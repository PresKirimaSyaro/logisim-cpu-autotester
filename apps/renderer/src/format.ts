import type {TestResult} from '../../../packages/differential-runner/src/types.js';

export const STATUS_LABEL: Record<string, string> = {
  pass: '通过',
  fail: '失败',
  error: '错误',
  skipped: '跳过',
  cancelled: '已停止',
};

export const ERROR_LABEL: Record<string, string> = {
  assembly: '汇编错误',
  config: '配置错误',
  'circuit-load': '电路加载失败',
  init: '初始化失败',
  simulation: '仿真失败',
  'signal-mismatch': '信号不一致',
  timeout: '超时',
  'ram-mismatch': '历史 RAM 差异',
  reference: '参考模型异常',
  observability: '不可观察',
  bridge: 'Bridge 错误',
  cancelled: '已停止',
  internal: '内部错误',
};

export function hex(value: number, width = 32): string {
  const digits = Math.max(1, Math.ceil(width / 4));
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(digits, '0')}`;
}

export function parseHex(text: string): number {
  return Number.parseInt(text.replace(/^0x/i, ''), 16) >>> 0;
}

export function statusClass(status: string): string {
  return status === 'pass' ? 'ok' : status === 'fail' ? 'fail' : status === 'error' ? 'error' : 'muted';
}

export function resultCounts(results: TestResult[]) {
  return {
    pass: results.filter((result) => result.status === 'pass').length,
    fail: results.filter((result) => result.status === 'fail').length,
    error: results.filter((result) => result.status === 'error').length,
  };
}

export function shortPath(path: string | undefined, max = 54): string {
  if (!path) return '未选择';
  return path.length <= max ? path : `…${path.slice(-(max - 1))}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
