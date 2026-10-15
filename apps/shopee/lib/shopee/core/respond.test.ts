import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SHOPEE_ERROR_KIND,
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
} from '@delfrance/integrations-shopee';

import {
  ETAPA_PUBLICACAO,
  MOTIVO_PUBLICACAO_BLOQUEADA,
  ShopeePublishBlockedError,
  ShopeePublishRejectedError,
  type ProblemaDeBloqueio,
  type ProblemaPublicacao,
} from '../anuncios/errosPublicacao';
import {
  MOTIVO_IMPORT_BLOQUEADO,
  ShopeeImportBlockedError,
  type MotivoImportBloqueado,
} from '../produtos/errosImportacao';
import { ShopeeCredencialInvalidaError } from './credentialStore';
import { ShopeeContaNotConfiguredError } from './shopee';
import {
  ShopeeContaSemShopIdError,
  ShopeeRefreshEmAndamentoError,
  ShopeeSemCredencialError,
} from './tokenStore';
import { isShopeeError, shopeeErrorResponse } from './respond';

const PATH = '/api/v2/product/get_item_base_info';
const ITEM_ID = 2500139861;
const PRODUTO_ID = 'prod-fixture-1';
/** Provider prose, so a leak into a log line or a `message` is unmistakable. */
const PROSA = 'PROSA-DA-SHOPEE-QUE-NAO-PODE-VAZAR';

/** The one argument type `shopeeErrorResponse` accepts (`KnownError` is module-private). */
type ErroConhecido = Parameters<typeof shopeeErrorResponse>[0];

// `shopeeErrorResponse` LOGS every mapping (the load-bearing half of the
// module), so every test silences the two console sinks and some of them assert
// on which one was used.
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function bloqueado(
  motivo: MotivoImportBloqueado = MOTIVO_IMPORT_BLOQUEADO.kitComponenteNaoVinculado,
  mensagem?: string,
) {
  return new ShopeeImportBlockedError(motivo, ITEM_ID, mensagem);
}

describe('shopeeErrorResponse — a cadeia existente', () => {
  it('1 — cada classe cai no seu próprio braço, com o status e o code que a nomeia', async () => {
    // A tabela inteira num teste só: o valor aqui é que NENHUMA classe possa
    // escorregar para o 500 genérico sem que uma linha fique vermelha.
    const casos: readonly (readonly [ErroConhecido, number, string | undefined])[] = [
      [new ShopeeConfigError('SHOPEE_PARTNER_KEY ausente'), 500, undefined],
      [new ShopeeContaNotConfiguredError('sem integração'), 404, undefined],
      [new ShopeeRefreshEmAndamentoError('lease ocupada', 1), 503, 'SHOPEE_REFRESH_EM_ANDAMENTO'],
      [new ShopeeSemCredencialError('sem credencial'), 409, 'SHOPEE_REAUTH_REQUIRED'],
      [new ShopeeContaSemShopIdError('sem shop_id'), 409, 'SHOPEE_CONTA_SEM_SHOP_ID'],
      [
        new ShopeeCredencialInvalidaError('credencial parcial', ['access_token']),
        502,
        'SHOPEE_BAD_RESPONSE',
      ],
      [
        new ShopeeSchemaError('corpo inesperado', {
          campos: ['response.item_list[0].deboost'],
          httpStatus: 200,
          path: PATH,
        }),
        502,
        'SHOPEE_BAD_RESPONSE',
      ],
      [
        new ShopeeReauthRequiredError('grant morto', {
          code: 'shop_access_expired',
          kind: SHOPEE_ERROR_KIND.reauth,
          httpStatus: 200,
          path: PATH,
        }),
        409,
        'SHOPEE_REAUTH_REQUIRED',
      ],
      [
        new ShopeeApiError('recusou', {
          code: 'error_param',
          kind: SHOPEE_ERROR_KIND.other,
          httpStatus: 200,
          path: PATH,
        }),
        502,
        'SHOPEE_HTTP_ERROR',
      ],
      [new ShopeeNetworkError('ECONNRESET'), 503, 'SHOPEE_NETWORK_ERROR'],
      [
        new ShopeeHttpError('edge recusou', { httpStatus: 403, path: PATH }),
        502,
        'SHOPEE_HTTP_ERROR',
      ],
      [new ShopeeError('genérico'), 500, 'SHOPEE_ERROR'],
    ];

    for (const [err, status, code] of casos) {
      const res = shopeeErrorResponse(err);
      expect(res.status, err.name).toBe(status);
      const corpo = (await res.json()) as Record<string, unknown>;
      if (code !== undefined) expect(corpo.code, err.name).toBe(code);
    }
  });

  it('2 — ⛔ NEAR-MISS: o braço de reauth fica ACIMA do ShopeeApiError que ele estende', () => {
    // Abaixo dele, um grant morto viraria um 502 genérico e o operador nunca
    // seria mandado reconectar. Mesma propriedade de ordem do braço 422 abaixo.
    const reauth = new ShopeeReauthRequiredError('grant morto', {
      code: 'shop_access_expired',
      kind: SHOPEE_ERROR_KIND.reauth,
      httpStatus: 200,
      path: PATH,
    });
    expect(reauth).toBeInstanceOf(ShopeeApiError);
    expect(shopeeErrorResponse(reauth).status).toBe(409);
  });
});

describe('shopeeErrorResponse — ShopeeImportBlockedError (step 9)', () => {
  it('3 — um ShopeeImportBlockedError vira 422 SHOPEE_IMPORT_BLOCKED com o motivo e o itemId', async () => {
    const res = shopeeErrorResponse(
      bloqueado(
        MOTIVO_IMPORT_BLOQUEADO.kitComponenteNaoVinculado,
        '2 de 3 componentes ainda não têm produto no ERP',
      ),
    );

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({
      error:
        'Importação bloqueada (kit-componente-nao-vinculado) no item 2500139861: 2 de 3 componentes ainda não têm produto no ERP',
      code: 'SHOPEE_IMPORT_BLOCKED',
      motivo: 'kit-componente-nao-vinculado',
      itemId: ITEM_ID,
      mensagem: '2 de 3 componentes ainda não têm produto no ERP',
    });
  });

  it('4 — ⛔ NEAR-MISS: a ORDEM importa — abaixo do braço base ele seria 500 SHOPEE_ERROR', async () => {
    // A propriedade, medida no comportamento: a classe ESTENDE `ShopeeError`, e
    // o braço genérico responde 500. Se o braço novo escorregar para baixo dele,
    // o `instanceof` da base casa primeiro e este teste fica vermelho.
    const err = bloqueado(MOTIVO_IMPORT_BLOQUEADO.semNome);
    expect(err).toBeInstanceOf(ShopeeError);

    const res = shopeeErrorResponse(err);
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ code: 'SHOPEE_IMPORT_BLOCKED' });
  });

  it('5 — ⛔ NEAR-MISS: a ordem também no FONTE — o braço novo vem antes do braço base', () => {
    // O teste 4 mede o comportamento; este mede o TEXTO, porque um refactor que
    // reordene a cadeia sem rodar a suíte é exatamente o que se quer pegar. Um
    // `indexOf` que não achasse nada devolveria -1 e passaria por acaso, então as
    // duas ÂNCORAS são asseridas explicitamente.
    const fonte = readFileSync(fileURLToPath(new URL('./respond.ts', import.meta.url)), 'utf8');

    const iBloqueado = fonte.indexOf('if (err instanceof ShopeeImportBlockedError) {');
    const iBase = fonte.indexOf("code: 'SHOPEE_ERROR'");

    expect(iBloqueado, 'âncora: o braço 422 existe no fonte').toBeGreaterThanOrEqual(0);
    expect(iBase, 'âncora: o braço base 500 existe no fonte').toBeGreaterThanOrEqual(0);
    expect(iBloqueado).toBeLessThan(iBase);
  });

  it('6 — o corpo carrega EXATAMENTE cinco chaves: nada de nome de anúncio nem de body cru', async () => {
    // #1015. O que não está na lista não vaza: a resposta é operator-facing e
    // `mensagem` é uma frase de MECANISMO por construção (docblock da classe).
    // Um `...err` acidental no corpo apareceria aqui como uma chave a mais.
    const res = shopeeErrorResponse(
      bloqueado(
        MOTIVO_IMPORT_BLOQUEADO.vinculoInconsistente,
        'o prodshopee aponta para outra família',
      ),
    );

    const corpo = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(corpo).sort()).toEqual(['code', 'error', 'itemId', 'mensagem', 'motivo']);
  });

  it('7 — 422 é culpa do chamador: sai em console.warn, nunca em console.error', () => {
    // `logErrorResponse` separa por status: >= 500 carrega o objeto de erro (o
    // stack sobrevive), < 500 é uma linha de aviso. Um item recusado não é uma
    // pane nossa e não deve acordar ninguém.
    shopeeErrorResponse(bloqueado(MOTIVO_IMPORT_BLOQUEADO.itemDeletado));

    const warn = vi.mocked(console.warn);
    expect(vi.mocked(console.error)).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const linha = String(warn.mock.calls[0]?.[0]);
    expect(linha).toContain('ShopeeImportBlockedError -> HTTP 422');
    expect(linha).toContain('item-deletado');
    expect(linha).toContain(String(ITEM_ID));
  });
});

function problemaDeBloqueio(
  motivo: ProblemaDeBloqueio['motivo'],
  campo: string | null,
  mensagem: string,
): ProblemaDeBloqueio {
  return { campo, motivo, mensagem };
}

function publicacaoBloqueada(
  problemas: readonly [ProblemaDeBloqueio, ...ProblemaDeBloqueio[]] = [
    problemaDeBloqueio(MOTIVO_PUBLICACAO_BLOQUEADA.semPeso, 'weight', 'o produto não tem peso'),
  ],
  itemId: number | null = null,
) {
  return new ShopeePublishBlockedError({ produtoId: PRODUTO_ID, itemId, problemas });
}

function publicacaoRecusada(problemas: readonly ProblemaPublicacao[] = []) {
  return new ShopeePublishRejectedError({
    etapa: ETAPA_PUBLICACAO.initTierVariation,
    shopeeCode: 'product.error_param',
    produtoId: PRODUTO_ID,
    itemId: ITEM_ID,
    problemas,
  });
}

describe('shopeeErrorResponse — as duas recusas de PUBLICAÇÃO (step 11)', () => {
  it('10 — um ShopeePublishBlockedError vira 422 SHOPEE_PUBLISH_BLOCKED com motivo e problemas', async () => {
    const res = shopeeErrorResponse(
      publicacaoBloqueada([
        problemaDeBloqueio(MOTIVO_PUBLICACAO_BLOQUEADA.semPeso, 'weight', 'o produto não tem peso'),
        problemaDeBloqueio(
          MOTIVO_PUBLICACAO_BLOQUEADA.semDimensoes,
          'dimension',
          'faltam os três eixos',
        ),
      ]),
    );

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as Record<string, unknown>;
    // ⚠️ As chaves EXATAS: um `...err` acidental apareceria aqui como uma chave a
    // mais, e `mensagem` deliberadamente NÃO é uma delas (a classe não tem esse
    // campo — a prosa vive em `problemas[].mensagem` e em lugar nenhum além).
    expect(Object.keys(corpo).sort()).toEqual([
      'code',
      'error',
      'itemId',
      'motivo',
      'problemas',
      'produtoId',
    ]);
    expect(corpo.code).toBe('SHOPEE_PUBLISH_BLOCKED');
    expect(corpo.motivo).toBe('sem-peso');
    expect(corpo.produtoId).toBe(PRODUTO_ID);
    expect(corpo.itemId).toBeNull();
    expect(corpo.problemas).toEqual([
      { campo: 'weight', motivo: 'sem-peso', mensagem: 'o produto não tem peso' },
      { campo: 'dimension', motivo: 'sem-dimensoes', mensagem: 'faltam os três eixos' },
    ]);
  });

  it('11 — um ShopeePublishRejectedError vira 422 SHOPEE_PUBLISH_REJECTED com etapa e shopeeCode', async () => {
    const res = shopeeErrorResponse(
      publicacaoRecusada([
        { campo: 'tier_variation', motivo: 'opcoes-demais', mensagem: 'demais' },
      ]),
    );

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(corpo).sort()).toEqual([
      'code',
      'error',
      'etapa',
      'itemId',
      'problemas',
      'produtoId',
      'shopeeCode',
    ]);
    expect(corpo.code).toBe('SHOPEE_PUBLISH_REJECTED');
    // A etapa é o extra carregado: ela diz o que EXISTE no canal agora. Uma
    // recusa em `init_tier_variation` deixa um item UNLIST sem modelos.
    expect(corpo.etapa).toBe('init_tier_variation');
    // ⚠️ VERBATIM, prefixo de módulo e tudo — igual ao braço do ShopeeApiError.
    expect(corpo.shopeeCode).toBe('product.error_param');
    expect(corpo.itemId).toBe(ITEM_ID);
  });

  it('12 — ⛔ NEAR-MISS: a ORDEM importa — abaixo do braço base as duas seriam 500', async () => {
    // A propriedade medida no comportamento. As duas classes ESTENDEM
    // `ShopeeError`, cujo braço responde 500 `SHOPEE_ERROR` — a nossa pane. Se
    // qualquer um dos dois braços novos escorregar para baixo dele, o
    // `instanceof` da base casa primeiro, o operador é informado de uma pane que
    // não houve e nunca descobre qual produto foi recusado.
    const bloq = publicacaoBloqueada();
    const rej = publicacaoRecusada();
    expect(bloq).toBeInstanceOf(ShopeeError);
    expect(rej).toBeInstanceOf(ShopeeError);

    const resBloq = shopeeErrorResponse(bloq);
    expect(resBloq.status).toBe(422);
    await expect(resBloq.json()).resolves.toMatchObject({ code: 'SHOPEE_PUBLISH_BLOCKED' });

    const resRej = shopeeErrorResponse(rej);
    expect(resRej.status).toBe(422);
    await expect(resRej.json()).resolves.toMatchObject({ code: 'SHOPEE_PUBLISH_REJECTED' });
  });

  it('13 — ⛔ NEAR-MISS: a ordem também no FONTE, e os três braços 422 ficam juntos', () => {
    // O teste 12 mede o comportamento; este mede o TEXTO, porque um refactor que
    // reordene a cadeia sem rodar a suíte é exatamente o que se quer pegar. Um
    // `indexOf` que não achasse nada devolveria -1 e passaria por acaso, então
    // TODAS as âncoras são asseridas explicitamente.
    const fonte = readFileSync(fileURLToPath(new URL('./respond.ts', import.meta.url)), 'utf8');

    const iPublishBloq = fonte.indexOf('if (err instanceof ShopeePublishBlockedError) {');
    const iPublishRej = fonte.indexOf('if (err instanceof ShopeePublishRejectedError) {');
    const iImport = fonte.indexOf('if (err instanceof ShopeeImportBlockedError) {');
    const iBase = fonte.indexOf("code: 'SHOPEE_ERROR'");

    for (const [nome, i] of [
      ['publish-blocked', iPublishBloq],
      ['publish-rejected', iPublishRej],
      ['import-blocked', iImport],
      ['base 500', iBase],
    ] as const) {
      expect(i, `âncora: o braço ${nome} existe no fonte`).toBeGreaterThanOrEqual(0);
    }

    // Imediatamente ACIMA do braço de importação, que já estava acima da base.
    expect(iPublishBloq).toBeLessThan(iPublishRej);
    expect(iPublishRej).toBeLessThan(iImport);
    expect(iImport).toBeLessThan(iBase);
  });

  it('14 — a linha de log NUNCA carrega a prosa de um problema', async () => {
    // `logErrorResponse` imprime `err.message` (mais um detalhe por classe), e
    // nenhuma das duas classes é `ShopeeApiError`/`ShopeeSchemaError`, então o
    // detalhe é vazio. O que sobra é a frase de MECANISMO — que nomeia motivo,
    // produto e a CONTAGEM de problemas, nunca o texto deles. A prosa da Shopee
    // chega ao operador pelo corpo 422 e mora só lá.
    const res = shopeeErrorResponse(
      publicacaoBloqueada([
        problemaDeBloqueio(
          MOTIVO_PUBLICACAO_BLOQUEADA.atributoObrigatorio,
          'attribute_list',
          PROSA,
        ),
      ]),
    );

    const warn = vi.mocked(console.warn);
    expect(vi.mocked(console.error)).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const linha = String(warn.mock.calls[0]?.[0]);
    expect(linha).toContain('ShopeePublishBlockedError -> HTTP 422');
    expect(linha).toContain('atributo-obrigatorio');
    expect(linha).toContain(PRODUTO_ID);
    expect(linha).not.toContain(PROSA);

    // ⛔ O par que dá sentido: a prosa ESTÁ no corpo 422, de propósito. Sem esta
    // linha o teste passaria se `problemas` tivesse sumido do corpo.
    await expect(res.json()).resolves.toMatchObject({
      problemas: [{ campo: 'attribute_list', motivo: 'atributo-obrigatorio', mensagem: PROSA }],
    });
  });
});

describe('isShopeeError', () => {
  it('8 — reconhece a classe nova e continua recusando o que não é nosso', () => {
    expect(isShopeeError(bloqueado())).toBe(true);
    expect(isShopeeError(publicacaoBloqueada())).toBe(true);
    expect(isShopeeError(publicacaoRecusada())).toBe(true);
    expect(isShopeeError(new TypeError('x is not a function'))).toBe(false);
    expect(isShopeeError(new Error('boom'))).toBe(false);
    expect(isShopeeError('string')).toBe(false);
    expect(isShopeeError(null)).toBe(false);
  });

  it('9 — um ShopeeRateLimitError continua passando pela guarda (via ShopeeApiError)', () => {
    const burst = new ShopeeRateLimitError('estourou', {
      code: 'error_rate_limit',
      kind: 'burst',
      httpStatus: 200,
      path: PATH,
    });
    expect(isShopeeError(burst)).toBe(true);
  });
});
