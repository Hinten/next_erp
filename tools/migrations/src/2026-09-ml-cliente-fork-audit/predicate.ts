import { identityValue } from '@delfrance/schemas';

/**
 * Pure classification for the #1408 audit: for each Mercado Livre pedido, does
 * the cliente it is linked to actually own the buyer's `idMercadoLivre`?
 *
 * No Firestore here — `audit.ts` owns the walk. `identityValue` is imported
 * rather than re-implemented so "a usable id" means exactly what
 * `findOrCreateCliente`'s cascade leg means by it: a non-empty TRIMMED string.
 * Comparing an untrimmed value here while the runtime queries the trimmed one
 * would report forks that do not exist.
 *
 * ## Why the population exists
 *
 * Until #1407 the ML ORDER import supplied no `idMercadoLivre`, so its cascade
 * leg was always null on that path and every order matched on cpf_cnpj,
 * telefone or e-mail. A buyer who asked a QUESTION before ordering therefore got
 * two documents: one keyed on their ML id by `questionImport`, and one built
 * from the billing identity by `orderImport`. #1407 stops that happening; it
 * repairs nothing already split, and this counts what is there.
 *
 * ⚠️ **Read-only, and a count is not a repair.** Merging two clientes moves
 * pedidos, conversas and endereços — a migration and a human decision, not
 * something this script may infer in bulk.
 */

/**
 * ⚠️ Ordered from "cannot be assessed" through "actively wrong". The classifier
 * returns exactly one, and the first matching rule wins — `dono-duplicado`
 * outranks `fork` because a doubly-owned id makes the match leg ambiguous for
 * everyone, not just for this pedido.
 */
export type ForkAuditKind =
  /**
   * The mirror is ORPHAN DEBRIS: its parent pedido was deleted.
   *
   * ⚠️ Checked FIRST, and it is not hypothetical. `pedidoMeta` declares a
   * cascade over `pedidos/{id}/orderML` but that cascade is **deliberately not
   * enforced** — there is no `onPedidoDeleted` trigger, a decision already made
   * and rejected (`nfev4` holds fiscal records the business must retain), so
   * `pedidoMeta` states outright that deleting a pedido ORPHANS these
   * subcollections. `caroGenericoTriggers.ts` registers only integracao,
   * int_frete, metodoPagamento and conversa.
   *
   * The collection-group walk therefore reaches every deleted ML pedido's
   * mirror, and the Firestore import carries them across the window unchanged.
   * Without this kind they read as `pedido-sem-cliente` — an ACTIONABLE finding
   * about a pedido that does not exist, inflating the very count this audit
   * exists to produce.
   */
  | 'pedido-ausente'
  /** The `orderML` mirror carries no buyer id — nothing to check. */
  | 'sem-buyer-id'
  /**
   * The buyer id is past 2^53, so `JSON.parse` already rounded it and two
   * accounts may share this number.
   *
   * ⚠️ This is a REPORT about a refusal, not a second copy of it: the runtime
   * declines to stamp such an id (`safeMlUserId`), which means these pedidos
   * stay unstamped permanently rather than self-healing after the deploy. That
   * consequence is the reason the kind exists — the audit would otherwise file
   * them under `nao-carimbado` and imply they will fix themselves.
   */
  | 'buyer-id-inseguro'
  /**
   * A PACK whose child orders name different buyers. Not expected — a pack is
   * one buyer's cart — so it is surfaced rather than resolved by picking one.
   */
  | 'buyers-divergentes'
  /** The import never linked a cliente (`clientePedidoOuterRef` is null). */
  | 'pedido-sem-cliente'
  /** The link points at a cliente document that no longer exists. */
  | 'cliente-ausente'
  /**
   * TWO OR MORE clientes carry this id. The worst kind: `findOrCreateCliente`'s
   * third leg takes the first row of a page, so every later delivery repeats the
   * same arbitrary pick. #1407's guard refuses to CREATE this state but cannot
   * undo one already there.
   */
  | 'dono-duplicado'
  /**
   * Exactly one cliente owns the id and it is NOT this pedido's — the split
   * this audit exists to count.
   */
  | 'fork'
  /**
   * Nobody owns the id and this pedido's cliente carries a DIFFERENT one.
   *
   * ⚠️ Predictive, not historical: two ML accounts share one cliente today, and
   * under #1407 the NEXT order from this buyer will be REFUSED at the cpf_cnpj
   * leg and fork into a second cliente carrying the same CPF. That is the
   * documented, intended trade — but these rows are where it will land, so they
   * are worth seeing before the deploy rather than after.
   */
  | 'cliente-com-outro-id'
  /**
   * Nobody owns the id and this pedido's cliente carries none. The COMMON
   * pre-#1407 shape, and the benign one: the next import of this buyer stamps
   * it, so these self-heal once the ML backend deploys.
   */
  | 'nao-carimbado'
  /** The pedido's cliente owns exactly this buyer id. Nothing to do. */
  | 'ok';

/**
 * Kinds that are findings. The four NOT here are the quiet ones: `ok`,
 * `sem-buyer-id`, `pedido-ausente` (debris from a deleted pedido — not a cliente
 * problem at all) and — deliberately — `nao-carimbado`, the big benign
 * background population that self-heals on the next import once #1407 deploys.
 * Counting those would drown the forks this audit exists to surface; the
 * per-kind tally still reports every one of them.
 */
export const KINDS_ACIONAVEIS: readonly ForkAuditKind[] = [
  'buyer-id-inseguro',
  'buyers-divergentes',
  'pedido-sem-cliente',
  'cliente-ausente',
  'dono-duplicado',
  'fork',
  'cliente-com-outro-id',
];

export interface ForkAuditInput {
  readonly pedidoPath: string;
  /** Distinct `buyer.id` values across the pedido's `orderML` mirror docs. */
  readonly buyerIdsBrutos: readonly unknown[];
  /**
   * Whether the parent pedido still exists. `false` means the mirror is orphan
   * debris — see `pedido-ausente`.
   */
  readonly pedidoExiste: boolean;
  /** Resolved from `clientePedidoOuterRef`; `null` when the pedido has none. */
  readonly clienteId: string | null;
  /** Whether that cliente document exists. */
  readonly clienteExiste: boolean;
  /** `idMercadoLivre` stored on the pedido's cliente. */
  readonly idMlDoCliente: unknown;
  /**
   * Every cliente carrying the buyer's id. Supplied by the caller because it
   * comes from a scan; the classifier stays pure.
   */
  readonly donosDoBuyerId: readonly string[];
}

export interface ForkAuditRow {
  readonly pedidoPath: string;
  readonly kind: ForkAuditKind;
  readonly buyerId: string | null;
  readonly clienteDoPedido: string | null;
  readonly idMlDoCliente: string | null;
  readonly donos: readonly string[];
}

/**
 * A buyer id from the `orderML` mirror as the cascade leg would query it, or
 * `null` when there is none.
 *
 * ⚠️ `Number.isSafeInteger` is checked SEPARATELY (see `buyer-id-inseguro`)
 * rather than folded in here: an unsafe id is a finding, and collapsing it to
 * `null` would file it under "no buyer id" and hide it.
 */
export function normalizarBuyerId(bruto: unknown): string | null {
  if (typeof bruto === 'number') return Number.isFinite(bruto) ? String(bruto) : null;
  return identityValue(bruto);
}

/** True when the raw value is a number JSON.parse could not represent exactly. */
export function buyerIdInseguro(bruto: unknown): boolean {
  return typeof bruto === 'number' && Number.isFinite(bruto) && !Number.isSafeInteger(bruto);
}

/** Classify one pedido. Always returns a row — `ok` is a verdict, not an absence. */
export function auditPedidoCliente(input: ForkAuditInput): ForkAuditRow {
  const distintos = [
    ...new Set(input.buyerIdsBrutos.map(normalizarBuyerId).filter((v) => v != null)),
  ];
  const buyerId = distintos.length === 1 ? distintos[0]! : null;
  const idMlDoCliente = identityValue(input.idMlDoCliente);
  const base = {
    pedidoPath: input.pedidoPath,
    buyerId,
    clienteDoPedido: input.clienteId,
    idMlDoCliente,
    donos: input.donosDoBuyerId,
  };

  // FIRST: a mirror whose pedido is gone says nothing about any cliente, and
  // reading it as `pedido-sem-cliente` would file debris as a finding.
  if (!input.pedidoExiste) return { ...base, kind: 'pedido-ausente' };
  if (distintos.length === 0) return { ...base, kind: 'sem-buyer-id' };
  if (distintos.length > 1) {
    return { ...base, kind: 'buyers-divergentes', donos: [] };
  }
  // Checked AFTER "is there one id at all" so an unsafe value is reported as
  // unsafe rather than as missing.
  if (input.buyerIdsBrutos.some(buyerIdInseguro)) {
    return { ...base, kind: 'buyer-id-inseguro' };
  }
  if (input.clienteId == null) return { ...base, kind: 'pedido-sem-cliente' };
  if (!input.clienteExiste) return { ...base, kind: 'cliente-ausente' };

  if (input.donosDoBuyerId.length > 1) return { ...base, kind: 'dono-duplicado' };
  if (input.donosDoBuyerId.length === 1) {
    return input.donosDoBuyerId[0] === input.clienteId
      ? { ...base, kind: 'ok' }
      : { ...base, kind: 'fork' };
  }
  return idMlDoCliente == null
    ? { ...base, kind: 'nao-carimbado' }
    : { ...base, kind: 'cliente-com-outro-id' };
}
