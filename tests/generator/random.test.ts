import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {COURSE_INSTRUCTIONS, parseCpuConfig} from '../../packages/mips-core/src/index.js';
import {
  generateRandomTests,
  layoutForConfig,
  programInstructions,
} from '../../packages/test-generator/src/index.js';

async function config() {
  return parseCpuConfig(JSON.parse(await readFile('fixtures/course.config.json', 'utf8')));
}

test('random programs are deterministic, seedable and use only enabled instructions', async () => {
  const cfg = await config();
  const layout = layoutForConfig(cfg);
  const first = generateRandomTests(layout, {count: 8, seed: 0x1234, instructions: cfg.instructions});
  const second = generateRandomTests(layout, {count: 8, seed: 0x1234, instructions: cfg.instructions});
  const other = generateRandomTests(layout, {count: 8, seed: 0x9999, instructions: cfg.instructions});
  assert.equal(first.length, 8);
  assert.deepEqual(first, second);
  assert.notDeepEqual(first.map((entry) => entry.id), other.map((entry) => entry.id));
  for (const entry of first) {
    assert.equal(entry.seed, 0x1234);
    assert.equal(entry.category, 'random');
    assert.ok(entry.steps > 0);
    assert.ok(entry.signature.some((word) => word.expected !== 0));
    for (const name of programInstructions(entry.assembly)) {
      assert.ok(COURSE_INSTRUCTIONS.includes(name as never), `${entry.id} uses ${name}`);
    }
  }
});

test('random generation respects explicitly disabled instructions and count bounds', async () => {
  const layout = layoutForConfig(await config());
  const restricted = generateRandomTests(layout, {
    count: 3,
    seed: 7,
    instructions: ['add', 'ori', 'sw', 'nop'],
  });
  assert.equal(restricted.length, 3);
  for (const entry of restricted) {
    const used = new Set(programInstructions(entry.assembly));
    assert.ok([...used].every((name) => ['add', 'ori', 'sw', 'nop'].includes(name)));
  }
  assert.equal(generateRandomTests(layout, {count: 0, seed: 1, instructions: ['ori', 'sw']}).length, 1);
});
