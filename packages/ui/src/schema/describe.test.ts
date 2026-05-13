import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseZodDescription } from './describe';

describe('parseZodDescription', () => {
  it('returns empty object when no description present', () => {
    expect(parseZodDescription(z.string())).toEqual({});
  });

  it('returns label for plain-string describe()', () => {
    expect(parseZodDescription(z.string().describe('Nome do cliente'))).toEqual({
      label: 'Nome do cliente',
    });
  });

  it('parses JSON describe() into structured fields', () => {
    const parsed = parseZodDescription(
      z
        .string()
        .describe('{"label":"Cliente","kind":"reference","collection":"clientes"}'),
    );
    expect(parsed).toEqual({
      label: 'Cliente',
      kind: 'reference',
      collection: 'clientes',
    });
  });

  it('falls back to label when JSON parse fails on a curly-starting string', () => {
    const parsed = parseZodDescription(z.string().describe('{not json'));
    expect(parsed).toEqual({ label: '{not json' });
  });
});
