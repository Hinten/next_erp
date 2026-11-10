/**
 * The product import's category of one product (`categorias.ts`) on the fake Firestore: the leaf,
 * the linked case that costs nothing, `soVincular`'s refusal, and "create and link" — the ERP
 * parent's own breadcrumb, root-most first, tier 0 at deterministic ids with `ALREADY_EXISTS`
 * judged, Simular's map overlay giving `aplicar`'s verdicts, and two contas never sharing an id.
 *
 * Every decision is pinned as a PAIR (the equal case and the near-miss). Nothing reaches the network
 * (D17): the GLOBAL `fetch` is stubbed to throw for the whole file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CATEGORIAS_IMPORTACAO_LI,
  type CategoriaDoJobLi,
  MODO_IMPORTACAO_LI,
  type ModoImportacaoLi,
  MOTIVO_CATEGORIA_SEM_VINCULO_LI,
  PENDENCIA_IMPORTACAO_LI,
  VINCULO_CATEGORIA_IMPORTACAO_LI,
  type VinculoCategoriaImportacaoLi,
} from '@delfrance/schemas';

import { type DocData, FakeDb, asDb, grpc } from '../testing/fakeDb';
import { AGORA_MS } from '../testing/fixtures';
import {
  type CategoriaDoProdutoLi,
  type DepsCategoriasLi,
  TIPO_CATEGORIA_DO_PRODUTO_LI,
  avisoDaPendenciaDeCategoriaLi,
  idCategoriaCriadaLi,
  idVinculoCategoriaCriadoLi,
  resolverCategoriaDoProdutoLi,
} from './categorias';

const CONTA = 'conta-li-categorias';
const OUTRA = 'conta-li-categorias-2';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('categorias.test: nenhuma chamada de rede'))),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------- fixtures --------------------------------- */

const uri = (id: number): string => `/api/v1/categoria/${String(id)}`;

/** One store category of the job's map: its parent (`null` = a root), its ERP side. */
function cat(
  id: number,
  pai: number | null | 'ilegivel',
  over: {
    nome?: string;
    vinculo?: VinculoCategoriaImportacaoLi;
    erpCategoriaId?: string | null;
  } = {},
): CategoriaDoJobLi {
  const vinculo =
    over.vinculo ??
    (over.erpCategoriaId ? VINCULO_CATEGORIA_IMPORTACAO_LI.vinculada : undefined) ??
    VINCULO_CATEGORIA_IMPORTACAO_LI.semVinculo;
  return {
    id,
    nome: over.nome ?? `Cat${String(id)}`,
    pai:
      pai === null
        ? { tipo: 'raiz' }
        : pai === 'ilegivel'
          ? { tipo: 'ilegivel' }
          : { tipo: 'id', id: pai },
    erpCategoriaId: over.erpCategoriaId ?? null,
    vinculo,
  };
}

function deps(db: FakeDb, over: Partial<DepsCategoriasLi> = {}): DepsCategoriasLi {
  return {
    db: asDb(db),
    contaId: CONTA,
    modo: MODO_IMPORTACAO_LI.aplicar,
    categorias: CATEGORIAS_IMPORTACAO_LI.criarEVincular,
    agoraMs: () => AGORA_MS,
    ...over,
  };
}

const caminhoCategoria = (id: string) => `categorias/${id}`;
const caminhoVinculo = (categoriaId: string, docId: string) =>
  `categorias/${categoriaId}/categorialojaintegrada/${docId}`;
const ref = (conta = CONTA) => `documents/integracao/${conta}`;

/** An ERP categoria as the web saves one. */
function seedCategoriaErp(
  db: FakeDb,
  id: string,
  nome: string,
  nomeCompleto: string | null = nome,
): void {
  db.seed(caminhoCategoria(id), {
    nome,
    nomeCompleto,
    permiteCadastro: true,
    categoriaGoogleId: null,
    categoriaPaiOuterRef: null,
    timestamp: AGORA_MS,
    ultimaModificacao: AGORA_MS,
  });
}

function recusada(c: CategoriaDoProdutoLi) {
  if (c.tipo !== TIPO_CATEGORIA_DO_PRODUTO_LI.recusada) {
    throw new Error(`esperava uma recusa, veio ${c.tipo}`);
  }
  return c;
}

function resolvida(c: CategoriaDoProdutoLi) {
  if (c.tipo !== TIPO_CATEGORIA_DO_PRODUTO_LI.resolvida) {
    throw new Error(`esperava uma categoria, veio ${c.tipo}`);
  }
  return c;
}

const entradas = (mapa: readonly CategoriaDoJobLi[], id: number) => mapa.filter((c) => c.id === id);

/* ------------------------------ the ids ----------------------------------- */

describe('the deterministic ids', () => {
  it('categoria li-<conta>-<store id>, its link <conta>-<store id>', () => {
    expect(idCategoriaCriadaLi('C1', 7645875)).toBe('li-C1-7645875');
    expect(idVinculoCategoriaCriadoLi('C1', 7645875)).toBe('C1-7645875');
  });

  it('NEAR-MISS: another conta or another store id is another id — never one doc for two', () => {
    expect(idCategoriaCriadaLi('C2', 7645875)).not.toBe(idCategoriaCriadaLi('C1', 7645875));
    expect(idCategoriaCriadaLi('C1', 7645876)).not.toBe(idCategoriaCriadaLi('C1', 7645875));
    // A conta id may hold a dash; the store id is digits and comes last, so the pair is unique.
    expect(idCategoriaCriadaLi('a-1', 2)).not.toBe(idCategoriaCriadaLi('a', 12));
  });

  it('an id that cannot be one throws (both come from parsed input)', () => {
    expect(() => idCategoriaCriadaLi('', 1)).toThrow(RangeError);
    expect(() => idCategoriaCriadaLi('a/b', 1)).toThrow(RangeError);
    expect(() => idCategoriaCriadaLi('C1', 0)).toThrow(RangeError);
    expect(() => idVinculoCategoriaCriadoLi('C1', 1.5)).toThrow(RangeError);
  });
});

/* ------------------------------- the leaf --------------------------------- */

describe('the leaf', () => {
  it('a LINKED leaf ⇒ its ERP categoria, with ZERO reads and ZERO writes; the map unchanged', async () => {
    const db = new FakeDb();
    const mapa = [cat(1, null), cat(2, 1, { erpCategoriaId: 'erp-2' })];
    const r = await resolverCategoriaDoProdutoLi(deps(db), mapa, [uri(1), uri(2)]);
    expect(r.categoria).toEqual({
      tipo: 'resolvida',
      categoriaLiId: 2,
      erpCategoriaId: 'erp-2',
      criadas: [],
      criadaPelaImportacao: false,
    });
    expect(r.mapaCategorias).toEqual(mapa);
    expect(db.leituras).toEqual([]);
    expect(db.consultas).toEqual([]);
    expect(db.escritas).toEqual([]);
  });

  it('a linked leaf that an import created (li-<conta>-<id>) is flagged for the tax review ⟷ NEAR-MISS a hand-made one is not', async () => {
    const db = new FakeDb();
    const importada = await resolverCategoriaDoProdutoLi(
      deps(db),
      [cat(5, null, { erpCategoriaId: idCategoriaCriadaLi(CONTA, 5) })],
      [uri(5)],
    );
    expect(resolvida(importada.categoria).criadaPelaImportacao).toBe(true);
    const aMao = await resolverCategoriaDoProdutoLi(
      deps(db),
      [cat(5, null, { erpCategoriaId: 'feita-a-mao' })],
      [uri(5)],
    );
    expect(resolvida(aMao.categoria).criadaPelaImportacao).toBe(false);
    // Another conta's import id is not this conta's import.
    const deOutra = await resolverCategoriaDoProdutoLi(
      deps(db),
      [cat(5, null, { erpCategoriaId: idCategoriaCriadaLi(OUTRA, 5) })],
      [uri(5)],
    );
    expect(resolvida(deOutra.categoria).criadaPelaImportacao).toBe(false);
  });

  it('a `simulada` entry counts as linked: it resolves to the id `aplicar` would have created', async () => {
    const db = new FakeDb();
    const r = await resolverCategoriaDoProdutoLi(
      deps(db, { modo: MODO_IMPORTACAO_LI.simular }),
      [
        cat(5, null, {
          vinculo: VINCULO_CATEGORIA_IMPORTACAO_LI.simulada,
          erpCategoriaId: idCategoriaCriadaLi(CONTA, 5),
        }),
      ],
      [uri(5)],
    );
    expect(resolvida(r.categoria)).toMatchObject({
      erpCategoriaId: idCategoriaCriadaLi(CONTA, 5),
      criadas: [],
      criadaPelaImportacao: true,
    });
  });

  it('no category in the store ⇒ nenhuma, nothing read', async () => {
    const db = new FakeDb();
    const r = await resolverCategoriaDoProdutoLi(deps(db), [cat(1, null)], []);
    expect(r.categoria).toEqual({ tipo: 'nenhuma' });
    expect(db.leituras).toEqual([]);
  });

  it('an unreadable category URI ⇒ categoria-recusada, no aviso, nothing written', async () => {
    const db = new FakeDb();
    const r = await resolverCategoriaDoProdutoLi(
      deps(db),
      [cat(1, null)],
      [uri(1), '/api/v1/categoria/None'],
    );
    expect(recusada(r.categoria)).toMatchObject({
      pendencia: PENDENCIA_IMPORTACAO_LI.categoriaRecusada,
      referencias: ['ilegivel'],
      aviso: null,
    });
    expect(db.escritas).toEqual([]);
  });

  it('two unlinked leaves ⇒ categoria-ambigua (never a guess, never created)', async () => {
    const db = new FakeDb();
    const r = await resolverCategoriaDoProdutoLi(
      deps(db),
      [cat(1, null), cat(2, null)],
      [uri(1), uri(2)],
    );
    expect(recusada(r.categoria)).toMatchObject({
      pendencia: PENDENCIA_IMPORTACAO_LI.categoriaAmbigua,
      referencias: ['1', '2'],
    });
    expect(db.escritas).toEqual([]);
  });

  it('a linked leaf beside an unlinked one (a promotion branch) ⇒ the linked one ⟷ NEAR-MISS beside an AMBIGUOUS one ⇒ categoria-ambigua (fail closed)', async () => {
    const db = new FakeDb();
    const comLivre = await resolverCategoriaDoProdutoLi(
      deps(db),
      [cat(1, null, { erpCategoriaId: 'erp-1' }), cat(2, null)],
      [uri(1), uri(2)],
    );
    expect(resolvida(comLivre.categoria).erpCategoriaId).toBe('erp-1');

    const comAmbigua = await resolverCategoriaDoProdutoLi(
      deps(db),
      [
        cat(1, null, { erpCategoriaId: 'erp-1' }),
        cat(2, null, { vinculo: VINCULO_CATEGORIA_IMPORTACAO_LI.ambigua }),
      ],
      [uri(1), uri(2)],
    );
    expect(recusada(comAmbigua.categoria).pendencia).toBe(PENDENCIA_IMPORTACAO_LI.categoriaAmbigua);
  });

  it('the one leaf AMBIGUOUS in the map (two ERP categorias claim it) ⇒ categoria-ambigua, never created', async () => {
    const db = new FakeDb();
    const r = await resolverCategoriaDoProdutoLi(
      deps(db),
      [cat(3, null, { vinculo: VINCULO_CATEGORIA_IMPORTACAO_LI.ambigua })],
      [uri(3)],
    );
    expect(recusada(r.categoria)).toMatchObject({
      pendencia: PENDENCIA_IMPORTACAO_LI.categoriaAmbigua,
      referencias: ['3'],
    });
    expect(db.escritas).toEqual([]);
  });
});

/* ------------------------------- soVincular -------------------------------- */

describe('categories `soVincular`: nothing is ever created', () => {
  it('an unlinked leaf ⇒ categoria-sem-vinculo, the aviso’s path root first, ZERO writes', async () => {
    const db = new FakeDb();
    const r = await resolverCategoriaDoProdutoLi(
      deps(db, { categorias: CATEGORIAS_IMPORTACAO_LI.soVincular }),
      [cat(1, null), cat(2, 1), cat(3, 2)],
      [uri(1), uri(2), uri(3)],
    );
    expect(r.categoria).toEqual({
      tipo: 'recusada',
      pendencia: PENDENCIA_IMPORTACAO_LI.categoriaSemVinculo,
      referencias: ['3'],
      aviso: {
        categoriaLiId: 3,
        caminho: [1, 2, 3],
        motivo: MOTIVO_CATEGORIA_SEM_VINCULO_LI.semVinculo,
      },
      criadas: [],
    });
    expect(db.escritas).toEqual([]);
    expect(db.leituras).toEqual([]);
  });

  it('a category the store’s list does not hold ⇒ categoria-recusada (ausente), NO aviso — under either option', async () => {
    for (const categorias of Object.values(CATEGORIAS_IMPORTACAO_LI)) {
      const db = new FakeDb();
      const r = await resolverCategoriaDoProdutoLi(
        deps(db, { categorias }),
        [cat(1, null)],
        [uri(99)],
      );
      expect(recusada(r.categoria)).toMatchObject({
        pendencia: PENDENCIA_IMPORTACAO_LI.categoriaRecusada,
        referencias: ['99', 'ausente'],
        aviso: null,
      });
      expect(db.escritas).toEqual([]);
    }
  });
});

/* ---------------------------- create and link ------------------------------ */

describe('criarEVincular: the breadcrumb is the ERP parent’s own', () => {
  it("PAIR: 'Z' under an ERP parent whose nomeCompleto is 'X > Y' ⇒ 'X > Y > Z' ⟷ NEAR-MISS the store's names joined ('A > B > Z') are never written", async () => {
    const db = new FakeDb();
    seedCategoriaErp(db, 'erp-y', 'Y', 'X > Y');
    const mapa = [
      cat(10, null, { nome: 'A' }),
      cat(11, 10, { nome: 'B', erpCategoriaId: 'erp-y' }),
      cat(12, 11, { nome: 'Z' }),
    ];
    const r = await resolverCategoriaDoProdutoLi(deps(db), mapa, [uri(10), uri(11), uri(12)]);

    const id = idCategoriaCriadaLi(CONTA, 12);
    expect(r.categoria).toEqual({
      tipo: 'resolvida',
      categoriaLiId: 12,
      erpCategoriaId: id,
      criadas: [12],
      criadaPelaImportacao: true,
    });
    expect(db.ler(caminhoCategoria(id))).toEqual({
      nome: 'Z',
      nomeCompleto: 'X > Y > Z',
      permiteCadastro: true,
      categoriaGoogleId: null,
      categoriaPaiOuterRef: 'documents/categorias/erp-y',
      timestamp: AGORA_MS,
      ultimaModificacao: AGORA_MS,
    });
    expect(db.ler(caminhoVinculo(id, idVinculoCategoriaCriadoLi(CONTA, 12)))).toEqual({
      id: '12',
      nome: 'Z',
      contaLojaIntegrada: ref(),
    });
    // NEAR-MISS: the store's own path never reaches a document.
    for (const e of db.escritas) expect(JSON.stringify(e.dados)).not.toContain('A > B');
    // Decided 2026-11-06: the category above the linked one is not created (no product of this call
    // sits in it).
    expect(db.ler(caminhoCategoria(idCategoriaCriadaLi(CONTA, 10)))).toBeUndefined();
    // The map: the created one is linked now; the others untouched.
    expect(entradas(r.mapaCategorias, 12)).toEqual([
      { ...mapa[2]!, vinculo: VINCULO_CATEGORIA_IMPORTACAO_LI.vinculada, erpCategoriaId: id },
    ]);
    expect(entradas(r.mapaCategorias, 10)).toEqual([mapa[0]]);
  });

  it('an ERP parent with no breadcrumb yet (an older document) lends its name — the shared helper’s fallback', async () => {
    const db = new FakeDb();
    seedCategoriaErp(db, 'erp-y', 'Y', null);
    const r = await resolverCategoriaDoProdutoLi(
      deps(db),
      [cat(11, null, { erpCategoriaId: 'erp-y' }), cat(12, 11, { nome: 'Z' })],
      [uri(12)],
    );
    const id = resolvida(r.categoria).erpCategoriaId;
    expect(db.ler(caminhoCategoria(id))?.nomeCompleto).toBe('Y > Z');
  });

  it('no linked ancestor: ROOT-MOST FIRST, each under the one just created, the leaf last', async () => {
    const db = new FakeDb();
    const mapa = [
      cat(20, null, { nome: 'R' }),
      cat(21, 20, { nome: 'S' }),
      cat(22, 21, { nome: 'T' }),
    ];
    const r = await resolverCategoriaDoProdutoLi(deps(db), mapa, [uri(22)]);
    const [r20, r21, r22] = [20, 21, 22].map((i) => idCategoriaCriadaLi(CONTA, i));
    expect(resolvida(r.categoria)).toMatchObject({ erpCategoriaId: r22, criadas: [20, 21, 22] });
    expect(db.escritas.map((e) => [e.verbo, e.caminho])).toEqual([
      ['create', caminhoCategoria(r20!)],
      ['create', caminhoVinculo(r20!, `${CONTA}-20`)],
      ['create', caminhoCategoria(r21!)],
      ['create', caminhoVinculo(r21!, `${CONTA}-21`)],
      ['create', caminhoCategoria(r22!)],
      ['create', caminhoVinculo(r22!, `${CONTA}-22`)],
    ]);
    expect(db.ler(caminhoCategoria(r20!))).toMatchObject({
      nomeCompleto: 'R',
      categoriaPaiOuterRef: null,
    });
    expect(db.ler(caminhoCategoria(r21!))).toMatchObject({
      nomeCompleto: 'R > S',
      categoriaPaiOuterRef: `documents/categorias/${r20!}`,
    });
    expect(db.ler(caminhoCategoria(r22!))).toMatchObject({
      nomeCompleto: 'R > S > T',
      categoriaPaiOuterRef: `documents/categorias/${r21!}`,
    });
    for (const i of [20, 21, 22]) {
      expect(entradas(r.mapaCategorias, i)[0]).toMatchObject({
        vinculo: VINCULO_CATEGORIA_IMPORTACAO_LI.vinculada,
        erpCategoriaId: idCategoriaCriadaLi(CONTA, i),
      });
    }
  });

  it('a LATER product of the same job meets the categories through the map: resolved, nothing written again', async () => {
    const db = new FakeDb();
    const mapa = [cat(20, null, { nome: 'R' }), cat(21, 20, { nome: 'S' })];
    const primeiro = await resolverCategoriaDoProdutoLi(deps(db), mapa, [uri(21)]);
    const escritas = db.escritas.length;
    const segundo = await resolverCategoriaDoProdutoLi(deps(db), primeiro.mapaCategorias, [
      uri(20),
    ]);
    expect(segundo.categoria).toEqual({
      tipo: 'resolvida',
      categoriaLiId: 20,
      erpCategoriaId: idCategoriaCriadaLi(CONTA, 20),
      criadas: [],
      criadaPelaImportacao: true,
    });
    expect(db.escritas).toHaveLength(escritas);
  });

  it('a category under one this job just created takes the created one’s breadcrumb', async () => {
    const db = new FakeDb();
    seedCategoriaErp(db, 'erp-x', 'X', 'Loja > X');
    const mapa = [
      cat(1, null, { erpCategoriaId: 'erp-x' }),
      cat(2, 1, { nome: 'P' }),
      cat(3, 2, { nome: 'Q' }),
    ];
    const primeiro = await resolverCategoriaDoProdutoLi(deps(db), mapa, [uri(2)]);
    await resolverCategoriaDoProdutoLi(deps(db), primeiro.mapaCategorias, [uri(3)]);
    expect(db.ler(caminhoCategoria(idCategoriaCriadaLi(CONTA, 3)))).toMatchObject({
      nomeCompleto: 'Loja > X > P > Q',
      categoriaPaiOuterRef: `documents/categorias/${idCategoriaCriadaLi(CONTA, 2)}`,
    });
  });

  it('two contas’ runs over one store name create TWO categorias, each with its own conta’s link', async () => {
    const db = new FakeDb();
    const mapa = [cat(30, null, { nome: 'Camisetas' })];
    const c1 = await resolverCategoriaDoProdutoLi(deps(db), mapa, [uri(30)]);
    const c2 = await resolverCategoriaDoProdutoLi(deps(db, { contaId: OUTRA }), mapa, [uri(30)]);
    const id1 = resolvida(c1.categoria).erpCategoriaId;
    const id2 = resolvida(c2.categoria).erpCategoriaId;
    expect(id1).toBe(idCategoriaCriadaLi(CONTA, 30));
    expect(id2).toBe(idCategoriaCriadaLi(OUTRA, 30));
    expect(id1).not.toBe(id2);
    expect(db.ler(caminhoVinculo(id1, `${CONTA}-30`))?.contaLojaIntegrada).toBe(ref(CONTA));
    expect(db.ler(caminhoVinculo(id2, `${OUTRA}-30`))?.contaLojaIntegrada).toBe(ref(OUTRA));
  });
});

describe('criarEVincular: refusals', () => {
  it('a chain whose ancestor’s parent is unreadable ⇒ categoria-recusada (pai-ilegivel) + its aviso, NOTHING created — never a root', async () => {
    const db = new FakeDb();
    const r = await resolverCategoriaDoProdutoLi(
      deps(db),
      [cat(1, 'ilegivel'), cat(2, 1)],
      [uri(2)],
    );
    expect(r.categoria).toEqual({
      tipo: 'recusada',
      pendencia: PENDENCIA_IMPORTACAO_LI.categoriaRecusada,
      referencias: ['2', 'pai-ilegivel'],
      aviso: {
        categoriaLiId: 2,
        caminho: [2],
        motivo: MOTIVO_CATEGORIA_SEM_VINCULO_LI.paiIlegivel,
      },
      criadas: [],
    });
    expect(db.escritas).toEqual([]);
  });

  it('a parent the store’s list lacks ⇒ pai-ausente; a cycle ⇒ ciclo — each with its aviso, nothing created', async () => {
    const db = new FakeDb();
    const ausente = await resolverCategoriaDoProdutoLi(deps(db), [cat(2, 77)], [uri(2)]);
    expect(recusada(ausente.categoria)).toMatchObject({
      referencias: ['2', 'pai-ausente'],
      aviso: { motivo: MOTIVO_CATEGORIA_SEM_VINCULO_LI.paiAusente },
    });
    // 3 sits BELOW the cycle 1 ⇄ 2: it can be the leaf, and its chain read refuses it.
    const ciclo = await resolverCategoriaDoProdutoLi(
      deps(db),
      [cat(1, 2), cat(2, 1), cat(3, 2)],
      [uri(3)],
    );
    expect(recusada(ciclo.categoria)).toMatchObject({
      pendencia: PENDENCIA_IMPORTACAO_LI.categoriaRecusada,
      referencias: ['3', 'ciclo'],
      aviso: { motivo: MOTIVO_CATEGORIA_SEM_VINCULO_LI.ciclo },
    });
    expect(db.escritas).toEqual([]);
  });

  it('an AMBIGUOUS ancestor between the leaf and any linked one ⇒ categoria-ambigua naming it, nothing created', async () => {
    const db = new FakeDb();
    seedCategoriaErp(db, 'erp-1', 'Um');
    const r = await resolverCategoriaDoProdutoLi(
      deps(db),
      [
        cat(1, null, { erpCategoriaId: 'erp-1' }),
        cat(2, 1, { vinculo: VINCULO_CATEGORIA_IMPORTACAO_LI.ambigua }),
        cat(3, 2),
      ],
      [uri(3)],
    );
    expect(recusada(r.categoria)).toMatchObject({
      pendencia: PENDENCIA_IMPORTACAO_LI.categoriaAmbigua,
      referencias: ['2'],
    });
    expect(db.escritas).toEqual([]);
  });

  it('an empty store name ⇒ dado-invalido naming the categoria’s field, NOTHING of it or below it written', async () => {
    const db = new FakeDb();
    const r = await resolverCategoriaDoProdutoLi(
      deps(db),
      [cat(1, null, { nome: '' }), cat(2, 1, { nome: 'Filha' })],
      [uri(2)],
    );
    expect(recusada(r.categoria)).toMatchObject({
      pendencia: PENDENCIA_IMPORTACAO_LI.dadoInvalido,
      referencias: ['categoria.nome'],
      criadas: [],
    });
    expect(db.escritas).toEqual([]);
  });

  it('a name over 255 ⇒ dado-invalido (categoria.nome) ⟷ NEAR-MISS exactly 255 is created', async () => {
    const db = new FakeDb();
    const longo = await resolverCategoriaDoProdutoLi(
      deps(db),
      [cat(1, null, { nome: 'n'.repeat(256) })],
      [uri(1)],
    );
    expect(recusada(longo.categoria).referencias).toEqual(['categoria.nome']);
    const noLimite = await resolverCategoriaDoProdutoLi(
      deps(db),
      [cat(2, null, { nome: 'n'.repeat(255) })],
      [uri(2)],
    );
    expect(resolvida(noLimite.categoria).criadas).toEqual([2]);
  });

  it('a refusal after a create keeps what it created: the map holds it, and the result names it', async () => {
    const db = new FakeDb();
    const r = await resolverCategoriaDoProdutoLi(
      deps(db),
      [cat(1, null, { nome: 'Pai' }), cat(2, 1, { nome: '' })],
      [uri(2)],
    );
    expect(recusada(r.categoria)).toMatchObject({
      pendencia: PENDENCIA_IMPORTACAO_LI.dadoInvalido,
      referencias: ['categoria.nome'],
      criadas: [1],
    });
    expect(entradas(r.mapaCategorias, 1)[0]).toMatchObject({
      vinculo: VINCULO_CATEGORIA_IMPORTACAO_LI.vinculada,
      erpCategoriaId: idCategoriaCriadaLi(CONTA, 1),
    });
    expect(entradas(r.mapaCategorias, 2)[0]?.vinculo).toBe(
      VINCULO_CATEGORIA_IMPORTACAO_LI.semVinculo,
    );
  });

  it('any other Firestore failure propagates (the task retries)', async () => {
    const db = new FakeDb();
    db.falharEscrita(caminhoCategoria(idCategoriaCriadaLi(CONTA, 1)), grpc(14, 'UNAVAILABLE'));
    await expect(
      resolverCategoriaDoProdutoLi(deps(db), [cat(1, null)], [uri(1)]),
    ).rejects.toMatchObject({ code: 14 });
  });
});

describe('criarEVincular: a linked parent that is GONE (the catalogue rule, met late)', () => {
  it('its link is ignored: the walk goes on to the next linked ancestor up, and the map forgets it', async () => {
    const db = new FakeDb();
    seedCategoriaErp(db, 'erp-1', 'Um', 'Um');
    const mapa = [
      cat(1, null, { erpCategoriaId: 'erp-1' }),
      cat(2, 1, { nome: 'Dois', erpCategoriaId: 'erp-sumiu' }),
      cat(3, 2, { nome: 'Tres' }),
    ];
    const r = await resolverCategoriaDoProdutoLi(deps(db), mapa, [uri(3)]);
    expect(resolvida(r.categoria).criadas).toEqual([2, 3]);
    expect(db.ler(caminhoCategoria(idCategoriaCriadaLi(CONTA, 2)))).toMatchObject({
      nomeCompleto: 'Um > Dois',
      categoriaPaiOuterRef: 'documents/categorias/erp-1',
    });
    expect(db.ler(caminhoCategoria(idCategoriaCriadaLi(CONTA, 3)))?.nomeCompleto).toBe(
      'Um > Dois > Tres',
    );
  });
});

/* -------------------------- ALREADY_EXISTS: judged ------------------------- */

describe('criarEVincular: ALREADY_EXISTS is the arbiter — the document at our id is JUDGED', () => {
  const ID = () => idCategoriaCriadaLi(CONTA, 40);

  it('a create that loses to a categoria at our id ADOPTS it — its stored breadcrumb, not ours, is what a child takes', async () => {
    const db = new FakeDb();
    db.antesDaProximaEscrita(caminhoCategoria(ID()), () => {
      seedCategoriaErp(db, ID(), 'Quarenta', 'Editada > Quarenta');
    });
    const r = await resolverCategoriaDoProdutoLi(
      deps(db),
      [cat(40, null, { nome: 'Quarenta' }), cat(41, 40, { nome: 'Filha' })],
      [uri(41)],
    );
    expect(resolvida(r.categoria).criadas).toEqual([40, 41]);
    // The adopted categoria is left as it is; only its link and the child are written.
    expect(db.ler(caminhoCategoria(ID()))?.nomeCompleto).toBe('Editada > Quarenta');
    expect(db.escritas.map((e) => e.caminho)).toEqual([
      caminhoVinculo(ID(), `${CONTA}-40`),
      caminhoCategoria(idCategoriaCriadaLi(CONTA, 41)),
      caminhoVinculo(idCategoriaCriadaLi(CONTA, 41), `${CONTA}-41`),
    ]);
    expect(db.ler(caminhoCategoria(idCategoriaCriadaLi(CONTA, 41)))?.nomeCompleto).toBe(
      'Editada > Quarenta > Filha',
    );
  });

  it('NEAR-MISS: a document at our id that is not a categoria ⇒ dado-invalido naming its fields, no link written', async () => {
    const db = new FakeDb();
    db.seed(caminhoCategoria(ID()), { nome: '' });
    const r = await resolverCategoriaDoProdutoLi(deps(db), [cat(40, null)], [uri(40)]);
    expect(recusada(r.categoria)).toMatchObject({
      pendencia: PENDENCIA_IMPORTACAO_LI.dadoInvalido,
      referencias: ['categoria.nome'],
    });
    expect(db.escritas).toEqual([]);
  });

  it('a link already at our id naming this store category for this conta ⇒ adopted, nothing written over it', async () => {
    const db = new FakeDb();
    seedCategoriaErp(db, ID(), 'Cat40');
    db.seed(caminhoVinculo(ID(), `${CONTA}-40`), {
      id: '40',
      nome: 'antigo',
      contaLojaIntegrada: ref(),
    });
    const r = await resolverCategoriaDoProdutoLi(deps(db), [cat(40, null)], [uri(40)]);
    expect(resolvida(r.categoria).erpCategoriaId).toBe(ID());
    expect(db.escritas).toEqual([]);
    expect(db.ler(caminhoVinculo(ID(), `${CONTA}-40`))?.nome).toBe('antigo');
  });

  it('NEAR-MISS: a link at our id of ANOTHER conta, or naming another store category ⇒ categoria-ambigua', async () => {
    for (const dados of [
      { id: '40', nome: 'x', contaLojaIntegrada: ref(OUTRA) },
      { id: '41', nome: 'x', contaLojaIntegrada: ref() },
      { id: '040', nome: 'x', contaLojaIntegrada: ref() },
    ] satisfies DocData[]) {
      const db = new FakeDb();
      seedCategoriaErp(db, ID(), 'Cat40');
      db.seed(caminhoVinculo(ID(), `${CONTA}-40`), dados);
      const r = await resolverCategoriaDoProdutoLi(
        deps(db),
        [cat(40, null), cat(41, null)],
        [uri(40)],
      );
      expect(recusada(r.categoria)).toMatchObject({
        pendencia: PENDENCIA_IMPORTACAO_LI.categoriaAmbigua,
        referencias: ['40'],
      });
      expect(db.escritas).toEqual([]);
    }
  });

  it('a unit RETRIED from the old map (its creates landed) meets its own documents: the same answer, ZERO new writes', async () => {
    const db = new FakeDb();
    const mapa = [cat(20, null, { nome: 'R' }), cat(21, 20, { nome: 'S' })];
    const primeira = await resolverCategoriaDoProdutoLi(deps(db), mapa, [uri(21)]);
    const escritas = db.escritas.length;
    const retentativa = await resolverCategoriaDoProdutoLi(deps(db), mapa, [uri(21)]);
    expect(retentativa).toEqual(primeira);
    expect(db.escritas).toHaveLength(escritas);
  });
});

/* -------------------------------- Simular ---------------------------------- */

describe('Simular: nothing written, the same verdicts as aplicar (the map overlay)', () => {
  /** A chain of `n` categories 1…n, each named by `nome(i)`. */
  function cadeia(n: number, nome: (i: number) => string): CategoriaDoJobLi[] {
    return Array.from({ length: n }, (_, k) =>
      cat(k + 1, k === 0 ? null : k, { nome: nome(k + 1) }),
    );
  }

  async function correr(
    modo: ModoImportacaoLi,
    mapa: CategoriaDoJobLi[],
    produtos: readonly number[][],
  ) {
    const db = new FakeDb();
    seedCategoriaErp(db, 'erp-raiz', 'Raiz', 'Raiz');
    let m: readonly CategoriaDoJobLi[] = mapa;
    const resultados: CategoriaDoProdutoLi[] = [];
    for (const ids of produtos) {
      const r = await resolverCategoriaDoProdutoLi(deps(db, { modo }), m, ids.map(uri));
      resultados.push(r.categoria);
      m = r.mapaCategorias;
    }
    return { db, resultados, mapa: m };
  }

  it('a category planned for product 1 serves product 2 — and the created ids, refusals and counts match aplicar', async () => {
    const mapa = cadeia(4, (i) => `Nivel${String(i)}`);
    const produtos = [[2], [4], [3], [1]];
    const aplicar = await correr(MODO_IMPORTACAO_LI.aplicar, mapa, produtos);
    const simular = await correr(MODO_IMPORTACAO_LI.simular, mapa, produtos);
    expect(simular.resultados).toEqual(aplicar.resultados);
    expect(simular.db.escritas).toEqual([]);
    expect(aplicar.db.escritas).toHaveLength(8);
    for (const i of [1, 2, 3, 4]) {
      expect(entradas(simular.mapa, i)[0]).toMatchObject({
        vinculo: VINCULO_CATEGORIA_IMPORTACAO_LI.simulada,
        erpCategoriaId: idCategoriaCriadaLi(CONTA, i),
      });
      expect(entradas(aplicar.mapa, i)[0]).toMatchObject({
        vinculo: VINCULO_CATEGORIA_IMPORTACAO_LI.vinculada,
        erpCategoriaId: idCategoriaCriadaLi(CONTA, i),
      });
    }
  });

  it('the breadcrumb a simulated parent lends is the one its create would have stored: PAIR 2,000 characters fits under both modes ⟷ NEAR-MISS 2,001 is dado-invalido under both', async () => {
    // Eight levels of 220 characters (1,781 with the separators) planned by product 1; product 2's
    // ninth level then reaches the 2,000 ceiling exactly (216) or one past it (217).
    for (const [ultimo, cabe] of [
      [216, true],
      [217, false],
    ] as const) {
      const mapa = cadeia(9, (i) => (i === 9 ? 'u'.repeat(ultimo) : `${String(i)}`.repeat(220)));
      const aplicar = await correr(MODO_IMPORTACAO_LI.aplicar, mapa, [[8], [9]]);
      const simular = await correr(MODO_IMPORTACAO_LI.simular, mapa, [[8], [9]]);
      expect(simular.resultados).toEqual(aplicar.resultados);
      const segundo = simular.resultados[1]!;
      if (cabe) {
        expect(resolvida(segundo).criadas).toEqual([9]);
        expect(
          aplicar.db.ler(caminhoCategoria(idCategoriaCriadaLi(CONTA, 9)))?.nomeCompleto,
        ).toHaveLength(2000);
      } else {
        expect(recusada(segundo)).toMatchObject({
          pendencia: PENDENCIA_IMPORTACAO_LI.dadoInvalido,
          referencias: ['categoria.nomeCompleto'],
        });
      }
    }
  });

  it('a categoria already at our id (a link lost, say) is adopted under Simular too: resolved, nothing written', async () => {
    const db = new FakeDb();
    seedCategoriaErp(db, idCategoriaCriadaLi(CONTA, 50), 'Cat50');
    const r = await resolverCategoriaDoProdutoLi(
      deps(db, { modo: MODO_IMPORTACAO_LI.simular }),
      [cat(50, null)],
      [uri(50)],
    );
    expect(resolvida(r.categoria).erpCategoriaId).toBe(idCategoriaCriadaLi(CONTA, 50));
    expect(db.escritas).toEqual([]);
  });

  it('NEAR-MISS: under Simular a foreign link at our id refuses exactly as aplicar would', async () => {
    const db = new FakeDb();
    seedCategoriaErp(db, idCategoriaCriadaLi(CONTA, 50), 'Cat50');
    db.seed(caminhoVinculo(idCategoriaCriadaLi(CONTA, 50), `${CONTA}-50`), {
      id: '50',
      nome: 'x',
      contaLojaIntegrada: ref(OUTRA),
    });
    const r = await resolverCategoriaDoProdutoLi(
      deps(db, { modo: MODO_IMPORTACAO_LI.simular }),
      [cat(50, null)],
      [uri(50)],
    );
    expect(recusada(r.categoria).pendencia).toBe(PENDENCIA_IMPORTACAO_LI.categoriaAmbigua);
    expect(db.escritas).toEqual([]);
  });
});

describe('avisoDaPendenciaDeCategoriaLi: the job-end aviso re-derived from a REPORTED refusal', () => {
  /** Every refusal the resolver can report with (or without) an aviso: the map and the URIs. */
  const casos: readonly [string, Partial<DepsCategoriasLi>, CategoriaDoJobLi[], string[]][] = [
    [
      'soVincular, an unlinked leaf under a root',
      { categorias: CATEGORIAS_IMPORTACAO_LI.soVincular },
      [cat(1, null), cat(2, 1)],
      [uri(1), uri(2)],
    ],
    ['pai-ilegivel', {}, [cat(1, 'ilegivel'), cat(2, 1)], [uri(2)]],
    ['pai-ausente', {}, [cat(2, 77)], [uri(2)]],
    ['ciclo', {}, [cat(1, 2), cat(2, 1), cat(3, 2)], [uri(3)]],
    ['a leaf the store’s list lacks (no aviso)', {}, [cat(1, null)], [uri(9)]],
    ['unreadable URIs (no aviso)', {}, [cat(1, null)], ['/api/v1/categoria/None']],
  ];

  it.each(casos)(
    'PAIR: %s ⇒ exactly the aviso the resolver returned',
    async (_nome, over, mapa, uris) => {
      const r = await resolverCategoriaDoProdutoLi(deps(new FakeDb(), over), mapa, uris);
      const c = recusada(r.categoria);
      expect(
        avisoDaPendenciaDeCategoriaLi(r.mapaCategorias, {
          codigo: c.pendencia,
          referencias: c.referencias,
        }),
      ).toEqual(c.aviso);
    },
  );

  it('NEAR-MISS: another category code, or a first reference that is no canonical store id, gives none', () => {
    const mapa = [cat(1, null), cat(2, 1)];
    expect(
      avisoDaPendenciaDeCategoriaLi(mapa, {
        codigo: PENDENCIA_IMPORTACAO_LI.categoriaAmbigua,
        referencias: ['2'],
      }),
    ).toBeNull();
    for (const primeira of ['02', ' 2', '2.0', 'ilegivel', '']) {
      expect(
        avisoDaPendenciaDeCategoriaLi(mapa, {
          codigo: PENDENCIA_IMPORTACAO_LI.categoriaSemVinculo,
          referencias: [primeira],
        }),
        primeira,
      ).toBeNull();
    }
    expect(
      avisoDaPendenciaDeCategoriaLi(mapa, {
        codigo: PENDENCIA_IMPORTACAO_LI.categoriaSemVinculo,
        referencias: ['2'],
      }),
    ).toEqual({
      categoriaLiId: 2,
      caminho: [1, 2],
      motivo: MOTIVO_CATEGORIA_SEM_VINCULO_LI.semVinculo,
    });
  });
});
