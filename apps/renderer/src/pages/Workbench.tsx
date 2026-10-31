import {useState} from 'react';
import type {AppState, SuiteName} from '../../../../packages/desktop-ipc/src/index.js';
import type {RunSummary, TestResult} from '../../../../packages/differential-runner/src/types.js';
import type {LiveRun} from '../App.js';
import {ResultDetail} from '../components/ResultDetail.js';
import {ResultTable} from '../components/ResultTable.js';
import {formatDuration, hex, shortPath} from '../format.js';

interface Props {
  state: AppState | null;
  run: LiveRun | null;
  results: TestResult[];
  counts: {pass: number; fail: number; error: number};
  summary: RunSummary | null;
  progress: number;
  elapsed: number;
  selected: TestResult | null;
  assembly: string;
  onAssemblyChange: (value: string) => void;
  onSelect: (result: TestResult) => void;
  onChooseCircuit: () => Promise<void>;
  onChooseConfig: () => Promise<void>;
  onRunSuite: (suite: SuiteName) => Promise<void>;
  onRunAssembly: (steps: number, stopPc?: number) => Promise<void>;
  onStop: () => Promise<void>;
  onOpenEditor: () => void;
}

export function Workbench(props: Props) {
  const {state, run, results, counts, summary, selected} = props;
  const [mode, setMode] = useState<'suite' | 'assembly'>('suite');
  const [suite, setSuite] = useState<SuiteName>('basic');
  const [steps, setSteps] = useState(4);
  const [stopPcText, setStopPcText] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const configured = Boolean(state?.circuit && state?.config);
  const running = Boolean(run?.running);
  const total = run?.total ?? summary?.totals.total ?? 0;
  const completed = run?.completed ?? summary?.totals.total ?? 0;

  async function start(): Promise<void> {
    setLocalError(null);
    if (mode === 'suite') {
      await props.onRunSuite(suite);
      return;
    }
    const stopPc = stopPcText.trim().length > 0 ? parseAddress(stopPcText) : undefined;
    if (stopPcText.trim().length > 0 && stopPc === null) {
      setLocalError('停止 PC 需要 32 位十六进制地址');
      return;
    }
    if (stopPc === undefined && (!Number.isInteger(steps) || steps <= 0)) {
      setLocalError('周期数必须是正整数');
      return;
    }
    await props.onRunAssembly(steps, stopPc ?? undefined);
  }

  return (
    <div className="workbench" data-testid="workbench">
      <div className="section-grid">
        <section className="card circuit-card">
          <div className="card-head">
            <div>
              <div className="eyebrow">被测电路</div>
              <h2>{state?.circuit?.circuitName ?? '未加载 CPU'}</h2>
            </div>
            <button className="btn primary" onClick={props.onChooseCircuit}>
              选择 .circ
            </button>
          </div>
          {state?.circuit ? (
            <>
              <div className="path-line" title={state.circuit.path}>
                {shortPath(state.circuit.path, 70)}
              </div>
              <div className="chip-row">
                <span className="chip good">内部 Clock × {state.circuit.clocks.length}</span>
                <span className="chip">指令 ROM {state.circuit.rom.addressBits} 位地址 / {state.circuit.rom.capacity} 字</span>
                <span className="chip">
                  逻辑 DM {state.config?.ram.capacityWords ?? state.circuit.config.ram.capacityWords} 字
                  （0x{(state.config?.ram.baseByteAddress ?? 0).toString(16).toUpperCase()} 起）
                </span>
              </div>
              {state.circuit.warnings.map((warning) => (
                <div className="notice notice-warn" key={warning}>
                  {warning}
                </div>
              ))}
              <div className="port-list">
                {state.circuit.ports.map((port) => (
                  <span className="port-pill" key={port.id}>
                    <span className={`dot ${port.direction === 'input' ? 'dot-input' : 'dot-output'}`} />
                    {port.label}
                    <em>{port.width}b</em>
                  </span>
                ))}
              </div>
            </>
          ) : (
            <div className="empty-panel small-empty">
              <div className="empty-icon">⌁</div>
              <div>
                <strong>先加载 Logisim 电路</strong>
                <p>顶层电路应为 main，包含 reset 输入和课程要求的 8 个输出信号。</p>
              </div>
            </div>
          )}
        </section>

        <section className="card config-card">
          <div className="card-head">
            <div>
              <div className="eyebrow">CPU Profile</div>
              <h2>{state?.config?.name ?? '默认课程配置'}</h2>
            </div>
            <button className="btn ghost" onClick={props.onChooseConfig} disabled={running}>
              载入配置
            </button>
          </div>
          {state?.config ? (
            <div className="kv-grid">
              <Kv label="PC 初值" value={hex(state.config.pc.initial)} />
              <Kv label="复位" value={`${state.config.reset.strategy === 'pin' ? state.config.reset.pin : state.config.reset.strategy} · ${state.config.reset.strategy === 'pin' && state.config.reset.activeLow ? '低有效' : '高有效'}`} />
              <Kv label="时钟" value={state.config.clock.mode === 'internal' ? '内部 Logisim Clock' : `外部 ${state.config.clock.pin}`} />
              <Kv label="ROM 基址" value={hex(state.config.rom.baseByteAddress)} />
              <Kv label="ROM 容量" value={`${state.config.rom.capacityWords} 字`} />
              <Kv label="逻辑 DM 基址" value={hex(state.config.ram.baseByteAddress)} />
              <Kv label="逻辑 DM 容量" value={`${state.config.ram.capacityWords} 字`} />
              <Kv label="观测方式" value="时钟沿前采样顶层输出" />
            </div>
          ) : (
            <div className="empty-inline">加载电路后自动生成课程配置；也可以载入已有 JSON。</div>
          )}
        </section>
      </div>

      <section className="card run-card">
        <div className="card-head">
          <div>
            <div className="eyebrow">测试控制</div>
            <h2>运行差分测试</h2>
          </div>
          <div className="segmented">
            <button className={mode === 'suite' ? 'active' : ''} onClick={() => setMode('suite')} disabled={running}>
              内置测试集
            </button>
            <button className={mode === 'assembly' ? 'active' : ''} onClick={() => setMode('assembly')} disabled={running}>
              自定义汇编
            </button>
          </div>
        </div>

        {mode === 'suite' ? (
          <div className="run-controls">
            <label className="field">
              <span>测试套件</span>
              <select value={suite} onChange={(event) => setSuite(event.target.value as SuiteName)} disabled={running}>
                <option value="basic">basic · 核心</option>
                <option value="full">full · 全部</option>
                <option value="alu">alu · 算术/移位</option>
                <option value="memory">memory · load/store</option>
                <option value="branch">branch · 分支</option>
              </select>
            </label>
            <button className="btn primary" data-testid="run-suite" onClick={start} disabled={!configured || running}>
              {running ? '测试运行中…' : '开始测试'}
            </button>
            {running && (
              <button className="btn danger" onClick={props.onStop}>
                停止
              </button>
            )}
          </div>
        ) : (
          <div className="run-controls assembly-controls">
            <div className="assembly-mini">
              <textarea
                value={props.assembly}
                onChange={(event) => props.onAssemblyChange(event.target.value)}
                spellCheck={false}
                disabled={running}
                aria-label="自定义汇编"
              />
              <button className="link-btn" onClick={props.onOpenEditor}>
                在编辑器中打开 ↗
              </button>
            </div>
            <div className="inline-fields">
              <label className="field narrow">
                <span>周期数</span>
                <input
                  type="number"
                  min={1}
                  value={steps}
                  onChange={(event) => setSteps(Number(event.target.value))}
                  disabled={running}
                />
              </label>
              <label className="field narrow">
                <span>或停止 PC</span>
                <input
                  placeholder="0x3030"
                  value={stopPcText}
                  onChange={(event) => setStopPcText(event.target.value)}
                  disabled={running}
                />
              </label>
              <button className="btn primary" onClick={start} disabled={!configured || running}>
                运行自定义汇编
              </button>
            </div>
          </div>
        )}
        {localError && <div className="notice notice-error">{localError}</div>}
        {!configured && <div className="notice notice-warn">请先加载 .circ 电路，测试服务会校验唯一 ROM 和 8 个顶层观测输出。</div>}
      </section>

      <section className={`card progress-card ${running ? 'running' : ''}`}>
        <div className="progress-head">
          <div>
            <div className="eyebrow">运行状态</div>
            <h2>
              {running
                ? run?.currentTestId
                  ? `正在执行 ${run.currentTestId}`
                  : '正在执行测试'
                : summary
                  ? '最近一次测试'
                  : '尚未运行'}
            </h2>
          </div>
          <div className="progress-numbers">
            <span>
              {completed}/{total || '—'}
            </span>
            <strong>{running ? formatDuration(props.elapsed) : summary ? formatDuration(summary.durationMs) : '—'}</strong>
          </div>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{width: `${props.progress}%`}} />
        </div>
        <div className="stat-row">
          <Stat label="通过" value={counts.pass} tone="ok" />
          <Stat label="失败" value={counts.fail} tone="fail" />
          <Stat label="错误" value={counts.error} tone="error" />
          <Stat label="当前周期" value={run?.running ? (run.cycle ?? '—') : '—'} tone="muted" />
        </div>
        <div className="cycle-focus">
          <span>
            当前 PC <strong className="mono">{run?.running ? (run.currentPc ?? '—') : '—'}</strong>
          </span>
          <span>
            当前指令 <strong className="mono">{run?.running ? (run.currentInstruction ?? '—') : '—'}</strong>
          </span>
          <span>
            参考 PC <strong className="mono">{run?.running ? (run.expectedPc ?? '—') : '—'}</strong>
          </span>
        </div>
        {run?.error && <div className="notice notice-error">{run.error}</div>}
        {run?.message && !run.error && <div className="notice notice-warn">{run.message}</div>}
        {!running && !summary && <div className="empty-inline">运行测试后，这里会显示实时进度、通过/失败计数和耗时。</div>}
      </section>

      <section className="card results-card">
        <div className="card-head">
          <div>
            <div className="eyebrow">测试结果</div>
            <h2>用例列表</h2>
          </div>
          {summary && (
            <div className="summary-line">
              <span className="badge ok">{summary.totals.passed} 通过</span>
              <span className="badge fail">{summary.totals.failed} 失败</span>
              <span className="badge error">{summary.totals.errors} 错误</span>
            </div>
          )}
        </div>
        <ResultTable
          results={results}
          selectedId={selected?.id}
          onSelect={props.onSelect}
          emptyText="还没有测试结果。加载电路后运行内置测试集或自定义汇编。"
        />
      </section>

      <ResultDetail result={selected} />
    </div>
  );
}

function Kv({label, value}: {label: string; value: string}) {
  return (
    <div className="kv">
      <span>{label}</span>
      <strong className="mono">{value}</strong>
    </div>
  );
}

function Stat({label, value, tone}: {label: string; value: number | string; tone: string}) {
  return (
    <div className={`stat ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function parseAddress(text: string): number | null {
  const value = /^0x/i.test(text.trim()) ? Number.parseInt(text.trim().slice(2), 16) : Number(text.trim());
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) return null;
  return value >>> 0;
}
