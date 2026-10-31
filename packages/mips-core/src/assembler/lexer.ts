import {AssemblyError} from '../errors.js';

export type TokenType =
  | 'identifier'
  | 'register'
  | 'number'
  | 'comma'
  | 'colon'
  | 'lparen'
  | 'rparen'
  | 'newline'
  | 'eof';

export interface Token {
  type: TokenType;
  text: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
  /** 0-based character offset in the source. */
  offset: number;
  lineText: string;
}

const IDENT_START = /[A-Za-z_.]/;
const IDENT_PART = /[A-Za-z0-9_.]/;
const DIGIT = /[0-9]/;
const HEX_DIGIT = /[0-9a-fA-F]/;

/** Tokenize assembly while preserving exact source positions and line text. */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const lines = source.split(/\r?\n/);
  let index = 0;
  let line = 1;
  let column = 1;

  const lineText = () => lines[line - 1] ?? '';
  const push = (type: TokenType, text: string, startOffset: number, startLine: number, startColumn: number) => {
    tokens.push({type, text, line: startLine, column: startColumn, offset: startOffset, lineText: lineText()});
  };
  const fail = (message: string, startLine: number, startColumn: number, length = 1): never => {
    throw new AssemblyError(
      'ASM_LEX',
      message,
      {line: startLine, column: startColumn, length},
      lines[startLine - 1] ?? '',
    );
  };

  while (index < source.length) {
    const ch = source[index];
    if (ch === '\r') {
      index++;
      continue;
    }
    if (ch === '\n') {
      push('newline', '\n', index, line, column);
      index++;
      line++;
      column = 1;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      index++;
      column++;
      continue;
    }
    if (ch === '#' || ch === ';') {
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') {
        index++;
        column++;
      }
      continue;
    }
    if (ch === ',') {
      push('comma', ch, index, line, column);
      index++;
      column++;
      continue;
    }
    if (ch === ':') {
      push('colon', ch, index, line, column);
      index++;
      column++;
      continue;
    }
    if (ch === '(') {
      push('lparen', ch, index, line, column);
      index++;
      column++;
      continue;
    }
    if (ch === ')') {
      push('rparen', ch, index, line, column);
      index++;
      column++;
      continue;
    }
    if (ch === '$') {
      const start = index;
      const startColumn = column;
      index++;
      column++;
      let body = '';
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index])) {
        body += source[index];
        index++;
        column++;
      }
      if (body.length === 0) fail('Expected a register name after $', line, startColumn, 1);
      push('register', `$${body}`, start, line, startColumn);
      continue;
    }
    if (ch === '-' || ch === '+' || DIGIT.test(ch)) {
      const start = index;
      const startColumn = column;
      let text = ch;
      index++;
      column++;
      if (ch === '-' || ch === '+') {
        if (index >= source.length || !(DIGIT.test(source[index]) || source[index] === '0')) {
          fail('Expected a number after the sign', line, startColumn, 1);
        }
        text += source[index];
        index++;
        column++;
      }
      if (text.endsWith('0') && (source[index] === 'x' || source[index] === 'X')) {
        text += source[index];
        index++;
        column++;
        let digits = '';
        while (index < source.length && HEX_DIGIT.test(source[index])) {
          digits += source[index];
          index++;
          column++;
        }
        if (digits.length === 0) fail('Hexadecimal literal has no digits', line, startColumn, text.length);
        text += digits;
      } else {
        while (index < source.length && DIGIT.test(source[index])) {
          text += source[index];
          index++;
          column++;
        }
      }
      if (index < source.length && IDENT_PART.test(source[index])) {
        fail(`Invalid numeric literal near "${text}${source[index]}"`, line, startColumn, text.length);
      }
      push('number', text, start, line, startColumn);
      continue;
    }
    if (IDENT_START.test(ch)) {
      const start = index;
      const startColumn = column;
      let text = '';
      while (index < source.length && IDENT_PART.test(source[index])) {
        text += source[index];
        index++;
        column++;
      }
      push('identifier', text, start, line, startColumn);
      continue;
    }
    fail(`Unexpected character "${ch}"`, line, column, 1);
  }
  push('eof', '', index, line, column);
  return tokens;
}
