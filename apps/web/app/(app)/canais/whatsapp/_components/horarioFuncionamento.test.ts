import { describe, expect, it } from 'vitest';
import type { PeriodoWhatsapp } from '@delfrance/schemas';
import { applyWeekdayEdit, hhmmToMs, msToHHMM } from './horarioFuncionamento';

describe('applyWeekdayEdit', () => {
  it('edits a weekday of period[0] and keeps every extra período byte-identical', () => {
    const period0: PeriodoWhatsapp = { segunda: { abertura: 1, fechamento: 2 } };
    // A distinct second período the editor never surfaces — it must survive.
    const period1: PeriodoWhatsapp = {
      quarta: { abertura: 100, fechamento: 200 },
      sexta: { abertura: 300, fechamento: 400 },
    };
    const periods = [period0, period1];

    const next = applyWeekdayEdit(periods, 'terca', { abertura: 5, fechamento: 6 });

    expect(next).not.toBeNull();
    expect(next).toHaveLength(2);
    // period[0] got the edit applied on top of its existing days.
    expect(next?.[0]).toEqual({
      segunda: { abertura: 1, fechamento: 2 },
      terca: { abertura: 5, fechamento: 6 },
    });
    // period[1] is preserved verbatim — same reference, byte-identical.
    expect(next?.[1]).toBe(period1);
    expect(next?.[1]).toEqual(period1);
  });

  it('turning a weekday off preserves extra períodos instead of wiping to null', () => {
    const period0: PeriodoWhatsapp = { segunda: { abertura: 1, fechamento: 2 } };
    const period1: PeriodoWhatsapp = { domingo: { abertura: 9, fechamento: 9 } };
    const next = applyWeekdayEdit([period0, period1], 'segunda', null);
    // period[0] is now empty, but the extra período must NOT be lost.
    expect(next).toEqual([{ segunda: null }, period1]);
    expect(next?.[1]).toBe(period1);
  });

  it('collapses to null only when the sole período becomes fully empty', () => {
    const period0: PeriodoWhatsapp = { segunda: { abertura: 1, fechamento: 2 } };
    expect(applyWeekdayEdit([period0], 'segunda', null)).toBeNull();
  });

  it('starts a first período from an empty value', () => {
    const next = applyWeekdayEdit([], 'quarta', { abertura: 10, fechamento: 20 });
    expect(next).toEqual([{ quarta: { abertura: 10, fechamento: 20 } }]);
  });
});

describe('msToHHMM / hhmmToMs', () => {
  it('round-trips a HH:MM string through the wire codec and back', () => {
    for (const hhmm of ['00:00', '08:00', '09:05', '18:30', '23:59']) {
      expect(msToHHMM(hhmmToMs(hhmm))).toBe(hhmm);
    }
  });

  it('renders a blank string for a null/absent value', () => {
    expect(msToHHMM(null)).toBe('');
    expect(msToHHMM(undefined)).toBe('');
    expect(msToHHMM(Number.NaN)).toBe('');
  });

  it('rejects a malformed time string', () => {
    expect(hhmmToMs('24:00')).toBeNull();
    expect(hhmmToMs('9:5')).toBeNull();
    expect(hhmmToMs('')).toBeNull();
  });
});
