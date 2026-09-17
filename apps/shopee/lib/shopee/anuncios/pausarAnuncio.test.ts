import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_UNLIST_MAX_ITEMS,
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeRateLimitError,
  type ShopeeClient,
  type ShopeeItemBaseInfo,
  type ShopeeItemWriteResponse,
  type ShopeeUnlistItemRequest,
  type ShopeeUnlistItemResponse,
  type ShopeeUpdateItemRequest,
} from '@delfrance/integrations-shopee';
import {
  ACAO_STATUS_ANUNCIO,
  ESTADO_ANUNCIO_SHOPEE,
  SHOPEE_ITEM_STATUS,
  type AcaoStatusAnuncio,
  type EstadoAnuncioShopee,
} from '@delfrance/schemas';
import { produtoShopeeLinkCollection } from '@delfrance/data/admin/collections';

import { FakeDb, asDb, increment } from '../testing/fakeDb';
import {
  MOTIVO_STATUS_ANUNCIO,
  definirStatusAnunciosShopee,
  ordemDasPortas,
  proximaViradaDaCotaMs,
  type AnuncioStatusInput,
  type AnuncioStatusResponse,
  type PausarAnuncioDeps,
} from './pausarAnuncio';

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented ids only. Never a real partner, shop, item or buyer.   */
/* -------------------------------------------------------------------------- */

const INTEGRACAO = 'int-1';
const REF_CONTA = `documents/integracao/${INTEGRACAO}`;
const REF_OUTRA_CONTA = 'documents/integracao/int-2';

const PRODUTO_A = 'prod-a';
const PRODUTO_B = 'prod-b';
const PRODUTO_C = 'prod-c';
const ITEM_A = 2500139861;
const ITEM_B = 2500139862;
const ITEM_C = 2500139863;

const AGORA = 1_757_000_000_000;

const PAUSAR = ACAO_STATUS_ANUNCIO.pausar;
const REATIVAR = ACAO_STATUS_ANUNCIO.reativar;

function caminhoDoLink(produtoId: string, linkId = 'link-1'): string {
  return `produtos/${produtoId}/prodshopee/${linkId}`;
}

function semearProduto(db: FakeDb, produtoId: string, nome: string): void {
  db.seed(`produtos/${produtoId}`, { nome, paiId: null });
}

function semearLink(
  db: FakeDb,
  produtoId: string,
  itemId: number | null,
  extra: Record<string, unknown> = {},
  linkId = 'link-1',
): void {
  db.seed(caminhoDoLink(produtoId, linkId), {
    contaProdutoShopeeOuterRef: REF_CONTA,
    item_name: 'Camiseta Básica',
    item_id: itemId,
    ...extra,
  });
}

/** Produto + link + a folded estado, the shape every happy-path case starts from. */
function semearTudo(
  db: FakeDb,
  produtoId: string,
  itemId: number,
  estadoAnuncio: EstadoAnuncioShopee | null = ESTADO_ANUNCIO_SHOPEE.ativo,
): void {
  semearProduto(db, produtoId, `Produto ${produtoId}`);
  semearLink(db, produtoId, itemId, { estadoAnuncio, item_status: SHOPEE_ITEM_STATUS.normal });
}

/* ------------------------------ the wire doubles --------------------------- */

interface LinhaDeFalha {
  readonly item_id: number;
  readonly failed_reason: string | null;
}

/**
 * ⚠️ `success_list[].unlist` is hardcoded `true` here on purpose: it ECHOES the
 * request flag and is not a status, so every fixture that uses it is also a trap
 * for a module that read the status off it.
 */
function envelopeUnlist(
  sucessos: readonly number[],
  falhas: readonly LinhaDeFalha[] = [],
): ShopeeUnlistItemResponse {
  return {
    error: '',
    message: '',
    request_id: 'req-1',
    response: {
      success_list: sucessos.map((item_id) => ({ item_id, unlist: true })),
      failure_list: [...falhas],
    },
  } as unknown as ShopeeUnlistItemResponse;
}

function linhaBase(itemId: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    item_id: itemId,
    item_name: 'Camiseta Básica',
    item_status: SHOPEE_ITEM_STATUS.normal,
    deboost: false,
    condition: 'NEW',
    has_model: false,
    scheduled_publish_time: null,
    ...over,
  };
}

function releitura(linhas: readonly (Record<string, unknown> | null)[]): ShopeeItemBaseInfo {
  return { item_list: linhas } as unknown as ShopeeItemBaseInfo;
}

interface OpcoesCliente {
  readonly unlist?: (body: ShopeeUnlistItemRequest) => ShopeeUnlistItemResponse;
  readonly update?: (body: ShopeeUpdateItemRequest) => void;
  readonly base?: (p: { itemIds: readonly number[] }) => ShopeeItemBaseInfo;
}

interface ClienteFake {
  readonly client: ShopeeClient;
  readonly unlists: ShopeeUnlistItemRequest[];
  readonly updates: ShopeeUpdateItemRequest[];
  readonly releituras: { itemIds: readonly number[] }[];
  /** Every operation name in CALL order — the `opLog` of the Shopee side. */
  readonly ops: string[];
}

/**
 * A `ShopeeClient` that answers only the three operations this module owns. Any
 * other member is absent on purpose: reaching for one is a routing bug, and a
 * `TypeError` naming it beats a silent `undefined`. An operation the case did not
 * arrange throws, so "never calls X" is checkable without a spy.
 */
function clienteFake(op: OpcoesCliente = {}): ClienteFake {
  const unlists: ShopeeUnlistItemRequest[] = [];
  const updates: ShopeeUpdateItemRequest[] = [];
  const releituras: { itemIds: readonly number[] }[] = [];
  const ops: string[] = [];
  const client = {
    unlistItem: (body: ShopeeUnlistItemRequest) => {
      ops.push('unlist_item');
      unlists.push(body);
      if (op.unlist === undefined) throw new Error('fixture: unlistItem inesperado');
      return Promise.resolve(op.unlist(body));
    },
    updateItem: (body: ShopeeUpdateItemRequest) => {
      ops.push('update_item');
      updates.push(body);
      if (op.update === undefined) throw new Error('fixture: updateItem inesperado');
      op.update(body);
      return Promise.resolve({} as unknown as ShopeeItemWriteResponse);
    },
    getItemBaseInfo: (p: { itemIds: readonly number[] }) => {
      ops.push('get_item_base_info');
      releituras.push(p);
      if (op.base === undefined) throw new Error('fixture: getItemBaseInfo inesperado');
      return Promise.resolve(op.base(p));
    },
  } as unknown as ShopeeClient;
  return { client, unlists, updates, releituras, ops };
}

function deps(client: ShopeeClient, nowMs = AGORA): PausarAnuncioDeps {
  return { clientFor: () => Promise.resolve(client), increment, nowMs };
}

function entrada(over: Partial<AnuncioStatusInput> = {}): AnuncioStatusInput {
  return { integracaoId: INTEGRACAO, produtoIds: [PRODUTO_A], acao: PAUSAR, ...over };
}

function erroApi(code: string): ShopeeApiError {
  return new ShopeeApiError(`Shopee /product/update_item respondeu ${code} (HTTP 200)`, {
    code,
    kind: SHOPEE_ERROR_KIND.other,
    httpStatus: 200,
    path: '/api/v2/product/update_item',
  });
}

function limite(kind: 'burst' | 'daily'): ShopeeRateLimitError {
  return new ShopeeRateLimitError('Shopee respondeu error_limit (HTTP 200)', {
    code: 'error_limit',
    kind,
    httpStatus: 200,
    path: '/api/v2/product/unlist_item',
  });
}

/** The listing row for one produto, or a loud failure. */
function linhaDe(res: AnuncioStatusResponse, produtoId: string) {
  const linha = res.listings.find((l) => l.produtoId === produtoId);
  if (linha === undefined) throw new Error(`fixture: nenhuma listing para ${produtoId}`);
  return linha;
}

/** Every `update` patch the run issued against one link document. */
function patchesDoLink(db: FakeDb, produtoId: string, linkId = 'link-1') {
  return db.patches.filter((p) => p.path === caminhoDoLink(produtoId, linkId)).map((p) => p.patch);
}

const infos: unknown[][] = [];
const avisos: unknown[][] = [];

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    infos.push(args);
  });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    avisos.push(args);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  infos.length = 0;
  avisos.length = 0;
});

/* -------------------------------------------------------------------------- */
/*  (1) the batch                                                             */
/* -------------------------------------------------------------------------- */

describe('definirStatusAnunciosShopee — o lote', () => {
  it('uma seleção de 3 produtos gera UMA chamada unlist_item com os 3 item_id', async () => {
    const db = new FakeDb();
    semearTudo(db, PRODUTO_A, ITEM_A);
    semearTudo(db, PRODUTO_B, ITEM_B);
    semearTudo(db, PRODUTO_C, ITEM_C);
    const fake = clienteFake({
      unlist: () => envelopeUnlist([ITEM_A, ITEM_B, ITEM_C]),
      base: () =>
        releitura([
          linhaBase(ITEM_A, { item_status: SHOPEE_ITEM_STATUS.unlist }),
          linhaBase(ITEM_B, { item_status: SHOPEE_ITEM_STATUS.unlist }),
          linhaBase(ITEM_C, { item_status: SHOPEE_ITEM_STATUS.unlist }),
        ]),
    });

    const res = await definirStatusAnunciosShopee(
      asDb(db),
      entrada({ produtoIds: [PRODUTO_A, PRODUTO_B, PRODUTO_C] }),
      deps(fake.client),
    );

    expect(fake.unlists).toHaveLength(1);
    expect(fake.unlists[0]?.item_list).toEqual([
      { item_id: ITEM_A, unlist: true },
      { item_id: ITEM_B, unlist: true },
      { item_id: ITEM_C, unlist: true },
    ]);
    expect(res.resumo).toEqual({ aplicados: 3, pulados: 0, falhas: 0, naoTentados: 0 });
    expect(res.familias).toBe(3);
    expect(res.solicitados).toBe(3);
  });

  it('um produtoId repetido é deduplicado antes de virar chamada', async () => {
    const db = new FakeDb();
    semearTudo(db, PRODUTO_A, ITEM_A);
    const fake = clienteFake({
      unlist: () => envelopeUnlist([ITEM_A]),
      base: () => releitura([linhaBase(ITEM_A, { item_status: SHOPEE_ITEM_STATUS.unlist })]),
    });

    const res = await definirStatusAnunciosShopee(
      asDb(db),
      entrada({ produtoIds: [PRODUTO_A, PRODUTO_A, PRODUTO_A] }),
      deps(fake.client),
    );

    expect(res.solicitados).toBe(1);
    expect(fake.unlists[0]?.item_list).toHaveLength(1);
  });

  it('⚠️ 51 produtos RECUSAM a requisição inteira — a seleção nunca é truncada', async () => {
    const db = new FakeDb();
    const muitos = Array.from(
      { length: SHOPEE_UNLIST_MAX_ITEMS + 1 },
      (_, i) => `prod-${String(i)}`,
    );
    const fake = clienteFake();

    await expect(
      definirStatusAnunciosShopee(asDb(db), entrada({ produtoIds: muitos }), deps(fake.client)),
    ).rejects.toThrow(ShopeeConfigError);
    // Nothing was read and nothing was sent: the refusal is BEFORE any work.
    expect(fake.ops).toEqual([]);
    expect(db.caminhos).toEqual([]);
  });

  it('o limite vem do pacote (SHOPEE_UNLIST_MAX_ITEMS), e exatamente 50 passa', () => {
    expect(SHOPEE_UNLIST_MAX_ITEMS).toBe(50);
  });

  it('linkDocId com mais de um produtoId é recusado como bug de chamador', async () => {
    const db = new FakeDb();
    const fake = clienteFake();
    await expect(
      definirStatusAnunciosShopee(
        asDb(db),
        entrada({ produtoIds: [PRODUTO_A, PRODUTO_B], linkDocId: 'link-1' }),
        deps(fake.client),
      ),
    ).rejects.toThrow(ShopeeConfigError);
  });
});

/* -------------------------------------------------------------------------- */
/*  (2) the read-back is the only status source                                */
/* -------------------------------------------------------------------------- */

describe('definirStatusAnunciosShopee — a releitura manda', () => {
  it('⚠️ o item_status escrito vem da RELEITURA, nunca do success_list.unlist', async () => {
    const db = new FakeDb();
    // A re-list whose echo says `unlist: true` and whose READ-BACK says NORMAL.
    semearTudo(db, PRODUTO_A, ITEM_A, ESTADO_ANUNCIO_SHOPEE.pausado);
    const fake = clienteFake({
      unlist: () => envelopeUnlist([ITEM_A]),
      base: () => releitura([linhaBase(ITEM_A, { item_status: SHOPEE_ITEM_STATUS.normal })]),
    });

    const res = await definirStatusAnunciosShopee(
      asDb(db),
      entrada({ acao: REATIVAR }),
      deps(fake.client),
    );

    expect(patchesDoLink(db, PRODUTO_A)).toEqual([
      {
        item_status: SHOPEE_ITEM_STATUS.normal,
        estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
        deboost: false,
        pausadoPeloErp: false,
        ultimaModificacao: AGORA,
      },
    ]);
    expect(linhaDe(res, PRODUTO_A).statusFinal).toBe(SHOPEE_ITEM_STATUS.normal);
    expect(linhaDe(res, PRODUTO_A).estadoAnuncio).toBe(ESTADO_ANUNCIO_SHOPEE.ativo);
  });

  it('a releitura é UMA chamada get_item_base_info com os ids aceitos, nunca get_item_list', async () => {
    const db = new FakeDb();
    semearTudo(db, PRODUTO_A, ITEM_A);
    semearTudo(db, PRODUTO_B, ITEM_B);
    const fake = clienteFake({
      unlist: () => envelopeUnlist([ITEM_A, ITEM_B]),
      base: () =>
        releitura([
          linhaBase(ITEM_A, { item_status: SHOPEE_ITEM_STATUS.unlist }),
          linhaBase(ITEM_B, { item_status: SHOPEE_ITEM_STATUS.unlist }),
        ]),
    });

    await definirStatusAnunciosShopee(
      asDb(db),
      entrada({ produtoIds: [PRODUTO_A, PRODUTO_B] }),
      deps(fake.client),
    );

    expect(fake.releituras).toEqual([{ itemIds: [ITEM_A, ITEM_B] }]);
    expect(fake.ops).toEqual(['unlist_item', 'get_item_base_info']);
    // `getItemList` is not even a member of the double: a call would TypeError.
    expect('getItemList' in (fake.client as unknown as Record<string, unknown>)).toBe(false);
  });

  it('⚠️ um id aceito ausente da releitura é FALHA, e nada é escrito para ele', async () => {
    const db = new FakeDb();
    semearTudo(db, PRODUTO_A, ITEM_A);
    semearTudo(db, PRODUTO_B, ITEM_B);
    const fake = clienteFake({
      unlist: () => envelopeUnlist([ITEM_A, ITEM_B]),
      // B answered; A did not come back at all.
      base: () => releitura([linhaBase(ITEM_B, { item_status: SHOPEE_ITEM_STATUS.unlist })]),
    });

    const res = await definirStatusAnunciosShopee(
      asDb(db),
      entrada({ produtoIds: [PRODUTO_A, PRODUTO_B] }),
      deps(fake.client),
    );

    expect(linhaDe(res, PRODUTO_A)).toMatchObject({
      outcome: 'falha',
      motivo: MOTIVO_STATUS_ANUNCIO.semLeituraApos,
      statusFinal: SHOPEE_ITEM_STATUS.normal, // the STORED reading, not a new one
    });
    expect(patchesDoLink(db, PRODUTO_A)).toEqual([]);
    expect(patchesDoLink(db, PRODUTO_B)).toHaveLength(1);
    expect(linhaDe(res, PRODUTO_B).outcome).toBe('enviado');
  });

  it('⚠️ uma linha ILEGÍVEL (o sentinela null por linha) conta como ausente', async () => {
    const db = new FakeDb();
    semearTudo(db, PRODUTO_A, ITEM_A);
    const fake = clienteFake({
      unlist: () => envelopeUnlist([ITEM_A]),
      base: () => releitura([null]),
    });

    const res = await definirStatusAnunciosShopee(asDb(db), entrada(), deps(fake.client));

    expect(linhaDe(res, PRODUTO_A).motivo).toBe(MOTIVO_STATUS_ANUNCIO.semLeituraApos);
    expect(patchesDoLink(db, PRODUTO_A)).toEqual([]);
  });

  it('⚠️ o patch de ciclo de vida é PLANO — mergeIfExists lança em objeto aninhado', async () => {
    const db = new FakeDb();
    semearTudo(db, PRODUTO_A, ITEM_A);
    const fake = clienteFake({
      unlist: () => envelopeUnlist([ITEM_A]),
      base: () => releitura([linhaBase(ITEM_A, { item_status: SHOPEE_ITEM_STATUS.unlist })]),
    });

    await definirStatusAnunciosShopee(asDb(db), entrada(), deps(fake.client));

    const patch = patchesDoLink(db, PRODUTO_A)[0];
    expect(patch).toBeDefined();
    for (const [chave, valor] of Object.entries(patch ?? {})) {
      expect(chave).not.toContain('.');
      expect(
        valor === null || typeof valor !== 'object' || Array.isArray(valor),
        `${chave} é um objeto aninhado`,
      ).toBe(true);
    }
    // The MECHANISM, proven against the real handle: adding `falhaPublicacao` (or
    // `ultimaPublicacao`) to a lifecycle patch is a runtime TypeError, not a
    // subtly different write.
    await expect(
      produtoShopeeLinkCollection.mergeIfExists(asDb(db), { produtoId: PRODUTO_A }, 'link-1', {
        falhaPublicacao: { em: AGORA, etapa: 'add_item', erro: 'x', mensagem: 'y', problemas: [] },
      }),
    ).rejects.toThrow(TypeError);
  });
});

/* -------------------------------------------------------------------------- */
/*  (3)(4)(5) discovery and the pre-check                                      */
/* -------------------------------------------------------------------------- */

describe('definirStatusAnunciosShopee — descoberta e pré-checagem', () => {
  it('um produto sem link entra em produtosSemAnuncio e não custa chamada nenhuma', async () => {
    const db = new FakeDb();
    semearProduto(db, PRODUTO_A, 'Camiseta sem anúncio');
    const fake = clienteFake();

    const res = await definirStatusAnunciosShopee(asDb(db), entrada(), deps(fake.client));

    expect(res.produtosSemAnuncio).toEqual([
      {
        produtoId: PRODUTO_A,
        produtoNome: 'Camiseta sem anúncio',
        motivo: MOTIVO_STATUS_ANUNCIO.semAnuncio,
        mensagem: expect.stringContaining('não tem anúncio') as unknown as string,
      },
    ]);
    expect(res.listings).toEqual([]);
    expect(fake.ops).toEqual([]);
  });

  it('um link de OUTRA conta não é alvo — o produto conta como sem anúncio', async () => {
    const db = new FakeDb();
    semearProduto(db, PRODUTO_A, 'Camiseta de outra conta');
    db.seed(caminhoDoLink(PRODUTO_A), {
      contaProdutoShopeeOuterRef: REF_OUTRA_CONTA,
      item_name: 'Camiseta Básica',
      item_id: ITEM_A,
    });
    const fake = clienteFake();

    const res = await definirStatusAnunciosShopee(asDb(db), entrada(), deps(fake.client));

    expect(res.produtosSemAnuncio).toHaveLength(1);
    expect(fake.ops).toEqual([]);
  });

  const PRE_CHECAGEM: readonly {
    readonly motivo: string;
    readonly itemId: number | null;
    readonly estado: EstadoAnuncioShopee | null;
    readonly acao: AcaoStatusAnuncio;
  }[] = [
    { motivo: MOTIVO_STATUS_ANUNCIO.semItemId, itemId: null, estado: null, acao: PAUSAR },
    {
      motivo: MOTIVO_STATUS_ANUNCIO.anuncioRemovido,
      itemId: ITEM_A,
      estado: ESTADO_ANUNCIO_SHOPEE.removido,
      acao: PAUSAR,
    },
    {
      motivo: MOTIVO_STATUS_ANUNCIO.anuncioBanido,
      itemId: ITEM_A,
      estado: ESTADO_ANUNCIO_SHOPEE.banido,
      acao: PAUSAR,
    },
    {
      motivo: MOTIVO_STATUS_ANUNCIO.anuncioEmRevisao,
      itemId: ITEM_A,
      estado: ESTADO_ANUNCIO_SHOPEE.emRevisao,
      acao: PAUSAR,
    },
    {
      motivo: MOTIVO_STATUS_ANUNCIO.anuncioAgendado,
      itemId: ITEM_A,
      estado: ESTADO_ANUNCIO_SHOPEE.agendado,
      acao: REATIVAR,
    },
    {
      motivo: MOTIVO_STATUS_ANUNCIO.jaPausado,
      itemId: ITEM_A,
      estado: ESTADO_ANUNCIO_SHOPEE.pausado,
      acao: PAUSAR,
    },
    {
      motivo: MOTIVO_STATUS_ANUNCIO.jaAtivo,
      itemId: ITEM_A,
      estado: ESTADO_ANUNCIO_SHOPEE.ativo,
      acao: REATIVAR,
    },
  ];

  it.each(PRE_CHECAGEM)(
    'um anúncio $motivo é PULADO antes da chamada',
    async ({ motivo, itemId, estado, acao }) => {
      const db = new FakeDb();
      semearProduto(db, PRODUTO_A, 'Camiseta Básica');
      semearLink(db, PRODUTO_A, itemId, { estadoAnuncio: estado });
      const fake = clienteFake();

      const res = await definirStatusAnunciosShopee(asDb(db), entrada({ acao }), deps(fake.client));

      expect(linhaDe(res, PRODUTO_A)).toMatchObject({ outcome: 'pulado', motivo });
      expect(linhaDe(res, PRODUTO_A).mensagem.length).toBeGreaterThan(10);
      expect(fake.ops).toEqual([]);
      expect(db.patches).toEqual([]);
      expect(res.resumo).toEqual({ aplicados: 0, pulados: 1, falhas: 0, naoTentados: 0 });
    },
  );

  it('⚠️ NEAR-MISS: estadoAnuncio null NÃO é pulado — vai para a Shopee', async () => {
    const db = new FakeDb();
    semearProduto(db, PRODUTO_A, 'Camiseta importada pelo passo 9');
    semearLink(db, PRODUTO_A, ITEM_A, { estadoAnuncio: null });
    const fake = clienteFake({
      unlist: () => envelopeUnlist([ITEM_A]),
      base: () => releitura([linhaBase(ITEM_A, { item_status: SHOPEE_ITEM_STATUS.unlist })]),
    });

    const res = await definirStatusAnunciosShopee(asDb(db), entrada(), deps(fake.client));

    expect(fake.unlists).toHaveLength(1);
    expect(linhaDe(res, PRODUTO_A).outcome).toBe('enviado');
  });

  it('pausadoPeloErp vira true num pausar bem-sucedido, e NÃO se move num pulado', async () => {
    const db = new FakeDb();
    semearTudo(db, PRODUTO_A, ITEM_A);
    semearProduto(db, PRODUTO_B, 'Já pausado');
    semearLink(db, PRODUTO_B, ITEM_B, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado });
    const fake = clienteFake({
      unlist: () => envelopeUnlist([ITEM_A]),
      base: () => releitura([linhaBase(ITEM_A, { item_status: SHOPEE_ITEM_STATUS.unlist })]),
    });

    await definirStatusAnunciosShopee(
      asDb(db),
      entrada({ produtoIds: [PRODUTO_A, PRODUTO_B] }),
      deps(fake.client),
    );

    expect(patchesDoLink(db, PRODUTO_A)[0]).toMatchObject({ pausadoPeloErp: true });
    expect(patchesDoLink(db, PRODUTO_B)).toEqual([]);
  });

  it('⚠️ uma FALHA não move pausadoPeloErp, mas grava o estado que acabou de ler', async () => {
    const db = new FakeDb();
    semearTudo(db, PRODUTO_A, ITEM_A);
    const fake = clienteFake({
      unlist: () =>
        envelopeUnlist([], [{ item_id: ITEM_A, failed_reason: 'error_unlist_in_promotion' }]),
      base: () => releitura([linhaBase(ITEM_A, { item_status: SHOPEE_ITEM_STATUS.normal })]),
    });

    const res = await definirStatusAnunciosShopee(asDb(db), entrada(), deps(fake.client));

    const patch = patchesDoLink(db, PRODUTO_A)[0];
    expect(patch).toBeDefined();
    expect(Object.keys(patch ?? {})).not.toContain('pausadoPeloErp');
    expect(patch).toMatchObject({
      item_status: SHOPEE_ITEM_STATUS.normal,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    });
    expect(linhaDe(res, PRODUTO_A).outcome).toBe('falha');
  });
});

/* -------------------------------------------------------------------------- */
/*  (6)(7)(8) per-entry refusals are DATA                                      */
/* -------------------------------------------------------------------------- */

describe('definirStatusAnunciosShopee — recusas por entrada', () => {
  it('todas as entradas recusadas ainda respondem 200 com os motivos como DADOS', async () => {
    const db = new FakeDb();
    semearTudo(db, PRODUTO_A, ITEM_A);
    semearTudo(db, PRODUTO_B, ITEM_B);
    const fake = clienteFake({
      unlist: () =>
        envelopeUnlist(
          [],
          [
            { item_id: ITEM_A, failed_reason: 'error_unlist_in_promotion' },
            { item_id: ITEM_B, failed_reason: 'error_holiday_on_del_item' },
          ],
        ),
      base: () => releitura([linhaBase(ITEM_A), linhaBase(ITEM_B)]),
    });

    const res = await definirStatusAnunciosShopee(
      asDb(db),
      entrada({ produtoIds: [PRODUTO_A, PRODUTO_B] }),
      deps(fake.client),
    );

    expect(res.resumo).toEqual({ aplicados: 0, pulados: 0, falhas: 2, naoTentados: 0 });
    expect(linhaDe(res, PRODUTO_A).motivo).toBe(MOTIVO_STATUS_ANUNCIO.bloqueadoPorPromocao);
    expect(linhaDe(res, PRODUTO_B).motivo).toBe(MOTIVO_STATUS_ANUNCIO.lojaEmFerias);
  });

  const GRAFIAS_DE_PROMOCAO = [
    'error_cannt_unlisted_in_promotion',
    'error_in_item_promotion_unlsit_lock',
    'error_unlist_in_promotion',
  ] as const;

  it.each(GRAFIAS_DE_PROMOCAO)(
    'as TRÊS grafias do bloqueio por promoção classificam igual (%s)',
    async (grafia) => {
      const db = new FakeDb();
      semearTudo(db, PRODUTO_A, ITEM_A);
      const fake = clienteFake({
        unlist: () => envelopeUnlist([], [{ item_id: ITEM_A, failed_reason: grafia }]),
        base: () => releitura([linhaBase(ITEM_A)]),
      });

      const res = await definirStatusAnunciosShopee(asDb(db), entrada(), deps(fake.client));

      expect(linhaDe(res, PRODUTO_A)).toMatchObject({
        outcome: 'falha',
        motivo: MOTIVO_STATUS_ANUNCIO.bloqueadoPorPromocao,
      });
      expect(linhaDe(res, PRODUTO_A).mensagem).toContain('promoção');
    },
  );

  it('⚠️ NEAR-MISS: uma quarta grafia inventada NÃO classifica — cai no verbatim', async () => {
    const db = new FakeDb();
    semearTudo(db, PRODUTO_A, ITEM_A);
    const inventada = 'error_unlist_promotion_lock';
    const fake = clienteFake({
      unlist: () => envelopeUnlist([], [{ item_id: ITEM_A, failed_reason: inventada }]),
      base: () => releitura([linhaBase(ITEM_A)]),
    });

    const res = await definirStatusAnunciosShopee(asDb(db), entrada(), deps(fake.client));

    expect(linhaDe(res, PRODUTO_A).motivo).toBe(inventada);
    expect(linhaDe(res, PRODUTO_A).motivo).not.toBe(MOTIVO_STATUS_ANUNCIO.bloqueadoPorPromocao);
    expect(linhaDe(res, PRODUTO_A).mensagem).toBe(`A Shopee recusou: ${inventada}`);
  });

  it('uma frase que EMBUTE o token classifica — failed_reason é uma sentença', async () => {
    const db = new FakeDb();
    semearTudo(db, PRODUTO_A, ITEM_A);
    const fake = clienteFake({
      unlist: () =>
        envelopeUnlist(
          [],
          [
            {
              item_id: ITEM_A,
              failed_reason: 'Item is locked: error_in_item_promotion_unlsit_lock, try later',
            },
          ],
        ),
      base: () => releitura([linhaBase(ITEM_A)]),
    });

    const res = await definirStatusAnunciosShopee(asDb(db), entrada(), deps(fake.client));

    expect(linhaDe(res, PRODUTO_A).motivo).toBe(MOTIVO_STATUS_ANUNCIO.bloqueadoPorPromocao);
  });

  it('um error_param prefixado por "product." classifica como o bare', async () => {
    const db = new FakeDb();
    semearTudo(db, PRODUTO_A, ITEM_A);
    semearTudo(db, PRODUTO_B, ITEM_B);
    const fake = clienteFake({
      unlist: () =>
        envelopeUnlist(
          [],
          [
            { item_id: ITEM_A, failed_reason: 'product.error_param' },
            { item_id: ITEM_B, failed_reason: 'error_param' },
          ],
        ),
      base: () => releitura([linhaBase(ITEM_A), linhaBase(ITEM_B)]),
    });

    const res = await definirStatusAnunciosShopee(
      asDb(db),
      entrada({ produtoIds: [PRODUTO_A, PRODUTO_B] }),
      deps(fake.client),
    );

    expect(linhaDe(res, PRODUTO_A).motivo).toBe('error_param');
    expect(linhaDe(res, PRODUTO_B).motivo).toBe('error_param');
  });

  it('um anúncio banido que a pré-checagem não viu vem da Shopee como falha própria', async () => {
    const db = new FakeDb();
    semearTudo(db, PRODUTO_A, ITEM_A);
    const fake = clienteFake({
      unlist: () =>
        envelopeUnlist(
          [],
          [
            {
              item_id: ITEM_A,
              failed_reason: 'error_busi_cannot_delist_reviewing_or_banned_item',
            },
          ],
        ),
      base: () => releitura([linhaBase(ITEM_A, { item_status: SHOPEE_ITEM_STATUS.banned })]),
    });

    const res = await definirStatusAnunciosShopee(asDb(db), entrada(), deps(fake.client));

    expect(linhaDe(res, PRODUTO_A)).toMatchObject({
      outcome: 'falha',
      motivo: MOTIVO_STATUS_ANUNCIO.anuncioBanidoOuEmRevisao,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.banido,
    });
  });

  it('uma recusa reconciliada POR item_id, nunca por posição', async () => {
    const db = new FakeDb();
    semearTudo(db, PRODUTO_A, ITEM_A);
    semearTudo(db, PRODUTO_B, ITEM_B);
    const fake = clienteFake({
      // The order is INVERTED relative to the request.
      unlist: () =>
        envelopeUnlist([ITEM_B], [{ item_id: ITEM_A, failed_reason: 'error_unlist_in_promotion' }]),
      base: () =>
        releitura([
          linhaBase(ITEM_B, { item_status: SHOPEE_ITEM_STATUS.unlist }),
          linhaBase(ITEM_A),
        ]),
    });

    const res = await definirStatusAnunciosShopee(
      asDb(db),
      entrada({ produtoIds: [PRODUTO_A, PRODUTO_B] }),
      deps(fake.client),
    );

    expect(linhaDe(res, PRODUTO_A).outcome).toBe('falha');
    expect(linhaDe(res, PRODUTO_B).outcome).toBe('enviado');
  });
});

/* -------------------------------------------------------------------------- */
/*  (9)(10) the two doors                                                      */
/* -------------------------------------------------------------------------- */

describe('definirStatusAnunciosShopee — as duas portas', () => {
  it('ordemDasPortas: pausar tem UMA porta; reativar segue o literal, e o literal invertido troca', () => {
    expect(ordemDasPortas(PAUSAR)).toEqual(['unlist']);
    expect(ordemDasPortas(PAUSAR, 'update_item')).toEqual(['unlist']);
    expect(ordemDasPortas(REATIVAR, 'unlist')).toEqual(['unlist', 'update_item']);
    expect(ordemDasPortas(REATIVAR, 'update_item')).toEqual(['update_item', 'unlist']);
  });

  it("reativar recusado com error_set_normal_unlisted_item cai para update_item {item_status:'NORMAL'} — e só isso vai no corpo", async () => {
    const db = new FakeDb();
    semearTudo(db, PRODUTO_A, ITEM_A, ESTADO_ANUNCIO_SHOPEE.pausado);
    const fake = clienteFake({
      unlist: () =>
        envelopeUnlist([], [{ item_id: ITEM_A, failed_reason: 'error_set_normal_unlisted_item' }]),
      update: () => undefined,
      base: () => releitura([linhaBase(ITEM_A, { item_status: SHOPEE_ITEM_STATUS.normal })]),
    });

    const res = await definirStatusAnunciosShopee(
      asDb(db),
      entrada({ acao: REATIVAR }),
      deps(fake.client),
    );

    expect(fake.ops).toEqual(['unlist_item', 'update_item', 'get_item_base_info']);
    expect(fake.updates).toEqual([{ item_id: ITEM_A, item_status: 'NORMAL' }]);
    // EXACTLY two keys — a status bundled with other fields is silently ignored
    // on some listings.
    expect(Object.keys(fake.updates[0] ?? {})).toEqual(['item_id', 'item_status']);
    expect(linhaDe(res, PRODUTO_A)).toMatchObject({ outcome: 'enviado', motivo: null });
  });

  it('⚠️ quando as DUAS portas recusam, a entrada é falha com o código real — nunca uma terceira tentativa', async () => {
    const db = new FakeDb();
    semearTudo(db, PRODUTO_A, ITEM_A, ESTADO_ANUNCIO_SHOPEE.pausado);
    const fake = clienteFake({
      unlist: () =>
        envelopeUnlist([], [{ item_id: ITEM_A, failed_reason: 'error_set_normal_unlisted_item' }]),
      update: () => {
        throw erroApi('product.error_busi');
      },
      base: () => releitura([linhaBase(ITEM_A, { item_status: SHOPEE_ITEM_STATUS.unlist })]),
    });

    const res = await definirStatusAnunciosShopee(
      asDb(db),
      entrada({ acao: REATIVAR }),
      deps(fake.client),
    );

    expect(fake.ops).toEqual(['unlist_item', 'update_item', 'get_item_base_info']);
    expect(linhaDe(res, PRODUTO_A)).toMatchObject({
      outcome: 'falha',
      // the LAST door's real code, not the first door's `relistagem-recusada`
      motivo: 'error_busi',
    });
  });

  it('⚠️ um bloqueio por promoção é TERMINAL — a segunda porta não é gasta', async () => {
    const db = new FakeDb();
    semearTudo(db, PRODUTO_A, ITEM_A, ESTADO_ANUNCIO_SHOPEE.pausado);
    const fake = clienteFake({
      unlist: () =>
        envelopeUnlist([], [{ item_id: ITEM_A, failed_reason: 'error_unlist_in_promotion' }]),
      base: () => releitura([linhaBase(ITEM_A, { item_status: SHOPEE_ITEM_STATUS.unlist })]),
    });

    const res = await definirStatusAnunciosShopee(
      asDb(db),
      entrada({ acao: REATIVAR }),
      deps(fake.client),
    );

    expect(fake.ops).toEqual(['unlist_item', 'get_item_base_info']);
    expect(linhaDe(res, PRODUTO_A).motivo).toBe(MOTIVO_STATUS_ANUNCIO.bloqueadoPorPromocao);
  });

  it('um erro de ENVELOPE que classifica como error_set_normal_unlisted_item cai para a outra porta', async () => {
    const db = new FakeDb();
    semearTudo(db, PRODUTO_A, ITEM_A, ESTADO_ANUNCIO_SHOPEE.pausado);
    const fake = clienteFake({
      unlist: () => {
        throw erroApi('product.error_set_normal_unlisted_item');
      },
      update: () => undefined,
      base: () => releitura([linhaBase(ITEM_A, { item_status: SHOPEE_ITEM_STATUS.normal })]),
    });

    const res = await definirStatusAnunciosShopee(
      asDb(db),
      entrada({ acao: REATIVAR }),
      deps(fake.client),
    );

    expect(fake.ops).toEqual(['unlist_item', 'update_item', 'get_item_base_info']);
    expect(linhaDe(res, PRODUTO_A).outcome).toBe('enviado');
  });

  it('um erro de ENVELOPE que não classifica assim SOBE — nada é escrito', async () => {
    const db = new FakeDb();
    semearTudo(db, PRODUTO_A, ITEM_A);
    const fake = clienteFake({
      unlist: () => {
        throw erroApi('error_auth');
      },
    });

    await expect(
      definirStatusAnunciosShopee(asDb(db), entrada(), deps(fake.client)),
    ).rejects.toThrow(ShopeeApiError);
    expect(db.patches).toEqual([]);
  });

  it('um pausar NUNCA abre a porta update_item', async () => {
    const db = new FakeDb();
    semearTudo(db, PRODUTO_A, ITEM_A);
    const fake = clienteFake({
      unlist: () =>
        envelopeUnlist([], [{ item_id: ITEM_A, failed_reason: 'error_set_normal_unlisted_item' }]),
      base: () => releitura([linhaBase(ITEM_A)]),
    });

    const res = await definirStatusAnunciosShopee(asDb(db), entrada(), deps(fake.client));

    expect(fake.ops).toEqual(['unlist_item', 'get_item_base_info']);
    expect(fake.updates).toEqual([]);
    expect(linhaDe(res, PRODUTO_A).motivo).toBe(MOTIVO_STATUS_ANUNCIO.relistagemRecusada);
  });
});

/* -------------------------------------------------------------------------- */
/*  (14) the write mechanism                                                   */
/* -------------------------------------------------------------------------- */

describe('definirStatusAnunciosShopee — a escrita', () => {
  it('o merge é mergeIfExists — um link apagado no meio não é ressuscitado', async () => {
    const db = new FakeDb();
    semearTudo(db, PRODUTO_A, ITEM_A);
    const fake = clienteFake({
      unlist: () => envelopeUnlist([ITEM_A]),
      base: () => {
        // The link is deleted between the resolve and the write — the window
        // `mergeIfExists` exists for.
        delete db.store[caminhoDoLink(PRODUTO_A)];
        return releitura([linhaBase(ITEM_A, { item_status: SHOPEE_ITEM_STATUS.unlist })]);
      },
    });

    const res = await definirStatusAnunciosShopee(asDb(db), entrada(), deps(fake.client));

    // ⚠️ NOT resurrected: a `merge` would be an UPSERT and would leave a ghost
    // document carrying only the patch keys.
    expect(db.store[caminhoDoLink(PRODUTO_A)]).toBeUndefined();
    expect(avisos.some((args) => String(args[0]).includes('desapareceu'))).toBe(true);
    expect(linhaDe(res, PRODUTO_A).outcome).toBe('enviado');
  });
});

/* -------------------------------------------------------------------------- */
/*  (15) rate limits                                                           */
/* -------------------------------------------------------------------------- */

describe('definirStatusAnunciosShopee — cotas', () => {
  it('a cota DIÁRIA preenche pausadoAte e marca o resto como nao-tentado', async () => {
    const db = new FakeDb();
    semearTudo(db, PRODUTO_A, ITEM_A);
    semearTudo(db, PRODUTO_B, ITEM_B);
    const fake = clienteFake({
      unlist: () => {
        throw limite('daily');
      },
    });

    const res = await definirStatusAnunciosShopee(
      asDb(db),
      entrada({ produtoIds: [PRODUTO_A, PRODUTO_B] }),
      deps(fake.client),
    );

    expect(res.pausadoAte).toBe(new Date(proximaViradaDaCotaMs(AGORA)).toISOString());
    expect(res.resumo).toEqual({ aplicados: 0, pulados: 0, falhas: 0, naoTentados: 2 });
    expect(linhaDe(res, PRODUTO_A).motivo).toBe(MOTIVO_STATUS_ANUNCIO.naoTentado);
    // The read-back is not spent either: the quota is exhausted.
    expect(fake.releituras).toEqual([]);
    expect(db.patches).toEqual([]);
  });

  it('⚠️ a RAJADA sobe — ela é um transitório, não uma cota', async () => {
    const db = new FakeDb();
    semearTudo(db, PRODUTO_A, ITEM_A);
    const fake = clienteFake({
      unlist: () => {
        throw limite('burst');
      },
    });

    await expect(
      definirStatusAnunciosShopee(asDb(db), entrada(), deps(fake.client)),
    ).rejects.toThrow(ShopeeRateLimitError);
    expect(db.patches).toEqual([]);
  });

  it('a cota DIÁRIA na RELEITURA deixa a entrada em sem-leitura-apos, sem escrever', async () => {
    const db = new FakeDb();
    semearTudo(db, PRODUTO_A, ITEM_A);
    const fake = clienteFake({
      unlist: () => envelopeUnlist([ITEM_A]),
      base: () => {
        throw limite('daily');
      },
    });

    const res = await definirStatusAnunciosShopee(asDb(db), entrada(), deps(fake.client));

    expect(res.pausadoAte).not.toBeNull();
    expect(linhaDe(res, PRODUTO_A)).toMatchObject({
      outcome: 'falha',
      motivo: MOTIVO_STATUS_ANUNCIO.semLeituraApos,
    });
    expect(db.patches).toEqual([]);
  });

  it('proximaViradaDaCotaMs é a próxima 00:00 UTC+8, estritamente à frente', () => {
    // 2026-09-04T16:00:00Z === 2026-09-05T00:00:00+08:00 — exactly a boundary.
    const virada = Date.UTC(2026, 8, 4, 16, 0, 0);
    expect(proximaViradaDaCotaMs(virada)).toBe(virada + 86_400_000);
    expect(proximaViradaDaCotaMs(virada - 1)).toBe(virada);
    expect(proximaViradaDaCotaMs(virada + 1)).toBe(virada + 86_400_000);
  });
});

/* -------------------------------------------------------------------------- */
/*  (16) the envelope                                                          */
/* -------------------------------------------------------------------------- */

describe('definirStatusAnunciosShopee — o envelope', () => {
  const CHAVES_DO_ENVELOPE = [
    'canal',
    'integracaoId',
    'acao',
    'solicitados',
    'familias',
    'resumo',
    'listings',
    'produtosSemAnuncio',
    'pausadoAte',
  ] as const;

  const CHAVES_DA_LISTING = [
    'produtoId',
    'produtoNome',
    'anuncioId',
    'linkDocId',
    'outcome',
    'motivo',
    'mensagem',
    'statusFinal',
    'estadoAnuncio',
    'membros',
  ] as const;

  it('o envelope é byte-compatível com AnuncioStatusResponse', async () => {
    const db = new FakeDb();
    semearTudo(db, PRODUTO_A, ITEM_A);
    const fake = clienteFake({
      unlist: () => envelopeUnlist([ITEM_A]),
      base: () => releitura([linhaBase(ITEM_A, { item_status: SHOPEE_ITEM_STATUS.unlist })]),
    });

    const res = await definirStatusAnunciosShopee(asDb(db), entrada(), deps(fake.client));

    // ⚠️ The key SET against a literal list, so a field added here without a
    // step-21 registry row is visible in this suite.
    expect(Object.keys(res).sort()).toEqual([...CHAVES_DO_ENVELOPE].sort());
    expect(Object.keys(res.resumo).sort()).toEqual(
      ['aplicados', 'pulados', 'falhas', 'naoTentados'].sort(),
    );
    expect(Object.keys(linhaDe(res, PRODUTO_A)).sort()).toEqual([...CHAVES_DA_LISTING].sort());
    expect(res.canal).toBe('shopee');
    expect(res.integracaoId).toBe(INTEGRACAO);
    expect(res.acao).toBe(PAUSAR);
  });

  it('⚠️ membros é SEMPRE null — a Shopee não tem família de anúncio', async () => {
    const db = new FakeDb();
    semearTudo(db, PRODUTO_A, ITEM_A);
    semearProduto(db, PRODUTO_B, 'Já pausado');
    semearLink(db, PRODUTO_B, ITEM_B, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado });
    const fake = clienteFake({
      unlist: () => envelopeUnlist([ITEM_A]),
      base: () => releitura([linhaBase(ITEM_A, { item_status: SHOPEE_ITEM_STATUS.unlist })]),
    });

    const res = await definirStatusAnunciosShopee(
      asDb(db),
      entrada({ produtoIds: [PRODUTO_A, PRODUTO_B] }),
      deps(fake.client),
    );

    expect(res.listings.map((l) => l.membros)).toEqual([null, null]);
  });

  it('o produtoNome vem do produto, e um nome em branco é ausência', async () => {
    const db = new FakeDb();
    db.seed(`produtos/${PRODUTO_A}`, { nome: '   ', paiId: null });
    semearLink(db, PRODUTO_A, ITEM_A, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo });
    const fake = clienteFake({
      unlist: () => envelopeUnlist([ITEM_A]),
      base: () => releitura([linhaBase(ITEM_A, { item_status: SHOPEE_ITEM_STATUS.unlist })]),
    });

    const res = await definirStatusAnunciosShopee(asDb(db), entrada(), deps(fake.client));

    expect(linhaDe(res, PRODUTO_A).produtoNome).toBeNull();
  });

  it('a mensagem de sucesso diz o que a Shopee CONFIRMOU, não o que foi pedido', async () => {
    const db = new FakeDb();
    semearTudo(db, PRODUTO_A, ITEM_A);
    const fake = clienteFake({
      unlist: () => envelopeUnlist([ITEM_A]),
      // The pause landed and Shopee still reports the listing as NORMAL.
      base: () => releitura([linhaBase(ITEM_A, { item_status: SHOPEE_ITEM_STATUS.normal })]),
    });

    const res = await definirStatusAnunciosShopee(asDb(db), entrada(), deps(fake.client));

    expect(linhaDe(res, PRODUTO_A).mensagem).toContain(ESTADO_ANUNCIO_SHOPEE.ativo);
    expect(linhaDe(res, PRODUTO_A).outcome).toBe('enviado');
  });

  it('a linha de log carrega contagens e tokens, nunca a prosa da Shopee', async () => {
    const db = new FakeDb();
    semearTudo(db, PRODUTO_A, ITEM_A);
    const prosa = 'error_unlist_in_promotion: a very chatty provider sentence';
    const fake = clienteFake({
      unlist: () => envelopeUnlist([], [{ item_id: ITEM_A, failed_reason: prosa }]),
      base: () => releitura([linhaBase(ITEM_A)]),
    });

    await definirStatusAnunciosShopee(asDb(db), entrada(), deps(fake.client));

    const linhas = infos.filter((args) => args[0] === '[shopee/anuncios] status de anúncios');
    expect(linhas).toHaveLength(1);
    const inteiro = [...infos, ...avisos]
      .map((args) => args.map((a) => JSON.stringify(a)).join(' '))
      .join('|');
    expect(inteiro).not.toContain('chatty provider sentence');
    expect(linhas[0]?.[1]).toMatchObject({ integracaoId: INTEGRACAO, falhas: 1 });
  });
});
