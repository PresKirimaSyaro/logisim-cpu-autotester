import {useEffect, useRef, useState} from 'react';
import type {
  AppState,
  RunUpdate,
  StressIntensity,
  SuiteName,
  TesterSettings,
} from '../../../packages/desktop-ipc/src/index.js';
import type {RunSummary} from '../../../packages/differential-runner/src/types.js';
import type {InstructionName} from '../../../packages/mips-core/src/isa/instruction-set.js';
import {Workbench} from './pages/Workbench.js';
import {Editor} from './pages/Editor.js';
import {HistoryPage} from './pages/History.js';
import {SettingsPage} from './pages/Settings.js';


export type Page = 'workbench' | 'editor' | 'history' | 'settings';

export interface LiveRun {
  startedAt: number;
  total: number;
  completed: number;
  currentTestId?: string;
  cycle?: number;
  currentPc?: string;
  currentInstruction?: string;
  expectedPc?: string;
  expectedInstruction?: string;
  counts: {pass: number; fail: number; error: number};
  summary?: RunSummary;
  running: boolean;
  error?: string;
  message?: string;
}

const DEFAULT_ASM = `# 自定义 MIPS 汇编
# 课程 CPU Profile: PC=0x3000, ROM 4096x32, 逻辑 DM 3072x32
    ori $t0, $zero, 5
    ori $t1, $zero, 7
    add $t2, $t0, $t1
    sw  $t2, 0x100($zero)
`;

const PAGE_TITLE: Record<Page, string> = {
  workbench: '测试工作台',
  editor: '汇编编辑器',
  history: '测试历史',
  settings: '设置',
};

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [page, setPage] = useState<Page>('workbench');
  const [assembly, setAssembly] = useState(() => {
    const stored = localStorage.getItem('cpu-tester.asm');
    return (stored ?? DEFAULT_ASM).replace('RAM 3072x32', '逻辑 DM 3072x32');
  });
  const [run, setRun] = useState<LiveRun | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    window.cpuTester.getState().then(setState).catch((error) => setBanner(String(error)));
    const offState = window.cpuTester.onStateUpdate(setState);
    const offRun = window.cpuTester.onRunUpdate(handleRunUpdate);
    return () => {
      offState();
      offRun();
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    localStorage.setItem('cpu-tester.asm', assembly);
  }, [assembly]);

  useEffect(() => {
    document.documentElement.dataset.theme = state?.settings.theme ?? 'light';
  }, [state?.settings.theme]);

  useEffect(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (run?.running) {
      timerRef.current = window.setInterval(() => {
        setElapsed(Date.now() - run.startedAt);
      }, 200);
    }
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
  }, [run?.running, run?.startedAt]);

  function handleRunUpdate(update: RunUpdate): void {
    if (update.type === 'state') {
      setState(update.state);
      return;
    }
    if (update.type === 'started') {
      setElapsed(0);
      setBanner(null);
      setPage('workbench');
      setRun({
        startedAt: Date.parse(update.startedAt) || Date.now(),
        total: update.total,
        completed: 0,
        counts: {pass: 0, fail: 0, error: 0},
        running: true,
      });
      return;
    }
    if (update.type === 'progress') {
      setRun((current) =>
        current
          ? {
              ...current,
              completed: update.completed,
              currentTestId: update.currentTestId ?? current.currentTestId,
              cycle: update.cycle ?? current.cycle,
              currentPc: update.currentPc ?? current.currentPc,
              currentInstruction: update.currentInstruction ?? current.currentInstruction,
              expectedPc: update.expectedPc ?? current.expectedPc,
              expectedInstruction: update.expectedInstruction ?? current.expectedInstruction,
            }
          : current,
      );
      return;
    }
    if (update.type === 'test-result') {
      setRun((current) => {
        if (!current) return current;
        const counts = {...current.counts};
        if (update.result.status === 'pass') counts.pass++;
        else if (update.result.status === 'fail') counts.fail++;
        else counts.error++;
        return {...current, counts, completed: current.completed + 1};
      });
      return;
    }
    if (update.type === 'finished') {
      setRun((current) =>
        current
          ? {
              ...current,
              running: false,
              summary: {...update.summary, results: []},
              completed: update.summary.totals.total,
              total: update.summary.totals.total,
              counts: {
                pass: update.summary.totals.passed,
                fail: update.summary.totals.failed,
                error: update.summary.totals.errors,
              },
            }
          : current,
      );
      setState((current) => (current ? {...current, lastSummary: update.summary, lastReportId: update.historyId} : current));
      return;
    }
    if (update.type === 'stopped') {
      setRun((current) =>
        current
          ? {
              ...current,
              running: false,
              summary: update.summary ? {...update.summary, results: []} : current.summary,
              counts: update.summary
                ? {
                    pass: update.summary.totals.passed,
                    fail: update.summary.totals.failed,
                    error: update.summary.totals.errors,
                  }
                : current.counts,
              message: update.message,
            }
          : current,
      );
      setBanner(update.message);
      return;
    }
    if (update.type === 'error') {
      setRun((current) => (current ? {...current, running: false, error: update.message} : current));
      setBanner(update.message);
    }
  }

  async function refreshState(): Promise<void> {
    try {
      setState(await window.cpuTester.getState());
    } catch (error) {
      setBanner(String(error));
    }
  }

  async function chooseCircuit(): Promise<void> {
    const path = await window.cpuTester.chooseCircuit();
    if (!path) return;
    const result = await window.cpuTester.inspectCircuit(path);
    if (!result.ok) {
      setBanner(result.message);
      await refreshState();
      return;
    }
    setBanner(null);
    await refreshState();
  }

  async function chooseConfig(): Promise<void> {
    const path = await window.cpuTester.chooseConfig();
    if (!path) return;
    try {
      await window.cpuTester.loadConfig(path);
      setBanner(null);
      await refreshState();
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error));
    }
  }

  async function setInstructions(instructions: InstructionName[]): Promise<void> {
    const result = await window.cpuTester.setInstructions(instructions);
    if (!result.ok) setBanner(result.error ?? '无法更新指令集');
  }

  async function runSuite(
    suite: SuiteName,
    intensity?: StressIntensity,
    maxCycles?: number,
    seed?: number,
    seedCount?: number,
  ): Promise<void> {
    const result = await window.cpuTester.run({kind: 'suite', suite, intensity, maxCycles, seed, seedCount});
    if (!result.started) setBanner(result.error ?? '无法启动测试');
  }

  async function runAssembly(steps: number, stopPc?: number, maxCycles?: number): Promise<void> {
    const result = await window.cpuTester.run({
      kind: 'assembly',
      assembly,
      steps: stopPc === undefined ? steps : undefined,
      stopPc,
      maxCycles,
    });
    if (!result.started) setBanner(result.error ?? '无法启动测试');
    else setPage('workbench');
  }

  async function openResult(): Promise<void> {
    const reportId = state?.lastReportId;
    if (!reportId) {
      setBanner('还没有可打开的测试报告，请先运行测试');
      return;
    }
    const opened = await window.cpuTester.openResult(reportId);
    if (!opened) setBanner('无法打开测试结果窗口');
  }

  async function stop(): Promise<void> {
    await window.cpuTester.stop();
  }

  const counts = run?.counts ?? {
    pass: state?.lastSummary?.totals.passed ?? 0,
    fail: state?.lastSummary?.totals.failed ?? 0,
    error: state?.lastSummary?.totals.errors ?? 0,
  };
  const summary = run?.summary ?? state?.lastSummary ?? null;
  const progress = run?.total ? Math.min(100, (run.completed / run.total) * 100) : 0;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <div className="brand-title">CPU Tester</div>
            <div className="brand-sub">Logisim · MIPS</div>
          </div>
        </div>
        <nav className="nav">
          <NavItem id="workbench" label="测试工作台" glyph="◈" active={page} onClick={setPage} />
          <NavItem id="editor" label="汇编编辑器" glyph="⌨" active={page} onClick={setPage} />
          <NavItem id="history" label="测试历史" glyph="↺" active={page} onClick={setPage} />
          <NavItem id="settings" label="设置" glyph="⚙" active={page} onClick={setPage} />
        </nav>
        <div className="sidebar-footer">
          <div className="status-line">
            <span className={`dot ${state?.bridgeStatus === 'running' ? 'dot-busy' : state?.bridgeStatus === 'error' ? 'dot-error' : 'dot-idle'}`} />
            Bridge {bridgeLabel(state?.bridgeStatus)}
          </div>
          <div className="muted small">Phase 7 · 外部测试集 · 动态指令集 · 真实 Java Bridge</div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <div className="eyebrow">Logisim CPU 差分测试</div>
            <h1>{PAGE_TITLE[page]}</h1>
          </div>
          <div className="topbar-meta">
            <div className="meta-pill" title={state?.circuit?.path ?? ''}>
              <span>电路</span>
              <strong>{state?.circuit?.circuitName ?? '未加载'}</strong>
            </div>
            <div className="meta-pill" title={state?.circuit?.path ?? ''}>
              <span>配置</span>
              <strong>{state?.config?.name ?? '未加载'}</strong>
            </div>
            {run?.running ? (
              <button className="btn danger" onClick={stop}>
                停止测试
              </button>
            ) : (
              <button className="btn" onClick={chooseCircuit}>
                选择电路
              </button>
            )}
          </div>
        </header>

        {banner && (
          <div className="banner">
            <span>{banner}</span>
            <button className="icon-btn" onClick={() => setBanner(null)} aria-label="关闭">
              ×
            </button>
          </div>
        )}

        <main className="content">
          {page === 'workbench' && (
            <Workbench
              state={state}
              run={run}
              counts={counts}
              summary={summary}
              progress={progress}
              elapsed={elapsed}
              assembly={assembly}
              lastReportId={state?.lastReportId ?? null}
              onAssemblyChange={setAssembly}
              onChooseCircuit={chooseCircuit}
              onChooseConfig={chooseConfig}
              onRunSuite={runSuite}
              onRunAssembly={runAssembly}
              onInstructionsChange={setInstructions}
              onOpenResult={openResult}
              onStop={stop}
              onOpenEditor={() => setPage('editor')}
            />
          )}
          {page === 'editor' && (
            <Editor
              source={assembly}
              onChange={setAssembly}
              onRun={runAssembly}
              running={Boolean(run?.running)}
              onOpenWorkbench={() => setPage('workbench')}
              onMessage={setBanner}
            />
          )}
          {page === 'history' && (
            <HistoryPage
              onOpenWorkbench={() => setPage('workbench')}
              onMessage={setBanner}
            />
          )}
          {page === 'settings' && (
            <SettingsPage
              state={state}
              onRefresh={refreshState}
              onMessage={setBanner}
              onUpdateSettings={async (patch: Partial<TesterSettings>) => {
                await window.cpuTester.updateSettings(patch);
                await refreshState();
              }}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function NavItem({
  id,
  label,
  glyph,
  active,
  onClick,
}: {
  id: Page;
  label: string;
  glyph: string;
  active: Page;
  onClick: (page: Page) => void;
}) {
  return (
    <button
      className={`nav-item ${active === id ? 'active' : ''}`}
      data-nav={id}
      onClick={() => onClick(id)}
    >
      <span className="nav-glyph">{glyph}</span>
      <span>{label}</span>
    </button>
  );
}

function bridgeLabel(status: AppState['bridgeStatus'] | undefined): string {
  switch (status) {
    case 'running':
      return '运行中';
    case 'starting':
      return '启动中';
    case 'stopping':
      return '停止中';
    case 'error':
      return '错误';
    default:
      return '就绪';
  }
}
