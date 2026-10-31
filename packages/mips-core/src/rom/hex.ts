/**
 * Logisim 2.7.1 raw ROM image format.
 *
 * The file starts with the exact header `v2.0 raw`; following tokens are
 * hexadecimal words starting at the ROM's first offset (index 0). `#` starts a
 * comment and `n*value` is a run-length token. Logisim's HexFile reads the
 * words sequentially and zero-fills the remainder of the ROM. For the course
 * CPU, ROM index 0 corresponds to PC 0x3000.
 */
export interface HexEncodeOptions {
  /** ROM word index of the first supplied word. */
  startIndex?: number;
}

export function encodeLogisimHex(words: readonly (number | string)[], options: HexEncodeOptions = {}): string {
  const startIndex = options.startIndex ?? 0;
  if (!Number.isInteger(startIndex) || startIndex < 0) throw new Error('startIndex must be a non-negative integer');
  const all: string[] = new Array(startIndex).fill('00000000');
  for (const word of words) {
    const value = typeof word === 'number' ? word : parseHexWord(word);
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error(`invalid 32-bit word: ${word}`);
    all.push((value >>> 0).toString(16).padStart(8, '0'));
  }
  const lines: string[] = ['v2.0 raw'];
  for (let index = 0; index < all.length; index += 8) {
    lines.push(all.slice(index, index + 8).join(' '));
  }
  return `${lines.join('\n')}\n`;
}

export function parseLogisimHex(text: string): number[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let headerSeen = false;
  const data: number[] = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line.length === 0) continue;
    if (!headerSeen) {
      if (line !== 'v2.0 raw') throw new Error(`invalid Logisim hex header: ${line}`);
      headerSeen = true;
      continue;
    }
    for (const token of line.split(/\s+/)) {
      const star = token.indexOf('*');
      if (star >= 0) {
        const countText = token.slice(0, star);
        const valueText = token.slice(star + 1);
        if (!/^\d+$/.test(countText)) throw new Error(`invalid run-length token: ${token}`);
        const count = Number(countText);
        const value = parseHexWord(valueText);
        if (count > 1_000_000) throw new Error(`run-length too large: ${token}`);
        for (let i = 0; i < count; i++) data.push(value);
      } else {
        data.push(parseHexWord(token));
      }
    }
  }
  if (!headerSeen) throw new Error('missing Logisim hex header');
  return data;
}

function parseHexWord(text: string): number {
  const normalized = /^0x/i.test(text) ? text.slice(2) : text;
  if (!/^[0-9a-fA-F]{1,8}$/.test(normalized)) throw new Error(`invalid hexadecimal word: ${text}`);
  return Number.parseInt(normalized, 16) >>> 0;
}
