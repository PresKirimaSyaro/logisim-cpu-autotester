/** Stable error codes used by the assembler, interpreter, config and CLI. */
export type MipsErrorCode =
  | 'ASM_LEX'
  | 'ASM_SYNTAX'
  | 'ASM_DUPLICATE_LABEL'
  | 'ASM_UNDEFINED_LABEL'
  | 'ASM_INVALID_REGISTER'
  | 'ASM_INVALID_IMMEDIATE'
  | 'ASM_INVALID_OPERAND'
  | 'ASM_IMMEDIATE_RANGE'
  | 'ASM_BRANCH_RANGE'
  | 'ASM_BRANCH_ALIGNMENT'
  | 'ASM_UNKNOWN_MNEMONIC'
  | 'ENCODE_RANGE'
  | 'CONFIG_INVALID'
  | 'CONFIG_UNKNOWN_KEY'
  | 'CONFIG_TYPE'
  | 'CONFIG_RANGE'
  | 'CONFIG_MISMATCH'
  | 'ADDRESS_OUT_OF_RANGE'
  | 'ADDRESS_MISALIGNED'
  | 'UNSUPPORTED_INSTRUCTION'
  | 'PC_OUT_OF_RANGE'
  | 'PC_MISALIGNED'
  | 'EXECUTION_STEP_LIMIT'
  | 'EXECUTION_STOP_PC'
  | 'REFERENCE_ERROR';

export interface SourcePosition {
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
  /** 1-based length in characters; useful for editor highlights. */
  length?: number;
}

export interface Diagnostic extends SourcePosition {
  code: MipsErrorCode;
  message: string;
  lineText?: string;
}

export class MipsError extends Error {
  constructor(
    public readonly code: MipsErrorCode,
    message: string,
    public readonly position?: SourcePosition,
    public readonly lineText?: string,
  ) {
    super(message);
    this.name = 'MipsError';
  }

  toDiagnostic(): Diagnostic {
    return {
      code: this.code,
      message: this.message,
      line: this.position?.line ?? 1,
      column: this.position?.column ?? 1,
      length: this.position?.length,
      lineText: this.lineText,
    };
  }
}

export class AssemblyError extends MipsError {
  constructor(
    code: MipsErrorCode,
    message: string,
    position: SourcePosition,
    lineText?: string,
  ) {
    super(code, message, position, lineText);
    this.name = 'AssemblyError';
  }
}

export class ConfigError extends MipsError {
  constructor(
    code: MipsErrorCode,
    message: string,
    public readonly path = '$',
  ) {
    super(code, message);
    this.name = 'ConfigError';
  }
}

export class DecodeError extends MipsError {
  constructor(
    code: MipsErrorCode,
    message: string,
    public readonly word?: number,
  ) {
    super(code, message);
    this.name = 'DecodeError';
  }
}

export class ExecutionError extends MipsError {
  constructor(
    code: MipsErrorCode,
    message: string,
    public readonly pc?: number,
    public readonly address?: number,
  ) {
    super(code, message);
    this.name = 'ExecutionError';
  }
}

export interface ExecutionErrorInfo {
  code: MipsErrorCode;
  message: string;
  pc: number;
  address?: number;
}
