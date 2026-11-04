/**
 * The product import's link writes (`vinculos.ts`), on the fake Firestore: the create at the store
 * id's doc id (tier 0, `ALREADY_EXISTS` judged), the mirror refresh (tier 1 on its own read), the
 * one-store-product-per-conta refusals, the re-plan after a lost write, Simular, and the rule that
 * a variation is linked only beside its parent's confirmed link.
 *
 * Every refresh decision is pinned as a PAIR — the equal case and the near-miss — and nothing
 * reaches the network (D17): the GLOBAL `fetch` is stubbed to throw for the whole file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { produtoLojaIntegradaLinkCollection } from '@delfrance/data/admin/collections';
import {
  ALVO_IMPORTACAO_LI,
  ACAO_IMPORTACAO_LI,
  FORMA_RAIZ_ERP,
  MODO_IMPORTACAO_LI,
  type ModoImportacaoLi,
  PENDENCIA_IMPORTACAO_LI,
  SITUACAO_ERP_ITEM_LI,
} from '@delfrance/schemas';

import { type DocData, FakeDb, asDb, grpc } from '../testing/fakeDb';
import { seedJobLi } from '../testing/importacaoLi';
import { filhoLi, linhaProdutoLi, paiLi, vistaLi } from '../testing/produtosLi';
import { type FamiliaLi, ORIGEM_DO_FILHO_LI } from './familias';
import { type PlanoDaFamiliaLi, type VinculoPlanejadoLi, planejarFamiliaLi } from './plano';
import {
  SITUACAO_DO_FILHO_LI,
  VIA_DA_RAIZ_LI,
  VIA_DO_FILHO_LI,
  type ResolucaoDoFilhoLi,
} from './resolucao';
import {
  DESFECHO_DO_VINCULO_LI,
  type DepsVinculosLi,
  patchDoVinculoLi,
  vincularFamiliaLi,
  vincularProdutoLi,
} from './vinculos';

const CONTA = 'conta-li-vinculos';
const OUTRA = 'conta-li-vinculos-2';
const REF = (conta = CONTA) => `documents/integracao/${conta}`;

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('vinculos.test: nenhuma chamada de rede'))),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------- fixtures --------------------------------- */

let jobs = 0;

/**
 * One JOB's deps: its document is seeded NOW, so its createTime follows every write made before
 * and precedes every write made after. Two calls are two jobs; one deps object reused is one job
 * re-running a unit.
 */
function deps(db: FakeDb, modo: ModoImportacaoLi = MODO_IMPORTACAO_LI.aplicar): DepsVinculosLi {
  jobs += 1;
  const criacaoDoJob = seedJobLi(db, `job-vinculos-${String(jobs)}`, CONTA);
  return { db: asDb(db), contaId: CONTA, modo, criacaoDoJob: criacaoDoJob as unknown as Timestamp };
}

const caminho = (produtoId: string, docId: string) =>
  `produtos/${produtoId}/produtolojaintegrada/${docId}`;

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

function casado(liId: number, erpId: string): ResolucaoDoFilhoLi {
  return {
    liId,
    situacao: SITUACAO_DO_FILHO_LI.casado,
    erp: {
      id: erpId,
      sku: null,
      paiId: 'pai',
      filhoUnicoId: null,
      variacoesUid: null,
      grupoDeVariacoesUid: null,
    },
    via: VIA_DO_FILHO_LI.sku,
    opcoes: [],
    pendencias: [],
  };
}

/** The plan of a family matched to ERP root `erpId`, its variations to `filhosErp` (liId → erp). */
function plano(
  raiz: DocData,
  erpId: string,
  filhos: readonly DocData[] = [],
  filhosErp: Readonly<Record<number, string>> = {},
): PlanoDaFamiliaLi {
  return planejarFamiliaLi({
    job: {
      integracaoId: CONTA,
      modo: MODO_IMPORTACAO_LI.aplicar,
      alvo: ALVO_IMPORTACAO_LI.todos,
      acao: ACAO_IMPORTACAO_LI.soVincular,
      selecionados: [],
    },
    familia: familia(raiz, filhos),
    raiz: {
      tipo: SITUACAO_ERP_ITEM_LI.vinculado,
      erpId,
      via: VIA_DA_RAIZ_LI.vinculo,
      forma: FORMA_RAIZ_ERP.familiaDeMuitas,
    },
    filhos:
      filhos.length === 0
        ? null
        : {
            filhos: Object.entries(filhosErp).map(([li, erp]) => casado(Number(li), erp)),
            erpFilhos: [],
            combinacaoAmbiguaNaLoja: false,
            pendencias: [],
          },
    skusRepetidos: new Set(),
    recusasDoAprendizado: new Map(),
  });
}

/** The root link of a simple store product `liId` under ERP produto `produtoId`. */
function vinculoSimples(liId: number, produtoId: string, over: DocData = {}): VinculoPlanejadoLi {
  const v = plano(linhaProdutoLi(liId, over), produtoId).raizVinculo;
  if (v === null) throw new Error('vinculos.test: sem vínculo planejado');
  return v;
}

/** A concurrent writer of link `p10/10` (the publisher, a person): any field moves its stamp. */
async function outroEscritor(db: FakeDb, error: string): Promise<void> {
  await produtoLojaIntegradaLinkCollection
    .docRef(asDb(db), { produtoId: 'p10' }, '10')
    .update({ error });
}

function seedLink(db: FakeDb, produtoId: string, docId: string, campos: DocData) {
  return db.seed(caminho(produtoId, docId), { contaLojaIntegrada: REF(), sku: 's', ...campos });
}

/* ------------------------------- the create -------------------------------- */

describe('vincularProdutoLi — a free produto: the create at String(id)', () => {
  it('creates the planned document whole, at the store id, and nothing else', async () => {
    const db = new FakeDb();
    db.seed('produtos/p10', { nome: 'P', sku: 'SKU-10', paiId: null });
    const v = vinculoSimples(10, 'p10');
    const r = await vincularProdutoLi(deps(db), v);
    expect(r).toMatchObject({
      desfecho: { tipo: DESFECHO_DO_VINCULO_LI.criado, docId: '10' },
      gravado: true,
    });
    expect(db.escritas).toHaveLength(1);
    expect(db.escritas[0]).toMatchObject({ verbo: 'create', caminho: caminho('p10', '10') });
    expect(db.ler(caminho('p10', '10'))).toEqual(v.doc);
    expect(db.ler(caminho('p10', '10'))).not.toHaveProperty('destaque');
  });

  it('Simular: the same decision, zero writes', async () => {
    const db = new FakeDb();
    const r = await vincularProdutoLi(
      deps(db, MODO_IMPORTACAO_LI.simular),
      vinculoSimples(10, 'p10'),
    );
    expect(r).toMatchObject({ desfecho: { tipo: DESFECHO_DO_VINCULO_LI.criado }, gravado: false });
    expect(db.escritas).toEqual([]);
  });

  it('a store product with no SKU cannot be created ⇒ sem-sku, nothing written', async () => {
    const db = new FakeDb();
    const r = await vincularProdutoLi(deps(db), vinculoSimples(10, 'p10', { sku: '' }));
    expect(r.desfecho).toEqual({
      tipo: DESFECHO_DO_VINCULO_LI.recusado,
      codigo: PENDENCIA_IMPORTACAO_LI.semSku,
      referencias: [],
    });
    expect(db.escritas).toEqual([]);
  });

  describe('ALREADY_EXISTS: the document now at our id is judged', () => {
    it("this conta's link for this id ⇒ adopted and refreshed on that read", async () => {
      const db = new FakeDb();
      db.antesDaProximaEscrita(caminho('p10', '10'), () => {
        seedLink(db, 'p10', '10', { id: 10, removido: true });
      });
      const r = await vincularProdutoLi(deps(db), vinculoSimples(10, 'p10'));
      expect(r.desfecho).toMatchObject({ tipo: DESFECHO_DO_VINCULO_LI.atualizado, docIds: ['10'] });
      expect(db.ler(caminho('p10', '10'))?.removido).toBe(false);
      expect(db.escritas.map((e) => e.verbo)).toEqual(['update']);
    });

    it('near-miss: a TEXT id there ⇒ vinculo-ilegivel, never adopted or filled', async () => {
      const db = new FakeDb();
      db.antesDaProximaEscrita(caminho('p10', '10'), () => {
        seedLink(db, 'p10', '10', { id: '10' });
      });
      const r = await vincularProdutoLi(deps(db), vinculoSimples(10, 'p10'));
      expect(r.desfecho).toMatchObject({ codigo: PENDENCIA_IMPORTACAO_LI.vinculoIlegivel });
      expect(db.escritas).toEqual([]);
    });

    it("near-miss: another conta's document there ⇒ vinculo-ambiguo", async () => {
      const db = new FakeDb();
      db.antesDaProximaEscrita(caminho('p10', '10'), () => {
        seedLink(db, 'p10', '10', { id: 10, contaLojaIntegrada: REF(OUTRA) });
      });
      const r = await vincularProdutoLi(deps(db), vinculoSimples(10, 'p10'));
      expect(r.desfecho).toMatchObject({ codigo: PENDENCIA_IMPORTACAO_LI.vinculoAmbiguo });
      expect(db.escritas).toEqual([]);
    });
  });
});

/* --------------------------- one store product per conta -------------------- */

describe('vincularProdutoLi — the scan refuses, writing nothing', () => {
  it('this conta already links the produto to ANOTHER store product ⇒ vinculado-a-outro', async () => {
    const db = new FakeDb();
    seedLink(db, 'p10', '99', { id: 99 });
    const r = await vincularProdutoLi(deps(db), vinculoSimples(10, 'p10'));
    expect(r.desfecho).toEqual({
      tipo: DESFECHO_DO_VINCULO_LI.recusado,
      codigo: PENDENCIA_IMPORTACAO_LI.vinculadoAOutro,
      referencias: ['99'],
    });
    expect(db.escritas).toEqual([]);
  });

  it("near-miss: ANOTHER conta's link to another store product does not refuse ⇒ created", async () => {
    const db = new FakeDb();
    seedLink(db, 'p10', '99', { id: 99, contaLojaIntegrada: REF(OUTRA) });
    const r = await vincularProdutoLi(deps(db), vinculoSimples(10, 'p10'));
    expect(r.desfecho.tipo).toBe(DESFECHO_DO_VINCULO_LI.criado);
  });

  it('a link of this conta whose id is TEXT ⇒ vinculo-ilegivel', async () => {
    const db = new FakeDb();
    seedLink(db, 'p10', 'auto-1', { id: '10' });
    const r = await vincularProdutoLi(deps(db), vinculoSimples(10, 'p10'));
    expect(r.desfecho).toMatchObject({
      codigo: PENDENCIA_IMPORTACAO_LI.vinculoIlegivel,
      referencias: ['auto-1'],
    });
    expect(db.escritas).toEqual([]);
  });
});

/* ------------------------------- the refresh -------------------------------- */

describe('vincularProdutoLi — the mirror refresh (tier 1 on its own read)', () => {
  it("stored removido: true and the product listed again ⇒ removido: false, under the read's stamp", async () => {
    const db = new FakeDb();
    const carimbo = seedLink(db, 'p10', '10', { id: 10, removido: true, nome: 'Antigo' });
    const r = await vincularProdutoLi(deps(db), vinculoSimples(10, 'p10'));
    // `estadoPublicacao` was absent (filled); `ativo`/`bloqueado` absent READ as the store's.
    expect(r.desfecho).toEqual({
      tipo: DESFECHO_DO_VINCULO_LI.atualizado,
      docIds: ['10'],
      campos: ['estadoPublicacao', 'removido'],
    });
    const [escrita] = db.escritas;
    expect(escrita?.verbo).toBe('update');
    expect(escrita?.dados).toMatchObject({ removido: false });
    // Fields with a value are never touched: the stored name stays.
    expect(escrita?.dados).not.toHaveProperty('nome');
    expect(db.ler(caminho('p10', '10'))?.nome).toBe('Antigo');
    expect(db.carimboDe(caminho('p10', '10'))).not.toBe(carimbo);
  });

  it('an unchanged link ⇒ sem-mudanca, ZERO writes (a second run writes nothing)', async () => {
    const db = new FakeDb();
    const v = vinculoSimples(10, 'p10');
    await vincularProdutoLi(deps(db), v);
    const antes = db.escritas.length;
    const r = await vincularProdutoLi(deps(db), v);
    expect(r.desfecho).toEqual({ tipo: DESFECHO_DO_VINCULO_LI.semMudanca, docIds: ['10'] });
    expect(db.escritas).toHaveLength(antes);
  });

  it('an auto-id link of this conta (the mixed-id corpus) is refreshed WHERE IT IS, never duplicated', async () => {
    const db = new FakeDb();
    seedLink(db, 'p10', 'aBcDeF123', { id: 10, ativo: true, removido: true });
    const r = await vincularProdutoLi(deps(db), vinculoSimples(10, 'p10'));
    expect(r.desfecho).toMatchObject({
      tipo: DESFECHO_DO_VINCULO_LI.atualizado,
      docIds: ['aBcDeF123'],
    });
    expect(db.ler(caminho('p10', '10'))).toBeUndefined();
    expect(db.ler(caminho('p10', 'aBcDeF123'))?.removido).toBe(false);
  });

  it('a lost precondition re-plans once from a fresh scan', async () => {
    const db = new FakeDb();
    seedLink(db, 'p10', '10', { id: 10, removido: true });
    db.antesDaProximaEscrita(caminho('p10', '10'), async () => {
      await outroEscritor(db, 'outro escritor');
    });
    const r = await vincularProdutoLi(deps(db), vinculoSimples(10, 'p10'));
    expect(r.desfecho.tipo).toBe(DESFECHO_DO_VINCULO_LI.atualizado);
    expect(db.ler(caminho('p10', '10'))).toMatchObject({
      removido: false,
      error: 'outro escritor',
    });
  });

  it('a second loss ⇒ conflito-de-escrita, never forced', async () => {
    const db = new FakeDb();
    seedLink(db, 'p10', '10', { id: 10, removido: true });
    // Hooks fire inside each other's writes: the second is installed once the first one's own
    // write has landed.
    db.antesDaProximaEscrita(caminho('p10', '10'), async () => {
      await outroEscritor(db, 'escritor 1');
      db.antesDaProximaEscrita(caminho('p10', '10'), async () => {
        await outroEscritor(db, 'escritor 2');
      });
    });
    const r = await vincularProdutoLi(deps(db), vinculoSimples(10, 'p10'));
    expect(r.desfecho).toEqual({
      tipo: DESFECHO_DO_VINCULO_LI.recusado,
      codigo: PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita,
      referencias: ['p10'],
    });
    expect(db.ler(caminho('p10', '10'))?.removido).toBe(true);
  });

  it('any other Firestore failure propagates (the task retries)', async () => {
    const db = new FakeDb();
    seedLink(db, 'p10', '10', { id: 10, removido: true });
    db.falharEscrita(caminho('p10', '10'), grpc(14, 'UNAVAILABLE'));
    await expect(vincularProdutoLi(deps(db), vinculoSimples(10, 'p10'))).rejects.toMatchObject({
      code: 14,
    });
  });

  it('Simular reports the refresh it would make and writes nothing', async () => {
    const db = new FakeDb();
    seedLink(db, 'p10', '10', { id: 10, removido: true });
    const r = await vincularProdutoLi(
      deps(db, MODO_IMPORTACAO_LI.simular),
      vinculoSimples(10, 'p10'),
    );
    expect(r).toMatchObject({
      desfecho: { tipo: DESFECHO_DO_VINCULO_LI.atualizado },
      gravado: false,
    });
    expect(db.escritas).toEqual([]);
  });
});

/* ------------------------ the links THIS job created ------------------------ */

describe('vincularProdutoLi — a link THIS job already created is still its creation', () => {
  const linkRef = (db: FakeDb) =>
    produtoLojaIntegradaLinkCollection.docRef(asDb(db), { produtoId: 'p10' }, '10');

  it('a retried unit (the create LANDED, what followed it failed) ⇒ criado again, retomado — ZERO writes', async () => {
    const db = new FakeDb();
    const v = vinculoSimples(10, 'p10');
    const job = deps(db);
    await vincularProdutoLi(job, v);
    const antes = db.escritas.length;
    // The SAME job re-runs the unit from its old cursor.
    const r = await vincularProdutoLi(job, v);
    expect(r).toEqual({
      vinculo: v,
      desfecho: { tipo: DESFECHO_DO_VINCULO_LI.criado, docId: '10', retomado: true },
      gravado: true,
    });
    expect(db.escritas).toHaveLength(antes);
  });

  it('a lost reply (ALREADY_EXISTS on OUR landed create) ⇒ criado, retomado — the one create is all that landed', async () => {
    const db = new FakeDb();
    const v = vinculoSimples(10, 'p10');
    const job = deps(db);
    // The first commit lands; the SDK's retry of the same create meets it.
    db.antesDaProximaEscrita(caminho('p10', '10'), async () => {
      await linkRef(db).create({ ...v.doc });
    });
    const r = await vincularProdutoLi(job, v);
    expect(r.desfecho).toEqual({
      tipo: DESFECHO_DO_VINCULO_LI.criado,
      docId: '10',
      retomado: true,
    });
    expect(db.escritas.map((e) => [e.verbo, e.caminho])).toEqual([
      ['create', caminho('p10', '10')],
    ]);
  });

  it('"at or after the job’s createTime", seconds first, then nanoseconds — and a link one tick EARLIER is not this job’s', async () => {
    const db = new FakeDb();
    const v = vinculoSimples(10, 'p10');
    await vincularProdutoLi(deps(db), v);
    const criado = (await linkRef(db).get()).createTime;
    if (criado === undefined) throw new Error('vinculos.test: sem createTime');
    const jobEm = (seconds: number, nanoseconds: number): DepsVinculosLi => ({
      ...deps(db),
      criacaoDoJob: new Timestamp(seconds, nanoseconds),
    });
    const tipo = async (d: DepsVinculosLi) => (await vincularProdutoLi(d, v)).desfecho.tipo;
    const { seconds: s, nanoseconds: n } = criado;
    // EQUAL: the same instant; an earlier second whatever its nanoseconds.
    expect(await tipo(jobEm(s, n))).toBe(DESFECHO_DO_VINCULO_LI.criado);
    expect(await tipo(jobEm(s - 1, 999_999_999))).toBe(DESFECHO_DO_VINCULO_LI.criado);
    // NEAR-MISS: one nanosecond later; a later second whatever its nanoseconds.
    expect(await tipo(jobEm(s, n + 1))).toBe(DESFECHO_DO_VINCULO_LI.semMudanca);
    expect(await tipo(jobEm(s + 1, 0))).toBe(DESFECHO_DO_VINCULO_LI.semMudanca);
  });

  it('NEAR-MISS: this conta’s link created BEFORE this job started, identical to the plan ⇒ sem-mudanca (a second job counts nothing)', async () => {
    const db = new FakeDb();
    const v = vinculoSimples(10, 'p10');
    await vincularProdutoLi(deps(db), v);
    const r = await vincularProdutoLi(deps(db), v);
    expect(r).toEqual({
      vinculo: v,
      desfecho: { tipo: DESFECHO_DO_VINCULO_LI.semMudanca, docIds: ['10'] },
      gravado: false,
    });
  });

  it('NEAR-MISS: this conta’s link at an AUTO id, created during this job by another writer ⇒ sem-mudanca — this job creates only at the store id', async () => {
    const db = new FakeDb();
    const v = vinculoSimples(10, 'p10');
    const job = deps(db);
    await produtoLojaIntegradaLinkCollection
      .docRef(asDb(db), { produtoId: 'p10' }, 'aUtO1d')
      .create({ ...v.doc });
    const r = await vincularProdutoLi(job, v);
    expect(r.desfecho).toEqual({ tipo: DESFECHO_DO_VINCULO_LI.semMudanca, docIds: ['aUtO1d'] });
  });

  it('NEAR-MISS: ANOTHER conta’s document at our doc id, created during this job ⇒ vinculo-ambiguo, never counted', async () => {
    const db = new FakeDb();
    const job = deps(db);
    seedLink(db, 'p10', '10', {
      ...vinculoSimples(10, 'p10').doc,
      contaLojaIntegrada: REF(OUTRA),
    });
    const r = await vincularProdutoLi(job, vinculoSimples(10, 'p10'));
    expect(r.desfecho).toMatchObject({
      tipo: DESFECHO_DO_VINCULO_LI.recusado,
      codigo: PENDENCIA_IMPORTACAO_LI.vinculoAmbiguo,
    });
    expect(db.escritas).toEqual([]);
  });

  it('NEAR-MISS: a link this job created that ANOTHER writer has since changed ⇒ atualizado (the refresh it makes)', async () => {
    const db = new FakeDb();
    const v = vinculoSimples(10, 'p10');
    const job = deps(db);
    await vincularProdutoLi(job, v);
    await linkRef(db).update({ removido: true });
    const r = await vincularProdutoLi(job, v);
    expect(r.desfecho).toEqual({
      tipo: DESFECHO_DO_VINCULO_LI.atualizado,
      docIds: ['10'],
      campos: ['removido'],
    });
  });

  it('NEAR-MISS: Simular creates nothing, so a link of this conta created during it is never "its" creation ⇒ sem-mudanca', async () => {
    const db = new FakeDb();
    const v = vinculoSimples(10, 'p10');
    const simular = deps(db, MODO_IMPORTACAO_LI.simular);
    await linkRef(db).create({ ...v.doc });
    const r = await vincularProdutoLi(simular, v);
    expect(r.desfecho).toEqual({ tipo: DESFECHO_DO_VINCULO_LI.semMudanca, docIds: ['10'] });
  });

  it('a retried FAMILY: the root and every variation link it created read criado again', async () => {
    const db = new FakeDb();
    const p = plano(
      paiLi(500, [501, 502]),
      'pai',
      [filhoLi(501, { sku: 'A' }), filhoLi(502, { sku: 'B' })],
      { 501: 'f1', 502: 'f2' },
    );
    const job = deps(db);
    const primeira = await vincularFamiliaLi(job, p);
    const antes = db.escritas.length;
    const segunda = await vincularFamiliaLi(job, p);
    expect(db.escritas).toHaveLength(antes);
    const tipos = (r: typeof primeira) =>
      [r.raiz, ...r.filhos].map((x) => x?.desfecho.tipo ?? null);
    expect(tipos(primeira)).toEqual(['criado', 'criado', 'criado']);
    expect(tipos(segunda)).toEqual(tipos(primeira));
    // NEAR-MISS: a later job over the same links counts none of them.
    expect(tipos(await vincularFamiliaLi(deps(db), p))).toEqual([
      'sem-mudanca',
      'sem-mudanca',
      'sem-mudanca',
    ]);
  });
});

describe('patchDoVinculoLi — what a refresh changes (pairs)', () => {
  const v = vinculoSimples(10, 'p10', { ativo: true, bloqueado: false });

  it('the mirror is compared as the schema READS it: an absent ativo is true, absent bloqueado/removido false', () => {
    expect(
      patchDoVinculoLi({ id: 10, sku: 's', nome: 'x', categorias: [], estadoPublicacao: 'p' }, v),
    ).toEqual({});
  });

  it('⚠️ a stored mirror value the link schema REFUSES (null, a string) is not the store’s value: rewritten with the live boolean', () => {
    const base = { id: 10, sku: 's', nome: 'x', estadoPublicacao: 'p' };
    // `removido: null` while the store lists it live (false): the schema reads no value there.
    expect(patchDoVinculoLi({ ...base, removido: null }, v)).toEqual({ removido: false });
    expect(patchDoVinculoLi({ ...base, ativo: 'true' }, v)).toEqual({ ativo: true });
    expect(patchDoVinculoLi({ ...base, bloqueado: 0 }, v)).toEqual({ bloqueado: false });
    // EQUAL: the same values stored as booleans, or absent (the schema's defaults), change nothing.
    expect(
      patchDoVinculoLi({ ...base, removido: false, ativo: true, bloqueado: false }, v),
    ).toEqual({});
  });

  it('near-miss: the store now says hidden ⇒ ativo: false; blocked ⇒ bloqueado: true', () => {
    const oculto = vinculoSimples(10, 'p10', { ativo: false, bloqueado: true });
    expect(
      patchDoVinculoLi({ id: 10, sku: 's', nome: 'x', estadoPublicacao: 'p' }, oculto),
    ).toEqual({
      ativo: false,
      bloqueado: true,
    });
  });

  it('a field with a value is never touched, estadoPublicacao included; null or absent is filled', () => {
    expect(patchDoVinculoLi({ id: 10, sku: 's', nome: 'x', estadoPublicacao: 'E' }, v)).toEqual({});
    expect(patchDoVinculoLi({ id: 10, sku: 's', nome: null, estadoPublicacao: null }, v)).toEqual({
      nome: 'Produto 10',
      estadoPublicacao: 'p',
    });
  });

  it('a variation link fills a null paiProdutoIntegradaId, never rewrites a set one', () => {
    const p = plano(paiLi(500, [501]), 'pai', [filhoLi(501, { sku: 'A' })], { 501: 'f1' });
    const filho = p.filhosVinculos[0];
    if (filho === undefined) throw new Error('sem filho');
    const base = { id: 501, sku: 'A', estadoPublicacao: 'p', variacoes: ['x'] };
    expect(patchDoVinculoLi({ ...base, paiProdutoIntegradaId: null }, filho)).toEqual({
      paiProdutoIntegradaId: 500,
    });
    expect(patchDoVinculoLi({ ...base, paiProdutoIntegradaId: 777 }, filho)).toEqual({});
  });
});

/* -------------------------------- a family ---------------------------------- */

describe("vincularFamiliaLi — variations only beside the parent's confirmed link", () => {
  it('parent linked ⇒ every matched variation linked under its ERP child', async () => {
    const db = new FakeDb();
    const p = plano(
      paiLi(500, [501, 502]),
      'pai',
      [filhoLi(501, { sku: 'A' }), filhoLi(502, { sku: 'B' })],
      {
        501: 'f1',
        502: 'f2',
      },
    );
    const r = await vincularFamiliaLi(deps(db), p);
    expect(r.raiz?.desfecho.tipo).toBe(DESFECHO_DO_VINCULO_LI.criado);
    expect(r.filhos.map((f) => f.desfecho.tipo)).toEqual(['criado', 'criado']);
    expect(db.ler(caminho('f1', '501'))).toMatchObject({ id: 501, paiProdutoIntegradaId: 500 });
  });

  it('parent vinculado-a-outro ⇒ ZERO variation links, each vinculo-pai-ausente, no read of theirs', async () => {
    const db = new FakeDb();
    seedLink(db, 'pai', '999', { id: 999 });
    const p = plano(
      paiLi(500, [501, 502]),
      'pai',
      [filhoLi(501, { sku: 'A' }), filhoLi(502, { sku: 'B' })],
      {
        501: 'f1',
        502: 'f2',
      },
    );
    const r = await vincularFamiliaLi(deps(db), p);
    expect(r.raiz?.desfecho).toMatchObject({ codigo: PENDENCIA_IMPORTACAO_LI.vinculadoAOutro });
    expect(r.filhos.map((f) => f.desfecho)).toEqual([
      { tipo: 'recusado', codigo: PENDENCIA_IMPORTACAO_LI.vinculoPaiAusente, referencias: [] },
      { tipo: 'recusado', codigo: PENDENCIA_IMPORTACAO_LI.vinculoPaiAusente, referencias: [] },
    ]);
    expect(db.escritas).toEqual([]);
    expect(db.consultas.map((c) => c.colecao)).toEqual(['produtos/pai/produtolojaintegrada']);
  });

  it('Simular: a parent that WOULD be created confirms the variations', async () => {
    const db = new FakeDb();
    const p = plano(paiLi(500, [501]), 'pai', [filhoLi(501, { sku: 'A' })], { 501: 'f1' });
    const r = await vincularFamiliaLi(deps(db, MODO_IMPORTACAO_LI.simular), p);
    expect(r.filhos.map((f) => f.desfecho.tipo)).toEqual(['criado']);
    expect(db.escritas).toEqual([]);
  });

  it('a plan with no root link links nothing', async () => {
    const db = new FakeDb();
    expect(await vincularFamiliaLi(deps(db), { raizVinculo: null, filhosVinculos: [] })).toEqual({
      raiz: null,
      filhos: [],
    });
    expect(db.consultas).toEqual([]);
  });
});
