import { describe, expect, it } from 'vitest';
import {
  CHAVE_RETORNO_OAUTH_AMAZON,
  CODIGO_ERRO_AMAZON,
  LIMIAR_AVISO_AMAZON_DIAS,
  MAX_SELLING_PARTNER_ID,
  MOTIVO_RETORNO_OAUTH_AMAZON,
  VALIDADE_AUTORIZACAO_AMAZON_DIAS,
  contaAmazonRoteavel,
  diasAteDataCivilAmazon,
  diasParaReautorizarAmazon,
  erroContaAmazonSchema,
  motivoRetornoOAuthAmazonSchema,
  reautorizarAteAmazon,
  respostaInicioOAuthAmazonSchema,
  sellingPartnerIdValido,
  statusContaAmazonSchema,
} from './contaAmazon';
import * as barrel from './index';
import { INTEGRACAO_TIPO } from './integracao';

/** The sandbox placeholder of Amazon's own models — never a real seller. */
const SPID = 'AXXXXXXXXXXXXX';

/** Noon in São Paulo (UTC−3) on a civil date, as epoch ms. */
function meioDiaSp(ano: number, mes: number, dia: number): number {
  return Date.UTC(ano, mes - 1, dia, 15, 0, 0);
}

/* -------------------------------------------------------------------------- */
/*                               Reauthorization                              */
/* -------------------------------------------------------------------------- */

describe('reautorizarAteAmazon', () => {
  it('is the São Paulo civil day of the authorization plus 365 calendar days', () => {
    expect(reautorizarAteAmazon(meioDiaSp(2026, 10, 15))).toBe('2027-10-15');
  });

  it('crosses a leap year by DAYS — never "the same date next year"', () => {
    // 2027-06-01 + 365 days crosses 2028-02-29 and lands a day EARLIER than the
    // anniversary a `setFullYear(+1)` would compute.
    expect(reautorizarAteAmazon(meioDiaSp(2027, 6, 1))).toBe('2028-05-31');
    expect(reautorizarAteAmazon(meioDiaSp(2027, 3, 1))).toBe('2028-02-29');
    expect(reautorizarAteAmazon(meioDiaSp(2028, 2, 29))).toBe('2029-02-28');
    // Near-miss: a year with no 29 February in the window keeps the anniversary.
    expect(reautorizarAteAmazon(meioDiaSp(2026, 6, 1))).toBe('2027-06-01');
  });

  it('takes the day in São Paulo, not in UTC: 23:30 in São Paulo is already tomorrow in UTC', () => {
    // 2026-10-16T02:30Z — the 16th in UTC, still the 15th in São Paulo.
    const tardeSp = Date.UTC(2026, 9, 16, 2, 30, 0);
    expect(new Date(tardeSp).toISOString().slice(0, 10)).toBe('2026-10-16');
    expect(reautorizarAteAmazon(tardeSp)).toBe('2027-10-15');
    // Half an hour later São Paulo reaches midnight, and the date moves.
    expect(reautorizarAteAmazon(tardeSp + 30 * 60 * 1000)).toBe('2027-10-16');
  });

  it('pins the two constants the sweep and the panel share', () => {
    expect(VALIDADE_AUTORIZACAO_AMAZON_DIAS).toBe(365);
    expect(LIMIAR_AVISO_AMAZON_DIAS).toBe(30);
  });
});

describe('diasParaReautorizarAmazon', () => {
  const autorizadoEm = meioDiaSp(2026, 10, 15); // → reautorizar até 2027-10-15

  it('counts São Paulo civil days: 30 days ahead is 30, the date itself 0, the day after −1', () => {
    expect(diasParaReautorizarAmazon(autorizadoEm, meioDiaSp(2027, 9, 15))).toBe(30);
    expect(diasParaReautorizarAmazon(autorizadoEm, meioDiaSp(2027, 9, 14))).toBe(31);
    expect(diasParaReautorizarAmazon(autorizadoEm, meioDiaSp(2027, 9, 16))).toBe(29);
    expect(diasParaReautorizarAmazon(autorizadoEm, meioDiaSp(2027, 10, 15))).toBe(0);
    expect(diasParaReautorizarAmazon(autorizadoEm, meioDiaSp(2027, 10, 16))).toBe(-1);
    expect(diasParaReautorizarAmazon(autorizadoEm, autorizadoEm)).toBe(365);
  });

  it('counts the 29th of February when the window crosses it', () => {
    // Reauthorize by 2028-05-31; from 2028-02-01 that is 29 + 31 + 30 + 30 days.
    // A leap-blind day counter answers 119 and moves the 30-day threshold.
    expect(diasParaReautorizarAmazon(meioDiaSp(2027, 6, 1), meioDiaSp(2028, 2, 1))).toBe(120);
  });

  it('changes at São Paulo midnight — NOT at UTC midnight (the runner is UTC)', () => {
    // 2027-10-15T00:00Z is 21:00 on the 14th in São Paulo: still one day left,
    // although the UTC date is already the reauthorization date.
    expect(diasParaReautorizarAmazon(autorizadoEm, Date.UTC(2027, 9, 15, 0, 0, 0))).toBe(1);
    // 02:59:59Z is 23:59:59 in São Paulo — still the 14th.
    expect(diasParaReautorizarAmazon(autorizadoEm, Date.UTC(2027, 9, 15, 2, 59, 59))).toBe(1);
    // 03:00Z is São Paulo midnight: the count moves here, and only here.
    expect(diasParaReautorizarAmazon(autorizadoEm, Date.UTC(2027, 9, 15, 3, 0, 0))).toBe(0);
    expect(diasParaReautorizarAmazon(autorizadoEm, Date.UTC(2027, 9, 16, 2, 59, 59))).toBe(0);
    expect(diasParaReautorizarAmazon(autorizadoEm, Date.UTC(2027, 9, 16, 3, 0, 0))).toBe(-1);
  });

  it('is a whole number all day long — never a fraction of elapsed time', () => {
    for (let hora = 0; hora < 24; hora++) {
      const dias = diasParaReautorizarAmazon(autorizadoEm, Date.UTC(2027, 8, 15, hora, 17, 0));
      expect(Number.isInteger(dias), String(hora)).toBe(true);
    }
  });
});

describe('diasAteDataCivilAmazon', () => {
  const hoje = meioDiaSp(2026, 12, 31);

  it('0 today, positive ahead, negative behind — across a year boundary', () => {
    expect(diasAteDataCivilAmazon('2026-12-31', hoje)).toBe(0);
    expect(diasAteDataCivilAmazon('2027-01-01', hoje)).toBe(1);
    expect(diasAteDataCivilAmazon('2026-12-30', hoje)).toBe(-1);
    expect(diasAteDataCivilAmazon('2027-01-30', hoje)).toBe(30);
    expect(diasAteDataCivilAmazon('2027-01-31', hoje)).toBe(31);
  });

  it('counts 29 February as a day in a leap year — and not in a common one', () => {
    expect(diasAteDataCivilAmazon('2028-03-01', meioDiaSp(2028, 2, 28))).toBe(2);
    // Near-miss: the same span in a common year is one day.
    expect(diasAteDataCivilAmazon('2027-03-01', meioDiaSp(2027, 2, 28))).toBe(1);
  });

  it('counts the day of `agoraMs` in São Paulo', () => {
    // 2027-01-01T01:00Z is still 31 December in São Paulo.
    expect(diasAteDataCivilAmazon('2027-01-01', Date.UTC(2027, 0, 1, 1, 0, 0))).toBe(1);
  });

  it('refuses anything that is not a real YYYY-MM-DD date — never trims, never guesses', () => {
    for (const data of ['2026-13-01', '2026-02-30', ' 2026-01-01', '2026-01-01 ', '2026-1-1', '']) {
      expect(() => diasAteDataCivilAmazon(data, hoje), JSON.stringify(data)).toThrow(RangeError);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                         Seller id and routability                          */
/* -------------------------------------------------------------------------- */

describe('sellingPartnerIdValido', () => {
  it('accepts the placeholder and anything of 1–64 visible ASCII characters', () => {
    expect(sellingPartnerIdValido(SPID)).toBe(true);
    expect(sellingPartnerIdValido('A')).toBe(true);
    expect(sellingPartnerIdValido('A'.repeat(MAX_SELLING_PARTNER_ID))).toBe(true);
    // Never a format pattern: a shape Amazon has not documented is not refused.
    expect(sellingPartnerIdValido('x-1_Z.9')).toBe(true);
    // Both ends of the visible range: `!` (0x21) and `~` (0x7E).
    expect(sellingPartnerIdValido('A!')).toBe(true);
    expect(sellingPartnerIdValido('A~')).toBe(true);
    expect(MAX_SELLING_PARTNER_ID).toBe(64);
  });

  it('refuses instead of repairing: a space, a line break, empty, 65 characters, non-ASCII', () => {
    for (const quase of [
      ` ${SPID}`,
      `${SPID}\n`,
      `${SPID} `,
      'AXXXXXX XXXXXXX',
      `${SPID}\t`,
      // DEL (0x7F) is a control character, one past `~`.
      `${SPID}\x7F`,
      '',
      'A'.repeat(MAX_SELLING_PARTNER_ID + 1),
      'AXXXXXXXXXXXXÉ',
    ]) {
      expect(sellingPartnerIdValido(quase), JSON.stringify(quase)).toBe(false);
    }
  });

  it('refuses a non-string', () => {
    for (const valor of [null, undefined, 12345678901234, ['AXXXXXXXXXXXXX'], {}]) {
      expect(sellingPartnerIdValido(valor), String(valor)).toBe(false);
    }
  });

  it('never case-folds: two ids differing only in case are both valid and stay distinct', () => {
    // The predicate does not transform, so the exact compare downstream sees two sellers.
    const outro = 'AXXXXXXXXXXXXx';
    expect(sellingPartnerIdValido(outro)).toBe(true);
    expect(outro).not.toBe(SPID);
    expect(outro.toUpperCase()).toBe(SPID);
  });
});

describe('contaAmazonRoteavel', () => {
  const conta = { tipo: INTEGRACAO_TIPO.amazon, ativo: true, selling_partner_id: SPID };

  it('is true for an active Amazon conta with a valid seller id', () => {
    expect(contaAmazonRoteavel(conta)).toBe(true);
    expect(contaAmazonRoteavel({ ...conta, nome: 'Conta A', padrao: false })).toBe(true);
  });

  it('near-misses: the routing query would not find any of these', () => {
    const casos: [string, unknown][] = [
      ['another tipo', { ...conta, tipo: INTEGRACAO_TIPO.shopee }],
      ['tipo as text', { ...conta, tipo: '8' }],
      ['inactive', { ...conta, ativo: false }],
      ['ativo absent', { tipo: conta.tipo, selling_partner_id: SPID }],
      ['ativo as text', { ...conta, ativo: 'true' }],
      ['no seller id', { ...conta, selling_partner_id: null }],
      ['seller id absent', { tipo: conta.tipo, ativo: true }],
      ['seller id with a space', { ...conta, selling_partner_id: ` ${SPID}` }],
      ['null', null],
      ['undefined', undefined],
      ['array', [conta]],
      ['string', 'conta'],
    ];
    for (const [nome, valor] of casos) expect(contaAmazonRoteavel(valor), nome).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                                   Errors                                   */
/* -------------------------------------------------------------------------- */

describe('CODIGO_ERRO_AMAZON', () => {
  it('is exactly the four codes, each unique and AMAZON_-prefixed', () => {
    expect(CODIGO_ERRO_AMAZON).toEqual({
      ID_INVALIDO: 'AMAZON_ID_INVALIDO',
      CONTA_NAO_ENCONTRADA: 'AMAZON_CONTA_NAO_ENCONTRADA',
      CHAMADAS_DESLIGADAS: 'AMAZON_CHAMADAS_DESLIGADAS',
      CONFIG_AUSENTE: 'AMAZON_CONFIG_AUSENTE',
    });
    const codigos = Object.values(CODIGO_ERRO_AMAZON);
    expect(new Set(codigos).size).toBe(codigos.length);
    for (const c of codigos) expect(c).toMatch(/^AMAZON_[A-Z_]+$/);
  });
});

describe('erroContaAmazonSchema', () => {
  it('parses a conta-route envelope, with and without the optional detail', () => {
    expect(
      erroContaAmazonSchema.parse({ error: 'x', code: CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS }),
    ).toEqual({ error: 'x', code: 'AMAZON_CHAMADAS_DESLIGADAS' });
    expect(
      erroContaAmazonSchema.parse({
        error: 'x',
        code: CODIGO_ERRO_AMAZON.CONFIG_AUSENTE,
        issues: ['AMAZON_APPLICATION_ID'],
      }).issues,
    ).toEqual(['AMAZON_APPLICATION_ID']);
  });

  it('keeps `code` a plain string: an unknown code and verifyCaller’s coded answers parse', () => {
    expect(erroContaAmazonSchema.safeParse({ error: 'x', code: 'AMAZON_DO_FUTURO' }).success).toBe(
      true,
    );
    // 401 — a Firebase Auth rejection carries its code.
    expect(
      erroContaAmazonSchema.safeParse({
        error: 'Token inválido ou expirado (auth/id-token-expired).',
        code: 'auth/id-token-expired',
      }).success,
    ).toBe(true);
    // 500 — the Admin SDK failed to initialise.
    expect(
      erroContaAmazonSchema.safeParse({ error: 'x', code: 'app/invalid-credential' }).success,
    ).toBe(true);
  });

  it('requires `code`: a codeless body (verifyCaller’s 403, a proxy) is not this envelope', () => {
    expect(
      erroContaAmazonSchema.safeParse({ error: 'Sem permissão para esta operação.' }).success,
    ).toBe(false);
    expect(erroContaAmazonSchema.safeParse({ code: 'AMAZON_ID_INVALIDO' }).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                                  Answers                                   */
/* -------------------------------------------------------------------------- */

const STATUS_CONECTADA = {
  connected: true,
  credencialInvalida: false,
  autorizadoEm: '2026-10-15',
  reautorizarAte: '2027-10-15',
  diasParaReautorizar: 365,
  reconexaoPendente: null,
  chamadasLigadas: false,
};

const STATUS_VAZIO = {
  connected: false,
  credencialInvalida: false,
  autorizadoEm: null,
  reautorizarAte: null,
  diasParaReautorizar: null,
  reconexaoPendente: null,
  chamadasLigadas: false,
};

describe('statusContaAmazonSchema', () => {
  it('parses the connected, the parked and the all-null shapes', () => {
    expect(statusContaAmazonSchema.parse(STATUS_CONECTADA)).toEqual(STATUS_CONECTADA);
    expect(statusContaAmazonSchema.parse(STATUS_VAZIO)).toEqual(STATUS_VAZIO);
    const parada = { ...STATUS_CONECTADA, reconexaoPendente: { desde: '2027-01-02', status: 400 } };
    expect(statusContaAmazonSchema.parse(parada)).toEqual(parada);
    // A negative count is a real state: the date has passed.
    expect(
      statusContaAmazonSchema.safeParse({ ...STATUS_CONECTADA, diasParaReautorizar: -3 }).success,
    ).toBe(true);
  });

  it('is tolerant: an unknown key (a later field) is stripped, never refused', () => {
    const r = statusContaAmazonSchema.safeParse({ ...STATUS_CONECTADA, campoFuturo: 1 });
    expect(r.success).toBe(true);
    expect(r.success && 'campoFuturo' in r.data).toBe(false);
  });

  it('never carries the ref or the LWA code of a park: those keys are stripped', () => {
    const r = statusContaAmazonSchema.parse({
      ...STATUS_CONECTADA,
      reconexaoPendente: {
        desde: '2027-01-02',
        status: 400,
        refCredencial: 'x',
        codigoLwa: 'invalid_grant',
      },
    });
    expect(r.reconexaoPendente).toEqual({ desde: '2027-01-02', status: 400 });
  });

  it('refuses a non-civil date, a fractional count and a missing field', () => {
    expect(
      statusContaAmazonSchema.safeParse({ ...STATUS_CONECTADA, reautorizarAte: '15/10/2027' })
        .success,
    ).toBe(false);
    expect(
      statusContaAmazonSchema.safeParse({
        ...STATUS_CONECTADA,
        reautorizarAte: '2027-10-15T00:00:00Z',
      }).success,
    ).toBe(false);
    expect(
      statusContaAmazonSchema.safeParse({ ...STATUS_CONECTADA, diasParaReautorizar: 1.5 }).success,
    ).toBe(false);
    const { chamadasLigadas: _c, ...semChave } = STATUS_CONECTADA;
    expect(statusContaAmazonSchema.safeParse(semChave).success).toBe(false);
  });
});

describe('respostaInicioOAuthAmazonSchema', () => {
  it('parses a URL, refuses a non-URL and an absent one', () => {
    const url =
      'https://sellercentral.amazon.com.br/apps/authorize/consent?application_id=x&state=y';
    expect(respostaInicioOAuthAmazonSchema.parse({ authorizeUrl: url })).toEqual({
      authorizeUrl: url,
    });
    expect(respostaInicioOAuthAmazonSchema.safeParse({ authorizeUrl: 'consent' }).success).toBe(
      false,
    );
    expect(respostaInicioOAuthAmazonSchema.safeParse({}).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                            OAuth callback return                           */
/* -------------------------------------------------------------------------- */

describe('the OAuth return contract', () => {
  it('redirects under the `amazon` query key', () => {
    expect(CHAVE_RETORNO_OAUTH_AMAZON).toBe('amazon');
  });

  it('pins the motivo set AS A WHOLE — a widened or narrowed set fails here', () => {
    expect([...motivoRetornoOAuthAmazonSchema.options].sort()).toEqual(
      [
        'config',
        'bad_state',
        'integracao_desligada',
        'missing_params',
        'vendedor_invalido',
        'conta',
        'vendedor_diferente',
        'vendedor_em_outra_conta',
        'codigo_invalido',
        'server_config',
        'amazon_indisponivel',
        'tempo_esgotado',
        'rede',
        'resposta_invalida',
        'conflito',
        'exchange',
      ].sort(),
    );
    expect(motivoRetornoOAuthAmazonSchema.options).toHaveLength(16);
  });

  it('keeps the named-member constant in step with the enum, member for member', () => {
    expect(Object.values(MOTIVO_RETORNO_OAUTH_AMAZON).sort()).toEqual(
      [...motivoRetornoOAuthAmazonSchema.options].sort(),
    );
    expect(Object.keys(MOTIVO_RETORNO_OAUTH_AMAZON)).toHaveLength(16);
  });

  it('near-misses stay refused: the success value, other spellings, other channels’ reasons', () => {
    for (const quase of ['connected', 'error', 'Config', 'BAD_STATE', 'bad-state', 'state', '']) {
      expect(motivoRetornoOAuthAmazonSchema.safeParse(quase).success, quase).toBe(false);
    }
  });
});

describe('barrel', () => {
  it('exports the contract, and no collection meta for it', () => {
    expect(barrel.statusContaAmazonSchema).toBe(statusContaAmazonSchema);
    expect(barrel.erroContaAmazonSchema).toBe(erroContaAmazonSchema);
    expect(barrel.respostaInicioOAuthAmazonSchema).toBe(respostaInicioOAuthAmazonSchema);
    expect(barrel.motivoRetornoOAuthAmazonSchema).toBe(motivoRetornoOAuthAmazonSchema);
    expect(barrel.MOTIVO_RETORNO_OAUTH_AMAZON).toBe(MOTIVO_RETORNO_OAUTH_AMAZON);
    expect(barrel.CODIGO_ERRO_AMAZON).toBe(CODIGO_ERRO_AMAZON);
    expect(barrel.reautorizarAteAmazon).toBe(reautorizarAteAmazon);
    expect(barrel.diasParaReautorizarAmazon).toBe(diasParaReautorizarAmazon);
    expect(barrel.diasAteDataCivilAmazon).toBe(diasAteDataCivilAmazon);
    expect(barrel.sellingPartnerIdValido).toBe(sellingPartnerIdValido);
    expect(barrel.contaAmazonRoteavel).toBe(contaAmazonRoteavel);
    expect(Object.keys(barrel).some((k) => /^contaAmazon(Meta)?$/.test(k))).toBe(false);
  });
});
