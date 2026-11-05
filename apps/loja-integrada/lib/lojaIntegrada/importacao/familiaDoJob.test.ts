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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Timestamp } from 'firebase-admin/firestore';
import { produtoLojaIntegradaLinkCollection } from '@delfrance/data/admin/collections';
import {
  ACAO_IMPORTACAO_LI,
  ACAO_ITEM_IMPORTACAO_LI,
  ALVO_IMPORTACAO_LI,
  type ItemImportacaoLi,
  MODO_IMPORTACAO_LI,
  type ModoImportacaoLi,
  PENDENCIA_IMPORTACAO_LI,
  SITUACAO_ERP_ITEM_LI,
} from '@delfrance/schemas';

import { type DocData, FakeDb, asDb, grpc } from '../testing/fakeDb';
import { AGORA_MS } from '../testing/fixtures';
import { caminhoItemLi, caminhoJobLi, seedJobLi } from '../testing/importacaoLi';
import { filhoLi, linhaProdutoLi, paiLi, vistaLi } from '../testing/produtosLi';
import {
  type ContextoDasFamiliasLi,
  type DepsFamiliaLi,
  type ResultadoDaFamiliaLi,
  executarFamiliaLi,
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
