import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  SHOPEE_SURFACE,
  ShopeeConfigError,
  ShopeeRateLimitError,
  SHOPEE_ERROR_KIND,
  shopeeErrorFromEnvelope,
  shopeeItemBaseInfoRowSchema,
  shopeeUpdatePriceSchema,
  type ShopeeClient,
} from '@delfrance/integrations-shopee';
import { produtoCollection } from '@delfrance/data/admin/collections';

import { proximaViradaDaCotaMs } from '../anuncios/pausarAnuncio';
import type { VarLinkShopeeCru } from '../core/vinculosShopee';
import { MOTIVOS_DE_PAUSA } from '../estoque/constantesEstoque';
import { lerEstadoEstoque } from '../estoque/estadoEstoque';
import { type DocData, FakeDb, asDb } from '../testing/fakeDb';
import {
  ENVIO_PRECO_MANUAL_RETRY_DELAY_MS,
  SHOPEE_ENVIO_PRECO_MAX_PRODUTOS,
  SHOPEE_PRECO_MODEL_ID_SEM_MODELO,
} from './constantesPreco';
import type { DepsEnvioPreco, LinhaModeloPreco, ResultadoEnvioPreco } from './enviarPreco';
import {
  CHAVES_DA_LISTAGEM_PRECO,
  CHAVES_DO_ENVELOPE_PRECO,
  CHAVES_DO_RESUMO_PRECO,
  CHAVES_SEM_ENVIO_PRECO,
  conferirContabilidadeDePreco,
  enviarPrecoManualShopee,
  paraListagensDePreco,
  pausaDeCotaParaPreco,
  type DepsEnvioPrecoManual,
  type EnvioPrecoListing,
  type EnvioPrecoResponse,
  type EnvioPrecoSemEnvio,
} from './enviarPrecoManual';
import {
  CODIGO_GUARDA_PRECO,
  MENSAGEM_ENVIO_PRECO_LIMPO,
  MENSAGEM_POR_MOTIVO_PRECO,
  MOTIVO_PRECO_SHOPEE,
  ShopeeEnvioPrecoGuardError,
  type MotivoPrecoShopee,
} from './errosPreco';
import { precosDaFamilia, type FamiliaDePreco, type ItemDePreco } from './planoPreco';
import type { ContextoContaPreco } from './regiaoPreco';

/**
 * `enviarPrecoManual.ts` — the manual price push's RUN (#1521, step 13;
 * reconcile §2.10, C-s; D2 §2.3–§2.4). The sender is injected (its own suite
 * pins what it does to one item); what this suite pins is what the run does
 * AROUND it: the child → anchor resolution, the ONE base reader, the pool, the
 * deadline, the ladder, the aborts, the rows and the accounting.
 */

/* -------------------------------------------------------------------------- */
/*   Fixtures — invented ids only. Never a real partner, shop or credential.   */
/* -------------------------------------------------------------------------- */

const INT = 'int-1';
const AGORA = 1_760_000_000_000;
const TABELA = 'tab-normal';
const ANCORA = 'prod-ancora';
const ANCORA_2 = 'prod-ancora-2';
const ANCORA_3 = 'prod-ancora-3';
const FILHO_A = 'prod-filho-a';
const FILHO_B = 'prod-filho-b';
const LINK = 'link-1';
const ITEM = 2500139861;
const MODELO_A = 2000458802;
const MODELO_B = 2000458803;
const CAMINHO = '/api/v2/product/update_price';

/**
 * The shared double plus the ONE Admin-SDK read it does not model —
 * `Firestore.getAll(...refs, { fieldMask })`, with a real mask. Extended HERE
 * (the discovery suite's rule), never in `testing/fakeDb.ts`.
 */
class FakeDbComLote extends FakeDb {
  /** Every `getAll`: the ids read and the mask. */
  readonly leiturasEmLote: { ids: string[]; campos: string[] | null }[] = [];

  getAll(...args: unknown[]) {
    const ultimo = args[args.length - 1];
    const opcoes =
      typeof ultimo === 'object' && ultimo !== null && 'fieldMask' in ultimo
        ? (ultimo as { fieldMask: string[] })
        : null;
    const refs = (opcoes === null ? args : args.slice(0, -1)) as {
      id: string;
      get: () => Promise<{ exists: boolean; data: () => DocData | undefined }>;
    }[];
    const campos = opcoes?.fieldMask ?? null;
    this.leiturasEmLote.push({ ids: refs.map((r) => r.id), campos });
    return Promise.all(
      refs.map(async (ref) => {
        const snap = await ref.get();
        const dados = snap.data();
        return {
          id: ref.id,
          exists: snap.exists,
          data: () => {
            if (!snap.exists || dados === undefined) return undefined;
            if (campos === null) return dados;
            const saida: DocData = {};
            for (const c of campos) if (Object.hasOwn(dados, c)) saida[c] = dados[c];
            return saida;
          },
        };
      }),
    );
  }
}

function precos(valor: number): unknown {
  return { [TABELA]: { valor } };
}

function familiaSemModelo(anchorId: string, itemId = ITEM, valor = 15): FamiliaDePreco {
  return {
    anchorId,
    precos: precos(valor),
    links: [{ contaProdutoShopeeOuterRef: `integracoes/${INT}`, item_id: itemId, linkDocId: LINK }],
    children: [],
  };
}

function varLink(anchorId: string, modelId: number, varLinkDocId: string): VarLinkShopeeCru {
  return {
    contaVariacaoShopeeOuterRef: `integracoes/${INT}`,
    produtoShopeeOuterRef: `produtos/${anchorId}/prodshopee/${LINK}`,
    model_id: modelId,
    varLinkDocId,
  };
}

/** One listing with two models, each priced by its own child. */
function familiaComModelos(anchorId = ANCORA): FamiliaDePreco {
  return {
    anchorId,
    precos: precos(99),
    links: [{ contaProdutoShopeeOuterRef: `integracoes/${INT}`, item_id: ITEM, linkDocId: LINK }],
    children: [
      { produtoId: FILHO_A, precos: precos(12), varLinks: [varLink(anchorId, MODELO_A, 'var-a')] },
      { produtoId: FILHO_B, precos: precos(22), varLinks: [varLink(anchorId, MODELO_B, 'var-b')] },
    ],
  };
}

/** The rows a row-carrying result holds — one per alvo, same order. */
function linhas(
  item: ItemDePreco,
  resultado: LinhaModeloPreco['resultado'],
  motivo: MotivoPrecoShopee | null,
  codigo: string | null = null,
): LinhaModeloPreco[] {
  return item.alvos.map((alvo) => ({
    modelId: alvo.modelId,
    produtoId: alvo.produtoId,
    varLinkDocId: alvo.varLinkDocId,
    precoAlvo: alvo.precoAlvo,
    precoAnterior: 10,
    resultado,
    motivo,
    codigo,
  }));
}

const enviado = (item: ItemDePreco): ResultadoEnvioPreco => ({
  tipo: 'enviado',
  modelos: linhas(item, 'enviado', null),
  chamadasShopee: 1,
});

const falha = (
  item: ItemDePreco,
  motivo: MotivoPrecoShopee,
  codigo: string,
): ResultadoEnvioPreco => ({
  tipo: 'falha',
  motivo,
  codigo,
  mensagem: null,
  carimbado: true,
  modelos: linhas(item, 'falha', motivo, codigo),
  chamadasShopee: 1,
});

function pausaBurst(retryAfterSeconds: number | null): ResultadoEnvioPreco {
  return {
    tipo: 'pausa',
    pausa: MOTIVOS_DE_PAUSA.burst,
    ate: null,
    retryAfterSeconds,
    codigo: 'error_rate_limit',
    chamadasShopee: 1,
  };
}

function erroShopee(code: string): Error {
  return shopeeErrorFromEnvelope(
    { error: code, message: 'mensagem da Shopee', request_id: 'req-1', warning: null },
    { path: CAMINHO, httpStatus: 200, surface: SHOPEE_SURFACE.business },
  );
}

type Roteiro = (item: ItemDePreco) => ResultadoEnvioPreco | Error;

interface Mundo {
  readonly db: FakeDbComLote;
  readonly familias: Map<string, FamiliaDePreco>;
  readonly lerFamilias: ReturnType<typeof vi.fn>;
  /**
   * The SEND-time `precos` read, answering from {@link Mundo.familias} AT CALL
   * TIME — the families are this suite's catálogo, so a case that edits one
   * between the plan and the send is a tabela edited mid-request. A case that
   * needs the REAL reader passes `lerPrecos: undefined` and seeds `precos` on
   * the produto documents.
   */
  readonly lerPrecos: Mock<
    (db: unknown, ids: readonly string[]) => Promise<ReadonlyMap<string, unknown>>
  >;
  readonly enviar: Mock<(item: ItemDePreco, d: DepsEnvioPreco) => Promise<ResultadoEnvioPreco>>;
  readonly getItemBaseInfo: ReturnType<typeof vi.fn>;
  readonly updatePrice: ReturnType<typeof vi.fn>;
  readonly contexto: ContextoContaPreco;
  /** What the injected sender answers, per `item_id` — a queue, one entry per call. */
  readonly roteiro: Map<number, Roteiro[]>;
}

function mundo(): Mundo {
  const db = new FakeDbComLote();
  const familias = new Map<string, FamiliaDePreco>();
  const roteiro = new Map<number, Roteiro[]>();
  const lerFamilias = vi.fn((_db: unknown, a: { readonly anchorIds: readonly string[] }) =>
    Promise.resolve(
      new Map(
        a.anchorIds.flatMap((id): [string, FamiliaDePreco][] => {
          const f = familias.get(id);
          return f === undefined ? [] : [[id, f]];
        }),
      ),
    ),
  );
  const lerPrecos = vi.fn((_db: unknown, ids: readonly string[]) => {
    const catalogo = new Map<string, unknown>();
    for (const f of familias.values()) {
      for (const [id, p] of precosDaFamilia(f)) catalogo.set(id, p);
    }
    return Promise.resolve<ReadonlyMap<string, unknown>>(
      new Map(
        ids.flatMap((id): [string, unknown][] =>
          catalogo.has(id) ? [[id, catalogo.get(id)]] : [],
        ),
      ),
    );
  });
  const enviar = vi.fn<(item: ItemDePreco, d: DepsEnvioPreco) => Promise<ResultadoEnvioPreco>>(
    (item) => {
      const fila = roteiro.get(item.itemId) ?? [];
      const proximo = fila.shift() ?? enviado;
      const r = proximo(item);
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    },
  );
  const getItemBaseInfo = vi.fn(({ itemIds }: { itemIds: readonly number[] }) =>
    Promise.resolve({
      item_list: itemIds.map((item_id) =>
        shopeeItemBaseInfoRowSchema.parse({
          item_id,
          item_status: 'NORMAL',
          has_model: false,
          price_info: [{ currency: 'BRL', original_price: 10, current_price: 10 }],
        }),
      ),
    }),
  );
  const updatePrice = vi.fn(() =>
    Promise.resolve(
      shopeeUpdatePriceSchema.parse({
        request_id: 'req-1',
        error: '',
        message: null,
        warning: null,
        response: { success_list: [{ original_price: 15 }], failure_list: [] },
      }),
    ),
  );
  const client = { getItemBaseInfo, updatePrice } as unknown as ShopeeClient;
  const contexto = {
    integracaoId: INT,
    client,
    regiao: 'BR',
    moeda: 'BRL',
    multiplo: 4,
    tabelaNormalId: TABELA,
  } as ContextoContaPreco;
  return {
    db,
    familias,
    lerFamilias,
    lerPrecos,
    enviar,
    getItemBaseInfo,
    updatePrice,
    contexto,
    roteiro,
  };
}

function semearProduto(m: Mundo, id: string, nome: string, paiId: string | null = null): void {
  m.db.seed(`produtos/${id}`, {
    nome,
    paiId,
    descricao: 'um corpo que a máscara não deixa passar',
  });
}

function deps(m: Mundo, over: Partial<DepsEnvioPrecoManual> = {}): DepsEnvioPrecoManual {
  return {
    nowMs: AGORA,
    agora: () => 0,
    esperar: vi.fn(() => Promise.resolve()),
    contexto: m.contexto,
    contaNome: 'Loja teste',
    lerFamilias: m.lerFamilias as unknown as DepsEnvioPrecoManual['lerFamilias'],
    lerPrecos: m.lerPrecos as unknown as DepsEnvioPrecoManual['lerPrecos'],
    enviar: m.enviar as unknown as DepsEnvioPrecoManual['enviar'],
    ...over,
  };
}

function rodar(
  m: Mundo,
  produtoIds: readonly string[],
  over: Partial<DepsEnvioPrecoManual> = {},
  baixarPreco = false,
): Promise<EnvioPrecoResponse> {
  return enviarPrecoManualShopee(
    asDb(m.db),
    { integracaoId: INT, produtoIds, baixarPreco },
    deps(m, over),
  );
}

/** `n` no-model anchors, each with its own listing (item ids ITEM, ITEM+1, …). */
function semearAnchors(m: Mundo, n: number): string[] {
  return Array.from({ length: n }, (_v, i) => {
    const id = `prod-${String(i)}`;
    semearProduto(m, id, `Produto ${String(i)}`);
    m.familias.set(id, familiaSemModelo(id, ITEM + i));
    return id;
  });
}

beforeEach(() => {
  vi.stubEnv('SHOPEE_PRICE_MANUAL_CONCURRENCY', '1');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/*                          the pure row mapping                               */
/* -------------------------------------------------------------------------- */

describe('paraListagensDePreco — uma linha do remetente, uma linha do envelope', () => {
  const item: ItemDePreco = {
    produtoId: ANCORA,
    linkDocId: LINK,
    itemId: ITEM,
    semModelos: false,
    alvos: [
      { modelId: MODELO_A, produtoId: FILHO_A, varLinkDocId: 'var-a', precoAlvo: 12 },
      { modelId: MODELO_B, produtoId: FILHO_B, varLinkDocId: 'var-b', precoAlvo: 22 },
    ],
  };

  it('PAR (M20): uma linha `enviado` leva `preco` = o alvo, motivo nulo e a frase LIMPA', () => {
    const [a] = paraListagensDePreco(
      item,
      { tipo: 'enviado', modelos: linhas(item, 'enviado', null), chamadasShopee: 1 },
      'Âncora',
    );
    expect(a).toEqual({
      produtoId: ANCORA,
      produtoNome: 'Âncora',
      variacaoProdutoId: FILHO_A,
      anuncioId: String(ITEM),
      linkDocId: LINK,
      outcome: 'enviado',
      motivo: null,
      mensagem: MENSAGEM_ENVIO_PRECO_LIMPO,
      preco: 12,
      precoAnterior: 10,
      variacoes: null,
      codigo: null,
    });
  });

  it('QUASE-IGUAL (M20): uma linha `falha` do MESMO alvo leva `preco` NULO e mantém `precoAnterior`', () => {
    const r = falha(item, MOTIVO_PRECO_SHOPEE.precoForaDaFaixa, 'product.error_price_out_of_range');
    const [a] = paraListagensDePreco(
      item,
      r as Extract<ResultadoEnvioPreco, { tipo: 'falha' }>,
      null,
    );
    expect(a?.preco).toBeNull();
    expect(a?.precoAnterior).toBe(10);
    expect(a?.mensagem).toBe(MENSAGEM_POR_MOTIVO_PRECO['preco-fora-da-faixa']);
    expect(a?.codigo).toBe('product.error_price_out_of_range');
  });

  it('um item SEM modelo: `variacaoProdutoId` nulo (a linha é da âncora)', () => {
    const semModelo: ItemDePreco = {
      produtoId: ANCORA,
      linkDocId: LINK,
      itemId: ITEM,
      semModelos: true,
      alvos: [
        {
          modelId: SHOPEE_PRECO_MODEL_ID_SEM_MODELO,
          produtoId: ANCORA,
          varLinkDocId: null,
          precoAlvo: 15,
        },
      ],
    };
    const [a] = paraListagensDePreco(
      semModelo,
      { tipo: 'enviado', modelos: linhas(semModelo, 'enviado', null), chamadasShopee: 1 },
      null,
    );
    expect(a?.variacaoProdutoId).toBeNull();
    expect(a?.preco).toBe(15);
  });

  it('o `codigo` da Shopee chega VERBATIM, cortado em 300 caracteres', () => {
    const longo = 'x'.repeat(400);
    const r = falha(item, MOTIVO_PRECO_SHOPEE.recusaDesconhecida, longo);
    const saida = paraListagensDePreco(
      item,
      r as Extract<ResultadoEnvioPreco, { tipo: 'falha' }>,
      null,
    );
    expect(saida.map((l) => l.codigo?.length)).toEqual([300, 300]);
  });
});

/* -------------------------------------------------------------------------- */
/*                        the quota pause the route reads                      */
/* -------------------------------------------------------------------------- */

describe('pausaDeCotaParaPreco — só as duas pausas de COTA param o preço', () => {
  async function estado(doc: DocData) {
    const db = new FakeDb();
    db.seed(`estoqueShopeeSync/${INT}`, doc);
    return lerEstadoEstoque(asDb(db), INT);
  }

  it.each([MOTIVOS_DE_PAUSA.burst, MOTIVOS_DE_PAUSA.cotaDiaria])(
    'PAR: uma pausa `%s` ativa devolve o instante em que a conta reabre',
    async (motivo) => {
      const e = await estado({ pausadoAte: AGORA + 60_000, pausaMotivo: motivo });
      expect(pausaDeCotaParaPreco(e, AGORA)).toBe(AGORA + 60_000);
    },
  );

  it.each([MOTIVOS_DE_PAUSA.lojaEmFerias, MOTIVOS_DE_PAUSA.lojaBloqueada])(
    'QUASE-IGUAL (M69): uma pausa `%s` do ESTOQUE, igualmente ativa, NÃO para o preço',
    async (motivo) => {
      const e = await estado({ pausadoAte: AGORA + 60_000, pausaMotivo: motivo });
      expect(pausaDeCotaParaPreco(e, AGORA)).toBeNull();
    },
  );

  it('QUASE-IGUAL: a pausa de cota que termina EXATAMENTE agora já não pausa (a borda do estoque)', async () => {
    const e = await estado({ pausadoAte: AGORA, pausaMotivo: MOTIVOS_DE_PAUSA.burst });
    expect(pausaDeCotaParaPreco(e, AGORA)).toBeNull();
  });

  it('uma pausa SEM motivo gravado não é lida como pausa de cota', async () => {
    const e = await estado({ pausadoAte: AGORA + 60_000 });
    expect(pausaDeCotaParaPreco(e, AGORA)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                         resolution, plan and reads                          */
/* -------------------------------------------------------------------------- */

describe('enviarPrecoManualShopee — resolução do filho para a âncora', () => {
  it('⚠️ (M10) um FILHO pedido resolve para a âncora: linhas com `produtoId` = âncora e o filho em `variacaoProdutoId`', async () => {
    const m = mundo();
    semearProduto(m, ANCORA, 'Camiseta âncora');
    semearProduto(m, FILHO_A, 'Camiseta P', ANCORA);
    m.familias.set(ANCORA, familiaComModelos());

    const r = await rodar(m, [FILHO_A]);

    expect(r.produtosSemEnvio).toEqual([]);
    expect(r.listings.map((l) => [l.produtoId, l.variacaoProdutoId, l.produtoNome])).toEqual([
      [ANCORA, FILHO_A, 'Camiseta âncora'],
      [ANCORA, FILHO_B, 'Camiseta âncora'],
    ]);
    expect(m.lerFamilias).toHaveBeenCalledWith(expect.anything(), { anchorIds: [ANCORA] });
    // The requested ids masked to name + parent, then the unrequested anchor's name only.
    expect(m.db.leiturasEmLote).toEqual([
      { ids: [FILHO_A], campos: ['nome', 'paiId'] },
      { ids: [ANCORA], campos: ['nome'] },
    ]);
  });

  it('⚠️ (M11) filho + a PRÓPRIA âncora no mesmo pedido: UMA família, o remetente chamado UMA vez por item', async () => {
    const m = mundo();
    semearProduto(m, ANCORA, 'Âncora');
    semearProduto(m, FILHO_A, 'Filho', ANCORA);
    m.familias.set(ANCORA, familiaComModelos());

    const r = await rodar(m, [FILHO_A, ANCORA]);

    expect(m.enviar).toHaveBeenCalledTimes(1);
    expect(m.lerFamilias).toHaveBeenCalledTimes(1);
    expect(m.lerFamilias).toHaveBeenCalledWith(expect.anything(), { anchorIds: [ANCORA] });
    expect(r.solicitados).toBe(2);
    expect(r.familias).toBe(1);
    // The anchor was requested: no second name read.
    expect(m.db.leiturasEmLote).toHaveLength(1);
  });

  it('um id que NÃO existe ⇒ produtosSemEnvio `produto-nao-encontrado`, e o resto segue', async () => {
    const m = mundo();
    const [a] = semearAnchors(m, 1);

    const r = await rodar(m, ['prod-fantasma', a ?? '']);

    expect(r.produtosSemEnvio).toEqual([
      {
        produtoId: 'prod-fantasma',
        produtoNome: null,
        motivo: MOTIVO_PRECO_SHOPEE.produtoNaoEncontrado,
        mensagem: MENSAGEM_POR_MOTIVO_PRECO['produto-nao-encontrado'],
      },
    ]);
    expect(r.listings).toHaveLength(1);
  });

  it('um filho cuja ÂNCORA não existe ⇒ `produto-nao-encontrado` para o FILHO pedido (com o nome dele)', async () => {
    const m = mundo();
    semearProduto(m, FILHO_A, 'Órfão', 'prod-pai-sumido');

    const r = await rodar(m, [FILHO_A]);

    expect(r.listings).toEqual([]);
    expect(r.produtosSemEnvio).toEqual([
      {
        produtoId: FILHO_A,
        produtoNome: 'Órfão',
        motivo: MOTIVO_PRECO_SHOPEE.produtoNaoEncontrado,
        mensagem: MENSAGEM_POR_MOTIVO_PRECO['produto-nao-encontrado'],
      },
    ]);
  });

  it('PAR: uma família SEM anúncio desta conta ⇒ UMA entrada `sem-link` POR id pedido dela, nenhuma linha', async () => {
    const m = mundo();
    semearProduto(m, ANCORA, 'Âncora');
    semearProduto(m, FILHO_A, 'Filho', ANCORA);
    m.familias.set(ANCORA, { anchorId: ANCORA, precos: null, links: [], children: [] });

    const r = await rodar(m, [ANCORA, FILHO_A]);

    expect(r.listings).toEqual([]);
    expect(r.produtosSemEnvio.map((s) => [s.produtoId, s.motivo])).toEqual([
      [ANCORA, 'sem-link'],
      [FILHO_A, 'sem-link'],
    ]);
  });

  it('QUASE-IGUAL: um `sem-link` de UM vínculo ao lado de um anúncio planejado vira LINHA, não produtosSemEnvio', async () => {
    const m = mundo();
    semearProduto(m, ANCORA, 'Âncora');
    const f = familiaSemModelo(ANCORA);
    m.familias.set(ANCORA, {
      ...f,
      // A link of this conta with no document id: the planner's rung-1 `sem-link`.
      links: [...f.links, { contaProdutoShopeeOuterRef: `integracoes/${INT}`, item_id: ITEM + 7 }],
    });

    const r = await rodar(m, [ANCORA]);

    expect(r.produtosSemEnvio).toEqual([]);
    expect(r.listings.map((l) => [l.outcome, l.motivo])).toEqual([
      ['pulado', 'sem-link'],
      ['enviado', null],
    ]);
  });

  it('os pulos do plano viram linhas `pulado`: UMA por anúncio, ou UMA por modelo quando o plano os conhece', async () => {
    const m = mundo();
    semearProduto(m, ANCORA, 'Kit');
    semearProduto(m, ANCORA_2, 'Grande');
    m.familias.set(ANCORA, {
      ...familiaSemModelo(ANCORA),
      links: [
        {
          contaProdutoShopeeOuterRef: `integracoes/${INT}`,
          item_id: ITEM,
          linkDocId: LINK,
          kitNativo: true,
        },
      ],
    });
    const filhos = Array.from({ length: 51 }, (_v, i) => ({
      produtoId: `filho-${String(i).padStart(2, '0')}`,
      precos: precos(10),
      varLinks: [varLink(ANCORA_2, MODELO_A + i, `var-${String(i).padStart(2, '0')}`)],
    }));
    m.familias.set(ANCORA_2, { ...familiaSemModelo(ANCORA_2, ITEM + 1), children: filhos });

    const r = await rodar(m, [ANCORA, ANCORA_2]);

    expect(m.enviar).not.toHaveBeenCalled();
    const kit = r.listings.filter((l) => l.produtoId === ANCORA);
    expect(kit).toHaveLength(1);
    expect(kit[0]).toMatchObject({
      outcome: 'pulado',
      motivo: 'kit-derivado',
      variacaoProdutoId: null,
      anuncioId: String(ITEM),
    });
    const grande = r.listings.filter((l) => l.produtoId === ANCORA_2);
    expect(grande).toHaveLength(51);
    expect(new Set(grande.map((l) => l.motivo))).toEqual(new Set(['modelos-excedem-limite']));
    expect(grande[0]?.variacaoProdutoId).toBe('filho-00');
  });

  it('os preços são da TABELA da conta e do PRÓPRIO filho (o item chega ao remetente já precificado)', async () => {
    const m = mundo();
    semearProduto(m, ANCORA, 'Âncora');
    m.familias.set(ANCORA, familiaComModelos());

    await rodar(m, [ANCORA]);

    const item = m.enviar.mock.calls[0]?.[0] as ItemDePreco;
    expect(item.alvos.map((a) => [a.produtoId, a.precoAlvo])).toEqual([
      [FILHO_A, 12],
      [FILHO_B, 22],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                   the ONE reader and what the sender receives               */
/* -------------------------------------------------------------------------- */

describe('enviarPrecoManualShopee — UM leitor de base por pedido', () => {
  it('⚠️ três itens ⇒ UMA `get_item_base_info` com os três ids (o remetente lê pelo leitor injetado)', async () => {
    const m = mundo();
    semearAnchors(m, 3);
    m.enviar.mockImplementation(
      async (item: ItemDePreco, d: { lerBase: (id: number) => Promise<unknown> }) => {
        await d.lerBase(item.itemId);
        return enviado(item);
      },
    );

    await rodar(m, ['prod-0', 'prod-1', 'prod-2']);

    expect(m.getItemBaseInfo).toHaveBeenCalledTimes(1);
    expect(m.getItemBaseInfo).toHaveBeenCalledWith({ itemIds: [ITEM, ITEM + 1, ITEM + 2] });
  });

  it('QUASE-IGUAL: nenhum item planejado ⇒ ZERO leituras de base (o leitor é preguiçoso)', async () => {
    const m = mundo();
    semearProduto(m, ANCORA, 'Âncora');
    m.familias.set(ANCORA, { anchorId: ANCORA, precos: null, links: [], children: [] });

    await rodar(m, [ANCORA]);

    expect(m.getItemBaseInfo).not.toHaveBeenCalled();
  });

  it('(M67) o remetente recebe o contexto, o instante LÓGICO e `baixarPreco` do pedido — nos dois valores', async () => {
    const m = mundo();
    semearAnchors(m, 1);

    await rodar(m, ['prod-0'], {}, true);
    await rodar(m, ['prod-0'], {}, false);

    const ds = m.enviar.mock.calls.map(
      (c) => c[1] as { conta: unknown; nowMs: number; baixarPreco: boolean },
    );
    expect(ds.map((d) => d.baixarPreco)).toEqual([true, false]);
    expect(ds.every((d) => d.conta === m.contexto && d.nowMs === AGORA)).toBe(true);
  });

  it('o REMETENTE REAL, ponta a ponta: um item sem modelo sai `enviado` a 15 sobre 10, e o link recebe a escrita', async () => {
    const m = mundo();
    semearProduto(m, ANCORA, 'Âncora');
    m.db.seed(`produtos/${ANCORA}/prodshopee/${LINK}`, { item_id: ITEM, item_status: 'NORMAL' });
    m.familias.set(ANCORA, familiaSemModelo(ANCORA));

    const r = await rodar(m, [ANCORA], { enviar: undefined });

    expect(r.listings).toEqual([
      expect.objectContaining({
        outcome: 'enviado',
        preco: 15,
        precoAnterior: 10,
        motivo: null,
        mensagem: MENSAGEM_ENVIO_PRECO_LIMPO,
        codigo: null,
        variacaoProdutoId: null,
      }),
    ]);
    expect(m.getItemBaseInfo).toHaveBeenCalledTimes(1);
    expect(m.updatePrice).toHaveBeenCalledWith({
      item_id: ITEM,
      price_list: [{ model_id: SHOPEE_PRECO_MODEL_ID_SEM_MODELO, original_price: 15 }],
    });
    expect(m.db.writes.map((w) => w.path)).toContain(`produtos/${ANCORA}/prodshopee/${LINK}`);
  });
});

/* -------------------------------------------------------------------------- */
/*                         the pool, the deadline, the ladder                  */
/* -------------------------------------------------------------------------- */

describe('enviarPrecoManualShopee — a largura, o prazo e a escada', () => {
  it('(M17) a largura é GRAMPEADA na fila de estoque: 99 pedidos ⇒ no máximo `concurrentDispatches()` em voo', async () => {
    vi.stubEnv('SHOPEE_PRICE_MANUAL_CONCURRENCY', '99');
    vi.stubEnv('SHOPEE_STOCK_CONCURRENT_DISPATCHES', '3');
    const m = mundo();
    const ids = semearAnchors(m, 6);
    let emVoo = 0;
    let maximo = 0;
    m.enviar.mockImplementation(async (item: ItemDePreco) => {
      emVoo += 1;
      maximo = Math.max(maximo, emVoo);
      await new Promise((resolve) => setTimeout(resolve, 0));
      emVoo -= 1;
      return enviado(item);
    });

    await rodar(m, ids);

    expect(maximo).toBe(3);
  });

  it('as linhas voltam na ORDEM do pedido mesmo quando o segundo item termina primeiro', async () => {
    vi.stubEnv('SHOPEE_PRICE_MANUAL_CONCURRENCY', '2');
    const m = mundo();
    const ids = semearAnchors(m, 2);
    m.enviar.mockImplementation(async (item: ItemDePreco) => {
      if (item.itemId === ITEM) await new Promise((resolve) => setTimeout(resolve, 5));
      return enviado(item);
    });

    const r = await rodar(m, ids);

    expect(r.listings.map((l) => l.produtoId)).toEqual(ids);
  });

  it('⚠️ (M13) o prazo corre no relógio DECORRIDO: um `nowMs` no PASSADO ainda tenta o primeiro item', async () => {
    const m = mundo();
    semearAnchors(m, 1);

    const r = await rodar(m, ['prod-0'], { nowMs: 0, agora: () => 5_000_000_000_000 });

    expect(m.enviar).toHaveBeenCalledTimes(1);
    expect(r.listings[0]?.outcome).toBe('enviado');
  });

  it('PAR: decorrido ACIMA do prazo ⇒ o item seguinte sai `nao-tentado tempo-esgotado`, sem chamada', async () => {
    vi.stubEnv('SHOPEE_PRICE_MANUAL_DEADLINE_MS', '1000');
    const m = mundo();
    const ids = semearAnchors(m, 2);
    const leituras = [0, 0, 1_001];

    const r = await rodar(m, ids, { agora: () => leituras.shift() ?? 1_001 });

    expect(m.enviar).toHaveBeenCalledTimes(1);
    expect(r.listings.map((l) => [l.outcome, l.motivo])).toEqual([
      ['enviado', null],
      ['nao-tentado', 'tempo-esgotado'],
    ]);
    expect(r.resumo).toEqual({ enviados: 1, pulados: 0, falhas: 0, naoTentados: 1 });
  });

  it('QUASE-IGUAL: decorrido EXATAMENTE no prazo ainda tenta (estritamente maior encerra)', async () => {
    vi.stubEnv('SHOPEE_PRICE_MANUAL_DEADLINE_MS', '1000');
    const m = mundo();
    const ids = semearAnchors(m, 2);
    const leituras = [0, 0, 1_000];

    const r = await rodar(m, ids, { agora: () => leituras.shift() ?? 1_000 });

    expect(m.enviar).toHaveBeenCalledTimes(2);
    expect(r.resumo.naoTentados).toBe(0);
  });

  it('PAR: um erro LANÇADO (transitório) repete UMA vez, depois de `esperar(1500)`, e o segundo resultado vale', async () => {
    const m = mundo();
    semearAnchors(m, 1);
    m.roteiro.set(ITEM, [() => erroShopee('error_system_busy'), enviado]);
    const esperar = vi.fn(() => Promise.resolve());

    const r = await rodar(m, ['prod-0'], { esperar });

    expect(m.enviar).toHaveBeenCalledTimes(2);
    expect(esperar).toHaveBeenCalledWith(ENVIO_PRECO_MANUAL_RETRY_DELAY_MS);
    expect(r.listings[0]?.outcome).toBe('enviado');
  });

  it('QUASE-IGUAL: uma RECUSA classificada (um valor, não um throw) NÃO repete', async () => {
    const m = mundo();
    semearAnchors(m, 1);
    m.roteiro.set(ITEM, [
      (i) => falha(i, MOTIVO_PRECO_SHOPEE.precoRecusado, 'product.error_update_price_fail'),
    ]);

    const r = await rodar(m, ['prod-0']);

    expect(m.enviar).toHaveBeenCalledTimes(1);
    expect(r.listings[0]).toMatchObject({
      outcome: 'falha',
      motivo: 'preco-recusado',
      codigo: 'product.error_update_price_fail',
    });
  });

  it('dois lançamentos de um erro da Shopee ⇒ as linhas do item `falha recusa-desconhecida` com o código VERBATIM, e o resto segue', async () => {
    const m = mundo();
    const ids = semearAnchors(m, 2);
    m.roteiro.set(ITEM, [
      () => erroShopee('error_system_busy'),
      () => erroShopee('error_system_busy'),
    ]);

    const r = await rodar(m, ids);

    expect(r.listings.map((l) => [l.outcome, l.motivo, l.codigo])).toEqual([
      ['falha', 'recusa-desconhecida', 'error_system_busy'],
      ['enviado', null, null],
    ]);
  });

  it('QUASE-IGUAL da escada: o MESMO erro transitório NÃO repete quando um irmão já encerrou o envio (`fatal`)', async () => {
    vi.stubEnv('SHOPEE_PRICE_MANUAL_CONCURRENCY', '2');
    const m = mundo();
    const ids = semearAnchors(m, 2);
    m.enviar.mockImplementation(async (item: ItemDePreco) => {
      if (item.itemId === ITEM + 1) {
        return {
          tipo: 'fatal',
          motivo: 'reauth',
          erro: 'ShopeeReauthRequiredError: x',
          chamadasShopee: 1,
        };
      }
      // The first item fails transiently only AFTER its sibling ended the run.
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (m.enviar.mock.calls.filter((c) => (c[0] as ItemDePreco).itemId === ITEM).length === 1) {
        throw erroShopee('error_system_busy');
      }
      return enviado(item);
    });

    const r = await rodar(m, ids);

    expect(m.enviar.mock.calls.filter((c) => (c[0] as ItemDePreco).itemId === ITEM)).toHaveLength(
      1,
    );
    expect(r.listings.map((l) => [l.outcome, l.motivo])).toEqual([
      ['falha', 'recusa-desconhecida'],
      ['nao-tentado', 'reauth'],
    ]);
  });

  it('um limite de taxa LANÇADO nunca repete (martelar uma conta estrangulada é o que não se faz)', async () => {
    const m = mundo();
    semearAnchors(m, 1);
    const limite = new ShopeeRateLimitError('limite', {
      code: 'error_rate_limit',
      kind: SHOPEE_ERROR_KIND.burst,
      httpStatus: 429,
      path: CAMINHO,
      retryAfterSeconds: 5,
    });
    m.roteiro.set(ITEM, [() => limite]);

    await rodar(m, ['prod-0']);

    expect(m.enviar).toHaveBeenCalledTimes(1);
  });

  it('⚠️ (D-6) a classe de GUARDA sobe como ela mesma — nunca vira N linhas `falha`, e não repete', async () => {
    const m = mundo();
    semearAnchors(m, 1);
    const guarda = new ShopeeEnvioPrecoGuardError(CODIGO_GUARDA_PRECO.contaPausada, 'pausada');
    m.roteiro.set(ITEM, [() => guarda]);

    await expect(rodar(m, ['prod-0'])).rejects.toBe(guarda);
    expect(m.enviar).toHaveBeenCalledTimes(1);
  });

  it('um `ShopeeConfigError` (bug NOSSO) sobe sem repetir e sem virar linha', async () => {
    const m = mundo();
    semearAnchors(m, 1);
    const bug = new ShopeeConfigError('configuração');
    m.roteiro.set(ITEM, [() => bug]);

    await expect(rodar(m, ['prod-0'])).rejects.toBe(bug);
    expect(m.enviar).toHaveBeenCalledTimes(1);
  });

  it('rule 6: um TypeError lançado duas vezes SOBE, e nenhum item seguinte é tentado', async () => {
    const m = mundo();
    const ids = semearAnchors(m, 3);
    const bug = new TypeError('bug de programação');
    m.roteiro.set(ITEM, [() => bug, () => bug]);

    await expect(rodar(m, ids)).rejects.toBe(bug);
    expect(m.enviar).toHaveBeenCalledTimes(2);
  });

  it('S1 na superfície: um remetente que PERDE uma linha faz o envio lançar — um modelo nunca some do envelope', async () => {
    const m = mundo();
    semearProduto(m, ANCORA, 'Âncora');
    m.familias.set(ANCORA, familiaComModelos());
    m.roteiro.set(ITEM, [
      (i) => ({
        tipo: 'enviado',
        modelos: linhas(i, 'enviado', null).slice(0, 1),
        chamadasShopee: 1,
      }),
    ]);

    await expect(rodar(m, [ANCORA])).rejects.toThrow('linhas incompletas');
  });
});

/* -------------------------------------------------------------------------- */
/*                               pause and fatal                               */
/* -------------------------------------------------------------------------- */

describe('enviarPrecoManualShopee — `pausa` e `fatal` encerram o RESTO e ainda respondem', () => {
  it('⚠️ (M14) o item 2 pausa por RAJADA ⇒ itens 2..4 `nao-tentado conta-pausada`, 2 chamadas, `pausadoAte` = agora + Retry-After', async () => {
    const m = mundo();
    const ids = semearAnchors(m, 4);
    m.roteiro.set(ITEM + 1, [() => pausaBurst(30)]);

    const r = await rodar(m, ids);

    expect(m.enviar).toHaveBeenCalledTimes(2);
    expect(r.listings.map((l) => [l.outcome, l.motivo, l.codigo])).toEqual([
      ['enviado', null, null],
      ['nao-tentado', 'conta-pausada', 'error_rate_limit'],
      ['nao-tentado', 'conta-pausada', null],
      ['nao-tentado', 'conta-pausada', null],
    ]);
    expect(r.pausadoAte).toBe(new Date(AGORA + 30_000).toISOString());
  });

  it('(M73 no manual) uma rajada SEM Retry-After pausa por `SHOPEE_STOCK_RATE_PAUSE_MIN` — a MESMA pausa do estoque', async () => {
    vi.stubEnv('SHOPEE_STOCK_RATE_PAUSE_MIN', '7');
    const m = mundo();
    semearAnchors(m, 1);
    m.roteiro.set(ITEM, [() => pausaBurst(null)]);

    const r = await rodar(m, ['prod-0']);

    expect(r.pausadoAte).toBe(new Date(AGORA + 7 * 60 * 1_000).toISOString());
  });

  it('(M15) a cota DIÁRIA pausa até a virada que o remetente calculou — nunca por um cabeçalho', async () => {
    const m = mundo();
    semearAnchors(m, 1);
    const virada = proximaViradaDaCotaMs(AGORA);
    m.roteiro.set(ITEM, [
      () => ({
        tipo: 'pausa',
        pausa: MOTIVOS_DE_PAUSA.cotaDiaria,
        ate: virada,
        retryAfterSeconds: null,
        codigo: 'error_limit',
        chamadasShopee: 1,
      }),
    ]);

    const r = await rodar(m, ['prod-0']);

    expect(r.pausadoAte).toBe(new Date(virada).toISOString());
    expect(r.listings[0]).toMatchObject({ outcome: 'nao-tentado', motivo: 'conta-pausada' });
  });

  it('⚠️ (M16/M71) item 1 ENVIADO, item 2 `fatal reauth` ⇒ o envelope VOLTA: item 1 `enviado`, o resto `nao-tentado reauth`', async () => {
    const m = mundo();
    const ids = semearAnchors(m, 3);
    m.roteiro.set(ITEM + 1, [
      () => ({
        tipo: 'fatal',
        motivo: 'reauth',
        erro: 'ShopeeReauthRequiredError: expirada',
        chamadasShopee: 1,
      }),
    ]);

    const r = await rodar(m, ids);

    expect(m.enviar).toHaveBeenCalledTimes(2);
    expect(r.listings.map((l) => [l.outcome, l.motivo])).toEqual([
      ['enviado', null],
      ['nao-tentado', 'reauth'],
      ['nao-tentado', 'reauth'],
    ]);
    expect(r.pausadoAte).toBeNull();
    // The class and message reach the LOG, never a row.
    expect(JSON.stringify(r)).not.toContain('ShopeeReauthRequiredError');
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('reauth'),
      expect.objectContaining({ erro: 'ShopeeReauthRequiredError: expirada' }),
    );
  });

  it.each([
    ['a de 60 s chega PRIMEIRO, a de 30 s depois', 60, 30],
    ['a de 30 s chega PRIMEIRO, a de 60 s depois', 30, 60],
  ])(
    'LARGURA 2: duas pausas simultâneas (%s) ⇒ `pausadoAte` é o fim MAIS TARDIO, em qualquer ordem de chegada',
    async (_nome, primeira, segunda) => {
      vi.stubEnv('SHOPEE_PRICE_MANUAL_CONCURRENCY', '2');
      const m = mundo();
      const ids = semearAnchors(m, 2);
      // Both items are IN FLIGHT (sent) before either answers.
      m.enviar.mockImplementation(async (item: ItemDePreco) => {
        const chegaPrimeiro = item.itemId === ITEM + 1;
        await new Promise((resolve) => setTimeout(resolve, chegaPrimeiro ? 1 : 8));
        return pausaBurst(chegaPrimeiro ? primeira : segunda);
      });

      const r = await rodar(m, ids);

      expect(m.enviar).toHaveBeenCalledTimes(2);
      expect(r.pausadoAte).toBe(new Date(AGORA + 60_000).toISOString());
    },
  );

  const fatalReauth = (): ResultadoEnvioPreco => ({
    tipo: 'fatal',
    motivo: 'reauth',
    erro: 'ShopeeReauthRequiredError: expirada',
    chamadasShopee: 1,
  });

  it.each([
    [
      'um FATAL e depois uma PAUSA',
      fatalReauth,
      () => pausaBurst(30),
      [
        ['nao-tentado', 'conta-pausada', 'error_rate_limit'],
        ['nao-tentado', 'reauth', null],
        ['nao-tentado', 'reauth', null],
      ],
    ],
    [
      'uma PAUSA e depois um FATAL',
      () => pausaBurst(30),
      fatalReauth,
      [
        ['nao-tentado', 'reauth', null],
        ['nao-tentado', 'conta-pausada', 'error_rate_limit'],
        ['nao-tentado', 'conta-pausada', null],
      ],
    ],
  ])(
    'LARGURA 3: o PRIMEIRO aborto vence — %s ⇒ o item ainda lendo o preço sai `nao-tentado` com o motivo do PRIMEIRO',
    async (_nome, primeiro, segundo, esperadas) => {
      vi.stubEnv('SHOPEE_PRICE_MANUAL_CONCURRENCY', '3');
      vi.stubEnv('SHOPEE_STOCK_CONCURRENT_DISPATCHES', '3');
      const m = mundo();
      const ids = semearAnchors(m, 3);
      // Item 2 answers FIRST (1 ms), item 1 SECOND (8 ms); item 3 is still
      // reading its price (20 ms) when both have aborted the run.
      m.enviar.mockImplementation(async (item: ItemDePreco) => {
        const chegaPrimeiro = item.itemId === ITEM + 1;
        await new Promise((resolve) => setTimeout(resolve, chegaPrimeiro ? 1 : 8));
        return chegaPrimeiro ? primeiro() : segundo();
      });
      const precosReais = m.lerPrecos.getMockImplementation();
      m.lerPrecos.mockImplementation(async (db: unknown, lidos: readonly string[]) => {
        if (lidos.includes('prod-2')) await new Promise((resolve) => setTimeout(resolve, 20));
        if (precosReais === undefined) throw new Error('fixture: leitor de preços ausente');
        return precosReais(db, lidos);
      });

      const r = await rodar(m, ids);

      expect(m.enviar).toHaveBeenCalledTimes(2);
      expect(r.listings.map((l) => [l.outcome, l.motivo, l.codigo])).toEqual(esperadas);
    },
  );
});

/* -------------------------------------------------------------------------- */
/*                            the envelope and guards                          */
/* -------------------------------------------------------------------------- */

describe('enviarPrecoManualShopee — o envelope', () => {
  it('(M18/M19) as chaves nos QUATRO níveis são as declaradas, e toda `mensagem` é uma frase da tabela', async () => {
    const m = mundo();
    semearProduto(m, ANCORA, 'Âncora');
    m.familias.set(ANCORA, familiaComModelos());
    m.roteiro.set(ITEM, [
      (i) => falha(i, MOTIVO_PRECO_SHOPEE.lojaVsku, 'product.error_busi_cannot_edit_vsku'),
    ]);

    const r = await rodar(m, [ANCORA, 'prod-fantasma']);

    expect(Object.keys(r).sort()).toEqual([...CHAVES_DO_ENVELOPE_PRECO].sort());
    expect(Object.keys(r.resumo).sort()).toEqual([...CHAVES_DO_RESUMO_PRECO].sort());
    for (const l of r.listings)
      expect(Object.keys(l).sort()).toEqual([...CHAVES_DA_LISTAGEM_PRECO].sort());
    expect(Object.keys(r.produtosSemEnvio[0] ?? {}).sort()).toEqual(
      [...CHAVES_SEM_ENVIO_PRECO].sort(),
    );
    const frases = new Set([
      ...Object.values(MENSAGEM_POR_MOTIVO_PRECO),
      MENSAGEM_ENVIO_PRECO_LIMPO,
    ]);
    for (const l of [...r.listings, ...r.produtosSemEnvio])
      expect(frases.has(l.mensagem)).toBe(true);
    expect(r).toMatchObject({
      canal: 'shopee',
      integracaoId: INT,
      contaNome: 'Loja teste',
      solicitados: 2,
      familias: 1,
    });
  });

  it('(M9) TODA linha falhando ainda é um envelope, e `resumo` conta LINHAS (modelos), não itens', async () => {
    const m = mundo();
    semearProduto(m, ANCORA, 'Âncora');
    m.familias.set(ANCORA, familiaComModelos());
    m.roteiro.set(ITEM, [
      (i) => falha(i, MOTIVO_PRECO_SHOPEE.anuncioNaoEditavel, 'product.error_item_uneditable'),
    ]);

    const r = await rodar(m, [ANCORA]);

    expect(r.resumo).toEqual({ enviados: 0, pulados: 0, falhas: 2, naoTentados: 0 });
  });

  it('duplicatas no pedido contam UMA vez em `solicitados`', async () => {
    const m = mundo();
    semearAnchors(m, 1);

    const r = await rodar(m, ['prod-0', 'prod-0']);

    expect(r.solicitados).toBe(1);
    expect(m.enviar).toHaveBeenCalledTimes(1);
  });

  it('um pedido VAZIO devolve o envelope vazio sem ler nada', async () => {
    const m = mundo();

    const r = await rodar(m, []);

    expect(r.solicitados).toBe(0);
    expect(m.db.leiturasEmLote).toEqual([]);
    expect(m.lerFamilias).not.toHaveBeenCalled();
  });

  it(`acima de ${String(SHOPEE_ENVIO_PRECO_MAX_PRODUTOS)} distintos é ShopeeConfigError (a rota recusa antes), sem ler nada`, async () => {
    const m = mundo();
    const ids = Array.from(
      { length: SHOPEE_ENVIO_PRECO_MAX_PRODUTOS + 1 },
      (_v, i) => `p-${String(i)}`,
    );

    await expect(rodar(m, ids)).rejects.toBeInstanceOf(ShopeeConfigError);
    expect(m.db.leiturasEmLote).toEqual([]);
  });

  it(`PAR do teto: EXATAMENTE ${String(SHOPEE_ENVIO_PRECO_MAX_PRODUTOS)} distintos rodam — o teto do envio é o MESMO que a rota aceita`, async () => {
    const m = mundo();
    const ids = semearAnchors(m, SHOPEE_ENVIO_PRECO_MAX_PRODUTOS);

    const r = await rodar(m, ids);

    expect(r.solicitados).toBe(SHOPEE_ENVIO_PRECO_MAX_PRODUTOS);
    expect(m.enviar).toHaveBeenCalledTimes(SHOPEE_ENVIO_PRECO_MAX_PRODUTOS);
  });

  it('um contexto de OUTRA conta é recusado antes de qualquer leitura', async () => {
    const m = mundo();
    semearAnchors(m, 1);
    const alheio = { ...m.contexto, integracaoId: 'int-2' } as ContextoContaPreco;

    await expect(rodar(m, ['prod-0'], { contexto: alheio })).rejects.toBeInstanceOf(
      ShopeeConfigError,
    );
    expect(m.db.leiturasEmLote).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                               the accounting                                */
/* -------------------------------------------------------------------------- */

describe('conferirContabilidadeDePreco — todo id pedido sai em exatamente UM lugar', () => {
  function linha(produtoId: string): EnvioPrecoListing {
    return {
      produtoId,
      produtoNome: null,
      variacaoProdutoId: null,
      anuncioId: String(ITEM),
      linkDocId: LINK,
      outcome: 'enviado',
      motivo: null,
      mensagem: MENSAGEM_ENVIO_PRECO_LIMPO,
      preco: 10,
      precoAnterior: 9,
      variacoes: null,
      codigo: null,
    };
  }
  function sem(produtoId: string): EnvioPrecoSemEnvio {
    return {
      produtoId,
      produtoNome: null,
      motivo: MOTIVO_PRECO_SHOPEE.produtoNaoEncontrado,
      mensagem: MENSAGEM_POR_MOTIVO_PRECO['produto-nao-encontrado'],
    };
  }

  it('PAR: um filho coberto pelas linhas da SUA âncora, e um id ausente pela sua entrada, fecham a conta', () => {
    expect(() =>
      conferirContabilidadeDePreco(
        [FILHO_A, ANCORA, 'prod-fantasma'],
        new Map([
          [FILHO_A, ANCORA],
          [ANCORA, ANCORA],
        ]),
        [linha(ANCORA)],
        [sem('prod-fantasma')],
      ),
    ).not.toThrow();
  });

  it('QUASE-IGUAL (M12): um id pedido que não aparece em NENHUMA lista LANÇA', () => {
    expect(() =>
      conferirContabilidadeDePreco(
        [ANCORA, ANCORA_3],
        new Map([
          [ANCORA, ANCORA],
          [ANCORA_3, ANCORA_3],
        ]),
        [linha(ANCORA)],
        [],
      ),
    ).toThrow('não aparece em nenhuma lista');
  });

  it('um id nas DUAS listas lança', () => {
    expect(() =>
      conferirContabilidadeDePreco(
        [ANCORA],
        new Map([[ANCORA, ANCORA]]),
        [linha(ANCORA)],
        [sem(ANCORA)],
      ),
    ).toThrow('DUAS listas');
  });

  it('uma linha de uma âncora em que NENHUM pedido resolve lança', () => {
    expect(() =>
      conferirContabilidadeDePreco(
        [ANCORA],
        new Map([[ANCORA, ANCORA]]),
        [linha(ANCORA), linha(ANCORA_2)],
        [],
      ),
    ).toThrow('nenhum pedido resolve');
  });

  it('uma entrada sem envio de um id NÃO pedido lança, e uma entrada repetida também', () => {
    expect(() =>
      conferirContabilidadeDePreco([ANCORA], new Map(), [], [sem(ANCORA), sem('intruso')]),
    ).toThrow('não foi solicitado');
    expect(() =>
      conferirContabilidadeDePreco([ANCORA], new Map(), [], [sem(ANCORA), sem(ANCORA)]),
    ).toThrow('DUAS vezes');
  });
});

/* -------------------------------------------------------------------------- */
/*          review 1 — the send-time price, the ladder's base read, S1         */
/* -------------------------------------------------------------------------- */

/** The produto document with a `precos` map — what the REAL send-time reader sees. */
function precificarNoBanco(m: Mundo, id: string, valor: number, paiId: string | null = null): void {
  m.db.seed(`produtos/${id}`, { nome: `Nome de ${id}`, paiId, precos: precos(valor) });
}

/** The masked `precos` batch reads the run made, in call order. */
function leiturasDePrecos(m: Mundo): { ids: string[]; campos: string[] | null }[] {
  return m.db.leiturasEmLote.filter((l) => l.campos?.includes('precos') === true);
}

type LerFamiliasImpl = (
  db: unknown,
  a: { readonly anchorIds: readonly string[] },
) => Promise<ReadonlyMap<string, FamiliaDePreco>>;

/**
 * Wrap the fixture's family read: `antes` runs before it answers, `depois`
 * after it — the moment between the plan's reads and the pool a case needs.
 */
function envolverLerFamilias(
  m: Mundo,
  ganchos: { readonly antes?: () => void; readonly depois?: () => Promise<void> },
): void {
  const lerFamilias = m.lerFamilias as unknown as Mock<LerFamiliasImpl>;
  const original = lerFamilias.getMockImplementation();
  if (original === undefined) throw new Error('fixture: leitor de famílias ausente');
  lerFamilias.mockImplementation(async (db, a) => {
    ganchos.antes?.();
    const lidas = await original(db, a);
    await ganchos.depois?.();
    return lidas;
  });
}

describe('enviarPrecoManualShopee — o preço é lido na hora do ENVIO, nunca no plano (C-d, L3-F1)', () => {
  it('⚠️ PAR: a tabela alterada ENTRE o plano e o envio ⇒ o item seguinte sai com o valor NOVO', async () => {
    const m = mundo();
    const ids = semearAnchors(m, 2);
    for (const id of ids) precificarNoBanco(m, id, 15);
    m.enviar.mockImplementation((item: ItemDePreco) => {
      // A second operator edits prod-1's tabela while prod-0 is being sent.
      if (item.itemId === ITEM) precificarNoBanco(m, 'prod-1', 18);
      return Promise.resolve(enviado(item));
    });

    const r = await rodar(m, ids, { lerPrecos: undefined });

    expect(m.enviar.mock.calls.map((c) => [c[0].itemId, c[0].alvos[0]?.precoAlvo])).toEqual([
      [ITEM, 15],
      [ITEM + 1, 18],
    ]);
    expect(r.listings.map((l) => l.preco)).toEqual([15, 18]);
  });

  it('QUASE-IGUAL: a tabela INTACTA entre o plano e o envio ⇒ o valor planejado', async () => {
    const m = mundo();
    const ids = semearAnchors(m, 2);
    for (const id of ids) precificarNoBanco(m, id, 15);

    const r = await rodar(m, ids, { lerPrecos: undefined });

    expect(m.enviar.mock.calls.map((c) => [c[0].itemId, c[0].alvos[0]?.precoAlvo])).toEqual([
      [ITEM, 15],
      [ITEM + 1, 15],
    ]);
    expect(r.listings.map((l) => l.preco)).toEqual([15, 15]);
  });

  it('UMA leitura de `precos` POR ITEM, mascarada, imediatamente antes do SEU envio — e nenhuma antes do plano', async () => {
    const m = mundo();
    const ids = semearAnchors(m, 3);
    for (const id of ids) precificarNoBanco(m, id, 15);
    let leiturasAntesDoPlano = -1;
    envolverLerFamilias(m, {
      antes: () => {
        leiturasAntesDoPlano = leiturasDePrecos(m).length;
      },
    });
    const vistasNoEnvio: string[][] = [];
    m.enviar.mockImplementation((item: ItemDePreco) => {
      vistasNoEnvio.push(leiturasDePrecos(m).map((l) => l.ids.join(',')));
      return Promise.resolve(enviado(item));
    });

    await rodar(m, ids, { lerPrecos: undefined });

    expect(leiturasAntesDoPlano).toBe(0);
    expect(leiturasDePrecos(m)).toEqual([
      { ids: ['prod-0'], campos: ['precos'] },
      { ids: ['prod-1'], campos: ['precos'] },
      { ids: ['prod-2'], campos: ['precos'] },
    ]);
    // At each send, the LAST read is that item's own — never all of them up front.
    expect(vistasNoEnvio).toEqual([
      ['prod-0'],
      ['prod-0', 'prod-1'],
      ['prod-0', 'prod-1', 'prod-2'],
    ]);
  });

  it('um item COM modelos lê os FILHOS que o precificam (nunca a âncora), e do BANCO — não da família do plano', async () => {
    const m = mundo();
    semearProduto(m, ANCORA, 'Âncora');
    m.familias.set(ANCORA, familiaComModelos()); // the plan saw 12 / 22
    precificarNoBanco(m, FILHO_A, 13, ANCORA);
    precificarNoBanco(m, FILHO_B, 23, ANCORA);

    await rodar(m, [ANCORA], { lerPrecos: undefined });

    expect(leiturasDePrecos(m)).toEqual([{ ids: [FILHO_A, FILHO_B], campos: ['precos'] }]);
    const item = m.enviar.mock.calls[0]?.[0] as ItemDePreco;
    expect(item.alvos.map((a) => [a.produtoId, a.precoAlvo])).toEqual([
      [FILHO_A, 13],
      [FILHO_B, 23],
    ]);
  });

  it('um produto APAGADO entre o plano e o envio ⇒ `pulado preco-nao-encontrado`, sem chamada à Shopee, sem escrita e sem lançar', async () => {
    const m = mundo();
    precificarNoBanco(m, ANCORA, 15);
    m.db.seed(`produtos/${ANCORA}/prodshopee/${LINK}`, { item_id: ITEM, item_status: 'NORMAL' });
    m.familias.set(ANCORA, familiaSemModelo(ANCORA));
    // Deleted AFTER the plan's reads, before the pool starts.
    envolverLerFamilias(m, {
      depois: async () => {
        await produtoCollection.docRef(asDb(m.db), {}, ANCORA).delete();
      },
    });

    const r = await rodar(m, [ANCORA], { lerPrecos: undefined, enviar: undefined });

    expect(r.produtosSemEnvio).toEqual([]);
    expect(r.listings).toEqual([
      expect.objectContaining({
        produtoId: ANCORA,
        outcome: 'pulado',
        motivo: MOTIVO_PRECO_SHOPEE.precoNaoEncontrado,
        preco: null,
      }),
    ]);
    expect(leiturasDePrecos(m)).toEqual([{ ids: [ANCORA], campos: ['precos'] }]);
    expect(m.getItemBaseInfo).not.toHaveBeenCalled();
    expect(m.updatePrice).not.toHaveBeenCalled();
    expect(m.db.writes).toEqual([]);
  });
});

describe('enviarPrecoManualShopee — a escada relê a base FRESCA (S4, L3-F3)', () => {
  it('⚠️ uma escrita que POUSOU seguida de um write-back que LANÇA ⇒ a tentativa 2 relê SÓ aquele item e não envia NADA', async () => {
    const m = mundo();
    const [a, b] = semearAnchors(m, 2);
    const linkDe = (id: string | undefined): string => `produtos/${String(id)}/prodshopee/${LINK}`;
    m.db.seed(linkDe(a), { item_id: ITEM, item_status: 'NORMAL' });
    m.db.seed(linkDe(b), { item_id: ITEM + 1, item_status: 'NORMAL' });
    // One stateful Shopee: every listing at 10 until an update_price lands.
    const naShopee = new Map<number, number>();
    const baseInfo = m.getItemBaseInfo as Mock<
      (a: { itemIds: readonly number[] }) => Promise<unknown>
    >;
    baseInfo.mockImplementation(({ itemIds }) =>
      Promise.resolve({
        item_list: itemIds.map((item_id) => {
          const preco = naShopee.get(item_id) ?? 10;
          return shopeeItemBaseInfoRowSchema.parse({
            item_id,
            item_status: 'NORMAL',
            has_model: false,
            price_info: [{ currency: 'BRL', original_price: preco, current_price: preco }],
          });
        }),
      }),
    );
    const atualizar = m.updatePrice as Mock<
      (corpo: {
        item_id: number;
        price_list: readonly { original_price: number }[];
      }) => Promise<unknown>
    >;
    atualizar.mockImplementation((corpo) => {
      const preco = corpo.price_list[0]?.original_price ?? 0;
      naShopee.set(corpo.item_id, preco);
      return Promise.resolve(
        shopeeUpdatePriceSchema.parse({
          request_id: 'req-1',
          error: '',
          message: null,
          warning: null,
          response: { success_list: [{ original_price: preco }], failure_list: [] },
        }),
      );
    });
    // The first item's write-back fails ONCE, after its update_price landed.
    m.db.falhasDeUpdate.set(linkDe(a), new Error('14 UNAVAILABLE'));
    const esperar = vi.fn(() => {
      m.db.falhasDeUpdate.clear();
      return Promise.resolve();
    });

    const r = await rodar(m, [a ?? '', b ?? ''], { enviar: undefined, esperar });

    expect(esperar).toHaveBeenCalledTimes(1);
    // PAR: the first attempt read through the request's batch (both ids); the
    // retry through a FRESH one-id reader, which sees the landed 15.
    expect(m.getItemBaseInfo.mock.calls).toEqual([
      [{ itemIds: [ITEM, ITEM + 1] }],
      [{ itemIds: [ITEM] }],
    ]);
    // QUASE-IGUAL: one update_price per listing — the retry sent NOTHING.
    const envios = m.updatePrice.mock.calls.map((c) => (c[0] as { item_id: number }).item_id);
    expect(envios).toEqual([ITEM, ITEM + 1]);
    expect(r.listings.map((l) => [l.outcome, l.motivo])).toEqual([
      ['pulado', MOTIVO_PRECO_SHOPEE.precoIgual],
      ['enviado', null],
    ]);
    // `preco-igual` writes nothing: the lost write-back stays lost (rule 7).
    expect(m.db.writes.filter((w) => w.path === linkDe(a))).toEqual([]);
    expect(m.db.writes.map((w) => w.path)).toContain(linkDe(b));
  });
});

describe('enviarPrecoManualShopee — o S1 da superfície MARCA o aborto (L4-F1)', () => {
  const semLinhas = (item: ItemDePreco): ResultadoEnvioPreco => ({
    tipo: 'enviado',
    modelos: linhas(item, 'enviado', null).slice(0, 0),
    chamadasShopee: 1,
  });

  it('⚠️ LARGURA 2: a violação no item 1 aborta — o item 2, ainda lendo o preço, NUNCA é enviado, e o erro sobe', async () => {
    vi.stubEnv('SHOPEE_PRICE_MANUAL_CONCURRENCY', '2');
    const m = mundo();
    const ids = semearAnchors(m, 6);
    m.roteiro.set(ITEM, [semLinhas]);
    const precosReais = m.lerPrecos.getMockImplementation();
    m.lerPrecos.mockImplementation(async (db: unknown, lidos: readonly string[]) => {
      // Item 2's read is still in flight when item 1's rows are checked.
      if (lidos.includes('prod-1')) await new Promise((resolve) => setTimeout(resolve, 5));
      if (precosReais === undefined) throw new Error('fixture: leitor de preços ausente');
      return precosReais(db, lidos);
    });

    await expect(rodar(m, ids)).rejects.toThrow('linhas incompletas');

    expect(m.enviar).toHaveBeenCalledTimes(1);
    // Item 2 DID start (it read its price); items 3..6 never did.
    expect(m.lerPrecos.mock.calls.map((c) => c[1])).toEqual([['prod-0'], ['prod-1']]);
  });

  it('LARGURA 2, sem atraso: no máximo o irmão JÁ em voo é enviado — os itens 3..6 nunca', async () => {
    vi.stubEnv('SHOPEE_PRICE_MANUAL_CONCURRENCY', '2');
    const m = mundo();
    const ids = semearAnchors(m, 6);
    m.roteiro.set(ITEM, [semLinhas]);

    await expect(rodar(m, ids)).rejects.toThrow('linhas incompletas');

    const enviados = m.enviar.mock.calls.map((c) => c[0].itemId);
    expect(enviados.length).toBeLessThanOrEqual(2);
    expect(enviados.filter((id) => id >= ITEM + 2)).toEqual([]);
  });

  it('LARGURA 2: um irmão que PAUSA enquanto o item ainda lia o preço ⇒ o item sai `nao-tentado conta-pausada`, sem chamada', async () => {
    vi.stubEnv('SHOPEE_PRICE_MANUAL_CONCURRENCY', '2');
    const m = mundo();
    const ids = semearAnchors(m, 3);
    m.roteiro.set(ITEM, [() => pausaBurst(30)]);
    const precosReais = m.lerPrecos.getMockImplementation();
    m.lerPrecos.mockImplementation(async (db: unknown, lidos: readonly string[]) => {
      if (lidos.includes('prod-1')) await new Promise((resolve) => setTimeout(resolve, 5));
      if (precosReais === undefined) throw new Error('fixture: leitor de preços ausente');
      return precosReais(db, lidos);
    });

    const r = await rodar(m, ids);

    expect(m.enviar).toHaveBeenCalledTimes(1);
    expect(r.listings.map((l) => [l.outcome, l.motivo, l.codigo])).toEqual([
      ['nao-tentado', 'conta-pausada', 'error_rate_limit'],
      ['nao-tentado', 'conta-pausada', null],
      ['nao-tentado', 'conta-pausada', null],
    ]);
    expect(r.pausadoAte).toBe(new Date(AGORA + 30_000).toISOString());
  });

  it.each([
    ['um `ShopeeConfigError` (bug NOSSO)', (): Error => new ShopeeConfigError('configuração')],
    [
      'a classe de GUARDA',
      (): Error => new ShopeeEnvioPrecoGuardError(CODIGO_GUARDA_PRECO.contaPausada, 'pausada'),
    ],
  ])(
    'LARGURA 2: %s no item 1 aborta — os itens 3..6 nunca são enviados, e o erro sobe como ele mesmo',
    async (_nome, fabricar) => {
      vi.stubEnv('SHOPEE_PRICE_MANUAL_CONCURRENCY', '2');
      const m = mundo();
      const ids = semearAnchors(m, 6);
      const erro = fabricar();
      m.roteiro.set(ITEM, [() => erro]);

      await expect(rodar(m, ids)).rejects.toBe(erro);

      const enviados = m.enviar.mock.calls.map((c) => c[0].itemId);
      expect(enviados.length).toBeLessThanOrEqual(2);
      expect(enviados.filter((id) => id >= ITEM + 2)).toEqual([]);
    },
  );

  it('QUASE-IGUAL: um irmão que PAUSA durante a ESPERA da tentativa 2 NÃO a cancela — a tentativa 1 já chamou a Shopee, então a linha é o que a tentativa 2 de fato fez (nunca um `nao-tentado` que pode mentir)', async () => {
    vi.stubEnv('SHOPEE_PRICE_MANUAL_CONCURRENCY', '2');
    const m = mundo();
    const ids = semearAnchors(m, 2);
    let tentativasDoItem1 = 0;
    m.enviar.mockImplementation(async (item: ItemDePreco) => {
      if (item.itemId === ITEM + 1) {
        // The sibling pauses 2 ms in — while item 1 is in its 20 ms retry wait.
        await new Promise((resolve) => setTimeout(resolve, 2));
        return pausaBurst(30);
      }
      tentativasDoItem1 += 1;
      if (tentativasDoItem1 === 1) throw erroShopee('error_system_busy');
      return enviado(item);
    });
    const esperar = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

    const r = await rodar(m, ids, { esperar });

    expect(esperar).toHaveBeenCalledTimes(1);
    expect(m.enviar.mock.calls.filter((c) => c[0].itemId === ITEM)).toHaveLength(2);
    expect(r.listings.map((l) => [l.outcome, l.motivo, l.codigo])).toEqual([
      ['enviado', null, null],
      ['nao-tentado', 'conta-pausada', 'error_rate_limit'],
    ]);
  });
});
