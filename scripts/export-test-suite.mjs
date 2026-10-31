import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {parseCpuConfig} from '../dist/packages/mips-core/src/index.js';
import {ALL_INSTRUCTIONS} from '../dist/packages/mips-core/src/index.js';
import {layoutForConfig} from '../dist/packages/test-generator/src/index.js';
import {generateDirectedTests} from '../dist/packages/test-generator/src/builtin-directed.js';

const config = parseCpuConfig(JSON.parse(readFileSync('fixtures/course.config.json', 'utf8')));
const layout = layoutForConfig(config);
const tests = generateDirectedTests(layout, ALL_INSTRUCTIONS);
const suite = {
  schemaVersion: 1,
  name: 'course-directed',
  description:
    'External course test programs. Edit this JSON without rebuilding the application. Signature indexes are relative to the layout signatureBase (course: 0x100).',
  tests: tests.map((test) => ({
    id: test.id,
    name: test.name,
    category: test.category,
    description: test.description,
    assembly: test.assembly,
    steps: test.steps,
    signature: test.signature.map((entry) => ({
      index: (entry.byteAddress - layout.signatureBase) / 4,
      expected: entry.expected >>> 0,
    })),
    suites: test.suites,
    tags: test.tags,
    seed: test.seed,
    requiredRamBytes: requiredRamBytes(test, layout),
  })),
};
mkdirSync('test-suites', {recursive: true});
writeFileSync('test-suites/course.json', `${JSON.stringify(suite, null, 2)}\n`);
console.log(`wrote test-suites/course.json (${suite.tests.length} tests)`);

function requiredRamBytes(test, layout) {
  let bytes = 0;
  for (const entry of test.signature) bytes = Math.max(bytes, entry.byteAddress + 4 - layout.ramBase);
  for (const line of test.assembly.split(/\r?\n/)) {
    const match = /^\s*(?:lw|sw)\s+\$\w+,\s*(-?(?:0x[0-9a-f]+|\d+))\(\$zero\)/i.exec(line);
    if (!match) continue;
    const offset = Number(match[1]);
    if (Number.isFinite(offset)) bytes = Math.max(bytes, offset + 4);
  }
  return bytes;
}
