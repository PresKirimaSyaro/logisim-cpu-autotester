import {mkdir, readFile, readdir, stat, writeFile, rename} from 'node:fs/promises';
import {dirname, extname, join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {BridgeError, LogisimBridge, type BridgeOptions} from '../../bridge-client/src/index.js';
import {
  ConfigError,
  MipsError,
  assemble,
  COURSE_INSTRUCTIONS,
  encodeLogisimHex,
  normalizeInstructions,
  parseCpuConfig,
  parseInstructionSet,
  tryAssemble,
  type CpuConfig,
  type InstructionName,
  type Diagnostic,
} from '../../mips-core/src/index.js';
import {
  DifferentialRunner,
  type RunSummary,
  type TestInput,
  type TestResult,
} from '../../differential-runner/src/index.js';
import {
  generateStressTests,
  layoutForConfig,
  selectSuite,
  testsFromSuite,
  parseTestSuite,
} from '../../test-generator/src/index.js';
import type {
  AppState,
  AssembleResult,
  CircuitInspectResult,
  CircuitProfile,
  HistoryMeta,
  HistoryRecord,
  ReportMeta,
  ReportTestSummary,
  RunRequest,
  RunStartResult,
  RunUpdate,
  StressIntensity,
  SuiteName,
  TesterSettings,
  TracePage,
  TraceRow,
  TraceValue,
} from '../../desktop-ipc/src/index.js';

const DEFAULT_SETTINGS: TesterSettings = {
  javaPath: '',
  defaultCircuit: '',
  defaultConfig: '',
  bridgeTimeoutMs: 30000,
  maxCycles: 200000,
  theme: 'light',
  instructions: [...COURSE_INSTRUCTIONS],
};

const REQUIRED_OUTPUTS: {key: keyof NonNullable<CpuConfig['outputs']>; label: string; width: number}[] = [
  {key: 'instruction', label: 'Instr', width: 32},
  {key: 'pc', label: 'pc', width: 32},
  {key: 'regWrite', label: 'RegWrite', width: 1},
  {key: 'regAddr', label: 'RegAddr', width: 5},
  {key: 'regData', label: 'RegData', width: 32},
  {key: 'memWrite', label: 'MemWrite', width: 1},
  {key: 'memAddr', label: 'MemAddr', width: 32},
  {key: 'memData', label: 'MemData', width: 32},
];

export class ServiceError extends Error {
  constructor(
    message: string,
    public readonly code = 'SERVICE_ERROR',
    public readonly stderr?: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export interface TesterServiceOptions {
  repoRoot: string;
  dataDir: string;
  bridgeFactory?: (options: BridgeOptions) => LogisimBridge;
  onUpdate?: (update: RunUpdate) => void;
  /** External directed-test suite JSON. Defaults to <repoRoot>/test-suites/course.json. */
  suiteFile?: string;
}

/**
 * Electron-free application service. The CLI, Electron main process and tests
 * all call this class; the renderer only sees the IPC contract.
 */
export class TesterService {
  readonly settingsStore: SettingsStore;
  readonly historyStore: HistoryStore;
  private settings: TesterSettings;
  private circuit: CircuitProfile | null = null;
  private config: CpuConfig | null = null;
  private bridgeStatus: AppState['bridgeStatus'] = 'stopped';
  private running = false;
  private lastSummary: RunSummary | null = null;
  private lastReportId: string | null = null;
  readonly suiteFile: string;
  private lastError: string | null = null;
  private readonly reportCache = new Map<string, HistoryRecord>();
  private logs: string[] = [];
  private controller: AbortController | null = null;
  private bridge: LogisimBridge | null = null;
  private runPromise: Promise<void> | null = null;
  private onUpdate?: (update: RunUpdate) => void;

  constructor(private readonly options: TesterServiceOptions) {
    this.settingsStore = new SettingsStore(options.dataDir);
    this.historyStore = new HistoryStore(options.dataDir);
    this.settings = {...DEFAULT_SETTINGS};
    this.onUpdate = options.onUpdate;
    this.suiteFile = options.suiteFile ?? join(options.repoRoot, 'test-suites', 'course.json');
  }

  async init(): Promise<void> {
    await this.settingsStore.init();
    await this.historyStore.init();
    this.settings = await this.settingsStore.load();
    const history = await this.historyStore.list();
    this.lastReportId = history[0]?.id ?? null;
    this.log('service', `data directory: ${this.options.dataDir}`);
  }

  subscribe(listener: (update: RunUpdate) => void): void {
    this.onUpdate = listener;
  }

  getState(): AppState {
    return {
      settings: {...this.settings},
      circuit: this.circuit,
      config: this.config,
      bridgeStatus: this.bridgeStatus,
      running: this.running,
      // The main window only needs status/totals. Detailed results live in the
      // report store and are fetched by the independent result window via ID.
      lastSummary: this.lastSummary ? {...this.lastSummary, results: []} : null,
      lastReportId: this.lastReportId,
      suiteFile: this.suiteFile,
      lastError: this.lastError,
      logs: [...this.logs],
    };
  }

  async updateSettings(patch: Partial<TesterSettings>): Promise<TesterSettings> {
    const next = normalizeSettings({...this.settings, ...patch});
    await this.settingsStore.save(next);
    this.settings = next;
    this.log('settings', 'settings updated');
    this.emitState();
    return {...this.settings};
  }

  async loadCircuit(path: string): Promise<CircuitInspectResult> {
    if (this.running) return {ok: false, message: '测试正在运行，不能切换电路'};
    const absolute = await validateFile(path, '.circ');
    this.bridgeStatus = 'starting';
    this.emitState();
    const bridge = this.createBridge();
    this.bridge = bridge;
    try {
      await bridge.load(absolute, 'main');
      const info = await bridge.inspect();
      const inventory = await bridge.inspectComponents(true);
      const profile = buildCourseProfile(absolute, info.circuit, info.ports, inventory.components);
      profile.config = {...profile.config, instructions: [...this.settings.instructions]};
      this.circuit = profile;
      this.config = profile.config;
      this.lastError = null;
      this.log('circuit', `loaded ${absolute} (${info.circuit})`);
      this.bridgeStatus = 'stopped';
      this.emitState();
      return {ok: true, ...profile};
    } catch (error) {
      const message = describeError(error);
      this.lastError = message;
      this.bridgeStatus = 'error';
      this.log('error', message);
      this.emitState();
      return {
        ok: false,
        message,
        code: error instanceof BridgeError ? error.code : error instanceof ServiceError ? error.code : undefined,
        stderr: bridge.stderr.slice(-8192),
      };
    } finally {
      await bridge.close().catch(() => undefined);
      this.bridge = null;
      if (this.bridgeStatus === 'starting') this.bridgeStatus = 'stopped';
      this.emitState();
    }
  }

  async loadConfig(path: string): Promise<CpuConfig> {
    const absolute = await validateFile(path, '.json');
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(absolute, 'utf8'));
    } catch (error) {
      throw new ServiceError(`配置文件无法读取: ${describeError(error)}`, 'CONFIG_INVALID');
    }
    const config = parseCpuConfig(raw);
    this.config = config;
    this.settings.defaultConfig = absolute;
    this.settings.instructions = [...config.instructions];
    await this.settingsStore.save(this.settings);
    this.log('config', `loaded ${absolute}`);
    this.emitState();
    return config;
  }

  async setConfig(config: CpuConfig, path?: string): Promise<{saved: boolean; path?: string}> {
    const parsed = parseCpuConfig(config);
    this.config = parsed;
    let savedPath: string | undefined;
    if (path) {
      savedPath = await this.saveConfigFile(parsed, path);
    }
    this.emitState();
    return {saved: Boolean(savedPath), path: savedPath};
  }

  async saveConfig(config: CpuConfig, path?: string): Promise<{saved: boolean; path?: string}> {
    const parsed = parseCpuConfig(config);
    const target = path ?? this.settings.defaultConfig;
    if (!target) throw new ServiceError('没有配置文件路径，请选择保存位置', 'CONFIG_PATH_REQUIRED');
    const savedPath = await this.saveConfigFile(parsed, target);
    this.config = parsed;
    this.settings.defaultConfig = savedPath;
    this.settings.instructions = [...parsed.instructions];
    await this.settingsStore.save(this.settings);
    this.emitState();
    return {saved: true, path: savedPath};
  }

  private async saveConfigFile(config: CpuConfig, path: string): Promise<string> {
    const absolute = resolve(path);
    if (extname(absolute).toLowerCase() !== '.json') {
      throw new ServiceError('CPU 配置必须保存为 .json 文件', 'CONFIG_PATH_REQUIRED');
    }
    await mkdir(dirname(absolute), {recursive: true});
    await atomicWrite(absolute, `${JSON.stringify(config, null, 2)}\n`);
    this.log('config', `saved ${absolute}`);
    return absolute;
  }

  async setInstructions(instructions: string[]): Promise<{ok: boolean; config?: CpuConfig; error?: string}> {
    if (this.running) return {ok: false, error: '测试正在运行，不能修改指令集'};
    try {
      const parsed = parseInstructionSet(instructions);
      this.settings = {...this.settings, instructions: parsed};
      await this.settingsStore.save(this.settings);
      if (this.config) {
        this.config = {...this.config, instructions: parsed};
        if (this.circuit) this.circuit = {...this.circuit, config: this.config};
      }
      this.log('settings', `instructions: ${parsed.join(',')}`);
      this.emitState();
      return {ok: true, config: this.config ?? undefined};
    } catch (error) {
      return {ok: false, error: describeError(error)};
    }
  }

  assembleSource(source: string): AssembleResult {
    const origin = this.config?.pc.initial ?? 0x3000;
    const attempt = tryAssemble(source, {origin, instructions: this.config?.instructions});
    if (!attempt.ok) {
      return {ok: false, diagnostics: [attempt.diagnostic], message: attempt.diagnostic.message};
    }
    return {
      ok: true,
      words: attempt.program.hex,
      symbols: attempt.program.symbols,
      lines: attempt.program.instructions.map((instruction) => ({
        address: instruction.address,
        hex: instruction.hex,
        text: instruction.text,
      })),
    };
  }

  async startRun(request: RunRequest): Promise<RunStartResult> {
    if (this.running) return {started: false, error: '已有测试正在运行'};
    if (!this.circuit || !this.config) return {started: false, error: '请先加载 CPU 电路'};
    let tests: TestInput[];
    let label: string;
    try {
      ({tests, label} = await this.buildTests(request));
    } catch (error) {
      return {started: false, error: describeError(error)};
    }
    if (tests.length === 0) return {started: false, error: '没有可执行的测试'};
    this.running = true;
    this.lastError = null;
    this.lastSummary = null;
    this.controller = new AbortController();
    this.bridgeStatus = 'starting';
    this.emit({
      type: 'started',
      startedAt: new Date().toISOString(),
      total: tests.length,
      suite: label,
      circuitPath: this.circuit.path,
      configName: this.config.name,
    });
    this.emitState();
    const circuitPath = this.circuit.path;
    const config = this.config;
    this.runPromise = this.executeRun(circuitPath, config, tests, request, label);
    return {started: true, total: tests.length};
  }

  async stop(): Promise<void> {
    if (!this.running || !this.controller) return;
    this.bridgeStatus = 'stopping';
    this.log('run', 'stop requested');
    this.emitState();
    this.controller.abort();
    if (this.bridge) await this.bridge.terminate().catch(() => undefined);
    if (this.runPromise) await this.runPromise.catch(() => undefined);
  }

  async waitForRun(): Promise<void> {
    if (this.runPromise) await this.runPromise;
  }

  private async executeRun(
    circuitPath: string,
    config: CpuConfig,
    tests: TestInput[],
    request: RunRequest,
    label: string,
  ): Promise<void> {
    const bridge = this.createBridge();
    this.bridge = bridge;
    this.bridgeStatus = 'running';
    this.emitState();
    let completed = 0;
    let currentTestId: string | undefined;
    let lastCycleProgress = 0;
    try {
      const runner = new DifferentialRunner({
        circuitPath,
        config,
        bridge,
        signal: this.controller!.signal,
        maxCycles: this.settings.maxCycles,
        stopOnPcDivergence: true,
        onProgress: (event) => {
          if (event.kind === 'test-start') {
            currentTestId = event.testId;
            this.emit({type: 'progress', completed, total: tests.length, currentTestId});
          } else if (event.kind === 'cycle') {
            // Keep the UI live without flooding IPC during 10k+ cycle tests.
            const now = Date.now();
            if (now - lastCycleProgress >= 150 || event.cycle % 32 === 0) {
              lastCycleProgress = now;
              this.emit({
                type: 'progress',
                completed,
                total: tests.length,
                currentTestId,
                cycle: event.cycle,
                currentPc: event.pc,
                currentInstruction: event.instruction,
                expectedPc: event.expectedPc,
                expectedInstruction: event.expectedInstruction,
              });
            }
          } else if (event.kind === 'test-result') {
            completed++;
            // Main window only needs status/counters. The full result (including
            // per-cycle trace) is already persisted and fetched by the result
            // window by ID.
            this.emit({
              type: 'test-result',
              result: {
                ...event.result,
                signalCheckpoints: [],
                trace: [],
                instructions: [],
              },
            });
            this.emit({type: 'progress', completed, total: tests.length, currentTestId});
          }
        },
      });
      const summary = await runner.run(tests);
      this.lastSummary = summary;
      if (this.controller!.signal.aborted) {
        this.log('run', 'stopped by user');
        await this.saveHistory(summary, tests, request, label, false);
        this.emit({type: 'stopped', summary: {...summary, results: []}, message: '测试已停止'});
      } else {
        const record = await this.saveHistory(summary, tests, request, label, true);
        this.emit({type: 'finished', summary: {...summary, results: []}, historyId: record.meta.id});
        this.log('run', `finished ${summary.totals.passed}/${summary.totals.total} pass`);
      }
    } catch (error) {
      const message = describeError(error);
      this.lastError = message;
      this.log('error', message);
      if (this.controller!.signal.aborted) {
        this.emit({type: 'stopped', message: '测试已停止'});
      } else {
        this.emit({
          type: 'error',
          message,
          code: error instanceof BridgeError ? error.code : undefined,
          stderr: bridge.stderr.slice(-8192),
        });
      }
    } finally {
      await bridge.close().catch(() => undefined);
      this.bridge = null;
      this.running = false;
      this.bridgeStatus = 'stopped';
      this.controller = null;
      this.emitState();
    }
  }

  private async loadDirectedSuite(layout: ReturnType<typeof layoutForConfig>) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.suiteFile, 'utf8'));
    } catch (error) {
      throw new ServiceError(
        `无法读取外部测试集 ${this.suiteFile}: ${error instanceof Error ? error.message : String(error)}`,
        'SUITE_FILE_ERROR',
      );
    }
    const suite = parseTestSuite(raw);
    if (!this.config) throw new ServiceError('尚未加载 CPU 配置', 'CONFIG_REQUIRED');
    const tests = testsFromSuite(suite, layout, this.config.instructions);
    if (tests.length === 0) {
      throw new ServiceError(
        `测试集 ${suite.name} 没有适用于当前指令集的用例`,
        'SUITE_EMPTY',
      );
    }
    return tests;
  }

  private async buildTests(request: RunRequest): Promise<{tests: TestInput[]; label: string}> {
    if (request.kind === 'history') {
      if (!request.historyId) throw new ServiceError('缺少历史记录 id', 'HISTORY_NOT_FOUND');
      const record = await this.historyStore.get(request.historyId);
      if (!record) throw new ServiceError('历史记录不存在', 'HISTORY_NOT_FOUND');
      const failedIds = new Set(
        record.summary.results.filter((result) => result.status !== 'pass').map((result) => result.id),
      );
      const tests = request.onlyFailed ? record.tests.filter((test) => failedIds.has(test.id)) : record.tests;
      if (tests.length === 0) throw new ServiceError('该历史记录没有失败用例', 'NO_FAILED_TESTS');
      return {tests, label: request.onlyFailed ? `${record.meta.suite} (失败用例)` : `${record.meta.suite} (重跑)`};
    }
    if (!this.config || !this.circuit) throw new ServiceError('请先加载 CPU 电路', 'NO_CIRCUIT');
    if (request.kind === 'suite') {
      const suite = request.suite ?? 'basic';
      const layout = layoutForConfig(this.config);
      const all = suite === 'stress'
        ? generateStressTests(layout, {
            intensity: (request.intensity ?? 'standard') as StressIntensity,
            seedCount: request.seedCount,
            seed: request.seed,
            instructions: this.config.instructions,
          })
        : await this.loadDirectedSuite(layout);
      const selected = suite === 'full' ? all : selectSuite(all, suite);
      if (selected.length === 0) throw new ServiceError(`未知测试集: ${suite}`, 'UNKNOWN_SUITE');
      return {
        tests: selected.map((test) => ({
          id: test.id,
          name: test.name,
          category: test.category,
          description: test.description,
          assembly: test.assembly,
          steps: test.steps,
          signature: test.signature,
          seed: test.seed,
          maxCycles: request.maxCycles,
        })),
        label: suite === 'stress' ? `stress-${request.intensity ?? 'standard'}` : suite,
      };
    }
    const source = request.assembly ?? '';
    if (source.trim().length === 0) throw new ServiceError('汇编程序为空', 'EMPTY_ASSEMBLY');
    const origin = this.config.pc.initial;
    const program = assemble(source, {origin, instructions: this.config.instructions});
    if (program.words.length === 0) throw new ServiceError('汇编程序为空', 'EMPTY_ASSEMBLY');
    if (request.steps === undefined && request.stopPc === undefined) {
      throw new ServiceError('自定义汇编需要指定周期数或停止 PC', 'STEPS_REQUIRED');
    }
    return {
      tests: [
        {
          id: 'custom-asm',
          name: '自定义汇编',
          category: 'custom',
          description: '图形界面自定义汇编',
          assembly: source,
          steps: request.steps,
          stopPc: request.stopPc,
          seed: null,
          maxCycles: request.maxCycles,
        },
      ],
      label: 'custom',
    };
  }

  private async saveHistory(
    summary: RunSummary,
    tests: TestInput[],
    request: RunRequest,
    label: string,
    complete: boolean,
  ): Promise<HistoryRecord> {
    const record = await this.historyStore.save(summary, tests, request, label, complete);
    this.lastReportId = record.meta.id;
    this.reportCache.set(record.meta.id, record);
    this.log('history', `saved ${record.meta.id}`);
    return record;
  }

  async listHistory(): Promise<HistoryMeta[]> {
    return this.historyStore.list();
  }

  async getHistory(id: string): Promise<HistoryRecord | null> {
    return this.getReportRecord(id);
  }

  async getReportMeta(id: string): Promise<ReportMeta | null> {
    const record = await this.getReportRecord(id);
    if (!record) return null;
    return {
      id: record.meta.id,
      createdAt: record.meta.createdAt,
      circuitPath: record.meta.circuitPath,
      circuitName: record.meta.circuitName,
      configName: record.meta.configName,
      suite: record.meta.suite,
      totals: record.meta.totals,
      durationMs: record.meta.durationMs,
      complete: record.meta.complete,
      instructions: record.summary.instructions ? [...record.summary.instructions] : undefined,
      coverage: record.summary.coverage,
      tests: record.summary.results.map((result) => toReportTestSummary(result)),
    };
  }

  async getReportTest(reportId: string, testId: string): Promise<TestResult | null> {
    const record = await this.getReportRecord(reportId);
    const result = record?.summary.results.find((entry) => entry.id === testId);
    if (!result) return null;
    return normalizeReportTest({...result});
  }

  async getReportTrace(reportId: string, testId: string, offset: number, limit: number): Promise<TracePage | null> {
    const record = await this.getReportRecord(reportId);
    const test = record?.summary.results.find((entry) => entry.id === testId);
    if (!test) return null;
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit) || 200));
    const safeOffset = Math.max(0, Math.trunc(offset) || 0);
    const cycles = new Map<number, Map<string, {
      expected?: string;
      actual?: string;
      staticIndex?: number;
      actualStatus?: 'known' | 'unknown' | 'error';
    }>>();
    for (const checkpoint of test.signalCheckpoints ?? []) {
      let row = cycles.get(checkpoint.cycle);
      if (!row) {
        row = new Map();
        cycles.set(checkpoint.cycle, row);
      }
      row.set(checkpoint.signal, {
        expected: checkpoint.expected,
        actual: checkpoint.actual,
        staticIndex: checkpoint.staticIndex,
        actualStatus: checkpoint.actualStatus,
      });
    }
    let maxCycle = test.cyclesCompleted;
    for (const cycle of cycles.keys()) if (cycle > maxCycle) maxCycle = cycle;
    for (const checkpoint of test.pc?.checkpoints ?? []) {
      if (checkpoint.cycle > maxCycle) maxCycle = checkpoint.cycle;
    }
    const rows: TraceRow[] = [];
    const end = Math.min(maxCycle, safeOffset + safeLimit);
    for (let cycle = safeOffset + 1; cycle <= end; cycle++) {
      const values = cycles.get(cycle);
      const cell = (signal: string): TraceValue => {
        const value = values?.get(signal);
        return {
          expected: value?.expected,
          actual: value?.actual,
          actualStatus: value?.actualStatus ?? (value?.actual === undefined ? 'unsampled' : 'known'),
        };
      };
      const staticIndex = values?.values().next().value?.staticIndex;
      rows.push({
        cycle,
        staticIndex,
        staticAddress: staticIndex === undefined ? undefined : test.origin + staticIndex * 4,
        pc: cell('pc'),
        instruction: cell('instruction'),
        regWrite: cell('RegWrite'),
        regAddr: cell('RegAddr'),
        regData: cell('RegData'),
        memWrite: cell('MemWrite'),
        memAddr: cell('MemAddr'),
        memData: cell('MemData'),
      });
    }
    return {
      total: maxCycle,
      offset: safeOffset,
      limit: safeLimit,
      rows,
      firstMismatchCycle: test.firstSignalMismatch?.cycle,
      firstMismatchSignal: test.firstSignalMismatch?.signal,
      firstPcCycle: test.pc?.firstDivergence?.cycle,
    };
  }

  async exportHex(reportId: string, testId: string, path: string): Promise<{saved: boolean; path: string}> {
    const test = await this.getReportTest(reportId, testId);
    if (!test) throw new ServiceError('测试报告不存在', 'REPORT_NOT_FOUND');
    const absolute = resolve(path);
    if (extname(absolute).toLowerCase() !== '.hex') {
      throw new ServiceError('Logisim ROM 文件必须使用 .hex 扩展名', 'HEX_PATH_REQUIRED');
    }
    const text = encodeLogisimHex(test.machineCode, {startIndex: test.romStartIndex ?? 0});
    await mkdir(dirname(absolute), {recursive: true});
    await atomicWrite(absolute, text);
    this.log('report', `exported hex ${reportId}/${testId} to ${absolute}`);
    return {saved: true, path: absolute};
  }

  private async getReportRecord(id: string): Promise<HistoryRecord | null> {
    const cached = this.reportCache.get(id);
    if (cached) return cached;
    const record = await this.historyStore.get(id);
    if (record) {
      this.reportCache.set(id, record);
      if (this.reportCache.size > 2) {
        const oldest = this.reportCache.keys().next().value;
        if (oldest) this.reportCache.delete(oldest);
      }
    }
    return record;
  }

  async exportHistory(id: string, path?: string): Promise<{saved: boolean; path?: string}> {
    const record = await this.historyStore.get(id);
    if (!record) throw new ServiceError('历史记录不存在', 'HISTORY_NOT_FOUND');
    if (!path) throw new ServiceError('缺少导出路径', 'EXPORT_PATH_REQUIRED');
    const absolute = resolve(path);
    await mkdir(dirname(absolute), {recursive: true});
    await writeFile(absolute, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    this.log('history', `exported ${id} to ${absolute}`);
    return {saved: true, path: absolute};
  }

  async readAsm(path: string): Promise<{path: string; source: string}> {
    const absolute = await validateFile(path, '.asm');
    return {path: absolute, source: await readFile(absolute, 'utf8')};
  }

  async saveAsm(source: string, path: string): Promise<{saved: boolean; path: string}> {
    const absolute = resolve(path);
    if (extname(absolute).toLowerCase() !== '.asm') {
      throw new ServiceError('汇编文件必须使用 .asm 扩展名', 'ASM_PATH_REQUIRED');
    }
    await mkdir(dirname(absolute), {recursive: true});
    await atomicWrite(absolute, source);
    this.log('asm', `saved ${absolute}`);
    return {saved: true, path: absolute};
  }

  getLogs(): string[] {
    return [...this.logs];
  }

  private createBridge(): LogisimBridge {
    const factory = this.options.bridgeFactory ?? ((options: BridgeOptions) => new LogisimBridge(options));
    const bridge = factory({
      root: this.options.repoRoot,
      java: this.settings.javaPath || undefined,
      timeoutMs: this.settings.bridgeTimeoutMs,
      onStderr: (text) => this.log('bridge', text),
    });
    return bridge;
  }

  private log(source: string, message: string): void {
    const stamp = new Date().toISOString();
    for (const line of String(message).split(/\r?\n/)) {
      if (line.length === 0) continue;
      this.logs.push(`${stamp} [${source}] ${line}`);
    }
    if (this.logs.length > 500) this.logs = this.logs.slice(-500);
  }

  private emit(update: RunUpdate): void {
    this.onUpdate?.(update);
  }

  private emitState(): void {
    this.emit({type: 'state', state: this.getState()});
  }
}

class SettingsStore {
  private file: string;
  constructor(private readonly dataDir: string) {
    this.file = join(dataDir, 'settings.json');
  }
  async init(): Promise<void> {
    await mkdir(this.dataDir, {recursive: true});
  }
  async load(): Promise<TesterSettings> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Partial<TesterSettings>;
      return normalizeSettings({...DEFAULT_SETTINGS, ...raw});
    } catch {
      return {...DEFAULT_SETTINGS};
    }
  }
  async save(settings: TesterSettings): Promise<void> {
    await mkdir(this.dataDir, {recursive: true});
    await atomicWrite(this.file, `${JSON.stringify(settings, null, 2)}\n`);
  }
}

class HistoryStore {
  private historyDir: string;
  constructor(private readonly dataDir: string) {
    this.historyDir = join(dataDir, 'history');
  }
  async init(): Promise<void> {
    await mkdir(this.historyDir, {recursive: true});
  }
  async save(
    summary: RunSummary,
    tests: TestInput[],
    request: RunRequest,
    label: string,
    complete: boolean,
  ): Promise<HistoryRecord> {
    const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const meta: HistoryMeta = {
      id,
      createdAt: new Date().toISOString(),
      circuitPath: summary.circuitPath,
      circuitName: summary.circuitName,
      configName: summary.configName,
      suite: label,
      totals: summary.totals,
      durationMs: summary.durationMs,
      complete,
    };
    const record: HistoryRecord = {meta, summary, tests, request};
    await atomicWrite(join(this.historyDir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
    await atomicWrite(join(this.historyDir, `${id}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
    return record;
  }
  async list(): Promise<HistoryMeta[]> {
    const files = (await readdir(this.historyDir)).filter((name) => name.endsWith('.meta.json'));
    const metas: HistoryMeta[] = [];
    for (const file of files) {
      try {
        metas.push(JSON.parse(await readFile(join(this.historyDir, file), 'utf8')) as HistoryMeta);
      } catch {
        // Ignore a partially written or corrupted metadata file.
      }
    }
    metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return metas;
  }
  async get(id: string): Promise<HistoryRecord | null> {
    if (!/^[A-Za-z0-9-]+$/.test(id)) return null;
    try {
      return JSON.parse(await readFile(join(this.historyDir, `${id}.json`), 'utf8')) as HistoryRecord;
    } catch {
      return null;
    }
  }
}

function buildCourseProfile(
  path: string,
  circuitName: string,
  ports: CircuitProfile['ports'],
  components: CircuitProfile['components'],
): CircuitProfile {
  if (circuitName !== 'main') {
    throw new ServiceError(`顶层电路必须是 main，实际加载到 ${circuitName}`, 'CIRCUIT_NOT_MAIN');
  }
  const reset = ports.find((port) => port.label === 'reset');
  if (!reset) throw new ServiceError('缺少顶层输入 reset', 'MISSING_RESET');
  if (reset.direction !== 'input' || reset.width !== 1) {
    throw new ServiceError('reset 必须是 1 位输入', 'INVALID_RESET');
  }
  for (const output of REQUIRED_OUTPUTS) {
    const port = ports.find((candidate) => candidate.label === output.label);
    if (!port) throw new ServiceError(`缺少顶层输出 ${output.label}`, 'MISSING_OUTPUT');
    if (port.direction !== 'output' || port.width !== output.width) {
      throw new ServiceError(
        `${output.label} 必须是 ${output.width} 位输出（实际 ${port.width} 位 ${port.direction}）`,
        'INVALID_OUTPUT',
      );
    }
  }
  const clocks = components.filter((component) => component.kind === 'clock');
  if (clocks.length !== 1) {
    throw new ServiceError(`需要且只能有一个内部 Clock 元件，实际 ${clocks.length} 个`, 'CLOCK_COUNT');
  }
  const roms = components.filter((component) => component.kind === 'rom');
  if (roms.length !== 1) throw new ServiceError(`需要且只能有一个指令 ROM，实际 ${roms.length} 个`, 'ROM_COUNT');
  const rom = roms[0];
  if (rom.addressBits !== 12 || rom.dataBits !== 32 || (rom.capacity ?? 0) < 4096) {
    throw new ServiceError('ROM 必须是 4096×32（12 位地址、32 位数据）', 'ROM_SHAPE');
  }
  const warnings: string[] = [];
  if ((clocks[0].label ?? '').length > 0 && clocks[0].label !== 'CLK') {
    warnings.push(`内部时钟标签为 "${clocks[0].label}"；Bridge 不使用标签，只驱动 Logisim Clock 元件。`);
  }
  const outputs = {
    instruction: 'Instr',
    pc: 'pc',
    regWrite: 'RegWrite',
    regAddr: 'RegAddr',
    regData: 'RegData',
    memWrite: 'MemWrite',
    memAddr: 'MemAddr',
    memData: 'MemData',
  } as const;
  const config = parseCpuConfig({
    schemaVersion: 1,
    name: 'course-single-cycle-mips',
    circuitName: 'main',
    clock: {mode: 'internal', halfCycles: 2},
    reset: {strategy: 'pin', pin: 'reset', activeLow: false, ticks: 1},
    pc: {mode: 'pin', port: 'pc', initial: 0x3000, checkEachCycle: true},
    rom: {
      path: rom.path,
      baseByteAddress: 0x3000,
      addressBits: 12,
      addressShift: 2,
      dataBits: 32,
      capacityWords: 4096,
    },
    ram: {
      baseByteAddress: 0,
      capacityWords: 3072,
    },
    limits: {maxSteps: 200000, maxCycles: 200000},
    inputs: [],
    outputs,
    instructions: [...COURSE_INSTRUCTIONS],
    notes: '图形界面根据课程 CPU Profile 生成的配置。',
  });
  return {
    path,
    circuitName,
    ports,
    components,
    clocks: clocks.map((clock) => ({path: clock.path, label: clock.label})),
    rom,
    config,
    warnings,
  };
}

function toReportTestSummary(result: TestResult): ReportTestSummary {
  const instructionCount = result.instructions?.length ?? result.machineCodeWords ?? result.machineCode.length;
  return {
    id: result.id,
    name: result.name,
    category: result.category,
    status: result.status,
    errorType: result.errorType,
    message: result.message,
    staticInstructions: instructionCount,
    cyclesRequested: result.cyclesRequested,
    cyclesCompleted: result.cyclesCompleted,
    firstDifferenceCycle: result.firstSignalMismatch?.cycle ?? result.pc?.firstDivergence?.cycle,
    firstDifferenceSignal: result.firstSignalMismatch?.signal ?? (result.pc?.firstDivergence ? 'pc' : undefined),
    seed: result.seed,
  };
}

function normalizeReportTest(test: TestResult): TestResult {
  // The result window receives one test at a time. Do not send the full
  // per-signal trace in the initial payload; it is fetched in pages.
  delete test.signalCheckpoints;
  delete test.trace;
  if (!test.instructions && test.assembly) {
    try {
      const attempt = tryAssemble(test.assembly, {origin: test.origin});
      if (attempt.ok) test.instructions = attempt.program.instructions;
    } catch {
      // Legacy reports may contain source that no longer reassembles; show
      // machine words and source lines only instead of fabricating fields.
    }
  }
  return test;
}

function normalizeSettings(input: TesterSettings): TesterSettings {
  return {
    javaPath: typeof input.javaPath === 'string' ? input.javaPath.trim() : '',
    defaultCircuit: typeof input.defaultCircuit === 'string' ? input.defaultCircuit.trim() : '',
    defaultConfig: typeof input.defaultConfig === 'string' ? input.defaultConfig.trim() : '',
    bridgeTimeoutMs: clampInt(input.bridgeTimeoutMs, 1000, 120000, DEFAULT_SETTINGS.bridgeTimeoutMs),
    maxCycles: clampInt(input.maxCycles, 1, 1000000, DEFAULT_SETTINGS.maxCycles),
    theme: input.theme === 'dark' ? 'dark' : 'light',
    instructions: normalizeInstructionSetting(input.instructions),
  };
}

function normalizeInstructionSetting(value: unknown): InstructionName[] {
  if (!Array.isArray(value)) return [...COURSE_INSTRUCTIONS];
  try {
    const parsed = normalizeInstructions(value.filter((item): item is string => typeof item === 'string'));
    return parsed.length > 0 ? parsed : [...COURSE_INSTRUCTIONS];
  } catch {
    return [...COURSE_INSTRUCTIONS];
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

async function validateFile(path: string, extension: string): Promise<string> {
  const absolute = resolve(path);
  if (extname(absolute).toLowerCase() !== extension) {
    throw new ServiceError(`文件必须是 ${extension} 文件: ${absolute}`, 'INVALID_PATH');
  }
  const info = await stat(absolute).catch(() => null);
  if (!info?.isFile()) throw new ServiceError(`文件不存在: ${absolute}`, 'FILE_NOT_FOUND');
  return absolute;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, content, 'utf8');
  await rename(temp, path);
}

function describeError(error: unknown): string {
  if (error instanceof ServiceError) return error.message;
  if (error instanceof BridgeError) return `${error.code}: ${error.message}`;
  if (error instanceof MipsError) return `${error.code}: ${error.message}`;
  if (error instanceof ConfigError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

export type {Diagnostic};
