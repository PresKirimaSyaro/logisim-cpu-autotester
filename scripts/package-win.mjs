#!/usr/bin/env node
/**
 * Build a portable Windows folder that can be started by double-clicking
 * "Logisim CPU Tester.exe". The Electron runtime, Java bridge classes, Logisim
 * jars, fixtures and the editable external test suite are all included.
 */
import {cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const root = resolve('.');
const releaseRoot = join(root, 'release');
const appDir = join(releaseRoot, 'Logisim CPU Tester');
const resources = join(appDir, 'resources');
const appRoot = join(resources, 'app');
const electronDist = join(root, 'node_modules', 'electron', 'dist');

if (!existsSync(electronDist)) throw new Error('node_modules/electron/dist is missing; run npm install first');
if (!existsSync(join(root, 'dist', 'electron', 'apps', 'desktop', 'main.js'))) {
  throw new Error('dist is missing; run npm run build:gui first');
}

rmSync(appDir, {recursive: true, force: true});
mkdirSync(appRoot, {recursive: true});
cpSync(electronDist, appDir, {recursive: true});
rmSync(join(resources, 'default_app.asar'), {force: true});
renameSync(join(appDir, 'electron.exe'), join(appDir, 'Logisim CPU Tester.exe'));

cpSync(join(root, 'dist'), join(appRoot, 'dist'), {recursive: true});
// Tests are development-only; the portable app ships the external suite and
// runtime code, not the compiled test corpus.
rmSync(join(appRoot, 'dist', 'tests'), {recursive: true, force: true});
// Migration-only test-program builder; the shipped app uses test-suites/*.json.
rmSync(join(appRoot, 'dist', 'packages', 'test-generator', 'src', 'builtin-directed.js'), {force: true});
cpSync(join(root, 'fixtures'), join(appRoot, 'fixtures'), {recursive: true});
cpSync(join(root, 'test-suites'), join(appRoot, 'test-suites'), {recursive: true});
cpSync(join(root, 'java-bridge', 'build', 'classes'), join(appRoot, 'java-bridge', 'build', 'classes'), {recursive: true});
mkdirSync(join(appRoot, 'vendor'), {recursive: true});
for (const name of ['logisim-generic-2.7.1.jar', 'gson-2.11.0.jar', 'COPYING.TXT', 'GSON-LICENSE.txt', 'README.md']) {
  const from = join(root, 'vendor', name);
  if (existsSync(from)) cpSync(from, join(appRoot, 'vendor', name));
}

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
writeFileSync(
  join(appRoot, 'package.json'),
  `${JSON.stringify({
    name: packageJson.name,
    productName: 'Logisim CPU Tester',
    version: '1.0.0',
    private: true,
    type: 'module',
    main: 'dist/electron/apps/desktop/main.js',
    description: 'Logisim single-cycle MIPS black-box differential tester',
  }, null, 2)}\n`,
);

const jlink = process.env.JAVA_HOME
  ? join(process.env.JAVA_HOME, 'bin', 'jlink.exe')
  : (spawnSync('where.exe', ['jlink.exe'], {encoding: 'utf8'}).stdout ?? '').split(/\r?\n/)[0].trim();
const runtime = join(appRoot, 'runtime');
if (existsSync(jlink)) {
  const modules = [
    'java.base', 'java.desktop', 'java.logging', 'java.xml', 'java.prefs',
    'java.datatransfer', 'java.scripting', 'java.naming', 'java.management',
    'java.instrument', 'jdk.unsupported',
  ].join(',');
  const result = spawnSync(jlink, [
    '--add-modules', modules,
    '--output', runtime,
    '--strip-debug', '--no-header-files', '--no-man-pages', '--compress=2',
  ], {stdio: 'inherit'});
  if (result.status !== 0) {
    console.warn('jlink failed; the portable app will use a system Java installation.');
    rmSync(runtime, {recursive: true, force: true});
  }
} else {
  console.warn('jlink not found; the portable app will use a system Java installation.');
}

writeFileSync(join(releaseRoot, 'README.txt'), [
  'Logisim CPU Tester (portable)',
  '',
  'Double-click: Logisim CPU Tester.exe',
  '',
  'The built-in test programs are external JSON files:',
  '  Logisim CPU Tester/resources/app/test-suites/course.json',
  'Edit them directly; each test run reloads the file, no rebuild is needed.',
  'Use "启用的指令集" in the workbench to select the supported ISA.',
  '',
  'A bundled Java runtime is in resources/app/runtime when jlink was available;',
  'otherwise install Java 17+ or select java.exe in Settings.',
  '',
  'Settings and test records are stored in the test-records folder next to this EXE.',
].join('\r\n') + '\r\n');

const size = directorySize(appDir);
console.log(`portable app: ${appDir}`);
console.log(`size: ${(size / 1024 / 1024).toFixed(1)} MB`);
console.log(`launcher: ${join(appDir, 'Logisim CPU Tester.exe')}`);

function directorySize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, {withFileTypes: true})) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else total += statSync(path).size;
    }
  }
  return total;
}
