import {useEffect, useMemo, useState} from 'react';
import type {
  ReportMeta,
  ReportTestSummary,
  TracePage,
  TraceRow,
  TraceValue,
} from '../../../../packages/desktop-ipc/src/index.js';
import type {TestResult} from '../../../../packages/differential-runner/src/types.js';
import {formatSignalValue, type SignalNumberFormat} from '../../../../packages/mips-core/src/index.js';

type Tab = 'code' | 'trace';
type CodeFormat = 'hex' | 'binary' | 'fields';
type NumberFormat = 'hex' | 'udec' | 'sdec' | 'binary';
const TRACE_PAGE_SIZE = 200;

const SIGNALS = [
  {key: 'pc', label: 'PC', signalName: 'pc', width: 32},
  {key: 'instruction', label: 'Instr', signalName: 'instruction', width: 32},
  {key: 'regWrite', label: 'RegWrite', signalName: 'RegWrite', width: 1},
  {key: 'regAddr', label: 'RegAddr', signalName: 'RegAddr', width: 5},
  {key: 'regData', label: 'RegData', signalName: 'RegData', width: 32},
  {key: 'memWrite', label: 'MemWrite', signalName: 'MemWrite', width: 1},
  {key: 'memAddr', label: 'MemAddr', signalName: 'MemAddr', width: 32},
  {key: 'memData', label: 'MemData', signalName: 'MemData', width: 32},
] as const;

type SignalKey = typeof SIGNALS[number]['key'];

export function ResultApp() {
  const reportId = useMemo(() => new URLSearchParams(window.location.search).get('reportId') ?? '', []);
  const [meta, setMeta] = useState<ReportMeta | null>(null);
  const [selectedId, setSelectedId] = useState<string>('');
  const [test, setTest] = useState<TestResult | null>(null);
  const [tab, setTab] = useState<Tab>('code');
  const [sort, setSort] = useState('default');
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [codeFormat, setCodeFormat] = useState<CodeFormat>('hex');
  const [numberFormat, setNumberFormat] = useState<NumberFormat>('hex');
  const [signalFormats, setSignalFormats] = useState<Partial<Record<SignalKey, NumberFormat | 'default'>>>({});
  const [selectedStatic, setSelectedStatic] = useState<number | undefined>();
  const [tracePage, setTracePage] = useState<TracePage | null>(null);
  const [traceOffset, setTraceOffset] = useState(0);
  const [jumpCycle, setJumpCycle] = useState('');
  const [showDifferences, setShowDifferences] = useState(false);

  useEffect(() => {
    if (!reportId) {
      setMessage('缺少报告 ID');
      return;
    }
    window.cpuTester.getReportMeta(reportId).then((next) => {
      if (!next) {
        setMessage('报告不存在或已损坏');
        return;
      }
      setMeta(next);
      setSelectedId(defaultTestId(next.tests));
    }).catch((error) => setMessage(String(error)));
  }, [reportId]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setTest(null);
    setTracePage(null);
    setTraceOffset(0);
    setSelectedStatic(undefined);
    window.cpuTester.getReportTest(reportId, selectedId)
      .then((next) => { if (!cancelled) setTest(next); })
      .catch((error) => { if (!cancelled) setMessage(String(error)); });
    return () => { cancelled = true; };
  }, [reportId, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    window.cpuTester.getReportTrace(reportId, selectedId, traceOffset, TRACE_PAGE_SIZE)
      .then((next) => { if (!cancelled) setTracePage(next); })
      .catch((error) => { if (!cancelled) setMessage(String(error)); });
    return () => { cancelled = true; };
  }, [reportId, selectedId, traceOffset]);

  const visibleTests = useMemo(() => {
    if (!meta) return [];
    const tests = failuresOnly
      ? meta.tests.filter((entry) => entry.status !== 'pass')
      : [...meta.tests];
    return tests.sort((a, b) => compareTests(a, b, sort));
  }, [meta, failuresOnly, sort]);

  const selectedSummary = meta?.tests.find((entry) => entry.id === selectedId);

  async function exportHex(): Promise<void> {
    if (!test) return;
    setMessage(null);
    try {
      const result = await window.cpuTester.exportHex(reportId, test.id);
      if (result.saved) setMessage(`HEX 已导出：${result.path}`);
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function exportJson(): Promise<void> {
    if (!meta) return;
    try {
      const path = await window.cpuTester.chooseReportPath(`report-${meta.id}.json`);
      if (!path) return;
      const result = await window.cpuTester.exportReport(meta.id, path);
      if (result.saved) setMessage(`报告 JSON 已导出：${result.path}`);
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function copy(text: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setMessage(`${label}已复制`);
    } catch {
      setMessage('复制失败');
    }
  }

  function jump(): void {
    const cycle = Number(jumpCycle);
    if (!Number.isInteger(cycle) || cycle < 1) {
      setMessage('请输入有效的周期号');
      return;
    }
    const bounded = tracePage ? Math.min(cycle, tracePage.total) : cycle;
    const offset = Math.floor((bounded - 1) / TRACE_PAGE_SIZE) * TRACE_PAGE_SIZE;
    setTraceOffset(offset);
  }

  if (!reportId) return <div className="result-empty">缺少报告 ID</div>;
  if (message && !meta) return <div className="result-empty">{message}</div>;
  if (!meta) return <div className="result-empty">正在加载报告…</div>;

  return (
    <div className="result-shell" data-testid="result-window">
      <header className="result-header">
        <div>
          <div className="eyebrow">测试结果 · {meta.id}</div>
          <h1>{meta.circuitName} · {meta.suite}</h1>
          <div className="result-header-meta">
            <span className={`badge ${historyStatus(meta).className}`}>{historyStatus(meta).label}</span>
            <span>{new Date(meta.createdAt).toLocaleString('zh-CN')}</span>
            <span>{meta.durationMs.toLocaleString()} ms</span>
            <span>{meta.totals.total} 用例</span>
            <span>{meta.totals.passed} 通过 / {meta.totals.failed} 失败 / {meta.totals.errors} 错误</span>
            {meta.instructions && <span>指令集：{meta.instructions.join(', ')}</span>}
            {meta.complete === false && <span className="warn-text">运行被停止，不能视为完整 PASS</span>}
          </div>
        </div>
        <div className="toolbar-row">
          <button className="btn ghost" onClick={exportJson}>导出 JSON</button>
        </div>
      </header>

      {message && <div className="banner result-banner"><span>{message}</span><button className="icon-btn" onClick={() => setMessage(null)}>×</button></div>}

      <div className="result-body">
        <aside className="result-list-panel">
          <div className="result-list-controls">
            <label className="field">
              <span>排序</span>
              <select value={sort} onChange={(event) => setSort(event.target.value)}>
                <option value="default">失败优先 + 首次差异周期</option>
                <option value="status">状态</option>
                <option value="static">静态指令数</option>
                <option value="cycles">动态周期数</option>
                <option value="first">首次差异周期</option>
              </select>
            </label>
            <label className="check-row">
              <input type="checkbox" checked={failuresOnly} onChange={(event) => setFailuresOnly(event.target.checked)} />
              只看失败 / 错误
            </label>
          </div>
          <div className="result-test-list">
            {visibleTests.map((entry) => {
              const status = statusLabel(entry);
              return (
                <button
                  key={entry.id}
                  className={`result-test-item ${entry.id === selectedId ? 'active' : ''}`}
                  onClick={() => setSelectedId(entry.id)}
                >
                  <div className="result-test-top">
                    <span className={`badge ${status.className}`}>{status.label}</span>
                    <span className="muted small">静态 {entry.staticInstructions} · 动态 {entry.cyclesCompleted}/{entry.cyclesRequested}</span>
                  </div>
                  <div className="cell-title">{entry.name}</div>
                  <div className="cell-sub">{entry.id}</div>
                  <div className="result-test-diff">
                    {entry.errorType === 'cycle-limit'
                      ? `达到周期上限 · ${entry.cyclesCompleted}/${entry.cyclesRequested}`
                      : entry.errorType === 'timeout'
                        ? 'Bridge timeout'
                        : entry.firstDifferenceCycle !== undefined
                          ? `首次差异 cycle ${entry.firstDifferenceCycle} · ${entry.firstDifferenceSignal ?? 'pc'}`
                          : '无差异'}
                  </div>
                </button>
              );
            })}
            {visibleTests.length === 0 && <div className="empty-inline">没有匹配的用例</div>}
          </div>
        </aside>

        <main className="result-detail-panel">
          {!test || !selectedSummary ? (
            <div className="result-empty">请选择左侧测试用例</div>
          ) : (
            <>
              <div className="result-detail-head">
                <div>
                  <div className="eyebrow">{test.category} · seed {test.seed ?? '—'}</div>
                  <h2>{test.name}</h2>
                  <p className="muted small">{test.description}</p>
                </div>
                <div className="result-detail-stats">
                  <span className={`badge ${statusLabel(selectedSummary).className}`}>{statusLabel(selectedSummary).label}</span>
                  <span>静态指令 <strong>{test.instructions?.length ?? test.machineCode.length}</strong></span>
                  <span>动态周期 <strong>{test.cyclesCompleted}</strong> / 预期 <strong>{test.cyclesRequested}</strong></span>
                </div>
              </div>

              {test.message && <div className={`notice ${test.status === 'pass' ? 'notice-ok' : 'notice-error'}`}>{test.message}</div>}
              {test.firstSignalMismatch && (
                <div className="notice notice-error">
                  首个信号差异：cycle {test.firstSignalMismatch.cycle} · {test.firstSignalMismatch.signal} ·
                  期望 {test.firstSignalMismatch.expected} · 实际 {test.firstSignalMismatch.actual}
                </div>
              )}
              {test.pc?.firstDivergence && !test.firstSignalMismatch && (
                <div className="notice notice-error">
                  首个 PC 差异：cycle {test.pc.firstDivergence.cycle} · 期望 {test.pc.firstDivergence.expected} ·
                  实际 {test.pc.firstDivergence.actual}
                </div>
              )}

              <div className="result-tabs">
                <button className={tab === 'code' ? 'active' : ''} onClick={() => setTab('code')}>汇编 / 机器码</button>
                <button className={tab === 'trace' ? 'active' : ''} onClick={() => setTab('trace')}>逐周期执行轨迹</button>
              </div>

              {meta.coverage && <CoverageSummary meta={meta} />}

              {tab === 'code' ? (
                <CodeTab
                  test={test}
                  format={codeFormat}
                  onFormat={setCodeFormat}
                  selectedStatic={selectedStatic}
                  onSelectStatic={setSelectedStatic}
                  onCopy={copy}
                  onExport={exportHex}
                />
              ) : (
                <TraceTab
                  page={tracePage}
                  offset={traceOffset}
                  total={tracePage?.total ?? 0}
                  onOffset={setTraceOffset}
                  jumpCycle={jumpCycle}
                  onJumpCycle={setJumpCycle}
                  onJump={jump}
                  showDifferences={showDifferences}
                  onShowDifferences={setShowDifferences}
                  numberFormat={numberFormat}
                  onNumberFormat={setNumberFormat}
                  signalFormats={signalFormats}
                  onSignalFormat={(signal, format) => setSignalFormats((current) => ({...current, [signal]: format}))}
                  onSelectCycle={(row) => {
                    if (row.staticIndex !== undefined) {
                      setSelectedStatic(row.staticIndex);
                      setTab('code');
                    }
                  }}
                />
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function CodeTab({
  test,
  format,
  onFormat,
  selectedStatic,
  onSelectStatic,
  onCopy,
  onExport,
}: {
  test: TestResult;
  format: CodeFormat;
  onFormat: (format: CodeFormat) => void;
  selectedStatic?: number;
  onSelectStatic: (index: number) => void;
  onCopy: (text: string, label: string) => void;
  onExport: () => void;
}) {
  const rows = staticRows(test);
  useEffect(() => {
    if (selectedStatic === undefined) return;
    document.getElementById(`static-instruction-${selectedStatic}`)?.scrollIntoView({block: 'center'});
  }, [selectedStatic]);
  return (
    <section className="result-section">
      <div className="result-toolbar">
        <div className="segmented">
          <button className={format === 'hex' ? 'active' : ''} onClick={() => onFormat('hex')}>十六进制</button>
          <button className={format === 'binary' ? 'active' : ''} onClick={() => onFormat('binary')}>完整二进制</button>
          <button className={format === 'fields' ? 'active' : ''} onClick={() => onFormat('fields')}>字段分段二进制</button>
        </div>
        <div className="toolbar-row">
          <button className="btn ghost" onClick={() => onCopy(rows.map((row) => row.hex).join('\n'), '全部机器码')}>复制全部机器码</button>
          <button className="btn primary" onClick={onExport}>导出 Logisim HEX</button>
        </div>
      </div>
      <div className="table-wrap result-code-table">
        <table className="data-table">
          <thead>
            <tr>
              <th>地址 / PC</th>
              <th>静态汇编</th>
              <th>机器码</th>
              <th>编码字段</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const fields = decodeFields(row.hex);
              return (
                <tr
                  key={`${row.address}-${row.hex}`}
                  id={`static-instruction-${row.index}`}
                  className={selectedStatic === row.index ? 'selected' : ''}
                  onClick={() => onSelectStatic(row.index)}
                >
                  <td className="mono">0x{row.address.toString(16).padStart(8, '0')}<br /><span className="muted small">index {row.index}</span></td>
                  <td className="mono">{row.text}</td>
                  <td className="mono machine-word">
                    {format === 'fields' ? <SegmentedBits hex={row.hex} fields={fields} /> : formatWord(row.hex, format === 'binary' ? 'binary' : 'hex')}
                  </td>
                  <td className="fields-cell">
                    {fields.type === 'R'
                      ? <span>R · opcode {fields.opcode} · rs ${fields.rs} · rt ${fields.rt} · rd ${fields.rd} · shamt {fields.shamt} · funct {fields.funct}</span>
                      : fields.type === 'J'
                        ? <span>J · opcode {fields.opcode} · index 0x{fields.index.toString(16).padStart(7, '0')} · target 0x{(fields.index << 2).toString(16)}</span>
                        : <span>I · opcode {fields.opcode} · rs ${fields.rs} · rt ${fields.rt} · imm 0x{fields.immediate.toString(16).padStart(4, '0')}</span>}
                  </td>
                  <td><button className="link-btn" onClick={(event) => { event.stopPropagation(); onCopy(row.hex, '机器码'); }}>复制</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small">ROM index 0 对应 PC 0x{test.origin.toString(16)}；HEX 文件使用 Logisim 2.7.1 的 <span className="mono">v2.0 raw</span> 格式。</p>
    </section>
  );
}

function TraceTab({
  page,
  offset,
  total,
  onOffset,
  jumpCycle,
  onJumpCycle,
  onJump,
  showDifferences,
  onShowDifferences,
  numberFormat,
  onNumberFormat,
  signalFormats,
  onSignalFormat,
  onSelectCycle,
}: {
  page: TracePage | null;
  offset: number;
  total: number;
  onOffset: (offset: number) => void;
  jumpCycle: string;
  onJumpCycle: (value: string) => void;
  onJump: () => void;
  showDifferences: boolean;
  onShowDifferences: (value: boolean) => void;
  numberFormat: NumberFormat;
  onNumberFormat: (format: NumberFormat) => void;
  signalFormats: Partial<Record<SignalKey, NumberFormat | 'default'>>;
  onSignalFormat: (signal: SignalKey, format: NumberFormat | 'default') => void;
  onSelectCycle: (row: TraceRow) => void;
}) {
  if (!page) return <div className="result-empty">正在加载轨迹…</div>;
  const rows = showDifferences ? page.rows.filter((row) => rowHasDifference(row, page)) : page.rows;
  return (
    <section className="result-section">
      <div className="result-toolbar trace-toolbar">
        <div className="toolbar-row">
          <label className="field narrow">
            <span>默认数值格式</span>
            <select value={numberFormat} onChange={(event) => onNumberFormat(event.target.value as NumberFormat)}>
              <option value="hex">十六进制</option>
              <option value="udec">无符号十进制</option>
              <option value="sdec">有符号十进制</option>
              <option value="binary">二进制</option>
            </select>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={showDifferences} onChange={(event) => onShowDifferences(event.target.checked)} />
            只显示有差异的周期
          </label>
        </div>
        <div className="toolbar-row">
          <input className="jump-input" placeholder="跳转周期" value={jumpCycle} onChange={(event) => onJumpCycle(event.target.value)} />
          <button className="btn ghost" onClick={onJump}>跳转</button>
          <button className="btn ghost" disabled={offset <= 0} onClick={() => onOffset(Math.max(0, offset - 200))}>上一页</button>
          <span className="muted small">{offset + 1}–{Math.min(total, offset + 200)} / {total}</span>
          <button className="btn ghost" disabled={offset + 200 >= total} onClick={() => onOffset(offset + 200)}>下一页</button>
        </div>
      </div>
      <div className="table-wrap trace-table-wrap">
        <table className="data-table trace-table">
          <thead>
            <tr>
              <th>Cycle</th>
              {SIGNALS.map((signal) => (
                <th key={signal.key}>
                  <div>{signal.label}</div>
                  <select
                    className="format-select"
                    value={signalFormats[signal.key] ?? 'default'}
                    onChange={(event) => onSignalFormat(signal.key, event.target.value as NumberFormat | 'default')}
                  >
                    <option value="default">默认</option>
                    <option value="hex">HEX</option>
                    <option value="udec">U</option>
                    <option value="sdec">S</option>
                    <option value="binary">BIN</option>
                  </select>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.cycle}
                className={row.cycle === page.firstMismatchCycle || row.cycle === page.firstPcCycle ? 'selected' : ''}
                onClick={() => onSelectCycle(row)}
              >
                <td className="mono">{row.cycle}</td>
                {SIGNALS.map((signal) => {
                  const value = row[signal.key];
                  const mismatch = row.cycle === page.firstMismatchCycle && page.firstMismatchSignal === signal.signalName;
                  const localFormat = signalFormats[signal.key];
                  const format = localFormat && localFormat !== 'default' ? localFormat : numberFormat;
                  return (
                    <td key={signal.key} className={mismatch ? 'cell-mismatch' : ''}>
                      <TraceCell value={value} width={signal.width} format={format} />
                    </td>
                  );
                })}
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={9} className="empty-inline">本页没有匹配的周期</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="muted small">采样时刻：时钟沿前。写使能为 0 时地址/数据未参与比较，显示为“未采样”，不视为 0。</p>
    </section>
  );
}

function TraceCell({value, width, format}: {value: TraceValue; width: number; format: NumberFormat}) {
  return (
    <div className="trace-cell">
      <div><span className="trace-label">E</span> {formatTraceValue(value.expected, width, format, 'expected')}</div>
      <div><span className="trace-label">A</span> {formatTraceValue(value.actual, width, format, value.actualStatus)}</div>
    </div>
  );
}

function CoverageSummary({meta}: {meta: ReportMeta}) {
  const coverage = meta.coverage;
  if (!coverage) return null;
  return (
    <details className="coverage-panel">
      <summary>覆盖率（来自真实参考执行）</summary>
      <div className="coverage-grid">
        <div><span>静态 / 动态指令</span><strong>{coverage.staticInstructions} / {coverage.dynamicInstructions}</strong></div>
        <div><span>GRF 写入 / 读取</span><strong>{coverage.registerWrites.length} / {coverage.registerReads.length} 个寄存器</strong></div>
        <div><span>sll shamt</span><strong>{coverage.sllShamt.length} / 32 种</strong></div>
        <div><span>beq taken / not taken</span><strong>{coverage.beqTaken} / {coverage.beqNotTaken}</strong></div>
        <div><span>分支 前向 / 反向</span><strong>{coverage.branchForward} / {coverage.branchBackward}</strong></div>
        <div><span>lw / sw</span><strong>{coverage.lwCount} / {coverage.swCount}</strong></div>
        <div><span>offset 0 / + / −</span><strong>{coverage.zeroOffset} / {coverage.positiveOffset} / {coverage.negativeOffset}</strong></div>
        <div><span>非分支 PC+4</span><strong>{coverage.nonControlPcPlus4} / {coverage.nonControlExecuted}</strong></div>
        <div><span>PC+4 违规</span><strong className={coverage.nonControlPcBad ? 'danger-text' : ''}>{coverage.nonControlPcBad}</strong></div>
        <div><span>负 / 高位 / 零结果</span><strong>{coverage.negativeResults} / {coverage.highBitResults} / {coverage.zeroResults}</strong></div>
        <div><span>最长用例动态周期</span><strong>{coverage.maxTestCycles}</strong></div>
      </div>
      <div className="coverage-instructions">
        {meta.instructions?.map((kind) => (
          <span className="chip" key={kind}>{kind}: {coverage.instructions[kind] ?? 0}</span>
        ))}
        {Object.entries(coverage.instructions)
          .filter(([kind]) => !((meta.instructions ?? []) as string[]).includes(kind))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([kind, count]) => <span className="chip" key={kind}>{kind}: {count}</span>)}
      </div>
    </details>
  );
}

function staticRows(test: TestResult): {index: number; address: number; hex: string; text: string}[] {
  if (test.instructions && test.instructions.length > 0) {
    return test.instructions.map((instruction, index) => ({
      index,
      address: instruction.address,
      hex: instruction.hex,
      text: instruction.text,
    }));
  }
  const sourceLines = test.assembly.split(/\r?\n/).filter((line) => line.trim().length > 0 && !line.trim().startsWith('#'));
  return test.machineCode.map((hex, index) => ({
    index,
    address: test.origin + index * 4,
    hex,
    text: sourceLines[index]?.trim() ?? `instruction ${index}`,
  }));
}

function decodeFields(hex: string) {
  const word = Number.parseInt(hex.replace(/^0x/i, ''), 16) >>> 0;
  const opcode = word >>> 26;
  const rs = (word >>> 21) & 0x1f;
  const rt = (word >>> 16) & 0x1f;
  const rd = (word >>> 11) & 0x1f;
  const shamt = (word >>> 6) & 0x1f;
  const funct = word & 0x3f;
  const immediate = word & 0xffff;
  const index = word & 0x03ffffff;
  const type = opcode === 0 ? 'R' : opcode === 0x02 ? 'J' : 'I';
  return {word, opcode, rs, rt, rd, shamt, funct, immediate, index, type} as const;
}

function SegmentedBits({hex, fields}: {hex: string; fields: ReturnType<typeof decodeFields>}) {
  const bits = Number.parseInt(hex.replace(/^0x/i, ''), 16).toString(2).padStart(32, '0');
  if (fields.type === 'R') {
    return (
      <span className="bit-groups">
        <span className="bits-group opcode">{bits.slice(0, 6)}<em>opcode</em></span>
        <span className="bits-group">{bits.slice(6, 11)}<em>rs</em></span>
        <span className="bits-group">{bits.slice(11, 16)}<em>rt</em></span>
        <span className="bits-group">{bits.slice(16, 21)}<em>rd</em></span>
        <span className="bits-group">{bits.slice(21, 26)}<em>shamt</em></span>
        <span className="bits-group funct">{bits.slice(26, 32)}<em>funct</em></span>
      </span>
    );
  }
  if (fields.type === 'J') {
    return (
      <span className="bit-groups">
        <span className="bits-group opcode">{bits.slice(0, 6)}<em>opcode</em></span>
        <span className="bits-group immediate">{bits.slice(6, 32)}<em>instr_index</em></span>
      </span>
    );
  }
  return (
    <span className="bit-groups">
      <span className="bits-group opcode">{bits.slice(0, 6)}<em>opcode</em></span>
      <span className="bits-group">{bits.slice(6, 11)}<em>rs</em></span>
      <span className="bits-group">{bits.slice(11, 16)}<em>rt</em></span>
      <span className="bits-group immediate">{bits.slice(16, 32)}<em>immediate</em></span>
    </span>
  );
}

function formatWord(hex: string, format: 'hex' | 'binary'): string {
  const word = Number.parseInt(hex.replace(/^0x/i, ''), 16) >>> 0;
  if (format === 'binary') return word.toString(2).padStart(32, '0');
  return `0x${word.toString(16).padStart(8, '0')}`;
}

function formatTraceValue(
  value: string | undefined,
  width: number,
  format: NumberFormat,
  status: TraceValue['actualStatus'] | 'expected' | undefined,
): string {
  return formatSignalValue(value, width, format as SignalNumberFormat, status === 'expected' ? undefined : status);
}

function rowHasDifference(row: TraceRow, page: TracePage): boolean {
  if (row.cycle === page.firstPcCycle) return true;
  return SIGNALS.some((signal) => {
    const value = row[signal.key];
    if (value.expected === undefined || value.actual === undefined) return false;
    return Number.parseInt(value.expected.replace(/^0x/i, ''), 16) !== Number.parseInt(value.actual.replace(/^0x/i, ''), 16);
  });
}

function defaultTestId(tests: ReportTestSummary[]): string {
  return [...tests].sort((a, b) => compareTests(a, b, 'default'))[0]?.id ?? '';
}

function compareTests(a: ReportTestSummary, b: ReportTestSummary, mode: string): number {
  if (mode === 'status') {
    const rank = (entry: ReportTestSummary) => entry.status === 'pass' ? 9 : entry.errorType === 'cycle-limit' ? 5 : entry.status === 'error' ? 4 : entry.status === 'fail' ? 1 : 6;
    const diff = rank(a) - rank(b);
    if (diff !== 0) return diff;
  } else if (mode === 'static') {
    const diff = a.staticInstructions - b.staticInstructions;
    if (diff !== 0) return diff;
  } else if (mode === 'cycles') {
    const diff = a.cyclesCompleted - b.cyclesCompleted;
    if (diff !== 0) return diff;
  } else if (mode === 'first') {
    const diff = (a.firstDifferenceCycle ?? Number.MAX_SAFE_INTEGER) - (b.firstDifferenceCycle ?? Number.MAX_SAFE_INTEGER);
    if (diff !== 0) return diff;
  }
  const failureRank = (entry: ReportTestSummary) => entry.status === 'pass' ? 9 : entry.status === 'fail' ? 1 : entry.status === 'error' ? 2 : 3;
  const rankDiff = failureRank(a) - failureRank(b);
  if (rankDiff !== 0) return rankDiff;
  const firstDiff = (a.firstDifferenceCycle ?? Number.MAX_SAFE_INTEGER) - (b.firstDifferenceCycle ?? Number.MAX_SAFE_INTEGER);
  if (firstDiff !== 0) return firstDiff;
  return a.name.localeCompare(b.name);
}

function statusLabel(entry: ReportTestSummary): {label: string; className: string} {
  if (entry.errorType === 'timeout') return {label: 'TIMEOUT', className: 'timeout'};
  if (entry.errorType === 'cycle-limit') return {label: 'LIMIT', className: 'limit'};
  if (entry.errorType === 'cancelled') return {label: 'CANCELLED', className: 'muted'};
  if (entry.status === 'pass') return {label: 'PASS', className: 'ok'};
  if (entry.status === 'fail') return {label: 'FAIL', className: 'fail'};
  return {label: 'ERROR', className: 'error'};
}

function historyStatus(meta: ReportMeta): {label: string; className: string} {
  if (meta.complete === false) return {label: '已停止', className: 'warn'};
  return meta.totals.failed + meta.totals.errors === 0
    ? {label: 'PASS', className: 'ok'}
    : {label: 'FAIL', className: 'fail'};
}
