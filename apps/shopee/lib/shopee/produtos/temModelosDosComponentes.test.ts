import { describe, expect, it, vi } from 'vitest';

import {
  SHOPEE_ERROR_KIND,
  ShopeeApiError,
  ShopeeRateLimitError,
  shopeeItemBaseInfoPayloadSchema,
  shopeeKitItemSchema,
  type ShopeeClient,
} from '@delfrance/integrations-shopee';

import { itensDosComponentesDoKit, lerTemModelosDosComponentes } from './temModelosDosComponentes';

/** Kit roles (D1): component A has variations, component B (plain) does not. */
const COMPONENTE_A = 2500139871;
const COMPONENTE_B = 2500139872;
const MODELO_A = 2000458821;
const MODELO_OCULTO_B = 2000458829;

function payload(...linhas: Record<string, unknown>[]) {
  return shopeeItemBaseInfoPayloadSchema.parse({ item_list: linhas });
}

/** A client whose ONLY method is `getItemBaseInfo`, recorded call by call. */
function cliente(responder: (itemIds: readonly number[]) => unknown): {
  readonly client: ShopeeClient;
  readonly getItemBaseInfo: ReturnType<typeof vi.fn>;
} {
  const getItemBaseInfo = vi.fn((p: { itemIds: readonly number[] }) =>
    Promise.resolve(responder(p.itemIds)),
  );
  return { client: { getItemBaseInfo } as unknown as ShopeeClient, getItemBaseInfo };
}

function erroDeLote(code: string): ShopeeApiError {
  return new ShopeeApiError(`Shopee respondeu ${code} (HTTP 200)`, {
    code,
    kind: SHOPEE_ERROR_KIND.other,
    httpStatus: 200,
    path: '/api/v2/product/get_item_base_info',
  });
}

describe('lerTemModelosDosComponentes', () => {
  it('lê has_model por item_id — true e false, reconciliados pelo id e não pela posição', async () => {
    const { client } = cliente(() =>
      payload(
        { item_id: COMPONENTE_B, has_model: false },
        { item_id: COMPONENTE_A, has_model: true },
      ),
    );

    const mapa = await lerTemModelosDosComponentes(client, [COMPONENTE_A, COMPONENTE_B]);

    expect([...mapa.entries()]).toEqual([
      [COMPONENTE_B, false],
      [COMPONENTE_A, true],
    ]);
  });

  it('(M43) ⛔ uma linha AUSENTE fica FORA do mapa — desconhecido, nunca false', async () => {
    const { client } = cliente(() => payload({ item_id: COMPONENTE_A, has_model: true }));

    const mapa = await lerTemModelosDosComponentes(client, [COMPONENTE_A, COMPONENTE_B]);

    expect(mapa.get(COMPONENTE_A)).toBe(true);
    expect(mapa.has(COMPONENTE_B)).toBe(false);
  });

  it('⛔ uma linha ILEGÍVEL (sentinela null) e um has_model null também ficam fora do mapa', async () => {
    const { client } = cliente(() => ({
      item_list: [null, { item_id: COMPONENTE_B, has_model: null }],
    }));

    const mapa = await lerTemModelosDosComponentes(client, [COMPONENTE_A, COMPONENTE_B]);

    expect(mapa.size).toBe(0);
  });

  it('⚠️ NEAR-MISS: has_model false EXPLÍCITO entra no mapa como false (não é ausência)', async () => {
    const { client } = cliente(() => payload({ item_id: COMPONENTE_B, has_model: false }));

    const mapa = await lerTemModelosDosComponentes(client, [COMPONENTE_B]);

    expect(mapa.has(COMPONENTE_B)).toBe(true);
    expect(mapa.get(COMPONENTE_B)).toBe(false);
  });

  it('uma linha de um id NÃO pedido é ignorada; duas linhas do mesmo id ⇒ a PRIMEIRA vence', async () => {
    const { client } = cliente(() =>
      payload(
        { item_id: 2500139861, has_model: true },
        { item_id: COMPONENTE_B, has_model: false },
        { item_id: COMPONENTE_B, has_model: true },
      ),
    );

    const mapa = await lerTemModelosDosComponentes(client, [COMPONENTE_B]);

    expect([...mapa.entries()]).toEqual([[COMPONENTE_B, false]]);
  });

  it('ids DISTINTOS: um item que compõe dois modelos é pedido UMA vez', async () => {
    const { client, getItemBaseInfo } = cliente((ids) =>
      payload(...ids.map((id) => ({ item_id: id, has_model: false }))),
    );

    await lerTemModelosDosComponentes(client, [COMPONENTE_B, COMPONENTE_A, COMPONENTE_B]);

    expect(getItemBaseInfo).toHaveBeenCalledTimes(1);
    expect(getItemBaseInfo).toHaveBeenCalledWith({ itemIds: [COMPONENTE_B, COMPONENTE_A] });
  });

  it('(M44) 50 ids custam UMA chamada; 51 custam DUAS, cada uma com ≤ 50', async () => {
    const cinquenta = Array.from({ length: 50 }, (_, i) => 2500140000 + i);
    const umAMais = [...cinquenta, 2500140050];

    const a = cliente((ids) => payload(...ids.map((id) => ({ item_id: id, has_model: true }))));
    await lerTemModelosDosComponentes(a.client, cinquenta);
    expect(a.getItemBaseInfo).toHaveBeenCalledTimes(1);

    const b = cliente((ids) => payload(...ids.map((id) => ({ item_id: id, has_model: true }))));
    const mapa = await lerTemModelosDosComponentes(b.client, umAMais);
    expect(b.getItemBaseInfo).toHaveBeenCalledTimes(2);
    const tamanhos = b.getItemBaseInfo.mock.calls.map(
      (c) => (c[0] as { itemIds: readonly number[] }).itemIds.length,
    );
    expect(tamanhos).toEqual([50, 1]);
    expect(mapa.size).toBe(51);
  });

  it('zero ids ⇒ ZERO chamadas; um id inutilizável (0, fração) nunca é enviado', async () => {
    const { client, getItemBaseInfo } = cliente(() => payload());

    expect((await lerTemModelosDosComponentes(client, [])).size).toBe(0);
    expect((await lerTemModelosDosComponentes(client, [0, 1.5, -3])).size).toBe(0);
    expect(getItemBaseInfo).not.toHaveBeenCalled();
  });

  it('error_item_not_found (nua OU com prefixo) no lote ⇒ todos desconhecidos, sem lançar', async () => {
    for (const code of ['error_item_not_found', 'product.error_item_not_found']) {
      const { client } = cliente(() => {
        throw erroDeLote(code);
      });

      const mapa = await lerTemModelosDosComponentes(client, [COMPONENTE_A, COMPONENTE_B]);

      expect(mapa.size).toBe(0);
    }
  });

  it('⚠️ NEAR-MISS: outro código, ou um limite de taxa, SOBE intacto', async () => {
    const outro = erroDeLote('error_param');
    const a = cliente(() => {
      throw outro;
    });
    await expect(lerTemModelosDosComponentes(a.client, [COMPONENTE_A])).rejects.toBe(outro);

    const limite = new ShopeeRateLimitError('limite', {
      code: 'error_item_not_found',
      kind: SHOPEE_ERROR_KIND.burst,
      httpStatus: 429,
      path: '/api/v2/product/get_item_base_info',
    });
    const b = cliente(() => {
      throw limite;
    });
    await expect(lerTemModelosDosComponentes(b.client, [COMPONENTE_A])).rejects.toBe(limite);
  });

  it('(R6-M11) ⛔ o MESMO código num erro TRANSITÓRIO (um 5xx) SOBE — só o kind `other` é o veredito do lote', async () => {
    // Mutant TM1: without the `kind` narrowing a 503 carrying
    // `error_item_not_found` would be swallowed as "none of these ids exists",
    // every id would read as UNKNOWN and the import would fall to the SKU rungs
    // instead of retrying (rule 6).
    const transitorio = new ShopeeApiError('Shopee respondeu error_item_not_found (HTTP 503)', {
      code: 'error_item_not_found',
      kind: SHOPEE_ERROR_KIND.transient,
      httpStatus: 503,
      path: '/api/v2/product/get_item_base_info',
    });
    const a = cliente(() => {
      throw transitorio;
    });
    await expect(lerTemModelosDosComponentes(a.client, [COMPONENTE_A])).rejects.toBe(transitorio);

    // ⛔ NEAR-MISS: o mesmo código com kind `other` é o veredito — engolido.
    const b = cliente(() => {
      throw erroDeLote('error_item_not_found');
    });
    expect((await lerTemModelosDosComponentes(b.client, [COMPONENTE_A])).size).toBe(0);
  });

  it('sem cache: duas leituras seguidas pedem duas vezes (uma virada de has_model é vista)', async () => {
    let temModelo = false;
    const { client, getItemBaseInfo } = cliente(() =>
      payload({ item_id: COMPONENTE_B, has_model: temModelo }),
    );

    expect((await lerTemModelosDosComponentes(client, [COMPONENTE_B])).get(COMPONENTE_B)).toBe(
      false,
    );
    temModelo = true;
    expect((await lerTemModelosDosComponentes(client, [COMPONENTE_B])).get(COMPONENTE_B)).toBe(
      true,
    );
    expect(getItemBaseInfo).toHaveBeenCalledTimes(2);
  });
});

describe('itensDosComponentesDoKit', () => {
  it('lista o item de cada componente de cada modelo, na ordem, com repetições', () => {
    const kit = shopeeKitItemSchema.parse({
      item_id: 2500139870,
      model_list: [
        {
          model_id: 2000458820,
          component_list: [
            { component_item_id: COMPONENTE_A, component_model_id: MODELO_A, quantity: 2 },
            { component_item_id: COMPONENTE_B, component_model_id: MODELO_OCULTO_B, quantity: 1 },
          ],
        },
        {
          model_id: 2000458822,
          component_list: [
            { component_item_id: COMPONENTE_B, component_model_id: MODELO_OCULTO_B, quantity: 3 },
          ],
        },
      ],
    });

    expect(itensDosComponentesDoKit(kit)).toEqual([COMPONENTE_A, COMPONENTE_B, COMPONENTE_B]);
  });
});
