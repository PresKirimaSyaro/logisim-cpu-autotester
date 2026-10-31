#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LogisimBridge} from '../../bridge-client/src/index.js';
import {
  ConfigError,
  MipsError,
  parseCpuConfig,
  parseInstructionSet,
  tryAssemble,
  type CpuConfig,
} from '../../mips-core/src/index.js';
import {
  DifferentialRunner,
  formatTerminalReport,
  writeJsonReport,
  type RunSummary,
  type TestInput,
} from '../../differential-runner/src/index.js';
import {
  generateStressTests,
  layoutForConfig,
  parseTestSuite,
  selectSuite,
  testsFromSuite,
  type StressIntensity,
} from '../../test-generator/src/index.js';

interface CliOptions {
  circuit?: string;
  config?: string;
  asm?: string;
  suite?: string;
  intensity?: StressIntensity;
  seedCount?: number;
  seed?: number;
  instructions?: string;
  suiteFile?: string;
  steps?: number;
  stopPc?: number;
  report?: string;
  expects: {byteAddress: number; expected: number}[];
  trace: boolean;
  json: boolean;
  list: boolean;
  java?: string;
  timeoutMs?: number;
  maxCycles?: number;
  help: boolean;
}

const HELP = `Usage:
  npm run test:cpu -- --circuit <cpu.circ> --config <cpu.config.json> --asm <program.asm> --steps <n>
  npm run test:cpu -- --circuit <cpu.circ> --config <cpu.config.json> --suite <basic|full|branch|memory|alu|stress>

Required:
  --circuit <path>       Logisim .circ file containing the CPU.
  --config <path>        JSON CpuConfig (see fixtures/cpu.config.json).
  One of:
  --asm <path>           Assembly file to run.
  --suite <name>         Run tests (basic, full, branch, memory, alu, stress).
  --suite-file <path>    External directed-test JSON (default: test-suites/course.json).
  --intensity <level>    Stress intensity: quick, standard, stress (default standard).
  --seed <n>             Base seed for stress random programs (default 0x5a17c0de).
  --seed-count <n>       Override the number of seeded stress programs.
  --instructions <list>  Comma-separated enabled instructions (overrides config).
                         Default: add,sub,ori,lw,sw,beq,lui,nop; optional sll,j.

Termination for --asm:
  --steps <n>            Exact number of dynamic instructions / CPU cycles.
  --stop-pc <address>    Stop when PC reaches this byte address.

Comparison:
  --expect <addr=value>  Expected final logical-DM value (repeatable; reference
                         cross-check only). CPU stores are checked per cycle.

The CPU is tested as a black box. Physical RAM contents are never read or
written; initialize DM with sw instructions. --range and --initial-ram were
removed with the physical-RAM comparison.

Other:
  --report <path>        JSON report path (default: test-results/report-<time>.json).
  --trace                Include the reference execution trace in the JSON report.
  --json                 Print the JSON report to stdout instead of the terminal table.
  --list                 List generated tests and exit (with --suite).
  --java <path>          Java executable (default: java or $JAVA).
  --timeout <ms>         Bridge request timeout (default: 10000).
  --max-cycles <n>       Override config.limits.maxCycles for this run.
  --help                 Show this help.

Exit codes: 0 all pass; 1 one or more differential failures; 2 harness/config/assembly error.
`;

async function main(argv: string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    console.error('Run with --help for usage.');
    return 2;
  }
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  if (!options.circuit) return usageError('--circuit is required');
  if (!options.config) return usageError('--config is required');
  if (!options.asm && !options.suite) return usageError('one of --asm or --suite is required');
  if (options.asm && options.suite) return usageError('--asm and --suite are mutually exclusive');

  let config: CpuConfig;
  try {
    const raw = JSON.parse(await readFile(options.config, 'utf8')) as unknown;
    config = parseCpuConfig(raw);
    if (options.instructions) {
      config = {...config, instructions: parseInstructionSet(options.instructions.split(',').map((item) => item.trim()))};
    }
  } catch (error) {
    printMipsError(error, options.config);
    return 2;
  }

  let tests: TestInput[];
  try {
    tests = options.suite ? await testsForSuite(config, options) : [await testFromAsm(options, config)];
  } catch (error) {
    printMipsError(error, options.asm ?? options.config);
    return 2;
  }
  if (options.list) {
    for (const test of tests) console.log(`${test.id}\t${test.category ?? ''}\t${test.name}`);
    return 0;
  }

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const bridge = new LogisimBridge({
    root: repoRoot,
    java: options.java,
    timeoutMs: options.timeoutMs ?? 30000,
    onStderr: (text) => {
      if (options.trace) process.stderr.write(text);
    },
  });
  let summary: RunSummary;
  try {
    const runner = new DifferentialRunner({
      circuitPath: resolve(options.circuit),
      config,
      bridge,
      maxCycles: options.maxCycles,
      trace: options.trace,
      onProgress: (event) => {
        if (event.kind === 'test-start' && !options.json) {
          process.stderr.write(`[run] ${event.testId} ${event.name}\n`);
        }
      },
    });
    summary = await runner.run(tests);
  } catch (error) {
    printMipsError(error, options.circuit);
    return 2;
  } finally {
    await bridge.close().catch(() => undefined);
  }

  const reportPath = options.report ?? defaultReportPath();
  let written: string | undefined;
  try {
    written = await writeJsonReport(summary, reportPath);
  } catch (error) {
    console.error(`Could not write JSON report: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(formatTerminalReport(summary));
    if (written) console.log(`\nJSON report: ${written}`);
  }

  if (summary.totals.errors > 0) return 2;
  if (summary.totals.failed > 0) return 1;
  return 0;
}

async function testsForSuite(config: CpuConfig, options: CliOptions): Promise<TestInput[]> {
  const layout = layoutForConfig(config);
  const suite = options.suite ?? 'basic';
  let all: ReturnType<typeof generateStressTests>;
  if (suite === 'stress') {
    all = generateStressTests(layout, {
      intensity: options.intensity ?? 'standard',
      seedCount: options.seedCount,
      seed: options.seed,
      instructions: config.instructions,
    });
  } else {
    const suitePath = options.suiteFile ?? 'test-suites/course.json';
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(suitePath, 'utf8'));
    } catch (error) {
      throw new ConfigError(
        'CONFIG_INVALID',
        `无法读取外部测试集 ${suitePath}: ${error instanceof Error ? error.message : String(error)}`,
        '$.suiteFile',
      );
    }
    all = testsFromSuite(parseTestSuite(raw), layout, config.instructions);
  }
  const selected = suite === 'full' || suite === 'all' || suite === 'stress' ? all : selectSuite(all, suite);
  if (selected.length === 0) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `Unknown or empty suite "${suite}". Available: basic, full, branch, memory, alu, stress`,
      '$.suite',
    );
  }
  return selected.map((test) => ({
    id: test.id,
    name: test.name,
    category: test.category,
    description: test.description,
    assembly: test.assembly,
    steps: test.steps,
    signature: test.signature,
    seed: test.seed,
  }));
}

async function testFromAsm(options: CliOptions, config: CpuConfig): Promise<TestInput> {
  const path = options.asm!;
  const source = await readFile(path, 'utf8');
  const attempt = tryAssemble(source, {fileName: path, instructions: config.instructions});
  if (!attempt.ok) {
    const diagnostic = attempt.diagnostic;
    throw new MipsError(diagnostic.code, diagnostic.message, {
      line: diagnostic.line,
      column: diagnostic.column,
      length: diagnostic.length,
    }, diagnostic.lineText);
  }
  if (options.steps === undefined && options.stopPc === undefined) {
    throw new ConfigError('CONFIG_INVALID', '--asm requires --steps <n> or --stop-pc <address>', '$.steps');
  }
  if (options.steps !== undefined && options.stopPc !== undefined) {
    throw new ConfigError('CONFIG_INVALID', '--steps and --stop-pc are mutually exclusive', '$.steps');
  }
  return {
    id: path,
    name: path,
    category: 'custom',
    description: 'Ad-hoc assembly file',
    assembly: source,
    assemblyFile: path,
    steps: options.steps,
    stopPc: options.stopPc,
    signature: options.expects,
    seed: null,
  };
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    expects: [],
    trace: false,
    json: false,
    list: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case '--circuit':
        options.circuit = next();
        break;
      case '--config':
        options.config = next();
        break;
      case '--asm':
        options.asm = next();
        break;
      case '--suite':
        options.suite = next();
        break;
      case '--suite-file':
        options.suiteFile = next();
        break;
      case '--intensity': {
        const value = next();
        if (value !== 'quick' && value !== 'standard' && value !== 'stress') {
          throw new Error('--intensity must be quick, standard or stress');
        }
        options.intensity = value;
        break;
      }
      case '--seed-count':
        options.seedCount = parsePositiveInt(next(), '--seed-count');
        break;
      case '--instructions':
        options.instructions = next();
        break;
      case '--seed': {
        const value = Number(next());
        if (!Number.isInteger(value) || value < 0) throw new Error('--seed must be a non-negative integer');
        options.seed = value >>> 0;
        break;
      }
      case '--steps':
        options.steps = parsePositiveInt(next(), '--steps');
        break;
      case '--stop-pc':
        options.stopPc = parseWord(next(), '--stop-pc');
        break;
      case '--report':
        options.report = next();
        break;
      case '--range':
        throw new Error('--range was removed: physical RAM comparison is no longer supported');
      case '--initial-ram':
        throw new Error('--initial-ram was removed: initialize logical DM with sw instructions');
      case '--expect': {
        const value = next();
        const [address, expected] = value.split('=');
        if (!address || !expected) throw new Error('--expect expects addr=value');
        options.expects.push({byteAddress: parseWord(address, '--expect address'), expected: parseWord(expected, '--expect value')});
        break;
      }
      case '--trace':
        options.trace = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--list':
        options.list = true;
        break;
      case '--java':
        options.java = next();
        break;
      case '--timeout':
        options.timeoutMs = parsePositiveInt(next(), '--timeout');
        break;
      case '--max-cycles':
        options.maxCycles = parsePositiveInt(next(), '--max-cycles');
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option ${arg}`);
    }
  }
  return options;
}

function parsePositiveInt(text: string, option: string): number {
  if (!/^\d+$/.test(text)) throw new Error(`${option} expects a non-negative integer`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${option} is out of range`);
  return value;
}

function parseWord(text: string, option: string): number {
  const value = /^0x/i.test(text) ? Number.parseInt(text.slice(2), 16) : Number(text);
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`${option} expects a 32-bit unsigned address/value`);
  }
  return value >>> 0;
}

function usageError(message: string): number {
  console.error(`Error: ${message}`);
  console.error('Run with --help for usage.');
  return 2;
}

function printMipsError(error: unknown, file?: string): void {
  if (error instanceof ConfigError) {
    console.error(`${file ?? 'config'}${error.path}: ${error.code}: ${error.message}`);
    return;
  }
  if (error instanceof MipsError) {
    const position = error.position;
    const where = position ? `${file ?? '<input>'}:${position.line}:${position.column}` : file ?? '<input>';
    console.error(`${where}: ${error.code}: ${error.message}`);
    if (error.lineText !== undefined) {
      console.error(`  ${error.lineText}`);
      if (position) console.error(`  ${' '.repeat(Math.max(0, position.column - 1))}^`);
    }
    return;
  }
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
}

function defaultReportPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return resolve('test-results', `report-${stamp}.json`);
}

// The CLI is intentionally a thin shell; all logic lives in reusable packages.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exitCode = 2;
    });
}

export {main, parseArgs};
