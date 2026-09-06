const UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Milliseconds for a duration given as a number (already milliseconds) or a string such as
 * `'30m'`, `'6h'`, `'2d'`, `'1w'`, `'500ms'` or `'1h 30m'`.
 */
export function parseDuration(input: number | string): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw new Error(`invalid duration ${input}`);
    return input;
  }
  const text = input.replace(/\s+/g, '').toLowerCase();
  const matches = Array.from(text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d|w)/g));
  const consumed = matches.reduce((length, match) => length + match[0].length, 0);
  if (matches.length === 0 || consumed !== text.length) throw new Error(`invalid duration "${input}"`);
  return matches.reduce((total, match) => total + Number(match[1]) * UNITS[match[2]!]!, 0);
}

/** A short human form of a duration in milliseconds, e.g. `2d 3h`, `45m`, `12s`, `800ms`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const parts: string[] = [];
  let rest = Math.round(Math.abs(ms));
  for (const unit of ['d', 'h', 'm', 's'] as const) {
    const size = UNITS[unit]!;
    if (rest >= size) {
      parts.push(`${Math.floor(rest / size)}${unit}`);
      rest %= size;
    }
    if (parts.length === 2) break;
  }
  return parts.length ? parts.join(' ') : `${rest}ms`;
}
