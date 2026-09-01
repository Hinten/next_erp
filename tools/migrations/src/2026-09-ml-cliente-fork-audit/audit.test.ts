import { describe, expect, it } from 'vitest';

import { MigrationArgError, type MigrationContext } from '../runner';
import { run } from './audit';

/**
 * ⚠️ This suite exists because an audit script is written once and RUN once,
 * months later, under time pressure inside the migration window. A version that
 * only typechecks is a version nobody has ever executed — so the walk itself is
 * driven here against an in-memory Firestore, page boundary included.
 *
 * Importing `audit.ts` is safe under vitest: its entrypoint guard compares
 * `import.meta.url` to `process.argv[1]`, which is the vitest binary here, so
 * `runMigration` does not fire.
 */

/* ------------------------------ fake Firestore ----------------------------- */

type Dados = Record<string, unknown>;

interface FakeRef {
  readonly path: string;
  readonly id: string;
  readonly parent: { id: string; parent: FakeRef | null };
}

function ref(path: string): FakeRef {
  const segs = path.split('/');
  const id = segs[segs.length - 1]!;
  const colId = segs[segs.length - 2] ?? '';
  const paiPath = segs.slice(0, -2).join('/');
  return {
    path,
    id,
    parent: { id: colId, parent: paiPath === '' ? null : ref(paiPath) },
  };
}

function snap(path: string, dados: Dados | undefined) {
  return {
    id: ref(path).id,
    ref: ref(path),
    exists: dados !== undefined,
    data: () => dados,
    get: (campo: string) => dados?.[campo],
  };
}

class FakeDb {
  /** Full doc path → data. One flat store; the queries slice it by prefix. */
  readonly docs = new Map<string, Dados>();
  /** Every `.get()` issued, so a page-boundary regression is visible. */
  queries = 0;

  seed(path: string, dados: Dados): void {
    this.docs.set(path, dados);
  }

  private query(filtrar: (path: string) => boolean) {
    const self = this;
    let limite: number | null = null;
    let depois: string | null = null;
    const q = {
      orderBy: () => q,
      limit: (n: number) => {
        limite = n;
        return q;
      },
      startAfter: (cursor: { ref: FakeRef }) => {
        depois = cursor.ref.path;
        return q;
      },
      get: async () => {
        self.queries += 1;
        let paths = [...self.docs.keys()].filter(filtrar).sort();
        if (depois != null) paths = paths.filter((p) => p > depois!);
        if (limite != null) paths = paths.slice(0, limite);
        const docs = paths.map((p) => snap(p, self.docs.get(p)));
        return { empty: docs.length === 0, size: docs.length, docs };
      },
    };
    return q;
  }

  collection(nome: string) {
    // Top-level collection: exactly two path segments, first one matching.
    return this.query((p) => {
      const s = p.split('/');
      return s.length === 2 && s[0] === nome;
    });
  }

  collectionGroup(nome: string) {
    // Any depth, as long as the collection segment (second-to-last) matches.
    return this.query((p) => {
      const s = p.split('/');
      return s.length >= 2 && s[s.length - 2] === nome;
    });
  }

  doc(path: string) {
    return ref(path);
  }

  async getAll(...refs: FakeRef[]) {
    this.queries += 1;
    return refs.map((r) => snap(r.path, this.docs.get(r.path)));
  }
}

/* --------------------------------- harness -------------------------------- */

interface Linha {
  tipo: 'change' | 'skip';
  path: string;
  kind: string;
  extra: unknown;
}

function ctx(fake: FakeDb, over: Partial<MigrationContext> = {}) {
  const linhas: Linha[] = [];
  const sink = {
    changes: 0,
    skips: 0,
    change(path: string, field: string, _from: unknown, to: unknown) {
      sink.changes += 1;
      linhas.push({ tipo: 'change', path, kind: field, extra: to });
    },
    skip(path: string, field: string, _value: unknown, _reason: string) {
      sink.skips += 1;
      linhas.push({ tipo: 'skip', path, kind: field, extra: null });
    },
  };
  const base = {
    db: fake as unknown as MigrationContext['db'],
    apply: false,
    reportOnly: false,
    sink: sink as unknown as MigrationContext['sink'],
    writer: null as unknown as MigrationContext['writer'],
    args: { projectId: 'p', apply: false, reportOnly: false, targets: [] },
    ...over,
  } as MigrationContext;
  return { ctx: base, linhas, sink };
}

/** A pedido with one ML mirror doc naming `buyerId`. */
function seedPedidoMl(
  fake: FakeDb,
  pedidoId: string,
  buyerId: unknown,
  clienteOuterRef: string | null,
): void {
  fake.seed(`pedidos/${pedidoId}`, { clientePedidoOuterRef: clienteOuterRef });
  fake.seed(`pedidos/${pedidoId}/orderML/1`, { buyer: { id: buyerId } });
}

const BUYER = 301110805;

describe('ml-cliente-fork audit — the guard', () => {
  it('⚠️ REJECTS --apply instead of silently ignoring it', async () => {
    const { ctx: c } = ctx(new FakeDb(), { apply: true });
    await expect(run(c)).rejects.toThrow(MigrationArgError);
    await expect(run(c)).rejects.toThrow(/AUDIT, not a migration/);
  });

  it('says WHY — a repair moves pedidos, conversas and endereços', async () => {
    const { ctx: c } = ctx(new FakeDb(), { apply: true });
    await expect(run(c)).rejects.toThrow(/pedidos, conversas and endereços/);
  });
});

describe('ml-cliente-fork audit — the walk', () => {
  it('classifies the four shapes that matter, and writes nothing', async () => {
    const fake = new FakeDb();
    // ok — the pedido's cliente owns the id.
    fake.seed('clientes/cli-ok', { idMercadoLivre: String(BUYER) });
    seedPedidoMl(fake, 'ped-ok', BUYER, 'documents/clientes/cli-ok');
    // fork — the question's cliente owns it, the pedido points elsewhere.
    fake.seed('clientes/cli-pergunta', { idMercadoLivre: '555000111' });
    fake.seed('clientes/cli-pedido', { idMercadoLivre: null });
    seedPedidoMl(fake, 'ped-fork', 555000111, 'documents/clientes/cli-pedido');
    // nao-carimbado — nobody owns it (the common pre-#1407 shape).
    fake.seed('clientes/cli-sozinho', { idMercadoLivre: null });
    seedPedidoMl(fake, 'ped-novo', 777888999, 'documents/clientes/cli-sozinho');
    // dono-duplicado — two clientes carry one id.
    fake.seed('clientes/cli-dup-a', { idMercadoLivre: '111222333' });
    fake.seed('clientes/cli-dup-b', { idMercadoLivre: '111222333' });
    seedPedidoMl(fake, 'ped-dup', 111222333, 'documents/clientes/cli-dup-a');
    // A NON-ML pedido: no mirror, so it must never be fetched or classified.
    fake.seed('pedidos/ped-manual', { clientePedidoOuterRef: 'documents/clientes/cli-ok' });

    const { ctx: c, linhas, sink } = ctx(fake);
    const resumo = await run(c);

    const porPath = new Map(linhas.map((l) => [l.path, l]));
    expect(porPath.get('pedidos/ped-ok')?.kind).toBe('ok');
    expect(porPath.get('pedidos/ped-fork')?.kind).toBe('fork');
    expect(porPath.get('pedidos/ped-novo')?.kind).toBe('nao-carimbado');
    expect(porPath.get('pedidos/ped-dup')?.kind).toBe('dono-duplicado');
    // The manual pedido has no orderML mirror — invisible to this audit.
    expect(porPath.has('pedidos/ped-manual')).toBe(false);

    // The fork row names BOTH documents, which is what makes it actionable.
    expect(porPath.get('pedidos/ped-fork')?.extra).toMatchObject({
      clienteDoPedido: 'cli-pedido',
      donos: ['cli-pergunta'],
    });

    // Findings are `change`, clean rows are `skip`, and the two reconcile with
    // the ML pedido count — the README's verification step.
    expect(resumo.docsScanned).toBe(4);
    // TWO findings, not three: `nao-carimbado` is deliberately not one. It is
    // the big benign background population — it self-heals on the next import
    // once #1407 deploys — and counting it as a finding would drown the forks
    // it is there to make visible. The per-kind tally still reports it.
    expect(resumo.docsChanged).toBe(2);
    expect(sink.changes + sink.skips).toBe(4);
    // Neither `ok` nor `nao-carimbado` may be a finding.
    expect(porPath.get('pedidos/ped-ok')?.tipo).toBe('skip');
    expect(porPath.get('pedidos/ped-novo')?.tipo).toBe('skip');
    expect(porPath.get('pedidos/ped-fork')?.tipo).toBe('change');
    expect(porPath.get('pedidos/ped-dup')?.tipo).toBe('change');
  });

  it('accepts the bare `clientes/<id>` outerRef the legacy corpus also carries', async () => {
    const fake = new FakeDb();
    fake.seed('clientes/cli-legado', { idMercadoLivre: String(BUYER) });
    seedPedidoMl(fake, 'ped-legado', BUYER, 'clientes/cli-legado');

    const { linhas, ctx: c } = ctx(fake);
    await run(c);

    expect(linhas[0]?.kind).toBe('ok');
  });

  it('reads a pedido whose cliente link is missing as pedido-sem-cliente', async () => {
    const fake = new FakeDb();
    seedPedidoMl(fake, 'ped-orfao', BUYER, null);

    const { linhas, ctx: c } = ctx(fake);
    await run(c);

    expect(linhas[0]?.kind).toBe('pedido-sem-cliente');
  });

  it('pages past the 300-doc boundary on BOTH scans', async () => {
    // The cursor is the part of a one-shot script that fails silently: a broken
    // `startAfter` truncates the report at exactly one page and still exits 0,
    // so the number looks plausible. 350 of each forces a second page.
    const fake = new FakeDb();
    for (let i = 0; i < 350; i += 1) {
      const n = String(i).padStart(4, '0');
      fake.seed(`clientes/cli-${n}`, { idMercadoLivre: `9${n}` });
      seedPedidoMl(fake, `ped-${n}`, Number(`9${n}`), `documents/clientes/cli-${n}`);
    }

    const { ctx: c, linhas } = ctx(fake);
    const resumo = await run(c);

    expect(resumo.docsScanned).toBe(350);
    expect(linhas).toHaveLength(350);
    // All of them resolve — a truncated clientes scan would turn the tail into
    // `cliente-ausente`, which is exactly the plausible-looking wrong answer.
    expect(linhas.every((l) => l.kind === 'ok')).toBe(true);
  });

  it('recognises an owner whose stored id is PADDED — the #1087-era hazard', async () => {
    // `buildClienteUpdatePatch` stores the id trimmed precisely because a raw
    // `'  301110805  '` made every later lookup miss. Rows written before that
    // are still on disk, so the index has to fold the same way the cascade leg
    // does — otherwise the owner is invisible and a healthy pedido is reported
    // as `nao-carimbado`, understating the real fork count.
    const fake = new FakeDb();
    fake.seed('clientes/cli-padded', { idMercadoLivre: `  ${BUYER}  ` });
    fake.seed('clientes/cli-pedido', { idMercadoLivre: null });
    seedPedidoMl(fake, 'ped-x', BUYER, 'documents/clientes/cli-pedido');

    const { ctx: c, linhas } = ctx(fake);
    await run(c);

    // Found, and correctly named as the other owner — not missed as unstamped.
    expect(linhas[0]?.kind).toBe('fork');
    expect(linhas[0]?.extra).toMatchObject({ donos: ['cli-padded'] });
  });

  it('a NEAR-MISS stored id is a different buyer, not the same one', async () => {
    // The other half of the fold: trimming must not start folding distinct
    // accounts together. A trailing digit is what a rounded id looks like.
    const fake = new FakeDb();
    fake.seed('clientes/cli-quase', { idMercadoLivre: `${BUYER}0` });
    fake.seed('clientes/cli-pedido', { idMercadoLivre: null });
    seedPedidoMl(fake, 'ped-y', BUYER, 'documents/clientes/cli-pedido');

    const { ctx: c, linhas } = ctx(fake);
    await run(c);

    // Nobody owns THIS id, so it is unstamped — never a fork onto `cli-quase`.
    expect(linhas[0]?.kind).toBe('nao-carimbado');
  });

  it('treats a PACK’s repeated mirrors as one buyer, not as divergence', async () => {
    const fake = new FakeDb();
    fake.seed('clientes/cli-pack', { idMercadoLivre: String(BUYER) });
    fake.seed('pedidos/ped-pack', { clientePedidoOuterRef: 'documents/clientes/cli-pack' });
    fake.seed('pedidos/ped-pack/orderML/1', { buyer: { id: BUYER } });
    fake.seed('pedidos/ped-pack/orderML/2', { buyer: { id: BUYER } });
    fake.seed('pedidos/ped-pack/orderML/3', { buyer: { id: BUYER } });

    const { ctx: c, linhas } = ctx(fake);
    const resumo = await run(c);

    // THREE mirror docs, ONE pedido row — a pack must not be counted per order.
    expect(resumo.docsScanned).toBe(1);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.kind).toBe('ok');
  });
});
