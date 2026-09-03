import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MigrationArgError, type MigrationContext } from '../runner';
import { run } from './migrate';
import { idDoMembroUnico } from './transform';

/**
 * The conversion walk, driven against a fake Firestore.
 *
 * `transform.test.ts` covers the decisions. This covers what the pure module
 * cannot see — **which produto each kit component is repointed at**, which is
 * decided by the walk's own bookkeeping rather than by any single decision.
 *
 * ⛔ The first test is the one that must never regress. Phase 2's resolution map
 * is built from what phase 1 actually DID, not from what pass 1 guessed it would
 * do, and the difference is a live Mercado Livre listing: a produto skipped as
 * `tem-vinculo-mercado-livre` is childless, so an optimistic seed would send every
 * kit naming it to `idDoMembroUnico(id)` — a document the run never creates.
 * `kitEstoqueDisponivel` scores an unresolvable component 0, the sweep pushes that
 * 0, and the listing stops selling. `transform.ts`'s header is explicit that the
 * cost is the listing's sales history and ranking, irrecoverably.
 *
 * Importing `migrate.ts` is safe under vitest: its entrypoint guard compares
 * `import.meta.url` to `process.argv[1]`, which is the vitest binary here, so
 * `runMigration` does not fire.
 */

interface Escrita {
  tipo: 'set' | 'update' | 'updateGuarded';
  path: string;
  data: Record<string, unknown>;
}

/** A produto in the fake corpus. `paiId: null` unless said otherwise. */
const produto = (data: Record<string, unknown> = {}): Record<string, unknown> => ({
  nome: 'p',
  sku: 'p',
  paiId: null,
  filhoUnicoId: null,
  ...data,
});

const kit = (quantidade = 1) => ({ quantidade, limitarEstoque: true, timestamp: null });

interface Mundo {
  /** produto id → stored document. */
  produtos: Record<string, Record<string, unknown>>;
  /** produto id → its estoque rows, `{docId: {quantidade, reservada, depositoId}}`. */
  estoques?: Record<string, Record<string, { q: number; r?: number; dep?: string }>>;
  /** produto ids that carry a `produtoMercadoLivre` link. */
  comVinculoMl?: string[];
  /**
   * Children that exist for the FRESH `where('paiId','==',id)` re-read but not in
   * the corpus walk — i.e. a variation created between pass 1 and pass 2. The one
   * divergence the walk is built to survive, and it cannot be expressed by a
   * double that answers both reads from the same store.
   */
  aparecemDepois?: Record<string, string[]>;
}

function fakeDb(mundo: Mundo) {
  const snapshot = (docs: Array<{ id: string; data: Record<string, unknown> }>) => ({
    empty: docs.length === 0,
    size: docs.length,
    docs: docs.map((d) => ({ id: d.id, data: () => d.data, updateTime: { seconds: 1 } })),
  });

  const todosProdutos = () => Object.entries(mundo.produtos).map(([id, data]) => ({ id, data }));

  const collection = (path: string) => {
    const fazer = (
      docs: Array<{ id: string; data: Record<string, unknown> }>,
      limite: number | null,
      primeiraPagina: boolean,
    ): Record<string, unknown> => {
      const q: Record<string, unknown> = {
        select: () => fazer(docs, limite, primeiraPagina),
        orderBy: () => fazer(docs, limite, primeiraPagina),
        limit: (n: number) => fazer(docs, n, primeiraPagina),
        // Small fixtures never fill a page, so the second page is always empty.
        startAfter: () => fazer([], limite, false),
        where: (campo: string, _op: string, valor: unknown) =>
          fazer(
            [
              ...docs.filter((d) => (d.data[campo] ?? null) === valor),
              // Only the FRESH re-read sees these — the corpus walk never does.
              ...(campo === 'paiId'
                ? (mundo.aparecemDepois?.[String(valor)] ?? []).map((id) => ({
                    id,
                    data: produto({ paiId: valor }),
                  }))
                : []),
            ],
            limite,
            primeiraPagina,
          ),
        get: async () => snapshot(limite === null ? docs : docs.slice(0, limite)),
      };
      return q;
    };

    if (path === 'produtos') return fazer(todosProdutos(), null, true);

    const estoque = /^produtos\/(.+)\/estoques$/.exec(path);
    if (estoque) {
      const linhas = mundo.estoques?.[estoque[1]!] ?? {};
      return fazer(
        Object.entries(linhas).map(([id, l]) => ({
          id,
          data: {
            depositoOuterRef: `documents/depositos/${l.dep ?? 'dep1'}`,
            quantidade: l.q,
            quantidadeReservada: l.r ?? 0,
          },
        })),
        null,
        true,
      );
    }

    const ml = /^produtos\/(.+)\/produtoMercadoLivre$/.exec(path);
    if (ml) {
      const tem = (mundo.comVinculoMl ?? []).includes(ml[1]!);
      return fazer(tem ? [{ id: 'link', data: {} }] : [], null, true);
    }

    return fazer([], null, true);
  };

  const doc = (path: string) => {
    const id = path.replace(/^produtos\//, '');
    return {
      path,
      get: async () => ({
        exists: mundo.produtos[id] !== undefined,
        data: () => mundo.produtos[id],
        updateTime: { seconds: 1 },
      }),
    };
  };

  return { collection, doc } as unknown as MigrationContext['db'];
}

function ctx(mundo: Mundo, over: { targets?: string[]; apply?: boolean } = {}) {
  const escritas: Escrita[] = [];
  const registrar = (tipo: Escrita['tipo']) => async (ref: { path: string }, data: unknown) => {
    escritas.push({ tipo, path: ref.path, data: data as Record<string, unknown> });
    return true;
  };
  const contexto: MigrationContext = {
    db: fakeDb(mundo),
    apply: over.apply ?? true,
    reportOnly: false,
    sink: {
      changes: 0,
      skips: 0,
      change: () => {},
      skip: () => {},
    } as unknown as MigrationContext['sink'],
    writer: {
      set: registrar('set'),
      update: registrar('update'),
      updateGuarded: registrar('updateGuarded'),
      flush: async () => {},
      committed: 0,
    } as unknown as MigrationContext['writer'],
    args: {
      projectId: 'p',
      apply: over.apply ?? true,
      reportOnly: false,
      targets: over.targets ?? [],
    },
  };
  return { contexto, escritas };
}

/** The `componentesKit` a run wrote to one produto, or `undefined`. */
const mapaEscrito = (escritas: Escrita[], produtoId: string) =>
  escritas.filter((e) => e.path === `produtos/${produtoId}`).at(-1)?.data.componentesKit;

let linhas: string[] = [];
beforeEach(() => {
  linhas = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    linhas.push(args.map(String).join(' '));
  });
});

/* -------------------------------------------------------------------------- */

describe('phase 2 — where a kit component is repointed', () => {
  /**
   * ⛔ THE test. A produto with an ML link is skipped by the conversion, so it
   * keeps its own stock and its own id — and the kit naming it must be left
   * exactly as it is. Repointing it at the child the run did NOT create is the
   * one failure that costs a live listing.
   */
  it('leaves a kit naming a produto the run SKIPPED for Mercado Livre', async () => {
    const { contexto, escritas } = ctx({
      produtos: {
        vendeNoMl: produto(),
        oKit: produto({ ehKit: true, componentesKit: { vendeNoMl: kit() } }),
      },
      estoques: { vendeNoMl: { 'est-vendeNoMl-dep1': { q: 5 } } },
      comVinculoMl: ['vendeNoMl'],
    });

    await run(contexto);

    // Nothing was minted for it...
    expect(escritas.some((e) => e.path === `produtos/${idDoMembroUnico('vendeNoMl')}`)).toBe(false);
    // ...and the kit still names the produto that still holds the stock.
    expect(mapaEscrito(escritas, 'oKit')).toBeUndefined();
  });

  it('repoints a kit at the child the run just minted', async () => {
    const { contexto, escritas } = ctx({
      produtos: {
        simples: produto(),
        oKit: produto({ ehKit: true, componentesKit: { simples: kit(3) } }),
      },
      estoques: { simples: { 'est-simples-dep1': { q: 5 } } },
    });

    await run(contexto);

    expect(mapaEscrito(escritas, 'oKit')).toEqual({ [idDoMembroUnico('simples')]: kit(3) });
  });

  /**
   * ⛔ The half the walk used to lose. A KIT produto with no children is itself
   * converted, and `montarMembroUnico` copies its map VERBATIM onto a child
   * written after the corpus walk already returned — so a walk that only knows
   * about documents it SAW rewrites the parent and leaves the member naming
   * produtos with no stock. The mirror then reads that mismatch as operator
   * divergence and freezes the four kit fields for the life of the produto.
   */
  it('rewrites the sole member it just minted for a KIT parent', async () => {
    const { contexto, escritas } = ctx({
      produtos: {
        comp: produto(),
        kitPai: produto({ ehKit: true, componentesKit: { comp: kit(2) } }),
      },
      estoques: { comp: { 'est-comp-dep1': { q: 5 } } },
    });

    await run(contexto);

    const esperado = { [idDoMembroUnico('comp')]: kit(2) };
    expect(mapaEscrito(escritas, 'kitPai')).toEqual(esperado);
    // ...and the member minted for `kitPai` carries the SAME resolved map.
    expect(mapaEscrito(escritas, idDoMembroUnico('kitPai'))).toEqual(esperado);
  });

  // ⚠️ A component that is a family of MANY has no single sellable unit, so no
  // script may choose one. It is left alone and counted.
  it('leaves a component that is a family of many exactly where it is', async () => {
    const { contexto, escritas } = ctx({
      produtos: {
        pai: produto(),
        v1: produto({ paiId: 'pai' }),
        v2: produto({ paiId: 'pai' }),
        oKit: produto({ ehKit: true, componentesKit: { pai: kit() } }),
      },
    });

    await run(contexto);

    expect(mapaEscrito(escritas, 'oKit')).toBeUndefined();
    expect(linhas.join('\n')).toContain('família de VÁRIOS filhos');
  });

  it('repoints at the sole member of a family that already existed', async () => {
    const { contexto, escritas } = ctx({
      produtos: {
        pai: produto({ filhoUnicoId: 'unico' }),
        unico: produto({ paiId: 'pai' }),
        oKit: produto({ ehKit: true, componentesKit: { pai: kit() } }),
      },
    });

    await run(contexto);

    expect(mapaEscrito(escritas, 'oKit')).toEqual({ unico: kit() });
  });

  // ⚠️ The near-miss for the pointer: a STORED `filhoUnicoId` that disagrees with
  // the live child set must not be baked into a kit map. The pointer is a
  // denormalisation with nothing keeping it honest; the observed children win.
  it('ignores a stored pointer that the live child set contradicts', async () => {
    const { contexto, escritas } = ctx({
      produtos: {
        pai: produto({ filhoUnicoId: 'fantasma' }),
        v1: produto({ paiId: 'pai' }),
        v2: produto({ paiId: 'pai' }),
        oKit: produto({ ehKit: true, componentesKit: { pai: kit() } }),
      },
    });

    await run(contexto);

    expect(mapaEscrito(escritas, 'oKit')).toBeUndefined();
    expect(linhas.join('\n')).toContain('divergentes do conjunto vivo');
  });
});

describe('phase 1 — the pointer for a family that already exists', () => {
  it('stamps filhoUnicoId on a family of one that has none', async () => {
    const { contexto, escritas } = ctx({
      produtos: { pai: produto(), unico: produto({ paiId: 'pai' }) },
    });

    await run(contexto);

    expect(escritas).toContainEqual(
      expect.objectContaining({
        tipo: 'updateGuarded',
        path: 'produtos/pai',
        data: expect.objectContaining({ filhoUnicoId: 'unico' }),
      }),
    );
  });

  // The near-miss: two children means no single sellable unit, so no pointer.
  it('stamps nothing on a family of many', async () => {
    const { contexto, escritas } = ctx({
      produtos: {
        pai: produto(),
        v1: produto({ paiId: 'pai' }),
        v2: produto({ paiId: 'pai' }),
      },
    });

    await run(contexto);

    expect(escritas.some((e) => 'filhoUnicoId' in (e.data ?? {}))).toBe(false);
  });

  /**
   * ⛔ The window pass 1 cannot see. A variation created between the corpus walk
   * and this re-read makes the snapshot say "one child" for a family of two — and
   * stamping then points every stock reader at one arbitrary variation, which is
   * the precise drift `filhoUnicoId` exists to prevent, written by the tool meant
   * to establish it. The fresh read wins, and the seeded resolution is dropped
   * with it so no kit is repointed at that child either.
   */
  it('drops the seeded unit when a sibling appeared after the walk', async () => {
    const { contexto, escritas } = ctx({
      produtos: {
        pai: produto(),
        v1: produto({ paiId: 'pai' }),
        // Already a settled family of one, so nothing here converts it and the
        // only writes a correct run can make are about `pai`.
        oKit: produto({ filhoUnicoId: 'oKitFilho', ehKit: true, componentesKit: { pai: kit() } }),
        oKitFilho: produto({ paiId: 'oKit' }),
      },
      aparecemDepois: { pai: ['v2'] },
    });

    await run(contexto);

    expect(escritas.filter((e) => e.path === 'produtos/pai')).toEqual([]);
    expect(mapaEscrito(escritas, 'oKit')).toBeUndefined();
  });

  it('writes nothing when the pointer is already right — the re-run case', async () => {
    const { contexto, escritas } = ctx({
      produtos: { pai: produto({ filhoUnicoId: 'unico' }), unico: produto({ paiId: 'pai' }) },
    });

    await run(contexto);

    expect(escritas).toEqual([]);
  });
});

describe('--target', () => {
  /**
   * ⛔ `runner.ts` accepts any string, so a typo would select neither phase, write
   * nothing and exit 0 reporting success — the worst failure this package can
   * have, and the reason the flag cannot be copied without this throw.
   */
  it('throws on an unknown target instead of silently doing nothing', async () => {
    const { contexto } = ctx({ produtos: {} }, { targets: ['kit'] });
    await expect(run(contexto)).rejects.toThrow(MigrationArgError);
  });

  /**
   * ⛔ The seed's own correctness, isolated. With the conversion phase running,
   * the pointer arm re-reads and DELETES a wrong seed, so a seed taken from the
   * stored `filhoUnicoId` would still come out right — masking the bug. Under
   * `--target kits` there is no such arm, and the seed is the only thing deciding
   * where every kit component lands.
   */
  it('ignores a stored pointer under --target kits, where nothing corrects it', async () => {
    const { contexto, escritas } = ctx(
      {
        produtos: {
          pai: produto({ filhoUnicoId: 'fantasma' }),
          v1: produto({ paiId: 'pai' }),
          v2: produto({ paiId: 'pai' }),
          oKit: produto({ ehKit: true, componentesKit: { pai: kit() } }),
        },
      },
      { targets: ['kits'] },
    );

    await run(contexto);

    expect(mapaEscrito(escritas, 'oKit')).toBeUndefined();
  });

  it('rewrites kits without converting anything under --target kits', async () => {
    const { contexto, escritas } = ctx(
      {
        produtos: {
          pai: produto({ filhoUnicoId: 'unico' }),
          unico: produto({ paiId: 'pai' }),
          simples: produto(),
          oKit: produto({ ehKit: true, componentesKit: { pai: kit() } }),
        },
        estoques: { simples: { 'est-simples-dep1': { q: 5 } } },
      },
      { targets: ['kits'] },
    );

    await run(contexto);

    expect(mapaEscrito(escritas, 'oKit')).toEqual({ unico: kit() });
    // `simples` is a conversion candidate and was NOT touched.
    expect(escritas.some((e) => e.path === `produtos/${idDoMembroUnico('simples')}`)).toBe(false);
  });

  /**
   * ⛔ Converting without rewriting the kits CREATES the harm this script exists
   * to remove — every kit then names a produto whose available stock has just
   * moved away. Exiting 0 would report that as done.
   */
  it('refuses to finish when a conversion ran without the kit phase', async () => {
    const { contexto } = ctx(
      {
        produtos: { simples: produto() },
        estoques: { simples: { 'est-simples-dep1': { q: 5 } } },
      },
      { targets: ['conversao'] },
    );

    await expect(run(contexto)).rejects.toThrow(/--target kits/);
  });

  it('is happy converting nothing under --target conversao', async () => {
    const { contexto } = ctx(
      { produtos: { pai: produto({ filhoUnicoId: 'unico' }), unico: produto({ paiId: 'pai' }) } },
      { targets: ['conversao'] },
    );
    await expect(run(contexto)).resolves.toBeDefined();
  });
});
