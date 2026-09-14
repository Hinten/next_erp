import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ORIGEM_INCIDENTE,
  TIPO_INCIDENTE,
  classificarIncidenteBloqueante,
  type ItemDoPedido,
  type OrigemIncidente,
  type Pedido,
  type TipoIncidente,
} from '@delfrance/schemas';

import { FakeDb, asDb, grpc } from '../testing/fakeDb';
import {
  SUBTIPO_NAO_VINCULADO,
  SUBTIPO_SKU_AMBIGUO,
  registrarLinhasSemProduto,
  type LinhaSemProdutoShopee,
} from './incidentesProduto';

/* -------------------------------------------------------------------------- */

const PEDIDO_ID = 'ped-1';
const ORDER_SN = '220810QSK8S7BX';
const AGORA_US = 1_700_000_000_000_000;
const UNIQUE_ID = 'f9fff5c4b3dbac919da0a3e076b5d37a3f04b5201a5edaa48a55a5f4876ed567';
const DOC_ID = `shopee-prod-${UNIQUE_ID}`;
const CAMINHO = `pedidos/${PEDIDO_ID}/incidentes/${DOC_ID}`;

function item(over: Partial<ItemDoPedido> = {}): ItemDoPedido {
  return {
    produtoUid: null,
    ordem: 0,
    ensureUniqueId: UNIQUE_ID,
    mktplaceId: '12984093',
    sku: 'CAM-P',
    gtin: null,
    nomeDeVenda: 'Camiseta Preta P',
    precoDeVenda: 15,
    descontoUnitario: 0,
    quantidade: 2,
    custo: null,
    timestamp: AGORA_US,
    imposto: null,
    ...over,
  };
}

function linha(over: Partial<LinhaSemProdutoShopee> = {}): LinhaSemProdutoShopee {
  return {
    item: item(),
    itemId: 846056136,
    modelId: 12984093,
    via: 'unresolved',
    ...over,
  };
}

function registrar(
  db: FakeDb,
  linhas: LinhaSemProdutoShopee[],
  itensGravados: Pedido['itens'] | null = null,
): Promise<number> {
  return registrarLinhasSemProduto(asDb(db), {
    pedidoId: PEDIDO_ID,
    orderSn: ORDER_SN,
    linhas,
    itensGravados,
    nowUs: AGORA_US,
  });
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */

describe('registrarLinhasSemProduto', () => {
  it('uma linha sem produto vira UM incidente no id determinístico shopee-prod-<ensureUniqueId>', async () => {
    const db = new FakeDb();
    expect(await registrar(db, [linha()])).toBe(1);

    const doc = db.store[CAMINHO]!.data;
    expect(doc).toMatchObject({
      origem: ORIGEM_INCIDENTE.outros,
      tipo: TIPO_INCIDENTE.outros,
      subtipo: SUBTIPO_NAO_VINCULADO,
      externalId: '12984093',
      timestamp: AGORA_US,
      ultimaModificacao: AGORA_US,
      comentarios: null,
      resolucao: null,
    });
  });

  it('nomeia o ANÚNCIO e a VARIAÇÃO separadamente — o mktplaceId sozinho é ambíguo', async () => {
    const db = new FakeDb();
    await registrar(db, [linha()]);
    const motivo = db.store[CAMINHO]!.data.motivoDoIncidente as string;
    expect(motivo).toContain('anúncio 846056136');
    expect(motivo).toContain('variação 12984093');
    expect(motivo).toContain('SKU CAM-P');
  });

  it('⚠️ model_id 0 é "sem variação" e nunca aparece como "variação 0"', async () => {
    const db = new FakeDb();
    await registrar(db, [linha({ modelId: 0 })]);
    const motivo = db.store[CAMINHO]!.data.motivoDoIncidente as string;
    expect(motivo).toContain('anúncio 846056136');
    expect(motivo).not.toContain('variação');
  });

  it('a segunda entrega do mesmo pedido não cria uma segunda linha (ALREADY_EXISTS engolido)', async () => {
    const db = new FakeDb();
    expect(await registrar(db, [linha()])).toBe(1);
    const carimbo = db.store[CAMINHO]!.data.timestamp;

    expect(
      await registrarLinhasSemProduto(asDb(db), {
        pedidoId: PEDIDO_ID,
        orderSn: ORDER_SN,
        linhas: [linha()],
        itensGravados: null,
        // Um relógio MAIS NOVO: se o create não fosse engolido, o carimbo mudaria.
        nowUs: AGORA_US + 60_000_000,
      }),
    ).toBe(0);
    expect(db.store[CAMINHO]!.data.timestamp).toBe(carimbo);
    expect(db.writes.filter((w) => w.path === CAMINHO)).toHaveLength(1);
  });

  it('⚠️ NEAR-MISS: só ALREADY_EXISTS é engolido — um PERMISSION_DENIED sobe', async () => {
    const db = new FakeDb();
    db.falhasDeCriacao.set(CAMINHO, grpc(7, 'PERMISSION_DENIED'));
    await expect(registrar(db, [linha()])).rejects.toThrow('PERMISSION_DENIED');
  });

  it('sku ambíguo e sku ausente compartilham o id e diferem no subtipo e no texto', async () => {
    const ausente = new FakeDb();
    await registrar(ausente, [linha({ via: 'unresolved' })]);
    const ambiguo = new FakeDb();
    await registrar(ambiguo, [linha({ via: 'ambiguous-sku' })]);

    expect(Object.keys(ausente.store)).toEqual(Object.keys(ambiguo.store));
    expect(ausente.store[CAMINHO]!.data.subtipo).toBe(SUBTIPO_NAO_VINCULADO);
    expect(ambiguo.store[CAMINHO]!.data.subtipo).toBe(SUBTIPO_SKU_AMBIGUO);
    expect(ambiguo.store[CAMINHO]!.data.motivoDoIncidente).toContain('mais de um produto');
    expect(ausente.store[CAMINHO]!.data.motivoDoIncidente).not.toContain('mais de um produto');
  });

  it('uma linha COM produtoUid não gera incidente', async () => {
    const db = new FakeDb();
    expect(await registrar(db, [linha({ item: item({ produtoUid: 'prod-A' }) })])).toBe(0);
    expect(db.writes).toEqual([]);
  });

  it('uma linha JÁ GRAVADA com produtoUid não gera incidente, mesmo resolvendo nada agora', async () => {
    const db = new FakeDb();
    const gravados: Pedido['itens'] = {
      'prod-legado': [item({ produtoUid: 'prod-legado' })],
    };
    expect(await registrar(db, [linha()], gravados)).toBe(0);
    expect(db.writes).toEqual([]);
  });

  it('⚠️ NEAR-MISS: uma linha gravada SEM produtoUid ainda gera o incidente', async () => {
    const db = new FakeDb();
    const gravados: Pedido['itens'] = { NONE: [item({ produtoUid: null })] };
    expect(await registrar(db, [linha()], gravados)).toBe(1);
  });

  it('uma linha sem ensureUniqueId é ignorada — não há id determinístico para ela', async () => {
    const db = new FakeDb();
    expect(await registrar(db, [linha({ item: item({ ensureUniqueId: null }) })])).toBe(0);
    expect(db.writes).toEqual([]);
  });

  it('duas linhas sem produto geram DOIS incidentes, um por ensureUniqueId', async () => {
    const db = new FakeDb();
    const outro = 'b'.repeat(64);
    expect(await registrar(db, [linha(), linha({ item: item({ ensureUniqueId: outro }) })])).toBe(
      2,
    );
    expect(Object.keys(db.store).sort()).toEqual(
      [CAMINHO, `pedidos/${PEDIDO_ID}/incidentes/shopee-prod-${outro}`].sort(),
    );
  });
});

describe('o tipo escolhido nunca bloqueia', () => {
  it('tipo "o" + origem 99 não entram no overlay de bloqueio', async () => {
    const db = new FakeDb();
    await registrar(db, [linha()]);
    const doc = db.store[CAMINHO]!.data;
    expect(
      classificarIncidenteBloqueante({
        origem: doc.origem as OrigemIncidente,
        tipo: doc.tipo as TipoIncidente,
        claimStatus: null,
        resolucao: null,
        entregue: null,
      }),
    ).toBe(null);
  });

  it('o par igual: um incidente de devolução do Mercado Livre BLOQUEIA', () => {
    // Sem esta metade, o teste acima passaria mesmo se o classificador sempre
    // respondesse null.
    expect(
      classificarIncidenteBloqueante({
        origem: ORIGEM_INCIDENTE.pedidoMercadoLivre,
        tipo: TIPO_INCIDENTE.devolucao,
        claimStatus: null,
        resolucao: null,
        entregue: null,
      }),
    ).toBe('devolucao');
  });
});

describe('o log', () => {
  it('sai só quando algo foi criado e não carrega o nome do produto', async () => {
    const info = vi.spyOn(console, 'info');
    const db = new FakeDb();
    await registrar(db, [linha()]);
    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(info.mock.calls[0])).not.toContain('Camiseta');

    info.mockClear();
    await registrar(db, [linha()]);
    expect(info).not.toHaveBeenCalled();
  });
});
