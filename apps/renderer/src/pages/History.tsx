import {useEffect, useState} from 'react';
import type {HistoryMeta, HistoryRecord} from '../../../../packages/desktop-ipc/src/index.js';
import type {TestResult} from '../../../../packages/differential-runner/src/types.js';
import {ResultDetail} from '../components/ResultDetail.js';
import {ResultTable} from '../components/ResultTable.js';
import {formatDuration, shortPath} from '../format.js';

interface Props {
  onOpenWorkbench: () => void;
  onMessage: (message: string | null) => void;
}

export function HistoryPage({onOpenWorkbench, onMessage}: Props) {
  const [entries, setEntries] = useState<HistoryMeta[]>([]);
  const [record, setRecord] = useState<HistoryRecord | null>(null);
  const [selected, setSelected] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh(autoOpen = false): Promise<void> {
    try {
      const list = await window.cpuTester.listHistory();
      setEntries(list);
      if (autoOpen && list.length > 0) await open(list[0]);
    } catch (error) {
      onMessage(String(error));
    }
  }

  useEffect(() => {
    void refresh(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function open(meta: HistoryMeta): Promise<void> {
    setBusy(true);
    try {
      const next = await window.cpuTester.getHistory(meta.id);
      setRecord(next);
      setSelected(next?.summary.results.find((result) => result.status !== 'pass') ?? next?.summary.results[0] ?? null);
    } catch (error) {
      onMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function exportReport(): Promise<void> {
    if (!record) return;
    const path = await window.cpuTester.chooseReportPath(`report-${record.meta.id}.json`);
    if (!path) return;
    const result = await window.cpuTester.exportReport(record.meta.id, path);
    if (result.saved) onMessage(`已导出 ${result.path}`);
  }

  async function rerun(onlyFailed: boolean): Promise<void> {
    if (!record) return;
    setBusy(true);
    try {
      const result = await window.cpuTester.rerun(record.meta.id, onlyFailed);
      if (!result.started) onMessage(result.error ?? '无法重跑');
      else onOpenWorkbench();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="history-page" data-testid="history">
      <section className="card history-list-card">
        <div className="card-head">
          <div>
            <div className="eyebrow">本地记录</div>
            <h2>测试历史</h2>
          </div>
          <button className="btn ghost" onClick={() => refresh()} disabled={busy}>
            刷新
          </button>
        </div>
        {entries.length === 0 ? (
          <div className="empty-panel small-empty">
            <div className="empty-icon">↺</div>
            <div>
              <strong>还没有历史记录</strong>
              <p>完成一次真实测试后，报告会自动保存到本地。</p>
            </div>
          </div>
        ) : (
          <div className="history-items">
            {entries.map((entry) => (
              <button
                key={entry.id}
                className={`history-item ${record?.meta.id === entry.id ? 'active' : ''}`}
                onClick={() => open(entry)}
              >
                <div className="history-item-head">
                  <span className={`badge ${historyStatus(entry).className}`}>{historyStatus(entry).label}</span>
                  <span className="muted small">{new Date(entry.createdAt).toLocaleString('zh-CN')}</span>
                </div>
                <div className="cell-title">
                  {entry.circuitName} · {entry.suite}
                </div>
                <div className="cell-sub" title={entry.circuitPath}>
                  {shortPath(entry.circuitPath, 48)}
                </div>
                <div className="history-item-stats">
                  <span>{entry.totals.passed} 通过</span>
                  <span>{entry.totals.failed} 失败</span>
                  <span>{entry.totals.errors} 错误</span>
                  <span>{formatDuration(entry.durationMs)}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="card history-detail-card">
        {!record ? (
          <div className="empty-panel">
            <div className="empty-icon">◈</div>
            <div>
              <strong>选择一条历史记录</strong>
              <p>查看测试结果、导出 JSON 报告，或重新执行失败用例。</p>
            </div>
          </div>
        ) : (
          <>
            <div className="card-head">
              <div>
                <div className="eyebrow">历史详情</div>
                <h2>{record.meta.circuitName} · {record.meta.suite}</h2>
                <div className="detail-meta">
                  <span className={`badge ${historyStatus(record.meta).className}`}>{historyStatus(record.meta).label}</span>
                  {record.meta.complete === false && <span>运行被用户提前停止，不能视为完整 PASS</span>}
                  <span>{new Date(record.meta.createdAt).toLocaleString('zh-CN')}</span>
                  <span>{formatDuration(record.meta.durationMs)}</span>
                </div>
              </div>
              <div className="toolbar-row">
                <button className="btn ghost" onClick={exportReport}>导出 JSON</button>
                <button className="btn" onClick={() => rerun(true)} disabled={busy}>
                  重跑失败用例
                </button>
                <button className="btn ghost" onClick={() => rerun(false)} disabled={busy}>
                  重跑全部
                </button>
              </div>
            </div>
            <div className="metric-grid">
              <Metric label="总用例" value={String(record.summary.totals.total)} />
              <Metric label="通过" value={String(record.summary.totals.passed)} />
              <Metric label="失败" value={String(record.summary.totals.failed)} />
              <Metric label="错误" value={String(record.summary.totals.errors)} />
            </div>
            <ResultTable
              results={record.summary.results}
              selectedId={selected?.id}
              onSelect={setSelected}
              emptyText="该记录没有用例结果"
            />
            <ResultDetail result={selected} />
          </>
        )}
      </section>
    </div>
  );
}

function Metric({label, value}: {label: string; value: string}) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function historyStatus(entry: HistoryMeta): {label: string; className: string} {
  if (entry.complete === false) return {label: '已停止', className: 'warn'};
  return entry.totals.failed + entry.totals.errors === 0
    ? {label: 'PASS', className: 'ok'}
    : {label: 'FAIL', className: 'fail'};
}
