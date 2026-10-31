import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseCpuConfig} from '../../packages/mips-core/src/index.js';
import {COURSE_INSTRUCTIONS} from '../../packages/mips-core/src/index.js';
import {
  generateStressTests,
  layoutForConfig,
  programInstructions,
  stressProfile,
} from '../../packages/test-generator/src/index.js';

async function config() {
  return parseCpuConfig(JSON.parse(await readFile('fixtures/course.config.json', 'utf8')));
}

test('stress profiles expose progressively larger loop programs', async () => {
  const layout = layoutForConfig(await config());
  const quick = generateStressTests(layout, {intensity: 'quick'});
  const standard = generateStressTests(layout, {intensity: 'standard'});
  const stress = generateStressTests(layout, {intensity: 'stress'});
  assert.ok(quick.length >= 6);
  assert.ok(standard.length > quick.length);
  assert.ok(stress.length > standard.length);
  assert.ok(stress.some((entry) => entry.steps > 4096), 'stress must include a >4096-cycle loop');
  assert.deepEqual(stressProfile('quick').loopCount, 64);
  for (const entry of [...quick, ...standard, ...stress]) {
    assert.ok(entry.steps >= 1);
    assert.ok(entry.signature.length > 0);
    assert.ok(entry.signature.some((word) => word.expected !== 0));
    assert.equal(entry.suites.includes('stress'), true);
  }
  const seeded = stress.filter((entry) => entry.seed !== null);
  assert.equal(seeded.length, 8);
  assert.equal(new Set(seeded.map((entry) => entry.seed)).size, 8);

  const courseOnly = generateStressTests(layout, {intensity: 'quick', instructions: COURSE_INSTRUCTIONS});
  assert.ok(courseOnly.length > 0);
  for (const entry of courseOnly) {
    for (const name of programInstructions(entry.assembly)) {
      assert.ok(COURSE_INSTRUCTIONS.includes(name as never), `${entry.id} uses ${name}`);
    }
    assert.ok(!entry.assembly.match(/\b(sll|j)\b/));
  }
});
