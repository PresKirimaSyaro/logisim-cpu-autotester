import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {LogisimBridge} from '../../packages/bridge-client/src/index.js';
import {parseCpuConfig} from '../../packages/mips-core/src/index.js';
import {
  generateDirectedTests,
  layoutForConfig,
  type DirectedTest,
} from '../../packages/test-generator/src/index.js';
import {
  DifferentialRunner,
  type CpuBridge,
  type TestInput,
  type RunSummary,
} from '../../packages/differential-runner/src/index.js';

async function loadConfig() {
  return parseCpuConfig(JSON.parse(await readFile('fixtures/cpu.config.json', 'utf8')));
}

async function loadCourseConfig() {
  return parseCpuConfig(JSON.parse(await readFile('fixtures/course.config.json', 'utf8')));
}

function toInput(test: DirectedTest): TestInput {
  return {
    id: test.id,
    name: test.name,
    category: test.category,
    description: test.description,
    assembly: test.assembly,
    steps: test.steps,
    signature: test.signature,
    seed: test.seed,
  };
}

async function runSuite(circuit: string, tests: TestInput[], configOverride?: Awaited<ReturnType<typeof loadConfig>>): Promise<RunSummary> {
  const config = configOverride ?? (await loadConfig());
  const bridge = new LogisimBridge({timeoutMs: 30000});
  try {
    const runner = new DifferentialRunner({
      circuitPath: resolve(circuit),
      config,
      bridge,
      stopOnPcDivergence: true,
    });
    return await runner.run(tests);
  } finally {
    await bridge.close();
  }
}

test('course profile (main, internal Clock, standard outputs) passes all 49 black-box tests', {timeout: 120000}, async () => {
  const config = await loadCourseConfig();
  const tests = generateDirectedTests(layoutForConfig(config)).map(toInput);
  const summary = await runSuite('fixtures/course-cpu.circ', tests, config);
  assert.deepEqual(summary.totals, {total: 49, passed: 49, failed: 0, errors: 0, skipped: 0});
  for (const result of summary.results) {
    assert.equal(result.status, 'pass', result.message);
    assert.equal(result.firstSignalMismatch, undefined);
    assert.ok((result.signalCheckpoints?.length ?? 0) > 0);
    assert.equal(result.pc?.finalMatch, true);
    assert.ok((result.reference?.observableWrites ?? 0) > 0);
    assert.equal(result.expectedRam, undefined);
    assert.equal(result.actualRam, undefined);
  }
});

test('real external-clock CPU passes all 49 black-box tests through its top-level outputs', {timeout: 120000}, async () => {
  const config = await loadConfig();
  const tests = generateDirectedTests(layoutForConfig(config)).map(toInput);
  assert.equal(tests.length, 49);
  const summary = await runSuite('fixtures/cpu.circ', tests);
  assert.deepEqual(
    summary.totals,
    {total: 49, passed: 49, failed: 0, errors: 0, skipped: 0},
    JSON.stringify(summary.results.filter((result) => result.status !== 'pass'), null, 2),
  );
  for (const result of summary.results) {
    assert.equal(result.status, 'pass');
    assert.equal(result.stepsExecuted, result.stepsRequested);
    assert.equal(result.cyclesCompleted, result.cyclesRequested);
    assert.equal(result.romReadbackVerified, undefined);
    assert.equal(result.firstSignalMismatch, undefined);
    assert.equal(result.pc?.finalMatch, true);
    assert.ok((result.signalCheckpoints?.length ?? 0) > 0);
  }
});

test('runner performs no readMemory call at all in black-box mode', {timeout: 60000}, async () => {
  const config = await loadCourseConfig();
  const test = generateDirectedTests(layoutForConfig(config)).find((entry) => entry.id === 'add-basic');
  assert.ok(test);
  const bridge = new LogisimBridge({timeoutMs: 30000});
  const memoryReads: string[] = [];
  const proxy = new Proxy(bridge, {
    get(target, property, receiver) {
      if (property === 'readMemory') {
        return async (path: string, start?: number, count?: number) => {
          memoryReads.push(path);
          return target.readMemory(path, start, count);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as CpuBridge;
  try {
    const runner = new DifferentialRunner({
      circuitPath: resolve('fixtures/course-cpu.circ'),
      config,
      bridge: proxy,
    });
    const summary = await runner.run([toInput(test)]);
    assert.equal(summary.results[0].status, 'pass', summary.results[0].message);
    assert.deepEqual(memoryReads, [], 'black-box runner must not read any physical memory');
  } finally {
    await proxy.close();
  }
});

test('$zero writeback with RegWrite=1/RegAddr=0 is treated as a no-op, not an error', {timeout: 60000}, async () => {
  const config = await loadCourseConfig();
  const test = generateDirectedTests(layoutForConfig(config)).find((entry) => entry.id === 'add-zero-register');
  assert.ok(test);
  const bridge = new LogisimBridge({timeoutMs: 30000});
  let reads = 0;
  const proxy = new Proxy(bridge, {
    get(target, property, receiver) {
      if (property === 'readOutputs') {
        return async (ports: string[]) => {
          reads++;
          const result = await target.readOutputs(ports);
          if (reads === 4) {
            result[config.outputs!.regWrite] = {...result[config.outputs!.regWrite], value: '0x1'};
            result[config.outputs!.regAddr] = {...result[config.outputs!.regAddr], value: '0x00'};
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as CpuBridge;
  try {
    const runner = new DifferentialRunner({
      circuitPath: resolve('fixtures/course-cpu.circ'),
      config,
      bridge: proxy,
    });
    const summary = await runner.run([toInput(test)]);
    assert.equal(summary.results[0].status, 'pass', summary.results[0].message);
  } finally {
    await proxy.close();
  }
});

test('sw/lw cross-check observes store data and the later load writeback', {timeout: 60000}, async () => {
  const config = await loadCourseConfig();
  const bridge = new LogisimBridge({timeoutMs: 30000});
  try {
    const runner = new DifferentialRunner({
      circuitPath: resolve('fixtures/course-cpu.circ'),
      config,
      bridge,
    });
    const result = await runner.runTest({
      id: 'sw-lw-cross-check',
      name: 'sw then lw cross-check',
      assembly: 'ori $t0, $zero, 123\nsw $t0, 0($zero)\nlw $t1, 0($zero)\nsw $t1, 256($zero)\n',
      steps: 4,
    });
    assert.equal(result.status, 'pass', result.message);
    const checkpoints = result.signalCheckpoints ?? [];
    assert.ok(checkpoints.some((entry) => entry.signal === 'MemWrite' && entry.cycle === 2 && entry.expected === '0x00000001'));
    assert.ok(checkpoints.some((entry) => entry.signal === 'MemData' && entry.cycle === 2 && entry.expected === '0x0000007B'));
    assert.ok(checkpoints.some((entry) => entry.signal === 'RegData' && entry.cycle === 3 && entry.expected === '0x0000007B'));
    assert.ok(checkpoints.some((entry) => entry.signal === 'MemData' && entry.cycle === 4 && entry.expected === '0x0000007B'));
  } finally {
    await bridge.close();
  }
});

test('physical RAM count does not affect acceptance: extra RAM components are ignored', {timeout: 120000}, async () => {
  const config = await loadCourseConfig();
  const tests = generateDirectedTests(layoutForConfig(config)).map(toInput);
  const summary = await runSuite('fixtures/course-multi-ram.circ', tests, config);
  assert.deepEqual(summary.totals, {total: 49, passed: 49, failed: 0, errors: 0, skipped: 0});
  for (const result of summary.results) assert.equal(result.status, 'pass', result.message);
});

test('controlled faulty CPU is detected at the first signal mismatch', {timeout: 60000}, async () => {
  const config = await loadConfig();
  const test = generateDirectedTests(layoutForConfig(config)).find((entry) => entry.id === 'sll-15');
  assert.ok(test);
  const summary = await runSuite('fixtures/cpu-faulty.circ', [toInput(test)]);
  assert.equal(summary.totals.failed, 1);
  const result = summary.results[0];
  assert.equal(result.status, 'fail');
  assert.equal(result.errorType, 'signal-mismatch');
  assert.ok(result.firstSignalMismatch);
  assert.equal(result.firstSignalMismatch?.signal, 'RegData');
  assert.equal(result.firstSignalMismatch?.cycle, 2);
  assert.equal(result.firstSignalMismatch?.expected, '0x12340000');
  assert.notEqual(result.firstSignalMismatch?.actual, result.firstSignalMismatch?.expected);
  assert.equal(result.actualRam, undefined);
});

test('dead CPU fails at the first post-clock PC divergence, not PASS', {timeout: 60000}, async () => {
  const config = await loadConfig();
  const test = generateDirectedTests(layoutForConfig(config)).find((entry) => entry.id === 'add-basic');
  assert.ok(test);
  const summary = await runSuite('fixtures/cpu-dead.circ', [toInput(test)]);
  assert.equal(summary.totals.failed, 1);
  const result = summary.results[0];
  assert.equal(result.status, 'fail');
  assert.equal(result.errorType, 'simulation');
  assert.equal(result.cyclesCompleted, 1);
  assert.equal(result.cyclesRequested, test.steps);
  assert.equal(result.pc?.firstDivergence?.cycle, 1);
  assert.equal(result.pc?.firstDivergence?.actual, '0x00000000');
});

test('config without top-level outputs is rejected instead of falling back to RAM', {timeout: 60000}, async () => {
  const config = await loadConfig();
  const noOutputs = {...config, outputs: undefined};
  const test = generateDirectedTests(layoutForConfig(config)).find((entry) => entry.id === 'add-basic');
  assert.ok(test);
  const summary = await runSuite('fixtures/cpu.circ', [toInput(test)], noOutputs);
  const result = summary.results[0];
  assert.equal(result.status, 'error');
  assert.equal(result.errorType, 'config');
  assert.match(result.message ?? '', /outputs/i);
});

test('state reset and PC pin observation remain supported', {timeout: 60000}, async () => {
  const config = await loadConfig();
  const alternate = {
    ...config,
    reset: {strategy: 'state' as const},
    pc: {mode: 'pin' as const, port: 'pc', initial: 0, checkEachCycle: true},
  };
  const test = generateDirectedTests(layoutForConfig(config)).find((entry) => entry.id === 'add-basic');
  assert.ok(test);
  const summary = await runSuite('fixtures/cpu.circ', [toInput(test)], alternate);
  assert.equal(summary.results[0].status, 'pass', summary.results[0].message);
  assert.equal(summary.results[0].pc?.mode, 'pin');
  assert.equal(summary.results[0].pc?.finalMatch, true);
  assert.equal(summary.results[0].pc?.checkpoints?.length, test.steps);
});

test('a closed/failed bridge produces an error, never PASS', {timeout: 60000}, async () => {
  const config = await loadConfig();
  const bridge = new LogisimBridge({timeoutMs: 30000});
  await bridge.close();
  const runner = new DifferentialRunner({
    circuitPath: resolve('fixtures/cpu.circ'),
    config,
    bridge,
  });
  const result = await runner.runTest({
    id: 'closed-bridge',
    name: 'closed bridge',
    assembly: await readFile('tests/programs/basic.asm', 'utf8'),
    steps: 4,
  });
  assert.notEqual(result.status, 'pass');
  assert.equal(result.status, 'error');
  assert.equal(result.errorType, 'bridge');
  assert.match(result.message ?? '', /CLOSED|closed/i);
});

test('empty and unobservable programs are rejected rather than marked pass', {timeout: 60000}, async () => {
  const config = await loadConfig();
  const bridge = new LogisimBridge({timeoutMs: 30000});
  try {
    const runner = new DifferentialRunner({
      circuitPath: resolve('fixtures/cpu.circ'),
      config,
      bridge,
    });
    const empty = await runner.runTest({
      id: 'empty',
      name: 'empty program',
      assembly: '# nothing\n',
      steps: 1,
    });
    assert.equal(empty.status, 'error');
    assert.equal(empty.errorType, 'assembly');
    assert.match(empty.message ?? '', /Empty assembly/);

    const unobservable = await runner.runTest({
      id: 'unobservable',
      name: 'no architectural write',
      assembly: 'beq $zero, $zero, next\nnext:\n',
      steps: 1,
    });
    assert.equal(unobservable.status, 'error');
    assert.equal(unobservable.errorType, 'observability');
    assert.match(unobservable.message ?? '', /no observable/i);

    const zeroProgram = await runner.runTest({
      id: 'zero-fill',
      name: 'all-zero instruction',
      assembly: 'sll $zero, $zero, 0\n',
      steps: 1,
    });
    assert.equal(zeroProgram.status, 'error');
    assert.equal(zeroProgram.errorType, 'observability');
  } finally {
    await bridge.close();
  }
});
