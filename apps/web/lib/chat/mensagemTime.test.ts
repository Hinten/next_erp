import { describe, expect, it } from 'vitest';
import { formatMensagemTime, formatVisualizado } from './mensagemTime';

const NOW = Date.parse('2026-07-16T12:00:00.000Z');

describe('formatMensagemTime', () => {
  it('returns empty string for a missing timestamp', () => {
    expect(formatMensagemTime(null, NOW)).toBe('');
    expect(formatMensagemTime(undefined, NOW)).toBe('');
  });

  it('shows HH:mm within one day', () => {
    const ts = Date.parse('2026-07-16T09:30:00.000Z');
    const out = formatMensagemTime(ts, NOW);
    // HH:mm only — no parenthesised date.
    expect(out).not.toContain('(');
    expect(out).toMatch(/\d{2}:\d{2}/);
  });

  it('adds (dd/MM) when older than a day but within a year', () => {
    const ts = Date.parse('2026-05-01T09:30:00.000Z');
    const out = formatMensagemTime(ts, NOW);
    expect(out).toContain('(');
    // dd/MM without a year segment (no second slash inside the parens).
    const inParens = out.slice(out.indexOf('(') + 1, out.indexOf(')'));
    expect(inParens.split('/')).toHaveLength(2);
  });

  it('adds (dd/MM/yyyy) when older than a year', () => {
    const ts = Date.parse('2024-01-01T09:30:00.000Z');
    const out = formatMensagemTime(ts, NOW);
    const inParens = out.slice(out.indexOf('(') + 1, out.indexOf(')'));
    expect(inParens.split('/')).toHaveLength(3);
    expect(inParens).toContain('2024');
  });

  it('uses absolute difference (future timestamps within a day are still HH:mm)', () => {
    const ts = Date.parse('2026-07-16T18:00:00.000Z');
    expect(formatMensagemTime(ts, NOW)).not.toContain('(');
  });
});

describe('formatVisualizado', () => {
  it('always renders the full dd/MM/yyyy form with the Visualizado prefix', () => {
    const out = formatVisualizado(Date.parse('2026-07-16T09:30:00.000Z'));
    expect(out.startsWith('Visualizado: ')).toBe(true);
    const inParens = out.slice(out.indexOf('(') + 1, out.indexOf(')'));
    expect(inParens.split('/')).toHaveLength(3);
  });
});
