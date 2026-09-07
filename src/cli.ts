import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createBaseline, isBaseline, type Baseline, type BaselineOptions } from './baseline';
import { defineContract, inferContract, validate, type Contract } from './contract';
import { detectDrift, type DriftOptions } from './drift';
import { detectLeakage, detectOverlap } from './leakage';
import { readJson, readRows, writeJson } from './node';
import { profile } from './profile';
import { contractToMarkdown, driftToMarkdown, leakageToMarkdown, overlapToMarkdown, profileToMarkdown, validationToMarkdown } from './report';
import type { Row } from './types';

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

interface Parsed {
  command: string | undefined;
  positionals: string[];
  flags: Record<string, string | true>;
}

const USAGE = `leakcheck - leakage, drift and data contract checks for ML datasets

Usage:
  leakcheck leak <data> --label <column> [--exclude a,b] [--features a,b]
                        [--label-time <column> --feature-times a,b]
                        [--association 0.95] [--label-copy 0.99] [--future 0]
  leakcheck overlap <train> <test> [--keys a,b] [--columns a,b]
  leakcheck drift <reference | baseline.json> <current> [--columns a,b] [--bins 10]
                        [--binning quantile|width] [--psi 0.2] [--p-value 0.05]
                        [--missing-rate 0.1] [--categorical a,b] [--numeric a,b]
  leakcheck baseline <data> --out <baseline.json> [--columns a,b] [--bins 10]
                        [--binning quantile|width] [--sample-size 2000]
  leakcheck validate <contract.json> <data> [--now <iso>] [--max-issues 1000] [--strict]
  leakcheck infer <data> --name <name> [--out <contract.json>] [--enum-max 10] [--margin 0.1]
  leakcheck profile <data> [--columns a,b]

Data files: .csv, .tsv, .ndjson, .jsonl, or .json (an array of objects).
Options for every command:
  --json       print the report as JSON instead of Markdown
  --no-fail    exit 0 even when the check fails (default: exit 1 on leakage, drift or contract issues)
  --min-samples <n>   fewest values a column needs (default 20)
  --help, --version`;

function parse(argv: readonly string[]): Parsed {
  const flags: Record<string, string | true> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (eq !== -1) {
        flags[name] = arg.slice(eq + 1);
      } else if (name.startsWith('no-')) {
        flags[name] = true;
      } else if (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) {
        flags[name] = argv[i + 1]!;
        i += 1;
      } else {
        flags[name] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { command: positionals[0], positionals: positionals.slice(1), flags };
}

class UsageError extends Error {}

function text(flags: Parsed['flags'], name: string): string | undefined {
  const value = flags[name];
  if (value === true) throw new UsageError(`--${name} needs a value`);
  return value;
}

function list(flags: Parsed['flags'], name: string): string[] | undefined {
  const value = text(flags, name);
  return value === undefined ? undefined : value.split(',').map((s) => s.trim()).filter(Boolean);
}

function number(flags: Parsed['flags'], name: string): number | undefined {
  const value = text(flags, name);
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} needs a number, got "${value}"`);
  return n;
}

function need(positionals: string[], index: number, what: string): string {
  const value = positionals[index];
  if (!value) throw new UsageError(`missing ${what}`);
  return value;
}

function baselineOptions(flags: Parsed['flags']): BaselineOptions {
  const binning = text(flags, 'binning');
  if (binning !== undefined && binning !== 'quantile' && binning !== 'width') throw new UsageError('--binning must be quantile or width');
  return {
    columns: list(flags, 'columns'),
    bins: number(flags, 'bins'),
    binning,
    minSamples: number(flags, 'min-samples'),
    maxCategories: number(flags, 'max-categories'),
    categorical: list(flags, 'categorical'),
    numeric: list(flags, 'numeric'),
    sampleSize: number(flags, 'sample-size'),
  };
}

async function readReference(path: string): Promise<readonly Row[] | Baseline> {
  if (path.toLowerCase().endsWith('.json')) {
    const parsed = await readJson<unknown>(path);
    if (isBaseline(parsed)) return parsed;
  }
  return readRows(path);
}

function version(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require('../package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

/**
 * Runs the command line with the given arguments (without `node` and the script name) and
 * returns the exit code: 0 when the check passed, 1 when it failed, 2 on a usage error.
 */
export async function run(argv: readonly string[], io: CliIO = defaultIO()): Promise<number> {
  const { command, positionals, flags } = parse(argv);
  if (flags.version) {
    io.stdout(version());
    return 0;
  }
  if (!command || command === 'help' || flags.help) {
    io.stdout(USAGE);
    return command || flags.help ? 0 : 2;
  }
  const asJson = flags.json === true;
  const fail = flags['no-fail'] !== true;
  const emit = (report: unknown, markdown: () => string) => io.stdout(asJson ? JSON.stringify(report, null, 2) : markdown());
  try {
    switch (command) {
      case 'leak': {
        const rows = await readRows(need(positionals, 0, 'data file'));
        const label = text(flags, 'label');
        if (!label) throw new UsageError('--label is required');
        const report = detectLeakage(rows, {
          label,
          features: list(flags, 'features'),
          exclude: list(flags, 'exclude'),
          labelTime: text(flags, 'label-time'),
          featureTimes: list(flags, 'feature-times'),
          minSamples: number(flags, 'min-samples'),
          thresholds: { association: number(flags, 'association'), labelCopy: number(flags, 'label-copy'), future: number(flags, 'future') },
        });
        emit(report, () => leakageToMarkdown(report));
        return report.ok || !fail ? 0 : 1;
      }
      case 'overlap': {
        const train = await readRows(need(positionals, 0, 'train file'));
        const test = await readRows(need(positionals, 1, 'test file'));
        const report = detectOverlap(train, test, { keys: list(flags, 'keys'), columns: list(flags, 'columns'), examples: number(flags, 'examples') });
        emit(report, () => overlapToMarkdown(report));
        return report.ok || !fail ? 0 : 1;
      }
      case 'drift': {
        const reference = await readReference(need(positionals, 0, 'reference file'));
        const current = await readRows(need(positionals, 1, 'current file'));
        const options: DriftOptions = {
          ...baselineOptions(flags),
          thresholds: { psi: number(flags, 'psi'), pValue: number(flags, 'p-value'), missingRate: number(flags, 'missing-rate') },
        };
        const report = detectDrift(reference, current, options);
        emit(report, () => driftToMarkdown(report, { bins: flags['no-bins'] !== true }));
        return report.ok || !fail ? 0 : 1;
      }
      case 'baseline': {
        const rows = await readRows(need(positionals, 0, 'data file'));
        const out = text(flags, 'out');
        const baseline = createBaseline(rows, baselineOptions(flags));
        if (out) {
          await writeJson(out, baseline);
          const kinds = Object.values(baseline.columns);
          io.stdout(`baseline of ${baseline.rows} rows written to ${out}: ${kinds.filter((c) => c.kind === 'numeric').length} numeric, ${kinds.filter((c) => c.kind === 'categorical').length} categorical, ${kinds.filter((c) => c.kind === 'skipped').length} skipped`);
        } else {
          io.stdout(JSON.stringify(baseline, null, 2));
        }
        return 0;
      }
      case 'validate': {
        const contract = defineContract(await readJson<Contract>(need(positionals, 0, 'contract file')));
        const rows = await readRows(need(positionals, 1, 'data file'));
        const now = text(flags, 'now');
        const report = validate(contract, rows, {
          now: now ? new Date(now) : undefined,
          maxIssues: number(flags, 'max-issues'),
          coerce: flags.strict !== true,
        });
        emit(report, () => validationToMarkdown(report, { maxIssues: number(flags, 'show') }));
        return report.ok || !fail ? 0 : 1;
      }
      case 'infer': {
        const rows = await readRows(need(positionals, 0, 'data file'));
        const name = text(flags, 'name');
        if (!name) throw new UsageError('--name is required');
        const contract = inferContract(rows, { name, enumMaxDistinct: number(flags, 'enum-max'), margin: number(flags, 'margin') });
        const out = text(flags, 'out');
        if (out) {
          await writeJson(out, contract);
          io.stdout(`contract "${name}" with ${Object.keys(contract.columns).length} columns written to ${out}`);
        } else if (asJson) {
          io.stdout(JSON.stringify(contract, null, 2));
        } else {
          io.stdout(contractToMarkdown(contract));
        }
        return 0;
      }
      case 'profile': {
        const rows = await readRows(need(positionals, 0, 'data file'));
        const report = profile(rows, { columns: list(flags, 'columns'), bins: number(flags, 'bins') });
        emit(report, () => profileToMarkdown(report));
        return 0;
      }
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`leakcheck: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    io.stderr(`leakcheck: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

function defaultIO(): CliIO {
  return {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  };
}

function isMain(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    // npm installs the bin as a symlink; compare against the resolved path.
    return import.meta.url === pathToFileURL(realpathSync(script)).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`leakcheck: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    },
  );
}
