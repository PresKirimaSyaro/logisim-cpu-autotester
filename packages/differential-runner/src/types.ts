import type {
  CircuitInfo,
  ComponentInventory,
  RegisterValue,
  LogicValue,
  BatchResult,
  BridgeOperation,
} from '../../protocol/src/index.js';
import type {CpuConfig} from '../../mips-core/src/config/config.js';
import type {ExecutionErrorInfo} from '../../mips-core/src/errors.js';
import type {StepResult} from '../../mips-core/src/interpreter/interpreter.js';

export type TestStatus = 'pass' | 'fail' | 'error' | 'skipped';

export type TestErrorType =
  | 'assembly'
  | 'config'
  | 'circuit-load'
  | 'init'
  | 'simulation'
  | 'signal-mismatch'
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
}

export interface RunnerOptions {
  circuitPath: string;
  config: CpuConfig;
  bridge: CpuBridge;
  maxCycles?: number;
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
  match: boolean;
}

export interface SignalMismatch {
  cycle: number;
  signal: string;
  expected: string;
  actual: string;
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
