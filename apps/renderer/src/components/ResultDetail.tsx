import type {TestResult} from '../../../../packages/differential-runner/src/types.js';
import {ERROR_LABEL, STATUS_LABEL, formatDuration, statusClass} from '../format.js';

const WRITE_SIGNALS = new Set(['RegWrite', 'RegAddr', 'RegData', 'MemWrite', 'MemAddr', 'MemData']);

export function ResultDetail({result}: {result: TestResult | null}) {
  if (!result) {
    return (
      <div className="empty-panel">
        <div className="empty-icon">◈</div>
        <div>
          <strong>选择一条测试结果</strong>
          <p>这里会展示汇编、机器码、寄存器写回、存储器写入、PC / 信号检查点和错误日志。</p>
        </div>
      </div>
    );
  }
  const checkpoints = result.signalCheckpoints ?? [];
  const writeCheckpoints = checkpoints.filter((checkpoint) => WRITE_SIGNALS.has(checkpoint.signal));
  return (
    <div className="result-detail">
      <div className="detail-head">
        <div>
          <div className="eyebrow">测试详情</div>
          <h2>{result.name}</h2>
          <div className="detail-meta">
            <span className={`badge ${statusClass(result.status)}`}>{STATUS_LABEL[result.status]}</span>
            {result.errorType && <span className="badge muted">{ERROR_LABEL[result.errorType] ?? result.errorType}</span>}
            <span>{result.category}</span>
            <span>{result.id}</span>
            <span>采样：时钟沿前</span>
          </div>
        </div>
        <div className="detail-stat">
          <span>耗时</span>
          <strong>{formatDuration(result.durationMs)}</strong>
          <span>
            {result.cyclesCompleted}/{result.cyclesRequested} 周期
          </span>
        </div>
      </div>

      {result.message && (
        <div className={`notice ${result.status === 'pass' ? 'notice-ok' : 'notice-error'}`}>{result.message}</div>
      )}

      <div className="metric-grid">
        <Metric label="执行周期" value={`${result.cyclesCompleted}/${result.cyclesRequested}`} />
        <Metric label="信号观测" value={String(checkpoints.length)} />
        <Metric label="可观察写入" value={String(result.reference?.observableWrites ?? '—')} />
        <Metric
          label="首次差异"
          value={result.firstSignalMismatch ? `c${result.firstSignalMismatch.cycle}` : '无'}
        />
      </div>

      {result.firstSignalMismatch && (
        <Section title="首次不一致">
          <div className="callout">
            <div>
              <span className="mono">{result.firstSignalMismatch.signal}</span> 在第{' '}
              <strong>{result.firstSignalMismatch.cycle}</strong> 个周期不一致
            </div>
            <div className="mono">
              期望 {result.firstSignalMismatch.expected} · 实际 {result.firstSignalMismatch.actual}
            </div>
          </div>
        </Section>
      )}

      {result.pc?.firstDivergence && (
        <Section title="首个 PC 不一致">
          <div className="callout">
            <div>
              第 <strong>{result.pc.firstDivergence.cycle}</strong> 个周期
            </div>
            <div className="mono">
              期望 {result.pc.firstDivergence.expected} · 实际 {result.pc.firstDivergence.actual}
            </div>
          </div>
        </Section>
      )}

      <Section title={`寄存器写回 / 存储器写入事件（${writeCheckpoints.length}）`}>
        {writeCheckpoints.length === 0 ? (
          <div className="empty-inline">没有需要比较的写回或访存事件。</div>
        ) : (
          <div className="table-wrap compact">
            <table className="data-table">
              <thead>
                <tr>
                  <th>周期</th>
                  <th>信号</th>
                  <th>期望</th>
                  <th>实际</th>
                  <th>结果</th>
                </tr>
              </thead>
              <tbody>
                {writeCheckpoints.slice(0, 120).map((checkpoint) => (
                  <tr key={`${checkpoint.cycle}-${checkpoint.signal}`}>
                    <td>{checkpoint.cycle}</td>
                    <td className="mono">{checkpoint.signal}</td>
                    <td className="mono">{checkpoint.expected}</td>
                    <td className={`mono ${checkpoint.match ? '' : 'fail-text'}`}>{checkpoint.actual}</td>
                    <td>
                      <span className={`badge ${checkpoint.match ? 'ok' : 'fail'}`}>
                        {checkpoint.match ? '一致' : '不一致'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {writeCheckpoints.length > 120 && (
              <div className="empty-inline">仅显示前 120 条；完整数据在 JSON 报告中。</div>
            )}
          </div>
        )}
      </Section>

      <Section title={`逐周期信号（${checkpoints.length}）`}>
        {checkpoints.length === 0 ? (
          <div className="empty-inline">没有逐周期信号检查点。</div>
        ) : (
          <div className="table-wrap compact">
            <table className="data-table">
              <thead>
                <tr>
                  <th>周期</th>
                  <th>信号</th>
                  <th>期望</th>
                  <th>实际</th>
                  <th>结果</th>
                </tr>
              </thead>
              <tbody>
                {checkpoints.slice(0, 100).map((checkpoint) => (
                  <tr key={`${checkpoint.cycle}-${checkpoint.signal}`}>
                    <td>{checkpoint.cycle}</td>
                    <td className="mono">{checkpoint.signal}</td>
                    <td className="mono">{checkpoint.expected}</td>
                    <td className={`mono ${checkpoint.match ? '' : 'fail-text'}`}>{checkpoint.actual}</td>
                    <td>
                      <span className={`badge ${checkpoint.match ? 'ok' : 'fail'}`}>
                        {checkpoint.match ? '一致' : '不一致'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {checkpoints.length > 100 && <div className="empty-inline">仅显示前 100 条；完整数据在 JSON 报告中。</div>}
          </div>
        )}
      </Section>

      {(result.pc?.checkpoints?.length ?? 0) > 0 && (
        <Section title={`PC 检查点（${result.pc!.checkpoints!.length}）`}>
          <div className="table-wrap compact">
            <table className="data-table">
              <thead>
                <tr>
                  <th>周期</th>
                  <th>期望 PC</th>
                  <th>实际 PC</th>
                  <th>结果</th>
                </tr>
              </thead>
              <tbody>
                {result.pc!.checkpoints!.slice(0, 80).map((checkpoint) => (
                  <tr key={checkpoint.cycle}>
                    <td>{checkpoint.cycle}</td>
                    <td className="mono">{checkpoint.expected}</td>
                    <td className={`mono ${checkpoint.match ? '' : 'fail-text'}`}>{checkpoint.actual}</td>
                    <td>
                      <span className={`badge ${checkpoint.match ? 'ok' : 'fail'}`}>
                        {checkpoint.match ? '一致' : '不一致'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      <Section title="MIPS 汇编">
        <pre className="code-block">{result.assembly}</pre>
      </Section>

      <Section title={`机器码（${result.machineCode.length} 字）`}>
        <div className="code-grid">
          {result.machineCode.map((word, index) => (
            <div key={`${word}-${index}`} className="code-word">
              <span>0x{(result.origin + index * 4).toString(16).padStart(8, '0')}</span>
              <strong>{word}</strong>
            </div>
          ))}
        </div>
      </Section>

      {result.bridgeErrors.length > 0 && (
        <Section title="Bridge 错误">
          <ul className="log-list">
            {result.bridgeErrors.map((error, index) => (
              <li key={index}>{error}</li>
            ))}
          </ul>
        </Section>
      )}

      {result.bridgeStderr && (
        <Section title="Bridge stderr">
          <pre className="code-block log-block">{result.bridgeStderr}</pre>
        </Section>
      )}
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

function Section({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <section className="detail-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
