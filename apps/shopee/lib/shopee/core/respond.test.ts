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

describe('isShopeeError', () => {
  it('8 — reconhece a classe nova e continua recusando o que não é nosso', () => {
    expect(isShopeeError(bloqueado())).toBe(true);
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
