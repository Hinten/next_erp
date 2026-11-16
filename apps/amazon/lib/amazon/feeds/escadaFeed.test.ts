/**
 * The feed's poll ladder (step 12a, PR 12-b): the delays, the deadline and the
 * abandonment, measured from antesDoEnvioMs.
 */
import { describe, expect, it } from 'vitest';

import {
  CONSULTA_HORARIA_FEED_S,
  ESCADA_CONSULTA_FEED_S,
  TIPO_CONSULTA_FEED,
  proximaConsultaFeed,
} from './escadaFeed';

const ANTES = 1_800_000_000_000;
const HORA = 3_600_000;

describe('the ladder', () => {
  it('120, 300, 600, 900, 1800, 1800 s, then hourly', () => {
    expect(ESCADA_CONSULTA_FEED_S).toEqual([120, 300, 600, 900, 1800, 1800]);
    expect(CONSULTA_HORARIA_FEED_S).toBe(3600);
    // The index is the SCHEDULED rung's: rung 0 (after the submission) waits 120 s.
    const atrasos = [0, 1, 2, 3, 4, 5, 6, 7, 30].map((rodadaAgendada) =>
      proximaConsultaFeed(rodadaAgendada, ANTES + 60_000, ANTES),
    );
    expect(atrasos).toEqual([
      { tipo: TIPO_CONSULTA_FEED.consultar, atrasoS: 120 },
      { tipo: TIPO_CONSULTA_FEED.consultar, atrasoS: 300 },
      { tipo: TIPO_CONSULTA_FEED.consultar, atrasoS: 600 },
      { tipo: TIPO_CONSULTA_FEED.consultar, atrasoS: 900 },
      { tipo: TIPO_CONSULTA_FEED.consultar, atrasoS: 1800 },
      { tipo: TIPO_CONSULTA_FEED.consultar, atrasoS: 1800 },
      { tipo: TIPO_CONSULTA_FEED.consultar, atrasoS: 3600 },
      { tipo: TIPO_CONSULTA_FEED.consultar, atrasoS: 3600 },
      { tipo: TIPO_CONSULTA_FEED.consultar, atrasoS: 3600 },
    ]);
  });

  it('rung 3 runs 1,920 s after the submission (the first rung past 30 min)', () => {
    const acumulado = ESCADA_CONSULTA_FEED_S.slice(0, 4).reduce((a, b) => a + b, 0);
    expect(acumulado).toBe(1920);
    expect(ESCADA_CONSULTA_FEED_S.slice(0, 3).reduce((a, b) => a + b, 0)).toBeLessThan(1800);
  });
});

describe('★ the deadline and the abandonment, measured from antesDoEnvioMs', () => {
  it('prazo at 12 h, hourly from then on; abandonar at 48 h (both boundaries inclusive)', () => {
    expect(proximaConsultaFeed(10, ANTES + 12 * HORA - 1, ANTES).tipo).toBe(
      TIPO_CONSULTA_FEED.consultar,
    );
    expect(proximaConsultaFeed(10, ANTES + 12 * HORA, ANTES)).toEqual({
      tipo: TIPO_CONSULTA_FEED.prazo,
      atrasoS: CONSULTA_HORARIA_FEED_S,
    });
    // A rung still early on the ladder past the deadline: hourly, not its ladder delay.
    expect(proximaConsultaFeed(1, ANTES + 12 * HORA, ANTES)).toEqual({
      tipo: TIPO_CONSULTA_FEED.prazo,
      atrasoS: CONSULTA_HORARIA_FEED_S,
    });
    expect(proximaConsultaFeed(40, ANTES + 48 * HORA - 1, ANTES).tipo).toBe(
      TIPO_CONSULTA_FEED.prazo,
    );
    expect(proximaConsultaFeed(40, ANTES + 48 * HORA, ANTES)).toEqual({
      tipo: TIPO_CONSULTA_FEED.abandonar,
    });
  });

  it('the clock is the CALLER’s to pass: handed antesDoEnvioMs it answers prazo, handed the record’s later criadoEmMs it would not (the result handler must read antesDoEnvioMs)', () => {
    // The record is created after createFeed answers: 9 s later here.
    const criadoEmMs = ANTES + 9_000;
    const agora = ANTES + 12 * HORA + 1_000;
    // Measured from criadoEmMs this would still be before the deadline.
    expect(agora < criadoEmMs + 12 * HORA).toBe(true);
    expect(proximaConsultaFeed(10, agora, ANTES).tipo).toBe(TIPO_CONSULTA_FEED.prazo);
    expect(proximaConsultaFeed(10, agora, criadoEmMs).tipo).toBe(TIPO_CONSULTA_FEED.consultar);

    const agoraAbandono = ANTES + 48 * HORA + 1_000;
    expect(agoraAbandono < criadoEmMs + 48 * HORA).toBe(true);
    expect(proximaConsultaFeed(50, agoraAbandono, ANTES).tipo).toBe(TIPO_CONSULTA_FEED.abandonar);
  });

  it('a negative or fractional rung, or a clock that is not a ms instant, is a programming error', () => {
    expect(() => proximaConsultaFeed(-1, ANTES, ANTES)).toThrow(RangeError);
    expect(() => proximaConsultaFeed(1.5, ANTES, ANTES)).toThrow(RangeError);
    expect(() => proximaConsultaFeed(1, Number.NaN, ANTES)).toThrow(RangeError);
    expect(() => proximaConsultaFeed(1, ANTES, -1)).toThrow(RangeError);
  });
});
