import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MigrationArgError, type MigrationContext } from '../runner';
import { run } from './audit';

/**
 * The walk, driven against a fake Firestore.
 *
 * `predicate.test.ts` covers the decisions; this covers the three promises the
 * README makes about HOW the walk gets there, none of which the pure module can
 * see: that `--apply` is refused, that a produto which already has children does
 * not pay for an estoque read, and that an unmeasured optional pass reports
 * `null` rather than a zero someone would read as a measurement.
 *
 * Importing `audit.ts` is safe under vitest: its entrypoint guard compares
 * `import.meta.url` to `process.argv[1]`, which is the vitest binary here, so
 * `runMigration` does not fire.
 */

interface FakeDoc {
  id: string;
  data: Record<string, unknown>;
}

interface Registro {
  path: string;
  field: string;
  to: unknown;
}

/**
 * Enough of the Admin SDK surface for `pagesByDocId` and the direct
 * subcollection `get()`. Every requested collection path is recorded, which is
 * what makes the "no estoque read for an existing family" promise testable —
 * a cost guarantee is invisible to an assertion about output.
 */
function fakeDb(cols: Record<string, FakeDoc[]>, lidas: string[]) {
  const snapshot = (docs: FakeDoc[]) => ({
    empty: docs.length === 0,
    size: docs.length,
    docs: docs.map((d) => ({ id: d.id, data: () => d.data })),
  });

  const collection = (path: string) => {
    lidas.push(path);
    const docs = cols[path] ?? [];
    const q: Record<string, unknown> = {
      orderBy: () => q,
      limit: () => q,
      // Small fixtures never fill a page, so paging stops after the first get.
      // Returning an empty page keeps that an implementation detail rather than
      // a trap if PAGE_SIZE ever drops.
      startAfter: () => ({ ...q, get: async () => snapshot([]) }),
      get: async () => snapshot(docs),
    };
    return q;
  };

  return { collection } as unknown as MigrationContext['db'];
}

function ctx(over: {
  cols?: Record<string, FakeDoc[]>;
  targets?: string[];
  apply?: boolean;
  lidas?: string[];
  registros?: Registro[];
}): MigrationContext {
  const lidas = over.lidas ?? [];
  const registros = over.registros ?? [];
  return {
    db: fakeDb(over.cols ?? {}, lidas),
    apply: over.apply ?? false,
    reportOnly: false,
    sink: {
      changes: 0,
      skips: 0,
      change: (path: string, field: string, _from: unknown, to: unknown) => {
        registros.push({ path, field, to });
      },
      skip: () => {},
    } as unknown as MigrationContext['sink'],
    writer: null as unknown as MigrationContext['writer'],
    args: {
      projectId: 'p',
      apply: over.apply ?? false,
      reportOnly: false,
      targets: over.targets ?? [],
    },
  };
}

const produto = (id: string, data: Record<string, unknown> = {}): FakeDoc => ({
  id,
  data: { nome: id, sku: id, paiId: null, ultimaModificacao: 1, ...data },
});

const estoque = (produtoId: string, depositoId: string, quantidade: number): FakeDoc => ({
  id: `est-${produtoId}-${depositoId}`,
  data: {
    depositoOuterRef: `documents/depositos/${depositoId}`,
    quantidade,
    quantidadeReservada: 0,
  },
});

let linhas: string[] = [];

beforeEach(() => {
  linhas = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    linhas.push(args.map(String).join(' '));
  });
});

/** The one stdout line a reader sizes the conversion from. */
const linhaQueContem = (agulha: string) => linhas.find((l) => l.includes(agulha)) ?? '';

describe('produto-sem-variacoes census — the --apply promise', () => {
  it('⚠️ REJECTS --apply instead of silently ignoring it', async () => {
    await expect(run(ctx({ apply: true }))).rejects.toThrow(MigrationArgError);
    await expect(run(ctx({ apply: true }))).rejects.toThrow(/CENSUS, not a migration/);
  });

  it('says WHY, naming the window — so nobody assumes the flag just needs a retry', async () => {
    await expect(run(ctx({ apply: true }))).rejects.toThrow(/cutover window/);
  });
});

describe('produto-sem-variacoes census — the walk', () => {
  const corpus = {
    produtos: [
      produto('simples', { sku: 'S1' }),
      produto('familia'),
      produto('filho-1', { paiId: 'familia' }),
      produto('orfao-1', { paiId: 'pai-que-sumiu' }),
    ],
    'produtos/simples/estoques': [estoque('simples', 'dep-1', 20)],
    'produtos/familia/estoques': [estoque('familia', 'dep-1', 7)],
  };

  it('derives "has children" from the children themselves, with no per-candidate query', async () => {
    const lidas: string[] = [];
    const registros: Registro[] = [];
    const summary = await run(ctx({ cols: corpus, lidas, registros }));

    // One pass over `produtos`, not one query per candidate.
    expect(lidas.filter((p) => p === 'produtos')).toHaveLength(1);
    expect(summary.docsScanned).toBe(4);

    const vereditos = Object.fromEntries(registros.map((r) => [r.path, r.field]));
    expect(vereditos['produtos/simples']).toBe('simples-com-estoque');
    expect(vereditos['produtos/orfao-1']).toBe('orfao');
  });

  // ⚠️ The cost guarantee. `familia` already has a child, so reading its estoques
  // would be one wasted subcollection read per existing family across the whole
  // catalogue — invisible in the output, visible on the Enterprise invoice.
  it('does NOT read estoques for a produto that already has children', async () => {
    const lidas: string[] = [];
    await run(ctx({ cols: corpus, lidas }));
    expect(lidas).toContain('produtos/simples/estoques');
    expect(lidas).not.toContain('produtos/familia/estoques');
    // Nor for children, which are not candidates either.
    expect(lidas).not.toContain('produtos/filho-1/estoques');
  });

  it('reads them under --target residuais, and reports the family holding stock', async () => {
    const lidas: string[] = [];
    const registros: Registro[] = [];
    await run(ctx({ cols: corpus, lidas, registros, targets: ['residuais'] }));
    expect(lidas).toContain('produtos/familia/estoques');
    expect(registros.map((r) => r.path)).toContain('produtos/familia');
  });

  // The reporting policy the run also prints: `filho` is counted, never written
  // out. A reader must not mistake the JSONL's row count for the corpus size.
  it('counts a filho but does not give it a JSONL row', async () => {
    const registros: Registro[] = [];
    const summary = await run(ctx({ cols: corpus, registros }));
    expect(summary.docsScanned).toBe(4);
    expect(registros.map((r) => r.path)).not.toContain('produtos/filho-1');
    expect(summary.docsChanged).toBe(registros.length);
  });

  // ⚠️ "we did not look" and "we looked and found none" must never be the same
  // value in a report someone sizes a migration from.
  it('reports null for an optional pass that did not run, and a number when it did', async () => {
    const semAlvo: Registro[] = [];
    await run(ctx({ cols: corpus, registros: semAlvo }));
    const linha = semAlvo.find((r) => r.path === 'produtos/simples')?.to as Record<string, unknown>;
    expect(linha.nPedidosAbertosQueReservam).toBeNull();
    expect(linha.emBalancoAberto).toBeNull();

    const comAlvo: Registro[] = [];
    const lidas: string[] = [];
    await run(
      ctx({
        cols: {
          ...corpus,
          pedidos: [
            { id: 'ped-1', data: { estoqueAplicado: { reservado: { simples: 3 } } } },
            // Zero must not count as a held reservation.
            { id: 'ped-2', data: { estoqueAplicado: { reservado: { simples: 0 } } } },
          ],
          // `estado: null` IS "aberto" (balanco.ts:95-108).
          balanco: [{ id: 'bal-1', data: { estado: null, depositoOuterRef: 'depositos/dep-1' } }],
        },
        lidas,
        registros: comAlvo,
        targets: ['pedidos', 'balancos'],
      }),
    );
    const medida = comAlvo.find((r) => r.path === 'produtos/simples')?.to as Record<
      string,
      unknown
    >;
    expect(medida.nPedidosAbertosQueReservam).toBe(1);
    expect(medida.emBalancoAberto).toBe(true);

    // A produto nothing reserves against reports 0, not null — it WAS measured.
    const orfao = comAlvo.find((r) => r.path === 'produtos/orfao-1')?.to as Record<string, unknown>;
    expect(orfao.nPedidosAbertosQueReservam).toBe(0);
  });

  it('ignores a FINALIZED balanço when flagging open ones', async () => {
    const registros: Registro[] = [];
    await run(
      ctx({
        cols: {
          ...corpus,
          balanco: [
            {
              id: 'bal-1',
              data: { estado: 'finalizado', depositoOuterRef: 'depositos/dep-1' },
            },
          ],
        },
        registros,
        targets: ['balancos'],
      }),
    );
    const linha = registros.find((r) => r.path === 'produtos/simples')?.to as Record<
      string,
      unknown
    >;
    expect(linha.emBalancoAberto).toBe(false);
  });

  it('carries the kit reference count from the same single pass', async () => {
    const registros: Registro[] = [];
    await run(
      ctx({
        cols: {
          ...corpus,
          produtos: [
            ...corpus.produtos,
            produto('kit-1', { ehKit: true, componentesKitKeys: ['simples'] }),
            produto('kit-2', { ehKit: true, componentesKitKeys: ['simples', 'outro'] }),
          ],
        },
        registros,
      }),
    );
    const linha = registros.find((r) => r.path === 'produtos/simples')?.to as Record<
      string,
      unknown
    >;
    expect(linha.nKitsQueReferenciam).toBe(2);
  });
});

/**
 * ⚠️ The headline number must not depend on which flags were passed. `--target
 * residuais` reports on produtos that ALREADY have children — the conversion
 * mints no sole child for one of those and relocates none of its units — so
 * folding them in made the same corpus answer 20 or 27 depending on invocation.
 */
describe('produto-sem-variacoes census — the conversion total is flag-independent', () => {
  const corpus = {
    produtos: [produto('simples'), produto('familia'), produto('filho-1', { paiId: 'familia' })],
    'produtos/simples/estoques': [estoque('simples', 'dep-1', 20)],
    'produtos/familia/estoques': [estoque('familia', 'dep-1', 7)],
  };

  it('reports the same MOVERIA with and without --target residuais', async () => {
    await run(ctx({ cols: corpus }));
    const semAlvo = linhaQueContem('MOVERIA para o filho único');
    expect(semAlvo).toContain(': 20');

    await run(ctx({ cols: corpus, targets: ['residuais'] }));
    const comAlvo = linhaQueContem('MOVERIA para o filho único');
    expect(comAlvo).toContain(': 20');
  });

  it('reports the família residual on its own line, as units outside the conversion', async () => {
    await run(ctx({ cols: corpus, targets: ['residuais'] }));
    const residual = linhaQueContem('RESÍDUO (fora da conversão)');
    expect(residual).toContain('1 família');
    expect(residual).toContain('7 unidade');
  });
});

/**
 * ⚠️ `estoqueAplicado` is server-owned and written ONLY by
 * `sincronizarEstoquePedido`, and a Firestore import fires no triggers — so on
 * the imported corpus this census exists to measure, NO pedido carries one.
 * Keying on it alone reported a confident `0` for every produto: "we measured,
 * nothing reserves against this", about a corpus whose reservations are real.
 */
describe('produto-sem-variacoes census — reservations on an imported corpus', () => {
  const corpus = {
    produtos: [produto('simples')],
    'produtos/simples/estoques': [estoque('simples', 'dep-1', 20)],
  };

  const linhaDoSimples = (registros: Registro[]) =>
    registros.find((r) => r.path === 'produtos/simples')?.to as Record<string, unknown>;

  it('counts a legacy pedido that carries NO estoqueAplicado snapshot', async () => {
    const registros: Registro[] = [];
    await run(
      ctx({
        cols: {
          ...corpus,
          pedidos: [
            {
              id: 'ped-legado',
              data: {
                // Stock made unavailable, never removed — the reservation is open.
                dataIndisponivelEstoque: 1_700_000_000_000_000,
                dataRemocaoEstoque: null,
                itens: { simples: [{ quantidade: 2 }] },
              },
            },
          ],
        },
        registros,
        targets: ['pedidos'],
      }),
    );
    expect(linhaDoSimples(registros).nPedidosAbertosQueReservam).toBe(1);
    expect(linhaQueContem('via o marcador legado')).toContain('1 via o marcador legado');
  });

  // The other half of the marker: stock already removed is no longer reserved.
  it('does NOT count a legacy pedido whose stock was already removed', async () => {
    const registros: Registro[] = [];
    await run(
      ctx({
        cols: {
          ...corpus,
          pedidos: [
            {
              id: 'ped-enviado',
              data: {
                dataIndisponivelEstoque: 1_700_000_000_000_000,
                dataRemocaoEstoque: 1_700_000_500_000_000,
                itens: { simples: [{ quantidade: 2 }] },
              },
            },
          ],
        },
        registros,
        targets: ['pedidos'],
      }),
    );
    expect(linhaDoSimples(registros).nPedidosAbertosQueReservam).toBe(0);
  });

  // ⚠️ A snapshot that exists and reserves nothing is a MEASURED zero for that
  // pedido — the legacy fallback must not second-guess it and re-add the line.
  it('does not let the legacy marker override an existing empty snapshot', async () => {
    const registros: Registro[] = [];
    await run(
      ctx({
        cols: {
          ...corpus,
          pedidos: [
            {
              id: 'ped-sincronizado',
              data: {
                estoqueAplicado: { reservado: {} },
                dataIndisponivelEstoque: 1_700_000_000_000_000,
                dataRemocaoEstoque: null,
                itens: { simples: [{ quantidade: 2 }] },
              },
            },
          ],
        },
        registros,
        targets: ['pedidos'],
      }),
    );
    expect(linhaDoSimples(registros).nPedidosAbertosQueReservam).toBe(0);
  });

  // ⚠️ "we did not look" must never read as "we looked and found none".
  it('reports null, not 0, when the pedidos collection is empty', async () => {
    const registros: Registro[] = [];
    await run(ctx({ cols: corpus, registros, targets: ['pedidos'] }));
    expect(linhaDoSimples(registros).nPedidosAbertosQueReservam).toBeNull();
  });

  it('ignores the "NONE" placeholder key on a legacy pedido', async () => {
    const registros: Registro[] = [];
    await run(
      ctx({
        cols: {
          ...corpus,
          pedidos: [
            {
              id: 'ped-sem-produto',
              data: {
                dataIndisponivelEstoque: 1_700_000_000_000_000,
                dataRemocaoEstoque: null,
                itens: { NONE: [{ quantidade: 1 }], '': [{ quantidade: 1 }] },
              },
            },
          ],
        },
        registros,
        targets: ['pedidos'],
      }),
    );
    expect(linhaDoSimples(registros).nPedidosAbertosQueReservam).toBe(0);
  });
});
