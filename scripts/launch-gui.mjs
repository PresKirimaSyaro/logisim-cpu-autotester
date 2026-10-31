import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const smoke = process.argv.includes('--smoke');
const env = {...process.env};
// Some harness shells set this for VS Code/Electron subprocesses. It forces the
// Electron binary to behave as plain Node and prevents a GUI from starting.
delete env.ELECTRON_RUN_AS_NODE;
if (smoke) env.CPU_TESTER_SMOKE = '1';

const child = spawn(electronPath, ['.'], {
  cwd: resolve('.'),
  env,
  stdio: 'inherit',
  windowsHide: false,
});
child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
