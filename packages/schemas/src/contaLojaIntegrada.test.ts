import { describe, expect, it } from 'vitest';
import {
  CODIGO_ERRO_LI,
  LIMIAR_AVISO_TOKEN_LI_DIAS,
  MAX_TOKEN_LI,
  SITUACAO_VALIDADE_TOKEN_LI,
  VALIDADE_TOKEN_LI_MAX_DIAS,
  corpoRenovarValidadeLiSchema,
  corpoSalvarCredencialLiSchema,
  diasParaExpirarLi,
  erroContaLojaIntegradaSchema,
  janelaDeValidadeTokenLi,
  respostaCredencialLojaIntegradaSchema,
  respostaRemocaoCredencialLiSchema,
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

describe('janelaDeValidadeTokenLi', () => {
  it('today (São Paulo) to today + 120 days, both civil dates', () => {
    expect(janelaDeValidadeTokenLi(MEIO_DIA_SP)).toEqual({
      desde: '2026-10-08',
      ate: '2027-02-05',
    });
  });

  it('near-miss: 23:30 in São Paulo is already tomorrow in UTC, and today is still São Paulo’s', () => {
    // 2026-10-09T02:30Z — the 9th in UTC, still the 8th in São Paulo.
    const tardeSp = Date.UTC(2026, 9, 9, 2, 30, 0);
    expect(new Date(tardeSp).toISOString().slice(0, 10)).toBe('2026-10-09');
    expect(janelaDeValidadeTokenLi(tardeSp).desde).toBe('2026-10-08');
    // One hour later São Paulo reaches midnight, and the window moves.
    expect(janelaDeValidadeTokenLi(tardeSp + 60 * 60 * 1000).desde).toBe('2026-10-09');
  });

  it('crosses a leap day by the calendar', () => {
    // 2027-11-01 + 120 days = 2028-02-29.
    const r = janelaDeValidadeTokenLi(Date.UTC(2027, 10, 1, 15, 0, 0));
    expect(r).toEqual({ desde: '2027-11-01', ate: '2028-02-29' });
  });
});

describe('corpoSalvarCredencialLiSchema', () => {
  const corpo = { token: 'abc', expiraEm: '2026-12-31', versaoEsperada: null };

  it('trims the token at both ends — and only there', () => {
    expect(corpoSalvarCredencialLiSchema.parse({ ...corpo, token: '  abc\n' }).token).toBe('abc');
    // Near-miss: an inner space is kept; the package refuses it as malformed.
    expect(corpoSalvarCredencialLiSchema.parse({ ...corpo, token: 'a bc' }).token).toBe('a bc');
  });

  it('refuses an empty or blank token, and one past MAX_TOKEN_LI', () => {
    expect(corpoSalvarCredencialLiSchema.safeParse({ ...corpo, token: '' }).success).toBe(false);
    expect(corpoSalvarCredencialLiSchema.safeParse({ ...corpo, token: ' \n\t' }).success).toBe(
      false,
    );
    expect(
      corpoSalvarCredencialLiSchema.safeParse({ ...corpo, token: 'x'.repeat(MAX_TOKEN_LI) })
        .success,
    ).toBe(true);
    expect(
      corpoSalvarCredencialLiSchema.safeParse({ ...corpo, token: 'x'.repeat(MAX_TOKEN_LI + 1) })
        .success,
    ).toBe(false);
  });

  it('versaoEsperada: null or a non-negative integer; never negative, fractional or absent', () => {
    expect(corpoSalvarCredencialLiSchema.safeParse(corpo).success).toBe(true);
    expect(
      corpoSalvarCredencialLiSchema.safeParse({ ...corpo, versaoEsperada: 1_790_000_000_123_456 })
        .success,
    ).toBe(true);
    for (const v of [-1, 1.5, '1', undefined]) {
      expect(
        corpoSalvarCredencialLiSchema.safeParse({ ...corpo, versaoEsperada: v }).success,
        String(v),
      ).toBe(false);
    }
  });

  it('is strict, and leaves the date to the route (any string passes here)', () => {
    expect(corpoSalvarCredencialLiSchema.safeParse({ ...corpo, extra: 1 }).success).toBe(false);
    expect(corpoSalvarCredencialLiSchema.safeParse({ ...corpo, expiraEm: '31/12' }).success).toBe(
      true,
    );
  });
});

describe('corpoRenovarValidadeLiSchema', () => {
  it('requires a version — there is always a stored token to renew', () => {
    expect(
      corpoRenovarValidadeLiSchema.safeParse({ expiraEm: '2026-12-31', versaoEsperada: 7 }).success,
    ).toBe(true);
    expect(
      corpoRenovarValidadeLiSchema.safeParse({ expiraEm: '2026-12-31', versaoEsperada: null })
        .success,
    ).toBe(false);
  });

  it('is strict: a token in a renewal body is refused, never ignored', () => {
    expect(
      corpoRenovarValidadeLiSchema.safeParse({
        expiraEm: '2026-12-31',
        versaoEsperada: 7,
        token: 'abc',
      }).success,
    ).toBe(false);
  });
});

describe('the other answers', () => {
  it('the removal answer is exactly { ok: true }', () => {
    expect(respostaRemocaoCredencialLiSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(respostaRemocaoCredencialLiSchema.safeParse({ ok: false }).success).toBe(false);
  });

  it('the error envelope parses the bare and the validation shapes, and an unknown code', () => {
    expect(erroContaLojaIntegradaSchema.parse({ error: 'x', code: 'LI_X' })).toEqual({
      error: 'x',
      code: 'LI_X',
    });
    expect(
      erroContaLojaIntegradaSchema.parse({
        error: 'recusado',
        code: CODIGO_ERRO_LI.tokenRecusado,
        status: 401,
        correlationId: 'c-1',
      }),
    ).toMatchObject({ status: 401, correlationId: 'c-1' });
    expect(
      erroContaLojaIntegradaSchema.parse({
        error: 'x',
        code: CODIGO_ERRO_LI.corpoInvalido,
        issues: ['token'],
      }).issues,
    ).toEqual(['token']);
    expect(erroContaLojaIntegradaSchema.safeParse({ error: 'x' }).success).toBe(false);
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
    expect(barrel.janelaDeValidadeTokenLi).toBe(janelaDeValidadeTokenLi);
    expect(barrel.corpoSalvarCredencialLiSchema).toBe(corpoSalvarCredencialLiSchema);
    expect(barrel.corpoRenovarValidadeLiSchema).toBe(corpoRenovarValidadeLiSchema);
    expect(barrel.erroContaLojaIntegradaSchema).toBe(erroContaLojaIntegradaSchema);
    expect(barrel.respostaRemocaoCredencialLiSchema).toBe(respostaRemocaoCredencialLiSchema);
    expect(Object.keys(barrel).some((k) => /^contaLojaIntegrada(Meta)?$/.test(k))).toBe(false);
  });
});
