/**
 * `planejarEnvioEstoque.ts` — the write-free resolve-and-plan prefix BOTH modes
 * of the manual stock push call (review of PR #1948).
 *
 * The finding this suite exists for: the `enviar:estoque` dry run read the ids
 * AS TYPED while `--live` resolved each to its family anchor, so a variation
 * child was planned as its own (listing-less) anchor — "nothing to send" — and
 * `--live` then pushed the whole family. Three things are pinned:
 *
 *  - **§1** the helper plans a child as its ANCHOR's family — the very tasks the
 *    live send makes for the same input;
 *  - **§2** a child whose `paiId` names a missing document is
 *    `produto-nao-encontrado`, under the CHILD's id;
 *  - **§3** dry-run / live PARITY: what the dry run renders
 *    (`montarPlanoDoEnsaio`, the script's own call) equals what the live path
 *    sends and reports, for a child, a parent, a child+parent pair, a missing id
 *    and a mixed selection;
 *  - **§4** the module is write-free by its IMPORTS, read as text.
 *
 * ⚠️ The family reader below is a stub, but a FAITHFUL one: like the real
 * `documents()` pipeline it returns a row for EVERY existing id it is handed — a
 * child id included, as its own anchor with no conta denorm and no link. That
 * is what makes §1 and §2 fail on a plan that reads the ids as typed, instead of
 * passing because the stub happened not to know the child.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import type { ShopeeClient } from '@delfrance/integrations-shopee';
import { ESTADO_ANUNCIO_SHOPEE } from '@delfrance/schemas';

import { type DocData, FakeDb, asDb } from '../testing/fakeDb';
import type { BuscarFamiliasShopeePorIds } from './descobertaEstoque';
import { montarPlanoDoEnsaio, renderizarPlanoDeEnvio, resumoDoPlano } from './enviarEstoqueCli';
import { enviarEstoqueManualShopee, type DepsEnvioManual } from './enviarEstoqueManual';
import { OUTCOME_ENVIO_ESTOQUE } from './enviarEstoque';
import { MENSAGEM_POR_MOTIVO, MOTIVO_ESTOQUE_SHOPEE } from './errosEstoque';
import { planejarEnvioEstoqueShopee } from './planejarEnvioEstoque';
import type {
  FilhoDaFamilia,
  LinhaDeFamiliaShopee,
  LinkShopeeCru,
  TarefaDeEstoqueShopee,
} from './planoEstoque';

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented ids only. Never a real partner, shop, item or seller.  */
/* -------------------------------------------------------------------------- */

const INT = 'int-1';
const REF_CONTA = `documents/integracao/${INT}`;
const DEPOSITO = 'documents/deposito/dep-1';
const AGORA_MS = 1_760_000_000_000;
const ITEM_CAMISETA = 2500139861;
const ITEM_CANECA = 2500139862;
const ITEM_MOCHILA = 2500139863;
const MODEL_M = 2000458802;
const MODEL_P = 2000458803;

const ANCORA = 'prod-1';
const FILHO_M = 'prod-1-m';
const FILHO_P = 'prod-1-p';
const CANECA = 'prod-2';
const OUTRA_CONTA = 'prod-3';
const ORFAO = 'prod-4-p';
const PAI_APAGADO = 'prod-pai-apagado';
const REMOVIDO = 'prod-5';
const FANTASMA = 'prod-fantasma';

/**
 * The shared double plus the ONE Admin-SDK read it does not model —
 * `Firestore.getAll(...refs, { fieldMask })`, with a real mask — which the
 * anchor resolution (`core/anchors.ts`) makes. Extended HERE (the price suites'
 * rule), never in `testing/fakeDb.ts`.
 */
class FakeDbComLote extends FakeDb {
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
    return Promise.all(
      refs.map(async (ref) => {
        const snap = await ref.get();
        const dados = snap.data();
        return {
          id: ref.id,
          exists: snap.exists,
          data: () => {
            if (!snap.exists || dados === undefined || opcoes === null) return dados;
            const saida: DocData = {};
            for (const c of opcoes.fieldMask) if (Object.hasOwn(dados, c)) saida[c] = dados[c];
            return saida;
          },
        };
      }),
    );
  }
}

function semearCatalogo(): FakeDbComLote {
  const db = new FakeDbComLote();
  db.seed(`produtos/${ANCORA}`, { nome: 'Camiseta', paiId: null });
  db.seed(`produtos/${FILHO_M}`, { nome: 'Camiseta M', paiId: ANCORA });
  db.seed(`produtos/${FILHO_P}`, { nome: 'Camiseta P', paiId: ANCORA });
  db.seed(`produtos/${CANECA}`, { nome: 'Caneca', paiId: null });
  db.seed(`produtos/${OUTRA_CONTA}`, { nome: 'Chaveiro', paiId: null });
  db.seed(`produtos/${ORFAO}`, { nome: 'Boné P', paiId: PAI_APAGADO });
  db.seed(`produtos/${REMOVIDO}`, { nome: 'Mochila', paiId: null });
  return db;
}

function membro(produtoId: string, quantidade: number) {
  return {
    produtoId,
    ehKit: false,
    ehKitVirtual: false,
    publicado: true,
    componentesKit: null,
    timestampMs: AGORA_MS,
    estoque: { quantidade, quantidadeReservada: 0 },
    componentEstoques: [],
  };
}

function link(linkDocId: string, itemId: number, over: LinkShopeeCru = {}): LinkShopeeCru {
  return {
    contaProdutoShopeeOuterRef: REF_CONTA,
    linkDocId,
    item_id: itemId,
    item_status: 'NORMAL',
    estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    ...over,
  };
}

function filho(produtoId: string, quantidade: number, modelId: number): FilhoDaFamilia {
  return {
    ...membro(produtoId, quantidade),
    varLinks: [
      {
        contaVariacaoShopeeOuterRef: REF_CONTA,
        produtoShopeeOuterRef: `produtos/${ANCORA}/prodshopee/link-camiseta`,
        model_id: modelId,
        varLinkDocId: `var-${produtoId}`,
      },
    ],
  };
}

/** What the real by-ids pipeline returns for a child id: its OWN row, listing-less. */
function linhaPropria(produtoId: string): LinhaDeFamiliaShopee {
  return {
    anchorId: produtoId,
    anchor: membro(produtoId, 3),
    integracoesComProduto: [],
    links: [],
    children: [],
  };
}

/** The row the by-ids reader returns PER DOCUMENT ID it is handed. */
const LINHAS: Readonly<Record<string, LinhaDeFamiliaShopee>> = {
  [ANCORA]: {
    anchorId: ANCORA,
    anchor: membro(ANCORA, 0),
    integracoesComProduto: [INT],
    links: [link('link-camiseta', ITEM_CAMISETA)],
    // Sorted by id, as the real mapper sorts them.
    children: [filho(FILHO_M, 4, MODEL_M), filho(FILHO_P, 3, MODEL_P)],
  },
  [FILHO_M]: linhaPropria(FILHO_M),
  [FILHO_P]: linhaPropria(FILHO_P),
  [ORFAO]: linhaPropria(ORFAO),
  [CANECA]: {
    anchorId: CANECA,
    anchor: membro(CANECA, 9),
    integracoesComProduto: [INT],
    links: [link('link-caneca', ITEM_CANECA)],
    children: [],
  },
  [OUTRA_CONTA]: {
    anchorId: OUTRA_CONTA,
    anchor: membro(OUTRA_CONTA, 2),
    integracoesComProduto: ['int-outra'],
    links: [
      link('link-chaveiro', ITEM_CANECA, {
        contaProdutoShopeeOuterRef: 'documents/integracao/int-outra',
      }),
    ],
    children: [],
  },
  [REMOVIDO]: {
    anchorId: REMOVIDO,
    anchor: membro(REMOVIDO, 5),
    integracoesComProduto: [INT],
    links: [link('link-mochila', ITEM_MOCHILA, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido })],
    children: [],
  },
};

/** The faithful stub, recording every id list it is handed. */
function leitor(): { buscarFamilias: BuscarFamiliasShopeePorIds; lidos: string[][] } {
  const lidos: string[][] = [];
  const buscarFamilias: BuscarFamiliasShopeePorIds = (_db, args) => {
    lidos.push([...args.produtoIds]);
    return Promise.resolve(args.produtoIds.flatMap((id) => LINHAS[id] ?? []));
  };
  return { buscarFamilias, lidos };
}

async function planejar(db: FakeDb, produtoIds: readonly string[]) {
  const { buscarFamilias, lidos } = leitor();
  const planejado = await planejarEnvioEstoqueShopee(
    asDb(db),
    { integracaoId: INT, depositoId: 'dep-1', produtoIds, reenviarComErro: false },
    { nowMs: AGORA_MS, buscarFamilias },
  );
  return { planejado, lidos };
}

/** The live path, with a send handler that records each task and answers a clean send. */
async function enviarAoVivo(db: FakeDb, produtoIds: readonly string[]) {
  const { buscarFamilias } = leitor();
  const enviadas: TarefaDeEstoqueShopee[] = [];
  const deps: DepsEnvioManual = {
    nowMs: AGORA_MS,
    agora: () => AGORA_MS,
    esperar: () => Promise.resolve(),
    conta: { depositoOuterRef: DEPOSITO, nome: 'Loja teste' },
    contaNome: 'Loja teste',
    client: {} as unknown as ShopeeClient,
    increment: (by: number) => ({ __increment: by }),
    buscarFamilias,
    enviarTarefa: (_db, raw) => {
      const tarefa = raw as TarefaDeEstoqueShopee;
      enviadas.push(tarefa);
      return Promise.resolve({
        outcome: OUTCOME_ENVIO_ESTOQUE.enviado,
        motivo: null,
        codigo: null,
        modelos: [],
        quantidadeEnviada: tarefa.modelos.reduce((soma, m) => soma + m.quantidade, 0),
        chamadasShopee: 1,
        pausadoAte: null,
      });
    },
  };
  const resposta = await enviarEstoqueManualShopee(
    asDb(db),
    { integracaoId: INT, produtoIds, reenviarComErro: false },
    deps,
  );
  return { resposta, enviadas };
}

const porVinculo = (a: TarefaDeEstoqueShopee, b: TarefaDeEstoqueShopee): number =>
  a.linkDocId.localeCompare(b.linkDocId) || a.parte - b.parte;

const SEM_PISO: ReadonlyMap<number, ReadonlyMap<number, number>> = new Map();

/* ========================================================================== */
/*  1 · um filho é planejado como a família da âncora                         */
/* ========================================================================== */

describe('planejarEnvioEstoqueShopee — um FILHO pedido planeja a família da ÂNCORA', () => {
  it('⚠️ [filho] ⇒ a família é lida pela ÂNCORA e planeja os modelos da família inteira', async () => {
    const { planejado, lidos } = await planejar(semearCatalogo(), [FILHO_P]);

    // Over the anchor, never the id as typed.
    expect(lidos).toEqual([[ANCORA]]);
    expect(planejado.familias).toHaveLength(1);
    const [familia] = planejado.familias;
    expect(familia).toMatchObject({
      anchorId: ANCORA,
      anchorNome: 'Camiseta',
      pedidos: [FILHO_P],
      semListagem: null,
    });
    expect(familia?.plano?.tarefas.map((t) => [t.produtoId, t.linkDocId, t.itemId])).toEqual([
      [ANCORA, 'link-camiseta', ITEM_CAMISETA],
    ]);
    // The WHOLE family's models — the sibling M rides the call a child P asked for.
    expect(familia?.plano?.tarefas[0]?.modelos.map((m) => [m.modelId, m.produtoId])).toEqual([
      [MODEL_M, FILHO_M],
      [MODEL_P, FILHO_P],
    ]);
    expect(planejado.produtosSemEnvio).toEqual([]);
    expect(planejado.familiasLidas).toBe(1);
  });

  it('PAR: as tarefas do plano são EXATAMENTE as que o envio ao vivo entrega ao remetente', async () => {
    const { planejado } = await planejar(semearCatalogo(), [FILHO_P]);
    const { enviadas } = await enviarAoVivo(semearCatalogo(), [FILHO_P]);

    const planejadas = planejado.familias.flatMap((f) => f.plano?.tarefas ?? []);
    expect(planejadas).toHaveLength(1);
    expect([...enviadas].sort(porVinculo)).toEqual([...planejadas].sort(porVinculo));
  });

  it('[filho, âncora] ⇒ UMA família com os dois pedidos, e a dedução vem DEPOIS da resolução', async () => {
    const { planejado, lidos } = await planejar(semearCatalogo(), [FILHO_P, ANCORA, FILHO_P]);

    expect(planejado.solicitados).toEqual([FILHO_P, ANCORA]);
    expect(lidos).toEqual([[ANCORA]]);
    expect(planejado.familias.map((f) => [f.anchorId, f.pedidos])).toEqual([
      [ANCORA, [FILHO_P, ANCORA]],
    ]);
  });
});

/* ========================================================================== */
/*  2 · o paiId que nomeia um documento ausente                               */
/* ========================================================================== */

describe('planejarEnvioEstoqueShopee — nada some sem uma linha', () => {
  it('⚠️ um filho cujo paiId nomeia um documento AUSENTE ⇒ produto-nao-encontrado para o FILHO', async () => {
    const { planejado, lidos } = await planejar(semearCatalogo(), [ORFAO]);

    expect(lidos).toEqual([[PAI_APAGADO]]);
    expect(planejado.familias).toEqual([
      {
        anchorId: PAI_APAGADO,
        anchorNome: null,
        pedidos: [ORFAO],
        row: null,
        plano: null,
        semListagem: {
          motivo: MOTIVO_ESTOQUE_SHOPEE.produtoNaoEncontrado,
          mensagem: MENSAGEM_POR_MOTIVO[MOTIVO_ESTOQUE_SHOPEE.produtoNaoEncontrado],
        },
      },
    ]);
    expect(planejado.produtosSemEnvio).toEqual([
      {
        produtoId: ORFAO,
        produtoNome: 'Boné P',
        motivo: MOTIVO_ESTOQUE_SHOPEE.produtoNaoEncontrado,
        mensagem: MENSAGEM_POR_MOTIVO[MOTIVO_ESTOQUE_SHOPEE.produtoNaoEncontrado],
      },
    ]);
    expect(planejado.familiasLidas).toBe(0);
  });

  it('QUASE-PAR: um id SEM documento também é produto-nao-encontrado, e não lê família nenhuma', async () => {
    const { planejado, lidos } = await planejar(semearCatalogo(), [FANTASMA]);

    expect(lidos).toEqual([]);
    expect(planejado.familias).toEqual([]);
    expect(planejado.naoEncontrados).toEqual([FANTASMA]);
    expect(planejado.produtosSemEnvio.map((s) => [s.produtoId, s.motivo])).toEqual([
      [FANTASMA, MOTIVO_ESTOQUE_SHOPEE.produtoNaoEncontrado],
    ]);
  });

  it('o veredito "sem anúncio" do planejador vale para CADA pedido da família, na ordem do pedido', async () => {
    const { planejado } = await planejar(semearCatalogo(), [OUTRA_CONTA, FANTASMA, ORFAO]);

    expect(planejado.produtosSemEnvio.map((s) => [s.produtoId, s.motivo])).toEqual([
      [OUTRA_CONTA, MOTIVO_ESTOQUE_SHOPEE.contaForaDoProduto],
      [FANTASMA, MOTIVO_ESTOQUE_SHOPEE.produtoNaoEncontrado],
      [ORFAO, MOTIVO_ESTOQUE_SHOPEE.produtoNaoEncontrado],
    ]);
  });
});

/* ========================================================================== */
/*  3 · paridade: o que o dry-run imprime é o que o --live envia              */
/* ========================================================================== */

describe('dry-run × --live — o plano impresso é o envio', () => {
  it.each([
    ['um filho', [FILHO_P]],
    ['a âncora', [ANCORA]],
    ['filho + âncora', [FILHO_P, ANCORA]],
    ['um id ausente', [FANTASMA]],
    [
      'uma seleção mista',
      [FILHO_M, CANECA, OUTRA_CONTA, ORFAO, REMOVIDO, FANTASMA, FILHO_P, ANCORA],
    ],
  ])('%s: listagens, linhas sem envio e contadores coincidem', async (_nome, produtoIds) => {
    const { planejado } = await planejar(semearCatalogo(), produtoIds);
    const plano = montarPlanoDoEnsaio(planejado, { integracaoId: INT, pisoPorItem: SEM_PISO });
    const { resposta, enviadas } = await enviarAoVivo(semearCatalogo(), produtoIds);

    // What is SENT: the same calls, models and quantities, under the same anchor.
    const chave = (produtoId: string, anuncioId: string, linkDocId: string, parte: number) =>
      `${produtoId}|${anuncioId}|${linkDocId}|${String(parte)}`;
    expect(
      plano.listagens
        .map((l) => ({
          chave: chave(l.produtoId, l.anuncioId, l.linkDocId, l.parte),
          modelos: l.modelos.map((m) => [m.modelId, m.produtoId, m.quantidade]),
        }))
        .sort((a, b) => a.chave.localeCompare(b.chave)),
    ).toEqual(
      enviadas
        .map((t) => ({
          chave: chave(t.produtoId, String(t.itemId), t.linkDocId, t.parte),
          modelos: t.modelos.map((m) => [m.modelId, m.produtoId, m.quantidade]),
        }))
        .sort((a, b) => a.chave.localeCompare(b.chave)),
    );
    // …under the same NAME, in the same order as the envelope's sent rows.
    expect(plano.listagens.map((l) => [l.produtoId, l.produtoNome])).toEqual(
      resposta.listings
        .filter((l) => l.outcome === 'enviado')
        .map((l) => [l.produtoId, l.produtoNome]),
    );

    // What is NOT sent: the dry run's skip lines are the envelope's skipped
    // listing rows plus its `produtosSemEnvio`, id for id and motivo for motivo.
    const ordenar = (linhas: string[][]) =>
      [...linhas].sort((a, b) => a.join().localeCompare(b.join()));
    expect(ordenar(plano.pulos.map((p) => [p.produtoId, p.motivo]))).toEqual(
      ordenar([
        ...resposta.listings
          .filter((l) => l.outcome === 'pulado')
          .map((l) => [l.produtoId, l.motivo ?? '']),
        ...resposta.produtosSemEnvio.map((s) => [s.produtoId, s.motivo]),
      ]),
    );
    expect(plano.solicitados).toBe(resposta.solicitados);
    expect(plano.familias).toBe(resposta.familias);
  });

  it('⚠️ não-vácuo: um FILHO sozinho rende UM anúncio no dry-run — nunca "nada seria enviado"', async () => {
    const { planejado } = await planejar(semearCatalogo(), [FILHO_P]);
    const plano = montarPlanoDoEnsaio(planejado, { integracaoId: INT, pisoPorItem: SEM_PISO });
    const texto = renderizarPlanoDeEnvio(plano).join('\n');

    expect(plano.listagens).toHaveLength(1);
    expect(plano.pulos).toEqual([]);
    expect(texto).not.toContain('nada seria enviado');
    // …and it SAYS which anchor the child resolved to.
    expect(texto).toContain(`### anúncio 1/1 — ${ANCORA}`);
    expect(texto).toMatch(new RegExp(`via variação \\.+ ${FILHO_P}$`, 'm'));
    expect(resumoDoPlano(plano)).toMatchObject({
      listagens: [{ produtoId: ANCORA, variacoesPedidas: [FILHO_P] }],
    });
  });

  it('PAR/QUASE: só um pedido que NÃO é a âncora ganha "via variação" / "âncora="', async () => {
    const { planejado } = await planejar(semearCatalogo(), [ANCORA, CANECA, ORFAO, FANTASMA]);
    const plano = montarPlanoDoEnsaio(planejado, { integracaoId: INT, pisoPorItem: SEM_PISO });
    const linhas = renderizarPlanoDeEnvio(plano);

    expect(plano.listagens.map((l) => [l.produtoId, l.variacoesPedidas])).toEqual([
      [ANCORA, []],
      [CANECA, []],
    ]);
    expect(linhas.some((l) => l.includes('via variação'))).toBe(false);
    expect(plano.pulos.map((p) => [p.produtoId, p.ancoraId])).toEqual([
      [ORFAO, PAI_APAGADO],
      [FANTASMA, null],
    ]);
    const doOrfao = linhas.find((l) => l.trimStart().startsWith(ORFAO));
    const doFantasma = linhas.find((l) => l.trimStart().startsWith(FANTASMA));
    expect(doOrfao).toContain(`âncora=${PAI_APAGADO}`);
    expect(doFantasma).not.toContain('âncora=');
  });
});

/* ========================================================================== */
/*  4 · sem escrita, pela própria lista de imports                            */
/* ========================================================================== */

describe('planejarEnvioEstoque.ts — sem escrita por construção', () => {
  const importsDe = (arquivo: string): string[] =>
    [
      ...readFileSync(new URL(arquivo, import.meta.url), 'utf8').matchAll(
        /^import[^;]*?from '([^']+)';/gms,
      ),
    ].map((m) => m[1] ?? '');

  it('⛔ importa EXATAMENTE os leitores e o planejador — nenhum remetente, agendador, gravador ou cliente', () => {
    expect(importsDe('./planejarEnvioEstoque.ts').sort()).toEqual(
      [
        '../core/anchors',
        './descobertaEstoque',
        './errosEstoque',
        './planoEstoque',
        './quantidadeEstoque',
        'firebase-admin/firestore',
      ].sort(),
    );
  });

  it('não-vácuo: o mesmo leitor de imports ACHA o remetente no módulo do envio ao vivo', () => {
    expect(importsDe('./enviarEstoqueManual.ts')).toEqual(
      expect.arrayContaining(['./enviarEstoque', './planejarEnvioEstoque']),
    );
  });

  it('não lê relógio: nenhum Date.now nem new Date no módulo', () => {
    const fonte = readFileSync(new URL('./planejarEnvioEstoque.ts', import.meta.url), 'utf8');
    expect(fonte).not.toMatch(/Date\.now\(|new Date\(/);
  });
});
