import {mkdir, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import type {RunSummary, TestResult} from './types.js';

export async function writeJsonReport(summary: RunSummary, reportPath: string): Promise<string> {
  const absolute = resolve(reportPath);
  await mkdir(dirname(absolute), {recursive: true});
  await writeFile(absolute, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return absolute;
}

export function formatTerminalReport(summary: RunSummary): string {
  const lines: string[] = [];
  lines.push('Logisim CPU black-box differential test report');
  lines.push(`  circuit : ${summary.circuitPath} (${summary.circuitName})`);
  lines.push(`  config  : ${summary.configName}`);
  lines.push(
    `  totals  : ${summary.totals.total} total, ${summary.totals.passed} pass, ${summary.totals.failed} fail, ${summary.totals.errors} error, ${summary.totals.skipped} skipped`,
  );
  lines.push(`  elapsed : ${summary.durationMs} ms`);
  lines.push('  observe : top-level outputs sampled immediately before each clock edge');
  lines.push('');
  const width = Math.max(4, ...summary.results.map((result) => result.id.length));
  lines.push(`${'STATUS'.padEnd(7)}  ${'ID'.padEnd(width)}  CATEGORY      DETAILS`);
  for (const result of summary.results) {
    lines.push(
      `${statusLabel(result.status).padEnd(7)}  ${result.id.padEnd(width)}  ${result.category.padEnd(12)}  ${summaryMessage(result)}`,
    );
  }
  const problems = summary.results.filter((result) => result.status !== 'pass');
  if (problems.length > 0) {
    lines.push('');
    lines.push('Failure details');
    for (const result of problems) {
      lines.push('');
      lines.push(`[${result.id}] ${result.name}`);
      lines.push(`  status    : ${result.status}${result.errorType ? ` (${result.errorType})` : ''}`);
      if (result.message) lines.push(`  message   : ${result.message}`);
      if (result.firstSignalMismatch) {
        const mismatch = result.firstSignalMismatch;
        lines.push(
          `  first signal: ${mismatch.signal} at cycle ${mismatch.cycle}: expected ${mismatch.expected}, actual ${mismatch.actual}`,
        );
      }
      if (result.pc?.firstDivergence) {
        lines.push(
          `  pc        : diverged at cycle ${result.pc.firstDivergence.cycle}: expected ${result.pc.firstDivergence.expected}, actual ${result.pc.firstDivergence.actual}`,
        );
      } else if (result.pc?.finalMatch === false) {
        lines.push(`  pc        : expected ${result.pc.expectedFinal}, actual ${result.pc.actualFinal}`);
      }
      if (result.bridgeErrors.length > 0) {
        for (const error of result.bridgeErrors.slice(0, 5)) lines.push(`  bridge    : ${error}`);
      }
    }
  }
  if (summary.knownLimitations.length > 0) {
    lines.push('');
    lines.push('Known limitations');
    for (const limitation of summary.knownLimitations) lines.push(`  - ${limitation}`);
  }
  return lines.join('\n');
}

function statusLabel(status: TestResult['status']): string {
  switch (status) {
    case 'pass':
      return 'PASS';
    case 'fail':
      return 'FAIL';
    case 'error':
      return 'ERROR';
    case 'skipped':
      return 'SKIP';
  }
}

function summaryMessage(result: TestResult): string {
  if (result.status === 'pass') {
    const signals = result.signalCheckpoints?.length ?? 0;
    return `${result.stepsExecuted} cycle(s), ${signals} signal observation(s), no mismatch`;
  }
  return result.message ?? (result.errorType ?? 'failed');
}

export function formatMachineCode(result: TestResult): string {
  return result.machineCode.map((hex, index) => `  0x${(index * 4).toString(16).padStart(8, '0')}: ${hex}`).join('\n');
}
