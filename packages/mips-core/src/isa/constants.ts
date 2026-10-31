import {AssemblyError, MipsError, type MipsErrorCode} from '../errors.js';

/** All arithmetic is expressed in unsigned 32-bit words. */
export function u32(value: number): number {
  return value >>> 0;
}

/** Signed reinterpretation of a 32-bit word. */
export function s32(value: number): number {
  return value | 0;
}

export function signExtend16(value: number): number {
  return ((value & 0xffff) << 16) >> 16;
}

export function toHex32(value: number): string {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

export function toHex(value: number, width: number): string {
  const digits = Math.max(1, Math.ceil(width / 4));
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(digits, '0')}`;
}

export const OPCODE = {
  R: 0x00,
  ORI: 0x0d,
  LW: 0x23,
  SW: 0x2b,
  BEQ: 0x04,
} as const;

export const FUNCT = {
  SLL: 0x00,
  ADD: 0x20,
  SUB: 0x22,
} as const;

export const MNEMONICS = ['add', 'sub', 'ori', 'lw', 'sw', 'beq', 'sll'] as const;
export type Mnemonic = (typeof MNEMONICS)[number];

const REGISTER_NAMES: Readonly<Record<string, number>> = {
  zero: 0,
  at: 1,
  v0: 2,
  v1: 3,
  a0: 4,
  a1: 5,
  a2: 6,
  a3: 7,
  t0: 8,
  t1: 9,
  t2: 10,
  t3: 11,
  t4: 12,
  t5: 13,
  t6: 14,
  t7: 15,
  s0: 16,
  s1: 17,
  s2: 18,
  s3: 19,
  s4: 20,
  s5: 21,
  s6: 22,
  s7: 23,
  t8: 24,
  t9: 25,
  k0: 26,
  k1: 27,
  gp: 28,
  sp: 29,
  fp: 30,
  s8: 30,
  ra: 31,
};

export const REGISTER_ALIASES: Readonly<Record<number, string>> = {
  0: '$zero',
  1: '$at',
  2: '$v0',
  3: '$v1',
  4: '$a0',
  5: '$a1',
  6: '$a2',
  7: '$a3',
  8: '$t0',
  9: '$t1',
  10: '$t2',
  11: '$t3',
  12: '$t4',
  13: '$t5',
  14: '$t6',
  15: '$t7',
  16: '$s0',
  17: '$s1',
  18: '$s2',
  19: '$s3',
  20: '$s4',
  21: '$s5',
  22: '$s6',
  23: '$s7',
  24: '$t8',
  25: '$t9',
  26: '$k0',
  27: '$k1',
  28: '$gp',
  29: '$sp',
  30: '$fp',
  31: '$ra',
};

/**
 * Parse a register spelling. Accepts `$zero`, `$t0`-style names and `$0`-`$31`.
 * The $ prefix is mandatory, matching the course syntax.
 */
export function parseRegister(text: string): number | null {
  if (!text.startsWith('$')) return null;
  const body = text.slice(1).toLowerCase();
  if (/^\d+$/.test(body)) {
    const index = Number(body);
    return index >= 0 && index <= 31 ? index : null;
  }
  const named = REGISTER_NAMES[body];
  return named === undefined ? null : named;
}

export function registerName(index: number): string {
  return REGISTER_ALIASES[index] ?? `$${index}`;
}

export function mnemonic(text: string): Mnemonic | null {
  const lower = text.toLowerCase();
  return (MNEMONICS as readonly string[]).includes(lower) ? (lower as Mnemonic) : null;
}

/** Parse `0x...`, decimal and signed forms without JavaScript coercion surprises. */
export function parseIntegerLiteral(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const negative = trimmed.startsWith('-');
  const positive = trimmed.startsWith('+');
  const body = negative || positive ? trimmed.slice(1) : trimmed;
  let value: number;
  if (/^0x[0-9a-fA-F]+$/.test(body)) {
    value = Number.parseInt(body.slice(2), 16);
  } else if (/^\d+$/.test(body)) {
    value = Number.parseInt(body, 10);
  } else {
    return null;
  }
  if (!Number.isSafeInteger(value)) return null;
  return negative ? -value : value;
}

export function asmError(
  code: MipsErrorCode,
  message: string,
  token: {line: number; column: number; text: string},
  lineText?: string,
): AssemblyError {
  return new AssemblyError(
    code,
    message,
    {line: token.line, column: token.column, length: token.text.length},
    lineText,
  );
}

export function encodeR(fields: {
  rs: number;
  rt: number;
  rd: number;
  shamt: number;
  funct: number;
}): number {
  checkField('rs', fields.rs, 0, 31);
  checkField('rt', fields.rt, 0, 31);
  checkField('rd', fields.rd, 0, 31);
  checkField('shamt', fields.shamt, 0, 31);
  checkField('funct', fields.funct, 0, 63);
  return u32(
    (OPCODE.R << 26) |
      (fields.rs << 21) |
      (fields.rt << 16) |
      (fields.rd << 11) |
      (fields.shamt << 6) |
      fields.funct,
  );
}

export function encodeI(fields: {
  opcode: number;
  rs: number;
  rt: number;
  /** Signed or unsigned 16-bit immediate; only the low 16 bits are encoded. */
  immediate: number;
}): number {
  checkField('opcode', fields.opcode, 0, 63);
  checkField('rs', fields.rs, 0, 31);
  checkField('rt', fields.rt, 0, 31);
  if (!Number.isInteger(fields.immediate) || fields.immediate < -32768 || fields.immediate > 65535) {
    throw new MipsError('ENCODE_RANGE', `immediate ${fields.immediate} outside 16-bit encodable range`);
  }
  return u32(
    (fields.opcode << 26) | (fields.rs << 21) | (fields.rt << 16) | (fields.immediate & 0xffff),
  );
}

function checkField(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new MipsError('ENCODE_RANGE', `${name} ${value} outside [${min}, ${max}]`);
  }
}

export interface InstructionFields {
  opcode: number;
  rs: number;
  rt: number;
  rd: number;
  shamt: number;
  funct: number;
  immediate: number;
}

export function fieldsOf(word: number): InstructionFields {
  const value = u32(word);
  return {
    opcode: value >>> 26,
    rs: (value >>> 21) & 0x1f,
    rt: (value >>> 16) & 0x1f,
    rd: (value >>> 11) & 0x1f,
    shamt: (value >>> 6) & 0x1f,
    funct: value & 0x3f,
    immediate: value & 0xffff,
  };
}
