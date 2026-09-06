import type { Contract, ValidationReport } from './contract';
import type { DriftReport } from './drift';
import type { LeakageReport, OverlapReport } from './leakage';
import { formatDuration } from './duration';
import type { DatasetProfile } from './types';

function fmt(n: number | null | undefined, digits = 4): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  return Number(n.toPrecision(digits)).toString();
}

function pct(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`;
  return [line(header), `|${header.map(() => ' --- ').join('|')}|`, ...rows.map(line)].join('\n');
}

/** A Markdown summary of a validation report: verdict, counts per issue code, columns and the first issues. */
export function validationToMarkdown(report: ValidationReport, options: { maxIssues?: number } = {}): string {
  const lines = [`## ${report.contract}: ${report.ok ? 'valid' : 'invalid'}`, '', `${report.rows} rows`];
  if (report.freshness) {
    const f = report.freshness;
    lines.push(
      f.latest
        ? `Freshness: newest ${f.column} is ${formatDuration(f.ageMs ?? 0)} old (limit ${formatDuration(f.maxAgeMs)}), ${f.ok ? 'ok' : 'stale'}`
        : `Freshness: ${f.column} has no valid dates`,
    );
  }
  if (report.duplicateKeys) lines.push(`Duplicate keys: ${report.duplicateKeys}`);
  if (report.extraColumns.length) lines.push(`Extra columns: ${report.extraColumns.join(', ')}`);
  const codes = Object.entries(report.issueCounts);
  if (codes.length) {
    lines.push('', '### Issues', '', table(['Code', 'Count'], codes.map(([code, count]) => [code, String(count)])));
  }
  lines.push(
    '',
    '### Columns',
    '',
    table(
      ['Column', 'Present', 'Values', 'Missing', 'Invalid rows'],
      Object.entries(report.columns).map(([name, c]) => [name, c.present ? 'yes' : 'no', String(c.count), String(c.missing), String(c.invalid)]),
    ),
  );
  const shown = report.issues.slice(0, options.maxIssues ?? 20);
  if (shown.length) {
    lines.push('', '### First issues', '', ...shown.map((issue) => `- ${issue.severity === 'warning' ? 'warning' : 'error'} ${issue.code}${issue.row !== undefined ? ` (row ${issue.row})` : ''}: ${issue.message}`));
    const rest = report.issues.length - shown.length + report.truncated;
    if (rest > 0) lines.push(`- ... and ${rest} more`);
  }
  return lines.join('\n');
}

/** A Markdown summary of a drift report: verdict, one row per column, and bin tables for drifted columns. */
export function driftToMarkdown(report: DriftReport, options: { bins?: boolean } = {}): string {
  const lines = [
    `## Drift: ${report.ok ? 'stable' : `${report.drifted.length} column${report.drifted.length === 1 ? '' : 's'} drifted`}`,
    '',
    `Reference ${report.reference.rows} rows, current ${report.current.rows} rows. Thresholds: PSI ${fmt(report.thresholds.psi)}, p-value ${fmt(report.thresholds.pValue)}, missing rate ${fmt(report.thresholds.missingRate)}.`,
    '',
    table(
      ['Column', 'Kind', 'PSI', 'JS', 'Test p', 'Missing ref -> cur', 'Verdict'],
      Object.values(report.columns).map((c) => [
        c.column,
        c.kind,
        c.kind === 'skipped' ? '' : fmt(c.psi, 3),
        c.kind === 'skipped' ? '' : fmt(c.jsDivergence, 3),
        c.ks ? fmt(c.ks.pValue, 3) : c.chiSquare ? fmt(c.chiSquare.pValue, 3) : '',
        c.kind === 'skipped' ? '' : `${pct(c.reference.missingRate)} -> ${pct(c.current.missingRate)}`,
        c.kind === 'skipped' ? `skipped: ${c.reason ?? ''}` : c.drifted ? c.signals.join('; ') : 'ok',
      ]),
    ),
  ];
  if (options.bins !== false) {
    for (const name of report.drifted) {
      const c = report.columns[name]!;
      lines.push('', `### ${name}`, '', table(['Bin', 'Reference', 'Current'], c.bins.map((b) => [b.label, pct(b.reference), pct(b.current)])));
      if (c.referenceStats && c.currentStats) {
        lines.push(
          '',
          table(
            ['', 'Reference', 'Current'],
            [
              ['mean', fmt(c.referenceStats.mean), fmt(c.currentStats.mean)],
              ['std', fmt(c.referenceStats.std), fmt(c.currentStats.std)],
              ['p50', fmt(c.referenceStats.quantiles.p50), fmt(c.currentStats.quantiles.p50)],
              ['min', fmt(c.referenceStats.min), fmt(c.currentStats.min)],
              ['max', fmt(c.referenceStats.max), fmt(c.currentStats.max)],
            ],
          ),
        );
      }
    }
  }
  return lines.join('\n');
}

/** A Markdown table of a dataset profile. */
export function profileToMarkdown(profile: DatasetProfile): string {
  return [
    `## Profile: ${profile.rows} rows, ${Object.keys(profile.columns).length} columns`,
    '',
    table(
      ['Column', 'Type', 'Values', 'Missing', 'Distinct', 'Min', 'p50', 'Max', 'Top values'],
      Object.values(profile.columns).map((c) => [
        c.name,
        c.type,
        String(c.count),
        String(c.missing),
        String(c.distinct),
        c.numeric ? (c.type === 'date' ? new Date(c.numeric.min).toISOString() : fmt(c.numeric.min)) : '',
        c.numeric ? (c.type === 'date' ? new Date(c.numeric.quantiles.p50).toISOString() : fmt(c.numeric.quantiles.p50)) : '',
        c.numeric ? (c.type === 'date' ? new Date(c.numeric.max).toISOString() : fmt(c.numeric.max)) : '',
        c.categories ? c.categories.slice(0, 5).map((cat) => `${cat.value} (${cat.count})`).join(', ') : '',
      ]),
    ),
  ].join('\n');
}

/** A Markdown rendering of a contract, for documentation or review. */
export function contractToMarkdown(contract: Contract): string {
  const lines = [`## Contract: ${contract.name}`, ''];
  if (contract.description) lines.push(contract.description, '');
  if (contract.grain?.length) lines.push(`Grain: ${contract.grain.join(', ')}`);
  if (contract.freshness) lines.push(`Freshness: ${contract.freshness.column} within ${typeof contract.freshness.maxAge === 'number' ? formatDuration(contract.freshness.maxAge) : contract.freshness.maxAge}`);
  if (contract.minRows !== undefined) lines.push(`At least ${contract.minRows} rows`);
  lines.push(`Extra columns: ${contract.extraColumns ?? 'allow'}`, '');
  lines.push(
    table(
      ['Column', 'Type', 'Required', 'Rules'],
      Object.entries(contract.columns).map(([name, spec]) => {
        const rules: string[] = [];
        if (spec.min !== undefined) rules.push(`min ${spec.min instanceof Date ? spec.min.toISOString() : spec.min}`);
        if (spec.max !== undefined) rules.push(`max ${spec.max instanceof Date ? spec.max.toISOString() : spec.max}`);
        if (spec.enum) rules.push(`one of ${spec.enum.map(String).join(', ')}`);
        if (spec.pattern !== undefined) rules.push(`matches ${spec.pattern}`);
        if (spec.minLength !== undefined) rules.push(`length >= ${spec.minLength}`);
        if (spec.maxLength !== undefined) rules.push(`length <= ${spec.maxLength}`);
        if (spec.unique) rules.push('unique');
        if (spec.check) rules.push('custom check');
        return [name, spec.type ?? 'any', spec.required ? 'yes' : 'no', rules.join('; ')];
      }),
    ),
  );
  return lines.join('\n');
}

/** A Markdown summary of a leakage report: verdict and one row per feature. */
export function leakageToMarkdown(report: LeakageReport): string {
  return [
    `## Leakage: ${report.ok ? 'none found' : `${report.flagged.length} feature${report.flagged.length === 1 ? '' : 's'} flagged`}`,
    '',
    `Label "${report.label}" (${report.labelKind}), ${report.rows} rows. Thresholds: association ${fmt(report.thresholds.association)}, label copy ${fmt(report.thresholds.labelCopy)}, future share ${fmt(report.thresholds.future)}.`,
    '',
    table(
      ['Feature', 'Kind', 'Association', 'Label copy', 'Future', 'Verdict'],
      Object.values(report.features).map((f) => [
        f.column,
        f.kind,
        f.association !== undefined ? `${f.measure} ${fmt(f.association, 3)}` : '',
        f.kind === 'skipped' ? '' : pct(f.labelCopyShare),
        f.futureShare !== undefined ? pct(f.futureShare) : '',
        f.kind === 'skipped' ? `skipped: ${f.reason ?? ''}` : f.flagged ? f.signals.join('; ') : 'ok',
      ]),
    ),
  ].join('\n');
}

/** A Markdown summary of a train/test overlap report. */
export function overlapToMarkdown(report: OverlapReport): string {
  const lines = [
    `## Train/test overlap: ${report.ok ? 'none found' : 'found'}`,
    '',
    `Train ${report.train.rows} rows, test ${report.test.rows} rows.`,
    `Duplicate rows in test: ${report.duplicateRows.count} (${pct(report.duplicateRows.share)})`,
  ];
  if (report.keyOverlap) {
    lines.push(`Test rows sharing an entity key with train: ${report.keyOverlap.count} (${pct(report.keyOverlap.share)})`);
    if (report.keyOverlap.keys.length) lines.push('', `First keys: ${report.keyOverlap.keys.join(', ')}`);
  }
  return lines.join('\n');
}
