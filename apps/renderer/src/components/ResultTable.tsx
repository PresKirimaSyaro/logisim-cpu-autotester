import type {TestResult} from '../../../../packages/differential-runner/src/types.js';
import {ERROR_LABEL, STATUS_LABEL, statusClass} from '../format.js';

interface Props {
  results: TestResult[];
  selectedId?: string;
  onSelect: (result: TestResult) => void;
  emptyText?: string;
}

export function ResultTable({results, selectedId, onSelect, emptyText = '暂无测试结果'}: Props) {
  if (results.length === 0) return <div className="empty-inline">{emptyText}</div>;
  return (
    <div className="table-wrap">
      <table className="data-table result-table">
        <thead>
          <tr>
            <th>状态</th>
            <th>用例</th>
            <th>类别</th>
            <th>周期</th>
            <th>结论 / 首个差异</th>
          </tr>
        </thead>
        <tbody>
          {results.map((result, index) => {
            const detail =
              result.firstSignalMismatch
                ? `${result.firstSignalMismatch.signal} @ cycle ${result.firstSignalMismatch.cycle}: ${result.firstSignalMismatch.expected} → ${result.firstSignalMismatch.actual}`
                : result.pc?.firstDivergence
                  ? `PC @ cycle ${result.pc.firstDivergence.cycle}: ${result.pc.firstDivergence.expected} → ${result.pc.firstDivergence.actual}`
                  : result.message ?? '';
            return (
              <tr
                key={`${result.id}-${index}`}
                className={selectedId === result.id ? 'selected' : ''}
                onClick={() => onSelect(result)}
              >
                <td>
                  <span className={`badge ${statusClass(result.status)}`}>{STATUS_LABEL[result.status]}</span>
                </td>
                <td>
                  <div className="cell-title">{result.name}</div>
                  <div className="cell-sub">{result.id}</div>
                </td>
                <td>{result.category}</td>
                <td>
                  {result.cyclesCompleted}/{result.cyclesRequested}
                </td>
                <td>
                  <div className="cell-title">
                    {result.errorType ? ERROR_LABEL[result.errorType] ?? result.errorType : '—'}
                  </div>
                  <div className="cell-sub">{detail}</div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
