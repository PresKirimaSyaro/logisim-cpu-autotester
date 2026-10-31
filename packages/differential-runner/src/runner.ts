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
} from '../../mips-core/src/interpreter/interpreter.js';
import type {
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
  RunSummary,
  SignalCheckpoint,
  SignalMismatch,
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

      const romStartIndex = (config.pc.initial - config.rom.baseByteAddress) >>> config.rom.addressShift;
      if (romStartIndex + program.words.length > config.rom.capacityWords) {
        throw new PhaseError(
          'config',
          `Program has ${program.words.length} words at ROM index ${romStartIndex}, exceeding capacity ${config.rom.capacityWords}`,
        );
      }
      const referenceImage = buildReferenceImage(config, program, romStartIndex);
      const reference = new ReferenceInterpreter(referenceImage, {trace: true});
      const referenceRun = this.runReference(reference, input, config);
      if (this.options.trace) state.result.trace = reference.trace;
      const steps = referenceRun.steps;
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

      const outcome = await this.executeObservedCycles(state, config, steps, reference);
      state.result.cyclesCompleted = outcome.cyclesCompleted;
      state.result.signalCheckpoints = outcome.signalCheckpoints;
      state.result.firstSignalMismatch = outcome.firstSignalMismatch;
      state.result.pc = this.buildPcResult(state, config, reference, outcome);
      if (outcome.error?.type === 'cancelled') throw outcome.error;
      if (outcome.error) throw outcome.error;

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
      } else if (outcome.cyclesCompleted !== steps) {
        state.result.status = 'error';
        state.result.errorType = 'simulation';
        state.result.message = `CPU completed ${outcome.cyclesCompleted} of ${steps} requested cycles`;
      } else {
        state.result.status = 'pass';
        state.result.message = `PASS: ${steps} cycle(s), 0 signal difference(s)`;
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
    const maxCycles = this.options.maxCycles ?? config.limits.maxCycles;
    if (steps > maxCycles) {
      return {
        cyclesCompleted: 0,
        checkpoints: [],
        signalCheckpoints: [],
        stoppedEarly: false,
        error: new PhaseError('config', `Requested ${steps} cycles exceeds maxCycles ${maxCycles}`),
      };
    }
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

    for (let cycle = 1; cycle <= steps; cycle++) {
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
      const entry = reference.trace[cycle - 1];
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

      let observations: Record<string, LogicValue>;
      try {
        observations = await bridge.readOutputs(ports);
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
      const actual: Record<string, number> = {};
      try {
        for (const port of ports) actual[port] = parseKnownOutput(observations[port], port);
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

      this.options.onProgress?.({
        kind: 'cycle',
        testId: state.result.id,
        cycle,
        total: steps,
        pc: toHex32(actual[outputs.pc]),
        instruction: toHex32(actual[outputs.instruction]),
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
      } else {
        // No architectural register write is expected (including writes to
        // $zero). A writeback to register 0 is architecturally a no-op and is
        // implementation-defined, so RegWrite and RegData are not compared.
        // A writeback to a nonzero register would be real corruption.
        if (actual[outputs.regWrite] !== 0 && actual[outputs.regAddr] !== 0) {
          expectations.push({
            signal: 'RegAddr',
            port: outputs.regAddr,
            expected: 0,
            compare: true,
          });
        }
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
        const actualValue = actual[expectation.port] >>> 0;
        const expectedValue = expectation.expected >>> 0;
        const match = actualValue === expectedValue;
        signalCheckpoints.push({
          cycle,
          signal: expectation.signal,
          expected: toHex32(expectedValue),
          actual: toHex32(actualValue),
          match,
        });
        if (!match && !firstSignalMismatch) {
          firstSignalMismatch = {
            cycle,
            signal: expectation.signal,
            expected: toHex32(expectedValue),
            actual: toHex32(actualValue),
          };
        }
      }
      if (firstSignalMismatch) {
        finalPc = actual[outputs.pc] >>> 0;
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

      try {
        if (config.clock.mode === 'internal') {
          await bridge.clockCycle(config.clock.halfCycles);
        } else {
          await bridge.tick(config.clock.pin, config.clock.edge);
        }
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
      cyclesCompleted = cycle;
      let pcValue: LogicValue;
      try {
        pcValue = await bridge.getOutput(outputs.pc);
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
      try {
        finalPc = parseKnownOutput(pcValue, outputs.pc);
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
      const expectedPc = entry.pcAfter >>> 0;
      const pcMatch = finalPc === expectedPc;
      checkpoints.push({
        cycle,
        expected: toHex32(expectedPc),
        actual: toHex32(finalPc),
        match: pcMatch,
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
  };
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
