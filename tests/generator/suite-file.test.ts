import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseCpuConfig, ALL_INSTRUCTIONS, COURSE_INSTRUCTIONS} from '../../packages/mips-core/src/index.js';
import {
  layoutForConfig,
  parseTestSuite,
  testsFromSuite,
  programInstructions,
} from '../../packages/test-generator/src/index.js';

async function loadSuite() {
  const config = parseCpuConfig(JSON.parse(await readFile('fixtures/course.config.json', 'utf8')));
  const raw = JSON.parse(await readFile('test-suites/course.json', 'utf8'));
  return {config, layout: layoutForConfig(config), suite: parseTestSuite(raw)};
}

test('external suite is the application source of truth and filters optional instructions', async () => {
  const {layout, suite} = await loadSuite();
  assert.equal(suite.name, 'course-directed');
  const defaults = testsFromSuite(suite, layout, COURSE_INSTRUCTIONS);
  const all = testsFromSuite(suite, layout, ALL_INSTRUCTIONS);
  assert.equal(defaults.length, 47);
  assert.equal(all.length, 65);
  assert.ok(defaults.some((entry) => entry.id === 'lui-ffff'));
  assert.ok(!defaults.some((entry) => entry.id.startsWith('sll-')));
  assert.ok(all.some((entry) => entry.id === 'j-backward-loop'));
  for (const entry of defaults) {
    for (const name of programInstructions(entry.assembly)) {
      assert.ok(COURSE_INSTRUCTIONS.includes(name as never), `${entry.id} emits disabled ${name}`);
    }
    for (const signature of entry.signature) {
      assert.equal(signature.byteAddress % 4, 0);
      assert.ok(signature.byteAddress >= layout.ramBase);
      assert.ok(signature.byteAddress < layout.ramBase + layout.ramBytes);
    }
  }
});

test('external suite rejects duplicate ids and empty signatures with a clear error', async () => {
  const base = {
    schemaVersion: 1 as const,
    name: 'bad',
    tests: [
      {
        id: 'dup',
        name: 'a',
        category: 'mixed',
        description: '',
        assembly: 'nop\n',
        steps: 1,
        signature: [{index: 0, expected: 1}],
        suites: ['basic'],
        tags: [],
        seed: null,
      },
    ],
  };
  assert.throws(() => parseTestSuite({...base, tests: [...base.tests, ...base.tests]}), /duplicate test id/);
  assert.throws(
    () => parseTestSuite({...base, tests: [{...base.tests[0], signature: []}]}),
    /signature must be a non-empty array/,
  );
});
