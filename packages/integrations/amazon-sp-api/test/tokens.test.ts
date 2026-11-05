import { afterEach, describe, expect, it } from 'vitest';

import { type ChamadaAmazon, type OpcoesClienteSpApi, URL_BASE_SP_API } from '../src/client';
import { CAMINHO_AGENDAMENTO_EASY_SHIP } from '../src/easyShip';
import { AmazonHttpError, AmazonNotFoundError, AmazonSchemaError } from '../src/errors';
import { criarClienteEscritaSpApi } from '../src/escrita';
import {
  CAMINHO_TOKEN_RESTRITO,
  criarTokenRestrito,
  OPERACAO_TOKEN_RESTRITO,
  RECURSO_RESTRITO_AGENDAMENTO,
  type RecursoRestritoAmazon,
  respostaTokenRestritoSchema,
} from '../src/tokens';
import {
  ACCESS_TOKEN,
  falha,
  json,
  mockFetch,
  requisicao,
  textosDoErro,
  USER_AGENT,
  verificarFormaDasRequisicoesSpApi,
} from './_helpers/mockFetch';

afterEach(verificarFormaDasRequisicoesSpApi);

/**
 * A synthetic RDT, shaped like nothing real (no Amazon prefix), so neither a
 * reader nor a secret scanner mistakes it for a credential; it stands in for
 * the model's example token.
 */
const RDT = 'rdt|TESTE-restrito-9999-sintetico-naoreal-00';

/**
 * tokens `createRestrictedDataToken` 200 static[0] (its request sends
 * `targetApplication`) and static[1] (its request does not): the same response
 * shape, `{ restrictedDataToken, expiresIn: 3600 }`, built inline from
 * `tokens_2021-03-01.json` with the example token REPLACED by {@link RDT}.
 */
const tokenRestrito200ComAlvo = { restrictedDataToken: RDT, expiresIn: 3600 } as const;
const tokenRestrito200SemAlvo = { restrictedDataToken: RDT, expiresIn: 3600 } as const;

/** tokens `createRestrictedDataToken` 400 static[0], as printed. */
const erro400TokenInvalidRequest = {
  errors: [
    {
      code: 'InvalidRequest',
      message: 'Request is missing or has invalid parameters',
      details: 'Resource not provided.',
    },
  ],
} as const;

function escritor(fetch: typeof globalThis.fetch) {
  const eventos: ChamadaAmazon[] = [];
  const opcoes: OpcoesClienteSpApi = {
    obterCredencial: () => ({ accessToken: ACCESS_TOKEN, ref: 'ref-lwa' }),
    userAgent: USER_AGENT,
    fetch,
    gerarCorrelationId: () => 'corr-1',
    agora: () => 1_000,
    onChamada: (e) => eventos.push(e),
  };
  return { c: criarClienteEscritaSpApi(opcoes), eventos };
}

describe('the constants', () => {
  it('pins the operation, the path and the ONE resource', () => {
    expect(OPERACAO_TOKEN_RESTRITO).toBe('createRestrictedDataToken');
    expect(CAMINHO_TOKEN_RESTRITO).toBe('/tokens/2021-03-01/restrictedDataToken');
    expect(RECURSO_RESTRITO_AGENDAMENTO).toEqual({
      method: 'POST',
      path: '/easyShip/2022-03-23/packages/bulk',
    });
    expect(RECURSO_RESTRITO_AGENDAMENTO.path).toBe(CAMINHO_AGENDAMENTO_EASY_SHIP);
    expect(Object.isFrozen(RECURSO_RESTRITO_AGENDAMENTO)).toBe(true);
  });
});

describe('criarTokenRestrito (createRestrictedDataToken)', () => {
  it('★ the body is EXACTLY restrictedResources: [{ method: POST, path }] (no dataElements, no targetApplication)', async () => {
    const f = mockFetch(() => json(tokenRestrito200SemAlvo));
    const { c, eventos } = escritor(f);
    await criarTokenRestrito(c, RECURSO_RESTRITO_AGENDAMENTO);
    const { url, init } = requisicao(f);
    expect(init.method).toBe('POST');
    expect(`${url.origin}${url.pathname}`).toBe(`${URL_BASE_SP_API}${CAMINHO_TOKEN_RESTRITO}`);
    expect(url.search).toBe('');
    // The literal pin. NEAR-MISSES it refuses: the optional keys sent anyway
    // (`dataElements: []`, a `targetApplication`), and `method: 'post'`.
    expect(init.body).toBe(
      '{"restrictedResources":[{"method":"POST","path":"/easyShip/2022-03-23/packages/bulk"}]}',
    );
    expect(init.body).not.toContain('dataElements');
    expect(init.body).not.toContain('targetApplication');
    expect(eventos[0]).toMatchObject({
      operacao: 'createRestrictedDataToken',
      metodo: 'POST',
      caminho: CAMINHO_TOKEN_RESTRITO,
    });
  });

  it('★ keys a caller smuggles into the resource never ride along (named keys)', async () => {
    const f = mockFetch(() => json(tokenRestrito200SemAlvo));
    const { c } = escritor(f);
    const contrabando = {
      ...RECURSO_RESTRITO_AGENDAMENTO,
      dataElements: [],
      targetApplication: 'outra-aplicacao',
    } as RecursoRestritoAmazon;
    await criarTokenRestrito(c, contrabando);
    expect(requisicao(f).init.body).toBe(
      '{"restrictedResources":[{"method":"POST","path":"/easyShip/2022-03-23/packages/bulk"}]}',
    );
  });

  it('★ a DIFFERENT resource cast past the type still mints for the bulk only (not a generic minter)', async () => {
    const f = mockFetch(() => json(tokenRestrito200SemAlvo));
    const { c } = escritor(f);
    const outro = {
      method: 'GET',
      path: '/orders/v0/orders/000-0000000-0000000/address',
    } as unknown as RecursoRestritoAmazon;
    await criarTokenRestrito(c, outro);
    const { init } = requisicao(f);
    expect(init.body).toBe(
      '{"restrictedResources":[{"method":"POST","path":"/easyShip/2022-03-23/packages/bulk"}]}',
    );
    expect(init.body).not.toContain('/orders/');
    expect(init.body).not.toContain('GET');
  });

  it('★ the minted token DOES reach the observer event’s corpo: only the app’s secret path policy keeps it out of a log line', async () => {
    // Pinned on purpose. The write client scrubs only the LWA access token of
    // the request; the RDT is another value. A change to the observer seam, or
    // to the app's policy for this path, has to face this test.
    const { c, eventos } = escritor(mockFetch(() => json(tokenRestrito200SemAlvo)));
    await criarTokenRestrito(c, RECURSO_RESTRITO_AGENDAMENTO);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]?.resultado).toBe('ok');
    expect(eventos[0]?.corpo).toContain(RDT);
  });

  it.each([
    ['static[0] (requested with targetApplication)', tokenRestrito200ComAlvo],
    ['static[1] (requested without targetApplication)', tokenRestrito200SemAlvo],
  ])('★ the sandbox 200 %s → { token, expiraEmS: 3600 }', async (_caso, corpo) => {
    const { c } = escritor(mockFetch(() => json(corpo)));
    expect(await criarTokenRestrito(c, RECURSO_RESTRITO_AGENDAMENTO)).toEqual({
      token: RDT,
      expiraEmS: 3600,
    });
  });

  it('★ expiresIn is read through wireInt(): absent → null, quoted → a number', async () => {
    const semValidade = escritor(mockFetch(() => json({ restrictedDataToken: RDT })));
    expect(await criarTokenRestrito(semValidade.c, RECURSO_RESTRITO_AGENDAMENTO)).toEqual({
      token: RDT,
      expiraEmS: null,
    });
    const nulo = escritor(mockFetch(() => json({ restrictedDataToken: RDT, expiresIn: null })));
    expect((await criarTokenRestrito(nulo.c, RECURSO_RESTRITO_AGENDAMENTO)).expiraEmS).toBeNull();
    const aspas = escritor(mockFetch(() => json({ restrictedDataToken: RDT, expiresIn: '3600' })));
    expect((await criarTokenRestrito(aspas.c, RECURSO_RESTRITO_AGENDAMENTO)).expiraEmS).toBe(3600);
    // Near-miss: a fraction is not an integer lifetime.
    expect(
      respostaTokenRestritoSchema.safeParse({ restrictedDataToken: RDT, expiresIn: 1.5 }).success,
    ).toBe(false);
  });

  it('★ the sandbox 400 InvalidRequest → AmazonHttpError 400 with codigosErro [InvalidRequest]', async () => {
    const { c } = escritor(mockFetch(() => json(erro400TokenInvalidRequest, 400)));
    const err = await falha(criarTokenRestrito(c, RECURSO_RESTRITO_AGENDAMENTO));
    expect(err).toBeInstanceOf(AmazonHttpError);
    expect(err).not.toBeInstanceOf(AmazonNotFoundError);
    expect(err).toMatchObject({ status: 400, codigosErro: ['InvalidRequest'] });
    for (const t of textosDoErro(err)) expect(t).not.toContain('Resource not provided');
  });

  it.each([
    ['a space', 'rdt|TESTE com-espaco'],
    ['a line break', 'rdt|TESTE-quebra\n'],
    ['a control character', 'rdt|TESTE-\u0001-controle'],
    ['DEL (0x7F, just past the visible range)', 'rdt|TESTE-\u007f-del'],
    ['a non-ASCII character', 'rdt|TESTE-acentuação'],
    ['empty', ''],
    ['over 4096 characters', `rdt|${'x'.repeat(4093)}`],
  ])('★ a token with %s → AmazonSchemaError, and no error text holds it', async (_caso, token) => {
    const { c } = escritor(mockFetch(() => json({ restrictedDataToken: token, expiresIn: 3600 })));
    const err = await falha(criarTokenRestrito(c, RECURSO_RESTRITO_AGENDAMENTO));
    expect(err).toBeInstanceOf(AmazonSchemaError);
    expect(err).toMatchObject({ motivo: 'formato', campos: ['restrictedDataToken'] });
    for (const t of textosDoErro(err)) {
      if (token !== '') expect(t).not.toContain(token);
      expect(t).not.toContain('rdt|');
    }
  });

  it('★ NEAR-MISS: every visible ASCII character, 0x21 (!) to 0x7E (~), is a token, returned verbatim', async () => {
    // Real tokens carry `.` and `|` (the model's own example does); a grammar
    // narrowed below the whole visible range would refuse every one of them.
    // No Amazon prefix, so no secret scanner mistakes it for a credential.
    const todos = Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) => String.fromCharCode(0x21 + i));
    const token = todos.join('');
    expect(token).toHaveLength(94);
    expect(token.startsWith('!')).toBe(true);
    expect(token.endsWith('~')).toBe(true);
    const { c } = escritor(mockFetch(() => json({ restrictedDataToken: token, expiresIn: 3600 })));
    expect(await criarTokenRestrito(c, RECURSO_RESTRITO_AGENDAMENTO)).toEqual({
      token,
      expiraEmS: 3600,
    });
  });

  it('near-miss: 4096 visible characters is a token', () => {
    const token = `rdt|${'x'.repeat(4092)}`;
    expect(token).toHaveLength(4096);
    expect(respostaTokenRestritoSchema.safeParse({ restrictedDataToken: token }).success).toBe(
      true,
    );
  });

  it('a 2xx without a token is AmazonSchemaError (nothing to hand on)', async () => {
    const { c } = escritor(mockFetch(() => json({ expiresIn: 3600 })));
    expect(await falha(criarTokenRestrito(c, RECURSO_RESTRITO_AGENDAMENTO))).toBeInstanceOf(
      AmazonSchemaError,
    );
  });
});
