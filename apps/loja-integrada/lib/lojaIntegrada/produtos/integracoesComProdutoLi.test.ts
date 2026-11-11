/**
 * The Loja Integrada binding of the shared `integracoesComProduto` core: what the binding CHOSE —
 * the conta field, the counts predicate, the survivor read it binds and the sentinels. The core's
 * own behaviour (the plan's arms, the NOT_FOUND narrow, the guarded remove) is the core's suite
 * (`packages/data/src/admin/produtos/integracoesComProduto.test.ts`); the conta reader's and the
 * counts predicate's own pairs are `packages/schemas/src/produto/collection/lojaIntegradaLink.test.ts`;
 * the survivor read's own pairs and its unfiltered read are
 * `packages/data/src/admin/produtos/sobreviventesLi.test.ts`. The plan's pairs are repeated HERE
 * through the binding, because a binding that passed another reader would leave all of those
 * suites green.
 *
 * ⚠️ The core's guarded remove runs the multi-document read-and-write API, which this app's fake
 * does not model and which no file of this app may name. So `removerContaSeOrfa` is the ONE stub
 * below — it records what the binding hands it, and the survivor closure is then driven by hand
 * with a read-only `tx` over the fake. Everything else is real: `planLinkChange`,
 * `contaIdFromRef`, `vinculoLiConta`, and `adicionarConta` against the fake. The remove's real
 * run is the emulator suite `functions/src/onProdutoLojaIntegradaLinkChanged.tasks.test.ts`.
 */
import { FieldValue, type Transaction } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SentinelasDeArray } from '@delfrance/data/admin/produtos';
import { contaDoLinkLi as contaDoLinkLiCompartilhado } from '@delfrance/schemas';

import { FakeDb, asDb, type DocData } from '../testing/fakeDb';

const core = vi.hoisted(() => ({
  removerContaSeOrfa: vi.fn(async () => true),
  adicionarConta: vi.fn(),
}));
vi.mock('@delfrance/data/admin/produtos', async (importOriginal) => {
  const real = await importOriginal<typeof import('@delfrance/data/admin/produtos')>();
  // The add stays REAL (it is one `update` the fake models); only the spy records it.
  core.adicionarConta.mockImplementation(real.adicionarConta);
  return { ...real, ...core };
});

const { adicionarContaLi, contaDoLinkLi, planejarMudancaDeLinkLi, removerContaLiSeOrfa } =
  await import('./integracoesComProdutoLi');

/* ---------------------------------- fixtures ------------------------------ */

const PRODUTO = 'produto-li-1';
const C1 = 'C1';
const C2 = 'C2';
/** The spec's public example produto id. */
const ID_LI = 182904918;
const CAMPO = 'integracoesComProduto';
const NADA = { add: [], check: [] };

/** A counting link of conta {@link C1}: a store product id, not in the trash. */
function link(over: DocData = {}): DocData {
  return {
    contaLojaIntegrada: `documents/integracao/${C1}`,
    id: ID_LI,
    sku: 'SKU-TESTE-1',
    nome: 'Produto de teste',
    ativo: true,
    bloqueado: false,
    removido: false,
    ...over,
  };
}

function semearLink(db: FakeDb, id: string, over: DocData = {}, produto = PRODUTO): void {
  db.seed(`produtos/${produto}/produtolojaintegrada/${id}`, link(over));
}

/**
 * A read-only `tx`, enough for a survivor closure — which only reads. Hand-built: this app's
 * fake models no multi-document read-and-write call, and no file here may name one.
 */
function txLeitura(): Transaction {
  return {
    get: (alvo: { get: () => Promise<unknown> }) => alvo.get(),
  } as unknown as Transaction;
}

/** The arguments the binding handed the core's remove, named by position. */
function chamadaDoRemove(): {
  produtoId: string;
  contaId: string;
  sobrevivem: (tx: Transaction) => Promise<boolean>;
  sentinelas: SentinelasDeArray;
} {
  const chamada = core.removerContaSeOrfa.mock.calls.at(-1) as unknown as
    | [unknown, string, string, (tx: Transaction) => Promise<boolean>, SentinelasDeArray]
    | undefined;
  if (chamada === undefined) throw new Error('teste: removerContaSeOrfa não foi chamado');
  const [, produtoId, contaId, sobrevivem, sentinelas] = chamada;
  return { produtoId, contaId, sobrevivem, sentinelas };
}

beforeEach(() => {
  core.removerContaSeOrfa.mockClear();
  core.adicionarConta.mockClear();
});

/* -------------------------------------------------------------------------- */
/*                    (1) contaDoLinkLi — the conta, by its field               */
/* -------------------------------------------------------------------------- */

describe('contaDoLinkLi', () => {
  it('⛔ re-exports the ONE shared reader — never a local copy', () => {
    // Its pairs and near-misses live with it (`lojaIntegradaLink.test.ts`). A local
    // re-implementation here would leave that suite green while it drifted, so the binding's
    // export must BE the shared function.
    expect(contaDoLinkLi).toBe(contaDoLinkLiCompartilhado);
  });

  it('⛔ reads contaLojaIntegrada and no other channel’s field: such a link plans NOTHING', () => {
    // One identifier apart from correct, at BOTH altitudes: the fold, and the plan built on it.
    // A binding reading another channel's field compiles and turns the trigger into a silent no-op.
    for (const campo of ['contaOuterRef', 'contaProdutoShopeeOuterRef']) {
      const comOutroCampo = { [campo]: `documents/integracao/${C1}`, id: ID_LI };
      expect(contaDoLinkLi(comOutroCampo), campo).toBeNull();
      expect(planejarMudancaDeLinkLi(null, comOutroCampo), campo).toEqual(NADA);
    }
    // ÂNCORA: the same body under the right field does plan.
    expect(
      planejarMudancaDeLinkLi(null, { contaLojaIntegrada: `integracao/${C1}`, id: ID_LI }),
    ).toEqual({ add: [C1], check: [] });
  });

  it('⛔ a raw document never makes it throw — nor the plan built on it', () => {
    // Both are handed `event.data.after.data()`, whatever is on disk; a throw inside the trigger's
    // zero-read fast path would ride the Eventarc redelivery for ever.
    for (const bruto of [
      {},
      { contaLojaIntegrada: { caminho: 'integracao/C1' } },
      { contaLojaIntegrada: ['integracao/C1'] },
      { contaLojaIntegrada: `documents/integracao/${C1}`, id: { valor: 1 } },
      { contaLojaIntegrada: `documents/integracao/${C1}`, removido: 'sim' },
    ]) {
      expect(() => contaDoLinkLi(bruto)).not.toThrow();
      expect(() => planejarMudancaDeLinkLi(bruto, bruto)).not.toThrow();
      expect(() => planejarMudancaDeLinkLi(null, bruto)).not.toThrow();
    }
  });
});

/* -------------------------------------------------------------------------- */
/*            (2) planejarMudancaDeLinkLi — the counts pairs and the arms        */
/* -------------------------------------------------------------------------- */

describe('planejarMudancaDeLinkLi — what counts (the anchor pairs)', () => {
  it.each([
    ['{ id: 182904918, removido: false }', { id: ID_LI, removido: false }],
    ['a hidden one, ativo: false', { id: ID_LI, removido: false, ativo: false }],
    ['a blocked one, bloqueado: true', { id: ID_LI, removido: false, bloqueado: true }],
    ["the id as its decimal text, '182904918'", { id: '182904918' }],
    ['no removido field at all', { removido: undefined }],
    ['a publication code that is not published', { estadoPublicacao: 'pa' }],
  ])('COUNTS — %s: its create ADDS the conta', (_caso, over) => {
    const corpo = Object.fromEntries(Object.entries(link(over)).filter(([, v]) => v !== undefined));
    expect(planejarMudancaDeLinkLi(null, corpo)).toEqual({ add: [C1], check: [] });
  });

  it.each([
    ['in the trash, removido: true', { removido: true }],
    ['id: null', { id: null }],
    ['id: 0', { id: 0 }],
    ["id: '07' (not canonical)", { id: '07' }],
    ['id: -1', { id: -1 }],
    ['id: 1.5', { id: 1.5 }],
  ])('does NOT count — %s: its create costs nothing', (_caso, over) => {
    expect(planejarMudancaDeLinkLi(null, link(over))).toEqual(NADA);
  });
});

describe('planejarMudancaDeLinkLi — the arms of one write', () => {
  it('create ⇒ add; delete ⇒ check', () => {
    expect(planejarMudancaDeLinkLi(null, link())).toEqual({ add: [C1], check: [] });
    expect(planejarMudancaDeLinkLi(link(), null)).toEqual({ add: [], check: [C1] });
  });

  it('removido flipped to true ⇒ check; flipped back ⇒ add (it counts again)', () => {
    expect(planejarMudancaDeLinkLi(link(), link({ removido: true }))).toEqual({
      add: [],
      check: [C1],
    });
    expect(planejarMudancaDeLinkLi(link({ removido: true }), link())).toEqual({
      add: [C1],
      check: [],
    });
  });

  it('a conta change ADDS the new conta and CHECKS the old one', () => {
    expect(
      planejarMudancaDeLinkLi(link(), link({ contaLojaIntegrada: `documents/integracao/${C2}` })),
    ).toEqual({ add: [C2], check: [C1] });
  });

  it('EQUAL: a ref rewritten from one stored form to the other is the same conta ⇒ nothing', () => {
    expect(
      planejarMudancaDeLinkLi(link(), link({ contaLojaIntegrada: `integracao/${C1}` })),
    ).toEqual(NADA);
  });

  it('an id change between two store product ids moves no membership ⇒ nothing', () => {
    expect(planejarMudancaDeLinkLi(link(), link({ id: ID_LI + 1 }))).toEqual(NADA);
  });

  it('an id that stops naming a store product ⇒ check; one that starts ⇒ add', () => {
    expect(planejarMudancaDeLinkLi(link(), link({ id: null }))).toEqual({ add: [], check: [C1] });
    expect(planejarMudancaDeLinkLi(link({ id: null }), link())).toEqual({ add: [C1], check: [] });
  });

  it.each([
    ['nome', { nome: 'Outro nome' }],
    ['the mirror fields ativo and bloqueado', { ativo: false, bloqueado: true }],
    ['sku and the URIs', { sku: 'SKU-2', categorias: ['/api/v1/categoria/1'] }],
    ['estadoPublicacao', { estadoPublicacao: 'p' }],
  ])('an edit of %s moves nothing ⇒ ZERO-cost plan', (_campo, over) => {
    expect(planejarMudancaDeLinkLi(link(), link(over))).toEqual(NADA);
  });

  it('a link that never counted, edited or deleted, checks nothing (it was never the last one)', () => {
    const naLixeira = link({ removido: true });
    expect(planejarMudancaDeLinkLi(naLixeira, { ...naLixeira, nome: 'x' })).toEqual(NADA);
    expect(planejarMudancaDeLinkLi(naLixeira, null)).toEqual(NADA);
  });
});

/* -------------------------------------------------------------------------- */
/*                 (3) the two writers — what the binding hands the core          */
/* -------------------------------------------------------------------------- */

describe('adicionarContaLi', () => {
  it('hands the core the produto, the conta and the arrayUnion sentinel under arrayUnion', async () => {
    const db = new FakeDb();
    db.seed(`produtos/${PRODUTO}`, { nome: 'Produto de teste' });

    await expect(adicionarContaLi(asDb(db), PRODUTO, C1)).resolves.toBe(true);

    const [, produtoId, contaId, sentinelas] = core.adicionarConta.mock.calls[0] as [
      unknown,
      string,
      string,
      SentinelasDeArray,
    ];
    expect([produtoId, contaId]).toEqual([PRODUTO, C1]);
    // ⛔ The keys are NAMED so a swap is written on purpose: the ADD path's union must be a
    // union, never a remove.
    const uniao = sentinelas.arrayUnion(C1) as FieldValue;
    expect(uniao.isEqual(FieldValue.arrayUnion(C1))).toBe(true);
    expect(uniao.isEqual(FieldValue.arrayRemove(C1))).toBe(false);
    // The real core wrote ONE update on the produto, and only the array key.
    expect(db.escritas.map((e) => [e.verbo, e.caminho, Object.keys(e.dados ?? {})])).toEqual([
      ['update', `produtos/${PRODUTO}`, [CAMPO]],
    ]);
  });

  it('a produto that is gone answers false and writes nothing (never a husk)', async () => {
    const db = new FakeDb();

    await expect(adicionarContaLi(asDb(db), PRODUTO, C1)).resolves.toBe(false);
    expect(db.escritas).toEqual([]);
  });
});

describe('removerContaLiSeOrfa', () => {
  it('hands the core the produto, the conta, ITS survivor reader and the arrayRemove sentinel', async () => {
    const db = new FakeDb();

    await expect(removerContaLiSeOrfa(asDb(db), PRODUTO, C1)).resolves.toBe(true);

    const { produtoId, contaId, sobrevivem, sentinelas } = chamadaDoRemove();
    expect([produtoId, contaId]).toEqual([PRODUTO, C1]);
    const remocao = sentinelas.arrayRemove(C1) as FieldValue;
    expect(remocao.isEqual(FieldValue.arrayRemove(C1))).toBe(true);
    expect(remocao.isEqual(FieldValue.arrayUnion(C1))).toBe(false);

    // ⚠️ And the closure really is THIS binding's reader, bound to the path's produto and this
    // conta: `expect.any(Function)` would accept a closure bound to another produto, which would
    // conclude "no survivors" and drop a live conta.
    semearLink(db, 'l1', { contaLojaIntegrada: `documents/integracao/${C2}` });
    await expect(sobrevivem(txLeitura())).resolves.toBe(false);
    semearLink(db, 'l2');
    await expect(sobrevivem(txLeitura())).resolves.toBe(true);
    expect(db.consultas.map((c) => c.colecao)).toEqual([
      `produtos/${PRODUTO}/produtolojaintegrada`,
      `produtos/${PRODUTO}/produtolojaintegrada`,
    ]);
    // The binding itself wrote nothing: the guarded write is the core's.
    expect(db.escritas).toEqual([]);
  });
});
