import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_MAX_PAGE_SIZE,
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
  type ShopeeClient,
  type ShopeeItemBaseInfo,
  type ShopeeItemList,
  type ShopeeKitItemInfo,
  type ShopeeModelList,
} from '@delfrance/integrations-shopee';
import {
  OPCOES_IMPORTACAO_SHOPEE_PADRAO,
  SHOPEE_ITEM_STATUS,
  toOuterRef,
  type ImportacaoShopeeOptions,
} from '@delfrance/schemas';

import { ShopeeCredencialInvalidaError } from '../core/credentialStore';
import { ShopeeContaNotConfiguredError } from '../core/shopee';
import { ShopeeContaSemShopIdError, ShopeeSemCredencialError } from '../core/tokenStore';
import { INDICES_COMPOSTOS_SHOPEE } from '../pedidos/produtoResolve';
import { FakeDb, asDb, type DocData } from '../testing/fakeDb';
import {
  MOTIVO_FALHA_JOB,
  ShopeeImportBlockedError,
  ShopeeMassImportTasksDisabledError,
} from './errosImportacao';
import type {
  ContextoImportacaoShopee,
  ImportacaoShopeeDeps,
  ItemLido,
  ResultadoImportacaoShopee,
} from './itemLido';
import {
  FALHAS_CAP,
  ITENS_POR_DESPACHO,
  ITENS_POR_DESPACHO_SEM_FOTOS,
  LINK_QUERY_CHUNK,
  MAX_TENTATIVAS,
  MSG_LIMITE_DIARIO,
  MSG_OFFSET_ACIMA_DO_LIMITE,
  MSG_PAGINAS_MAX,
  MSG_VALVULA_FECHADA,
  PAGINAS_MAX_POR_JOB,
  PAUSA_BURST_PADRAO_S,
  SHOPEE_MASS_IMPORT_QUEUE,
  ShopeeImportacaoEmAndamentoError,
  cancelarImportacaoShopee,
  finalizarImportacaoShopee,
  iniciarImportacaoShopee,
  processarImportacaoShopee,
} from './importacaoMassa';

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented ids only (partner 1000001, shop 987654, integração     */
/*  int-1). No real listing id, no buyer datum, no name beyond an invented one. */
/* -------------------------------------------------------------------------- */

const AGORA_MS = 1_770_000_000_000;
const INT_A = 'int-1';
const INT_B = 'int-2';
const JOB = 'job-1';
const COL = 'importacoesShopee';
const CAMINHO_JOB = `${COL}/${JOB}`;
const REF_CONTA_A = toOuterRef(`integracao/${INT_A}`);
const REF_CONTA_B = toOuterRef(`integracao/${INT_B}`);
const ITEM = 2_500_139_861;

const [, INDICE_LISTAGEM] = INDICES_COMPOSTOS_SHOPEE;

function opcoes(over: Partial<ImportacaoShopeeOptions> = {}): ImportacaoShopeeOptions {
  return {
    ...OPCOES_IMPORTACAO_SHOPEE_PADRAO,
    statuses: [...OPCOES_IMPORTACAO_SHOPEE_PADRAO.statuses],
    ...over,
  };
}

function semearJob(db: FakeDb, over: DocData = {}): void {
  db.seed(CAMINHO_JOB, {
    integracaoId: INT_A,
    status: 'running',
    nextOffset: null,
    fila: [],
    filaKits: [],
    scanned: 0,
    imported: 0,
    created: 0,
    skipped: 0,
    kits: 0,
    failureCount: 0,
    failures: [],
    options: opcoes(),
    startedAt: AGORA_MS - 1000,
    updatedAt: AGORA_MS - 1000,
    finishedAt: null,
    erro: null,
    ...over,
  });
}

function job(db: FakeDb): DocData {
  const doc = db.store[CAMINHO_JOB]?.data;
  if (!doc) throw new Error(`o job ${JOB} não existe no fake`);
  return doc;
}

function semearLink(db: FakeDb, produtoId: string, itemId: unknown, contaRef: string): void {
  db.seed(`produtos/${produtoId}/prodshopee/lnk-${produtoId}`, {
    item_id: itemId,
    contaProdutoShopeeOuterRef: contaRef,
  });
}

/** One `get_item_list` row. `tag.kit` is the ONLY kit-discovery channel. */
function linha(itemId: number, over: DocData = {}): DocData {
  return {
    item_id: itemId,
    item_status: SHOPEE_ITEM_STATUS.normal,
    update_time: 1_770_000,
    tag: { kit: false },
    ...over,
  };
}

function pagina(over: Partial<Record<string, unknown>> = {}): ShopeeItemList {
  return {
    item: [],
    total_count: null,
    has_next_page: false,
    next_offset: null,
    next: null,
    ...over,
  } as unknown as ShopeeItemList;
}

/** One `get_item_base_info` row — only the fields these tests read. */
function linhaBase(itemId: number, over: DocData = {}): DocData {
  return { item_id: itemId, item_name: `Anúncio ${String(itemId)}`, has_model: false, ...over };
}

function corpoBase(linhas: DocData[], raiz: DocData = {}): ShopeeItemBaseInfo {
  return { item_list: linhas, ...raiz } as unknown as ShopeeItemBaseInfo;
}

function listaDeModelos(): ShopeeModelList {
  return { tier_variation: [], model: [] } as unknown as ShopeeModelList;
}

function kitInfo(produto: DocData | null): ShopeeKitItemInfo {
  return { product_info: produto } as unknown as ShopeeKitItemInfo;
}

function resultado(over: Partial<ResultadoImportacaoShopee> = {}): ResultadoImportacaoShopee {
  return {
    produtoId: 'prod-1',
    criado: true,
    nome: 'Anúncio',
    variacoes: { total: 0, criadas: 0, semLink: 0 },
    fotos: { importadas: 0, ignoradas: 0, falhas: 0 },
    ...over,
  };
}

interface ClienteFalso {
  getItemList: Mock;
  getItemBaseInfo: Mock;
  getModelList: Mock;
  getKitItemInfo: Mock;
}

function clienteFalso(over: Partial<ClienteFalso> = {}): ClienteFalso {
  return {
    getItemList: vi.fn(async () => pagina()),
    getItemBaseInfo: vi.fn(async () => corpoBase([])),
    getModelList: vi.fn(async () => listaDeModelos()),
    getKitItemInfo: vi.fn(async () => kitInfo({ item_id: ITEM })),
    ...over,
  };
}

function contexto(cliente: ClienteFalso): ContextoImportacaoShopee {
  return {
    client: cliente as unknown as ShopeeClient,
    integracaoId: INT_A,
    tabelaNormalOuterRef: 'documents/tabelasDePrecos/tab-normal',
    tabelaPromocionalOuterRef: null,
    depositoOuterRef: 'documents/depositos/dep-1',
  };
}

interface Montagem {
  db: FakeDb;
  cliente: ClienteFalso;
  deps: ImportacaoShopeeDeps;
  enqueue: Mock;
  importarAnuncio: Mock;
  importarKit: Mock;
}

function montar(
  over: { cliente?: ClienteFalso; deps?: Partial<ImportacaoShopeeDeps> } = {},
): Montagem {
  const db = new FakeDb();
  const cliente = over.cliente ?? clienteFalso();
  const enqueue = vi.fn(async () => {});
  const importarAnuncio = vi.fn(async () => resultado());
  const importarKit = vi.fn(async () => resultado({ kit: { componentes: 2, criado: true } }));
  const deps: ImportacaoShopeeDeps = {
    db: asDb(db),
    resolverContexto: async () => contexto(cliente),
    importarAnuncio,
    importarKit,
    scheduler: { enqueue },
    now: () => AGORA_MS,
    ...over.deps,
  };
  return { db, cliente, deps, enqueue, importarAnuncio, importarKit };
}

const PAYLOAD = { jobId: JOB, integracaoId: INT_A };

beforeEach(() => {
  vi.restoreAllMocks();
});

/* ========================================================================== */
/*  Início e guarda (1–5)                                                     */
/* ========================================================================== */

describe('iniciarImportacaoShopee', () => {
  it('1 — cria o doc com todos os contadores em zero e status running', async () => {
    const db = new FakeDb();

    const jobId = await iniciarImportacaoShopee(asDb(db), {
      integracaoId: INT_A,
      options: opcoes(),
      now: AGORA_MS,
    });

    const doc = db.store[`${COL}/${jobId}`]?.data;
    expect(doc).toMatchObject({
      integracaoId: INT_A,
      status: 'running',
      nextOffset: null,
      fila: [],
      filaKits: [],
      scanned: 0,
      imported: 0,
      created: 0,
      skipped: 0,
      kits: 0,
      failureCount: 0,
      failures: [],
      startedAt: AGORA_MS,
      updatedAt: AGORA_MS,
      finishedAt: null,
      erro: null,
    });
  });

  it('2 — recusa um segundo job running da mesma conta com ShopeeImportacaoEmAndamentoError', async () => {
    const db = new FakeDb();
    semearJob(db);

    await expect(
      iniciarImportacaoShopee(asDb(db), { integracaoId: INT_A, options: opcoes(), now: AGORA_MS }),
    ).rejects.toBeInstanceOf(ShopeeImportacaoEmAndamentoError);
  });

  it('3 — ⛔ não recusa um job running de OUTRA conta', async () => {
    const db = new FakeDb();
    semearJob(db, { integracaoId: INT_B });

    const jobId = await iniciarImportacaoShopee(asDb(db), {
      integracaoId: INT_A,
      options: opcoes(),
      now: AGORA_MS,
    });

    expect(db.store[`${COL}/${jobId}`]?.data.integracaoId).toBe(INT_A);
  });

  it('4 — não enfileira — quem enfileira é a rota', async () => {
    const db = new FakeDb();

    const jobId = await iniciarImportacaoShopee(asDb(db), {
      integracaoId: INT_A,
      options: opcoes(),
      now: AGORA_MS,
    });

    // A ÚNICA escrita do início é o doc do job: não há transporte para observar
    // porque a função não recebe scheduler nenhum — é a rota que enfileira,
    // DEPOIS, para que uma falha de enqueue tenha um doc para carimbar.
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0]?.path).toBe(`${COL}/${jobId}`);
  });

  it('5 — um doc de job sem NENHUMA chave de options parseia com os padrões', async () => {
    const { db, cliente, deps } = montar();
    const semOptions: DocData = {
      integracaoId: INT_A,
      status: 'running',
      startedAt: AGORA_MS - 1000,
      updatedAt: AGORA_MS - 1000,
    };
    db.seed(CAMINHO_JOB, semOptions);

    await processarImportacaoShopee(deps, PAYLOAD, 0);

    expect(cliente.getItemList).toHaveBeenCalledWith(
      expect.objectContaining({
        statuses: [...OPCOES_IMPORTACAO_SHOPEE_PADRAO.statuses],
        pageSize: SHOPEE_MAX_PAGE_SIZE,
        offset: 0,
      }),
    );
  });
});

/* ========================================================================== */
/*  Varredura (6–16)                                                          */
/* ========================================================================== */

describe('processarImportacaoShopee — varredura', () => {
  it('6 — varre UMA página por despacho', async () => {
    const cliente = clienteFalso({
      getItemList: vi.fn(async () => pagina({ item: [], has_next_page: true, next_offset: 100 })),
    });
    const { db, deps } = montar({ cliente });
    semearJob(db);

    const saida = await processarImportacaoShopee(deps, PAYLOAD, 0);

    expect(cliente.getItemList).toHaveBeenCalledTimes(1);
    expect(saida).toBe('continued');
  });

  it('7 — segue o next_offset do SERVIDOR, nunca offset+page_size', async () => {
    const cliente = clienteFalso({
      getItemList: vi.fn(async () => pagina({ item: [], has_next_page: true, next_offset: 7 })),
    });
    const { db, deps } = montar({ cliente });
    semearJob(db);

    await processarImportacaoShopee(deps, PAYLOAD, 0);

    // 7, e não 0 + 100: a página diz "este valor precisa ir no próximo
    // request.offset" e a API reserva o direito de os dois diferirem.
    expect(job(db).nextOffset).toBe(7);
  });

  it('8 — has_next_page false zera o nextOffset mesmo com next_offset presente', async () => {
    const cliente = clienteFalso({
      getItemList: vi.fn(async () => pagina({ item: [], has_next_page: false, next_offset: 50 })),
    });
    const { db, deps } = montar({ cliente });
    semearJob(db);

    const saida = await processarImportacaoShopee(deps, PAYLOAD, 0);

    expect(job(db).nextOffset).toBeNull();
    expect(saida).toBe('done');
  });

  it('9 — ⛔ um next_offset que NÃO avança encerra a varredura e loga uma linha', async () => {
    const aviso = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cliente = clienteFalso({
      getItemList: vi.fn(async () => pagina({ item: [], has_next_page: true, next_offset: 20 })),
    });
    const { db, deps } = montar({ cliente });
    semearJob(db, { nextOffset: 20 });

    const saida = await processarImportacaoShopee(deps, PAYLOAD, 0);

    expect(job(db).nextOffset).toBeNull();
    expect(saida).toBe('done');
    expect(aviso).toHaveBeenCalledTimes(1);
  });

  it('9b — ⛔ has_next_page true SEM next_offset é TERMINAL, nunca fim silencioso', async () => {
    const cliente = clienteFalso({
      getItemList: vi.fn(async () => pagina({ item: [], has_next_page: true, next_offset: null })),
    });
    const { db, deps, enqueue } = montar({ cliente });
    semearJob(db);

    const saida = await processarImportacaoShopee(deps, PAYLOAD, 0);

    expect(saida).toBe('failed');
    expect(job(db).status).toBe('failed');
    expect(String(job(db).erro)).toContain('next_offset');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('10 — manda os statuses da option, nunca um padrão do módulo', async () => {
    const { db, cliente, deps } = montar();
    semearJob(db, { options: opcoes({ statuses: ['BANNED'] }) });

    await processarImportacaoShopee(deps, PAYLOAD, 0);

    expect(cliente.getItemList).toHaveBeenCalledWith(
      expect.objectContaining({ statuses: ['BANNED'] }),
    );
  });

  it('11 — manda page_size 100', async () => {
    const { db, cliente, deps } = montar();
    semearJob(db);

    await processarImportacaoShopee(deps, PAYLOAD, 0);

    expect(cliente.getItemList).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: SHOPEE_MAX_PAGE_SIZE }),
    );
    expect(SHOPEE_MAX_PAGE_SIZE).toBe(100);
  });

  it('12 — repassa updateTimeFrom/To só quando a option os traz', async () => {
    const semJanela = montar();
    semearJob(semJanela.db);
    await processarImportacaoShopee(semJanela.deps, PAYLOAD, 0);
    const chamadaSemJanela = semJanela.cliente.getItemList.mock.calls[0]?.[0] as DocData;
    expect(chamadaSemJanela).not.toHaveProperty('updateTimeFromS');
    expect(chamadaSemJanela).not.toHaveProperty('updateTimeToS');

    const comJanela = montar();
    semearJob(comJanela.db, {
      options: opcoes({ updateTimeFromS: 1_700_000_000, updateTimeToS: 1_700_100_000 }),
    });
    await processarImportacaoShopee(comJanela.deps, PAYLOAD, 0);
    expect(comJanela.cliente.getItemList).toHaveBeenCalledWith(
      expect.objectContaining({ updateTimeFromS: 1_700_000_000, updateTimeToS: 1_700_100_000 }),
    );
  });

  it('13 — soma scanned com TODAS as linhas da página, inclusive as ignoradas', async () => {
    const cliente = clienteFalso({
      getItemList: vi.fn(async () =>
        pagina({
          item: [
            linha(1),
            linha(2, { item_status: SHOPEE_ITEM_STATUS.sellerDelete }),
            linha(3, { item_status: SHOPEE_ITEM_STATUS.shopeeDelete }),
          ],
        }),
      ),
      getItemBaseInfo: vi.fn(async () => corpoBase([linhaBase(1)])),
    });
    const { db, deps } = montar({ cliente });
    semearJob(db);

    await processarImportacaoShopee(deps, PAYLOAD, 0);

    expect(job(db).scanned).toBe(3);
  });

  it('14 — filtra linhas com status de DELETE e conta em skipped', async () => {
    const cliente = clienteFalso({
      getItemList: vi.fn(async () =>
        pagina({ item: [linha(1), linha(2, { item_status: SHOPEE_ITEM_STATUS.sellerDelete })] }),
      ),
      getItemBaseInfo: vi.fn(async () => corpoBase([linhaBase(1)])),
    });
    const { db, deps, importarAnuncio } = montar({ cliente });
    semearJob(db);

    await processarImportacaoShopee(deps, PAYLOAD, 0);

    expect(job(db).skipped).toBe(1);
    expect(importarAnuncio).toHaveBeenCalledTimes(1);
  });

  it('15 — ⛔ total_count nunca é denominador nem condição de parada', async () => {
    const cliente = clienteFalso({
      getItemList: vi.fn(async () =>
        pagina({ item: [linha(1)], total_count: 10_000, has_next_page: false }),
      ),
      getItemBaseInfo: vi.fn(async () => corpoBase([linhaBase(1)])),
    });
    const { db, deps } = montar({ cliente });
    semearJob(db);

    const saida = await processarImportacaoShopee(deps, PAYLOAD, 0);

    // `total_count` diz 10 000 e mesmo assim o job COMPLETA: a única condição de
    // parada é `has_next_page`.
    expect(saida).toBe('done');
    expect(job(db).status).toBe('completed');
  });

  it('16 — PAGINAS_MAX_POR_JOB encerra o job com erro próprio', async () => {
    const { db, cliente, deps } = montar();
    semearJob(db, { scanned: PAGINAS_MAX_POR_JOB * SHOPEE_MAX_PAGE_SIZE });

    const saida = await processarImportacaoShopee(deps, PAYLOAD, 0);

    expect(saida).toBe('failed');
    expect(job(db).erro).toBe(MSG_PAGINAS_MAX);
    expect(cliente.getItemList).not.toHaveBeenCalled();
  });
});

/* ========================================================================== */
/*  Filtro de já-cadastrados (17–22)                                          */
/* ========================================================================== */

describe('processarImportacaoShopee — filtro de já-cadastrados', () => {
  function paginaDe(ids: number[]): ShopeeItemList {
    return pagina({ item: ids.map((id) => linha(id)) });
  }

  it('17 — consulta prodshopee em blocos de 30', async () => {
    const ids = Array.from({ length: 35 }, (_, i) => 1000 + i);
    const cliente = clienteFalso({
      getItemList: vi.fn(async () => paginaDe(ids)),
      getItemBaseInfo: vi.fn(async (p: { itemIds: number[] }) =>
        corpoBase(p.itemIds.map((id) => linhaBase(id))),
      ),
    });
    const { db, deps } = montar({ cliente });
    semearJob(db);

    await processarImportacaoShopee(deps, PAYLOAD, 0);

    const grupo = db.consultasCompletas.filter((c) => c.fonte === 'group:prodshopee');
    expect(grupo).toHaveLength(2);
    expect((grupo[0]?.clausulas[0]?.[2] as number[]).length).toBe(LINK_QUERY_CHUNK);
    expect((grupo[1]?.clausulas[0]?.[2] as number[]).length).toBe(35 - LINK_QUERY_CHUNK);
  });

  it('18 — manda as DUAS cláusulas ao servidor — item_id in e a conta', async () => {
    const cliente = clienteFalso({ getItemList: vi.fn(async () => paginaDe([ITEM])) });
    const { db, deps } = montar({ cliente });
    semearJob(db);

    await processarImportacaoShopee(deps, PAYLOAD, 0);

    const grupo = db.consultasCompletas.find((c) => c.fonte === 'group:prodshopee');
    expect(grupo?.clausulas).toEqual([
      ['item_id', 'in', [ITEM]],
      ['contaProdutoShopeeOuterRef', '==', REF_CONTA_A],
    ]);
    // Os NOMES vêm do mesmo par que `firestore.indexes.json` declara: renomear
    // um campo do link quebra os dois lados juntos.
    expect(grupo?.clausulas.map((c) => c[0])).toEqual([...INDICE_LISTAGEM.campos]);
    expect(INDICE_LISTAGEM.collectionGroup).toBe('prodshopee');
  });

  it('19 — ⛔ um link de OUTRA conta com o mesmo item_id NÃO é ignorado', async () => {
    const cliente = clienteFalso({
      getItemList: vi.fn(async () => paginaDe([ITEM])),
      getItemBaseInfo: vi.fn(async () => corpoBase([linhaBase(ITEM)])),
    });
    const { db, deps, importarAnuncio } = montar({ cliente });
    semearJob(db);
    semearLink(db, 'prod-outra-conta', ITEM, REF_CONTA_B);

    await processarImportacaoShopee(deps, PAYLOAD, 0);

    expect(job(db).skipped).toBe(0);
    expect(importarAnuncio).toHaveBeenCalledTimes(1);
  });

  it('19b — o MESMO item_id sob ESTA conta é ignorado', async () => {
    const cliente = clienteFalso({ getItemList: vi.fn(async () => paginaDe([ITEM])) });
    const { db, deps, importarAnuncio } = montar({ cliente });
    semearJob(db);
    semearLink(db, 'prod-desta-conta', ITEM, REF_CONTA_A);

    await processarImportacaoShopee(deps, PAYLOAD, 0);

    expect(job(db).skipped).toBe(1);
    expect(importarAnuncio).not.toHaveBeenCalled();
  });

  it('20 — os ids da fila são NÚMEROS', async () => {
    const cliente = clienteFalso({
      getItemList: vi.fn(async () =>
        pagina({ item: [linha(11), linha(12)], has_next_page: false }),
      ),
      getItemBaseInfo: vi.fn(async () => corpoBase([])),
    });
    const { db, deps } = montar({ cliente });
    // Cap de 1 item por despacho não existe; força a fila a sobrar carimbando
    // um lote que devolve zero linhas, de modo que a fila persistida seja lida.
    semearJob(db, { fila: [] });

    await processarImportacaoShopee(deps, PAYLOAD, 0);

    const chamada = cliente.getItemBaseInfo.mock.calls[0]?.[0] as { itemIds: unknown[] };
    for (const id of chamada.itemIds) expect(typeof id).toBe('number');
  });

  it('21 — atualizarCadastrados: true pula o filtro inteiro (zero consultas)', async () => {
    const cliente = clienteFalso({
      getItemList: vi.fn(async () => paginaDe([ITEM])),
      getItemBaseInfo: vi.fn(async () => corpoBase([linhaBase(ITEM)])),
    });
    const { db, deps, importarAnuncio } = montar({ cliente });
    semearJob(db, { options: opcoes({ atualizarCadastrados: true }) });
    semearLink(db, 'prod-desta-conta', ITEM, REF_CONTA_A);

    await processarImportacaoShopee(deps, PAYLOAD, 0);

    expect(db.consultasCompletas.filter((c) => c.fonte === 'group:prodshopee')).toHaveLength(0);
    expect(job(db).skipped).toBe(0);
    expect(importarAnuncio).toHaveBeenCalledTimes(1);
  });

  it('22 — um item_id gravado como STRING pelo legado não casa — e o item é importado', async () => {
    const cliente = clienteFalso({
      getItemList: vi.fn(async () => paginaDe([ITEM])),
      getItemBaseInfo: vi.fn(async () => corpoBase([linhaBase(ITEM)])),
    });
    const { db, deps, importarAnuncio } = montar({ cliente });
    semearJob(db);
    semearLink(db, 'prod-legado', String(ITEM), REF_CONTA_A);

    await processarImportacaoShopee(deps, PAYLOAD, 0);

    expect(job(db).skipped).toBe(0);
    expect(importarAnuncio).toHaveBeenCalledTimes(1);
  });
});

/* ========================================================================== */
/*  Dreno (23–31)                                                             */
/* ========================================================================== */

describe('processarImportacaoShopee — dreno', () => {
  function corpoDe(p: { itemIds: number[] }): ShopeeItemBaseInfo {
    return corpoBase(p.itemIds.map((id) => linhaBase(id)));
  }

  it('23 — drena no máximo ITENS_POR_DESPACHO com fotos ligadas', async () => {
    const fila = Array.from({ length: ITENS_POR_DESPACHO + 5 }, (_, i) => 2000 + i);
    const cliente = clienteFalso({ getItemBaseInfo: vi.fn(async (p) => corpoDe(p)) });
    const { db, deps, importarAnuncio } = montar({ cliente });
    semearJob(db, { fila, options: opcoes({ importarFotos: true }) });

    await processarImportacaoShopee(deps, PAYLOAD, 0);

    expect(importarAnuncio).toHaveBeenCalledTimes(ITENS_POR_DESPACHO);
    expect(job(db).fila).toHaveLength(5);
  });

  it('24 — drena até ITENS_POR_DESPACHO_SEM_FOTOS com importarFotos: false', async () => {
    const fila = Array.from({ length: ITENS_POR_DESPACHO_SEM_FOTOS + 3 }, (_, i) => 2000 + i);
    const cliente = clienteFalso({ getItemBaseInfo: vi.fn(async (p) => corpoDe(p)) });
    const { db, deps, importarAnuncio } = montar({ cliente });
    semearJob(db, { fila, options: opcoes({ importarFotos: false }) });

    await processarImportacaoShopee(deps, PAYLOAD, 0);

    // O lote de leitura é limitado pelo teto do fio (50), então o dreno deste
    // despacho é `min(40, 50)`.
    expect(importarAnuncio).toHaveBeenCalledTimes(ITENS_POR_DESPACHO_SEM_FOTOS);
    expect(job(db).fila).toHaveLength(3);
  });

  it('25 — um lote, uma chamada de get_item_base_info', async () => {
    const cliente = clienteFalso({ getItemBaseInfo: vi.fn(async (p) => corpoDe(p)) });
    const { db, deps } = montar({ cliente });
    semearJob(db, { fila: [1, 2, 3] });

    await processarImportacaoShopee(deps, PAYLOAD, 0);

    expect(cliente.getItemBaseInfo).toHaveBeenCalledTimes(1);
    expect(cliente.getItemBaseInfo).toHaveBeenCalledWith({ itemIds: [1, 2, 3] });
  });

  it('26 — reconcilia por item_id, nunca por posição', async () => {
    const cliente = clienteFalso({
      // A resposta chega na ORDEM INVERSA do pedido.
      getItemBaseInfo: vi.fn(async () => corpoBase([linhaBase(3), linhaBase(2), linhaBase(1)])),
    });
    const { db, deps, importarAnuncio } = montar({ cliente });
    semearJob(db, { fila: [1, 2, 3] });

    await processarImportacaoShopee(deps, PAYLOAD, 0);

    const vistos = importarAnuncio.mock.calls.map((c) => {
      const item = c[1] as ItemLido;
      return [item.itemId, item.base.item_id];
    });
    expect(vistos).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it('27 — um id ausente no lote vira falha item-nao-retornado, não trava o lote', async () => {
    const cliente = clienteFalso({
      getItemBaseInfo: vi.fn(async () => corpoBase([linhaBase(1), linhaBase(3)])),
    });
    const { db, deps, importarAnuncio } = montar({ cliente });
    semearJob(db, { fila: [1, 2, 3] });

    await processarImportacaoShopee(deps, PAYLOAD, 0);

    expect(importarAnuncio).toHaveBeenCalledTimes(2);
    expect(job(db).failureCount).toBe(1);
    expect(job(db).failures).toEqual([
      expect.objectContaining({ itemId: 2, motivo: MOTIVO_FALHA_JOB.itemNaoRetornado }),
    ]);
  });

  it('28 — chama get_model_list só quando has_model é true', async () => {
    const cliente = clienteFalso({
      getItemBaseInfo: vi.fn(async () =>
        corpoBase([linhaBase(1, { has_model: true }), linhaBase(2, { has_model: false })]),
      ),
    });
    const { db, deps } = montar({ cliente });
    semearJob(db, { fila: [1, 2] });

    await processarImportacaoShopee(deps, PAYLOAD, 0);

    expect(cliente.getModelList).toHaveBeenCalledTimes(1);
    expect(cliente.getModelList).toHaveBeenCalledWith({ itemId: 1 });
  });

  it('29 — há UM merge de checkpoint por item drenado', async () => {
    const cliente = clienteFalso({ getItemBaseInfo: vi.fn(async (p) => corpoDe(p)) });
    const { db, deps } = montar({ cliente });
    semearJob(db, { fila: [1, 2, 3], nextOffset: 5 });

    await processarImportacaoShopee(deps, PAYLOAD, 0);

    // Três itens, três checkpoints. Nenhuma varredura aconteceu (a fila não
    // estava vazia), então não há o merge da página para descontar.
    const escritas = db.writes.filter((w) => w.path === CAMINHO_JOB);
    expect(escritas).toHaveLength(3);
  });

  it('30 — criados só incrementa quando o resultado diz criado', async () => {
    const cliente = clienteFalso({ getItemBaseInfo: vi.fn(async (p) => corpoDe(p)) });
    const importarAnuncio = vi.fn(async (_d: unknown, entrada: ItemLido) =>
      resultado({ criado: entrada.itemId === 1 }),
    );
    const { db, deps } = montar({ cliente, deps: { importarAnuncio } });
    semearJob(db, { fila: [1, 2] });

    await processarImportacaoShopee(deps, PAYLOAD, 0);

    expect(job(db).imported).toBe(2);
    expect(job(db).created).toBe(1);
  });

  it('31 — passa o ItemLido já lido — o importador não relê nada', async () => {
    const cliente = clienteFalso({
      getItemBaseInfo: vi.fn(async () => corpoBase([linhaBase(ITEM, { item_name: 'Camiseta' })])),
    });
    const { db, deps, importarAnuncio } = montar({ cliente });
    semearJob(db, { fila: [ITEM] });

    await processarImportacaoShopee(deps, PAYLOAD, 0);

    const entrada = importarAnuncio.mock.calls[0]?.[1] as ItemLido;
    expect(entrada.itemId).toBe(ITEM);
    expect(entrada.base.item_name).toBe('Camiseta');
    expect(entrada.models).toBeNull();
    // UMA leitura de item_base_info no despacho inteiro, e o importador recebeu
    // o registro já montado: não há por onde ele reler.
    expect(cliente.getItemBaseInfo).toHaveBeenCalledTimes(1);
  });
});

/* ========================================================================== */
/*  Contenção (32–40)                                                         */
/* ========================================================================== */

describe('processarImportacaoShopee — contenção', () => {
  function corpoDe(p: { itemIds: number[] }): ShopeeItemBaseInfo {
    return corpoBase(p.itemIds.map((id) => linhaBase(id)));
  }

  it('32 — um ShopeeImportBlockedError vira falha contida com motivo e mensagem', async () => {
    const cliente = clienteFalso({ getItemBaseInfo: vi.fn(async (p) => corpoDe(p)) });
    const importarAnuncio = vi.fn(async () => {
      throw new ShopeeImportBlockedError(MOTIVO_FALHA_JOB.semNome, ITEM, 'item_name em branco');
    });
    const { db, deps } = montar({ cliente, deps: { importarAnuncio } });
    semearJob(db, { fila: [ITEM] });

    const saida = await processarImportacaoShopee(deps, PAYLOAD, 0);

    expect(saida).toBe('done');
    expect(job(db).failures).toEqual([
      { itemId: ITEM, motivo: MOTIVO_FALHA_JOB.semNome, mensagem: 'item_name em branco' },
    ]);
    expect(job(db).failureCount).toBe(1);
    expect(job(db).imported).toBe(0);
  });

  it('33 — um erro de schema de UM item registra os CAMINHOS, nunca um valor', async () => {
    const cliente = clienteFalso({
      getItemBaseInfo: vi.fn(async (p) => corpoDe(p)),
      getModelList: vi.fn(async () => {
        throw new ShopeeSchemaError('Shopee respondeu num formato inesperado.', {
          campos: ['response.model[0].price_info', 'response.tier_variation'],
          httpStatus: 200,
          path: '/api/v2/product/get_model_list',
        });
      }),
    });
    const { db, deps } = montar({ cliente });
    semearJob(db, { fila: [ITEM] });
    cliente.getItemBaseInfo.mockImplementation(async () =>
      corpoBase([linhaBase(ITEM, { has_model: true })]),
    );

    await processarImportacaoShopee(deps, PAYLOAD, 0);

    const falha = (job(db).failures as DocData[])[0];
    expect(falha?.motivo).toBe(MOTIVO_FALHA_JOB.erroSchema);
    expect(String(falha?.mensagem)).toContain('response.model[0].price_info');
    expect(String(falha?.mensagem)).toContain('response.tier_variation');
  });

  it('33b — um ShopeeApiError de item vira erro-shopee com a CLASSE e o código', async () => {
    const cliente = clienteFalso({ getItemBaseInfo: vi.fn(async (p) => corpoDe(p)) });
    const importarAnuncio = vi.fn(async () => {
      throw new ShopeeApiError('Shopee respondeu error_data (HTTP 200)', {
        code: 'error_data',
        kind: SHOPEE_ERROR_KIND.other,
        httpStatus: 200,
        path: '/api/v2/product/get_item_base_info',
      });
    });
    const { db, deps } = montar({ cliente, deps: { importarAnuncio } });
    semearJob(db, { fila: [ITEM] });

    await processarImportacaoShopee(deps, PAYLOAD, 0);

    expect((job(db).failures as DocData[])[0]).toEqual({
      itemId: ITEM,
      motivo: MOTIVO_FALHA_JOB.erroShopee,
      mensagem: 'ShopeeApiError: error_data',
    });
  });

  it('34 — failures para no FALHAS_CAP e failureCount continua subindo', async () => {
    const cheias = Array.from({ length: FALHAS_CAP }, (_, i) => ({
      itemId: 9000 + i,
      motivo: MOTIVO_FALHA_JOB.itemNaoRetornado,
      mensagem: '',
    }));
    const cliente = clienteFalso({ getItemBaseInfo: vi.fn(async () => corpoBase([])) });
    const { db, deps } = montar({ cliente });
    semearJob(db, { fila: [ITEM], failures: cheias, failureCount: FALHAS_CAP });

    await processarImportacaoShopee(deps, PAYLOAD, 0);

    expect((job(db).failures as DocData[]).length).toBe(FALHAS_CAP);
    expect(job(db).failureCount).toBe(FALHAS_CAP + 1);
  });

  it('35 — ⛔ um burst NÃO vira falha de item', async () => {
    const cliente = clienteFalso({ getItemBaseInfo: vi.fn(async (p) => corpoDe(p)) });
    const importarAnuncio = vi.fn(async () => {
      throw new ShopeeRateLimitError('Shopee respondeu error_busy (HTTP 200)', {
        code: 'error_busy',
        kind: SHOPEE_ERROR_KIND.burst,
        httpStatus: 200,
        path: '/api/v2/product/get_item_base_info',
      });
    });
    const { db, deps } = montar({ cliente, deps: { importarAnuncio } });
    semearJob(db, { fila: [1, 2, 3] });

    const saida = await processarImportacaoShopee(deps, PAYLOAD, 0);

    // Nenhuma linha de falha, nenhum contador — a fila restante NÃO queima.
    expect(job(db).failureCount).toBe(0);
    expect(job(db).failures).toEqual([]);
    expect(job(db).status).toBe('running');
    expect(saida).toBe('continued');
  });

  it('36 — um burst devolve continued, reenfileira com o Retry-After e NÃO consome tentativa', async () => {
    const cliente = clienteFalso({
      getItemList: vi.fn(async () => {
        throw new ShopeeRateLimitError('Shopee respondeu error_busy (HTTP 200)', {
          code: 'error_busy',
          kind: SHOPEE_ERROR_KIND.burst,
          httpStatus: 200,
          path: '/api/v2/product/get_item_list',
          retryAfterSeconds: 17,
        });
      }),
    });
    const { db, deps, enqueue } = montar({ cliente });
    semearJob(db);

    // `retryCount` na ÚLTIMA tentativa: mesmo assim a saída é `continued` e o
    // job segue `running` — a pausa não é uma tentativa.
    const saida = await processarImportacaoShopee(deps, PAYLOAD, MAX_TENTATIVAS - 1);

    expect(saida).toBe('continued');
    expect(enqueue).toHaveBeenCalledWith(PAYLOAD, { scheduleDelaySeconds: 17 });
    expect(job(db).status).toBe('running');
    expect(job(db).erro).toBeNull();
  });

  it('37 — sem Retry-After usa PAUSA_BURST_PADRAO_S', async () => {
    const cliente = clienteFalso({
      getItemList: vi.fn(async () => {
        throw new ShopeeRateLimitError('Shopee respondeu error_busy (HTTP 200)', {
          code: 'error_busy',
          kind: SHOPEE_ERROR_KIND.burst,
          httpStatus: 200,
          path: '/api/v2/product/get_item_list',
        });
      }),
    });
    const { db, deps, enqueue } = montar({ cliente });
    semearJob(db);

    await processarImportacaoShopee(deps, PAYLOAD, 0);

    expect(enqueue).toHaveBeenCalledWith(PAYLOAD, {
      scheduleDelaySeconds: PAUSA_BURST_PADRAO_S,
    });
  });

  it('37b — a válvula fechada DURANTE a pausa carimba failed, nunca um descarte', async () => {
    const cliente = clienteFalso({
      getItemList: vi.fn(async () => {
        throw new ShopeeRateLimitError('Shopee respondeu error_busy (HTTP 200)', {
          code: 'error_busy',
          kind: SHOPEE_ERROR_KIND.burst,
          httpStatus: 200,
          path: '/api/v2/product/get_item_list',
        });
      }),
    });
    const enqueue = vi.fn(async () => {
      throw new ShopeeMassImportTasksDisabledError();
    });
    const { db, deps } = montar({ cliente, deps: { scheduler: { enqueue } } });
    semearJob(db);

    const saida = await processarImportacaoShopee(deps, PAYLOAD, 0);

    expect(saida).toBe('failed');
    expect(job(db).status).toBe('failed');
    expect(job(db).erro).toBe(MSG_VALVULA_FECHADA);
  });

  it('38 — um error_limit carimba failed e não reenfileira', async () => {
    const cliente = clienteFalso({
      getItemList: vi.fn(async () => {
        throw new ShopeeRateLimitError('Shopee respondeu error_limit (HTTP 200)', {
          code: 'error_limit',
          kind: SHOPEE_ERROR_KIND.daily,
          httpStatus: 200,
          path: '/api/v2/product/get_item_list',
        });
      }),
    });
    const { db, deps, enqueue } = montar({ cliente });
    semearJob(db);

    const saida = await processarImportacaoShopee(deps, PAYLOAD, 0);

    expect(saida).toBe('failed');
    expect(job(db).erro).toBe(MSG_LIMITE_DIARIO);
    expect(String(job(db).erro)).toContain('UTC+8');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each<[string, Error]>([
    [
      'reauth',
      new ShopeeReauthRequiredError('Shopee respondeu error_auth (HTTP 200)', {
        code: 'error_auth',
        kind: SHOPEE_ERROR_KIND.reauth,
        httpStatus: 200,
        path: '/api/v2/product/get_item_list',
      }),
    ],
    ['sem credencial', new ShopeeSemCredencialError('sem credencial armazenada')],
    ['conta errada', new ShopeeContaNotConfiguredError('não é do tipo Shopee')],
    ['sem shop id', new ShopeeContaSemShopIdError('conta principal sem loja')],
    [
      'credencial inválida',
      new ShopeeCredencialInvalidaError('credencial ilegível', ['access_token']),
    ],
    ['config', new ShopeeConfigError('SHOPEE_PARTNER_KEY ausente')],
  ])('39 — %s carimba failed na PRIMEIRA tentativa', async (_nome, erro) => {
    const { db, deps, enqueue } = montar({
      deps: {
        resolverContexto: async () => {
          throw erro;
        },
      },
    });
    semearJob(db);

    const saida = await processarImportacaoShopee(deps, PAYLOAD, 0);

    expect(saida).toBe('failed');
    expect(job(db).status).toBe('failed');
    expect(job(db).erro).toBe(erro.message);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('40 — ⛔ near-miss: um error_param que NÃO é o do offset não encerra o job — ele lança', async () => {
    const cliente = clienteFalso({
      getItemList: vi.fn(async () => {
        throw new ShopeeApiError('Shopee respondeu error_param (HTTP 200) — Item status error.', {
          code: 'error_param',
          kind: SHOPEE_ERROR_KIND.other,
          httpStatus: 200,
          path: '/api/v2/product/get_item_list',
        });
      }),
    });
    const { db, deps } = montar({ cliente });
    semearJob(db);

    await expect(processarImportacaoShopee(deps, PAYLOAD, 0)).rejects.toBeInstanceOf(
      ShopeeApiError,
    );
    expect(job(db).status).toBe('running');
    expect(job(db).erro).toBeNull();
  });

  it('40b — na tentativa FINAL o mesmo error_param carimba failed com a mensagem do erro', async () => {
    const cliente = clienteFalso({
      getItemList: vi.fn(async () => {
        throw new ShopeeApiError('Shopee respondeu error_param (HTTP 200) — Item status error.', {
          code: 'error_param',
          kind: SHOPEE_ERROR_KIND.other,
          httpStatus: 200,
          path: '/api/v2/product/get_item_list',
        });
      }),
    });
    const { db, deps } = montar({ cliente });
    semearJob(db);

    const saida = await processarImportacaoShopee(deps, PAYLOAD, MAX_TENTATIVAS - 1);

    expect(saida).toBe('failed');
    expect(String(job(db).erro)).toContain('Item status error.');
  });
});

/* ========================================================================== */
/*  Terminais (41–44)                                                         */
/* ========================================================================== */

describe('processarImportacaoShopee — terminais', () => {
  it.each([
    'Shopee /api/v2/product/get_item_list respondeu error_param (HTTP 200) — get items offset over limit, please use the next field',
    'Shopee respondeu error_param (HTTP 200) — GET ITEMS   OFFSET OVER LIMIT, please use the next field',
  ])(
    '41 — o error_param do offset carimba failed com a mitigação da janela update_time',
    async (mensagem) => {
      const cliente = clienteFalso({
        getItemList: vi.fn(async () => {
          throw new ShopeeApiError(mensagem, {
            code: 'error_param',
            kind: SHOPEE_ERROR_KIND.other,
            httpStatus: 200,
            path: '/api/v2/product/get_item_list',
          });
        }),
      });
      const { db, deps, enqueue } = montar({ cliente });
      semearJob(db, { nextOffset: 10_000 });

      const saida = await processarImportacaoShopee(deps, PAYLOAD, 0);

      expect(saida).toBe('failed');
      expect(job(db).erro).toBe(MSG_OFFSET_ACIMA_DO_LIMITE);
      expect(String(job(db).erro)).toContain('update_time');
      expect(job(db).finishedAt).toBe(AGORA_MS);
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it('42 — completed não sobrescreve um cancelled', async () => {
    const db = new FakeDb();
    semearJob(db, { status: 'cancelled', finishedAt: AGORA_MS - 5 });

    const resultadoStamp = await finalizarImportacaoShopee(asDb(db), JOB, {
      status: 'completed',
      finishedAt: AGORA_MS,
      updatedAt: AGORA_MS,
    });

    expect(resultadoStamp).toBe('not-running');
    expect(job(db).status).toBe('cancelled');
    expect(job(db).finishedAt).toBe(AGORA_MS - 5);
  });

  it('42b — cancelar de OUTRA conta responde wrong-integracao e não escreve', async () => {
    const db = new FakeDb();
    semearJob(db);

    const saida = await cancelarImportacaoShopee(asDb(db), {
      jobId: JOB,
      integracaoId: INT_B,
      now: AGORA_MS,
    });

    expect(saida).toBe('wrong-integracao');
    expect(job(db).status).toBe('running');
    expect(db.writes).toHaveLength(0);
  });

  it('42c — cancelar da própria conta carimba cancelled; um job ausente responde not-found', async () => {
    const db = new FakeDb();
    semearJob(db);

    await expect(
      cancelarImportacaoShopee(asDb(db), { jobId: JOB, integracaoId: INT_A, now: AGORA_MS }),
    ).resolves.toBe('stamped');
    expect(job(db)).toMatchObject({ status: 'cancelled', erro: null, finishedAt: AGORA_MS });

    await expect(
      cancelarImportacaoShopee(asDb(db), {
        jobId: 'inexistente',
        integracaoId: INT_A,
        now: AGORA_MS,
      }),
    ).resolves.toBe('not-found');
  });

  it('43 — um cancel durante o drain devolve noop e não reenfileira', async () => {
    const cliente = clienteFalso({
      getItemBaseInfo: vi.fn(async (p: { itemIds: number[] }) =>
        corpoBase(p.itemIds.map((id) => linhaBase(id))),
      ),
    });
    const { db, deps, enqueue } = montar({ cliente });
    semearJob(db, { fila: [1], nextOffset: 100 });

    // O operador cancela enquanto o item está sendo importado.
    const importarAnuncio = vi.fn(async () => {
      const guardado = db.store[CAMINHO_JOB];
      if (guardado) guardado.data.status = 'cancelled';
      return resultado();
    });
    const saida = await processarImportacaoShopee({ ...deps, importarAnuncio }, PAYLOAD, 0);

    expect(saida).toBe('noop');
    expect(enqueue).not.toHaveBeenCalled();
    expect(job(db).status).toBe('cancelled');
  });

  it('44 — sem scheduler com trabalho restante LANÇA — não é contenção', async () => {
    const cliente = clienteFalso({
      getItemList: vi.fn(async () => pagina({ item: [], has_next_page: true, next_offset: 100 })),
    });
    const { db, deps } = montar({ cliente, deps: { scheduler: undefined } });
    semearJob(db);

    await expect(processarImportacaoShopee(deps, PAYLOAD, 0)).rejects.toThrow(/scheduler/);
    expect(job(db).status).toBe('running');
  });
});

/* ========================================================================== */
/*  Kits (K1) e o lote desconhecido                                           */
/* ========================================================================== */

describe('processarImportacaoShopee — kits e lote desconhecido', () => {
  it('os kits vão para filaKits e são drenados por ÚLTIMO', async () => {
    const cliente = clienteFalso({
      getItemList: vi.fn(async () =>
        pagina({ item: [linha(1), linha(9, { tag: { kit: true } })] }),
      ),
      getItemBaseInfo: vi.fn(async (p: { itemIds: number[] }) =>
        corpoBase(p.itemIds.map((id) => linhaBase(id))),
      ),
    });
    const { db, deps, importarAnuncio, importarKit } = montar({ cliente });
    semearJob(db);

    await processarImportacaoShopee(deps, PAYLOAD, 0);

    expect(importarAnuncio).toHaveBeenCalledTimes(1);
    expect(importarKit).toHaveBeenCalledTimes(1);
    expect(cliente.getItemBaseInfo).toHaveBeenCalledWith({ itemIds: [1] });
    // ⚠️ O kit NUNCA passa por get_item_base_info.
    expect(cliente.getKitItemInfo).toHaveBeenCalledWith({ itemId: 9 });
    expect(job(db).kits).toBe(1);
  });

  it('um kit com product_info nulo vira kit-sem-detalhe contido', async () => {
    const cliente = clienteFalso({ getKitItemInfo: vi.fn(async () => kitInfo(null)) });
    const { db, deps, importarKit } = montar({ cliente });
    semearJob(db, { filaKits: [9] });

    const saida = await processarImportacaoShopee(deps, PAYLOAD, 0);

    expect(saida).toBe('done');
    expect(importarKit).not.toHaveBeenCalled();
    expect((job(db).failures as DocData[])[0]).toMatchObject({
      itemId: 9,
      motivo: MOTIVO_FALHA_JOB.kitSemDetalhe,
    });
    expect(job(db).kits).toBe(0);
  });

  it('o ItemLido do kit carrega o product_info e o item_id, e nenhum modelo', async () => {
    const cliente = clienteFalso({
      getKitItemInfo: vi.fn(async () => kitInfo({ item_id: 9, item_name: 'Kit' })),
    });
    const { db, deps, importarKit } = montar({ cliente });
    semearJob(db, { filaKits: [9] });

    await processarImportacaoShopee(deps, PAYLOAD, 0);

    const entrada = importarKit.mock.calls[0]?.[1] as ItemLido;
    expect(entrada.itemId).toBe(9);
    expect(entrada.base.item_id).toBe(9);
    expect(entrada.base.tag).toEqual({ kit: true });
    expect(entrada.kit).toMatchObject({ item_id: 9 });
    expect(entrada.models).toBeNull();
  });

  it('um error_item_not_found no LOTE inteiro vira item-nao-encontrado para todo id', async () => {
    const cliente = clienteFalso({
      getItemBaseInfo: vi.fn(async () => {
        throw new ShopeeApiError('Shopee respondeu error_item_not_found (HTTP 200)', {
          code: 'error_item_not_found',
          kind: SHOPEE_ERROR_KIND.other,
          httpStatus: 200,
          path: '/api/v2/product/get_item_base_info',
        });
      }),
    });
    const { db, deps, importarAnuncio } = montar({ cliente });
    semearJob(db, { fila: [1, 2, 3] });

    const saida = await processarImportacaoShopee(deps, PAYLOAD, 0);

    expect(saida).toBe('done');
    expect(importarAnuncio).not.toHaveBeenCalled();
    expect(job(db).failureCount).toBe(3);
    expect((job(db).failures as DocData[]).map((f) => f.motivo)).toEqual([
      MOTIVO_FALHA_JOB.itemNaoEncontrado,
      MOTIVO_FALHA_JOB.itemNaoEncontrado,
      MOTIVO_FALHA_JOB.itemNaoEncontrado,
    ]);
    expect(job(db).fila).toEqual([]);
  });

  it('sem importarAnuncio injetado com fila não vazia LANÇA — não é contenção', async () => {
    const { db, deps } = montar({ deps: { importarAnuncio: undefined } });
    semearJob(db, { fila: [ITEM] });

    await expect(processarImportacaoShopee(deps, PAYLOAD, 0)).rejects.toThrow(/importarAnuncio/);
    expect(job(db).failureCount).toBe(0);
  });

  it('sem importarKit injetado com filaKits não vazia LANÇA — não é contenção', async () => {
    const { db, deps } = montar({ deps: { importarKit: undefined } });
    semearJob(db, { filaKits: [9] });

    await expect(processarImportacaoShopee(deps, PAYLOAD, 0)).rejects.toThrow(/importarKit/);
    expect(job(db).failureCount).toBe(0);
  });
});

/* ========================================================================== */
/*  Invariantes do módulo                                                     */
/* ========================================================================== */

describe('importacaoMassa — invariantes', () => {
  it('Σ skipped soma os DOIS contribuintes: já vinculados e status de DELETE', async () => {
    const cliente = clienteFalso({
      getItemList: vi.fn(async () =>
        pagina({
          item: [
            linha(1),
            linha(2),
            linha(3, { item_status: SHOPEE_ITEM_STATUS.sellerDelete }),
            linha(4, { item_status: SHOPEE_ITEM_STATUS.shopeeDelete }),
          ],
        }),
      ),
      getItemBaseInfo: vi.fn(async (p: { itemIds: number[] }) =>
        corpoBase(p.itemIds.map((id) => linhaBase(id))),
      ),
    });
    const { db, deps, importarAnuncio } = montar({ cliente });
    semearJob(db);
    semearLink(db, 'prod-1', 1, REF_CONTA_A);

    await processarImportacaoShopee(deps, PAYLOAD, 0);

    // 1 já vinculado + 2 com status de DELETE = 3, e só o item 2 é importado.
    expect(job(db).scanned).toBe(4);
    expect(job(db).skipped).toBe(3);
    expect(importarAnuncio).toHaveBeenCalledTimes(1);
  });

  it('um job que não está running responde noop sem tocar na Shopee', async () => {
    const { db, cliente, deps } = montar();
    semearJob(db, { status: 'completed' });

    await expect(processarImportacaoShopee(deps, PAYLOAD, 0)).resolves.toBe('noop');
    expect(cliente.getItemList).not.toHaveBeenCalled();
  });

  it('a API de transação aparece UMA vez no fonte, fora de comentários', () => {
    // ⚠️ A palavra é MONTADA em vez de escrita: o guarda de inventário e o gate
    // do orquestrador fazem `git grep` em TEXTO CRU, e um literal aqui faria
    // este arquivo de teste aparecer na varredura do módulo.
    const palavra = ['run', 'Transaction'].join('');
    const fonte = readFileSync(new URL('./importacaoMassa.ts', import.meta.url), 'utf8');
    const semComentarios = fonte
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    expect(semComentarios.split(palavra).length - 1).toBe(1);
    expect(fonte.split(palavra).length - 1).toBe(1);
  });

  it('o nome da fila é o nome da função implantada', () => {
    expect(SHOPEE_MASS_IMPORT_QUEUE).toBe('processShopeeMassImport');
  });
});
