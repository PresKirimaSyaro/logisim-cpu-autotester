export type SignalNumberFormat = 'hex' | 'udec' | 'sdec' | 'binary';
export type SignalValueStatus = 'known' | 'unsampled' | 'unknown' | 'error';

/**
 * Format a sampled signal for display without modifying the underlying value.
 * `value` is the canonical `0x...` string from the report. Missing values are
 * kept distinct from numeric zero.
 */
export function formatSignalValue(
  value: string | undefined | null,
  width: number,
  format: SignalNumberFormat,
  status?: SignalValueStatus,
): string {
  if (value === undefined || value === null) {
    if (status === 'unsampled') return '未采样';
    if (status === 'unknown') return '未知';
    if (status === 'error') return '错误';
    return '—';
  }
  const unsigned = Number.parseInt(value.replace(/^0x/i, ''), 16) >>> 0;
  const mask = width >= 32 ? 0xffffffff : (1 << width) - 1;
  const truncated = (unsigned & mask) >>> 0;
  const signed = width >= 32 ? truncated | 0 : (truncated & (1 << (width - 1)) ? truncated - (1 << width) : truncated);
  switch (format) {
    case 'udec':
      return String(truncated >>> 0);
    case 'sdec':
      return String(signed);
    case 'binary':
      return `0b${truncated.toString(2).padStart(width, '0')}`;
    default:
      return `0x${truncated.toString(16).padStart(Math.ceil(width / 4), '0')}`;
  }
}
