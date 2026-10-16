import { describe, expect, it } from 'vitest';

import {
  CHAVES_CONFIG_AMAZON,
  chavesLwaRecusadas,
  lerAplicacaoLwaAmazon,
  lerConfigAmazon,
  lerSegredoExpiraEm,
  lerWebAppUrl,
  webAppUrlValida,
} from './env';
import { AMBIENTE_LIGADO, CLIENT_SECRET, REDIRECT_URI, STATE_SECRET } from './testing/fixtures';

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
