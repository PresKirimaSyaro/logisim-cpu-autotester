import type {ComponentInfo, PortInfo} from '../../protocol/src/index.js';
import type {CpuConfig} from '../../mips-core/src/config/config.js';
import type {Diagnostic} from '../../mips-core/src/errors.js';
import type {RunSummary, TestResult, TestInput} from '../../differential-runner/src/types.js';

export const IPC = {
  stateGet: 'state:get',
  settingsUpdate: 'settings:update',
  circuitChoose: 'circuit:choose',
  circuitInspect: 'circuit:inspect',
  configChoose: 'config:choose',
  configLoad: 'config:load',
  configSave: 'config:save',
  asmChoose: 'asm:choose',
  asmSave: 'asm:save',
  reportChoosePath: 'report:choosePath',
  reportExport: 'report:export',
  runStart: 'run:start',
  runStop: 'run:stop',
  historyList: 'history:list',
  historyGet: 'history:get',
  historyRerun: 'history:rerun',
  assemble: 'assemble',
  logsGet: 'logs:get',
  runUpdate: 'run:update',
  stateUpdate: 'state:update',
} as const;

export type SuiteName = 'basic' | 'full' | 'branch' | 'memory' | 'alu';

export interface TesterSettings {
  /** Empty means java / $JAVA. */
  javaPath: string;
  defaultCircuit: string;
  defaultConfig: string;
  bridgeTimeoutMs: number;
  maxCycles: number;
  theme: 'light' | 'dark';
}

export interface CircuitProfile {
  path: string;
  circuitName: string;
  ports: PortInfo[];
  components: ComponentInfo[];
  clocks: {path: string; label: string | null}[];
  rom: ComponentInfo;
  config: CpuConfig;
  warnings: string[];
}

export interface CircuitInspectError {
  ok: false;
  message: string;
  code?: string;
  stderr?: string;
}

export type CircuitInspectResult = ({ok: true} & CircuitProfile) | CircuitInspectError;

export interface HistoryMeta {
  id: string;
  createdAt: string;
  circuitPath: string;
  circuitName: string;
  configName: string;
  suite: string;
  totals: RunSummary['totals'];
  durationMs: number;
  /** False when the user stopped the run before the suite finished. */
  complete: boolean;
}

export interface HistoryRecord {
  meta: HistoryMeta;
  summary: RunSummary;
  tests: TestInput[];
  request: RunRequest;
}

export interface RunRequest {
  kind: 'suite' | 'assembly' | 'history';
  suite?: SuiteName;
  assembly?: string;
  steps?: number;
  stopPc?: number;
  historyId?: string;
  onlyFailed?: boolean;
}

export interface AssembleResult {
  ok: boolean;
  words?: string[];
  symbols?: Record<string, number>;
  lines?: {address: number; hex: string; text: string}[];
  diagnostics?: Diagnostic[];
  message?: string;
}

export interface AppState {
  settings: TesterSettings;
  circuit: CircuitProfile | null;
  config: CpuConfig | null;
  bridgeStatus: 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
  running: boolean;
  lastSummary: RunSummary | null;
  lastError: string | null;
  logs: string[];
}

export type RunUpdate =
  | {
      type: 'started';
      startedAt: string;
      total: number;
      suite: string;
      circuitPath: string;
      configName: string;
    }
  | {
      type: 'progress';
      completed: number;
      total: number;
      currentTestId?: string;
      cycle?: number;
      currentPc?: string;
      currentInstruction?: string;
      expectedPc?: string;
      expectedInstruction?: string;
    }
  | {type: 'test-result'; result: TestResult}
  | {type: 'finished'; summary: RunSummary; historyId: string}
  | {type: 'stopped'; summary?: RunSummary; message: string}
  | {type: 'error'; message: string; code?: string; stderr?: string}
  | {type: 'state'; state: AppState};

export interface RunStartResult {
  started: boolean;
  error?: string;
  total?: number;
}

export interface FileText {
  path: string;
  source: string;
}

export interface DesktopApi {
  getState(): Promise<AppState>;
  updateSettings(patch: Partial<TesterSettings>): Promise<TesterSettings>;
  chooseCircuit(): Promise<string | null>;
  inspectCircuit(path: string): Promise<CircuitInspectResult>;
  chooseConfig(): Promise<string | null>;
  loadConfig(path: string): Promise<CpuConfig>;
  saveConfig(config: CpuConfig, path?: string): Promise<{saved: boolean; path?: string; error?: string}>;
  chooseAsm(): Promise<FileText | null>;
  saveAsm(source: string, suggestedPath?: string): Promise<{saved: boolean; path?: string}>;
  chooseReportPath(suggestedName: string): Promise<string | null>;
  exportReport(historyId: string, path?: string): Promise<{saved: boolean; path?: string; error?: string}>;
  run(request: RunRequest): Promise<RunStartResult>;
  stop(): Promise<void>;
  listHistory(): Promise<HistoryMeta[]>;
  getHistory(id: string): Promise<HistoryRecord | null>;
  rerun(historyId: string, onlyFailed: boolean): Promise<RunStartResult>;
  assemble(source: string): Promise<AssembleResult>;
  getLogs(): Promise<string[]>;
  onRunUpdate(listener: (update: RunUpdate) => void): () => void;
  onStateUpdate(listener: (state: AppState) => void): () => void;
}

declare global {
  interface Window {
    cpuTester: DesktopApi;
  }
}
