import type {
  CircuitInfo,
  ComponentInventory,
  RegisterValue,
  LogicValue,
  BatchResult,
  BridgeOperation,
} from '../../protocol/src/index.js';
import type {CpuConfig} from '../../mips-core/src/config/config.js';
import type {AssembledInstruction} from '../../mips-core/src/assembler/assembler.js';
import type {ExecutionErrorInfo} from '../../mips-core/src/errors.js';
import type {StepResult} from '../../mips-core/src/interpreter/interpreter.js';
import type {InstructionName} from '../../mips-core/src/isa/instruction-set.js';

export type TestStatus = 'pass' | 'fail' | 'error' | 'skipped';

export type TestErrorType =
  | 'assembly'
  | 'config'
  | 'circuit-load'
  | 'init'
  | 'simulation'
  | 'signal-mismatch'
  | 'cycle-limit'
  | 'timeout'
  /** Legacy reports from the old physical-RAM implementation. */
  | 'ram-mismatch'
  | 'reference'
  | 'observability'
  | 'bridge'
  | 'cancelled'
  | 'internal';

/** Structural subset of LogisimBridge used by the runner and its unit tests. */
export interface CpuBridge {
  load(path: string, circuit: string): Promise<void>;
  inspect(): Promise<CircuitInfo>;
  inspectComponents(recursive?: boolean): Promise<ComponentInventory>;
  loadRom(path: string, start: number, words: string[]): Promise<void>;
  readRegister(path: string): Promise<RegisterValue>;
  writeRegister(path: string, value: string): Promise<void>;
  setInput(port: string, value: string, width?: number): Promise<void>;
  getOutput(port: string): Promise<LogicValue>;
  propagate(): Promise<void>;
  tick(port: string, edge?: 'rising' | 'falling'): Promise<void>;
  clockCycle(halfCycles?: 1 | 2): Promise<void>;
  readOutputs(ports: string[]): Promise<Record<string, LogicValue>>;
  reset(): Promise<void>;
  batch(operations: BridgeOperation[]): Promise<BatchResult>;
  readonly stderr?: string;
  close(): Promise<void>;
}

/** Legacy type retained for old report JSON; new runs do not use it. */
export interface InitialRamWord {
  byteAddress: number;
  value: number;
}

export interface SignatureWord {
  byteAddress: number;
  expected: number;
}

export interface TestInput {
  id: string;
  name: string;
  category?: string;
  description?: string;
  assembly: string;
  assemblyFile?: string;
  /** Exact number of dynamic instructions. Mutually exclusive with stopPc. */
  steps?: number;
  /** Stop when PC reaches this address (checked before fetch). */
  stopPc?: number;
  /**
   * Legacy field. DM is initialized by sw instructions in black-box mode, so a
   * non-empty value is rejected instead of pretending to initialize the CPU.
   */
  initialRam?: InitialRamWord[];
  /** Optional expected final logical-DM values, used to sanity-check the reference. */
  signature?: SignatureWord[];
  seed?: number | null;
  /** Optional per-test cycle cap; reaching it is reported as cycle-limit, not a CPU error. */
  maxCycles?: number;
}

export type ReferenceFault =
  | 'sw-nextpc'
  | 'lw-sw-offset-zero'
  | 'beq-negative-offset'
  | 'ori-sign-extend'
  | 'lui-high'
  | 'add-sub-msb'
  | 'lw-as-beq'
  | 'sw-as-beq'
  | 'ori-as-beq';

export interface RunnerOptions {
  circuitPath: string;
  config: CpuConfig;
  bridge: CpuBridge;
  maxCycles?: number;
  /** Test-only controlled mutation of the reference trace, never used by the GUI. */
  referenceFault?: ReferenceFault;
  /** Stop at the first per-cycle PC/signal divergence. Default true. */
  stopOnPcDivergence?: boolean;
  trace?: boolean;
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
  /** Extra context attached to reports. */
  environment?: Record<string, unknown>;
}

export type ProgressEvent =
  | {kind: 'phase'; testId: string; phase: string; message?: string}
  | {kind: 'test-start'; testId: string; name: string}
  | {
      kind: 'cycle';
      testId: string;
      cycle: number;
      total: number;
      /** Observed values immediately before the clock edge. */
      pc?: string;
      instruction?: string;
      expectedPc?: string;
      expectedInstruction?: string;
    }
  | {kind: 'test-finish'; testId: string; status: TestStatus}
  | {kind: 'test-result'; result: TestResult};

export interface PcCheckpoint {
  cycle: number;
  expected: string;
  actual: string;
  match: boolean;
  staticIndex?: number;
}

export interface PcResult {
  mode: 'none' | 'register' | 'pin';
  expectedFinal?: string;
  actualFinal?: string;
  finalMatch?: boolean;
  checkpoints?: PcCheckpoint[];
  firstDivergence?: {cycle: number; expected: string; actual: string};
}

export interface SignalCheckpoint {
  cycle: number;
  signal: string;
  expected: string;
  actual: string;
  actualStatus?: 'known' | 'unknown' | 'error';
  match: boolean;
  /** Index into the static assembled instruction list (PC-origin)/4. */
  staticIndex?: number;
}

export interface SignalMismatch {
  cycle: number;
  signal: string;
  expected: string;
  actual: string;
}

export interface CoverageSummary {
  /** Dynamic instruction execution counts, keyed by mnemonic. */
  instructions: Record<string, number>;
  registerWrites: number[];
  registerReads: number[];
  sllShamt: number[];
  beqTaken: number;
  beqNotTaken: number;
  branchForward: number;
  branchBackward: number;
  lwCount: number;
  swCount: number;
  zeroOffset: number;
  positiveOffset: number;
  negativeOffset: number;
  nonzeroBase: number;
  nonControlExecuted: number;
  nonControlPcPlus4: number;
  nonControlPcBad: number;
  negativeResults: number;
  highBitResults: number;
  zeroResults: number;
  staticInstructions: number;
  dynamicInstructions: number;
  /** Longest individual test executed in this report. */
  maxTestCycles: number;
}

export interface ReferenceInfo {
  stepsRequested: number;
  stepsExecuted: number;
  status: string;
  finalPc: string;
  error?: ExecutionErrorInfo;
  wroteMemory: boolean;
  observableWrites: number;
}

export interface TestResult {
  id: string;
  name: string;
  category: string;
  description: string;
  status: TestStatus;
  errorType?: TestErrorType;
  message?: string;
  assembly: string;
  assemblyFile?: string;
  origin: number;
  machineCode: string[];
  machineCodeWords: number;
  /** Assembled static instructions with source text, address and machine word. */
  instructions?: AssembledInstruction[];
  /** ROM word index of the first instruction (PC = origin maps to this index). */
  romStartIndex?: number;
  seed: number | null;
  stepsRequested: number;
  stepsExecuted: number;
  cyclesRequested: number;
  cyclesCompleted: number;
  /** Per-cycle sampled top-level signals, when the CPU provides outputs. */
  signalCheckpoints?: SignalCheckpoint[];
  firstSignalMismatch?: SignalMismatch;
  pc?: PcResult;
  reference?: ReferenceInfo;
  coverage?: CoverageSummary;
  /** Legacy field from the ROM read-back era. New runs do not read memory. */
  romReadbackVerified?: boolean;
  bridgeErrors: string[];
  bridgeStderr?: string;
  durationMs: number;
  trace?: StepResult[];
  details?: Record<string, unknown>;

  // ---- Legacy physical-RAM report fields (old history JSON only). ----
  initialRam?: {startByteAddress: number; words: string[]};
  expectedRam?: {startByteAddress: number; words: string[]};
  actualRam?: {startByteAddress: number; words: string[]};
  comparedRanges?: {startByteAddress: number; words: number; kind: 'full' | 'range'}[];
  comparisonScope?: 'full' | 'partial';
  differenceCount?: number;
  firstDifference?: {
    byteAddress: number;
    wordIndex: number;
    expected: string;
    actual: string;
    expectedValue: number;
    actualValue: number;
  };
  differences?: {
    byteAddress: number;
    wordIndex: number;
    expected: string;
    actual: string;
    expectedValue: number;
    actualValue: number;
  }[];
  signature?: {byteAddress: number; expected: string; actual?: string; match?: boolean}[];
  ramInitVerified?: boolean;
}

export interface RunSummary {
  schemaVersion: 3;
  generatedAt: string;
  circuitPath: string;
  configName: string;
  circuitName: string;
  environment: Record<string, unknown>;
  results: TestResult[];
  /** Instruction set used to generate and execute this report. */
  instructions?: readonly InstructionName[];
  coverage?: CoverageSummary;
  totals: {
    total: number;
    passed: number;
    failed: number;
    errors: number;
    skipped: number;
  };
  durationMs: number;
  knownLimitations: string[];
}
