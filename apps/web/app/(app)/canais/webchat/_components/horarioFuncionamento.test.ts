import { describe, expect, it } from 'vitest';
import type { PeriodoWebchat } from '@delfrance/schemas';
import { applyWeekdayEdit, defaultHorario, fromHHMM, toHHMM } from './horarioFuncionamento';

describe('applyWeekdayEdit', () => {
  it('edits a weekday of period[0] and keeps every extra período byte-identical', () => {
    const period0: PeriodoWebchat = {
      segunda: { aberturaHora: 1, aberturaMinuto: 0, fechamentoHora: 2, fechamentoMinuto: 0 },
    };
    // A distinct second período the editor never surfaces — it must survive.
    const period1: PeriodoWebchat = {
      quarta: { aberturaHora: 10, aberturaMinuto: 0, fechamentoHora: 20, fechamentoMinuto: 0 },
      sexta: { aberturaHora: 3, aberturaMinuto: 0, fechamentoHora: 4, fechamentoMinuto: 0 },
    };
    const periods = [period0, period1];

    const next = applyWeekdayEdit(periods, 'terca', {
      aberturaHora: 5,
      aberturaMinuto: 0,
      fechamentoHora: 6,
      fechamentoMinuto: 0,
    });

    expect(next).not.toBeNull();
    expect(next).toHaveLength(2);
    // period[0] got the edit applied on top of its existing days.
    expect(next?.[0]).toEqual({
      segunda: { aberturaHora: 1, aberturaMinuto: 0, fechamentoHora: 2, fechamentoMinuto: 0 },
      terca: { aberturaHora: 5, aberturaMinuto: 0, fechamentoHora: 6, fechamentoMinuto: 0 },
    });
    // period[1] is preserved verbatim — same reference, byte-identical.
    expect(next?.[1]).toBe(period1);
    expect(next?.[1]).toEqual(period1);
  });

  it('turning a weekday off preserves extra períodos instead of wiping to null', () => {
    const period0: PeriodoWebchat = {
      segunda: { aberturaHora: 1, aberturaMinuto: 0, fechamentoHora: 2, fechamentoMinuto: 0 },
    };
    const period1: PeriodoWebchat = {
      domingo: { aberturaHora: 9, aberturaMinuto: 0, fechamentoHora: 9, fechamentoMinuto: 30 },
    };
    const next = applyWeekdayEdit([period0, period1], 'segunda', null);
    // period[0] is now empty, but the extra período must NOT be lost.
    expect(next).toEqual([{ segunda: null }, period1]);
    expect(next?.[1]).toBe(period1);
  });

  it('collapses to null only when the sole período becomes fully empty', () => {
    const period0: PeriodoWebchat = {
      segunda: { aberturaHora: 1, aberturaMinuto: 0, fechamentoHora: 2, fechamentoMinuto: 0 },
    };
    expect(applyWeekdayEdit([period0], 'segunda', null)).toBeNull();
  });

  it('starts a first período from an empty value', () => {
    const next = applyWeekdayEdit([], 'quarta', {
      aberturaHora: 10,
      aberturaMinuto: 0,
      fechamentoHora: 20,
      fechamentoMinuto: 0,
    });
    expect(next).toEqual([
      { quarta: { aberturaHora: 10, aberturaMinuto: 0, fechamentoHora: 20, fechamentoMinuto: 0 } },
    ]);
  });
});

describe('toHHMM / fromHHMM', () => {
  it('round-trips a HH:MM string', () => {
    for (const hhmm of ['00:00', '08:00', '09:05', '18:30', '23:59']) {
      const parsed = fromHHMM(hhmm);
      expect(parsed).not.toBeNull();
      expect(toHHMM(parsed?.hour, parsed?.minute)).toBe(hhmm);
    }
  });

  it('renders a blank string for a null/absent hour or minute', () => {
    expect(toHHMM(null, null)).toBe('');
    expect(toHHMM(undefined, undefined)).toBe('');
    expect(toHHMM(8, null)).toBe('');
    expect(toHHMM(null, 30)).toBe('');
  });

  it('rejects a malformed time string', () => {
    expect(fromHHMM('24:00')).toBeNull();
    expect(fromHHMM('9:5')).toBeNull();
    expect(fromHHMM('')).toBeNull();
  });
});

describe('defaultHorario', () => {
  it('defaults a freshly toggled-on weekday to 08:00–18:00', () => {
    expect(defaultHorario()).toEqual({
      aberturaHora: 8,
      aberturaMinuto: 0,
      fechamentoHora: 18,
      fechamentoMinuto: 0,
    });
  });
});
