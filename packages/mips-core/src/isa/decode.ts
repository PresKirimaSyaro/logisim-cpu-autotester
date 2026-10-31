import {FUNCT, OPCODE, fieldsOf, signExtend16, u32} from './constants.js';

export type Instruction =
  | {kind: 'add'; rs: number; rt: number; rd: number; word: number}
  | {kind: 'sub'; rs: number; rt: number; rd: number; word: number}
  | {kind: 'ori'; rs: number; rt: number; immediate: number; word: number}
  | {kind: 'lw'; rs: number; rt: number; offset: number; word: number}
  | {kind: 'sw'; rs: number; rt: number; offset: number; word: number}
  | {kind: 'beq'; rs: number; rt: number; offset: number; word: number}
  | {kind: 'sll'; rt: number; rd: number; shamt: number; word: number};

export interface DecodeFailure {
  ok: false;
  code: 'UNSUPPORTED_INSTRUCTION';
  word: number;
  opcode: number;
  funct: number;
  message: string;
}

export type DecodeResult = {ok: true; instruction: Instruction} | DecodeFailure;

/**
 * Decode exactly the seven-instruction course subset. Every other encoding is
 * rejected; decoding never guesses or silently turns an unknown word into NOP.
 */
export function decode(word: number): DecodeResult {
  const value = u32(word);
  const f = fieldsOf(value);
  if (f.opcode === OPCODE.R) {
    if (f.funct === FUNCT.ADD) {
      return {ok: true, instruction: {kind: 'add', rs: f.rs, rt: f.rt, rd: f.rd, word: value}};
    }
    if (f.funct === FUNCT.SUB) {
      return {ok: true, instruction: {kind: 'sub', rs: f.rs, rt: f.rt, rd: f.rd, word: value}};
    }
    if (f.funct === FUNCT.SLL) {
      // Real MIPS requires rs=0 for sll; the datapath ignores rs. We accept the
      // encoding and document that rs is ignored, rather than rejecting words
      // that a hardware CPU would execute.
      return {
        ok: true,
        instruction: {kind: 'sll', rt: f.rt, rd: f.rd, shamt: f.shamt, word: value},
      };
    }
    return unsupported(value, f.opcode, f.funct, `unsupported R-type funct 0x${f.funct.toString(16)}`);
  }
  if (f.opcode === OPCODE.ORI) {
    return {
      ok: true,
      instruction: {kind: 'ori', rs: f.rs, rt: f.rt, immediate: f.immediate, word: value},
    };
  }
  if (f.opcode === OPCODE.LW) {
    return {
      ok: true,
      instruction: {kind: 'lw', rs: f.rs, rt: f.rt, offset: signExtend16(f.immediate), word: value},
    };
  }
  if (f.opcode === OPCODE.SW) {
    return {
      ok: true,
      instruction: {kind: 'sw', rs: f.rs, rt: f.rt, offset: signExtend16(f.immediate), word: value},
    };
  }
  if (f.opcode === OPCODE.BEQ) {
    return {
      ok: true,
      instruction: {kind: 'beq', rs: f.rs, rt: f.rt, offset: signExtend16(f.immediate), word: value},
    };
  }
  return unsupported(value, f.opcode, f.funct, `unsupported opcode 0x${f.opcode.toString(16)}`);
}

function unsupported(word: number, opcode: number, funct: number, message: string): DecodeFailure {
  return {ok: false, code: 'UNSUPPORTED_INSTRUCTION', word, opcode, funct, message};
}

export function isSupportedWord(word: number): boolean {
  return decode(word).ok;
}

/** Human-readable form useful in traces and reports. */
export function formatInstruction(instruction: Instruction): string {
  switch (instruction.kind) {
    case 'add':
    case 'sub':
      return `${instruction.kind} $${instruction.rd}, $${instruction.rs}, $${instruction.rt}`;
    case 'ori':
      return `ori $${instruction.rt}, $${instruction.rs}, 0x${instruction.immediate.toString(16)}`;
    case 'lw':
    case 'sw':
      return `${instruction.kind} $${instruction.rt}, ${instruction.offset}($${instruction.rs})`;
    case 'beq':
      return `beq $${instruction.rs}, $${instruction.rt}, ${instruction.offset}`;
    case 'sll':
      return `sll $${instruction.rd}, $${instruction.rt}, ${instruction.shamt}`;
  }
}
