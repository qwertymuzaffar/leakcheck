import { parseCsv, parseNdjson, splitCsv, toCsv } from './csv';

describe('parseCsv', () => {
  it('handles quotes, doubled quotes, embedded newlines, CRLF and a byte-order mark', () => {
    const text = '﻿id,name,note\r\n1,"Smith, John","said ""hi""\nthen left"\r\n2,Ann,\r\n';
    expect(parseCsv(text)).toEqual([
      { id: '1', name: 'Smith, John', note: 'said "hi"\nthen left' },
      { id: '2', name: 'Ann', note: '' },
    ]);
  });

  it('detects semicolon, tab and pipe delimiters', () => {
    expect(parseCsv('a;b\n1;2')).toEqual([{ a: '1', b: '2' }]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([{ a: '1', b: '2' }]);
    expect(parseCsv('a|b\n1|2')).toEqual([{ a: '1', b: '2' }]);
    expect(parseCsv('"a,b";c\n1;2')).toEqual([{ 'a,b': '1', c: '2' }]);
  });

  it('supports headerless files, short records, value inference and trimming', () => {
    expect(parseCsv('1,2\n3', { header: false })).toEqual([
      { c0: '1', c1: '2' },
      { c0: '3', c1: '' },
    ]);
    expect(parseCsv('n,ok,s, spaced \n 12.5 ,true, x , y ', { infer: true })).toEqual([{ n: 12.5, ok: true, s: 'x', spaced: 'y' }]);
    expect(parseCsv('a,b\n" x ",y', { trim: false })).toEqual([{ a: ' x ', b: 'y' }]);
    expect(parseCsv('a,,c\n1,2,3')).toEqual([{ a: '1', c1: '2', c: '3' }]);
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('a,b\n')).toEqual([]);
    expect(splitCsv('a,b\n\n1,2\n', ',')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('round-trips through toCsv', () => {
    const rows = [
      { id: 1, name: 'Smith, John', when: new Date(0), note: 'a "quoted"\nline' },
      { id: 2, name: null, when: undefined, note: '' },
    ];
    const text = toCsv(rows);
    expect(text.split('\n')[0]).toBe('id,name,when,note');
    expect(parseCsv(text)).toEqual([
      { id: '1', name: 'Smith, John', when: '1970-01-01T00:00:00.000Z', note: 'a "quoted"\nline' },
      { id: '2', name: '', when: '', note: '' },
    ]);
    expect(toCsv(rows, ['name'], ';')).toBe('name\nSmith, John\n');
    expect(toCsv(rows, ['name'])).toBe('name\n"Smith, John"\n');
  });

  it('parses NDJSON and rejects non-objects', () => {
    expect(parseNdjson('{"a":1}\n\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(() => parseNdjson('[1]')).toThrow(/JSON object/);
    expect(() => parseNdjson('{')).toThrow();
  });
});
