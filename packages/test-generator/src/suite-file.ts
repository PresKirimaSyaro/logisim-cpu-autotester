import {ConfigError} from '../../mips-core/src/errors.js';
import {assemble} from '../../mips-core/src/assembler/assembler.js';
import {ALL_INSTRUCTIONS, type InstructionName} from '../../mips-core/src/isa/instruction-set.js';
import type {DirectedTest, TestCategory, TestLayout} from './directed.js';
import {programInstructions} from './directed.js';

export interface ExternalSignature {
  /** Index within the test's signature area (not an absolute byte address). */
  index: number;
  expected: number;
}

export interface ExternalTestDefinition {
  id: string;
  name: string;
  category: string;
  description: string;
  assembly: string;
  steps: number;
  signature: ExternalSignature[];
  suites: string[];
  tags: string[];
  seed: number | null;
  /** Minimum logical RAM bytes this program addresses (course-specific tests may need more). */
  requiredRamBytes?: number;
}

export interface ExternalSuiteFile {
  schemaVersion: 1;
  name: string;
  description?: string;
  tests: ExternalTestDefinition[];
}

/**
 * Parse a suite file that lives outside the application. The loader validates
 * assembly syntax and can filter by the selected instruction set, but never
 * rewrites the program text.
 */
export function parseTestSuite(value: unknown): ExternalSuiteFile {
  const root = object(value, '$');
  if (root.schemaVersion !== 1) {
    throw new ConfigError('CONFIG_INVALID', 'suite schemaVersion must be 1', '$.schemaVersion');
  }
  const name = nonEmpty(root.name, 'name', '$');
  const description = root.description === undefined ? undefined : String(root.description);
  if (!Array.isArray(root.tests) || root.tests.length === 0) {
    throw new ConfigError('CONFIG_INVALID', 'tests must be a non-empty array', '$.tests');
  }
  const seen = new Set<string>();
  const tests = root.tests.map((value, index) => parseTest(value, `$.tests[${index}]`, seen));
  return {schemaVersion: 1, name, description, tests};
}

function parseTest(value: unknown, path: string, seen: Set<string>): ExternalTestDefinition {
  const test = object(value, path);
  const id = nonEmpty(test.id, 'id', path);
  if (seen.has(id)) throw new ConfigError('CONFIG_INVALID', `duplicate test id ${id}`, `${path}.id`);
  seen.add(id);
  const name = nonEmpty(test.name, 'name', path);
  const category = nonEmpty(test.category, 'category', path);
  const description = typeof test.description === 'string' ? test.description : '';
  const assembly = nonEmpty(test.assembly, 'assembly', path);
  const steps = test.steps;
  if (typeof steps !== 'number' || !Number.isInteger(steps) || steps < 1) {
    throw new ConfigError('CONFIG_INVALID', 'steps must be a positive integer', `${path}.steps`);
  }
  if (!Array.isArray(test.signature) || test.signature.length === 0) {
    throw new ConfigError('CONFIG_INVALID', 'signature must be a non-empty array', `${path}.signature`);
  }
  const signature = test.signature.map((entry, index) => {
    const item = object(entry, `${path}.signature[${index}]`);
    if (typeof item.index !== 'number' || !Number.isInteger(item.index) || item.index < 0) {
      throw new ConfigError('CONFIG_INVALID', 'signature index must be non-negative', `${path}.signature[${index}].index`);
    }
    if (typeof item.expected !== 'number' || !Number.isInteger(item.expected) || item.expected < 0 || item.expected > 0xffffffff) {
      throw new ConfigError('CONFIG_INVALID', 'signature expected must be a 32-bit unsigned integer', `${path}.signature[${index}].expected`);
    }
    return {index: item.index, expected: item.expected >>> 0};
  });
  const suites = stringArray(test.suites, `${path}.suites`);
  const tags = stringArray(test.tags, `${path}.tags`);
  const seed = test.seed === null || test.seed === undefined ? null : test.seed;
  if (seed !== null && (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0)) {
    throw new ConfigError('CONFIG_INVALID', 'seed must be a non-negative integer or null', `${path}.seed`);
  }
  const requiredRamBytes = test.requiredRamBytes;
  if (
    requiredRamBytes !== undefined &&
    (typeof requiredRamBytes !== 'number' || !Number.isInteger(requiredRamBytes) || requiredRamBytes < 1)
  ) {
    throw new ConfigError('CONFIG_INVALID', 'requiredRamBytes must be a positive integer', `${path}.requiredRamBytes`);
  }
  return {id, name, category, description, assembly, steps, signature, suites, tags, seed, requiredRamBytes};
}

/**
 * Convert an external suite into runnable tests. Only tests whose concrete
 * assembly uses enabled instructions are returned.
 */
export function testsFromSuite(
  suite: ExternalSuiteFile,
  layout: TestLayout,
  instructions: readonly InstructionName[] = ALL_INSTRUCTIONS,
): DirectedTest[] {
  const enabled = new Set(instructions);
  const result: DirectedTest[] = [];
  for (const definition of suite.tests) {
    const used = programInstructions(definition.assembly);
    if (!used.every((name) => enabled.has(name))) continue;
    if ((definition.requiredRamBytes ?? 0) > layout.ramBytes) continue;
    // Validate syntax/encodability using all instructions so a disabled
    // instruction is filtered rather than reported as a broken suite file.
    assemble(definition.assembly, {instructions: ALL_INSTRUCTIONS});
    const signature = definition.signature.map((entry) => {
      const byteAddress = layout.signatureBase + entry.index * 4;
      if (byteAddress >= layout.ramBase + layout.ramBytes) {
        throw new ConfigError(
          'CONFIG_INVALID',
          `test ${definition.id} signature index ${entry.index} is outside RAM`,
          '$.tests',
        );
      }
      return {byteAddress, expected: entry.expected >>> 0};
    });
    if (!signature.some((entry) => entry.expected !== 0)) {
      throw new ConfigError('CONFIG_INVALID', `test ${definition.id} has an all-zero signature`, '$.tests');
    }
    result.push({
      id: definition.id,
      name: definition.name,
      category: definition.category as TestCategory,
      description: definition.description,
      assembly: definition.assembly,
      steps: definition.steps,
      signature,
      suites: definition.suites,
      tags: definition.tags,
      seed: definition.seed,
    });
  }
  return result;
}

function nonEmpty(value: unknown, key: string, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ConfigError('CONFIG_INVALID', `${key} must be a non-empty string`, `${path}.${key}`);
  }
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ConfigError('CONFIG_INVALID', 'expected an array of strings', path);
  }
  return [...value] as string[];
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError('CONFIG_INVALID', 'expected an object', path);
  }
  return value as Record<string, unknown>;
}
