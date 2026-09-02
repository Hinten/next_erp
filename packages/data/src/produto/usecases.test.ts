import { describe, expect, it } from 'vitest';
import {
  impostoProdutoSchema,
  operacaoIdFromImpostoRef,
  produtoExtraDataSchema,
} from '@delfrance/schemas';
import type { ProdutoDataPort, ProdutoSnapshot, ProdutoWriteOp } from './port';
import {
  ProdutoReferencedError,
  buildChildrenComponentesKitOps,
  buildMembroUnicoWriteOps,
  buildExtraDataWriteOps,
  buildImpostoWriteOps,
  buildKitStatusChildOps,
  buildLocalizacaoOp,
  deleteProdutoCascade,
  findProdutoReferences,
  planMovimentacao,
  propagateKitStatusToChildren,
  resolveKitGuardInputs,
  saveChildrenComponentesKit,
  saveProdutoExtraData,
} from './usecases';

interface MemoryOpts {
  children?: ProdutoSnapshot[];
  /** Per-produto-id inbound references. */
  refs?: Record<string, { kits?: ProdutoSnapshot[]; subcols?: string[] }>;
  /** Per-produto-id `ehKit` flag; an id absent here does not resolve to a doc. */
  kitFlags?: Record<string, boolean>;
}

function memoryPort(opts: MemoryOpts = {}) {
  const committed: ProdutoWriteOp[][] = [];
  const kitFlagCalls: string[][] = [];
  let n = 0;
  const port: ProdutoDataPort = {
    newId: () => `id${++n}`,
    now: () => 1000,
    getChildren: async () => opts.children ?? [],
    getKitReferences: async (id) => opts.refs?.[id]?.kits ?? [],
    getKitFlags: async (ids) => {
      kitFlagCalls.push(ids);
      return ids
        .filter((id) => opts.kitFlags?.[id] !== undefined)
        .map((id) => ({ id, ehKit: opts.kitFlags![id]! }));
    },
    subcollectionHasDocs: async (id, name) => (opts.refs?.[id]?.subcols ?? []).includes(name),
    commit: async (ops) => {
      committed.push(ops);
    },
  };
  return { port, committed, kitFlagCalls };
}

/** A `componentesKit` entry (only the key matters to the guard resolver). */
const kitEntry = () => ({ quantidade: 1, limitarEstoque: true, timestamp: null });

const snap = (id: string, precos: ProdutoSnapshot['precos'], nome = id): ProdutoSnapshot => ({
  id,
  nome,
  precos,
});

describe('produto extra data (Descrição + Google Merchant singleton)', () => {
  it('buildExtraDataWriteOps targets the fixed singleton path and fills wire defaults', () => {
    const ops = buildExtraDataWriteOps('p1', produtoExtraDataSchema.parse({ descricao: 'Olá' }));
    expect(ops).toHaveLength(1);
    const op = ops[0]!;
    expect(op.type).toBe('set');
    expect(op.path).toBe('produtos/p1/extraData/singleton');
    if (op.type !== 'set') throw new Error('expected a set op');
    // The use-case parses, so the persisted doc carries the wire defaults
    // (condicao=1=novo, coteudoAdulto=false) alongside the edited field.
    expect(op.data).toMatchObject({ descricao: 'Olá', condicao: 1, coteudoAdulto: false });
  });

  it('saveProdutoExtraData commits exactly one set op at the singleton path', async () => {
    const { port, committed } = memoryPort();
    await saveProdutoExtraData(port, 'p9', produtoExtraDataSchema.parse({ marca: 'Acme' }));
    expect(committed).toHaveLength(1);
    expect(committed[0]).toHaveLength(1);
    expect(committed[0]![0]).toMatchObject({
      type: 'set',
      path: 'produtos/p9/extraData/singleton',
    });
  });
});

describe('produto estoque — localização (buildLocalizacaoOp)', () => {
  it('updates ONLY localizacao on an existing estoque (quantities untouched)', () => {
    const op = buildLocalizacaoOp('p1', 'd1', 'A1', true, 1000);
    expect(op).toEqual({
      type: 'update',
      path: 'produtos/p1/estoques/est-p1-d1',
      data: { localizacao: 'A1', ultimaModificacao: 1000 },
    });
  });

  it('clears localizacao to null on an empty string', () => {
    const op = buildLocalizacaoOp('p1', 'd1', '   ', true, 1000);
    if (op.type !== 'update') throw new Error('expected an update op');
    expect(op.data).toMatchObject({ localizacao: null });
  });

  it('sets a fresh estoque (quantidade 0) when none exists yet', () => {
    const op = buildLocalizacaoOp('p1', 'd1', 'B2', false, 1000);
    expect(op.type).toBe('set');
    expect(op.path).toBe('produtos/p1/estoques/est-p1-d1');
    if (op.type !== 'set') throw new Error('expected a set op');
    expect(op.data).toMatchObject({
      parentId: 'p1',
      depositoOuterRef: 'documents/depositos/d1',
      localizacao: 'B2',
      quantidade: 0,
      quantidadeReservada: 0,
      dataCriacao: 1000,
      ultimaModificacao: 1000,
    });
  });
});

describe('produto estoque — movimentação (planMovimentacao)', () => {
  it('entrada keeps the magnitudes positive and records a signed movimento', () => {
    const plan = planMovimentacao(
      { tipo: 'entrada', quantidade: 5, quantidadeReservada: 0, motivo: 'compra' },
      1000,
    );
    expect(plan).toMatchObject({ ehBalanco: false, quantidade: 5, quantidadeReservada: 0 });
    // Read-free: the delta is known, the resulting saldo is not.
    expect(plan.historico).toEqual({
      movimento: 5,
      movimentoReservada: 0,
      saldo: null,
      saldoReservada: null,
      motivo: 'compra',
      timestamp: 1000,
    });
  });

  it('saída negates both magnitudes (the delta the caller increments)', () => {
    const plan = planMovimentacao(
      { tipo: 'saida', quantidade: 3, quantidadeReservada: 1, motivo: null },
      1000,
    );
    expect(plan).toMatchObject({ ehBalanco: false, quantidade: -3, quantidadeReservada: -1 });
    expect(plan.historico).toMatchObject({ movimento: -3, movimentoReservada: -1 });
  });

  it('entrada/saída fill the saldo pair when `atual` is supplied', () => {
    const plan = planMovimentacao(
      { tipo: 'saida', quantidade: 3, quantidadeReservada: 1, motivo: null },
      1000,
      { quantidade: 10, quantidadeReservada: 4 },
    );
    expect(plan.historico).toMatchObject({
      movimento: -3,
      movimentoReservada: -1,
      saldo: 7,
      saldoReservada: 3,
    });
  });

  it('records the CLAMPED reservada delta when `atual` makes the floor observable', () => {
    // Releasing 5 against a stored 2: the caller floors reservada at 0, so only
    // -2 actually applies. Recording the requested -5 would drift the ledger
    // from the stored counter by exactly the clamped amount (ADR 0014).
    const plan = planMovimentacao(
      { tipo: 'saida', quantidade: 0, quantidadeReservada: 5, motivo: null },
      1000,
      { quantidade: 10, quantidadeReservada: 2 },
    );
    expect(plan.historico).toMatchObject({ movimentoReservada: -2, saldoReservada: 0 });
  });

  it('balanço writes the absolute value but records it as a SIGNED delta', () => {
    // The whole point of v2: the estoque doc gets the counted value, the ledger
    // gets `contado − atual` so `sum(movimento)` stays meaningful.
    const plan = planMovimentacao(
      { tipo: 'balanco', quantidade: 42, quantidadeReservada: 2, motivo: 'contagem' },
      1000,
      { quantidade: 50, quantidadeReservada: 3 },
    );
    expect(plan).toMatchObject({ ehBalanco: true, quantidade: 42, quantidadeReservada: 2 });
    expect(plan.historico).toMatchObject({
      movimento: -8,
      movimentoReservada: -1,
      saldo: 42,
      saldoReservada: 2,
    });
  });

  it('a balanço against a missing/zero estoque records the full counted value as the delta', () => {
    const plan = planMovimentacao(
      { tipo: 'balanco', quantidade: 42, quantidadeReservada: 0, motivo: null },
      1000,
      { quantidade: 0, quantidadeReservada: 0 },
    );
    expect(plan.historico).toMatchObject({ movimento: 42, saldo: 42 });
  });

  it('a balanço planned WITHOUT `atual` records movimento null — unknown, never a fake delta', () => {
    // Callers must read first; if one does not, consumers must see "unknown"
    // and fail open rather than sum an absolute value as if it were a delta.
    const plan = planMovimentacao(
      { tipo: 'balanco', quantidade: 42, quantidadeReservada: 2, motivo: null },
      1000,
    );
    expect(plan.historico).toMatchObject({
      movimento: null,
      movimentoReservada: null,
      saldo: 42,
      saldoReservada: 2,
    });
  });

  it('clamps a negative counted reservada into BOTH the write and the recorded saldo', () => {
    // The plan describes exactly what lands on the doc, so a balanço's
    // `quantidadeReservada` must equal its `historico.saldoReservada` — the
    // caller writes it verbatim and must not need a second floor of its own.
    const plan = planMovimentacao(
      { tipo: 'balanco', quantidade: 5, quantidadeReservada: -3, motivo: null },
      1000,
      { quantidade: 5, quantidadeReservada: 1 },
    );
    expect(plan.quantidadeReservada).toBe(0);
    expect(plan.historico).toMatchObject({ saldoReservada: 0, movimentoReservada: -1 });
    expect(plan.quantidadeReservada).toBe(plan.historico.saldoReservada);
  });

  it('leaves a NEGATIVE entrada/saída reservada delta unclamped — there it is an increment', () => {
    // Only the balanço's field is an absolute value. A saída's is the signed
    // delta the caller `increment`s, so clamping it here would silently drop
    // the release of a reservation.
    const plan = planMovimentacao(
      { tipo: 'saida', quantidade: 1, quantidadeReservada: 2, motivo: null },
      1000,
      { quantidade: 10, quantidadeReservada: 5 },
    );
    expect(plan.quantidadeReservada).toBe(-2);
    expect(plan.historico).toMatchObject({ saldoReservada: 3, movimentoReservada: -2 });
  });
});

describe('produto imposto (per-operação override)', () => {
  const imp = (over: Record<string, unknown> = {}) =>
    impostoProdutoSchema.parse({ impostoOpercaoOuterRef: 'operacao/op1', ...over });

  it('sets one doc per configured operação, keyed by the operação id', () => {
    const ops = buildImpostoWriteOps('p1', [imp({ cfop: '5102', NCM: '61091000' })], 1000);
    expect(ops).toHaveLength(1);
    const op = ops[0]!;
    expect(op).toMatchObject({ type: 'set', path: 'produtos/p1/imposto/op1' });
    if (op.type !== 'set') throw new Error('expected a set op');
    // Wire shape: Flutter typo key + operação id mirrored into `id` + timestamp.
    expect(op.data).toMatchObject({
      id: 'op1',
      impostoOpercaoOuterRef: 'operacao/op1',
      cfop: '5102',
      NCM: '61091000',
      timestamp: 1000,
    });
  });

  it('preserves a typed ICMS config on re-save', () => {
    const ops = buildImpostoWriteOps(
      'p1',
      [imp({ cfop: '5102', configuracaoICMS: { crt: '1', csosn: '102' } })],
      1000,
    );
    const op = ops[0]!;
    if (op.type !== 'set') throw new Error('expected a set op');
    expect(op.data.configuracaoICMS).toEqual({ crt: '1', csosn: '102' });
  });

  it('persists an entry whose only value is a deep tax config (no Dados Gerais)', () => {
    // A config-only entry (e.g. just ICMS) must still be saved — the
    // carries-info check now considers the typed `configuracao*` fields.
    const ops = buildImpostoWriteOps(
      'p1',
      [imp({ configuracaoPIS: { CST: '01', pPIS: 1.65 } })],
      1000,
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: 'set', path: 'produtos/p1/imposto/op1' });
  });

  it('deletes a previously-saved imposto that was fully cleared', () => {
    const ops = buildImpostoWriteOps('p1', [imp({ id: 'op1' })], 1000);
    expect(ops).toEqual([{ type: 'delete', path: 'produtos/p1/imposto/op1' }]);
  });

  it('skips a pristine empty row (never persisted)', () => {
    expect(buildImpostoWriteOps('p1', [imp({})], 1000)).toEqual([]);
  });

  it('keeps an entry whose only value is an explicit compoeValorTotalDaNFe=false', () => {
    const ops = buildImpostoWriteOps('p1', [imp({ compoeValorTotalDaNFe: false })], 1000);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: 'set', path: 'produtos/p1/imposto/op1' });
  });

  it('extracts the operação id from a documents/operacao/<id> ref (resolver tolerance)', () => {
    // The schema is now strict bare `operacao/<id>`, but the runtime resolver
    // still tolerates a legacy `documents/operacao/<id>` value when reading docs.
    expect(operacaoIdFromImpostoRef('documents/operacao/opX')).toBe('opX');
    expect(
      impostoProdutoSchema.safeParse({ impostoOpercaoOuterRef: 'documents/operacao/opX' }).success,
    ).toBe(false);
  });
});

describe('kit "Gerar Variações" child flush (buildChildrenComponentesKitOps)', () => {
  it('updates each child produto doc with its map + sorted denorm keys', () => {
    const ops = buildChildrenComponentesKitOps([
      {
        id: 'childP',
        componentesKit: {
          cZeta: { quantidade: 2, limitarEstoque: true, timestamp: null },
          cAlpha: { quantidade: 1, limitarEstoque: false, timestamp: null },
        },
      },
    ]);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: 'update', path: 'produtos/childP' });
    if (ops[0]!.type !== 'update') throw new Error('expected an update op');
    // Keys are sorted (order-stable denorm for the array-contains delete guard).
    expect(ops[0]!.data.componentesKitKeys).toEqual(['cAlpha', 'cZeta']);
    expect(ops[0]!.data.componentesKit).toMatchObject({ cZeta: { quantidade: 2 } });
  });

  it('clears both fields for an empty/null map', () => {
    const ops = buildChildrenComponentesKitOps([
      { id: 'a', componentesKit: {} },
      { id: 'b', componentesKit: null },
    ]);
    expect(ops).toEqual([
      {
        type: 'update',
        path: 'produtos/a',
        data: { componentesKit: null, componentesKitKeys: null },
      },
      {
        type: 'update',
        path: 'produtos/b',
        data: { componentesKit: null, componentesKitKeys: null },
      },
    ]);
  });

  it('saveChildrenComponentesKit is a no-op for an empty children list', async () => {
    const { port, committed } = memoryPort();
    await saveChildrenComponentesKit(port, []);
    expect(committed).toEqual([]);
  });
});

describe('kit-status child propagation (buildKitStatusChildOps)', () => {
  const ids = [{ id: 'c1' }, { id: 'c2' }];

  it('is empty when neither ehKit nor ehKitVirtual changed', () => {
    expect(
      buildKitStatusChildOps(
        { ehKit: true, ehKitVirtual: false, oldEhKit: true, oldEhKitVirtual: false },
        ids,
      ),
    ).toEqual([]);
  });

  it('clears each child componentesKit when the parent stops being a kit', () => {
    const ops = buildKitStatusChildOps(
      { ehKit: false, ehKitVirtual: false, oldEhKit: true, oldEhKitVirtual: false },
      ids,
    );
    expect(ops).toEqual([
      {
        type: 'update',
        path: 'produtos/c1',
        data: { ehKit: false, ehKitVirtual: false, componentesKit: null, componentesKitKeys: null },
      },
      {
        type: 'update',
        path: 'produtos/c2',
        data: { ehKit: false, ehKitVirtual: false, componentesKit: null, componentesKitKeys: null },
      },
    ]);
  });

  it('syncs ehKit true without clearing componentesKit (child keeps its generated map)', () => {
    const ops = buildKitStatusChildOps(
      { ehKit: true, ehKitVirtual: false, oldEhKit: false, oldEhKitVirtual: false },
      [{ id: 'c1' }],
    );
    expect(ops).toEqual([
      { type: 'update', path: 'produtos/c1', data: { ehKit: true, ehKitVirtual: false } },
    ]);
  });

  it('propagates an ehKitVirtual flip while the parent stays a kit', () => {
    const ops = buildKitStatusChildOps(
      { ehKit: true, ehKitVirtual: true, oldEhKit: true, oldEhKitVirtual: false },
      [{ id: 'c1' }],
    );
    expect(ops).toEqual([
      { type: 'update', path: 'produtos/c1', data: { ehKit: true, ehKitVirtual: true } },
    ]);
  });

  it('collapses ehKitVirtual to false when the parent is not a kit', () => {
    const ops = buildKitStatusChildOps(
      { ehKit: false, ehKitVirtual: true, oldEhKit: true, oldEhKitVirtual: true },
      [{ id: 'c1' }],
    );
    if (ops[0]!.type !== 'update') throw new Error('expected an update op');
    expect(ops[0]!.data).toMatchObject({ ehKit: false, ehKitVirtual: false });
  });
});

describe('propagateKitStatusToChildren', () => {
  it('commits the child updates when the kit status changed', async () => {
    const { port, committed } = memoryPort({ children: [snap('c1', null), snap('c2', null)] });
    const updated = await propagateKitStatusToChildren(port, 'p1', {
      ehKit: false,
      ehKitVirtual: false,
      oldEhKit: true,
      oldEhKitVirtual: false,
    });
    expect(updated).toEqual(['c1', 'c2']);
    expect(committed).toHaveLength(1);
    expect(committed[0]?.[0]).toMatchObject({ type: 'update', path: 'produtos/c1' });
  });

  it('is a no-op when nothing changed', async () => {
    const { port, committed } = memoryPort({ children: [snap('c1', null)] });
    expect(
      await propagateKitStatusToChildren(port, 'p1', {
        ehKit: true,
        ehKitVirtual: true,
        oldEhKit: true,
        oldEhKitVirtual: true,
      }),
    ).toEqual([]);
    expect(committed).toEqual([]);
  });

  it('is a no-op when the parent has no variation children', async () => {
    const { port, committed } = memoryPort({ children: [] });
    expect(
      await propagateKitStatusToChildren(port, 'p1', {
        ehKit: false,
        ehKitVirtual: false,
        oldEhKit: true,
        oldEhKitVirtual: false,
      }),
    ).toEqual([]);
    expect(committed).toEqual([]);
  });
});

describe('resolveKitGuardInputs (agent/MCP kit-guard resolution #479)', () => {
  it('resolves componentKitIds to the components whose produto is itself a kit', async () => {
    const { port } = memoryPort({ kitFlags: { compKit: true, compPlain: false } });
    const out = await resolveKitGuardInputs(port, {
      componentesKit: { compKit: kitEntry(), compPlain: kitEntry() },
      paiId: null,
    });
    expect(out.componentKitIds).toEqual(['compKit']);
    expect(out.parentIsKit).toBeNull();
  });

  it('resolves parentIsKit=true when the paiId parent is a kit', async () => {
    const { port } = memoryPort({ kitFlags: { pai1: true } });
    const out = await resolveKitGuardInputs(port, { componentesKit: null, paiId: 'pai1' });
    expect(out.parentIsKit).toBe(true);
    expect(out.componentKitIds).toEqual([]);
  });

  it('resolves parentIsKit=false when the paiId parent is not a kit', async () => {
    const { port } = memoryPort({ kitFlags: { pai1: false } });
    const out = await resolveKitGuardInputs(port, { componentesKit: null, paiId: 'pai1' });
    expect(out.parentIsKit).toBe(false);
  });

  it('resolves parentIsKit as null (absent, not false) for a produto with no paiId', async () => {
    const { port, kitFlagCalls } = memoryPort();
    const out = await resolveKitGuardInputs(port, { componentesKit: null, paiId: null });
    expect(out).toEqual({ componentKitIds: [], parentIsKit: null });
    // No components and no parent → no doc read at all.
    expect(kitFlagCalls).toEqual([]);
  });

  it('treats an empty-string paiId as "no parent" (parentIsKit null, no read)', async () => {
    const { port, kitFlagCalls } = memoryPort();
    const out = await resolveKitGuardInputs(port, { componentesKit: null, paiId: '' });
    expect(out.parentIsKit).toBeNull();
    expect(kitFlagCalls).toEqual([]);
  });

  it('treats a component/parent id that resolves to no produto as a non-kit', async () => {
    // compGone / paiGone are absent from kitFlags → not returned by getKitFlags.
    const { port } = memoryPort({ kitFlags: { compKit: true } });
    const out = await resolveKitGuardInputs(port, {
      componentesKit: { compKit: kitEntry(), compGone: kitEntry() },
      paiId: 'paiGone',
    });
    expect(out.componentKitIds).toEqual(['compKit']);
    expect(out.parentIsKit).toBe(false);
  });

  it('drops an empty-string component key (invalid doc id) instead of reading it', async () => {
    const { port, kitFlagCalls } = memoryPort({ kitFlags: { compKit: true } });
    const out = await resolveKitGuardInputs(port, {
      componentesKit: { compKit: kitEntry(), '': kitEntry() },
      paiId: null,
    });
    expect(out.componentKitIds).toEqual(['compKit']);
    // The '' key never reaches the port (it would be an invalid Firestore ref).
    expect(kitFlagCalls[0]).not.toContain('');
    expect(kitFlagCalls[0]).toEqual(['compKit']);
  });

  it('batches all component ids + the paiId into a single getKitFlags call (deduped)', async () => {
    const { port, kitFlagCalls } = memoryPort({ kitFlags: { a: true, b: false, pai: true } });
    await resolveKitGuardInputs(port, {
      componentesKit: { a: kitEntry(), b: kitEntry() },
      paiId: 'pai',
    });
    expect(kitFlagCalls).toHaveLength(1);
    expect([...kitFlagCalls[0]!].sort()).toEqual(['a', 'b', 'pai']);
  });
});

describe('findProdutoReferences', () => {
  it('reports kit membership and deduped marketplace labels', async () => {
    const { port } = memoryPort({
      refs: {
        p1: {
          kits: [snap('k1', null, 'Kit A')],
          subcols: ['variacaoMercadoLivre', 'prodshopee'],
        },
      },
    });
    const refs = await findProdutoReferences(port, 'p1');
    expect(refs.kits).toEqual([{ id: 'k1', nome: 'Kit A' }]);
    expect(refs.marketplaces.sort()).toEqual(['Mercado Livre', 'Shopee']);
  });
});

describe('deleteProdutoCascade', () => {
  it('deletes only the parent when nothing references it (children cascade server-side)', async () => {
    // Children are still fetched + probed for the guard, but the client no longer
    // deletes them — the `onProdutoDeleted` trigger cascades children (#199) and
    // subcollections (#136). Only the parent doc is committed here.
    const { port, committed } = memoryPort({ children: [snap('c1', null, 'Variação P')] });
    await deleteProdutoCascade(port, 'p1');
    expect(committed).toEqual([[{ type: 'delete', path: 'produtos/p1' }]]);
  });

  it('throws ProdutoReferencedError and writes nothing when a target is referenced', async () => {
    const { port, committed } = memoryPort({
      children: [snap('c1', null)],
      refs: { c1: { subcols: ['produtoMercadoLivre'] } },
    });
    await expect(deleteProdutoCascade(port, 'p1')).rejects.toBeInstanceOf(ProdutoReferencedError);
    expect(committed).toEqual([]);
  });
});

/**
 * The two writes that turn a freshly created produto into a family of one.
 *
 * ⚠️ They belong to ONE atomic boundary. A parent written without its child
 * points at nothing; a child written without the pointer is invisible to every
 * surface that looks the family up. Both are wrong in ways nothing later
 * repairs, which is why this is a PAIR and the caller commits it as one.
 */
describe('buildMembroUnicoWriteOps', () => {
  const pai = { nome: 'Bandeja', sku: 'BAN-1' };

  it('creates the child and points the parent at it, in that order', () => {
    const ops = buildMembroUnicoWriteOps('p1', 'c1', pai);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ type: 'set', path: 'produtos/c1' });
    expect(ops[1]).toEqual({
      type: 'update',
      path: 'produtos/p1',
      data: { filhoUnicoId: 'c1' },
    });
  });

  it('writes the child under its OWN id, pointing back at the parent', () => {
    const [child] = buildMembroUnicoWriteOps('p1', 'c1', pai);
    expect(child!.path).toBe('produtos/c1');
    expect((child as { data: Record<string, unknown> }).data).toMatchObject({ paiId: 'p1' });
  });

  // ⚠️ The pointer goes through `derivarFilhoUnico`, the ONE producer of the
  // value — not set to `childId` directly. Same answer here, but routing every
  // writer through it is what keeps the denormalisation honest when a later
  // writer holds a child SET rather than a single id.
  it('refuses to point at an empty id', () => {
    const ops = buildMembroUnicoWriteOps('p1', '', pai);
    expect(ops[1]).toMatchObject({ data: { filhoUnicoId: null } });
  });
});

/**
 * ⛔ The kit flag and its map travel TOGETHER onto the sole member.
 *
 * The propagation used to clear `componentesKit` when the parent stopped being a
 * kit and write nothing when it BECAME one. A produto born as a family of one and
 * later turned into a kit therefore left its sole member `ehKit: true` with a
 * **null map** — and `calcularAlteracoesEstoque` reads exactly that as "kit with
 * no components" (`if (!componentes) continue;`), so a pedido line for it moved
 * NO stock: not the kit's own, not its components'. Silently, with a badge of 0
 * to match.
 */
describe('buildKitStatusChildOps — becoming a kit', () => {
  /** `ProdutoWriteOp` is a union and only the write arms carry `data`. */
  const dadosDe = (op: ProdutoWriteOp): Record<string, unknown> | undefined =>
    op.type === 'update' || op.type === 'set' ? op.data : undefined;

  const comp = { 'c-1': { quantidade: 6, limitarEstoque: true } };

  it('carries the map onto the sole member when ehKit goes true', () => {
    const ops = buildKitStatusChildOps(
      {
        ehKit: true,
        ehKitVirtual: false,
        oldEhKit: false,
        oldEhKitVirtual: false,
        componentesKit: comp,
        membroUnicoId: 'membro',
      },
      [{ id: 'membro' }],
    );

    expect(ops).toHaveLength(1);
    expect(dadosDe(ops[0]!)).toEqual({
      ehKit: true,
      ehKitVirtual: false,
      componentesKit: comp,
      componentesKitKeys: ['c-1'],
    });
  });

  // ⚠️ The near-miss, and the reason the write is scoped by the pointer. A real
  // variation authors its own composition through `buildChildrenComponentesKitOps`,
  // and copying the parent's over it would destroy a per-variation kit.
  it('gives a REAL variation the flags only, never the parent’s map', () => {
    const ops = buildKitStatusChildOps(
      {
        ehKit: true,
        ehKitVirtual: false,
        oldEhKit: false,
        oldEhKitVirtual: false,
        componentesKit: comp,
        membroUnicoId: 'membro',
      },
      [{ id: 'variacao-p' }],
    );

    expect(dadosDe(ops[0]!)).toEqual({ ehKit: true, ehKitVirtual: false });
  });

  // Without the pointer the arm is inert — the pre-#1398 behaviour, so a produto
  // with real variations and no sole member is untouched by this change.
  it('is inert when the parent has no sole member', () => {
    const ops = buildKitStatusChildOps(
      {
        ehKit: true,
        ehKitVirtual: false,
        oldEhKit: false,
        oldEhKitVirtual: false,
        componentesKit: comp,
      },
      [{ id: 'c1' }],
    );

    expect(dadosDe(ops[0]!)).toEqual({ ehKit: true, ehKitVirtual: false });
  });

  // The direction that was always right must survive: a non-kit keeps no map.
  it('still clears the map on the sole member when ehKit goes false', () => {
    const ops = buildKitStatusChildOps(
      {
        ehKit: false,
        ehKitVirtual: false,
        oldEhKit: true,
        oldEhKitVirtual: false,
        componentesKit: comp,
        membroUnicoId: 'membro',
      },
      [{ id: 'membro' }],
    );

    expect(dadosDe(ops[0]!)).toEqual({
      ehKit: false,
      ehKitVirtual: false,
      componentesKit: null,
      componentesKitKeys: null,
    });
  });
});
