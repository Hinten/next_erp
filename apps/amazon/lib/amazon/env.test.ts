import { describe, expect, it } from 'vitest';

import {
  CHAVES_CONFIG_AMAZON,
  MAX_SEGREDO_RELAY,
  MIN_SEGREDO_RELAY,
  RELAY_PREVIOUS_SECRET_ENV,
  RELAY_SECRET_ENV,
  TASKS_REGION_ENV,
  chavesDoReceptorRecusadas,
  chavesLwaRecusadas,
  lerConfigDoReceptorAmazon,
  lerAplicacaoLwaAmazon,
  lerConfigAmazon,
  lerSegredoExpiraEm,
  lerWebAppUrl,
  segredoRelayUtilizavel,
  webAppUrlValida,
} from './env';
import {
  AMBIENTE_LIGADO,
  APPLICATION_ID,
  CLIENT_SECRET,
  REDIRECT_URI,
  SEGREDO_RELAY,
  SEGREDO_RELAY_ANTERIOR,
  STATE_SECRET,
} from './testing/fixtures';

describe('lerConfigAmazon', () => {
  it('pins the six keys the start and the callback need', () => {
    expect([...CHAVES_CONFIG_AMAZON]).toEqual([
      'AMAZON_LWA_CLIENT_ID',
      'AMAZON_LWA_CLIENT_SECRET',
      'AMAZON_APPLICATION_ID',
      'AMAZON_OAUTH_REDIRECT_URI',
      'AMAZON_OAUTH_STATE_SECRET',
      'WEB_APP_URL',
    ]);
  });

  it('reads a complete environment, every value raw', () => {
    const c = lerConfigAmazon(AMBIENTE_LIGADO);
    expect(c.completa).toBe(true);
    if (!c.completa) return;
    expect(c.aplicacao.clientSecret).toBe(CLIENT_SECRET);
    expect(c.redirectUri).toBe(REDIRECT_URI);
    expect(c.segredoDoState).toBe(STATE_SECRET);
  });

  it.each(CHAVES_CONFIG_AMAZON.map((k) => [k]))('reports %s by NAME when unset', (chave) => {
    const c = lerConfigAmazon({ ...AMBIENTE_LIGADO, [chave]: undefined });
    expect(c).toEqual({ completa: false, faltando: [chave] });
  });

  it('treats blank (empty or whitespace) as unset — never `??` on the raw value', () => {
    const c = lerConfigAmazon({
      ...AMBIENTE_LIGADO,
      AMAZON_OAUTH_REDIRECT_URI: '',
      AMAZON_OAUTH_STATE_SECRET: '   ',
    });
    expect(c).toEqual({
      completa: false,
      faltando: ['AMAZON_OAUTH_REDIRECT_URI', 'AMAZON_OAUTH_STATE_SECRET'],
    });
  });

  it('never trims a present value (near-miss of blank): the package refuses it, not this', () => {
    const c = lerConfigAmazon({
      ...AMBIENTE_LIGADO,
      AMAZON_LWA_CLIENT_SECRET: ` ${CLIENT_SECRET}\n`,
    });
    expect(c.completa).toBe(true);
    if (c.completa) expect(c.aplicacao.clientSecret).toBe(` ${CLIENT_SECRET}\n`);
  });

  it('an incomplete answer carries names only, never a value', () => {
    const c = lerConfigAmazon({ ...AMBIENTE_LIGADO, WEB_APP_URL: undefined });
    expect(JSON.stringify(c)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(c)).not.toContain(STATE_SECRET);
  });

  it('does not need the read switch (that is the switch reader’s job)', () => {
    expect(lerConfigAmazon({ ...AMBIENTE_LIGADO, AMAZON_CHAMADAS: undefined }).completa).toBe(true);
  });
});

describe('lerAplicacaoLwaAmazon', () => {
  it('needs only the LWA pair — a flow never builds a consent URL', () => {
    const r = lerAplicacaoLwaAmazon({
      AMAZON_LWA_CLIENT_ID: 'id',
      AMAZON_LWA_CLIENT_SECRET: 'segredo',
    });
    expect(r).toEqual({ completa: true, aplicacao: { clientId: 'id', clientSecret: 'segredo' } });
  });

  it('reports the missing half by name', () => {
    expect(lerAplicacaoLwaAmazon({ AMAZON_LWA_CLIENT_ID: 'id' })).toEqual({
      completa: false,
      faltando: ['AMAZON_LWA_CLIENT_SECRET'],
    });
  });
});

describe('chavesLwaRecusadas', () => {
  it('a usable pair → none (interior visible punctuation is usable)', () => {
    expect(chavesLwaRecusadas({ clientId: 'cli|a~b', clientSecret: 'sec!{x}#$' })).toEqual([]);
  });

  it.each([
    [
      'a trailing newline on the secret',
      { clientId: 'id', clientSecret: 'sec\n' },
      ['AMAZON_LWA_CLIENT_SECRET'],
    ],
    [
      'a trailing space on the id',
      { clientId: 'id ', clientSecret: 'sec' },
      ['AMAZON_LWA_CLIENT_ID'],
    ],
    [
      'non-ASCII in both',
      { clientId: 'idé', clientSecret: 'secé' },
      ['AMAZON_LWA_CLIENT_ID', 'AMAZON_LWA_CLIENT_SECRET'],
    ],
  ])('%s → that key by NAME, never the value', (_c, aplicacao, chaves) => {
    const r = chavesLwaRecusadas(aplicacao);
    expect(r).toEqual(chaves);
    for (const valor of Object.values(aplicacao)) expect(r.join(',')).not.toContain(valor);
  });

  it('agrees with lerConfigAmazon: a present-but-unusable secret is COMPLETE there, refused here', () => {
    const c = lerConfigAmazon({
      ...AMBIENTE_LIGADO,
      AMAZON_LWA_CLIENT_SECRET: `${CLIENT_SECRET}\n`,
    });
    expect(c.completa).toBe(true);
    if (!c.completa) return;
    expect(chavesLwaRecusadas(c.aplicacao)).toEqual(['AMAZON_LWA_CLIENT_SECRET']);
  });
});

describe('lerWebAppUrl', () => {
  it('reads it raw, and a blank one as null', () => {
    expect(lerWebAppUrl({ WEB_APP_URL: 'https://app.example' })).toBe('https://app.example');
    expect(lerWebAppUrl({ WEB_APP_URL: ' ' })).toBeNull();
    expect(lerWebAppUrl({})).toBeNull();
  });

  it('answers null for a present but unusable value, so the callback stops at step 1', () => {
    expect(lerWebAppUrl({ WEB_APP_URL: 'erp.example.com' })).toBeNull();
    expect(lerWebAppUrl({ WEB_APP_URL: 'ftp://erp.example.com' })).toBeNull();
  });
});

describe('webAppUrlValida', () => {
  it.each([
    'https://erp.example.com',
    'https://erp.example.com/',
    'http://localhost:3000',
    'https://erp.example.com/base',
  ])('accepts the absolute http(s) URL %s', (url) => {
    expect(webAppUrlValida(url)).toBe(true);
  });

  it.each([
    ['a bare host', 'erp.example.com'],
    ['a relative path', '/canais'],
    ['another scheme', 'ftp://erp.example.com'],
    ['javascript:', 'javascript:alert(1)'],
    ['a scheme with no host', 'https://'],
  ])('refuses %s', (_c, url) => {
    expect(webAppUrlValida(url)).toBe(false);
  });

  it('lerConfigAmazon reports an unusable WEB_APP_URL by NAME, like a missing one', () => {
    // ⚠️ The near-miss pair: the same environment with a usable URL is complete.
    expect(lerConfigAmazon({ ...AMBIENTE_LIGADO, WEB_APP_URL: 'erp.example.com' })).toEqual({
      completa: false,
      faltando: ['WEB_APP_URL'],
    });
    expect(
      lerConfigAmazon({ ...AMBIENTE_LIGADO, WEB_APP_URL: 'https://erp.example.com' }).completa,
    ).toBe(true);
  });
});

describe('lerSegredoExpiraEm', () => {
  it.each([
    [undefined, { tipo: 'ausente' }],
    ['', { tipo: 'ausente' }],
    ['   ', { tipo: 'ausente' }],
    ['2027-02-14', { tipo: 'valida', dataCivil: '2027-02-14' }],
    ['2028-02-29', { tipo: 'valida', dataCivil: '2028-02-29' }],
    // Near-misses: each would be "repaired" by a lax reader.
    ['2026-13-01', { tipo: 'invalida' }],
    ['2026-02-30', { tipo: 'invalida' }],
    ['2027-02-29', { tipo: 'invalida' }],
    [' 2026-01-01', { tipo: 'invalida' }],
    ['2026-01-01 ', { tipo: 'invalida' }],
    ['2026-1-1', { tipo: 'invalida' }],
    ['01/02/2027', { tipo: 'invalida' }],
  ])('%j → %j', (valor, esperado) => {
    expect(lerSegredoExpiraEm({ AMAZON_LWA_SEGREDO_EXPIRA_EM: valor })).toEqual(esperado);
  });
});

describe('the receiver keys (step 3)', () => {
  const RECEPTOR = { [RELAY_SECRET_ENV]: SEGREDO_RELAY, AMAZON_APPLICATION_ID: APPLICATION_ID };

  it('pins the names and the bounds', () => {
    expect(RELAY_SECRET_ENV).toBe('AMAZON_RELAY_SECRET');
    expect(RELAY_PREVIOUS_SECRET_ENV).toBe('AMAZON_RELAY_PREVIOUS_SECRET');
    expect(TASKS_REGION_ENV).toBe('AMAZON_TASKS_REGION');
    expect([MIN_SEGREDO_RELAY, MAX_SEGREDO_RELAY]).toEqual([32, 512]);
  });

  it.each([
    ['exactly 32 visible characters', 'a'.repeat(32), true],
    ['exactly 512', 'a'.repeat(512), true],
    ['the openssl hex form (64)', 'f0'.repeat(32), true],
    ['31 characters', 'a'.repeat(31), false],
    ['513 characters', 'a'.repeat(513), false],
    ['a trailing newline', `${'a'.repeat(40)}\n`, false],
    ['a trailing space', `${'a'.repeat(40)} `, false],
    ['a leading space', ` ${'a'.repeat(40)}`, false],
    ['an inner space', `${'a'.repeat(20)} ${'a'.repeat(20)}`, false],
    ['a non-ASCII letter', `${'a'.repeat(40)}é`, false],
    ['a control character', `${'a'.repeat(40)}\u0007`, false],
  ])('segredoRelayUtilizavel: %s → %s', (_caso, valor, esperado) => {
    expect(segredoRelayUtilizavel(valor)).toBe(esperado);
  });

  it('a complete receiver environment refuses nothing, and reads every value raw', () => {
    expect(chavesDoReceptorRecusadas(RECEPTOR)).toEqual([]);
    expect(lerConfigDoReceptorAmazon(RECEPTOR)).toEqual({
      completa: true,
      segredoAtual: SEGREDO_RELAY,
      segredoAnterior: null,
      applicationId: APPLICATION_ID,
    });
    expect(
      lerConfigDoReceptorAmazon({
        ...RECEPTOR,
        [RELAY_PREVIOUS_SECRET_ENV]: SEGREDO_RELAY_ANTERIOR,
      }),
    ).toMatchObject({ completa: true, segredoAnterior: SEGREDO_RELAY_ANTERIOR });
  });

  it.each([
    ['the secret unset', { [RELAY_SECRET_ENV]: undefined }, [RELAY_SECRET_ENV]],
    ['the secret blank', { [RELAY_SECRET_ENV]: '   ' }, [RELAY_SECRET_ENV]],
    [
      'the secret with a trailing newline',
      { [RELAY_SECRET_ENV]: `${SEGREDO_RELAY}\n` },
      [RELAY_SECRET_ENV],
    ],
    ['a 31-character secret', { [RELAY_SECRET_ENV]: 'a'.repeat(31) }, [RELAY_SECRET_ENV]],
    [
      'a previous secret with a trailing space',
      { [RELAY_PREVIOUS_SECRET_ENV]: `${SEGREDO_RELAY_ANTERIOR} ` },
      [RELAY_PREVIOUS_SECRET_ENV],
    ],
    [
      'a short previous secret',
      { [RELAY_PREVIOUS_SECRET_ENV]: 'curto' },
      [RELAY_PREVIOUS_SECRET_ENV],
    ],
    ['the application id unset', { AMAZON_APPLICATION_ID: undefined }, ['AMAZON_APPLICATION_ID']],
    ['the application id blank', { AMAZON_APPLICATION_ID: '' }, ['AMAZON_APPLICATION_ID']],
    [
      'an application id holding a space',
      { AMAZON_APPLICATION_ID: `${APPLICATION_ID} x` },
      ['AMAZON_APPLICATION_ID'],
    ],
    [
      'everything at once, in a fixed order',
      {
        [RELAY_SECRET_ENV]: '',
        [RELAY_PREVIOUS_SECRET_ENV]: 'x',
        AMAZON_APPLICATION_ID: undefined,
      },
      [RELAY_SECRET_ENV, RELAY_PREVIOUS_SECRET_ENV, 'AMAZON_APPLICATION_ID'],
    ],
  ])('refuses %s, by NAME', (_caso, sobre, esperado) => {
    const ambiente = { ...RECEPTOR, ...sobre };
    expect(chavesDoReceptorRecusadas(ambiente)).toEqual(esperado);
    expect(lerConfigDoReceptorAmazon(ambiente)).toEqual({ completa: false, faltando: esperado });
  });

  it('a previous secret unset, empty or blank is "no rotation", never a refusal', () => {
    for (const anterior of [undefined, '', '   ', '\n']) {
      const ambiente = { ...RECEPTOR, [RELAY_PREVIOUS_SECRET_ENV]: anterior };
      expect(chavesDoReceptorRecusadas(ambiente)).toEqual([]);
      expect(lerConfigDoReceptorAmazon(ambiente)).toMatchObject({ segredoAnterior: null });
    }
  });

  it('a refusal never carries a value', () => {
    const recusadas = chavesDoReceptorRecusadas({
      [RELAY_SECRET_ENV]: `${SEGREDO_RELAY}\n`,
      AMAZON_APPLICATION_ID: `${APPLICATION_ID} `,
    });
    expect(JSON.stringify(recusadas)).not.toContain(SEGREDO_RELAY);
    expect(JSON.stringify(recusadas)).not.toContain(APPLICATION_ID);
  });
});
