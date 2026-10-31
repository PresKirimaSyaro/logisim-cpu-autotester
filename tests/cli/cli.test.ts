import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const exec = promisify(execFile);
const CLI = 'dist/packages/cli/src/main.js';

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[]): Promise<CliResult> {
  try {
    const result = await exec(process.execPath, [CLI, ...args], {
      cwd: resolve('.'),
      maxBuffer: 16 * 1024 * 1024,
    });
    return {code: 0, stdout: result.stdout, stderr: result.stderr};
  } catch (error) {
    const typed = error as {code?: number; stdout?: string; stderr?: string};
    return {code: typeof typed.code === 'number' ? typed.code : 2, stdout: typed.stdout ?? '', stderr: typed.stderr ?? ''};
  }
}

test('CLI --asm runs a real CPU test and writes a JSON report', {timeout: 60000}, async () => {
  const result = await runCli([
    '--circuit',
    'fixtures/cpu.circ',
    '--config',
    'fixtures/cpu.config.json',
    '--asm',
    'tests/programs/basic.asm',
    '--steps',
    '4',
    '--expect',
    '256=12',
    '--report',
    'test-results/cli-pass.json',
    '--json',
  ]);
  assert.equal(result.code, 0, result.stderr);
  const summary = JSON.parse(result.stdout) as {totals: Record<string, number>; results: any[]};
  assert.equal(summary.totals.total, 1);
  assert.equal(summary.totals.passed, 1);
  assert.equal(summary.results[0].status, 'pass');
  assert.equal(summary.results[0].romReadbackVerified, undefined);
  assert.equal(summary.results[0].expectedRam, undefined);
  assert.ok(summary.results[0].signalCheckpoints.length > 0);
});

test('CLI accepts a circuit with several physical RAM components', {timeout: 60000}, async () => {
  const result = await runCli([
    '--circuit',
    'fixtures/course-multi-ram.circ',
    '--config',
    'fixtures/course.config.json',
    '--suite',
    'basic',
    '--report',
    'test-results/cli-multi-ram.json',
    '--json',
  ]);
  assert.equal(result.code, 0, result.stderr);
  const summary = JSON.parse(result.stdout) as {totals: Record<string, number>; results: any[]};
  assert.equal(summary.totals.failed, 0);
  assert.equal(summary.totals.errors, 0);
  assert.equal(summary.results[0].actualRam, undefined);
});

test('CLI rejects the removed physical-RAM range option', {timeout: 30000}, async () => {
  const result = await runCli([
    '--circuit',
    'fixtures/cpu.circ',
    '--config',
    'fixtures/cpu.config.json',
    '--asm',
    'tests/programs/basic.asm',
    '--steps',
    '4',
    '--range',
    '256:1',
  ]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--range was removed/);
});

test('CLI returns 1 for a differential failure and reports the first signal', {timeout: 60000}, async () => {
  const result = await runCli([
    '--circuit',
    'fixtures/cpu-faulty.circ',
    '--config',
    'fixtures/cpu.config.json',
    '--asm',
    'tests/programs/sll.asm',
    '--steps',
    '5',
    '--expect',
    '256=0x2B3C0000',
    '--report',
    'test-results/cli-fail.json',
    '--json',
  ]);
  assert.equal(result.code, 1, result.stderr);
  const summary = JSON.parse(result.stdout) as {totals: Record<string, number>; results: any[]};
  assert.equal(summary.totals.failed, 1);
  assert.equal(summary.results[0].errorType, 'signal-mismatch');
  assert.equal(summary.results[0].firstSignalMismatch.signal, 'RegData');
  assert.equal(summary.results[0].firstSignalMismatch.cycle, 2);
  assert.equal(summary.results[0].firstSignalMismatch.expected, '0x12340000');
});

test('CLI returns 2 for assembly and configuration errors', {timeout: 60000}, async () => {
  await mkdir('test-results', {recursive: true});
  await writeFile('test-results/empty.asm', '# no instructions\n');
  const empty = await runCli([
    '--circuit',
    'fixtures/cpu.circ',
    '--config',
    'fixtures/cpu.config.json',
    '--asm',
    'test-results/empty.asm',
    '--steps',
    '1',
  ]);
  assert.equal(empty.code, 2);
  assert.match(`${empty.stdout}\n${empty.stderr}`, /Empty assembly program/);

  await writeFile('test-results/bad.config.json', JSON.stringify({schemaVersion: 1, nope: true}));
  const badConfig = await runCli([
    '--circuit',
    'fixtures/cpu.circ',
    '--config',
    'test-results/bad.config.json',
    '--suite',
    'basic',
  ]);
  assert.equal(badConfig.code, 2);
  assert.match(badConfig.stderr, /CONFIG_/);
});

test('CLI --list exposes generated tests and does not start the bridge', {timeout: 30000}, async () => {
  const result = await runCli([
    '--circuit',
    'fixtures/cpu.circ',
    '--config',
    'fixtures/cpu.config.json',
    '--suite',
    'basic',
    '--list',
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /add-basic/);
  assert.match(result.stdout, /beq-taken/);
});
