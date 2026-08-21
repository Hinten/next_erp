/**
 * Pure decision for the `conversa.clienteOuterRef` backfill.
 *
 * The chat inbox's Cliente filter matches ONE field. Every Mercado Livre
 * importer writes `clienteOuterRef` (#768) and WhatsApp now does too (#1159),
 * but a Firestore `==` cannot OR two fields — so as long as part of the corpus
 * carries only `usarioOuterRef`, filtering by a customer silently returns half
 * their threads. This pass converges the stored data onto the one field so the
 * read side can stay a single equality forever.
 *
 * ---- The mapping. A conversa names its contact as `documents/usuarios/<uid>`;
 * the cliente behind it is whichever `clientes` doc carries a matching
 * `userCliente`. That is the same second hop the chat UI does today
 * (`useClienteLink`), executed once here instead of on every render.
 *
 * ⚠️ `userCliente` is stored in BOTH shapes — `documents/usuarios/<uid>` (what
 * `usuarioOuterRef()` writes) and the bare `usuarios/<uid>` the legacy corpus
 * carries. The index below normalizes both to a bare uid, because Firestore
 * cannot normalize a stored value inside a `where` and a single-shape match
 * would silently miss half the population.
 *
 * ---- What this will NOT do.
 *
 * A conversa whose usuario resolves to **no** cliente, or to **more than one**,
 * is reported and left exactly as found. Both are real data conditions and
 * neither has a safe guess:
 *
 *  - `sem-cliente` — the contact was never paired, or its cliente was deleted.
 *    Writing a ref derived from the uid would point the filter at a `clientes`
 *    doc that does not exist, which is strictly worse than the absent field the
 *    UI already handles.
 *  - `ambiguo` — two clientes claim the same usuario. That is the duplicated
 *    identity #1067 exists to prevent; picking the lower doc id would hide a
 *    defect behind a coin flip, and merging clientes is a decision for a human,
 *    never a side effect of a backfill.
 *
 * Same discipline as the `depositoOuterRef` pass: an unrecognized value is
 * reported, never guessed at, because a plausible-looking wrong pointer is
 * harder to find later than an obvious gap.
 *
 * ---- Idempotent: a conversa that already carries `clienteOuterRef` is
 * `ja-normalizado` and is never written, so a re-run after an interrupted pass
 * touches only what is left — and a clean second pass reporting zero `resolvido`
 * IS the verification step.
 */
import { parseRef } from '@delfrance/schemas';

/** The `clientes` collection name, as it appears in an outer ref. */
export const COLECAO_CLIENTES = 'clientes';
/** The collection a `usarioOuterRef` must point at to be usable. */
export const COLECAO_USUARIOS = 'usuarios';

/** `documents/clientes/<id>` — the form every writer in this repo emits. */
export function clienteOuterRefFor(clienteId: string): string {
  return `documents/${COLECAO_CLIENTES}/${clienteId}`;
}

/** One `clientes` row, reduced to what the mapping needs. */
export interface ClienteRow {
  readonly id: string;
  readonly userCliente: unknown;
}

/**
 * uid → the cliente doc ids claiming it.
 *
 * An array rather than a single id **on purpose**: collapsing duplicates here
 * would destroy the very signal `ambiguo` reports. Doc ids are sorted so a
 * report is stable across runs.
 */
export type ClientesPorUsuario = ReadonlyMap<string, readonly string[]>;

/**
 * Build the uid → clientes index from every `clientes` row.
 *
 * Rows with a null/empty/non-string `userCliente` are simply absent — they link
 * to no usuario, which is the normal state for a cliente created through the
 * ERP's own cadastro screen.
 */
export function indexarClientesPorUsuario(rows: Iterable<ClienteRow>): ClientesPorUsuario {
  const porUsuario = new Map<string, string[]>();
  for (const row of rows) {
    if (typeof row.userCliente !== 'string' || row.userCliente === '') continue;
    const { collection, id } = parseRef(row.userCliente);
    // A `userCliente` naming some other collection is not a usuario link. Skip
    // rather than index it under a uid it does not actually reference.
    if (collection !== COLECAO_USUARIOS || id === '') continue;
    const atual = porUsuario.get(id);
    if (atual) atual.push(row.id);
    else porUsuario.set(id, [row.id]);
  }
  for (const ids of porUsuario.values()) ids.sort();
  return porUsuario;
}

/** What the migration decided about one conversa. */
export type ConversaClienteRefVerdict =
  /** `clienteOuterRef` is already set — nothing to write. */
  | { kind: 'ja-normalizado' }
  /** No `usarioOuterRef` either: an anonymous conversa, nothing to map from. */
  | { kind: 'sem-usuario' }
  /** Exactly one cliente claims the usuario — the ref is written. */
  | { kind: 'resolvido'; de: string; para: string; clienteId: string }
  /** A `usarioOuterRef` that does not name a `usuarios` doc. Left untouched. */
  | { kind: 'ref-invalida'; valor: unknown; motivo: string }
  /** No cliente carries this `userCliente`. Left untouched. */
  | { kind: 'sem-cliente'; usuarioId: string }
  /** Two or more clientes claim it. Left untouched — a human decides. */
  | { kind: 'ambiguo'; usuarioId: string; clienteIds: readonly string[] };

/** A conversa doc, reduced to the two fields this pass reads. */
export interface ConversaRow {
  readonly clienteOuterRef: unknown;
  readonly usarioOuterRef: unknown;
}

/**
 * Decide what to do with one conversa.
 *
 * ⚠️ The `ja-normalizado` check comes FIRST and treats any non-empty string as
 * set. A conversa written by a current ML importer or by the WhatsApp pipeline
 * after #1159 already carries the right value; re-deriving it from the usuario
 * hop could only disagree, and disagreeing with a live writer is how a backfill
 * turns into a regression.
 */
export function planConversaClienteRef(
  conversa: ConversaRow,
  porUsuario: ClientesPorUsuario,
): ConversaClienteRefVerdict {
  if (typeof conversa.clienteOuterRef === 'string' && conversa.clienteOuterRef !== '') {
    return { kind: 'ja-normalizado' };
  }

  const bruto = conversa.usarioOuterRef;
  if (bruto == null || bruto === '') return { kind: 'sem-usuario' };
  if (typeof bruto !== 'string') {
    return { kind: 'ref-invalida', valor: bruto, motivo: 'usarioOuterRef não é string' };
  }

  const { collection, id } = parseRef(bruto);
  if (id === '') {
    return { kind: 'ref-invalida', valor: bruto, motivo: 'usarioOuterRef sem id' };
  }
  if (collection !== COLECAO_USUARIOS) {
    return {
      kind: 'ref-invalida',
      valor: bruto,
      motivo: `usarioOuterRef aponta para "${collection}", não "usuarios"`,
    };
  }

  const clienteIds = porUsuario.get(id) ?? [];
  if (clienteIds.length === 0) return { kind: 'sem-cliente', usuarioId: id };
  if (clienteIds.length > 1) return { kind: 'ambiguo', usuarioId: id, clienteIds };

  const clienteId = clienteIds[0]!;
  return { kind: 'resolvido', de: bruto, para: clienteOuterRefFor(clienteId), clienteId };
}
