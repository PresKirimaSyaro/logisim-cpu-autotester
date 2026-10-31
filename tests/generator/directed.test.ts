import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  ConfigError,
  ReferenceInterpreter,
  assemble,
  decode,
  parseCpuConfig,
} from '../../packages/mips-core/src/index.js';
import {
  generateDirectedTests,
  layoutForConfig,
  selectSuite,
} from '../../packages/test-generator/src/index.js';

async function config() {
  return parseCpuConfig(JSON.parse(await readFile('fixtures/cpu.config.json', 'utf8')));
}

test('directed suite has all categories, non-zero signatures and exact step counts', async () => {
  const layout = layoutForConfig(await config());
  const tests = generateDirectedTests(layout);
  assert.equal(tests.length, 49);
  const categories = new Set<string>(tests.map((test) => test.category));
  for (const category of ['add-sub', 'ori', 'sll', 'lw-sw', 'beq', 'mixed']) {
    assert.ok(categories.has(category), `missing category ${category}`);
  }
  const ids = new Set<string>();
  for (const test of tests) {
    assert.ok(!ids.has(test.id), `duplicate test id ${test.id}`);
    ids.add(test.id);
    assert.ok(test.signature.length > 0, `${test.id} has no signature`);
    assert.ok(
      test.signature.some((word) => (word.expected >>> 0) !== 0),
      `${test.id} signature is all zero`,
    );
    for (const word of test.signature) {
      assert.equal(word.byteAddress % 4, 0, `${test.id} signature is misaligned`);
      assert.ok(word.byteAddress >= layout.ramBase, `${test.id} signature below RAM`);
      assert.ok(word.byteAddress < layout.ramBase + layout.ramBytes, `${test.id} signature above RAM`);
    }
    const program = assemble(test.assembly);
    for (const word of program.words) {
      const decoded = decode(word);
      assert.equal(decoded.ok, true, `${test.id} emitted unsupported word ${word.toString(16)}`);
    }
    const cpu = new ReferenceInterpreter({
      romWords: program.words,
      rom: {baseByteAddress: 0, addressBits: 8, addressShift: 2, dataBits: 32, capacityWords: 256},
      ram: {baseByteAddress: 0, addressBits: 8, addressShift: 2, dataBits: 32, capacityWords: 256},
      initialPc: 0,
    });
    const run = cpu.runSteps(test.steps);
    assert.equal(run.status, 'completed', `${test.id}: ${JSON.stringify(run)}`);
    assert.equal(run.steps, test.steps, `${test.id} step count`);
    const ram = cpu.snapshotRamWords();
    for (const signature of test.signature) {
      const index = signature.byteAddress >>> 2;
      assert.equal(
        ram[index],
        signature.expected >>> 0,
        `${test.id} signature at 0x${signature.byteAddress.toString(16)}`,
      );
    }
  }
});

test('seeded cases are deterministic and expose their seed', async () => {
  const layout = layoutForConfig(await config());
  const first = generateDirectedTests(layout).filter((test) => test.seed !== null);
  const second = generateDirectedTests(layout).filter((test) => test.seed !== null);
  assert.equal(first.length, 4);
  assert.deepEqual(first, second);
  assert.equal(new Set(first.map((test) => test.seed)).size, first.length);
  for (const test of first) {
    assert.match(test.id, /^seeded-/);
    assert.ok(test.signature.length >= 3);
  }
});

test('suite selection includes the advertised groups', async () => {
  const tests = generateDirectedTests(layoutForConfig(await config()));
  assert.ok(selectSuite(tests, 'basic').length > 10);
  assert.equal(selectSuite(tests, 'full').length, tests.length);
  assert.ok(selectSuite(tests, 'branch').length >= 8);
  assert.ok(selectSuite(tests, 'memory').length >= 9);
  assert.ok(selectSuite(tests, 'alu').length >= 21);
  assert.equal(selectSuite(tests, 'missing').length, 0);
});

test('layout is derived from RAM and rejects insufficient or unreachable RAM', async () => {
  const cfg = await config();
  const layout = layoutForConfig(cfg);
  assert.equal(layout.signatureBase, 0x100);
  assert.equal(layout.scratchBase, 0x200);
  assert.equal(layout.lastWordAddress, 1020);

  const small = structuredClone(cfg);
  small.ram.capacityWords = 32;
  assert.throws(
    () => layoutForConfig(small),
    (error: unknown) => error instanceof ConfigError && error.code === 'CONFIG_RANGE',
  );
});
