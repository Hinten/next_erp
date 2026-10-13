import { FieldPath } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MigrationArgError, type MigrationContext } from '../runner';
import { NOME_DA_CONTAGEM, run } from './audit';

/**
 * The walk, driven against a fake Firestore.
 *
 * `predicate.test.ts` covers the decisions; this covers the promises the README
 * makes about HOW the walk reaches them, which the pure module cannot see: that
 * `--apply` is refused, that nothing is ever written, that the scan is the
 * index-free `orderBy(documentId())` walk, that only a counted produto pays for
 * its link reads, and that EVERY child's `variacaoMercadoLivre` is probed — the
 * I/O half of M161.
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
  from: unknown;
  to: unknown;
}

/** One operation the walk sent: the collection path plus what it asked of it. */
interface Leitura {
  path: string;
  orderBy: unknown[];
  limit: number | null;
  where: [string, string, unknown] | null;
}

/**
 * Enough of the Admin SDK surface for the walk: `collection(path)` with
 * `orderBy` / `limit` / `startAfter` / `where(field, '==', value)` / `get()`.
 * Every `get()` is logged with what it asked, and the fake has NO write method at
 * all — a `set`, `update`, `batch` or transaction would throw a TypeError.
 */
function fakeDb(cols: Record<string, FakeDoc[]>, leituras: Leitura[]) {
  const snapshot = (docs: FakeDoc[]) => ({
    empty: docs.length === 0,
    size: docs.length,
    docs: docs.map((d) => ({ id: d.id, data: () => d.data })),
  });

  const consulta = (path: string, estado: Omit<Leitura, 'path'>): Record<string, unknown> => ({
    orderBy: (campo: unknown) => consulta(path, { ...estado, orderBy: [...estado.orderBy, campo] }),
    limit: (n: number) => consulta(path, { ...estado, limit: n }),
    where: (campo: string, op: string, valor: unknown) =>
      consulta(path, { ...estado, where: [campo, op, valor] }),
    // Small fixtures never fill a page, so paging stops after the first get.
    startAfter: () => ({ get: async () => snapshot([]) }),
    get: async () => {
      leituras.push({ path, ...estado });
      let docs = cols[path] ?? [];
      if (estado.where) {
        const [campo, op, valor] = estado.where;
        if (op !== '==') throw new Error(`fake: operador ${op} não suportado`);
        docs = docs.filter((d) => d.data[campo] === valor);
      }
      if (estado.limit !== null) docs = docs.slice(0, estado.limit);
      return snapshot(docs);
    },
  });

  return {
    collection: (path: string) => consulta(path, { orderBy: [], limit: null, where: null }),
  } as unknown as MigrationContext['db'];
}

/** A `writer` that fails the test on ANY access — the script has no write path. */
const writerProibido = new Proxy(
  {},
  {
    get(_alvo, prop) {
      throw new Error(`a contagem tocou o writer (${String(prop)})`);
    },
  },
) as MigrationContext['writer'];

function ctx(over: {
  cols?: Record<string, FakeDoc[]>;
  apply?: boolean;
  leituras?: Leitura[];
  registros?: Registro[];
}): MigrationContext {
  const leituras = over.leituras ?? [];
  const registros = over.registros ?? [];
  return {
    db: fakeDb(over.cols ?? {}, leituras),
    apply: over.apply ?? false,
    reportOnly: false,
    sink: {
      changes: 0,
      skips: 0,
      change: (path: string, field: string, from: unknown, to: unknown) => {
        registros.push({ path, field, from, to });
      },
      skip: () => {},
    } as unknown as MigrationContext['sink'],
    writer: writerProibido,
    args: { projectId: 'p', apply: over.apply ?? false, reportOnly: false, targets: [] },
  };
}

const produto = (id: string, data: Record<string, unknown> = {}): FakeDoc => ({
  id,
  data: { nome: id, paiId: null, ehKit: false, ehKitVirtual: false, ...data },
});

const vinculo = (id: string): FakeDoc => ({ id, data: {} });

let linhas: string[] = [];

beforeEach(() => {
  linhas = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    linhas.push(args.map(String).join(' '));
  });
});

describe('kit-virtual-contagem — the --apply promise', () => {
  it('⚠️ REJECTS --apply instead of silently ignoring it, and says why', async () => {
    await expect(run(ctx({ apply: true }))).rejects.toThrow(MigrationArgError);
    await expect(run(ctx({ apply: true }))).rejects.toThrow(/read-only CONTAGEM/);
    await expect(run(ctx({ apply: true }))).rejects.toThrow(/no backfill/);
  });

  it('logs under the contagem name — never "census"', () => {
    expect(NOME_DA_CONTAGEM).toBe('kit-virtual-contagem');
  });
});

describe('kit-virtual-contagem — the walk', () => {
  // A UP-kit family whose ML link sits on the SECOND child only (M161), a kit
  // linked on ML at the parent, an `ehKit: false` row, a mirrored member, and two
  // produtos the count must skip (false and the string 'true').
  const corpus: Record<string, FakeDoc[]> = {
    produtos: [
      produto('familia-up', {
        ehKit: true,
        ehKitVirtual: true,
        componentesKit: { 'comp-a': { quantidade: 1 } },
      }),
      produto('familia-up-f1', { paiId: 'familia-up' }),
      produto('familia-up-f2', { paiId: 'familia-up' }),
      produto('kit-ml', {
        ehKit: true,
        ehKitVirtual: true,
        componentesKit: { c: { quantidade: 2 } },
      }),
      produto('sem-ehkit', { ehKit: false, ehKitVirtual: true }),
      produto('membro', { paiId: 'kit-ml', ehKit: true, ehKitVirtual: true }),
      produto('comum', { ehKit: true, ehKitVirtual: false }),
      produto('string-true', { ehKit: true, ehKitVirtual: 'true' }),
    ],
    'produtos/familia-up-f2/variacaoMercadoLivre': [vinculo('vml-2')],
    'produtos/kit-ml/produtoMercadoLivre': [vinculo('pml-1')],
    'produtos/kit-ml/prodshopee': [vinculo('ps-1')],
    'produtos/membro/variacaoMercadoLivre': [vinculo('vml-m')],
  };

  it('counts ehKitVirtual === true only, one JSONL row each, split by Mercado Livre', async () => {
    const registros: Registro[] = [];
    const summary = await run(ctx({ cols: corpus, registros }));

    expect(summary.docsScanned).toBe(8);
    expect(summary.docsChanged).toBe(4);
    expect(registros.map((r) => [r.path, r.field])).toEqual([
      ['produtos/familia-up', 'com-mercado-livre'],
      ['produtos/kit-ml', 'com-mercado-livre'],
      ['produtos/sem-ehkit', 'sem-mercado-livre'],
      ['produtos/membro', 'com-mercado-livre'],
    ]);
    // `from` is never an intended value — this script writes nothing.
    expect(registros.every((r) => r.from === null)).toBe(true);
  });

  it('M161 through the walk: the ML link on the 2nd child makes the family "com Mercado Livre"', async () => {
    const registros: Registro[] = [];
    const leituras: Leitura[] = [];
    await run(ctx({ cols: corpus, registros, leituras }));

    expect(registros.find((r) => r.path === 'produtos/familia-up')?.to).toEqual({
      produtoId: 'familia-up',
      paiId: null,
      ehKit: true,
      temComponentes: true,
      comMercadoLivre: true,
      mlNoProduto: false,
      mlNosFilhos: true,
      comShopee: false,
    });
    // EVERY child was probed, the first included.
    const sondados = leituras.map((l) => l.path);
    expect(sondados).toContain('produtos/familia-up-f1/variacaoMercadoLivre');
    expect(sondados).toContain('produtos/familia-up-f2/variacaoMercadoLivre');
  });

  it('a mirrored member is a row of its own, its variation link counted as its ML link', async () => {
    const registros: Registro[] = [];
    await run(ctx({ cols: corpus, registros }));
    expect(registros.find((r) => r.path === 'produtos/membro')?.to).toMatchObject({
      paiId: 'kit-ml',
      mlNoProduto: true,
      comMercadoLivre: true,
    });
    expect(registros.find((r) => r.path === 'produtos/kit-ml')?.to).toMatchObject({
      mlNoProduto: true,
      comShopee: true,
    });
  });

  it('walks produtos by documentId with no filter — the index-free scan', async () => {
    const leituras: Leitura[] = [];
    await run(ctx({ cols: corpus, leituras }));
    const varredura = leituras.filter((l) => l.path === 'produtos' && l.where === null);
    expect(varredura).toHaveLength(1);
    expect(varredura[0]!.orderBy).toEqual([FieldPath.documentId()]);
    expect(varredura[0]!.limit).toBe(300);
  });

  it('every link probe is a limit(1) read; the children query is paiId == <id>', async () => {
    const leituras: Leitura[] = [];
    await run(ctx({ cols: corpus, leituras }));
    const sondas = leituras.filter((l) => l.path !== 'produtos');
    expect(sondas.length).toBeGreaterThan(0);
    expect(sondas.every((l) => l.limit === 1 && l.where === null)).toBe(true);
    const filhos = leituras.filter((l) => l.path === 'produtos' && l.where !== null);
    // The docblock's "with no `limit`" (R5-6): every child must be asked, so a
    // `limit(1)` on the children query would silently drop all but one.
    expect(filhos.length).toBeGreaterThan(0);
    expect(filhos.every((l) => l.limit === null)).toBe(true);
    expect(filhos.map((l) => l.where)).toEqual([
      ['paiId', '==', 'familia-up'],
      ['paiId', '==', 'kit-ml'],
      ['paiId', '==', 'sem-ehkit'],
      ['paiId', '==', 'membro'],
    ]);
  });

  // The cost promise: a produto outside the count pays nothing beyond its share of
  // the key-order scan — no link probe, no children query.
  it('reads nothing for a produto outside the count', async () => {
    const leituras: Leitura[] = [];
    await run(ctx({ cols: corpus, leituras }));
    const caminhos = leituras.map((l) => l.path);
    for (const fora of ['comum', 'string-true']) {
      expect(caminhos.some((c) => c.startsWith(`produtos/${fora}/`))).toBe(false);
    }
    const consultados = leituras.filter((l) => l.where !== null).map((l) => l.where![2]);
    expect(consultados).not.toContain('comum');
    expect(consultados).not.toContain('string-true');
  });

  it('prints the totals, the ehKit !== true subset, and says it wrote nothing', async () => {
    await run(ctx({ cols: corpus }));
    const saida = linhas.join('\n');
    expect(saida).toContain('ehKitVirtual === true: 4 produto(s)');
    expect(saida).toContain('comMercadoLivre=3, semMercadoLivre=1');
    expect(saida).toContain('ehKit !== true: 1');
    expect(saida).toContain('somente leitura');
  });
});
