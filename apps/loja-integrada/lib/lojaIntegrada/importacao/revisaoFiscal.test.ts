/**
 * The product import's tax-review list (`revisaoFiscal.ts`) on the fake Firestore: the add (tier 0,
 * merged on `ALREADY_EXISTS`), the carry-forward over the conta's earlier `aplicar` jobs, and the
 * re-check that lets an entry leave on EVIDENCE only — its own tax setting, its category's, a tax
 * rule naming it or its category, or the produto gone.
 *
 * Every decision is pinned as a PAIR (the equal case and the near-miss), and every query the phase
 * sends is checked against `firestore.indexes.json` (root rule 1). Nothing reaches the network
 * (D17): the GLOBAL `fetch` is stubbed to throw for the whole file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ETAPA_REVISAO_FISCAL_LI,
  MODO_IMPORTACAO_LI,
  MOTIVO_REVISAO_FISCAL_LI,
  type RevisaoFiscalLi,
  STATUS_IMPORTACAO_LI,
  importacaoLojaIntegradaSchema,
  revisaoFiscalLiSchema,
} from '@delfrance/schemas';

import { type DocData, FakeDb, asDb, increment } from '../testing/fakeDb';
import { AGORA_MS, caminhoAviso } from '../testing/fixtures';
import { caminhoJobLi, seedJobLi } from '../testing/importacaoLi';
import { chaveRevisaoFiscalLi } from '../avisos/avisos';
import {
  RESULTADO_AVISO_IMPORTACAO_LI,
  sincronizarAvisoDeRevisaoFiscalLi,
} from './avisosImportacao';
import { UNIDADE_IMPORTACAO_LI } from './orcamento';
import {
  DESFECHO_REVISAO_FISCAL_LI,
  type DepsRevisaoFiscalLi,
  type EstadoRevisaoFiscalLi,
  EVIDENCIA_FISCAL_LI,
  PAGINA_CONFERENCIA_REVISAO_LI,
  PAGINA_TRANSPORTE_REVISAO_LI,
  PASSO_REVISAO_FISCAL_LI,
  type PassoRevisaoFiscalLi,
  adicionarARevisaoFiscalLi,
  criarLeitorDeListasRevisaoLi,
  criarLeitorDeRegrasImpostoLi,
  evidenciaFiscalDoProdutoLi,
  executarUnidadeDaRevisaoFiscalLi,
  fundirEntradasRevisaoFiscalLi,
  mesmaEntradaRevisaoFiscalLi,
  unidadeDaRevisaoFiscalLi,
} from './revisaoFiscal';

const CONTA = 'conta-li-revisao';
const OUTRA = 'conta-li-revisao-2';
const JOB = 'job-revisao-atual';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('revisaoFiscal.test: nenhuma chamada de rede'))),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------- fixtures --------------------------------- */

const caminhoEntrada = (jobId: string, produtoId: string) =>
  `${caminhoJobLi(jobId)}/revisao/${produtoId}`;

function entrada(
  produtoId: string,
  over: Partial<Record<keyof RevisaoFiscalLi, unknown>> = {},
): RevisaoFiscalLi {
  return revisaoFiscalLiSchema.parse({
    produtoId,
    motivos: [MOTIVO_REVISAO_FISCAL_LI.produtoCriado],
    liId: null,
    desdeJobId: null,
    desdeMs: null,
    ...over,
  });
}

function seedEntrada(
  db: FakeDb,
  jobId: string,
  produtoId: string,
  over: Partial<Record<keyof RevisaoFiscalLi, unknown>> = {},
): void {
  db.seed(caminhoEntrada(jobId, produtoId), entrada(produtoId, over) as unknown as DocData);
}

/** A job of the conta, `iniciadoEmMs` minutes after AGORA (newer = larger). */
function seedJob(
  db: FakeDb,
  jobId: string,
  minuto: number,
  over: { modo?: string; status?: string; conta?: string } = {},
): void {
  seedJobLi(db, jobId, over.conta ?? CONTA, {
    iniciadoEmMs: AGORA_MS + minuto * 60_000,
    modo: over.modo ?? MODO_IMPORTACAO_LI.aplicar,
    status: over.status ?? STATUS_IMPORTACAO_LI.concluido,
  });
}

/** THIS job: the newest, running its `revisao` phase. */
function seedEsteJob(db: FakeDb): void {
  seedJob(db, JOB, 1_000, { status: STATUS_IMPORTACAO_LI.executando });
}

function seedProduto(db: FakeDb, id: string, categoria: string | null = null, extra: DocData = {}) {
  db.seed(`produtos/${id}`, {
    nome: id,
    sku: id,
    categoriaProdutoOuterRef: categoria === null ? null : `documents/categorias/${categoria}`,
    ...extra,
  });
}

function seedRegra(db: FakeDb, operacao: string, id: string, regra: DocData): void {
  db.seed(`operacao/${operacao}/regras/${id}`, {
    produtos: [],
    categorias: [],
    ncms: [],
    ...regra,
  });
}

function deps(db: FakeDb, over: Partial<DepsRevisaoFiscalLi> = {}): DepsRevisaoFiscalLi {
  return {
    db: asDb(db),
    contaId: CONTA,
    jobId: JOB,
    regras: criarLeitorDeRegrasImpostoLi(asDb(db)),
    listas: criarLeitorDeListasRevisaoLi(asDb(db)),
    ...over,
  };
}

const INICIAL: EstadoRevisaoFiscalLi = importacaoLojaIntegradaSchema.parse({
  integracaoId: CONTA,
  status: 'executando',
  iniciadoEmMs: AGORA_MS,
}).revisao;

/** Run the phase unit by unit until it concludes (as the dispatch would, checkpointing each). */
async function rodarFase(
  d: DepsRevisaoFiscalLi,
  estado: EstadoRevisaoFiscalLi = INICIAL,
): Promise<{ passos: PassoRevisaoFiscalLi[]; abertos: number; estado: EstadoRevisaoFiscalLi }> {
  const passos: PassoRevisaoFiscalLi[] = [];
  let atual = estado;
  for (let i = 0; i < 1_000; i += 1) {
    const passo = await executarUnidadeDaRevisaoFiscalLi(d, atual);
    passos.push(passo);
    atual = passo.estado;
    if (passo.tipo === PASSO_REVISAO_FISCAL_LI.concluido) {
      return { passos, abertos: passo.abertos, estado: atual };
    }
  }
  throw new Error('rodarFase: a fase não terminou');
}

const listaDe = (db: FakeDb, jobId = JOB) => db.idsEm(`${caminhoJobLi(jobId)}/revisao`).sort();

/* --------------------------------- an entry -------------------------------- */

describe('adicionarARevisaoFiscalLi — tier 0 at the produto id, merged on ALREADY_EXISTS', () => {
  it('a new produto ⇒ created whole at its id', async () => {
    const db = new FakeDb();
    const e = entrada('p1', { liId: 182904918, desdeJobId: JOB, desdeMs: AGORA_MS });
    expect(await adicionarARevisaoFiscalLi(asDb(db), JOB, e)).toBe(
      DESFECHO_REVISAO_FISCAL_LI.criada,
    );
    expect(db.ler(caminhoEntrada(JOB, 'p1'))).toEqual(e);
  });

  it('PAIR: the same entry again (a retried unit) ⇒ sem-mudanca, ZERO writes ⟷ NEAR-MISS one more motivo ⇒ merged, both kept', async () => {
    const db = new FakeDb();
    const e = entrada('p1', { desdeJobId: JOB, desdeMs: AGORA_MS });
    await adicionarARevisaoFiscalLi(asDb(db), JOB, e);
    const escritas = db.escritas.length;
    expect(await adicionarARevisaoFiscalLi(asDb(db), JOB, e)).toBe(
      DESFECHO_REVISAO_FISCAL_LI.semMudanca,
    );
    expect(db.escritas).toHaveLength(escritas);

    expect(
      await adicionarARevisaoFiscalLi(asDb(db), JOB, {
        ...e,
        motivos: [MOTIVO_REVISAO_FISCAL_LI.categoriaCriada],
      }),
    ).toBe(DESFECHO_REVISAO_FISCAL_LI.fundida);
    expect(db.ler(caminhoEntrada(JOB, 'p1'))?.motivos).toEqual([
      MOTIVO_REVISAO_FISCAL_LI.produtoCriado,
      MOTIVO_REVISAO_FISCAL_LI.categoriaCriada,
    ]);
  });

  it('a produto id that is not a document id throws (a coding bug, never data)', async () => {
    const db = new FakeDb();
    await expect(adicionarARevisaoFiscalLi(asDb(db), JOB, entrada('a/b'))).rejects.toThrow(
      RangeError,
    );
  });
});

describe('fundirEntradasRevisaoFiscalLi / mesmaEntradaRevisaoFiscalLi — pure', () => {
  const velha = entrada('p', {
    motivos: [MOTIVO_REVISAO_FISCAL_LI.semCategoria],
    desdeJobId: 'job-velho',
    desdeMs: 100,
  });
  const nova = entrada('p', {
    motivos: [MOTIVO_REVISAO_FISCAL_LI.produtoCriado],
    liId: 7,
    desdeJobId: 'job-novo',
    desdeMs: 200,
  });

  it('every motivo of both, in the schema’s order; the stored store id unless it has none; the EARLIEST since', () => {
    const fundida = fundirEntradasRevisaoFiscalLi(velha, nova);
    expect(fundida).toEqual({
      produtoId: 'p',
      motivos: [MOTIVO_REVISAO_FISCAL_LI.produtoCriado, MOTIVO_REVISAO_FISCAL_LI.semCategoria],
      liId: 7,
      desdeJobId: 'job-velho',
      desdeMs: 100,
    });
    // Either way round: the earlier since wins.
    expect(fundirEntradasRevisaoFiscalLi(nova, velha)).toMatchObject({
      desdeJobId: 'job-velho',
      desdeMs: 100,
    });
  });

  it('a since WITH a stamp is earlier than one without; two without keep the stored one', () => {
    const semCarimbo = entrada('p', { desdeJobId: 'job-sem', desdeMs: null });
    expect(fundirEntradasRevisaoFiscalLi(semCarimbo, nova)).toMatchObject({
      desdeJobId: 'job-novo',
      desdeMs: 200,
    });
    expect(
      fundirEntradasRevisaoFiscalLi(semCarimbo, entrada('p', { desdeJobId: 'outro' })),
    ).toMatchObject({ desdeJobId: 'job-sem' });
  });

  it('PAIR: identical entries are the same ⟷ NEAR-MISS any one field differing is not', () => {
    expect(mesmaEntradaRevisaoFiscalLi(velha, { ...velha })).toBe(true);
    expect(mesmaEntradaRevisaoFiscalLi(velha, { ...velha, motivos: [...velha.motivos] })).toBe(
      true,
    );
    for (const outra of [
      { ...velha, motivos: [...velha.motivos, MOTIVO_REVISAO_FISCAL_LI.produtoCriado] },
      { ...velha, liId: 1 },
      { ...velha, desdeJobId: 'job-x' },
      { ...velha, desdeMs: 101 },
      { ...velha, produtoId: 'q' },
    ]) {
      expect(mesmaEntradaRevisaoFiscalLi(velha, outra)).toBe(false);
    }
  });
});

/* ----------------------------- the carry-forward --------------------------- */

describe('the carry-forward — the conta’s earlier aplicar jobs', () => {
  it('every unit costs no Loja Integrada call', () => {
    expect(unidadeDaRevisaoFiscalLi()).toBe(UNIDADE_IMPORTACAO_LI.familia);
  });

  it('the previous CONCLUDED aplicar job’s list is carried; Simular jobs, other contas and this job are skipped; the walk stops at it', async () => {
    const db = new FakeDb();
    seedEsteJob(db);
    seedJob(db, 'job-simular', 500, { modo: MODO_IMPORTACAO_LI.simular });
    seedEntrada(db, 'job-simular', 'p-simulado');
    seedJob(db, 'job-de-outra-conta', 600, { conta: OUTRA });
    seedEntrada(db, 'job-de-outra-conta', 'p-outra');
    seedJob(db, 'job-anterior', 400);
    seedEntrada(db, 'job-anterior', 'p1', { desdeJobId: 'job-antigo', desdeMs: AGORA_MS });
    seedJob(db, 'job-antigo', 100);
    // Closed by job-anterior's re-check: it must stay closed.
    seedEntrada(db, 'job-antigo', 'p-fechado');
    seedProduto(db, 'p1');
    seedEntrada(db, JOB, 'p-proprio', { desdeJobId: JOB });
    seedProduto(db, 'p-proprio');

    const r = await rodarFase(deps(db));
    expect(listaDe(db)).toEqual(['p-proprio', 'p1']);
    expect(r.abertos).toBe(2);
    expect(r.estado.anteriorJobId).toBe('job-anterior');
    // The carried entry keeps the job that FIRST listed it.
    expect(db.ler(caminhoEntrada(JOB, 'p1'))).toMatchObject({
      desdeJobId: 'job-antigo',
      desdeMs: AGORA_MS,
    });
  });

  it('decided 2026-11-06, NEAR-MISS: a newer aplicar job that FAILED before its re-check is carried TOO — the walk goes past it to the concluded one', async () => {
    const db = new FakeDb();
    seedEsteJob(db);
    seedJob(db, 'job-falhou', 500, { status: STATUS_IMPORTACAO_LI.falhou });
    seedEntrada(db, 'job-falhou', 'p-novo', { desdeJobId: 'job-falhou' });
    seedJob(db, 'job-cancelado', 450, { status: STATUS_IMPORTACAO_LI.cancelado });
    seedJob(db, 'job-concluido', 400);
    seedEntrada(db, 'job-concluido', 'p-velho', { desdeJobId: 'job-concluido' });
    seedProduto(db, 'p-novo');
    seedProduto(db, 'p-velho');

    const r = await rodarFase(deps(db));
    expect(listaDe(db)).toEqual(['p-novo', 'p-velho']);
    expect(r.abertos).toBe(2);
    expect(r.estado.anteriorJobId).toBe('job-falhou');
  });

  it('an entry this job already holds is MERGED with the carried one: every motivo, the earliest since', async () => {
    const db = new FakeDb();
    seedEsteJob(db);
    seedJob(db, 'job-anterior', 400);
    seedEntrada(db, 'job-anterior', 'p1', {
      motivos: [MOTIVO_REVISAO_FISCAL_LI.semCategoria],
      desdeJobId: 'job-anterior',
      desdeMs: AGORA_MS,
    });
    seedEntrada(db, JOB, 'p1', {
      motivos: [MOTIVO_REVISAO_FISCAL_LI.categoriaPreenchida],
      desdeJobId: JOB,
      desdeMs: AGORA_MS + 1,
    });
    seedProduto(db, 'p1');
    await rodarFase(deps(db));
    expect(db.ler(caminhoEntrada(JOB, 'p1'))).toEqual({
      produtoId: 'p1',
      motivos: [
        MOTIVO_REVISAO_FISCAL_LI.semCategoria,
        MOTIVO_REVISAO_FISCAL_LI.categoriaPreenchida,
      ],
      liId: null,
      desdeJobId: 'job-anterior',
      desdeMs: AGORA_MS,
    });
  });

  it('pages: a source longer than one page and a walk past a page of Simular jobs carry EVERYTHING, one bounded unit at a time', async () => {
    const db = new FakeDb();
    seedEsteJob(db);
    for (let i = 0; i < 12; i += 1) {
      seedJob(db, `job-sim-${String(i).padStart(2, '0')}`, 500 + i, {
        modo: MODO_IMPORTACAO_LI.simular,
      });
    }
    seedJob(db, 'job-anterior', 400);
    const n = PAGINA_TRANSPORTE_REVISAO_LI + 7;
    for (let i = 0; i < n; i += 1) {
      const id = `p-${String(i).padStart(4, '0')}`;
      seedEntrada(db, 'job-anterior', id);
      seedProduto(db, id);
    }
    const r = await rodarFase(deps(db));
    expect(listaDe(db)).toHaveLength(n);
    expect(r.abertos).toBe(n);
    const transportes = r.passos.filter(
      (p) => p.tipo === PASSO_REVISAO_FISCAL_LI.progresso && p.transportadas > 0,
    );
    expect(transportes.map((p) => (p.tipo === 'progresso' ? p.transportadas : 0))).toEqual([
      PAGINA_TRANSPORTE_REVISAO_LI,
      7,
    ]);
    // Every job page is a bounded query, and the walk crossed one.
    expect(
      db.consultas.filter((c) => c.colecao === 'importacoesLojaIntegrada').map((c) => c.limite),
    ).toEqual([10, 10]);
  });

  it('the conta’s first aplicar job: nothing to carry, the re-check starts at once', async () => {
    const db = new FakeDb();
    seedEsteJob(db);
    seedEntrada(db, JOB, 'p1');
    seedProduto(db, 'p1');
    const r = await rodarFase(deps(db));
    expect(r.abertos).toBe(1);
    expect(r.estado.anteriorJobId).toBeNull();
  });

  it.each([ETAPA_REVISAO_FISCAL_LI.copiando, ETAPA_REVISAO_FISCAL_LI.apos])(
    'an inconsistent cursor (`%s` with no source) starts the phase over — and lands where a clean run lands (every step is idempotent)',
    async (etapa) => {
      function semeado(): FakeDb {
        const db = new FakeDb();
        seedEsteJob(db);
        seedJob(db, 'job-anterior', 400);
        seedEntrada(db, 'job-anterior', 'p1');
        seedProduto(db, 'p1');
        return db;
      }
      const limpo = await rodarFase(deps(semeado()));
      // Its own store: on the clean run's, p1 would already be in this job's list whether the
      // inconsistent cursor carried anything or not.
      const db = semeado();
      const recomecado = await rodarFase(deps(db), {
        ...INICIAL,
        etapa,
        fonteJobId: null,
      });
      expect(recomecado.abertos).toBe(1);
      expect(recomecado.abertos).toBe(limpo.abertos);
      expect(listaDe(db)).toEqual(['p1']);
      // Only the walk's own first step sets it: the phase really did start over.
      expect(recomecado.estado.anteriorJobId).toBe('job-anterior');
    },
  );
});

/* ------------------------------ the re-check ------------------------------- */

describe('the re-check — an entry leaves on EVIDENCE only', () => {
  async function umaEntrada(prepara: (db: FakeDb) => void) {
    const db = new FakeDb();
    seedEsteJob(db);
    seedEntrada(db, JOB, 'p1');
    prepara(db);
    const r = await rodarFase(deps(db));
    return { db, abertos: r.abertos, ficou: listaDe(db).includes('p1') };
  }

  it('PAIR: its CATEGORY gains an imposto doc ⇒ it leaves ⟷ NEAR-MISS an imposto doc of ANOTHER category ⇒ it stays', async () => {
    const sai = await umaEntrada((db) => {
      seedProduto(db, 'p1', 'c1');
      db.seed('categorias/c1/imposto/i1', { NCM: '61091000' });
    });
    expect(sai).toMatchObject({ abertos: 0, ficou: false });
    const fica = await umaEntrada((db) => {
      seedProduto(db, 'p1', 'c1');
      db.seed('categorias/c2/imposto/i1', { NCM: '61091000' });
    });
    expect(fica).toMatchObject({ abertos: 1, ficou: true });
  });

  it('PAIR: covered ONLY by a regraImposto naming its category ⇒ it leaves (tier 4 counted) ⟷ NEAR-MISS a rule naming another category ⇒ it stays', async () => {
    const sai = await umaEntrada((db) => {
      seedProduto(db, 'p1', 'c1');
      seedRegra(db, 'op1', 'r1', { categorias: ['documents/categorias/c1'] });
    });
    expect(sai).toMatchObject({ abertos: 0, ficou: false });
    const fica = await umaEntrada((db) => {
      seedProduto(db, 'p1', 'c1');
      seedRegra(db, 'op1', 'r1', { categorias: ['documents/categorias/c2'] });
    });
    expect(fica).toMatchObject({ abertos: 1, ficou: true });
  });

  it('a rule naming the PRODUTO ⇒ it leaves; a rule that does not parse covers nothing (the cascade drops it) ⇒ it stays', async () => {
    const sai = await umaEntrada((db) => {
      seedProduto(db, 'p1');
      seedRegra(db, 'op1', 'r1', { produtos: ['produtos/p1'] });
    });
    expect(sai.ficou).toBe(false);
    const fica = await umaEntrada((db) => {
      seedProduto(db, 'p1');
      seedRegra(db, 'op1', 'r1', { produtos: ['produtos/p1'], nome: '' });
    });
    expect(fica.ficou).toBe(true);
  });

  it('NEAR-MISS (stated): a rule matching only an NCM the produto document carries does not close it — the NCM is what the review asks a person to set', async () => {
    const fica = await umaEntrada((db) => {
      seedProduto(db, 'p1', null, { NCM: '61091000' });
      seedRegra(db, 'op1', 'r1', { ncms: ['6109.10.00'] });
    });
    expect(fica.ficou).toBe(true);
  });

  it('a `regras` collection that is not an operação’s is never read as tax rules', async () => {
    const fica = await umaEntrada((db) => {
      seedProduto(db, 'p1');
      db.seed('outra/x/regras/r1', { produtos: ['produtos/p1'], categorias: [], ncms: [] });
    });
    expect(fica.ficou).toBe(true);
  });

  it('PAIR: its OWN imposto doc ⇒ it leaves ⟷ NEAR-MISS another produto’s ⇒ it stays', async () => {
    const sai = await umaEntrada((db) => {
      seedProduto(db, 'p1', 'c1');
      db.seed('produtos/p1/imposto/i1', { NCM: '61091000' });
    });
    expect(sai.ficou).toBe(false);
    const fica = await umaEntrada((db) => {
      seedProduto(db, 'p1', 'c1');
      db.seed('produtos/p2/imposto/i1', { NCM: '61091000' });
    });
    expect(fica.ficou).toBe(true);
  });

  it('decided 2026-11-06: the produto deleted ⇒ it leaves (nothing could ever close it, and it is never invoiced)', async () => {
    const sai = await umaEntrada(() => undefined);
    expect(sai).toMatchObject({ abertos: 0, ficou: false });
  });

  it('a later CLEAN job without evidence ⇒ the entry STAYS: carried forward, still open', async () => {
    const db = new FakeDb();
    seedJob(db, 'job-1', 100);
    seedEntrada(db, 'job-1', 'p1', { desdeJobId: 'job-1', desdeMs: AGORA_MS });
    seedProduto(db, 'p1', 'c1');
    seedEsteJob(db);
    const r = await rodarFase(deps(db));
    expect(r.abertos).toBe(1);
    expect(db.ler(caminhoEntrada(JOB, 'p1'))).toMatchObject({ desdeJobId: 'job-1' });
    // The earlier job's own list is never touched.
    expect(db.ler(caminhoEntrada('job-1', 'p1'))).toBeDefined();
  });

  it('PAIR: the list empty ⇒ abertos 0 and the aviso RESOLVES ⟷ NEAR-MISS one entry open ⇒ the aviso is raised', async () => {
    const avisoDeps = { increment, nowMs: AGORA_MS };
    const job = {
      jobId: JOB,
      integracaoId: CONTA,
      lojaNome: 'Loja',
      modo: MODO_IMPORTACAO_LI.aplicar,
    };

    const vazia = await umaEntrada((db) => {
      seedProduto(db, 'p1', 'c1');
      db.seed('categorias/c1/imposto/i1', {});
    });
    expect(
      await sincronizarAvisoDeRevisaoFiscalLi(
        asDb(vazia.db),
        { ...job, fimMs: AGORA_MS, abertos: vazia.abertos },
        avisoDeps,
      ),
    ).toBe(RESULTADO_AVISO_IMPORTACAO_LI.resolvido);

    const aberta = await umaEntrada((db) => seedProduto(db, 'p1', 'c1'));
    expect(
      await sincronizarAvisoDeRevisaoFiscalLi(
        asDb(aberta.db),
        { ...job, fimMs: AGORA_MS, abertos: aberta.abertos },
        avisoDeps,
      ),
    ).toBe(RESULTADO_AVISO_IMPORTACAO_LI.avisado);
    expect(aberta.db.ler(caminhoAviso(chaveRevisaoFiscalLi(CONTA)))).toMatchObject({
      params: { abertos: 1, job: JOB },
    });
  });

  it('pages of the re-check keep the count across units: leaving entries are deleted, the rest counted once', async () => {
    const db = new FakeDb();
    seedEsteJob(db);
    const n = PAGINA_CONFERENCIA_REVISAO_LI * 2 + 3;
    for (let i = 0; i < n; i += 1) {
      const id = `p-${String(i).padStart(4, '0')}`;
      seedEntrada(db, JOB, id);
      // Every third produto has its own tax setting.
      seedProduto(db, id);
      if (i % 3 === 0) db.seed(`produtos/${id}/imposto/i`, {});
    }
    const r = await rodarFase(deps(db));
    const saem = Math.ceil(n / 3);
    expect(r.abertos).toBe(n - saem);
    expect(listaDe(db)).toHaveLength(n - saem);
    expect(r.passos.map((p) => p.conferidas)).toEqual([
      0,
      PAGINA_CONFERENCIA_REVISAO_LI,
      PAGINA_CONFERENCIA_REVISAO_LI,
      3,
    ]);
  });
});

describe('evidenciaFiscalDoProdutoLi — at most three reads, the rules read once', () => {
  it('a rule answers after ONE read; no evidence costs THREE (produto, its imposto, its category’s)', async () => {
    const db = new FakeDb();
    seedProduto(db, 'p1', 'c1');
    expect(await evidenciaFiscalDoProdutoLi(asDb(db), 'p1', [])).toBeNull();
    expect(db.leituras).toEqual(['produtos/p1']);
    expect(db.consultas.map((c) => [c.colecao, c.limite])).toEqual([
      ['produtos/p1/imposto', 1],
      ['categorias/c1/imposto', 1],
    ]);

    seedRegra(db, 'op1', 'r1', { produtos: ['p1'] });
    const lidas = await criarLeitorDeRegrasImpostoLi(asDb(db))();
    expect(lidas).toHaveLength(1);
    const antes = { leituras: db.leituras.length, consultas: db.consultas.length };
    expect(await evidenciaFiscalDoProdutoLi(asDb(db), 'p1', lidas)).toBe(EVIDENCIA_FISCAL_LI.regra);
    expect(db.leituras.length - antes.leituras).toBe(1);
    expect(db.consultas).toHaveLength(antes.consultas);
  });

  it('a produto with no category never reads a category’s imposto', async () => {
    const db = new FakeDb();
    seedProduto(db, 'p1');
    expect(await evidenciaFiscalDoProdutoLi(asDb(db), 'p1', [])).toBeNull();
    expect(db.consultas.map((c) => c.colecao)).toEqual(['produtos/p1/imposto']);
  });

  it('the rules are read ONCE per reader (one per dispatch), and never for an empty page', async () => {
    const db = new FakeDb();
    seedEsteJob(db);
    for (let i = 0; i < PAGINA_CONFERENCIA_REVISAO_LI + 1; i += 1) {
      seedEntrada(db, JOB, `p-${String(i).padStart(3, '0')}`);
      seedProduto(db, `p-${String(i).padStart(3, '0')}`);
    }
    await rodarFase(deps(db));
    expect(db.consultas.filter((c) => c.colecao === 'regras' && c.grupo === true)).toHaveLength(1);

    const vazio = new FakeDb();
    seedEsteJob(vazio);
    await rodarFase(deps(vazio));
    expect(vazio.consultas.filter((c) => c.colecao === 'regras')).toEqual([]);
  });
});

/* ------------------------------- the indexes ------------------------------- */

describe('every query the phase sends rides a declared index, or none (root rule 1)', () => {
  interface IndiceDeclarado {
    readonly collectionGroup: string;
    readonly queryScope: string;
    readonly fields: readonly { readonly fieldPath: string; readonly order?: string }[];
  }
  function indices(): IndiceDeclarado[] {
    let dir = dirname(fileURLToPath(import.meta.url));
    while (!existsSync(resolve(dir, 'pnpm-workspace.yaml'))) dir = dirname(dir);
    return (
      JSON.parse(readFileSync(resolve(dir, 'firestore.indexes.json'), 'utf8')) as {
        indexes: IndiceDeclarado[];
      }
    ).indexes;
  }

  it('the jobs walk: integracaoId == + iniciadoEmMs DESC — the declared composite; everything else unfiltered', async () => {
    const db = new FakeDb();
    seedEsteJob(db);
    seedJob(db, 'job-anterior', 400);
    seedEntrada(db, 'job-anterior', 'p1');
    seedProduto(db, 'p1', 'c1');
    seedRegra(db, 'op1', 'r1', {});
    await rodarFase(deps(db));

    const filtradas = db.consultas.filter((c) => c.filtros.length > 0 || c.ordens.length > 0);
    const dosJobs = filtradas.filter((c) => c.colecao === 'importacoesLojaIntegrada');
    // Anti-vacuity: the walk ran.
    expect(dosJobs.length).toBeGreaterThan(0);
    const declarado = indices().find(
      (i) =>
        i.collectionGroup === 'importacoesLojaIntegrada' &&
        i.queryScope === 'COLLECTION' &&
        i.fields.map((f) => `${f.fieldPath}:${f.order ?? ''}`).join(',') ===
          'integracaoId:ASCENDING,iniciadoEmMs:DESCENDING',
    );
    expect(declarado).toBeDefined();
    for (const c of dosJobs) {
      expect(c.filtros).toEqual([['integracaoId', '==', CONTA]]);
      expect(c.ordens).toEqual([['iniciadoEmMs', 'desc']]);
    }
    // No other query is ordered — above all, no document-key RANGE over a list: on Enterprise,
    // with no `__name__` index, every such page scans the whole list (module header).
    expect(filtradas.filter((q) => q.colecao !== 'importacoesLojaIntegrada')).toEqual([]);
    // The rest: a job's list read WHOLE, the produto's and the category's imposto `limit(1)`, and
    // the rules' group, whole.
    const soltas = db.consultas.filter((q) => q.filtros.length === 0 && q.ordens.length === 0);
    // Anti-vacuity: both lists (the source's and this job's) were read whole.
    expect(
      soltas
        .filter((c) => c.colecao.endsWith('/revisao'))
        .map((c) => c.colecao)
        .sort(),
    ).toEqual([`${caminhoJobLi('job-anterior')}/revisao`, `${caminhoJobLi(JOB)}/revisao`].sort());
    for (const c of soltas) {
      expect(
        (/^importacoesLojaIntegrada\/[^/]+\/revisao$/.test(c.colecao) &&
          c.limite === null &&
          c.apos === null) ||
          (c.colecao.endsWith('/imposto') && c.limite === 1) ||
          (c.colecao === 'regras' && c.grupo === true && c.limite === null),
        JSON.stringify(c),
      ).toBe(true);
    }
  });
});

describe('a list is read WHOLE once per dispatch — never paged by a key range', () => {
  it('a re-check of three pages and a two-page carry read each list ONCE per reader; a new reader (the next dispatch) reads again', async () => {
    const db = new FakeDb();
    seedEsteJob(db);
    seedJob(db, 'job-anterior', 400);
    const n = PAGINA_TRANSPORTE_REVISAO_LI + 3;
    for (let i = 0; i < n; i += 1) {
      const id = `p-${String(i).padStart(4, '0')}`;
      seedEntrada(db, 'job-anterior', id);
      seedProduto(db, id);
    }
    const leiturasDe = (jobId: string) =>
      db.consultas.filter((c) => c.colecao === `${caminhoJobLi(jobId)}/revisao`).length;
    const umDespacho = deps(db);
    const r = await rodarFase(umDespacho);
    expect(r.abertos).toBe(n);
    // Two copy pages, three re-check pages: still ONE read of each list.
    expect(r.passos.filter((p) => p.tipo === 'progresso' && p.transportadas > 0)).toHaveLength(2);
    expect(r.passos.filter((p) => p.conferidas > 0)).toHaveLength(3);
    expect(leiturasDe('job-anterior')).toBe(1);
    expect(leiturasDe(JOB)).toBe(1);

    // The next dispatch's reader reads this job's list again, once.
    await executarUnidadeDaRevisaoFiscalLi(deps(db), {
      ...INICIAL,
      etapa: ETAPA_REVISAO_FISCAL_LI.conferindo,
    });
    expect(leiturasDe(JOB)).toBe(2);
  });

  it('PAIR: the in-memory page resumes strictly AFTER the cursor’s id ⟷ NEAR-MISS an id equal to it is never handled twice', async () => {
    const db = new FakeDb();
    seedEsteJob(db);
    for (const id of ['a', 'b', 'c']) {
      seedEntrada(db, JOB, id);
      seedProduto(db, id);
    }
    const passo = await executarUnidadeDaRevisaoFiscalLi(deps(db), {
      ...INICIAL,
      etapa: ETAPA_REVISAO_FISCAL_LI.conferindo,
      abertos: 1,
      depoisProdutoId: 'b',
    });
    expect(passo).toMatchObject({ tipo: 'concluido', conferidas: 1, abertos: 2 });
    expect(passo.estado).toMatchObject({
      etapa: ETAPA_REVISAO_FISCAL_LI.conferindo,
      abertos: 2,
      depoisProdutoId: 'c',
    });
  });
});
