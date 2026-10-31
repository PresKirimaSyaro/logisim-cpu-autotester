import {MNEMONICS, type Mnemonic} from './constants.js';

export type InstructionName = Mnemonic;

/** The eight instructions required by the current course CPU. */
export const COURSE_INSTRUCTIONS = [
  'add',
  'sub',
  'ori',
  'lw',
  'sw',
  'beq',
  'lui',
  'nop',
] as const satisfies readonly InstructionName[];

/** Optional extensions that are never enabled unless the user asks for them. */
export const OPTIONAL_INSTRUCTIONS = ['sll', 'j'] as const satisfies readonly InstructionName[];

export const ALL_INSTRUCTIONS = [
  ...COURSE_INSTRUCTIONS,
  ...OPTIONAL_INSTRUCTIONS,
] as const satisfies readonly InstructionName[];

export const DEFAULT_INSTRUCTIONS: readonly InstructionName[] = COURSE_INSTRUCTIONS;

export function isInstructionName(value: string): value is InstructionName {
  return (MNEMONICS as readonly string[]).includes(value);
}

/** Remove duplicates while preserving the caller's order. */
export function normalizeInstructions(values: readonly string[]): InstructionName[] {
  const result: InstructionName[] = [];
  for (const value of values) {
    const name = value.trim().toLowerCase();
    if (!isInstructionName(name)) throw new Error(`unknown instruction "${value}"`);
    if (!result.includes(name)) result.push(name);
  }
  return result;
}

export function instructionSetLabel(values: readonly InstructionName[]): string {
  return values.length === 0 ? '(none)' : values.join(', ');
}

export function usesInstruction(instructions: readonly InstructionName[], kind: InstructionName): boolean {
  return instructions.includes(kind);
}
