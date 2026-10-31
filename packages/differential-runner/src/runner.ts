import {BridgeError} from '../../bridge-client/src/index.js';
import {
  assemble,
  type AssembledProgram,
} from '../../mips-core/src/assembler/assembler.js';
import {toHex32} from '../../mips-core/src/isa/constants.js';
import {
  parseCpuConfig,
  regionOf,
  type CpuConfig,
} from '../../mips-core/src/config/config.js';
import {MipsError} from '../../mips-core/src/errors.js';
import {AddressMap} from '../../mips-core/src/memory/address-map.js';
import {
  ReferenceInterpreter,
  type ReferenceImage,
  type RunResult,
  type TraceEntry,
} from '../../mips-core/src/interpreter/interpreter.js';
import type {
  BatchResult,
  BridgeOperation,
  ComponentInfo,
  LogicValue,
  PortInfo,
  RegisterValue,
} from '../../protocol/src/index.js';
import type {
  CpuBridge,
  PcCheckpoint,
  PcResult,
  RunnerOptions,
  CoverageSummary,
  RunSummary,
  SignalCheckpoint,
  SignalMismatch,
  ReferenceFault,
  TestErrorType,
  TestInput,
  TestResult,
  TestStatus,
} from './types.js';

const DEFAULT_KNOWN_LIMITATIONS = [
  'Black-box mode: the data memory is a logical, byte-addressed store in the reference model. Physical RAM count, geometry, contents and hierarchy are never inspected, read or written.',
  'The top-level Instr/pc/RegWrite/RegAddr/RegData/MemWrite/MemAddr/MemData outputs are sampled immediately before each clock edge; the post-edge pc is checked separately.',
  'The differential runner assumes every clock cycle executes exactly one instruction. Circuits with pipeline stalls, multi-cycle memory, or automatic multi-phase clocks are rejected by the single-cycle timing premise.',
  'lw correctness is inferred from the later register write and from programs that cross-check loaded values; the tool does not read the CPU’s physical RAM.',
  'The reference model has no halt instruction; tests must supply a fixed dynamic instruction count or a stop PC.',
  'ROM injection mutates only the in-memory Logisim ROM attribute; the input .circ file is never modified.',
];

class PhaseError extends Error {
  constructor(
    public readonly type: TestErrorType,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PhaseError';
  }
}

interface ExecutionOutcome {
  cyclesCompleted: number;
  checkpoints: PcCheckpoint[];
  signalCheckpoints: SignalCheckpoint[];
  firstDivergence?: {cycle: number; expected: number; actual: number};
  firstSignalMismatch?: SignalMismatch;
  stoppedEarly: boolean;
  finalPc?: number;
  error?: PhaseError;
}

interface RunState {
  result: TestResult;
  startedAt: number;
}

interface Expectation {
  signal: string;
  port: string;
  expected: number;
  compare: boolean;
}

export class DifferentialRunner {
  constructor(private readonly options: RunnerOptions) {}

  async run(inputs: TestInput[]): Promise<RunSummary> {
    const startedAt = Date.now();
    const results: TestResult[] = [];
    for (const input of inputs) {
      if (this.options.signal?.aborted) break;
      this.options.onProgress?.({kind: 'test-start', testId: input.id, name: input.name});
      const result = await this.runTest(input);
      results.push(result);
      this.options.onProgress?.({kind: 'test-finish', testId: input.id, status: result.status});
      this.options.onProgress?.({kind: 'test-result', result});
    }
    const totals = {
      total: results.length,
      passed: results.filter((result) => result.status === 'pass').length,
      failed: results.filter((result) => result.status === 'fail').length,
      errors: results.filter((result) => result.status === 'error').length,
      skipped: results.filter((result) => result.status === 'skipped').length,
    };
    return {
      schemaVersion: 3,
      generatedAt: new Date().toISOString(),
      circuitPath: this.options.circuitPath,
      configName: this.options.config.name,
      circuitName: this.options.config.circuitName,
      environment: this.options.environment ?? defaultEnvironment(),
      results,
      instructions: [...this.options.config.instructions],
      coverage: mergeCoverage(results),
      totals,
      durationMs: Date.now() - startedAt,
      knownLimitations: DEFAULT_KNOWN_LIMITATIONS,
    };
  }

  async runTest(input: TestInput): Promise<TestResult> {
    const startedAt = Date.now();
    const state: RunState = {
      startedAt,
      result: {
        id: input.id,
        name: input.name,
        category: input.category ?? 'custom',
        description: input.description ?? '',
        status: 'error',
        assembly: input.assembly,
        assemblyFile: input.assemblyFile,
        origin: this.options.config.pc.initial,
        machineCode: [],
        machineCodeWords: 0,
        seed: input.seed ?? null,
        stepsRequested: input.steps ?? 0,
        stepsExecuted: 0,
        cyclesRequested: input.steps ?? 0,
        cyclesCompleted: 0,
        bridgeErrors: [],
        durationMs: 0,
        details: {},
      },
    };
    try {
      if (this.options.signal?.aborted) throw new PhaseError('cancelled', 'Test run stopped by user');
      const config = parseCpuConfig(this.options.config);
      validateRunConfig(config, this.options, input);
      if ((input.initialRam?.length ?? 0) > 0) {
        throw new PhaseError(
          'config',
          'initialRam is not supported in black-box mode: initialize DM with sw instructions instead of writing physical RAM',
        );
      }
      if (!config.outputs) {
        throw new PhaseError(
          'config',
          'Top-level outputs are required. The runner no longer reads physical RAM; provide Instr/pc/RegWrite/RegAddr/RegData/MemWrite/MemAddr/MemData.',
        );
      }
      const program = this.assemble(input, config);
      state.result.origin = program.origin;
      state.result.machineCode = program.hex;
      state.result.machineCodeWords = program.words.length;
      state.result.instructions = program.instructions;
      state.result.romStartIndex = (config.pc.initial - config.rom.baseByteAddress) >>> config.rom.addressShift;

      const romStartIndex = state.result.romStartIndex;
      if (romStartIndex + program.words.length > config.rom.capacityWords) {
        throw new PhaseError(
          'config',
          `Program has ${program.words.length} words at ROM index ${romStartIndex}, exceeding capacity ${config.rom.capacityWords}`,
        );
      }
      const referenceImage = buildReferenceImage(config, program, romStartIndex);
      const reference = new ReferenceInterpreter(referenceImage, {trace: true});
      const referenceRun = this.runReference(reference, input, config);
      if (this.options.referenceFault) applyReferenceFault(reference.trace, this.options.referenceFault);
      if (this.options.trace) state.result.trace = reference.trace;
      const steps = referenceRun.steps;
      const maxCycles = input.maxCycles ?? this.options.maxCycles ?? config.limits.maxCycles;
      if (!Number.isInteger(maxCycles) || maxCycles < 1) {
        throw new PhaseError('config', `maxCycles must be a positive integer (received ${maxCycles})`);
      }
      const executableSteps = Math.min(steps, maxCycles);
      if (steps === 0) {
        throw new PhaseError('observability', 'Test executed zero instructions, so it cannot be a meaningful CPU test');
      }
      const observableWrites = countObservableWrites(reference.trace);
      if (observableWrites === 0) {
        throw new PhaseError(
          'observability',
          'Reference program produced no observable register or memory write; a CPU that does nothing must not be reported as PASS',
        );
      }
      validateSignature(input.signature, reference.snapshotRamWords(), config);
      state.result.stepsRequested = input.steps ?? steps;
      state.result.stepsExecuted = steps;
      state.result.cyclesRequested = steps;
      state.result.coverage = computeCoverage(program.instructions.length, reference.trace);
      state.result.reference = {
        stepsRequested: state.result.stepsRequested,
        stepsExecuted: steps,
        status: referenceRun.status,
        finalPc: toHex32(reference.state.pc),
        error: referenceRun.error,
        wroteMemory: reference.wroteMemory,
        observableWrites,
      };
      state.result.details = {
        ...state.result.details,
        sampledAt: 'pre-clock',
        referenceStatus: referenceRun.status,
        observableWrites,
      };

      const bridge = this.options.bridge;
      await this.phaseAsync(state, 'circuit-load', () => bridge.load(this.options.circuitPath, config.circuitName));
      const info = await this.phaseAsync(state, 'circuit-load', () => bridge.inspect());
      if (info.circuit !== config.circuitName) {
        throw new PhaseError(
          'circuit-load',
          `Loaded circuit is "${info.circuit}", expected "${config.circuitName}"`,
        );
      }
      validateOutputPins(info.ports, config.outputs);
      if (config.reset.strategy === 'pin') validatePin(info.ports, config.reset.pin, 'input', 1, 'reset input');

      const inventory = await this.phaseAsync(state, 'config', () => bridge.inspectComponents(true));
      const romInfo = findComponent(inventory.components, config.rom.path, 'rom');
      validateRomComponent(romInfo, config.rom);
      if (config.pc.mode === 'register') {
        const pcInfo = findComponent(inventory.components, config.pc.path, 'register');
        if (pcInfo.width !== 32) {
          throw new PhaseError('config', `PC register ${config.pc.path} is ${pcInfo.width} bits, expected 32`);
        }
      }

      // ROM injection is the only memory write. No readMemory call is needed:
      // a bad injection is caught immediately by the cycle-1 Instr comparison.
      await this.phaseAsync(state, 'init', () => bridge.loadRom(config.rom.path, romStartIndex, program.hex));

      await this.applyReset(state, config);
      await this.applyInputs(state, config);
      await this.initializePc(state, config);

      const outcome = await this.executeObservedCycles(state, config, executableSteps, reference);
      state.result.cyclesCompleted = outcome.cyclesCompleted;
      state.result.signalCheckpoints = outcome.signalCheckpoints;
      state.result.firstSignalMismatch = outcome.firstSignalMismatch;
      state.result.pc = this.buildPcResult(state, config, reference, outcome);
      if (outcome.error?.type === 'cancelled') throw outcome.error;
      if (outcome.error) throw outcome.error;
      state.result.details = {
        ...state.result.details,
        requestedCycles: steps,
        executedCycles: executableSteps,
        maxCycles,
        truncatedAtLimit: executableSteps < steps,
      };

      if (outcome.firstSignalMismatch) {
        state.result.status = 'fail';
        state.result.errorType = 'signal-mismatch';
        const mismatch = outcome.firstSignalMismatch;
        state.result.message = `Signal ${mismatch.signal} diverged at cycle ${mismatch.cycle}: expected ${mismatch.expected}, actual ${mismatch.actual}`;
      } else if (state.result.pc?.finalMatch === false || state.result.pc?.firstDivergence) {
        state.result.status = 'fail';
        state.result.errorType = 'simulation';
        state.result.message = state.result.pc.firstDivergence
          ? `PC diverged at cycle ${state.result.pc.firstDivergence.cycle}: expected ${state.result.pc.firstDivergence.expected}, actual ${state.result.pc.firstDivergence.actual}`
          : `Final PC mismatch: expected ${state.result.pc.expectedFinal}, actual ${state.result.pc.actualFinal}`;
      } else if (executableSteps < steps) {
        state.result.status = 'error';
        state.result.errorType = 'cycle-limit';
        state.result.message = `Cycle limit ${maxCycles} reached while ${steps} cycles were expected; execution was truncated (not a CPU mismatch)`;
      } else if (outcome.cyclesCompleted !== executableSteps) {
        state.result.status = 'error';
        state.result.errorType = 'simulation';
        state.result.message = `CPU completed ${outcome.cyclesCompleted} of ${executableSteps} requested cycles`;
      } else {
        state.result.status = 'pass';
        state.result.message = `PASS: ${executableSteps} cycle(s), 0 signal difference(s)`;
      }
    } catch (error) {
      this.applyError(state, error);
    } finally {
      const bridge = this.options.bridge;
      if (state.result.status !== 'pass' && bridge.stderr) {
        state.result.bridgeStderr = bridge.stderr.slice(-16384);
      }
      state.result.durationMs = Date.now() - state.startedAt;
    }
    return state.result;
  }

  private assemble(input: TestInput, config: CpuConfig): AssembledProgram {
    let program: AssembledProgram;
    try {
      program = assemble(input.assembly, {
        origin: config.pc.initial,
        fileName: input.assemblyFile,
        instructions: config.instructions,
      });
    } catch (error) {
      throw phaseFromError('assembly', error);
    }
    if (program.words.length === 0) {
      throw new PhaseError('assembly', 'Empty assembly program; refusing to treat an empty ROM as a passing test');
    }
    for (const word of program.words) {
      if (!Number.isInteger(word) || word < 0 || word > 0xffffffff) {
        throw new PhaseError('assembly', `Assembler produced a non-32-bit word: ${word}`);
      }
    }
    return program;
  }

  private runReference(reference: ReferenceInterpreter, input: TestInput, config: CpuConfig): RunResult {
    if (input.steps !== undefined && input.stopPc !== undefined) {
      throw new PhaseError('config', 'Test specifies both steps and stopPc; choose one termination rule');
    }
    if (input.steps !== undefined) {
      if (!Number.isInteger(input.steps) || input.steps < 1) {
        throw new PhaseError('config', `steps must be a positive integer (received ${input.steps})`);
      }
      if (input.steps > config.limits.maxSteps) {
        throw new PhaseError('config', `steps ${input.steps} exceeds limits.maxSteps ${config.limits.maxSteps}`);
      }
      const run = reference.runSteps(input.steps);
      if (run.status === 'error') {
        throw new PhaseError('reference', formatExecutionError(run), {error: run.error});
      }
      if (run.status !== 'completed' || run.steps !== input.steps) {
        throw new PhaseError('reference', `Reference stopped with status ${run.status} after ${run.steps} step(s)`);
      }
      return run;
    }
    if (input.stopPc !== undefined) {
      if (!Number.isInteger(input.stopPc) || input.stopPc < 0 || input.stopPc > 0xffffffff) {
        throw new PhaseError('config', `stopPc must be a 32-bit unsigned address (received ${input.stopPc})`);
      }
      if (input.stopPc % 4 !== 0) {
        throw new PhaseError('config', 'stopPc must be 4-byte aligned');
      }
      const run = reference.runUntilStop(input.stopPc, config.limits.maxSteps);
      if (run.status === 'error') {
        throw new PhaseError('reference', formatExecutionError(run), {error: run.error});
      }
      if (run.status !== 'stop-pc') {
        throw new PhaseError(
          'reference',
          run.status === 'step-limit'
            ? `Stop PC 0x${input.stopPc.toString(16)} was not reached within ${config.limits.maxSteps} steps`
            : `Reference stopped with status ${run.status}`,
        );
      }
      return run;
    }
    throw new PhaseError(
      'config',
      'No termination rule: pass steps (fixed dynamic instruction count) or stopPc',
    );
  }

  private async applyReset(state: RunState, config: CpuConfig): Promise<void> {
    const bridge = this.options.bridge;
    if (config.reset.strategy === 'state') {
      await this.phaseAsync(state, 'init', () => bridge.reset());
      return;
    }
    if (config.reset.strategy === 'none') {
      await this.phaseAsync(state, 'init', () => bridge.propagate());
      return;
    }
    const reset = config.reset;
    if (reset.strategy !== 'pin') return;
    const pin = reset.pin;
    const active = reset.activeLow ? '0x0' : '0x1';
    const inactive = reset.activeLow ? '0x1' : '0x0';
    await this.phaseAsync(state, 'init', () => bridge.setInput(pin, active, 1));
    await this.phaseAsync(state, 'init', () => bridge.propagate());
    const clock = config.clock;
    if (clock.mode === 'internal') {
      for (let i = 0; i < reset.ticks; i++) {
        await this.phaseAsync(state, 'init', () => bridge.clockCycle(clock.halfCycles));
      }
    } else {
      for (let i = 0; i < reset.ticks; i++) {
        await this.phaseAsync(state, 'init', () => bridge.tick(clock.pin, clock.edge));
      }
    }
    await this.phaseAsync(state, 'init', () => bridge.setInput(pin, inactive, 1));
    await this.phaseAsync(state, 'init', () => bridge.propagate());
  }

  private async applyInputs(state: RunState, config: CpuConfig): Promise<void> {
    const bridge = this.options.bridge;
    for (const input of config.inputs) {
      await this.phaseAsync(state, 'init', () => bridge.setInput(input.port, toHex32(input.value)));
    }
    await this.phaseAsync(state, 'init', () => bridge.propagate());
  }

  private async initializePc(state: RunState, config: CpuConfig): Promise<void> {
    const bridge = this.options.bridge;
    if (config.pc.mode === 'none') return;
    const pc = config.pc;
    if (pc.mode === 'register') {
      const path = pc.path;
      await this.phaseAsync(state, 'init', () => bridge.writeRegister(path, toHex32(pc.initial)));
      await this.phaseAsync(state, 'init', () => bridge.propagate());
      const readback = await this.phaseAsync(state, 'init', () => bridge.readRegister(path));
      if (parseHex(readback.value) !== pc.initial) {
        throw new PhaseError(
          'init',
          `PC register read-back ${readback.value} does not match pc.initial ${toHex32(pc.initial)}`,
        );
      }
      return;
    }
    if (pc.mode !== 'pin') return;
    const port = pc.port;
    const value = await this.phaseAsync(state, 'init', () => bridge.getOutput(port));
    if (value.status !== 'known') {
      throw new PhaseError('init', `PC pin ${port} is ${value.status}, expected a known value`);
    }
    if (parseHex(value.value) !== pc.initial) {
      throw new PhaseError(
        'init',
        `PC pin ${port} reads ${value.value} after reset but pc.initial is ${toHex32(pc.initial)}; this config cannot force PC through an output pin`,
      );
    }
  }

  /**
   * Sample the top-level outputs immediately before each clock edge, compare
   * them with the reference step, then advance the clock and compare the new PC.
   * No physical data-memory state is read or written.
   */
  private async executeObservedCycles(
    state: RunState,
    config: CpuConfig,
    steps: number,
    reference: ReferenceInterpreter,
  ): Promise<ExecutionOutcome> {
    const outputs = config.outputs;
    if (!outputs) throw new PhaseError('config', 'Outputs mapping is required for black-box testing');
    const bridge = this.options.bridge;
    const ports = [
      outputs.instruction,
      outputs.pc,
      outputs.regWrite,
      outputs.regAddr,
      outputs.regData,
      outputs.memWrite,
      outputs.memAddr,
      outputs.memData,
    ];
    const checkpoints: PcCheckpoint[] = [];
    const signalCheckpoints: SignalCheckpoint[] = [];
    let firstSignalMismatch: SignalMismatch | undefined;
    let firstDivergence: {cycle: number; expected: number; actual: number} | undefined;
    let cyclesCompleted = 0;
    let finalPc: number | undefined;
    const stopOnDivergence = this.options.stopOnPcDivergence ?? true;
    const batchSize = 64;

    for (let base = 1; base <= steps; base += batchSize) {
      if (this.options.signal?.aborted) {
        return {
          cyclesCompleted,
          checkpoints,
          signalCheckpoints,
          firstDivergence,
          firstSignalMismatch,
          stoppedEarly: true,
          finalPc,
          error: new PhaseError('cancelled', 'Test run stopped by user'),
        };
      }
      const count = Math.min(batchSize, steps - base + 1);
      const operations: BridgeOperation[] = [];
      for (let i = 0; i < count; i++) {
        operations.push({op: 'readOutputs', ports});
        operations.push(
          config.clock.mode === 'internal'
            ? {op: 'clockCycle', halfCycles: config.clock.halfCycles}
            : {op: 'tick', port: config.clock.pin, edge: config.clock.edge},
        );
        operations.push({op: 'getOutput', port: outputs.pc});
      }

      let batch: BatchResult;
      try {
        batch = await bridge.batch(operations);
      } catch (error) {
        return {
          cyclesCompleted,
          checkpoints,
          signalCheckpoints,
          firstDivergence,
          firstSignalMismatch,
          stoppedEarly: true,
          finalPc,
          error: phaseFromError(classifyBridgeError(error), error),
        };
      }

      for (let i = 0; i < count; i++) {
        const cycle = base + i;
        const pre = batch.results[i * 3];
        if (!pre || !pre.ok) {
          return {
            cyclesCompleted,
            checkpoints,
            signalCheckpoints,
            firstDivergence,
            firstSignalMismatch,
            stoppedEarly: true,
            finalPc,
            error: new PhaseError(
              'simulation',
              `Could not sample outputs at cycle ${cycle}: ${pre && !pre.ok ? `${pre.error.code}: ${pre.error.message}` : 'missing batch result'}`,
            ),
          };
        }
        const entry = reference.trace[cycle - 1];
        const staticIndex = staticInstructionIndex(entry?.pcBefore, state.result.origin);
        if (!entry) {
          return {
            cyclesCompleted,
            checkpoints,
            signalCheckpoints,
            firstDivergence,
            firstSignalMismatch,
            stoppedEarly: true,
            finalPc,
            error: new PhaseError('reference', `Reference trace is missing cycle ${cycle}`),
          };
        }
        const observations = pre.result as Record<string, LogicValue>;
        const actual: Record<string, number> = {};
        const actualText: Record<string, string> = {};
        const actualStatus: Record<string, 'known' | 'unknown' | 'error'> = {};
        for (const port of ports) {
          const observation = observations[port];
          if (!observation) {
            actualStatus[port] = 'unknown';
            actualText[port] = 'unknown';
          } else if (observation.status === 'known') {
            actualStatus[port] = 'known';
            actualText[port] = observation.value;
            actual[port] = parseHex(observation.value);
          } else {
            actualStatus[port] = observation.status;
            actualText[port] = observation.status;
          }
        }

        this.options.onProgress?.({
          kind: 'cycle',
          testId: state.result.id,
          cycle,
          total: steps,
          pc: actualStatus[outputs.pc] === 'known' ? toHex32(actual[outputs.pc]) : actualText[outputs.pc],
          instruction: actualStatus[outputs.instruction] === 'known'
            ? toHex32(actual[outputs.instruction])
            : actualText[outputs.instruction],
          expectedPc: toHex32(entry.pcBefore),
          expectedInstruction: toHex32(entry.machineCode),
        });

        const registerWrite =
          entry.registerWrite && !entry.registerWrite.ignored ? entry.registerWrite : undefined;
        const memoryWrite = entry.memoryWrite;
        const expectations: Expectation[] = [
          {signal: 'pc', port: outputs.pc, expected: entry.pcBefore, compare: true},
          {signal: 'instruction', port: outputs.instruction, expected: entry.machineCode, compare: true},
        ];

        if (registerWrite) {
          expectations.push(
            {signal: 'RegWrite', port: outputs.regWrite, expected: 1, compare: true},
            {signal: 'RegAddr', port: outputs.regAddr, expected: registerWrite.index, compare: true},
            {signal: 'RegData', port: outputs.regData, expected: registerWrite.value, compare: true},
          );
        } else if (
          actualStatus[outputs.regWrite] === 'known' &&
          actualStatus[outputs.regAddr] === 'known' &&
          actual[outputs.regWrite] !== 0 &&
          actual[outputs.regAddr] !== 0
        ) {
          // A real (nonzero-register) writeback is corruption. A writeback to
          // $zero is allowed as an implementation-defined no-op.
          expectations.push({signal: 'RegAddr', port: outputs.regAddr, expected: 0, compare: true});
        }

        expectations.push({signal: 'MemWrite', port: outputs.memWrite, expected: memoryWrite ? 1 : 0, compare: true});
        if (memoryWrite) {
          expectations.push(
            {signal: 'MemAddr', port: outputs.memAddr, expected: memoryWrite.address, compare: true},
            {signal: 'MemData', port: outputs.memData, expected: memoryWrite.value, compare: true},
          );
        }

        for (const expectation of expectations) {
          if (!expectation.compare) continue;
          const status = actualStatus[expectation.port] ?? 'unknown';
          const actualValue = actual[expectation.port] >>> 0;
          const expectedValue = expectation.expected >>> 0;
          const match = status === 'known' && actualValue === expectedValue;
          const actualDisplay = status === 'known' ? toHex32(actualValue) : status;
          signalCheckpoints.push({
            cycle,
            signal: expectation.signal,
            expected: toHex32(expectedValue),
            actual: actualDisplay,
            actualStatus: status,
            match,
            staticIndex,
          });
          if (!match && !firstSignalMismatch) {
            firstSignalMismatch = {
              cycle,
              signal: expectation.signal,
              expected: toHex32(expectedValue),
              actual: actualDisplay,
            };
          }
        }
        if (firstSignalMismatch) {
          finalPc = actualStatus[outputs.pc] === 'known' ? actual[outputs.pc] >>> 0 : undefined;
          return {
            cyclesCompleted: cycle - 1,
            checkpoints,
            signalCheckpoints,
            firstDivergence,
            firstSignalMismatch,
            stoppedEarly: true,
            finalPc,
          };
        }

        const clockResult = batch.results[i * 3 + 1];
        if (!clockResult || !clockResult.ok) {
          return {
            cyclesCompleted,
            checkpoints,
            signalCheckpoints,
            firstDivergence,
            firstSignalMismatch,
            stoppedEarly: true,
            finalPc,
            error: new PhaseError(
              'simulation',
              `CPU clock failed at cycle ${cycle}: ${clockResult && !clockResult.ok ? `${clockResult.error.code}: ${clockResult.error.message}` : 'missing batch result'}`,
            ),
          };
        }
        const post = batch.results[i * 3 + 2];
        if (!post || !post.ok) {
          return {
            cyclesCompleted,
            checkpoints,
            signalCheckpoints,
            firstDivergence,
            firstSignalMismatch,
            stoppedEarly: true,
            finalPc,
            error: new PhaseError(
              'simulation',
              `Could not read PC after cycle ${cycle}: ${post && !post.ok ? `${post.error.code}: ${post.error.message}` : 'missing batch result'}`,
            ),
          };
        }
        try {
          finalPc = parseKnownOutput(post.result as LogicValue, outputs.pc);
        } catch (error) {
          return {
            cyclesCompleted,
            checkpoints,
            signalCheckpoints,
            firstDivergence,
            firstSignalMismatch,
            stoppedEarly: true,
            finalPc,
            error: phaseFromError('simulation', error),
          };
        }
        cyclesCompleted = cycle;
        const expectedPc = entry.pcAfter >>> 0;
        const pcMatch = finalPc === expectedPc;
        checkpoints.push({
          cycle,
          expected: toHex32(expectedPc),
          actual: toHex32(finalPc),
          match: pcMatch,
          staticIndex,
        });
        if (!pcMatch && !firstDivergence) {
          firstDivergence = {cycle, expected: expectedPc, actual: finalPc};
          if (stopOnDivergence) {
            return {
              cyclesCompleted,
              checkpoints,
              signalCheckpoints,
              firstDivergence,
              firstSignalMismatch,
              stoppedEarly: true,
              finalPc,
            };
          }
        }
      }
    }

    return {
      cyclesCompleted,
      checkpoints,
      signalCheckpoints,
      firstDivergence,
      firstSignalMismatch,
      stoppedEarly: false,
      finalPc,
    };
  }

  private buildPcResult(
    state: RunState,
    config: CpuConfig,
    reference: ReferenceInterpreter,
    outcome: ExecutionOutcome,
  ): PcResult | undefined {
    if (config.pc.mode === 'none') return {mode: 'none'};
    const expectedFinal = expectedPcAfter(reference, outcome.cyclesCompleted, config.pc.initial);
    const actualFinal = outcome.finalPc;
    const checkpoints = outcome.checkpoints.length > 0 ? outcome.checkpoints : undefined;
    return {
      mode: config.pc.mode,
      expectedFinal: toHex32(expectedFinal),
      actualFinal: actualFinal === undefined ? undefined : toHex32(actualFinal),
      finalMatch: actualFinal === undefined ? undefined : actualFinal === expectedFinal,
      checkpoints,
      firstDivergence: outcome.firstDivergence
        ? {
            cycle: outcome.firstDivergence.cycle,
            expected: toHex32(outcome.firstDivergence.expected),
            actual: toHex32(outcome.firstDivergence.actual),
          }
        : undefined,
    };
  }

  private async phaseAsync<T>(state: RunState, type: TestErrorType, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      const phaseError = error instanceof PhaseError ? error : phaseFromError(type, error);
      state.result.bridgeErrors.push(`${phaseError.type}: ${phaseError.message}`);
      throw phaseError;
    }
  }

  private applyError(state: RunState, error: unknown): void {
    const phaseError = error instanceof PhaseError ? error : phaseFromError('internal', error);
    state.result.status = 'error';
    state.result.errorType = phaseError.type;
    state.result.message = phaseError.message;
    if (phaseError.details) state.result.details = {...state.result.details, ...phaseError.details};
    const text = `${phaseError.type}: ${phaseError.message}`;
    if (state.result.bridgeErrors[state.result.bridgeErrors.length - 1] !== text) {
      state.result.bridgeErrors.push(text);
    }
  }
}

function buildReferenceImage(
  config: CpuConfig,
  program: AssembledProgram,
  romStartIndex: number,
): ReferenceImage {
  const romWords: number[] = new Array(romStartIndex).fill(0);
  romWords.push(...program.words);
  return {
    romWords,
    rom: regionOf(config.rom),
    ram: regionOf(config.ram),
    initialPc: config.pc.initial,
    instructions: config.instructions,
  };
}

/**
 * Test-only reference mutation. This lets the regression suite prove that the
 * generated programs observe each classic datapath bug; it never changes the
 * user's circuit or the production reference model.
 */
function applyReferenceFault(trace: TraceEntry[], fault: ReferenceFault): void {
  for (const entry of trace) {
    const instruction = entry.instruction;
    if (!instruction || !entry.ok) continue;
    switch (fault) {
      case 'sw-nextpc':
        if (instruction.kind === 'sw') {
          entry.pcAfter = (entry.pcBefore + 4 + (instruction.offset << 2)) >>> 0;
        }
        break;
      case 'lw-sw-offset-zero':
        if (instruction.kind === 'sw' && entry.memoryWrite) {
          // A zero-extended negative offset addresses 0x10000 bytes too high.
          entry.memoryWrite = {...entry.memoryWrite, address: (entry.memoryWrite.address + 0x10000) >>> 0};
        } else if (instruction.kind === 'lw' && entry.registerWrite) {
          // lw's wrong address is only visible through the loaded value.
          entry.registerWrite = {...entry.registerWrite, value: (entry.registerWrite.value ^ 0x00010000) >>> 0};
        }
        break;
      case 'beq-negative-offset':
        if (instruction.kind === 'beq' && instruction.offset < 0 && entry.pcAfter !== ((entry.pcBefore + 4) >>> 0)) {
          entry.pcAfter = (entry.pcBefore + 4 + ((instruction.offset & 0xffff) << 2)) >>> 0;
        }
        break;
      case 'ori-sign-extend':
        if (instruction.kind === 'ori' && (instruction.immediate & 0x8000) !== 0 && entry.registerWrite) {
          const signExtended = (instruction.immediate | 0xffff0000) >>> 0;
          entry.registerWrite = {...entry.registerWrite, value: signExtended};
        }
        break;
      case 'lui-high':
        if (instruction.kind === 'lui' && entry.registerWrite) {
          entry.registerWrite = {...entry.registerWrite, value: entry.registerWrite.value & 0xffff};
        }
        break;
      case 'add-sub-msb':
        if ((instruction.kind === 'add' || instruction.kind === 'sub') && entry.registerWrite) {
          entry.registerWrite = {...entry.registerWrite, value: (entry.registerWrite.value ^ 0x80000000) >>> 0};
        }
        break;
    }
  }
}

function validateRunConfig(config: CpuConfig, options: RunnerOptions, input: TestInput): void {
  for (const pin of config.inputs.map((entry) => entry.port)) {
    if (config.clock.mode === 'pin' && pin === config.clock.pin) {
      throw new PhaseError('config', `inputs must not drive the configured clock pin "${pin}"`);
    }
    if (config.reset.strategy === 'pin' && pin === config.reset.pin) {
      throw new PhaseError('config', `inputs must not drive the configured reset pin "${pin}"`);
    }
  }
  if (options.circuitPath.length === 0) throw new PhaseError('config', 'circuitPath must not be empty');
  if (input.id.length === 0) throw new PhaseError('config', 'Test id must not be empty');
  if (input.steps !== undefined && input.stopPc !== undefined) {
    throw new PhaseError('config', 'Test specifies both steps and stopPc');
  }
  if (input.steps === undefined && input.stopPc === undefined) {
    throw new PhaseError('config', 'Test must specify steps or stopPc');
  }
  if (!config.outputs) {
    throw new PhaseError('config', 'config.outputs is required for black-box CPU testing');
  }
}

function validateSignature(
  signature: {byteAddress: number; expected: number}[] | undefined,
  expectedWords: Uint32Array,
  config: CpuConfig,
): void {
  if (!signature || signature.length === 0) return;
  const addressMap = new AddressMap(regionOf(config.ram), 'logical DM');
  for (const word of signature) {
    let index: number;
    try {
      addressMap.assertWordAlignment(word.byteAddress, 0);
      index = addressMap.indexOf(word.byteAddress, 0);
    } catch (error) {
      throw phaseFromError('config', error);
    }
    if ((expectedWords[index] >>> 0) !== (word.expected >>> 0)) {
      throw new PhaseError(
        'reference',
        `Signature expectation at 0x${word.byteAddress.toString(16)} is ${toHex32(word.expected)} but the reference produces ${toHex32(expectedWords[index])}`,
      );
    }
  }
}

function countObservableWrites(trace: {registerWrite?: {ignored: boolean}; memoryWrite?: unknown}[]): number {
  let count = 0;
  for (const entry of trace) {
    if (entry.registerWrite && !entry.registerWrite.ignored) count++;
    if (entry.memoryWrite) count++;
  }
  return count;
}

function findComponent(
  components: ComponentInfo[],
  path: string,
  kind: 'rom' | 'register',
): ComponentInfo {
  const found = components.find((component) => component.path === path);
  if (!found) {
    const candidates = components
      .filter((component) => component.kind === kind)
      .map((component) => component.path);
    throw new PhaseError(
      'config',
      `Component path "${path}" not found. Available ${kind} components: ${candidates.length > 0 ? candidates.join(', ') : '(none)'}`,
    );
  }
  if (found.kind !== kind) {
    throw new PhaseError('config', `Component "${path}" is ${found.kind}, expected ${kind}`);
  }
  return found;
}

function validateRomComponent(component: ComponentInfo, spec: CpuConfig['rom']): void {
  if (component.addressBits !== spec.addressBits) {
    throw new PhaseError(
      'config',
      `ROM ${component.path} has addressBits=${component.addressBits}, config says ${spec.addressBits}`,
    );
  }
  if (component.dataBits !== spec.dataBits) {
    throw new PhaseError('config', `ROM ${component.path} has dataBits=${component.dataBits}, config says ${spec.dataBits}`);
  }
  if ((component.capacity ?? 0) < spec.capacityWords) {
    throw new PhaseError(
      'config',
      `ROM ${component.path} has capacity=${component.capacity}, smaller than configured capacity ${spec.capacityWords}`,
    );
  }
}

function validateOutputPins(ports: PortInfo[], outputs: NonNullable<CpuConfig['outputs']>): void {
  const expected: [keyof typeof outputs, number][] = [
    ['instruction', 32],
    ['pc', 32],
    ['regWrite', 1],
    ['regAddr', 5],
    ['regData', 32],
    ['memWrite', 1],
    ['memAddr', 32],
    ['memData', 32],
  ];
  for (const [key, width] of expected) validatePin(ports, outputs[key], 'output', width, key);
}

function validatePin(ports: PortInfo[], label: string, direction: 'input' | 'output', width: number, what: string): void {
  const matches = ports.filter((port) => port.label === label);
  if (matches.length === 0) throw new PhaseError('config', `Top-level ${what} pin "${label}" is missing`);
  if (matches.length > 1) throw new PhaseError('config', `Top-level pin "${label}" is ambiguous`);
  const port = matches[0];
  if (port.direction !== direction) {
    throw new PhaseError('config', `Top-level pin "${label}" is ${port.direction}, expected ${direction}`);
  }
  if (port.width !== width) {
    throw new PhaseError('config', `Top-level pin "${label}" is ${port.width} bits, expected ${width}`);
  }
}

function parseKnownOutput(value: LogicValue | undefined, port: string): number {
  if (!value) throw new PhaseError('simulation', `Missing output observation for "${port}"`);
  if (value.status !== 'known') {
    throw new PhaseError('simulation', `Top-level output "${port}" is ${value.status}, expected known`);
  }
  return parseHex(value.value);
}

function expectedPcAfter(reference: ReferenceInterpreter, steps: number, initialPc: number): number {
  if (steps === 0) return initialPc;
  const entry = reference.trace[steps - 1];
  return entry ? entry.pcAfter : reference.state.pc;
}

function parseHex(value: string): number {
  const text = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]+$/.test(text)) {
    throw new PhaseError('internal', `Malformed hexadecimal value "${value}"`);
  }
  return Number.parseInt(text, 16) >>> 0;
}

function formatExecutionError(run: RunResult): string {
  if (!run.error) return `Reference execution failed with status ${run.status}`;
  return `Reference ${run.error.code} at PC ${toHex32(run.error.pc)}: ${run.error.message}`;
}

function phaseFromError(type: TestErrorType, error: unknown): PhaseError {
  if (error instanceof PhaseError) return error;
  if (error instanceof BridgeError) {
    return new PhaseError(classifyBridgeCode(error.code, type), `${error.code}: ${error.message}`, {
      bridgeCode: error.code,
    });
  }
  if (error instanceof MipsError) {
    const mapped: TestErrorType =
      error.code.startsWith('ASM_') ? 'assembly' : error.code.startsWith('CONFIG_') ? 'config' : type;
    return new PhaseError(mapped, `${error.code}: ${error.message}`, {mipsCode: error.code});
  }
  if (error instanceof Error) {
    return new PhaseError(type, error.message, {stack: error.stack});
  }
  return new PhaseError(type, String(error));
}

function classifyBridgeError(error: unknown): TestErrorType {
  if (error instanceof BridgeError) return classifyBridgeCode(error.code, 'simulation');
  return 'simulation';
}

function classifyBridgeCode(code: string, fallback: TestErrorType): TestErrorType {
  if (code === 'TIMEOUT') return 'timeout';
  if (code === 'PROCESS_START' || code === 'PROCESS_IO' || code === 'PROCESS_EXIT' || code === 'CLOSED' || code === 'TERMINATED') {
    return 'bridge';
  }
  if (code === 'INVALID_FILE' || code === 'CIRCUIT_NOT_FOUND' || code === 'UNSUPPORTED_LIBRARY') {
    return 'circuit-load';
  }
  if (code === 'NOT_LOADED') return 'init';
  return fallback;
}

function staticInstructionIndex(pc: number | undefined, origin: number): number | undefined {
  if (pc === undefined) return undefined;
  const delta = (pc >>> 0) - (origin >>> 0);
  if (delta < 0 || delta % 4 !== 0) return undefined;
  return delta / 4;
}

function computeCoverage(staticInstructions: number, trace: TraceEntry[]): CoverageSummary {
  const instructions: Record<string, number> = {};
  const writes = new Set<number>();
  const reads = new Set<number>();
  const shamt = new Set<number>();
  let beqTaken = 0;
  let beqNotTaken = 0;
  let branchForward = 0;
  let branchBackward = 0;
  let nonControlExecuted = 0;
  let nonControlPcPlus4 = 0;
  let nonControlPcBad = 0;
  let negativeResults = 0;
  let highBitResults = 0;
  let zeroResults = 0;
  let lwCount = 0;
  let swCount = 0;
  let zeroOffset = 0;
  let positiveOffset = 0;
  let negativeOffset = 0;
  let nonzeroBase = 0;
  for (const entry of trace) {
    const instruction = entry.instruction;
    if (!instruction) continue;
    instructions[instruction.kind] = (instructions[instruction.kind] ?? 0) + 1;
    if (entry.registerWrite && !entry.registerWrite.ignored) {
      writes.add(entry.registerWrite.index);
      const value = entry.registerWrite.value >>> 0;
      if (value === 0) zeroResults++;
      if ((value & 0x80000000) !== 0) negativeResults++;
      if (value >= 0x80000000) highBitResults++;
    }
    if (['add', 'sub', 'ori', 'lw', 'sw', 'lui', 'nop', 'sll'].includes(instruction.kind)) {
      nonControlExecuted++;
      if ((entry.pcAfter >>> 0) === (((entry.pcBefore >>> 0) + 4) >>> 0)) nonControlPcPlus4++;
      else nonControlPcBad++;
    }
    switch (instruction.kind) {
      case 'add':
      case 'sub':
        reads.add(instruction.rs);
        reads.add(instruction.rt);
        break;
      case 'ori':
        reads.add(instruction.rs);
        break;
      case 'lw':
        reads.add(instruction.rs);
        lwCount++;
        countOffset(instruction.offset);
        if (instruction.rs !== 0) nonzeroBase++;
        break;
      case 'sw':
        reads.add(instruction.rs);
        reads.add(instruction.rt);
        swCount++;
        countOffset(instruction.offset);
        if (instruction.rs !== 0) nonzeroBase++;
        break;
      case 'beq':
        reads.add(instruction.rs);
        reads.add(instruction.rt);
        if ((entry.pcAfter >>> 0) === (((entry.pcBefore >>> 0) + 4) >>> 0)) beqNotTaken++;
        else beqTaken++;
        if (instruction.offset < 0) branchBackward++;
        else if (instruction.offset > 0) branchForward++;
        break;
      case 'sll':
        reads.add(instruction.rt);
        shamt.add(instruction.shamt);
        break;
      case 'lui':
      case 'j':
      case 'nop':
        break;
    }
  }
  function countOffset(offset: number): void {
    if (offset === 0) zeroOffset++;
    else if (offset > 0) positiveOffset++;
    else negativeOffset++;
  }
  return {
    instructions,
    registerWrites: [...writes].sort((a, b) => a - b),
    registerReads: [...reads].sort((a, b) => a - b),
    sllShamt: [...shamt].sort((a, b) => a - b),
    beqTaken,
    beqNotTaken,
    branchForward,
    branchBackward,
    lwCount,
    swCount,
    zeroOffset,
    positiveOffset,
    negativeOffset,
    nonzeroBase,
    nonControlExecuted,
    nonControlPcPlus4,
    nonControlPcBad,
    negativeResults,
    highBitResults,
    zeroResults,
    staticInstructions,
    dynamicInstructions: trace.length,
    maxTestCycles: trace.length,
  };
}

function mergeCoverage(results: TestResult[]): CoverageSummary {
  const merged: CoverageSummary = {
    instructions: {},
    registerWrites: [],
    registerReads: [],
    sllShamt: [],
    beqTaken: 0,
    beqNotTaken: 0,
    branchForward: 0,
    branchBackward: 0,
    lwCount: 0,
    swCount: 0,
    zeroOffset: 0,
    positiveOffset: 0,
    negativeOffset: 0,
    nonzeroBase: 0,
    nonControlExecuted: 0,
    nonControlPcPlus4: 0,
    nonControlPcBad: 0,
    negativeResults: 0,
    highBitResults: 0,
    zeroResults: 0,
    staticInstructions: 0,
    dynamicInstructions: 0,
    maxTestCycles: 0,
  };
  const writes = new Set<number>();
  const reads = new Set<number>();
  const shamt = new Set<number>();
  for (const result of results) {
    const coverage = result.coverage;
    if (!coverage) continue;
    for (const [kind, count] of Object.entries(coverage.instructions)) {
      merged.instructions[kind] = (merged.instructions[kind] ?? 0) + count;
    }
    for (const index of coverage.registerWrites) writes.add(index);
    for (const index of coverage.registerReads) reads.add(index);
    for (const value of coverage.sllShamt) shamt.add(value);
    merged.beqTaken += coverage.beqTaken;
    merged.beqNotTaken += coverage.beqNotTaken;
    merged.branchForward += coverage.branchForward;
    merged.branchBackward += coverage.branchBackward;
    merged.lwCount += coverage.lwCount;
    merged.swCount += coverage.swCount;
    merged.zeroOffset += coverage.zeroOffset;
    merged.positiveOffset += coverage.positiveOffset;
    merged.negativeOffset += coverage.negativeOffset;
    merged.nonzeroBase += coverage.nonzeroBase;
    merged.nonControlExecuted += coverage.nonControlExecuted;
    merged.nonControlPcPlus4 += coverage.nonControlPcPlus4;
    merged.nonControlPcBad += coverage.nonControlPcBad;
    merged.negativeResults += coverage.negativeResults;
    merged.highBitResults += coverage.highBitResults;
    merged.zeroResults += coverage.zeroResults;
    merged.staticInstructions += coverage.staticInstructions;
    merged.dynamicInstructions += coverage.dynamicInstructions;
    merged.maxTestCycles = Math.max(merged.maxTestCycles, coverage.maxTestCycles);
  }
  merged.registerWrites = [...writes].sort((a, b) => a - b);
  merged.registerReads = [...reads].sort((a, b) => a - b);
  merged.sllShamt = [...shamt].sort((a, b) => a - b);
  return merged;
}

function defaultEnvironment(): Record<string, unknown> {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd(),
    logisim: '2.7.1',
    observation: 'top-level outputs sampled before clock edge',
  };
}

export function resultStatus(result: TestResult): TestStatus {
  return result.status;
}
