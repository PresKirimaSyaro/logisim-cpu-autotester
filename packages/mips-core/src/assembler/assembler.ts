import {AssemblyError, MipsError, type Diagnostic} from '../errors.js';
import {tokenize, type Token} from './lexer.js';
import {
  OPCODE,
  FUNCT,
  encodeI,
  encodeR,
  mnemonic,
  parseIntegerLiteral,
  parseRegister,
  registerName,
  toHex32,
  type Mnemonic,
} from '../isa/constants.js';

export interface AssemblerOptions {
  /** Byte address assigned to the first word. Defaults to 0. */
  origin?: number;
  fileName?: string;
}

export interface AssembledInstruction {
  /** MIPS byte address of this instruction. */
  address: number;
  word: number;
  hex: string;
  line: number;
  column: number;
  mnemonic: Mnemonic;
  text: string;
}

export interface AssembledProgram {
  origin: number;
  words: number[];
  hex: string[];
  symbols: Record<string, number>;
  symbolList: {name: string; address: number}[];
  instructions: AssembledInstruction[];
  source: string;
  fileName?: string;
}

interface LabelToken {
  name: string;
  token: Token;
}

interface PendingStatement {
  labels: LabelToken[];
}

interface PendingInstruction extends PendingStatement {
  mnemonicToken: Token;
  operands: Token[][];
}

type ParsedStatement = PendingStatement | PendingInstruction;

/**
 * Two-pass assembler for exactly add/sub/ori/lw/sw/beq/sll.
 *
 * Pass 1 assigns a byte address to every label. Pass 2 parses operands and
 * encodes words. No pseudo-instructions are accepted; `nop` is intentionally
 * not recognized even though 0x00000000 decodes as `sll $zero,$zero,0`.
 */
export function assemble(source: string, options: AssemblerOptions = {}): AssembledProgram {
  const origin = options.origin ?? 0;
  if (!Number.isInteger(origin) || origin < 0 || origin > 0xffffffff || origin % 4 !== 0) {
    throw new MipsError(
      'ASM_SYNTAX',
      `origin ${origin} must be a 4-byte aligned 32-bit address`,
      {line: 1, column: 1},
    );
  }
  const tokens = tokenize(source);
  const statements = parseStatements(tokens);
  const symbols = new Map<string, number>();
  const symbolTokens = new Map<string, Token>();

  // Pass 1: labels and addresses.
  let address = origin;
  for (const statement of statements) {
    for (const label of statement.labels) {
      if (symbols.has(label.name)) {
        throw new AssemblyError(
          'ASM_DUPLICATE_LABEL',
          `Duplicate label "${label.name}" (first defined at line ${symbolTokens.get(label.name)!.line})`,
          tokenPosition(label.token),
          label.token.lineText,
        );
      }
      symbols.set(label.name, address);
      symbolTokens.set(label.name, label.token);
    }
    if ('mnemonicToken' in statement) {
      const m = mnemonic(statement.mnemonicToken.text);
      if (m === null) {
        throw new AssemblyError(
          'ASM_UNKNOWN_MNEMONIC',
          `Unknown instruction "${statement.mnemonicToken.text}". Supported: add, sub, ori, lw, sw, beq, sll`,
          tokenPosition(statement.mnemonicToken),
          statement.mnemonicToken.lineText,
        );
      }
      address += 4;
      if (address > 0x100000000) {
        throw new AssemblyError(
          'ASM_SYNTAX',
          'Program exceeds the 32-bit address space',
          tokenPosition(statement.mnemonicToken),
          statement.mnemonicToken.lineText,
        );
      }
    }
  }

  // Pass 2: operands and encoding.
  const words: number[] = [];
  const instructions: AssembledInstruction[] = [];
  let pc = origin;
  for (const statement of statements) {
    if (!('mnemonicToken' in statement)) continue;
    const m = mnemonic(statement.mnemonicToken.text)!;
    const word = encodeStatement(m, statement, pc, symbols);
    words.push(word);
    instructions.push({
      address: pc,
      word,
      hex: toHex32(word),
      line: statement.mnemonicToken.line,
      column: statement.mnemonicToken.column,
      mnemonic: m,
      text: statement.mnemonicToken.lineText.trim(),
    });
    pc += 4;
  }

  const symbolList = [...symbols.entries()]
    .map(([name, value]) => ({name, address: value}))
    .sort((a, b) => a.address - b.address || a.name.localeCompare(b.name));
  const symbolObject: Record<string, number> = {};
  for (const symbol of symbolList) symbolObject[symbol.name] = symbol.address;

  return {
    origin,
    words,
    hex: words.map(toHex32),
    symbols: symbolObject,
    symbolList,
    instructions,
    source,
    fileName: options.fileName,
  };
}

function parseStatements(tokens: Token[]): ParsedStatement[] {
  const statements: ParsedStatement[] = [];
  let index = 0;
  const error = (token: Token, message: string): never => {
    throw new AssemblyError('ASM_SYNTAX', message, tokenPosition(token), token.lineText);
  };
  while (tokens[index].type !== 'eof') {
    while (tokens[index].type === 'newline') index++;
    if (tokens[index].type === 'eof') break;
    const labels: LabelToken[] = [];
    while (tokens[index].type === 'identifier' && tokens[index + 1]?.type === 'colon') {
      labels.push({name: tokens[index].text, token: tokens[index]});
      index += 2;
    }
    if (tokens[index].type === 'newline' || tokens[index].type === 'eof') {
      if (labels.length === 0) error(tokens[index], 'Expected a label or instruction');
      statements.push({labels});
      continue;
    }
    if (tokens[index].type !== 'identifier') {
      error(tokens[index], `Expected an instruction mnemonic, found "${tokens[index].text || tokens[index].type}"`);
    }
    const mnemonicToken = tokens[index];
    index++;
    const operands: Token[][] = [];
    let current: Token[] = [];
    while (tokens[index].type !== 'newline' && tokens[index].type !== 'eof') {
      if (tokens[index].type === 'comma') {
        if (current.length === 0) error(tokens[index], 'Empty operand before comma');
        operands.push(current);
        current = [];
        index++;
        continue;
      }
      if (tokens[index].type === 'colon') error(tokens[index], 'Unexpected ":"');
      current.push(tokens[index]);
      index++;
    }
    if (current.length > 0) operands.push(current);
    else if (operands.length > 0) error(tokens[index], 'Trailing comma in operand list');
    statements.push({labels, mnemonicToken, operands});
    if (tokens[index].type === 'newline') index++;
  }
  return statements;
}

function encodeStatement(
  m: Mnemonic,
  statement: PendingInstruction,
  pc: number,
  symbols: Map<string, number>,
): number {
  const operands = statement.operands;
  const lineText = statement.mnemonicToken.lineText;
  const fail = (code: ConstructorParameters<typeof AssemblyError>[0], message: string, token: Token): never => {
    throw new AssemblyError(code, message, tokenPosition(token), lineText);
  };
  const count = (expected: number) => {
    if (operands.length !== expected) {
      fail(
        'ASM_INVALID_OPERAND',
        `${m} expects ${expected} operand${expected === 1 ? '' : 's'}, received ${operands.length}`,
        statement.mnemonicToken,
      );
    }
  };
  const register = (group: Token[] | undefined, what: string): number => {
    if (!group || group.length !== 1 || group[0].type !== 'register') {
      fail('ASM_INVALID_OPERAND', `${m} ${what} must be a register such as $t0`, group?.[0] ?? statement.mnemonicToken);
    }
    const value = parseRegister(group![0].text);
    if (value === null) fail('ASM_INVALID_REGISTER', `Invalid register "${group![0].text}"`, group![0]);
    return value!;
  };
  const integer = (group: Token[] | undefined, what: string, min: number, max: number): number => {
    if (!group || group.length !== 1 || group[0].type !== 'number') {
      fail('ASM_INVALID_OPERAND', `${m} ${what} must be an integer literal`, group?.[0] ?? statement.mnemonicToken);
    }
    const value = parseIntegerLiteral(group![0].text);
    if (value === null) fail('ASM_INVALID_IMMEDIATE', `Invalid ${what} "${group![0].text}"`, group![0]);
    if (value! < min || value! > max) {
      fail('ASM_IMMEDIATE_RANGE', `${what} ${value} outside [${min}, ${max}]`, group![0]);
    }
    return value!;
  };
  const memory = (group: Token[] | undefined): {rt: number; offset: number; base: number} => {
    if (
      !group ||
      group.length !== 4 ||
      group[0].type !== 'number' ||
      group[1].type !== 'lparen' ||
      group[2].type !== 'register' ||
      group[3].type !== 'rparen'
    ) {
      fail('ASM_INVALID_OPERAND', `${m} expects offset(base), for example 0($zero)`, group?.[0] ?? statement.mnemonicToken);
    }
    const offset = parseIntegerLiteral(group![0].text);
    if (offset === null) fail('ASM_INVALID_IMMEDIATE', `Invalid offset "${group![0].text}"`, group![0]);
    if (offset! < -32768 || offset! > 32767) {
      fail('ASM_IMMEDIATE_RANGE', `Memory offset ${offset} outside [-32768, 32767]`, group![0]);
    }
    const base = parseRegister(group![2].text);
    if (base === null) fail('ASM_INVALID_REGISTER', `Invalid register "${group![2].text}"`, group![2]);
    return {rt: -1, offset: offset!, base: base!};
  };

  switch (m) {
    case 'add':
    case 'sub': {
      count(3);
      const rd = register(operands[0], 'rd');
      const rs = register(operands[1], 'rs');
      const rt = register(operands[2], 'rt');
      return encodeR({rs, rt, rd, shamt: 0, funct: m === 'add' ? FUNCT.ADD : FUNCT.SUB});
    }
    case 'ori': {
      count(3);
      const rt = register(operands[0], 'rt');
      const rs = register(operands[1], 'rs');
      const immediate = integer(operands[2], 'immediate', -32768, 65535);
      return encodeI({opcode: OPCODE.ORI, rs, rt, immediate});
    }
    case 'lw':
    case 'sw': {
      count(2);
      const rt = register(operands[0], 'rt');
      const mem = memory(operands[1]);
      return encodeI({opcode: m === 'lw' ? OPCODE.LW : OPCODE.SW, rs: mem.base, rt, immediate: mem.offset});
    }
    case 'sll': {
      count(3);
      const rd = register(operands[0], 'rd');
      const rt = register(operands[1], 'rt');
      const shamt = integer(operands[2], 'shamt', 0, 31);
      return encodeR({rs: 0, rt, rd, shamt, funct: FUNCT.SLL});
    }
    case 'beq': {
      count(3);
      const rs = register(operands[0], 'rs');
      const rt = register(operands[1], 'rt');
      const targetGroup = operands[2];
      if (!targetGroup || targetGroup.length !== 1) {
        fail('ASM_INVALID_OPERAND', 'beq target must be a label or a byte offset', targetGroup?.[0] ?? statement.mnemonicToken);
      }
      const token = targetGroup![0];
      let byteOffset: number;
      if (token.type === 'identifier') {
        const target = symbols.get(token.text);
        if (target === undefined) {
          fail('ASM_UNDEFINED_LABEL', `Undefined label "${token.text}"`, token);
        }
        if (target! % 4 !== 0) {
          fail('ASM_BRANCH_ALIGNMENT', `Branch target "${token.text}" is not 4-byte aligned`, token);
        }
        byteOffset = target! - (pc + 4);
        if (byteOffset % 4 !== 0) {
          fail('ASM_BRANCH_ALIGNMENT', `Branch target "${token.text}" is not word aligned`, token);
        }
      } else if (token.type === 'number') {
        byteOffset = parseIntegerLiteral(token.text) ?? Number.NaN;
        if (!Number.isFinite(byteOffset)) fail('ASM_INVALID_IMMEDIATE', `Invalid branch offset "${token.text}"`, token);
        if (byteOffset % 4 !== 0) {
          fail('ASM_BRANCH_ALIGNMENT', `Branch offset ${byteOffset} is not a multiple of 4`, token);
        }
      } else {
        fail('ASM_INVALID_OPERAND', 'beq target must be a label or a byte offset', token);
        byteOffset = 0;
      }
      const wordOffset = byteOffset! / 4;
      if (!Number.isInteger(wordOffset) || wordOffset < -32768 || wordOffset > 32767) {
        fail('ASM_BRANCH_RANGE', `Branch offset ${wordOffset} outside [-32768, 32767] words`, token);
      }
      return encodeI({opcode: OPCODE.BEQ, rs, rt, immediate: wordOffset});
    }
  }
  // Exhaustive check.
  const never: never = m;
  throw new MipsError('ASM_UNKNOWN_MNEMONIC', `Unhandled mnemonic ${String(never)}`);
}

function tokenPosition(token: Token): {line: number; column: number; length: number} {
  return {line: token.line, column: token.column, length: Math.max(1, token.text.length)};
}

export interface AssemblyFailure {
  ok: false;
  diagnostic: Diagnostic;
}

export type AssemblyAttempt =
  | {ok: true; program: AssembledProgram}
  | AssemblyFailure;

export function tryAssemble(source: string, options: AssemblerOptions = {}): AssemblyAttempt {
  try {
    return {ok: true, program: assemble(source, options)};
  } catch (error) {
    if (error instanceof MipsError) return {ok: false, diagnostic: error.toDiagnostic()};
    throw error;
  }
}

/** Convenience for tests and reports. */
export function formatRegister(index: number): string {
  return registerName(index);
}
