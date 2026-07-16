import type { PedidoDevolucaoDataPort, PedidoDocData, PedidoWriteOp } from './port';

/**
 * In-memory {@link PedidoDevolucaoDataPort} for unit tests — NOT exported from
 * the package (tests import it relatively, like the inline `fakePort` in
 * `usecases.test.ts`). Docs live in a single path-keyed map; `transact`/`commit`
 * apply ops atomically (stage then swap, so a thrown `apply` leaves zero
 * mutation, mirroring a real aborted transaction).
 */
export function createFakeDevolucaoPort(init?: {
  /** Seed docs by full path (e.g. `pedidos/o1`, `counters/pedido`, `operacao/op1`). */
  docs?: Record<string, Record<string, unknown> | null>;
  /** Fixed µs-epoch clock (default 1_700_000_000_000_000). */
  now?: number;
  /** What `findOperacaoEntradaPadrao` resolves to (default null). */
  operacaoEntradaPadrao?: { id: string; data: Record<string, unknown> } | null;
  /** What `listNFesAprovadas` returns per pedido id (default none). */
  nfesAprovadasByPedido?: Record<string, Array<Record<string, unknown>>>;
  /**
   * What `hasNFe` returns per pedido id. Unset ids fall back to whether
   * `nfesAprovadasByPedido` holds any doc for the pedido — set this only when
   * a pedido has non-aprovada NF-es the aprovadas map can't express.
   */
  hasNFeByPedido?: Record<string, boolean>;
}): {
  port: PedidoDevolucaoDataPort;
  /** Live doc store — inspect after a flow to assert the committed state. */
  docs: Map<string, Record<string, unknown> | null>;
  /** Every op that went through `commit`, in order. */
  committed: PedidoWriteOp[];
  /** The op list of each successful `transact`, in order. */
  txWrites: PedidoWriteOp[][];
} {
  const docs = new Map<string, Record<string, unknown> | null>();
  for (const [path, data] of Object.entries(init?.docs ?? {})) {
    docs.set(path, data === null ? null : structuredClone(data));
  }
  const committed: PedidoWriteOp[] = [];
  const txWrites: PedidoWriteOp[][] = [];
  const now = init?.now ?? 1_700_000_000_000_000;
  let idSeq = 0;

  const readDoc = (path: string): PedidoDocData => structuredClone(docs.get(path) ?? null);

  /** Apply ops onto a staging copy; only the caller swaps it in on success. */
  const applyOps = (staged: Map<string, Record<string, unknown> | null>, ops: PedidoWriteOp[]) => {
    for (const op of ops) {
      if (op.type === 'set') {
        staged.set(op.path, structuredClone(op.data));
      } else if (op.type === 'update') {
        const current = staged.get(op.path);
        if (current == null) {
          throw new Error(`fake port: update on missing doc "${op.path}"`);
        }
        staged.set(op.path, { ...current, ...structuredClone(op.data) });
      } else {
        staged.delete(op.path);
      }
    }
  };

  const swapIn = (staged: Map<string, Record<string, unknown> | null>) => {
    docs.clear();
    for (const [path, data] of staged) docs.set(path, data);
  };

  const port: PedidoDevolucaoDataPort = {
    now: () => now,
    newId: () => `id${++idSeq}`,

    async updatePedido(pedidoId, apply) {
      const path = `pedidos/${pedidoId}`;
      const patch = apply(readDoc(path));
      if (Object.keys(patch).length === 0) return;
      const staged = new Map(docs);
      applyOps(staged, [{ type: 'update', path, data: patch }]);
      swapIn(staged);
    },

    async commit(ops) {
      const staged = new Map(docs);
      applyOps(staged, ops);
      swapIn(staged);
      committed.push(...ops);
    },

    async transact({ reads, apply }) {
      const txDocs = new Map<string, PedidoDocData>();
      for (const path of new Set(reads)) txDocs.set(path, readDoc(path));
      const ops = apply(txDocs);
      const staged = new Map(docs);
      applyOps(staged, ops);
      swapIn(staged);
      txWrites.push(ops);
    },

    async getPedido(pedidoId) {
      return readDoc(`pedidos/${pedidoId}`);
    },

    async getIntegracao(integracaoId) {
      return readDoc(`integracao/${integracaoId}`);
    },

    async getOperacao(operacaoId) {
      return readDoc(`operacao/${operacaoId}`);
    },

    async findOperacaoEntradaPadrao() {
      const padrao = init?.operacaoEntradaPadrao ?? null;
      return padrao === null ? null : structuredClone(padrao);
    },

    async listNFesAprovadas(pedidoId) {
      return structuredClone(init?.nfesAprovadasByPedido?.[pedidoId] ?? []);
    },

    async hasNFe(pedidoId) {
      return (
        init?.hasNFeByPedido?.[pedidoId] ??
        (init?.nfesAprovadasByPedido?.[pedidoId] ?? []).length > 0
      );
    },
  };

  return { port, docs, committed, txWrites };
}
