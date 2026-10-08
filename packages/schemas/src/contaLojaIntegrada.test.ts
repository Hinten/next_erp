import { describe, expect, it } from 'vitest';
import {
  CODIGO_ERRO_LI,
  LIMIAR_AVISO_TOKEN_LI_DIAS,
  SITUACAO_VALIDADE_TOKEN_LI,
  VALIDADE_TOKEN_LI_MAX_DIAS,
  diasParaExpirarLi,
  respostaCredencialLojaIntegradaSchema,
  situacaoValidadeTokenLi,
  statusContaLojaIntegradaSchema,
} from './contaLojaIntegrada';
import * as barrel from './index';

const HORA_MS = 60 * 60 * 1000;
const DIA_MS = 24 * HORA_MS;

/** 2026-10-08T15:00:00Z — noon in São Paulo (UTC−3). */
const MEIO_DIA_SP = Date.UTC(2026, 9, 8, 15, 0, 0);
/** 23:59:59 São Paulo on the SAME civil day. */
const FIM_DO_DIA_SP = Date.UTC(2026, 9, 9, 2, 59, 59);

describe('diasParaExpirarLi', () => {
  it('floors: 23:59:59 at noon on the same day is 0 days, never 1', () => {
    expect(diasParaExpirarLi(FIM_DO_DIA_SP, MEIO_DIA_SP)).toBe(0);
  });

  it('counts whole days, and goes negative past the expiry', () => {
    expect(diasParaExpirarLi(FIM_DO_DIA_SP + 30 * DIA_MS, MEIO_DIA_SP)).toBe(30);
    expect(diasParaExpirarLi(FIM_DO_DIA_SP + 31 * DIA_MS, MEIO_DIA_SP)).toBe(31);
    // One second past the expiry is already the first negative day.
    expect(diasParaExpirarLi(FIM_DO_DIA_SP, FIM_DO_DIA_SP + 1000)).toBe(-1);
  });

  it('near-miss: Math.round would read 12h left as 1 day', () => {
    expect(diasParaExpirarLi(MEIO_DIA_SP + 12 * HORA_MS, MEIO_DIA_SP)).toBe(0);
    expect(diasParaExpirarLi(MEIO_DIA_SP + 23 * HORA_MS, MEIO_DIA_SP)).toBe(0);
  });
});

describe('situacaoValidadeTokenLi', () => {
  it('31 → ok, 30 → expirando, 0 → expirando, −1 → vencido', () => {
    expect(situacaoValidadeTokenLi(31)).toBe(SITUACAO_VALIDADE_TOKEN_LI.ok);
    expect(situacaoValidadeTokenLi(30)).toBe(SITUACAO_VALIDADE_TOKEN_LI.expirando);
    expect(situacaoValidadeTokenLi(0)).toBe(SITUACAO_VALIDADE_TOKEN_LI.expirando);
    expect(situacaoValidadeTokenLi(-1)).toBe(SITUACAO_VALIDADE_TOKEN_LI.vencido);
  });

  it('pins the two constants the routes and the panel share', () => {
    expect(LIMIAR_AVISO_TOKEN_LI_DIAS).toBe(30);
    expect(VALIDADE_TOKEN_LI_MAX_DIAS).toBe(120);
  });
});

const STATUS = {
  configurado: true,
  expiraEm: '2026-12-31',
  diasParaExpirar: 84,
  situacaoValidade: 'ok',
  atualizadoEmMs: 1_790_000_000_000,
  versaoCredencialUs: 1_790_000_000_123_456,
  reconexaoPendente: null,
};

describe('statusContaLojaIntegradaSchema', () => {
  it('parses the configured shape and the all-null "não configurado" shape', () => {
    expect(statusContaLojaIntegradaSchema.parse(STATUS)).toEqual(STATUS);
    const vazio = {
      configurado: false,
      expiraEm: null,
      diasParaExpirar: null,
      situacaoValidade: null,
      atualizadoEmMs: null,
      versaoCredencialUs: null,
      reconexaoPendente: null,
    };
    expect(statusContaLojaIntegradaSchema.parse(vazio)).toEqual(vazio);
  });

  it('tolerates an unknown key (a later field is additive) and strips it', () => {
    const r = statusContaLojaIntegradaSchema.safeParse({ ...STATUS, campoFuturo: 1 });
    expect(r.success).toBe(true);
    expect(r.success && 'campoFuturo' in r.data).toBe(false);
  });

  it('refuses a non-civil date and a status other than 401/403', () => {
    expect(
      statusContaLojaIntegradaSchema.safeParse({ ...STATUS, expiraEm: '31/12/2026' }).success,
    ).toBe(false);
    expect(
      statusContaLojaIntegradaSchema.safeParse({
        ...STATUS,
        reconexaoPendente: { desdeMs: 1, status: 400 },
      }).success,
    ).toBe(false);
  });

  it('never carries the ref of a parked credential: the field is stripped', () => {
    const r = statusContaLojaIntegradaSchema.parse({
      ...STATUS,
      reconexaoPendente: { desdeMs: 1, status: 401, refCredencial: 'x' },
    });
    expect(r.reconexaoPendente).toEqual({ desdeMs: 1, status: 401 });
  });

  it('the write answer adds reconexaoResolvida and requires it', () => {
    expect(
      respostaCredencialLojaIntegradaSchema.parse({ ...STATUS, reconexaoResolvida: true })
        .reconexaoResolvida,
    ).toBe(true);
    expect(respostaCredencialLojaIntegradaSchema.safeParse(STATUS).success).toBe(false);
  });
});

describe('CODIGO_ERRO_LI', () => {
  it('every code is unique and LI_-prefixed', () => {
    const codigos = Object.values(CODIGO_ERRO_LI);
    expect(new Set(codigos).size).toBe(codigos.length);
    for (const c of codigos) expect(c).toMatch(/^LI_[A-Z_]+$/);
  });
});

describe('barrel', () => {
  it('exports the contract, and no collection meta for it', () => {
    expect(barrel.statusContaLojaIntegradaSchema).toBe(statusContaLojaIntegradaSchema);
    expect(barrel.diasParaExpirarLi).toBe(diasParaExpirarLi);
    expect(Object.keys(barrel).some((k) => /^contaLojaIntegrada(Meta)?$/.test(k))).toBe(false);
  });
});
