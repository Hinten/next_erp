/**
 * One family of the `familias` phase (`familiaDoJob.ts`): the cascade, the plan, the links and the
 * report composed — run here over a small ERP and store on the fake Firestore. What it proves:
 *
 *  - "only link" writes ONLY link documents and the job's own items: every produto, extraData,
 *    categoria and arquivo document is byte-identical before and after;
 *  - a mixed-id corpus (a link at the store id's doc id, a link at an auto id) is found by FIELD
 *    query, and the auto-id link is refreshed where it is, never duplicated;
 *  - a second run over the same store writes nothing but the mirror refreshes that changed;
 *  - Simular writes only the job's items, and its verdicts equal an `aplicar` run's;
 *  - a family outside the target writes nothing; one bad product never stops the next.
 *
 * Nothing reaches the network (D17): the GLOBAL `fetch` is stubbed to throw for the whole file.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Timestamp } from 'firebase-admin/firestore';
import {
  produtoCollection,
  produtoLojaIntegradaLinkCollection,
} from '@delfrance/data/admin/collections';
import {
  ACAO_IMPORTACAO_LI,
  ACAO_ITEM_IMPORTACAO_LI,
  ALVO_IMPORTACAO_LI,
  CATEGORIAS_IMPORTACAO_LI,
  type GrupoComLinksLi,
  type ItemImportacaoLi,
  type MarcaCatalogoLi,
  MODO_IMPORTACAO_LI,
  type ModoImportacaoLi,
  PENDENCIA_IMPORTACAO_LI,
  SITUACAO_ERP_ITEM_LI,
  fundirLinksVariacoesLi,
  varianteFakePath,
} from '@delfrance/schemas';

import { type DocData, FakeDb, asDb, grpc } from '../testing/fakeDb';
import { AGORA_MS } from '../testing/fixtures';
import { caminhoItemLi, caminhoJobLi, seedJobLi } from '../testing/importacaoLi';
import {
  detalheLi,
  filhoLi,
  linhaProdutoLi,
  paiLi,
  uriOpcaoLi,
  vistaDetalhadaLi,
  vistaLi,
} from '../testing/produtosLi';
import {
  type ContextoDasFamiliasLi,
  type DepsFamiliaLi,
  type ResultadoDaFamiliaLi,
  alvosDeFotosDaFamiliaLi,
  comDetalhesLi,
  detalhesDaFamiliaLi,
  executarFamiliaLi,
  fecharFamiliaLi,
  lerProgressoDaFamiliaLi,
  textoDoProgressoDaFamiliaLi,
} from './familiaDoJob';
import { type FamiliaLi, ORIGEM_DO_FILHO_LI } from './familias';

const CONTA = 'conta-li-familia-job';
const REF = `documents/integracao/${CONTA}`;

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('familiaDoJob.test: nenhuma chamada de rede'))),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------- the ERP ---------------------------------- */

const vinculo = (produtoId: string, docId: string) =>
  `produtos/${produtoId}/produtolojaintegrada/${docId}`;

/** Every ERP document "only link" must leave untouched (produtos, extraData, categoria, arquivo). */
const INTOCAVEIS = [
  'produtos/cam',
  'produtos/cam-a',
  'produtos/cam-b',
  'produtos/cam/extraData/singleton',
  'produtos/caneca',
  'produtos/mixed',
  'produtos/texto',
  'categorias/cat-1',
  'arquivos/arq-1',
] as const;

function seedErp(db: FakeDb): void {
  db.seed('produtos/cam', {
    nome: 'Camiseta',
    sku: 'CAM',
    paiId: null,
    filhoUnicoId: null,
    fotos: [],
  });
  db.seed('produtos/cam-a', { nome: 'Camiseta A', sku: 'CAM-A', paiId: 'cam' });
  db.seed('produtos/cam-b', { nome: 'Camiseta B', sku: 'CAM-B', paiId: 'cam' });
  db.seed('produtos/cam/extraData/singleton', { descricao: 'texto do ERP', marca: null });
  db.seed('produtos/caneca', { nome: 'Caneca', sku: 'CAN', paiId: null, filhoUnicoId: null });
  db.seed('produtos/mixed', { nome: 'Misto', sku: 'MIX', paiId: null, filhoUnicoId: null });
  db.seed('produtos/texto', { nome: 'Texto', sku: 'TXT', paiId: null, filhoUnicoId: null });
  db.seed('categorias/cat-1', { nome: 'Roupas', nomeCompleto: 'Roupas' });
  db.seed('arquivos/arq-1', { path: 'produtos/cam/a.jpg' });
  // The migrated corpus: a link of this conta at an AUTO id (found only by field query), stored
  // `removido: true` although the store lists the product again.
  db.seed(vinculo('mixed', 'aUtO1d0000000000000x'), {
    contaLojaIntegrada: REF,
    id: 30,
    sku: 'MIX',
    removido: true,
  });
  // A link of this conta whose id is TEXT: invisible to every field query.
  db.seed(vinculo('texto', '40'), { contaLojaIntegrada: REF, id: '40', sku: 'TXT' });
}

/* ------------------------------- the store -------------------------------- */

function familia(raiz: DocData, filhos: readonly DocData[] = []): FamiliaLi {
  return {
    raiz: vistaLi(raiz),
    detalheDaRaiz: null,
    filhos: filhos.map((f) => ({
      linha: vistaLi(f),
      detalhe: null,
      origem: ORIGEM_DO_FILHO_LI.filhos,
    })),
    semDetalhe: [],
    pendencias: [],
  };
}

function loja(over: { readonly canecaOculta?: boolean } = {}): FamiliaLi[] {
  return [
    familia(paiLi(10, [11, 12], { sku: 'CAM', nome: 'Camiseta' }), [
      filhoLi(11, { sku: 'CAM-A' }),
      filhoLi(12, { sku: 'CAM-B' }),
    ]),
    familia(linhaProdutoLi(20, { sku: 'CAN', ativo: over.canecaOculta !== true })),
    familia(linhaProdutoLi(30, { sku: 'MIX' })),
    familia(linhaProdutoLi(40, { sku: 'TXT' })),
    familia(linhaProdutoLi(50, { sku: 'NOVO' })),
  ];
}

function contexto(
  modo: ModoImportacaoLi,
  over: Partial<ContextoDasFamiliasLi['job']> = {},
): ContextoDasFamiliasLi {
  return {
    job: {
      integracaoId: CONTA,
      modo,
      alvo: ALVO_IMPORTACAO_LI.todos,
      acao: ACAO_IMPORTACAO_LI.soVincular,
      selecionados: [],
      categorias: CATEGORIAS_IMPORTACAO_LI.soVincular,
      mapaCategorias: [],
      marcas: [],
      ...over,
    },
    skusRepetidos: new Set(),
    grupos: [],
    recusasDoAprendizado: new Map(),
  };
}

/** A job's deps: its document is seeded NOW, so its createTime precedes every write of the run. */
function depsDoJob(db: FakeDb, jobId: string): DepsFamiliaLi {
  const criacaoDoJob = seedJobLi(db, jobId, CONTA) as unknown as Timestamp;
  return { db: asDb(db), jobId, criacaoDoJob, agoraMs: () => AGORA_MS };
}

async function rodar(
  db: FakeDb,
  jobId: string,
  ctx: ContextoDasFamiliasLi,
  familias: readonly FamiliaLi[] = loja(),
): Promise<Map<number, ItemImportacaoLi>> {
  const deps = depsDoJob(db, jobId);
  const itens = new Map<number, ItemImportacaoLi>();
  for (const f of familias) {
    const r = await executarFamiliaLi(deps, ctx, f);
    if (r.tipo === 'relatado') itens.set(r.item.liId, r.item);
  }
  return itens;
}

const ehVinculo = (caminho: string) =>
  /^produtos\/[^/]+\/produtolojaintegrada\/[^/]+$/.test(caminho);
const ehItemDoJob = (jobId: string, caminho: string) =>
  caminho.startsWith(`${caminhoJobLi(jobId)}/itens/`);

/* -------------------------------- only link -------------------------------- */

describe("only link — writes ONLY link documents and the job's items", () => {
  it('every produto, extraData, categoria and arquivo document is byte-identical', async () => {
    const db = new FakeDb();
    seedErp(db);
    const antes = INTOCAVEIS.map((p) => [p, db.ler(p), db.carimboDe(p)]);
    await rodar(db, 'job-1', contexto(MODO_IMPORTACAO_LI.aplicar));
    expect(INTOCAVEIS.map((p) => [p, db.ler(p), db.carimboDe(p)])).toEqual(antes);
    for (const e of db.escritas) {
      expect(ehVinculo(e.caminho) || ehItemDoJob('job-1', e.caminho), e.caminho).toBe(true);
    }
  });

  it('links the matched families, refuses what the scan refuses, and reports each', async () => {
    const db = new FakeDb();
    seedErp(db);
    const itens = await rodar(db, 'job-1', contexto(MODO_IMPORTACAO_LI.aplicar));

    expect(db.ler(vinculo('cam', '10'))).toMatchObject({
      contaLojaIntegrada: REF,
      id: 10,
      sku: 'CAM',
    });
    expect(db.ler(vinculo('cam-a', '11'))).toMatchObject({ id: 11, paiProdutoIntegradaId: 10 });
    expect(db.ler(vinculo('cam-b', '12'))).toMatchObject({ id: 12, paiProdutoIntegradaId: 10 });
    expect(db.ler(vinculo('caneca', '20'))).toMatchObject({
      id: 20,
      ativo: true,
      estadoPublicacao: 'p',
    });
    for (const campo of ['destaque', 'usado', 'marca', 'descricao_html']) {
      expect(db.ler(vinculo('caneca', '20')), campo).not.toHaveProperty(campo);
    }
    expect(db.ler(vinculo('texto', '40'))).toEqual({
      contaLojaIntegrada: REF,
      id: '40',
      sku: 'TXT',
    });

    expect(itens.get(10)).toMatchObject({
      acao: 'vincular',
      aplicada: true,
      erpId: 'cam',
      pendencias: [],
    });
    expect(itens.get(20)).toMatchObject({ acao: 'vincular', situacaoErp: 'encontrado' });
    expect(itens.get(40)).toMatchObject({
      acao: 'nenhuma',
      pendencias: [
        {
          codigo: PENDENCIA_IMPORTACAO_LI.vinculoIlegivel,
          acionavel: true,
          liId: null,
          referencias: ['40'],
        },
      ],
    });
    expect(itens.get(50)).toMatchObject({
      situacaoErp: SITUACAO_ERP_ITEM_LI.ausente,
      acao: 'nenhuma',
    });
    expect(db.ler(caminhoItemLi('job-1', '10'))).toEqual(itens.get(10));
  });

  it('the mixed-id corpus: the auto-id link is FOUND by field query and refreshed where it is', async () => {
    const db = new FakeDb();
    seedErp(db);
    const itens = await rodar(db, 'job-1', contexto(MODO_IMPORTACAO_LI.aplicar));
    expect(itens.get(30)).toMatchObject({
      situacaoErp: SITUACAO_ERP_ITEM_LI.vinculado,
      erpId: 'mixed',
      acao: ACAO_ITEM_IMPORTACAO_LI.nenhuma,
      pendencias: [
        {
          codigo: PENDENCIA_IMPORTACAO_LI.vinculoAtualizado,
          acionavel: false,
          liId: null,
          referencias: ['estadoPublicacao', 'nome', 'removido'],
        },
      ],
    });
    expect(db.ler(vinculo('mixed', 'aUtO1d0000000000000x'))).toMatchObject({ removido: false });
    expect(db.ler(vinculo('mixed', '30'))).toBeUndefined();
    // The link lookup is the field query on the declared collection-group index.
    expect(
      db.consultas.find((c) => c.grupo === true && c.filtros.some(([, , v]) => v === 30)),
    ).toMatchObject({
      colecao: 'produtolojaintegrada',
      filtros: [
        ['contaLojaIntegrada', 'in', [REF, `integracao/${CONTA}`]],
        ['id', '==', 30],
      ],
    });
  });

  it('a second run over the same store finds every link by field query and writes NO link', async () => {
    const db = new FakeDb();
    seedErp(db);
    await rodar(db, 'job-1', contexto(MODO_IMPORTACAO_LI.aplicar));
    const marca = db.escritas.length;
    const itens = await rodar(db, 'job-2', contexto(MODO_IMPORTACAO_LI.aplicar));
    const novas = db.escritas.slice(marca);
    expect(
      novas.every((e) => ehItemDoJob('job-2', e.caminho)),
      JSON.stringify(novas.map((e) => e.caminho)),
    ).toBe(true);
    expect(itens.get(10)).toMatchObject({
      situacaoErp: 'vinculado',
      acao: 'nenhuma',
      pendencias: [],
    });
    expect(itens.get(30)).toMatchObject({
      situacaoErp: 'vinculado',
      acao: 'nenhuma',
      pendencias: [],
    });
  });

  it('near-miss: the store hides one product ⇒ exactly ONE mirror refresh, of that field only', async () => {
    const db = new FakeDb();
    seedErp(db);
    await rodar(db, 'job-1', contexto(MODO_IMPORTACAO_LI.aplicar));
    const marca = db.escritas.length;
    const itens = await rodar(
      db,
      'job-2',
      contexto(MODO_IMPORTACAO_LI.aplicar),
      loja({ canecaOculta: true }),
    );
    const links = db.escritas.slice(marca).filter((e) => ehVinculo(e.caminho));
    expect(links.map((e) => [e.verbo, e.caminho, e.dados])).toEqual([
      ['update', vinculo('caneca', '20'), { ativo: false }],
    ]);
    expect(itens.get(20)?.pendencias).toEqual([
      {
        codigo: PENDENCIA_IMPORTACAO_LI.vinculoAtualizado,
        acionavel: false,
        liId: null,
        referencias: ['ativo'],
      },
    ]);
  });
});

/* --------------------------------- Simular --------------------------------- */

describe('Simular', () => {
  it("writes ONLY the job's items, and its verdicts equal an aplicar run's", async () => {
    const simulado = new FakeDb();
    seedErp(simulado);
    const doSimular = await rodar(simulado, 'job-s', contexto(MODO_IMPORTACAO_LI.simular));
    expect(simulado.escritas.every((e) => ehItemDoJob('job-s', e.caminho))).toBe(true);

    const aplicado = new FakeDb();
    seedErp(aplicado);
    const doAplicar = await rodar(aplicado, 'job-s', contexto(MODO_IMPORTACAO_LI.aplicar));

    const semAplicada = (m: Map<number, ItemImportacaoLi>) =>
      [...m.values()].map(({ aplicada: _aplicada, ...resto }) => resto);
    expect(semAplicada(doSimular)).toEqual(semAplicada(doAplicar));
    expect([...doSimular.values()].every((i) => !i.aplicada)).toBe(true);
  });
});

/* ------------------------------ a retried family ----------------------------- */

describe('a retried family — the links its own job created still count', () => {
  const CAMISETA = 0;
  const CANECA = 1;
  const { aplicar, simular } = MODO_IMPORTACAO_LI;

  function relatado(r: ResultadoDaFamiliaLi) {
    if (r.tipo !== 'relatado') throw new Error('familiaDoJob.test: a família não foi relatada');
    return r;
  }

  function daLoja(indice: number): FamiliaLi {
    const f = loja()[indice];
    if (f === undefined) throw new Error('familiaDoJob.test: família inexistente');
    return f;
  }

  /** One family through an UNINTERRUPTED unit, on a fresh ERP. */
  async function semFalha(modo: ModoImportacaoLi, indice: number) {
    const db = new FakeDb();
    seedErp(db);
    const r = await executarFamiliaLi(depsDoJob(db, 'job-ref'), contexto(modo), daLoja(indice));
    return { db, r: relatado(r) };
  }

  const semAplicada = ({ aplicada: _aplicada, ...resto }: ItemImportacaoLi) => resto;

  it.each([
    ['the parent and its two variations', CAMISETA, 3],
    ['a simple product', CANECA, 1],
  ])(
    '%s: the item write fails AFTER the links landed and the SAME job re-runs the unit ⇒ the first attempt’s item and counters, and Simular’s verdict',
    async (_nome, indice, criados) => {
      const db = new FakeDb();
      seedErp(db);
      const familia = daLoja(indice);
      const deps = depsDoJob(db, 'job-1');
      const ctx = contexto(aplicar);
      const item = caminhoItemLi('job-1', String(familia.raiz.id));
      db.falharEscrita(item, grpc(14, 'UNAVAILABLE'));
      await expect(executarFamiliaLi(deps, ctx, familia)).rejects.toMatchObject({ code: 14 });
      db.falharEscrita(item, null);
      const marca = db.escritas.length;
      const retentativa = relatado(await executarFamiliaLi(deps, ctx, familia));
      // The retry writes its item only: no link twice.
      expect(db.escritas.slice(marca).map((e) => e.caminho)).toEqual([item]);

      const { r: primeira } = await semFalha(aplicar, indice);
      expect(retentativa.item).toEqual(primeira.item);
      expect(retentativa.contadores).toEqual(primeira.contadores);
      expect(retentativa.item).toMatchObject({
        situacaoErp: SITUACAO_ERP_ITEM_LI.encontrado,
        acao: ACAO_ITEM_IMPORTACAO_LI.vincular,
        aplicada: true,
        pendencias: [],
      });
      expect(retentativa.contadores).toMatchObject({
        familias: 1,
        vinculados: criados,
        semMudanca: 0,
      });

      const { r: simulado } = await semFalha(simular, indice);
      expect(semAplicada(retentativa.item)).toEqual(semAplicada(simulado.item));
      expect(retentativa.contadores).toEqual(simulado.contadores);
    },
  );

  it('a lost reply on the create (ALREADY_EXISTS on our own landed link) ⇒ the same item and counters', async () => {
    const { db: referencia, r: primeira } = await semFalha(aplicar, CANECA);
    const planejado = referencia.ler(vinculo('caneca', '20'));
    if (planejado === undefined) throw new Error('familiaDoJob.test: sem o vínculo planejado');
    const db = new FakeDb();
    seedErp(db);
    const deps = depsDoJob(db, 'job-1');
    // The first commit lands; the SDK's retry of the same create meets it.
    db.antesDaProximaEscrita(vinculo('caneca', '20'), async () => {
      await produtoLojaIntegradaLinkCollection
        .docRef(asDb(db), { produtoId: 'caneca' }, '20')
        .create(planejado);
    });
    const r = relatado(await executarFamiliaLi(deps, contexto(aplicar), daLoja(CANECA)));
    expect(r.item).toEqual(primeira.item);
    expect(r.contadores).toEqual(primeira.contadores);
  });

  it('⚠️ NEAR-MISS: the same link created BEFORE this job started ⇒ vinculado, nenhuma, semMudanca 1 — a second run counts nothing', async () => {
    const { db: referencia } = await semFalha(aplicar, CANECA);
    const planejado = referencia.ler(vinculo('caneca', '20'));
    if (planejado === undefined) throw new Error('familiaDoJob.test: sem o vínculo planejado');
    const db = new FakeDb();
    seedErp(db);
    db.seed(vinculo('caneca', '20'), planejado);
    const r = relatado(
      await executarFamiliaLi(depsDoJob(db, 'job-1'), contexto(aplicar), daLoja(CANECA)),
    );
    expect(r.item).toMatchObject({
      situacaoErp: SITUACAO_ERP_ITEM_LI.vinculado,
      acao: ACAO_ITEM_IMPORTACAO_LI.nenhuma,
      pendencias: [],
    });
    expect(r.contadores).toMatchObject({ familias: 1, vinculados: 0, semMudanca: 1 });
  });

  it('⚠️ ACCEPTED RESIDUAL: a MIRROR REFRESH this job landed reads sem-mudanca on the retried unit — semMudanca +1, its informational vinculo-atualizado lost; vinculados unaffected', async () => {
    const MISTO = 2;
    const db = new FakeDb();
    seedErp(db);
    const deps = depsDoJob(db, 'job-1');
    const ctx = contexto(aplicar);
    const familia = daLoja(MISTO);
    const item = caminhoItemLi('job-1', '30');
    // The refresh of the migrated auto-id link LANDS; the item write after it fails.
    db.falharEscrita(item, grpc(14, 'UNAVAILABLE'));
    await expect(executarFamiliaLi(deps, ctx, familia)).rejects.toMatchObject({ code: 14 });
    expect(db.ler(vinculo('mixed', 'aUtO1d0000000000000x'))).toMatchObject({ removido: false });
    db.falharEscrita(item, null);
    const retentativa = relatado(await executarFamiliaLi(deps, ctx, familia));

    const { r: primeira } = await semFalha(aplicar, MISTO);
    expect(primeira.item.pendencias).toMatchObject([
      {
        codigo: PENDENCIA_IMPORTACAO_LI.vinculoAtualizado,
        acionavel: false,
        referencias: ['estadoPublicacao', 'nome', 'removido'],
      },
    ]);
    expect(primeira.contadores).toMatchObject({ semMudanca: 0, pendenciasInformativas: 1 });
    // The residual's exact shape — a known gap, not a silent one. Closing it needs a job-owned
    // record of each planned refresh written before the link writes (`vinculos.ts` header).
    expect(retentativa.item).toMatchObject({
      situacaoErp: SITUACAO_ERP_ITEM_LI.vinculado,
      acao: ACAO_ITEM_IMPORTACAO_LI.nenhuma,
      pendencias: [],
    });
    expect(retentativa.contadores).toEqual({
      ...primeira.contadores,
      semMudanca: primeira.contadores.semMudanca + 1,
      pendenciasInformativas: primeira.contadores.pendenciasInformativas - 1,
    });
    expect(retentativa.contadores.vinculados).toBe(primeira.contadores.vinculados);
  });

  it('⚠️ NEAR-MISS: ANOTHER conta’s identical link at our doc id, created during this job, never counts', async () => {
    const { db: referencia } = await semFalha(aplicar, CANECA);
    const planejado = referencia.ler(vinculo('caneca', '20'));
    if (planejado === undefined) throw new Error('familiaDoJob.test: sem o vínculo planejado');
    const db = new FakeDb();
    seedErp(db);
    const deps = depsDoJob(db, 'job-1');
    db.seed(vinculo('caneca', '20'), {
      ...planejado,
      contaLojaIntegrada: 'documents/integracao/outra-conta',
    });
    const r = relatado(await executarFamiliaLi(deps, contexto(aplicar), daLoja(CANECA)));
    expect(r.item).toMatchObject({
      situacaoErp: SITUACAO_ERP_ITEM_LI.encontrado,
      acao: ACAO_ITEM_IMPORTACAO_LI.nenhuma,
      pendencias: [{ codigo: PENDENCIA_IMPORTACAO_LI.vinculoAmbiguo }],
    });
    expect(r.contadores).toMatchObject({ vinculados: 0, semMudanca: 1 });
  });
});

/* --------------------------- target and bad data ---------------------------- */

describe('the target, and one bad product', () => {
  it('a family outside the target is not reported and writes nothing', async () => {
    const db = new FakeDb();
    seedErp(db);
    const r = await executarFamiliaLi(
      depsDoJob(db, 'job-1'),
      contexto(MODO_IMPORTACAO_LI.aplicar, { alvo: ALVO_IMPORTACAO_LI.jaNoErp }),
      familia(linhaProdutoLi(50, { sku: 'NOVO' })),
    );
    expect(r.tipo).toBe('fora-do-alvo');
    expect(db.escritas).toEqual([]);
  });

  it.each([ALVO_IMPORTACAO_LI.jaNoErp, ALVO_IMPORTACAO_LI.naoNoErp])(
    '⚠️ a family in CONFLICT under %s is reported — its item, its conflict, no link',
    async (alvo) => {
      const db = new FakeDb();
      seedErp(db);
      // A second ERP root with the store's SKU: two hits, `sku-ambiguo`.
      db.seed('produtos/caneca-2', { nome: 'Caneca 2', sku: 'CAN', paiId: null });
      const r = await executarFamiliaLi(
        depsDoJob(db, 'job-1'),
        contexto(MODO_IMPORTACAO_LI.aplicar, { alvo }),
        familia(linhaProdutoLi(20, { sku: 'CAN' })),
      );
      expect(r.tipo).toBe('relatado');
      if (r.tipo !== 'relatado') throw new Error('not reported');
      expect(r.item).toMatchObject({
        situacaoErp: 'conflito',
        acao: 'nenhuma',
        pendencias: [{ codigo: 'sku-ambiguo', acionavel: true }],
      });
      // The item only: no link anywhere.
      expect(db.escritas.map((e) => e.caminho)).toEqual([
        'importacoesLojaIntegrada/job-1/itens/20',
      ]);
    },
  );

  it('completar: a simple product with nome null ⇒ dado-invalido(nome); the NEXT family is still processed', async () => {
    const db = new FakeDb();
    seedErp(db);
    const itens = await rodar(
      db,
      'job-1',
      contexto(MODO_IMPORTACAO_LI.aplicar, { acao: ACAO_IMPORTACAO_LI.completar }),
      [
        familia(linhaProdutoLi(60, { sku: 'SEM-NOME', nome: null })),
        familia(linhaProdutoLi(20, { sku: 'CAN' })),
      ],
    );
    expect(itens.get(60)).toMatchObject({
      situacaoErp: 'ausente',
      acao: 'nenhuma',
      pendencias: [
        {
          codigo: PENDENCIA_IMPORTACAO_LI.dadoInvalido,
          acionavel: true,
          liId: null,
          referencias: ['nome'],
        },
      ],
    });
    expect(itens.get(20)).toMatchObject({ acao: 'vincular' });
  });
});

/** An item without what only says WHEN or WHETHER it was applied. */
function veredito(item: ItemImportacaoLi | undefined) {
  if (item === undefined) return undefined;
  const { aplicada: _aplicada, atualizadoEmMs: _quando, ...resto } = item;
  return resto;
}

/* -------------------------------- complete --------------------------------- */

const GRADE_C = 8946;
const GRUPO_C = 'grupo-cor-completar';
const MARCA_C = 5101;
const MARCAS_C: readonly MarcaCatalogoLi[] = [{ id: MARCA_C, nome: 'Marca Neutra', ativo: true }];
const DESCRICAO_C = '<p>Uma descrição neutra.</p>';
const sha256 = (texto: string) => createHash('sha256').update(texto, 'utf8').digest('hex');

/** This conta's link of `GRADE_C` in the memo's grupo: option 1 ⇒ blue, 2 ⇒ green, 3 ⇒ purple. */
function grupoCompletar(): GrupoComLinksLi {
  const fusao = fundirLinksVariacoesLi(null, [
    { integracaoLiId: CONTA, gradeId: GRADE_C, opcaoId: 1, varianteId: 'v-azul' },
    { integracaoLiId: CONTA, gradeId: GRADE_C, opcaoId: 2, varianteId: 'v-verde' },
    { integracaoLiId: CONTA, gradeId: GRADE_C, opcaoId: 3, varianteId: 'v-roxo' },
  ]);
  if (!fusao.ok) throw new Error('grupoCompletar: a fusão recusou a lista vazia');
  return {
    id: GRUPO_C,
    variantesIds: ['v-azul', 'v-verde', 'v-roxo'],
    linksVariacoesli: fusao.array,
  };
}

/** The ERP grupo "Cor" the memo's links point at, as stored. */
function seedGrupoCompletar(db: FakeDb): void {
  db.seed(`grupoDeVariacoes/${GRUPO_C}`, {
    nome: 'Cor',
    ordem: 1,
    variacoesIds: ['v-azul', 'v-verde', 'v-roxo'],
    variacoes: [
      { id: 'v-azul', nome: 'Azul' },
      { id: 'v-verde', nome: 'Verde' },
      { id: 'v-roxo', nome: 'Roxo' },
    ],
  });
}

function contextoCompletar(
  modo: ModoImportacaoLi,
  over: Partial<ContextoDasFamiliasLi['job']> = {},
): ContextoDasFamiliasLi {
  return {
    ...contexto(modo, { acao: ACAO_IMPORTACAO_LI.completar, marcas: [...MARCAS_C], ...over }),
    grupos: [grupoCompletar()],
  };
}

/** A store simple product WITH its detail (0.450 kg, 10×12×14, a brand, a description). */
function simplesDetalhado(liId: number, linha: DocData, detalhe: DocData = {}): FamiliaLi {
  const row = linhaProdutoLi(liId, linha);
  return {
    raiz: vistaLi(row),
    detalheDaRaiz: vistaDetalhadaLi(
      detalheLi(row, null, {
        peso: '0.450',
        altura: 10,
        largura: 12,
        profundidade: 14,
        marca: `/api/v1/marca/${String(MARCA_C)}`,
        descricao_completa: DESCRICAO_C,
        ...detalhe,
      }),
    ),
    filhos: [],
    semDetalhe: [],
    pendencias: [],
  };
}

interface VariacaoC {
  readonly id: number;
  readonly sku: string;
  readonly opcao: number;
  readonly linha?: DocData;
}

/** A store family "Camiseta" WITH every detail (the parent's box 30×40×50). */
function familiaDetalhada(
  liId: number,
  sku: string,
  variacoes: readonly VariacaoC[],
  linha: DocData = {},
): FamiliaLi {
  const row = paiLi(
    liId,
    variacoes.map((v) => v.id),
    { sku, nome: 'Camiseta', ...linha },
  );
  return {
    raiz: vistaLi(row),
    detalheDaRaiz: vistaDetalhadaLi(
      detalheLi(row, null, {
        peso: '0.900',
        altura: 30,
        largura: 40,
        profundidade: 50,
        marca: `/api/v1/marca/${String(MARCA_C)}`,
        descricao_completa: DESCRICAO_C,
      }),
    ),
    filhos: variacoes.map((v) => {
      const filho = filhoLi(v.id, {
        sku: v.sku,
        variacoes: [uriOpcaoLi(GRADE_C, v.opcao)],
        ...v.linha,
      });
      return {
        linha: vistaLi(filho),
        detalhe: vistaDetalhadaLi(detalheLi(filho, liId, { peso: '0.250' })),
        origem: ORIGEM_DO_FILHO_LI.filhos,
      };
    }),
    semDetalhe: [],
    pendencias: [],
  };
}

/** Run one family's unit under "complete" and expect it reported. */
async function relatado(
  deps: DepsFamiliaLi,
  ctx: ContextoDasFamiliasLi,
  f: FamiliaLi,
): Promise<Extract<ResultadoDaFamiliaLi, { tipo: 'relatado' }>> {
  const r = await executarFamiliaLi(deps, ctx, f);
  if (r.tipo !== 'relatado') throw new Error(`familiaDoJob.test: a família terminou ${r.tipo}`);
  return r;
}

const ehDoErp = (jobId: string, caminho: string) =>
  caminho !== caminhoJobLi(jobId) && !caminho.startsWith(`${caminhoJobLi(jobId)}/`);

describe('complete — fill-empty, then the link LAST', () => {
  it('fills only the EMPTY fields of an existing produto — `x`, `0` and a category kept — and creates its link after every fill write', async () => {
    const db = new FakeDb();
    db.seed('produtos/caneca', {
      nome: 'Caneca',
      sku: 'CAN',
      paiId: null,
      filhoUnicoId: null,
      gtin: 'GTIN-ERP',
      pesoLiquidoKg: 0,
      pesoBrutoKg: null,
      larguraCm: 5,
      categoriaProdutoOuterRef: 'documents/categorias/cat-erp',
    });
    db.seed('produtos/caneca/extraData/singleton', { descricao: 'texto do ERP', marca: '' });
    db.seed('categorias/cat-erp', { nome: 'Do ERP', nomeCompleto: 'Do ERP' });
    const deps = depsDoJob(db, 'job-c1');

    const r = await relatado(
      deps,
      contextoCompletar(MODO_IMPORTACAO_LI.aplicar),
      simplesDetalhado(20, { sku: 'CAN', gtin: '7890000000017', categorias: [] }),
    );

    expect(r.item).toMatchObject({
      situacaoErp: 'encontrado',
      erpId: 'caneca',
      acao: 'completar',
      aplicada: true,
      camposPreenchidos: ['pesoBrutoKg', 'alturaCm', 'profundidadeCm', 'extraData.marca'],
    });
    expect(db.ler('produtos/caneca')).toMatchObject({
      gtin: 'GTIN-ERP',
      pesoLiquidoKg: 0,
      pesoBrutoKg: 0.45,
      alturaCm: 10,
      larguraCm: 5,
      profundidadeCm: 14,
      categoriaProdutoOuterRef: 'documents/categorias/cat-erp',
    });
    expect(db.ler('produtos/caneca/extraData/singleton')).toEqual({
      descricao: 'texto do ERP',
      marca: 'Marca Neutra',
    });
    expect(r.contadores).toMatchObject({ completados: 1, vinculados: 1, criados: 0 });
    // A category that was there is not the import's: no tax review.
    expect(db.idsEm(`${caminhoJobLi('job-c1')}/revisao`)).toEqual([]);

    const ordem = db.escritas.map((e) => e.caminho);
    const link = ordem.indexOf(vinculo('caneca', '20'));
    expect(link).toBeGreaterThan(ordem.indexOf('produtos/caneca'));
    expect(link).toBeGreaterThan(ordem.indexOf('produtos/caneca/extraData/singleton'));
    expect(ordem.filter((c) => ehDoErp('job-c1', c))).toEqual([
      'produtos/caneca',
      'produtos/caneca/extraData/singleton',
      vinculo('caneca', '20'),
    ]);
  });

  it('an existing variation is filled on its own with the PARENT’s category and, with no box of its own, the parent’s box', async () => {
    const db = new FakeDb();
    db.seed('produtos/cam', {
      nome: 'Camiseta',
      sku: 'CAM',
      paiId: null,
      filhoUnicoId: 'cam-az',
      categoriaProdutoOuterRef: 'documents/categorias/cat-erp',
    });
    db.seed('produtos/cam-az', {
      nome: 'Camiseta Azul',
      sku: 'CAM-AZ',
      paiId: 'cam',
      variacoesUid: [varianteFakePath(GRUPO_C, 'v-azul')],
      grupoDeVariacoesUid: [GRUPO_C],
    });
    db.seed('categorias/cat-erp', { nome: 'Do ERP', nomeCompleto: 'Do ERP' });
    const f = familiaDetalhada(100, 'CAM', [{ id: 101, sku: 'CAM-AZ', opcao: 1 }]);
    const filho = f.filhos[0];
    if (filho === undefined) throw new Error('sem variação');
    const semCaixa: FamiliaLi = {
      ...f,
      filhos: [
        {
          ...filho,
          detalhe: vistaDetalhadaLi(
            detalheLi(filhoLi(101, { sku: 'CAM-AZ', variacoes: [uriOpcaoLi(GRADE_C, 1)] }), 100, {
              peso: '0.250',
              altura: null,
              largura: null,
              profundidade: null,
            }),
          ),
        },
      ],
    };
    const r = await relatado(
      depsDoJob(db, 'job-c2'),
      contextoCompletar(MODO_IMPORTACAO_LI.aplicar),
      semCaixa,
    );
    expect(db.ler('produtos/cam-az')).toMatchObject({
      categoriaProdutoOuterRef: 'documents/categorias/cat-erp',
      alturaCm: 30,
      larguraCm: 40,
      profundidadeCm: 50,
      pesoLiquidoKg: 0.25,
    });
    expect(r.item.acao).toBe('completar');
    expect(db.ler(vinculo('cam-az', '101'))).toMatchObject({ id: 101, paiProdutoIntegradaId: 100 });
  });
});

describe('complete — a family the ERP lacks', () => {
  it('is created whole, in ONE batch with its links, with the ERP builder’s shape — and joins the tax review', async () => {
    const db = new FakeDb();
    seedGrupoCompletar(db);
    const r = await relatado(
      depsDoJob(db, 'job-c3'),
      contextoCompletar(MODO_IMPORTACAO_LI.aplicar),
      familiaDetalhada(100, 'CAM', [
        { id: 101, sku: 'CAM-AZ', opcao: 1 },
        { id: 102, sku: 'CAM-VD', opcao: 2 },
      ]),
    );
    const raiz = `li-sku-${sha256('CAM')}`;
    const azul = `li-sku-${sha256('CAM-AZ')}`;
    const verde = `li-sku-${sha256('CAM-VD')}`;
    expect(r.item).toMatchObject({
      situacaoErp: 'ausente',
      erpId: raiz,
      acao: 'criar',
      aplicada: true,
      pendencias: [],
    });
    expect(r.contadores).toMatchObject({ criados: 3, vinculados: 3, completados: 0 });
    expect(db.ler(`produtos/${raiz}`)).toMatchObject({
      sku: 'CAM',
      paiId: null,
      filhoUnicoId: null,
    });
    expect(db.ler(`produtos/${azul}`)).toMatchObject({
      sku: 'CAM-AZ',
      paiId: raiz,
      grupoDeVariacoesUid: [GRUPO_C],
      variacoesUid: [varianteFakePath(GRUPO_C, 'v-azul')],
    });
    expect(db.ler(`produtos/${verde}`)).toMatchObject({ paiId: raiz });
    // ONE commit: every created document shares one batch.
    const lotes = new Set(
      db.escritas.filter((e) => ehDoErp('job-c3', e.caminho)).map((e) => e.lote),
    );
    expect(lotes.size).toBe(1);
    expect([...lotes][0]).toBeDefined();
    expect(db.ler(vinculo(raiz, '100'))).toMatchObject({ id: 100 });
    expect(db.ler(vinculo(verde, '102'))).toMatchObject({ id: 102, paiProdutoIntegradaId: 100 });
    // Every created produto joined the tax review: created, with no category.
    expect(db.idsEm(`${caminhoJobLi('job-c3')}/revisao`).sort()).toEqual(
      [azul, raiz, verde].sort(),
    );
    expect(db.ler(`${caminhoJobLi('job-c3')}/revisao/${raiz}`)).toMatchObject({
      motivos: ['produto-criado', 'sem-categoria'],
      desdeJobId: 'job-c3',
    });
  });

  it('a one-variation family names its child in `filhoUnicoId`; a simple product becomes a família de um (near-miss: two variations name none)', async () => {
    const db = new FakeDb();
    seedGrupoCompletar(db);
    const deps = depsDoJob(db, 'job-c4');
    const ctx = contextoCompletar(MODO_IMPORTACAO_LI.aplicar);
    await relatado(deps, ctx, familiaDetalhada(300, 'UMA', [{ id: 301, sku: 'UMA-AZ', opcao: 1 }]));
    expect(db.ler(`produtos/li-sku-${sha256('UMA')}`)).toMatchObject({
      filhoUnicoId: `li-sku-${sha256('UMA-AZ')}`,
    });

    const r = await relatado(deps, ctx, simplesDetalhado(50, { sku: 'NOVO', nome: 'Novo' }));
    const raiz = `li-sku-${sha256('NOVO')}`;
    const membro = `${raiz}-un`;
    expect(r.item).toMatchObject({ acao: 'criar', erpId: raiz });
    expect(r.contadores).toMatchObject({ criados: 1, vinculados: 1 });
    expect(db.ler(`produtos/${raiz}`)).toMatchObject({ sku: 'NOVO', filhoUnicoId: membro });
    expect(db.ler(`produtos/${membro}`)).toMatchObject({ sku: 'NOVO-UN', paiId: raiz });
    // The link sits on the ROOT, never on the sole member.
    expect(db.ler(vinculo(raiz, '50'))).toMatchObject({ id: 50 });
    expect(db.ler(vinculo(membro, '50'))).toBeUndefined();
  });

  it('a HIDDEN store product absent from the ERP is not created; present, it is linked', async () => {
    const db = new FakeDb();
    const deps = depsDoJob(db, 'job-c5');
    const ctx = contextoCompletar(MODO_IMPORTACAO_LI.aplicar);
    const ausente = await relatado(
      deps,
      ctx,
      simplesDetalhado(60, { sku: 'OCULTO', ativo: false }),
    );
    expect(ausente.item.acao).not.toBe('criar');
    expect(ausente.item.situacaoErp).toBe('ausente');
    expect(db.escritas.filter((e) => ehDoErp('job-c5', e.caminho))).toEqual([]);

    db.seed('produtos/oculto', { nome: 'Oculto', sku: 'OCULTO', paiId: null, filhoUnicoId: null });
    const presente = await relatado(
      deps,
      ctx,
      simplesDetalhado(60, { sku: 'OCULTO', ativo: false }),
    );
    expect(presente.item).toMatchObject({ situacaoErp: 'encontrado', erpId: 'oculto' });
    expect(db.ler(vinculo('oculto', '60'))).toMatchObject({ id: 60, ativo: false });
  });

  it('a visible store-only family with ONE hidden variation is created without it', async () => {
    const db = new FakeDb();
    seedGrupoCompletar(db);
    const r = await relatado(
      depsDoJob(db, 'job-c6'),
      contextoCompletar(MODO_IMPORTACAO_LI.aplicar),
      familiaDetalhada(400, 'MEIA', [
        { id: 401, sku: 'MEIA-AZ', opcao: 1 },
        { id: 402, sku: 'MEIA-VD', opcao: 2, linha: { ativo: false } },
      ]),
    );
    const raiz = `li-sku-${sha256('MEIA')}`;
    expect(r.item).toMatchObject({ acao: 'criar', erpId: raiz });
    expect(r.item.pendencias).toContainEqual({
      codigo: PENDENCIA_IMPORTACAO_LI.ocultoNaoCriado,
      acionavel: false,
      liId: 402,
      referencias: [],
    });
    expect(db.ler(`produtos/li-sku-${sha256('MEIA-AZ')}`)).toMatchObject({ paiId: raiz });
    expect(db.ler(`produtos/li-sku-${sha256('MEIA-VD')}`)).toBeUndefined();
    expect(db.ler(`produtos/${raiz}`)).toMatchObject({
      filhoUnicoId: `li-sku-${sha256('MEIA-AZ')}`,
    });
  });

  it('a unit RETRIED after its create landed reports the family created by THIS job — the same item and delta, never `sku-ja-existe` against itself', async () => {
    const db = new FakeDb();
    seedGrupoCompletar(db);
    const deps = depsDoJob(db, 'job-c7');
    const ctx = contextoCompletar(MODO_IMPORTACAO_LI.aplicar);
    const f = familiaDetalhada(100, 'CAM', [
      { id: 101, sku: 'CAM-AZ', opcao: 1 },
      { id: 102, sku: 'CAM-VD', opcao: 2 },
    ]);
    const primeira = await relatado(deps, ctx, f);
    const escritas = db.escritas.length;
    // The item write or the checkpoint failed after the batch landed: the unit runs again.
    const retry = await relatado(deps, ctx, f);
    expect(veredito(retry.item)).toEqual(veredito(primeira.item));
    expect(retry.contadores).toEqual(primeira.contadores);
    expect(retry.item.pendencias.map((p) => p.codigo)).not.toContain('sku-ja-existe');
    // Nothing of the ERP was written again: only the job's own item and tax review.
    expect(db.escritas.slice(escritas).filter((e) => ehDoErp('job-c7', e.caminho))).toEqual([]);
  });

  it('near-miss: ANOTHER job’s create of the same family is not this job’s — the cascade links it, never `criar`', async () => {
    const db = new FakeDb();
    seedGrupoCompletar(db);
    const ctx = contextoCompletar(MODO_IMPORTACAO_LI.aplicar);
    const f = familiaDetalhada(100, 'CAM', [{ id: 101, sku: 'CAM-AZ', opcao: 1 }]);
    await relatado(depsDoJob(db, 'job-antes'), ctx, f);
    // A later job of the same conta (its document created after the batch).
    const r = await relatado(depsDoJob(db, 'job-depois'), ctx, f);
    expect(r.item.acao).not.toBe('criar');
    expect(r.item.situacaoErp).toBe('vinculado');
    expect(r.contadores.criados).toBe(0);
  });
});

describe('complete — a variation added to an existing family, and the anchor', () => {
  it('an anchor write landing on the parent after its link never yields `conflito-de-escrita`: the add re-plans and lands', async () => {
    const db = new FakeDb();
    seedGrupoCompletar(db);
    db.seed('produtos/cam', { nome: 'Camiseta', sku: 'CAM', paiId: null, filhoUnicoId: 'cam-az' });
    db.seed('produtos/cam-az', {
      nome: 'Camiseta Azul',
      sku: 'CAM-AZ',
      paiId: 'cam',
      gtin: 'G1',
      pesoLiquidoKg: 1,
      pesoBrutoKg: 1,
      alturaCm: 1,
      larguraCm: 1,
      profundidadeCm: 1,
      variacoesUid: [varianteFakePath(GRUPO_C, 'v-azul')],
      grupoDeVariacoesUid: [GRUPO_C],
    });
    // The root's fill is its FIRST write; the anchor lands right before its NEXT one — the add's
    // batch, after the root's link (what the trigger does once a link is created).
    db.antesDaProximaEscrita('produtos/cam', () => {
      db.antesDaProximaEscrita('produtos/cam', async () => {
        await produtoCollection
          .docRef(asDb(db), {}, 'cam')
          .update({ integracoesComProduto: [REF] });
      });
    });
    const r = await relatado(
      depsDoJob(db, 'job-c8'),
      contextoCompletar(MODO_IMPORTACAO_LI.aplicar),
      familiaDetalhada(100, 'CAM', [
        { id: 101, sku: 'CAM-AZ', opcao: 1 },
        { id: 102, sku: 'CAM-VD', opcao: 2 },
      ]),
    );
    expect(r.item.pendencias.map((p) => p.codigo)).not.toContain('conflito-de-escrita');
    const verde = `li-sku-${sha256('CAM-VD')}`;
    expect(db.ler(`produtos/${verde}`)).toMatchObject({ paiId: 'cam', sku: 'CAM-VD' });
    expect(db.ler(vinculo(verde, '102'))).toMatchObject({ id: 102, paiProdutoIntegradaId: 100 });
    expect(db.ler('produtos/cam')).toMatchObject({ integracoesComProduto: [REF] });
    expect(r.item.acao).toBe('completar');
    expect(r.contadores).toMatchObject({ criados: 1 });
    const ordem = db.escritas.map((e) => e.caminho);
    expect(ordem.indexOf('produtos/cam')).toBeLessThan(ordem.indexOf(vinculo('cam', '100')));
  });
});

describe('complete — Simular decides as `aplicar` and writes only the job', () => {
  it('a category created for product 1 serves product 2, families are created and filled as planned — the same verdicts, and no ERP write', async () => {
    const mapa = [
      {
        id: 900,
        nome: 'Roupas',
        pai: { tipo: 'raiz' as const },
        erpCategoriaId: null,
        vinculo: 'sem-vinculo' as const,
      },
    ];
    const familias = () => [
      simplesDetalhado(10, { sku: 'P1', categorias: ['/api/v1/categoria/900'] }),
      simplesDetalhado(20, { sku: 'P2', categorias: ['/api/v1/categoria/900'] }),
      familiaDetalhada(100, 'CAM', [{ id: 101, sku: 'CAM-AZ', opcao: 1 }]),
      simplesDetalhado(30, { sku: 'CAN' }),
    ];
    async function rodarModo(modo: ModoImportacaoLi) {
      const db = new FakeDb();
      seedGrupoCompletar(db);
      db.seed('produtos/caneca', { nome: 'Caneca', sku: 'CAN', paiId: null, filhoUnicoId: null });
      const deps = depsDoJob(db, 'job-p');
      let ctx = contextoCompletar(modo, {
        categorias: CATEGORIAS_IMPORTACAO_LI.criarEVincular,
        mapaCategorias: mapa,
      });
      const itens = new Map<number, ItemImportacaoLi>();
      const contadores = [];
      for (const f of familias()) {
        const r = await relatado(deps, ctx, f);
        itens.set(r.item.liId, r.item);
        contadores.push(r.contadores);
        ctx = { ...ctx, job: { ...ctx.job, mapaCategorias: [...r.mapaCategorias] } };
      }
      return { db, itens, contadores, mapa: ctx.job.mapaCategorias };
    }
    const simular = await rodarModo(MODO_IMPORTACAO_LI.simular);
    const aplicar = await rodarModo(MODO_IMPORTACAO_LI.aplicar);

    expect([...simular.itens.keys()]).toEqual([...aplicar.itens.keys()]);
    for (const id of aplicar.itens.keys()) {
      expect(veredito(simular.itens.get(id)), String(id)).toEqual(veredito(aplicar.itens.get(id)));
    }
    expect(simular.contadores).toEqual(aplicar.contadores);
    // The category: created ONCE by product 1 and taken by product 2.
    const categoria = `li-${CONTA}-900`;
    expect(aplicar.db.ler(`categorias/${categoria}`)).toMatchObject({ nome: 'Roupas' });
    expect(aplicar.db.ler(`produtos/li-sku-${sha256('P2')}`)).toMatchObject({
      categoriaProdutoOuterRef: `documents/categorias/${categoria}`,
    });
    expect(simular.mapa).toEqual([
      expect.objectContaining({ id: 900, erpCategoriaId: categoria, vinculo: 'simulada' }),
    ]);
    expect(aplicar.itens.get(30)).toMatchObject({ acao: 'completar', aplicada: true });
    expect(simular.itens.get(30)).toMatchObject({ acao: 'completar', aplicada: false });
    // Simular: every write is the job's own.
    expect(simular.db.escritas.filter((e) => ehDoErp('job-p', e.caminho))).toEqual([]);
  });
});

describe('complete — photos', () => {
  it('an `aplicar` run copying photos hands the prepared family over (`fotos`), its links NOT written yet; Simular counts them in the same unit', async () => {
    const db = new FakeDb();
    db.seed('produtos/caneca', { nome: 'Caneca', sku: 'CAN', paiId: null, filhoUnicoId: null });
    const imagens = [
      { id: 71, caminho: 'loja/produto/71/a.jpg', principal: true, posicao: 1, mime: null },
      { id: 72, caminho: 'loja/produto/72/b.jpg', principal: false, posicao: 2, mime: null },
    ];
    const f = simplesDetalhado(20, { sku: 'CAN' }, { imagens });
    const ctx = { ...contextoCompletar(MODO_IMPORTACAO_LI.aplicar), importarFotos: true };
    const r = await executarFamiliaLi(depsDoJob(db, 'job-f1'), ctx, f);
    if (r.tipo !== 'fotos') throw new Error(`esperava fotos, veio ${r.tipo}`);
    expect(r.progresso).toMatchObject({
      raizLiId: 20,
      caminho: 'existente',
      erpRaizId: 'caneca',
      alvos: [{ produtoId: 'caneca', liId: null }],
      fotos: null,
      resultadoFotos: null,
    });
    expect(alvosDeFotosDaFamiliaLi(f, r.progresso).map((a) => a.imagens.map((i) => i.id))).toEqual([
      [71, 72],
    ]);
    expect(db.ler(vinculo('caneca', '20'))).toBeUndefined();
    expect(db.idsEm(`${caminhoJobLi('job-f1')}/itens`)).toEqual([]);
    // The progress rides the job as tagged text and reads back whole (near-miss: another tag).
    const texto = textoDoProgressoDaFamiliaLi(r.progresso);
    expect(texto.startsWith('f:')).toBe(true);
    expect(lerProgressoDaFamiliaLi(texto)).toEqual(r.progresso);
    expect(lerProgressoDaFamiliaLi(`r:0:${texto.slice(2)}`)).toBeNull();
    expect(lerProgressoDaFamiliaLi('f:{nao-e-json')).toBeNull();
    expect(lerProgressoDaFamiliaLi(null)).toBeNull();

    // The closing, once every picture is decided: the link LAST, the photos counted.
    const fechada = await fecharFamiliaLi(depsDoJob(db, 'job-f1'), ctx, f, r.progresso, {
      produtos: [{ produtoId: 'caneca', liId: null, desfecho: 'importadas', fotos: 2 }],
      gravadas: 2,
      pendencias: [],
    });
    expect(fechada.item).toMatchObject({ acao: 'completar', aplicada: true });
    expect(fechada.item.camposPreenchidos.at(-1)).toBe('fotos');
    expect(fechada.contadores).toMatchObject({ fotos: 2, vinculados: 1 });
    expect(db.ler(vinculo('caneca', '20'))).toMatchObject({ id: 20 });

    const dbS = new FakeDb();
    dbS.seed('produtos/caneca', { nome: 'Caneca', sku: 'CAN', paiId: null, filhoUnicoId: null });
    const simular = await relatado(
      depsDoJob(dbS, 'job-f2'),
      { ...contextoCompletar(MODO_IMPORTACAO_LI.simular), importarFotos: true },
      f,
    );
    expect(simular.contadores.fotos).toBe(2);
    expect(simular.item.camposPreenchidos.at(-1)).toBe('fotos');
    expect(dbS.escritas.filter((e) => ehDoErp('job-f2', e.caminho))).toEqual([]);
  });

  it('a progress whose closing finds the filled root no longer answered by the cascade links nothing over it and creates nothing in its place', async () => {
    const db = new FakeDb();
    db.seed('produtos/caneca', { nome: 'Caneca', sku: 'CAN', paiId: null, filhoUnicoId: null });
    const f = simplesDetalhado(
      20,
      { sku: 'CAN' },
      {
        imagens: [{ id: 71, caminho: 'loja/a.jpg', principal: true, posicao: 1, mime: null }],
      },
    );
    const ctx = { ...contextoCompletar(MODO_IMPORTACAO_LI.aplicar), importarFotos: true };
    const r = await executarFamiliaLi(depsDoJob(db, 'job-f3'), ctx, f);
    if (r.tipo !== 'fotos') throw new Error(`esperava fotos, veio ${r.tipo}`);
    await produtoCollection.docRef(asDb(db), {}, 'caneca').delete();
    const fechada = await fecharFamiliaLi(depsDoJob(db, 'job-f3'), ctx, f, r.progresso, {
      produtos: [],
      gravadas: 0,
      pendencias: [],
    });
    expect(fechada.item.acao).not.toBe('criar');
    expect(fechada.item.pendencias).toContainEqual(
      expect.objectContaining({ codigo: 'conflito-de-escrita', referencias: ['caneca'] }),
    );
    expect(db.idsEm('produtos')).toEqual([]);
  });
});

describe('detalhesDaFamiliaLi — a detail only where it can change something', () => {
  it('a family the ERP lacks needs the root and every variation the create adds; a filled existing produto needs none (near-miss: one empty field needs its own)', async () => {
    const db = new FakeDb();
    seedGrupoCompletar(db);
    const ctx = contextoCompletar(MODO_IMPORTACAO_LI.aplicar);
    const nova = familiaDetalhada(100, 'CAM', [
      { id: 101, sku: 'CAM-AZ', opcao: 1 },
      { id: 102, sku: 'CAM-VD', opcao: 2, linha: { ativo: false } },
    ]);
    expect(await detalhesDaFamiliaLi(asDb(db), ctx, nova)).toEqual([100, 101]);

    const cheio = {
      nome: 'Caneca',
      sku: 'CAN',
      paiId: null,
      filhoUnicoId: null,
      gtin: 'G',
      pesoLiquidoKg: 1,
      pesoBrutoKg: 1,
      alturaCm: 1,
      larguraCm: 1,
      profundidadeCm: 1,
      categoriaProdutoOuterRef: 'documents/categorias/c',
    };
    db.seed('produtos/caneca', cheio);
    db.seed('produtos/caneca/extraData/singleton', { descricao: 'd', marca: 'm' });
    const simples = familia(linhaProdutoLi(20, { sku: 'CAN' }));
    expect(await detalhesDaFamiliaLi(asDb(db), ctx, simples)).toEqual([]);
    // The same produto without photos, when the run copies them: its pictures are the detail's.
    expect(await detalhesDaFamiliaLi(asDb(db), { ...ctx, importarFotos: true }, simples)).toEqual([
      20,
    ]);
    db.seed('produtos/caneca', { ...cheio, pesoBrutoKg: null });
    expect(await detalhesDaFamiliaLi(asDb(db), ctx, simples)).toEqual([20]);
    // "Only link" reads no detail.
    expect(
      await detalhesDaFamiliaLi(asDb(db), contexto(MODO_IMPORTACAO_LI.aplicar), simples),
    ).toEqual([]);
  });
});

describe('comDetalhesLi', () => {
  it('attaches a held detail where the assembly had none, and keeps one it had (near-miss: a detail of another id attaches nothing)', () => {
    const f = familia(paiLi(10, [11], { sku: 'CAM' }), [filhoLi(11, { sku: 'CAM-A' })]);
    const detalhe = (liId: number, linha: DocData) => ({
      liId,
      estado: 'lido' as const,
      detalhe: vistaDetalhadaLi(detalheLi(linha, null)),
      lidoEmMs: AGORA_MS,
    });
    const comRaiz = comDetalhesLi(f, new Map([[10, detalhe(10, paiLi(10, [11], { sku: 'CAM' }))]]));
    expect(comRaiz.detalheDaRaiz?.id).toBe(10);
    expect(comRaiz.filhos[0]?.detalhe).toBeNull();
    const outro = comDetalhesLi(f, new Map([[99, detalhe(99, linhaProdutoLi(99))]]));
    expect(outro.detalheDaRaiz).toBeNull();
    expect(outro.filhos[0]?.detalhe).toBeNull();
  });
});
