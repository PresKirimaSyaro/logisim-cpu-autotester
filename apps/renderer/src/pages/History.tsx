import {useEffect, useState} from 'react';
import type {HistoryMeta} from '../../../../packages/desktop-ipc/src/index.js';
import {formatDuration, shortPath} from '../format.js';

interface Props {
  onOpenWorkbench: () => void;
  onMessage: (message: string | null) => void;
}

export function HistoryPage({onOpenWorkbench, onMessage}: Props) {
  const [entries, setEntries] = useState<HistoryMeta[]>([]);
  const [busy, setBusy] = useState(false);

  async function refresh(): Promise<void> {
    try {
      setEntries(await window.cpuTester.listHistory());
    } catch (error) {
      onMessage(String(error));
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openResult(meta: HistoryMeta): Promise<void> {
    setBusy(true);
    try {
      const opened = await window.cpuTester.openResult(meta.id);
      if (!opened) onMessage('无法打开测试结果窗口');
    } catch (error) {
      onMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function exportReport(meta: HistoryMeta): Promise<void> {
    const path = await window.cpuTester.chooseReportPath(`report-${meta.id}.json`);
    if (!path) return;
    const result = await window.cpuTester.exportReport(meta.id, path);
    if (result.saved) onMessage(`已导出 ${result.path}`);
  }

  async function rerun(meta: HistoryMeta, onlyFailed: boolean): Promise<void> {
    setBusy(true);
    try {
      const result = await window.cpuTester.rerun(meta.id, onlyFailed);
      if (!result.started) onMessage(result.error ?? '无法重跑');
      else onOpenWorkbench();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="history-page history-page-single" data-testid="history">
      <section className="card history-list-card">
        <div className="card-head">
          <div>
            <div className="eyebrow">本地记录</div>
            <h2>测试历史</h2>
            <p className="muted small history-lead">点击记录在独立窗口中打开完整用例、机器码和逐周期轨迹。</p>
          </div>
          <button className="btn ghost" onClick={refresh} disabled={busy}>
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
          <div className="history-items history-items-wide">
            {entries.map((entry) => (
              <div key={entry.id} className="history-item history-item-row">
                <button className="history-open" onClick={() => openResult(entry)} disabled={busy}>
                  <div className="history-item-head">
                    <span className={`badge ${historyStatus(entry).className}`}>{historyStatus(entry).label}</span>
                    <span className="muted small">{new Date(entry.createdAt).toLocaleString('zh-CN')}</span>
                  </div>
                  <div className="cell-title">
                    {entry.circuitName} · {entry.suite}
                  </div>
                  <div className="cell-sub" title={entry.circuitPath}>
                    {shortPath(entry.circuitPath, 80)}
                  </div>
                  <div className="history-item-stats">
                    <span>{entry.totals.passed} 通过</span>
                    <span>{entry.totals.failed} 失败</span>
                    <span>{entry.totals.errors} 错误</span>
                    <span>{formatDuration(entry.durationMs)}</span>
                    <span>打开结果窗口 ↗</span>
                  </div>
                </button>
                <div className="history-actions">
                  <button className="btn ghost" onClick={() => exportReport(entry)} disabled={busy}>导出 JSON</button>
                  <button className="btn ghost" onClick={() => rerun(entry, true)} disabled={busy || entry.totals.failed + entry.totals.errors === 0}>
                    重跑失败
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function historyStatus(entry: HistoryMeta): {label: string; className: string} {
  if (entry.complete === false) return {label: '已停止', className: 'warn'};
  return entry.totals.failed + entry.totals.errors === 0
    ? {label: 'PASS', className: 'ok'}
    : {label: 'FAIL', className: 'fail'};
}
