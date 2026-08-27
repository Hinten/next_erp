import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';
import { outerRefSchema } from './shared/outerRef';
import type { CollectionMetadata } from './types';

// Balanço rides the same `PERM.estoque` domain (bits 64–66) as `deposito`,
// `estoque` and `historicoEstoque` — it is an inventory operation, not a
// domain of its own. Duplicated locally to avoid a circular dep on
// @delfrance/auth, like every other schema in this package.
const PERM_ESTOQUE_READ = 1n << 64n;
const PERM_ESTOQUE_WRITE = 1n << 65n;
const PERM_ESTOQUE_DELETE = 1n << 66n;

/**
 * The states a balanço is ever WRITTEN into. There is deliberately no `aberto`
 * member — see {@link balancoSchema}: an open balanço stores `estado: null`.
 *
 * The legacy Flutter enum had five (`iniciado`, `emProcessamento`,
 * `gerandoFinalizacao`, `finalizado`, `error`); the first two collapsed into
 * "open" (the `iniciado → emProcessamento` hop existed only to record that
 * someone had started counting, which the movimentos subcollection already
 * says), and `error` was declared but never written by anything.
 */
export const ESTADO_BALANCO_VALUES = ['finalizando', 'finalizado', 'erro'] as const;

export const ESTADO_BALANCO_LABELS = {
  finalizando: 'Finalizando',
  finalizado: 'Finalizado',
  erro: 'Erro',
} as const;

export const estadoBalancoSchema = z
  .enum(ESTADO_BALANCO_VALUES)
  .meta({ labels: ESTADO_BALANCO_LABELS });
export type EstadoBalanco = z.infer<typeof estadoBalancoSchema>;

/**
 * Named members of {@link estadoBalancoSchema} — the only way to write one of
 * these in code (enforced by the `delfrance/prefer-schema-enum` lint rule,
 * which fires for any Zod enum carrying a companion constant like this).
 */
export const ESTADO_BALANCO = {
  finalizando: 'finalizando',
  finalizado: 'finalizado',
  erro: 'erro',
} as const satisfies Record<string, EstadoBalanco>;

/** What the UI shows — the stored states plus the unstored `'aberto'`. */
export type EstadoBalancoVisivel = 'aberto' | EstadoBalanco;

export const ESTADO_BALANCO_VISIVEL_LABELS: Record<EstadoBalancoVisivel, string> = {
  aberto: 'Aberto',
  ...ESTADO_BALANCO_LABELS,
};

/**
 * The finalize job's checkpoint — written ONLY by the `finalizarBalanco`
 * callable and its `processarBalanco` task worker (`apps/functions`), never by
 * a client. It is what makes the job resumable: the worker persists how far it
 * got, so a timeout, a crash or a Cloud Tasks retry picks up at `shardCursor`
 * instead of re-applying stock from the beginning.
 *
 * `shards` is null until the work list has been frozen into the `relatorios`
 * subcollection (phase A); from then on the worker walks shards
 * `shardCursor … shards - 1` (phase B).
 */
export const finalizacaoBalancoSchema = z
  .object({
    /** ms since epoch — when the callable took the lock. */
    iniciadoEm: millisSinceEpoch('Início da finalização').nullable().default(null),
    /** Who pressed finalize. Stamped from the callable's auth, never the payload. */
    usuarioOuterRef: outerRefSchema.nullable().default(null),
    /** Whether uncounted produtos holding stock in the depósito are set to 0. */
    zerarNaoContados: z.boolean().default(false),
    /** Total `relatorios` shards, or null while phase A is still building them. */
    shards: z.number().int().nullable().default(null),
    /** Index of the next shard to apply. `shardCursor === shards` ⇒ done. */
    shardCursor: z.number().int().default(0),
    /** Produtos whose stock was actually written (progress display only). */
    produtosAplicados: z.number().int().default(0),
    /** Set with `estado: 'erro'` when the job gave up on its last retry. */
    erro: z.string().max(2000).nullable().default(null),
  })
  .passthrough();

export type FinalizacaoBalanco = z.infer<typeof finalizacaoBalancoSchema>;

/**
 * Balanço — one stock count over one depósito (`balanco/{id}`). Mirrors the
 * intent of the Flutter `BalancoEstoque`, not its wire shape: the legacy
 * feature was never used in production, so this is a redesign rather than a
 * port (field names follow this repo's conventions — `timestamp` /
 * `ultimaModificacao`, not `dataCadastro`).
 *
 * ## `estado: null` IS "aberto"
 *
 * ⚠️ There is no stored `'aberto'`. That is not a shortcut — it is what makes
 * the workflow lock unforgeable. `estado`, `dataFinalizado` and `finalizacao`
 * are all in `meta.serverOwnedFields`, and that mechanism allows a client
 * CREATE only when the value is `null` and denies **every** client UPDATE that
 * touches the field (no `su` bypass). So a client can open a balanço and can
 * never move it forward, backward, or back to open once the server has taken
 * it. A stored `'aberto'` would need to be client-writable to be created,
 * which would let anyone with `PERM.estoque.write` reset a finalized count and
 * re-apply it over whatever stock movements happened since.
 *
 * Nothing should compare `estado` against null by hand — call
 * {@link estadoBalanco} / {@link balancoAceitaLancamento} /
 * {@link podeFinalizarBalanco}.
 *
 * ## Why the count is server-applied
 *
 * The legacy finalize ran in the browser: it overwrote `estoque.quantidade`,
 * deleted estoque docs and wrote the audit trail from client-supplied values,
 * with no server check that any of it corresponded to a real balanço. This
 * port keeps only the *counting* on the client (the `movimentos` subcollection
 * below, which is a tally, not stock); everything that lands on `estoques` /
 * `historicoEstoque` goes through the `finalizarBalanco` callable.
 */
export const balancoSchema = z
  .object({
    nome: z.string().min(1).max(255).describe('Nome'),
    depositoOuterRef: outerRefSchema.describe('Depósito'),

    // Server-owned workflow state (see the docblock above) -------------------
    estado: estadoBalancoSchema.nullable().default(null).describe('Estado'),
    dataFinalizado: millisSinceEpoch('Finalizado em').nullable().default(null),
    finalizacao: finalizacaoBalancoSchema.nullable().default(null),

    // System fields — stamped by `saveRecord` on every write.
    timestamp: millisSinceEpoch('Criação').nullable().optional(),
    ultimaModificacao: millisSinceEpoch('Última modificação').nullable().optional(),
  })
  .passthrough();

export type Balanco = z.infer<typeof balancoSchema>;

/** The balanço's state including the unstored `'aberto'` (`estado === null`). */
export function estadoBalanco(b: Pick<Balanco, 'estado'>): EstadoBalancoVisivel {
  return b.estado ?? 'aberto';
}

/** True while the balanço still accepts lançamentos. */
export function balancoAceitaLancamento(b: Pick<Balanco, 'estado'>): boolean {
  return b.estado == null;
}

/**
 * True when `finalizarBalanco` may take the lock: the balanço has never been
 * applied (`dataFinalizado == null`) AND it is either open or parked in
 * `erro` — the retry path the legacy client never had, where a crashed run
 * left `gerandoFinalizacao` stuck forever with no way out.
 *
 * ⚠️ `dataFinalizado` is the load-bearing half. Both fields are server-owned,
 * but `dataFinalizado` is the one that is only ever set once and never
 * cleared, so it holds even if a future change makes `estado` writable again.
 */
export function podeFinalizarBalanco(b: Pick<Balanco, 'estado' | 'dataFinalizado'>): boolean {
  return b.dataFinalizado == null && (b.estado == null || b.estado === ESTADO_BALANCO.erro);
}

export const balancoMeta: CollectionMetadata = {
  collectionPath: 'balanco',
  permissions: {
    read: PERM_ESTOQUE_READ,
    write: PERM_ESTOQUE_WRITE,
    delete: PERM_ESTOQUE_DELETE,
  },
  // The list screen: newest count first.
  defaultQuery: {
    orderBy: [{ field: 'timestamp', direction: 'desc' }],
    limit: 50,
    columns: ['nome', 'estado', 'timestamp', 'dataFinalizado'],
  },
  serverOwnedFields: ['estado', 'dataFinalizado', 'finalizacao'],
};

export const balanco = { schema: balancoSchema, meta: balancoMeta };

/**
 * MovimentoBalanco — one lançamento (`balanco/{balancoId}/movimentos/{id}`).
 * Append-only from the client: a scan or a manual entry writes one doc, and
 * cancelling sets `removido: true` rather than deleting, so the tally keeps a
 * record of what was withdrawn.
 *
 * A row is one of three kinds:
 *  - a normal count — `produtoOuterRef` + `produtoId` set, `error: false`;
 *  - an **error** — `error: true`, produto refs null, `errorInput` carrying the
 *    text that failed (an unknown or duplicated SKU, a kit) and `errorMessage`
 *    the reason. Failures are persisted rather than dropped so nothing counted
 *    on the warehouse floor is silently lost;
 *  - a **cancelled** row — `removido: true`, excluded from every total.
 *
 * ⚠️ `produtoId` duplicates the id already inside `produtoOuterRef` on purpose:
 * it is the **group key** the finalize aggregate groups by. Grouping on the ref
 * would mean parsing a path in the aggregate (legacy did `.split('/').last` at
 * every call site) — the same lesson `historicoEstoque` v2 learned when it
 * added `parentId` + `depositoOuterRef`.
 */
export const movimentoBalancoSchema = z
  .object({
    produtoOuterRef: outerRefSchema.nullable().default(null).describe('Produto'),
    /** Bare produto doc id — the aggregate group key. Null on error rows. */
    produtoId: z.string().nullable().default(null),
    /**
     * Units counted. Integer: a balanço is people counting things. (The
     * `estoque.quantidade` it eventually writes is a double, which is why the
     * aggregate's sum is widened before it reaches `planMovimentacao`.)
     * Error rows carry 0 — they are excluded from every total anyway, and a
     * phantom 1 would be a lie if the filter were ever dropped.
     */
    quantidade: z.number().int().default(0).describe('Quantidade'),
    usuarioOuterRef: outerRefSchema.nullable().default(null).describe('Usuário'),
    /** Soft cancel — never a delete, so the withdrawal itself stays auditable. */
    removido: z.boolean().default(false).describe('Removido'),
    error: z.boolean().default(false).describe('Erro'),
    /** The raw text that failed (scanned SKU, produto name). */
    errorInput: z.string().max(255).nullable().default(null),
    errorMessage: z.string().max(500).nullable().default(null),
    timestamp: millisSinceEpoch('Lançado em').nullable().default(null),
  })
  .passthrough();

export type MovimentoBalanco = z.infer<typeof movimentoBalancoSchema>;

export const movimentoBalancoMeta: CollectionMetadata = {
  collectionPath: 'balanco/{balancoId}/movimentos',
  permissions: {
    read: PERM_ESTOQUE_READ,
    write: PERM_ESTOQUE_WRITE,
    delete: PERM_ESTOQUE_DELETE,
  },
  // Every read of this collection is scoped to one balanço, so the generator's
  // default `{path=**}/movimentos` group-read block would only widen the query
  // surface for nothing. The legacy ruleset had exactly that block and it was
  // flagged as a leak (#454).
  noCollectionGroupRead: true,
};

export const movimentoBalanco = { schema: movimentoBalancoSchema, meta: movimentoBalancoMeta };

/**
 * One produto's line in the stored report. `estoque` is the quantity the
 * finalize actually replaced (read inside the applying transaction, so it is
 * the real "before", not whatever the browser happened to have cached — the
 * legacy report recorded the latter).
 *
 * `sku` / `nome` are denormalized so the finalized report view and its CSV are
 * a pure read of these shards; legacy re-fetched every produto in batches of
 * 30 to render the same table.
 */
export const itemRelatorioBalancoSchema = z.object({
  sku: z.string().nullable().default(null),
  nome: z.string().nullable().default(null),
  /** `estoque.quantidade` immediately before the count was applied. */
  estoque: z.number().nullable().default(null),
  /** Units counted. Null means the produto was never counted (a `zerar` row). */
  contado: z.number().nullable().default(null),
  /**
   * Extra `estoques` docs found for this produto+depósito beyond the canonical
   * `est-<produtoId>-<depositoId>`. Legacy silently DELETED these; this port
   * leaves them alone and reports them, because a doc nobody can explain is not
   * a doc to destroy during an inventory count.
   */
  estoquesExtras: z.number().int().nullable().default(null),
});

export type ItemRelatorioBalanco = z.infer<typeof itemRelatorioBalancoSchema>;

/**
 * RelatorioBalanco — one shard of the finalize snapshot
 * (`balanco/{balancoId}/relatorios/{0000|0001|…}`), keyed by bare produto id.
 *
 * The shards are written in phase A of the finalize job and then walked in
 * order in phase B, so they are both the report AND the job's frozen work
 * list. Shard ids are deterministic ({@link relatorioBalancoShardId}) so a
 * retried phase A overwrites its own shards instead of duplicating them.
 */
export const relatorioBalancoSchema = z
  .object({
    itens: z.record(z.string(), itemRelatorioBalancoSchema).default({}),
    timestamp: millisSinceEpoch('Gerado em').nullable().default(null),
  })
  .passthrough();

export type RelatorioBalanco = z.infer<typeof relatorioBalancoSchema>;

/**
 * Produtos per `relatorios` shard. Legacy used 1000 and stored two numbers per
 * entry; these entries also carry `sku` + `nome`, so the bound is halved to
 * stay clear of Firestore's 1 MiB document limit (500 × ~200 B ≈ 100 KB, with
 * room for pathological names).
 */
export const RELATORIO_BALANCO_SHARD_SIZE = 500;

/** Deterministic shard doc id — zero-padded so lexical order IS shard order. */
export function relatorioBalancoShardId(index: number): string {
  return String(index).padStart(4, '0');
}

export const relatorioBalancoMeta: CollectionMetadata = {
  collectionPath: 'balanco/{balancoId}/relatorios',
  permissions: {
    read: PERM_ESTOQUE_READ,
    write: PERM_ESTOQUE_WRITE,
    delete: PERM_ESTOQUE_DELETE,
  },
  // The report IS the audit record of a stock mutation — only the finalize job
  // writes it. Client writes are denied outright (no `su` bypass), which also
  // means the client cannot cascade a balanço delete: `onBalancoDeleted`
  // (apps/functions) sweeps the subtree instead.
  serverOwned: true,
  noCollectionGroupRead: true,
};

export const relatorioBalanco = { schema: relatorioBalancoSchema, meta: relatorioBalancoMeta };
