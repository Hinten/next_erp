import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import {
  MOTIVO_RESOLUCAO_RECEITA_KIT,
  chaveReceitaKitErp,
  linhaVariacaoDeKit,
  toOuterRef,
} from '@delfrance/schemas';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The produto half of the Shopee native-kit recipe aviso (step 19, #1527): the
 * GATE and the WIRING only. The open/resolve decision itself is the shared
 * `reavaliarAvisoDeReceitaKit`, pinned over a real chain in the Shopee app's
 * `produtos/reavaliarAvisoReceitaKit.test.ts`; here it is a recorder, so every
 * assertion is about what THIS module reads and which (conta, kit) pairs it hands
 * over. The decision over a real Firestore is the emulator half,
 * `onProdutoChanged.storage.test.ts`.
 *
 * Rows are seeded through the schemas' own `linhaVariacaoDeKit` — the builder the
 * kit arms write with — so a row here has the shape a real kit create leaves.
 */

const m = vi.hoisted(() => ({
  reavaliar: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('firebase-functions', () => ({
  logger: { warn: m.warn, error: m.error, info: vi.fn() },
}));
vi.mock('@delfrance/data/admin/avisos', async (original) => ({
  ...(await original<typeof import('@delfrance/data/admin/avisos')>()),
  reavaliarAvisoDeReceitaKit: m.reavaliar,
}));

const { avisarReceitaKitShopee, receitaKitMudou } = await import('./avisoReceitaKitShopee');

/* -------------------------------------------------------------------------- */
/*                                  fixtures                                  */
/* -------------------------------------------------------------------------- */

const K = 'kit-k';
const C1 = 'filho-c1';
const C2 = 'filho-c2';
const L_KIT = 'link-kit';
const L_NOVO = 'link-kit-novo';
const L_COMUM = 'link-comum';

const comp = (quantidade: number, extra: Record<string, unknown> = {}) => ({
  quantidade,
  limitarEstoque: true,
  timestamp: 1,
  ...extra,
});
/** Recipe A — what Shopee's kit was created with. */
const RECEITA_A = { 'comp-a': comp(2), 'comp-b': comp(1) };
/** Recipe B — the ERP edit. */
const RECEITA_B = { 'comp-a': comp(3), 'comp-b': comp(1) };

const conta = (integracaoId: string) => toOuterRef(`integracao/${integracaoId}`);
const vinculo = (dono: string, linkId: string) =>
  toOuterRef(`produtos/${dono}/prodshopee/${linkId}`);

/** A kit-model row exactly as the kit arms write it. */
function linha(
  a: {
    contaId?: string;
    dono?: string;
    linkId?: string;
    modelId?: number;
    carimbo?: string | null;
  } = {},
): Record<string, unknown> {
  return linhaVariacaoDeKit({
    contaRef: conta(a.contaId ?? 'int-1'),
    linkPath: vinculo(a.dono ?? K, a.linkId ?? L_KIT),
    modelId: a.modelId ?? 2000458820,
    tierIndex: [0],
    modelStatus: 'NORMAL',
    receitaKitConferida: a.carimbo === undefined ? chaveReceitaKitErp(RECEITA_A) : a.carimbo,
  });
}

interface Banco {
  readonly produtos: Record<string, Record<string, unknown>>;
  /** produtoId → row doc id → row */
  readonly variashopee: Record<string, Record<string, Record<string, unknown>>>;
}

/**
 * The narrowest `db` this module touches, with EVERY access logged.
 *
 * ⚠️ Reads are the point. "Zero reads unless the recipe moved" is a claim about
 * READS, and a write-only double would pass with the gate removed. Any query, any
 * transaction and any write throws: this module makes none of them itself — the
 * aviso write belongs to the shared decision, which is the recorder here.
 */
function stubDb(banco: Banco) {
  const leituras: string[] = [];
  const proibido = (o: string) => () => {
    throw new Error(`avisoReceitaKitShopee não deveria chamar ${o}`);
  };
  const colecao = (path: string) => ({
    doc: (id: string) => ({
      get: async () => {
        leituras.push(`${path}/${id}`);
        const dados = path === 'produtos' ? banco.produtos[id] : undefined;
        return { id, exists: dados !== undefined, data: () => dados };
      },
      set: proibido('set'),
      update: proibido('update'),
      create: proibido('create'),
    }),
    get: async () => {
      leituras.push(path);
      const dono = /^produtos\/([^/]+)\/variashopee$/.exec(path)?.[1];
      const linhas = dono === undefined ? {} : (banco.variashopee[dono] ?? {});
      return { docs: Object.entries(linhas).map(([id, data]) => ({ id, data: () => data })) };
    },
    where: proibido('where'),
    add: proibido('add'),
  });
  const db = {
    collection: colecao,
    collectionGroup: proibido('collectionGroup'),
    runTransaction: proibido('runTransaction'),
    batch: proibido('batch'),
  } as unknown as Firestore;
  return { db, leituras };
}

const DEPS = {
  agoraUs: Date.parse('2026-10-07T12:00:00.000Z') * 1000,
  increment: (n: number) => FieldValue.increment(n),
};

/** The (conta, kit) pairs handed to the shared decision, in call order. */
const pares = () =>
  m.reavaliar.mock.calls.map((c) => c[1] as { integracaoId: string; kitProdutoId: string });

beforeEach(() => {
  m.reavaliar.mockReset();
  m.reavaliar.mockResolvedValue('aberto');
  m.warn.mockReset();
  m.error.mockReset();
});

/* -------------------------------------------------------------------------- */
/*                                  the gate                                  */
/* -------------------------------------------------------------------------- */

describe('receitaKitMudou — the pure gate, EQUAL pairs and DISTINCT near-misses', () => {
  it('EQUAL: key order, limitarEstoque, the entry timestamp and passthrough extras do not open it', () => {
    const reordenada = { 'comp-b': comp(1), 'comp-a': comp(2) };
    const outrosFlags = {
      'comp-a': comp(2, { limitarEstoque: false, timestamp: 99 }),
      'comp-b': comp(1, { legado: 'x' }),
    };
    expect(receitaKitMudou({ componentesKit: RECEITA_A }, { componentesKit: reordenada })).toBe(
      false,
    );
    expect(receitaKitMudou({ componentesKit: RECEITA_A }, { componentesKit: outrosFlags })).toBe(
      false,
    );
  });

  it('EQUAL: absent, null and an empty map are all "no recipe"', () => {
    expect(receitaKitMudou({}, { componentesKit: null })).toBe(false);
    expect(receitaKitMudou({ componentesKit: {} }, {})).toBe(false);
    expect(receitaKitMudou({ nome: 'a' }, { nome: 'b' })).toBe(false);
  });

  it('DISTINCT: one quantity moved (2 → 3) opens it', () => {
    expect(receitaKitMudou({ componentesKit: RECEITA_A }, { componentesKit: RECEITA_B })).toBe(
      true,
    );
  });

  it('DISTINCT: a component added, removed or renamed opens it', () => {
    const mais = { ...RECEITA_A, 'comp-c': comp(1) };
    const { 'comp-b': _removido, ...menos } = RECEITA_A;
    const renomeada = { 'comp-a': comp(2), 'comp-z': comp(1) };
    expect(receitaKitMudou({ componentesKit: RECEITA_A }, { componentesKit: mais })).toBe(true);
    expect(receitaKitMudou({ componentesKit: RECEITA_A }, { componentesKit: menos })).toBe(true);
    expect(receitaKitMudou({ componentesKit: RECEITA_A }, { componentesKit: renomeada })).toBe(
      true,
    );
  });

  it('DISTINCT: {p1: 12} is not {p11: 2} — the fingerprint never joins id and quantity', () => {
    expect(
      receitaKitMudou({ componentesKit: { p1: comp(12) } }, { componentesKit: { p11: comp(2) } }),
    ).toBe(true);
  });

  it('a create carrying a recipe opens it; a delete never does', () => {
    expect(receitaKitMudou(undefined, { componentesKit: RECEITA_A })).toBe(true);
    expect(receitaKitMudou({ componentesKit: RECEITA_A }, undefined)).toBe(false);
  });
});

describe('avisarReceitaKitShopee — the gate costs nothing (M154)', () => {
  const banco: Banco = {
    produtos: { [C1]: { paiId: K, componentesKit: RECEITA_A } },
    variashopee: { [C1]: { r1: linha() } },
  };

  // ⚠️ The common case: most produto saves move no recipe. Asserting the READS is
  // the point — a gate-less trigger would hand the same pairs over and the shared
  // decision would answer the same, so a call-only assertion passes without it.
  it('an ordinary save (no recipe change) reads NOTHING and decides nothing', async () => {
    const { db, leituras } = stubDb(banco);
    await expect(
      avisarReceitaKitShopee(
        db,
        C1,
        { paiId: K, nome: 'a', componentesKit: RECEITA_A },
        { paiId: K, nome: 'b', componentesKit: RECEITA_A },
        DEPS,
      ),
    ).resolves.toBeNull();
    expect(leituras).toEqual([]);
    expect(m.reavaliar).not.toHaveBeenCalled();
  });

  // The import's shape: it re-writes a kit's map with `limitarEstoque` forced true
  // and fresh stamps. Same components, same quantities — no recipe change.
  it('an import-shaped re-write of the SAME recipe reads nothing', async () => {
    const { db, leituras } = stubDb(banco);
    const reescrita = {
      'comp-b': comp(1, { timestamp: 5 }),
      'comp-a': comp(2, { limitarEstoque: true, timestamp: 5 }),
    };
    await expect(
      avisarReceitaKitShopee(
        db,
        C1,
        { paiId: K, componentesKit: RECEITA_A },
        { paiId: K, componentesKit: reescrita },
        DEPS,
      ),
    ).resolves.toBeNull();
    expect(leituras).toEqual([]);
  });

  // With recipe B, C1 is the child holding the ONLY divergent row of an open
  // (int-1, K) aviso (its row still carries Shopee's A): its delete hands nothing
  // over either, so that aviso stays open — intended, see `receitaKitMudou`. The
  // rows stay seeded: the delete cascade (`onProdutoDeleted`) runs beside this
  // delivery, not before it.
  it('a delete reads nothing and hands nothing over — even of the child holding the only divergent row', async () => {
    const { db, leituras } = stubDb(banco);
    for (const receita of [RECEITA_A, RECEITA_B]) {
      await expect(
        avisarReceitaKitShopee(db, C1, { paiId: K, componentesKit: receita }, undefined, DEPS),
      ).resolves.toBeNull();
    }
    expect(leituras).toEqual([]);
    expect(m.reavaliar).not.toHaveBeenCalled();
  });

  // ...and the near-miss: a real edit of that same child hands (int-1, K) over,
  // paying exactly the produto re-read and ONE unfiltered read of its own rows —
  // never a link doc, never another produto.
  it('a recipe edit reads the produto and its own rows, nothing else', async () => {
    const { db, leituras } = stubDb(banco);
    await expect(
      avisarReceitaKitShopee(
        db,
        C1,
        { paiId: K, componentesKit: RECEITA_A },
        { paiId: K, componentesKit: RECEITA_B },
        DEPS,
      ),
    ).resolves.toEqual({ reavaliados: 1 });
    expect(leituras).toEqual([`produtos/${C1}`, `produtos/${C1}/variashopee`]);
    expect(pares()).toEqual([{ integracaoId: 'int-1', kitProdutoId: K }]);
  });
});

/* -------------------------------------------------------------------------- */
/*                         the current state decides                           */
/* -------------------------------------------------------------------------- */

describe('avisarReceitaKitShopee — the CURRENT state decides, never the event (M155)', () => {
  it('a delivery that outlived its produto reads no row and decides nothing', async () => {
    const { db, leituras } = stubDb({ produtos: {}, variashopee: { [C1]: { r1: linha() } } });
    await expect(
      avisarReceitaKitShopee(
        db,
        C1,
        { paiId: K, componentesKit: RECEITA_A },
        { paiId: K, componentesKit: RECEITA_B },
        DEPS,
      ),
    ).resolves.toEqual({ reavaliados: 0 });
    expect(leituras).toEqual([`produtos/${C1}`]);
    expect(m.reavaliar).not.toHaveBeenCalled();
  });

  /**
   * ⛔ The delayed delivery. The operator edited A → B and then back to A; the
   * A → B event arrives LAST. Its `after` (B) diverges from the row's stamp (A),
   * but the produto as stored is A again — the aviso must RESOLVE. This module
   * cannot know that and must not try: it hands the pair to the shared decision,
   * which re-reads the children, with the resolve motivo of a fold-back. Writing
   * or skipping anything from `after` here would reopen a fixed problem.
   */
  it('a delayed A→B delivery after a fold-back to A hands the pair over, decides nothing itself', async () => {
    const { db } = stubDb({
      produtos: { [C1]: { paiId: K, componentesKit: RECEITA_A } },
      variashopee: { [C1]: { r1: linha() } },
    });
    await avisarReceitaKitShopee(
      db,
      C1,
      { paiId: K, componentesKit: RECEITA_A },
      { paiId: K, componentesKit: RECEITA_B },
      DEPS,
    );
    expect(m.reavaliar).toHaveBeenCalledTimes(1);
    expect(m.reavaliar).toHaveBeenCalledWith(
      db,
      { integracaoId: 'int-1', kitProdutoId: K },
      MOTIVO_RESOLUCAO_RECEITA_KIT.receitaIgualAShopee,
      DEPS,
    );
  });

  // The other order: the fold-back delivery itself, whose `after` EQUALS the
  // row's stamp. A trigger that pre-filtered on "after already matches Shopee"
  // would skip it — and leave open the aviso the A→B edit raised.
  it('the fold-back delivery (after equals the stamp) is still handed over', async () => {
    const { db } = stubDb({
      produtos: { [C1]: { paiId: K, componentesKit: RECEITA_A } },
      variashopee: { [C1]: { r1: linha({ carimbo: chaveReceitaKitErp(RECEITA_A) }) } },
    });
    await avisarReceitaKitShopee(
      db,
      C1,
      { paiId: K, componentesKit: RECEITA_B },
      { paiId: K, componentesKit: RECEITA_A },
      DEPS,
    );
    expect(pares()).toEqual([{ integracaoId: 'int-1', kitProdutoId: K }]);
  });

  it('hands the caller’s deps through untouched — the event clock and the increment sentinel', async () => {
    const { db } = stubDb({
      produtos: { [C1]: { paiId: K } },
      variashopee: { [C1]: { r1: linha() } },
    });
    await avisarReceitaKitShopee(db, C1, { componentesKit: RECEITA_A }, {}, DEPS);
    const deps = m.reavaliar.mock.calls[0]![3] as typeof DEPS;
    expect(deps).toBe(DEPS);
    expect(deps.agoraUs).toBe(DEPS.agoraUs);
    expect((deps.increment(2) as FieldValue).isEqual(FieldValue.increment(2))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*                              which pairs                                    */
/* -------------------------------------------------------------------------- */

describe('avisarReceitaKitShopee — ONE decision per (conta, kit) (M157)', () => {
  const edicao = [
    { paiId: K, componentesKit: RECEITA_A },
    { paiId: K, componentesKit: RECEITA_B },
  ] as const;

  // The row lives under the CHILD, the link under the KIT: K is read from the
  // link's path. Keyed by the row's own produto, every family kit would be
  // decided about the wrong document.
  it('names the KIT that owns the link, never the produto the row sits under', async () => {
    const { db } = stubDb({
      produtos: { [C1]: { paiId: K } },
      variashopee: { [C1]: { r1: linha() } },
    });
    await avisarReceitaKitShopee(db, C1, ...edicao, DEPS);
    expect(pares()).toEqual([{ integracaoId: 'int-1', kitProdutoId: K }]);
  });

  it('two contas are two decisions', async () => {
    const { db } = stubDb({
      produtos: { [C1]: { paiId: K } },
      variashopee: {
        [C1]: {
          r2: linha({ contaId: 'int-2', linkId: 'link-kit-conta-2' }),
          r1: linha({ contaId: 'int-1' }),
        },
      },
    });
    await expect(avisarReceitaKitShopee(db, C1, ...edicao, DEPS)).resolves.toEqual({
      reavaliados: 2,
    });
    expect(pares()).toEqual([
      { integracaoId: 'int-1', kitProdutoId: K },
      { integracaoId: 'int-2', kitProdutoId: K },
    ]);
  });

  // A child bound to the old kit of a recriar whose delete did not take AND to the
  // new kit holds two rows of ONE (conta, kit): one aviso, so one decision.
  it('two rows of one (conta, kit) are ONE decision', async () => {
    const { db } = stubDb({
      produtos: { [C1]: { paiId: K } },
      variashopee: {
        [C1]: {
          velha: linha({ linkId: L_KIT, modelId: 2000458820 }),
          nova: linha({ linkId: L_NOVO, modelId: 2000458822 }),
        },
      },
    });
    await expect(avisarReceitaKitShopee(db, C1, ...edicao, DEPS)).resolves.toEqual({
      reavaliados: 1,
    });
    expect(pares()).toEqual([{ integracaoId: 'int-1', kitProdutoId: K }]);
  });

  // ...and the near-miss on the same axis: the same conta, but the rows name two
  // DIFFERENT kits (a component of two kits is not a recipe; only a child is, but
  // the trigger must not collapse distinct kits into one key).
  it('one conta, two kits are two decisions', async () => {
    const { db } = stubDb({
      produtos: { [C1]: { paiId: K } },
      variashopee: {
        [C1]: { r1: linha({ dono: K }), r2: linha({ dono: 'outro-kit', linkId: 'link-outro' }) },
      },
    });
    await avisarReceitaKitShopee(db, C1, ...edicao, DEPS);
    expect(pares()).toEqual([
      { integracaoId: 'int-1', kitProdutoId: K },
      { integracaoId: 'int-1', kitProdutoId: 'outro-kit' },
    ]);
  });

  it('both stored ref encodings (documents/… and bare) are the same pair', async () => {
    const { db } = stubDb({
      produtos: { [C1]: { paiId: K } },
      variashopee: {
        [C1]: {
          canonica: linha(),
          nua: {
            ...linha({ linkId: L_NOVO }),
            contaVariacaoShopeeOuterRef: 'integracao/int-1',
            produtoShopeeOuterRef: `produtos/${K}/prodshopee/${L_NOVO}`,
          },
        },
      },
    });
    await avisarReceitaKitShopee(db, C1, ...edicao, DEPS);
    expect(pares()).toEqual([{ integracaoId: 'int-1', kitProdutoId: K }]);
  });
});

describe('avisarReceitaKitShopee — no link rule of its own (M156, the trigger half)', () => {
  /**
   * Whether a link still SELLS (active, or superseded and neither removed nor
   * banned) is the shared decision's filter (`ehKitNativoQueAindaVende`). The
   * trigger reads no link doc at all: it hands over the pair of every row —
   * a never-verified row (`null` stamp), a row on an ordinary listing — and the
   * decision drops what does not count. The behaviour over real links (a removed
   * link opens nothing; a superseded one still selling keeps the aviso open) is
   * the emulator half.
   */
  it('hands over a null-stamp row and an ordinary-listing row, reading no link doc', async () => {
    const { db, leituras } = stubDb({
      produtos: { [C1]: { paiId: K }, [C2]: { paiId: K } },
      variashopee: {
        [C1]: { nunca: linha({ carimbo: null }) },
        [C2]: { comum: linha({ dono: C2, linkId: L_COMUM, carimbo: null }) },
      },
    });
    await avisarReceitaKitShopee(db, C1, { componentesKit: RECEITA_A }, {}, DEPS);
    await avisarReceitaKitShopee(db, C2, { componentesKit: RECEITA_A }, {}, DEPS);
    expect(pares()).toEqual([
      { integracaoId: 'int-1', kitProdutoId: K },
      { integracaoId: 'int-1', kitProdutoId: C2 },
    ]);
    expect(leituras.filter((l) => l.includes('prodshopee'))).toEqual([]);
  });
});

describe('avisarReceitaKitShopee — an unreadable row is skipped and SAID', () => {
  it('skips a row whose conta or link ref cannot be read, logs it, and keeps the rest', async () => {
    const { db } = stubDb({
      produtos: { [C1]: { paiId: K } },
      variashopee: {
        [C1]: {
          boa: linha(),
          semConta: { ...linha(), contaVariacaoShopeeOuterRef: 42 },
          contaDeOutraColecao: {
            ...linha({ contaId: 'int-9' }),
            contaVariacaoShopeeOuterRef: toOuterRef('usuarios/int-9'),
          },
          vinculoTorto: { ...linha(), produtoShopeeOuterRef: toOuterRef(`produtos/${K}`) },
          vinculoNaoEhListagem: {
            ...linha(),
            produtoShopeeOuterRef: toOuterRef(`produtos/${K}/variashopee/x`),
          },
        },
      },
    });
    await expect(
      avisarReceitaKitShopee(db, C1, { componentesKit: RECEITA_A }, {}, DEPS),
    ).resolves.toEqual({ reavaliados: 1 });
    expect(pares()).toEqual([{ integracaoId: 'int-1', kitProdutoId: K }]);
    const avisos = m.warn.mock.calls.map((c) => String(c[0]));
    expect(avisos).toHaveLength(4);
    for (const id of ['semConta', 'contaDeOutraColecao', 'vinculoTorto', 'vinculoNaoEhListagem']) {
      expect(avisos.some((a) => a.includes(`variashopee ${id} `))).toBe(true);
    }
  });

  it('a produto with no rows at all reads its rows once and decides nothing', async () => {
    const { db } = stubDb({ produtos: { [K]: { paiId: null } }, variashopee: {} });
    await expect(
      avisarReceitaKitShopee(
        db,
        K,
        { componentesKit: RECEITA_A },
        { componentesKit: RECEITA_B },
        DEPS,
      ),
    ).resolves.toEqual({ reavaliados: 0 });
    expect(m.reavaliar).not.toHaveBeenCalled();
  });
});

describe('avisarReceitaKitShopee — rule 6: every failure surfaces', () => {
  // One conta's transient error must not cost another conta's aviso — and must
  // not be swallowed either. Every pair is attempted, THEN the first error rethrows.
  it('attempts every pair, then rethrows the first failure verbatim', async () => {
    const falha = Object.assign(new Error('unavailable'), { code: 14 });
    m.reavaliar.mockRejectedValueOnce(falha).mockResolvedValueOnce('resolvido');
    const { db } = stubDb({
      produtos: { [C1]: { paiId: K } },
      variashopee: {
        [C1]: {
          r1: linha({ contaId: 'int-1' }),
          r2: linha({ contaId: 'int-2', linkId: 'link-kit-conta-2' }),
        },
      },
    });
    await expect(
      avisarReceitaKitShopee(db, C1, { componentesKit: RECEITA_A }, {}, DEPS),
    ).rejects.toBe(falha);
    expect(pares()).toEqual([
      { integracaoId: 'int-1', kitProdutoId: K },
      { integracaoId: 'int-2', kitProdutoId: K },
    ]);
    expect(m.error).toHaveBeenCalledTimes(1);
    expect(String(m.error.mock.calls[0]![0])).toContain(`kit ${K} na conta int-1`);
  });

  it('a non-Error rejection is rethrown as it came', async () => {
    m.reavaliar.mockRejectedValueOnce('texto');
    const { db } = stubDb({
      produtos: { [C1]: { paiId: K } },
      variashopee: { [C1]: { r1: linha() } },
    });
    await expect(
      avisarReceitaKitShopee(db, C1, { componentesKit: RECEITA_A }, {}, DEPS),
    ).rejects.toBe('texto');
  });
});
