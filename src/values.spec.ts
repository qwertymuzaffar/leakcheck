import { formatDuration, parseDuration } from './duration';
import { columnNames, inferType, isMissing, matchesType, toBoolean, toDate, toKey, toNumber } from './values';

describe('value coercion', () => {
  it('recognises missing values', () => {
    expect([null, undefined, NaN, '', '  '].every(isMissing)).toBe(true);
    expect([0, false, 'a', [], {}].some(isMissing)).toBe(false);
  });

  it('parses numbers, dates and booleans leniently but not sloppily', () => {
    expect(toNumber('12.5')).toBe(12.5);
    expect(toNumber(' 1e3 ')).toBe(1000);
    expect(toNumber('12px')).toBeNull();
    expect(toNumber(Infinity)).toBeNull();
    expect(toNumber(10n)).toBe(10);
    expect(toDate('2024-05-01')?.toISOString()).toBe('2024-05-01T00:00:00.000Z');
    expect(toDate(new Date(0))?.getTime()).toBe(0);
    expect(toDate(86_400_000)?.toISOString()).toBe('1970-01-02T00:00:00.000Z');
    expect(toDate('2024')).toBeNull();
    expect(toDate('not a date')).toBeNull();
    expect(toDate(new Date('x'))).toBeNull();
    expect(toBoolean('Yes')).toBe(true);
    expect(toBoolean('0')).toBe(false);
    expect(toBoolean(1)).toBe(true);
    expect(toBoolean('maybe')).toBeNull();
    expect(toKey(new Date(0))).toBe('1970-01-01T00:00:00.000Z');
    expect(toKey({ a: 1 })).toBe('{"a":1}');
    expect(toKey(3)).toBe('3');
  });

  it('matches types', () => {
    expect(matchesType('3', 'number')).toBe(true);
    expect(matchesType('3.5', 'integer')).toBe(false);
    expect(matchesType(true, 'boolean')).toBe(true);
    expect(matchesType('2024-01-01', 'date')).toBe(true);
    expect(matchesType(3, 'string')).toBe(false);
    expect(matchesType({}, 'any')).toBe(true);
  });

  it('infers the narrowest column type', () => {
    expect(inferType([1, 2, null, 3])).toBe('integer');
    expect(inferType([1, 2.5, '3'])).toBe('number');
    expect(inferType([true, 'false', null])).toBe('boolean');
    expect(inferType(['2024-01-01', new Date()])).toBe('date');
    expect(inferType(['a', 'b'])).toBe('string');
    expect(inferType(['a', 1])).toBe('any');
    expect(inferType([null, ''])).toBe('any');
    expect(inferType([{ x: 1 }])).toBe('any');
  });

  it('lists columns in first-seen order', () => {
    expect(columnNames([{ b: 1 }, { a: 1, b: 2 }, { c: 3 }])).toEqual(['b', 'a', 'c']);
  });
});

describe('durations', () => {
  it('parses and formats', () => {
    expect(parseDuration('2d')).toBe(2 * 86_400_000);
    expect(parseDuration('1h 30m')).toBe(5_400_000);
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('1.5h')).toBe(5_400_000);
    expect(parseDuration(1234)).toBe(1234);
    expect(() => parseDuration('soon')).toThrow(/invalid duration/);
    expect(() => parseDuration('2 days')).toThrow(/invalid duration/);
    expect(() => parseDuration(-1)).toThrow();
    expect(formatDuration(2 * 86_400_000 + 3 * 3_600_000 + 5000)).toBe('2d 3h');
    expect(formatDuration(45 * 60_000)).toBe('45m');
    expect(formatDuration(800)).toBe('800ms');
    expect(formatDuration(NaN)).toBe('');
  });
});
