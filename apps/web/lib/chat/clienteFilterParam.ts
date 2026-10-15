/**
 * The chat inbox's `?cliente=` filter param: how it is read, and the invariant
 * that keeps it answerable by ONE Firestore index.
 *
 * Pure functions over `URLSearchParams` rather than logic inside the router
 * callbacks in `useConversaFilters`, so the invariant below is directly
 * assertable — it is a correctness property with a billing consequence, not a
 * detail of how a hook happens to be wired.
 */
import type { ConversaTab } from './conversaConstraints';

/** The collection a cliente filter value must name. */
const COLECAO_CLIENTES = 'clientes';

/** The one tab the cliente filter may coexist with. See `ehTabPermitida`. */
export const TAB_DO_FILTRO_CLIENTE: ConversaTab = 'todas';

/**
 * The other list params the cliente filter is EXCLUSIVE with.
 *
 * Not an arbitrary list: each one adds a `where`/`orderBy` clause to the same
 * query (`conversaConstraintSpecs`), so any of them combined with a cliente
 * needs its own composite index — and the combinations multiply
 * (2 filters × 5 orderings = 20 shapes). Declaring twenty indexes to serve a
 * filter that already narrows to one customer is the wrong trade; making the
 * pairing impossible is the right one.
 *
 * `busca` is deliberately absent: search mode replaces the list entirely
 * (`GlobalSearchPane`), so it never stacks on the conversa query.
 */
const PARAMS_EXCLUSIVOS = ['ordem', 'etiqueta', 'integracao'] as const;

/**
 * Read the `?cliente=` param as a storable `clienteOuterRef`, or null.
 *
 * ⚠️ Before #1159 this param held `documents/usuarios/<uid>`, and those URLs are
 * bookmarked, pasted into chats and sitting in browser history. Such a value
 * would now match no conversa at all — producing an empty inbox that looks
 * exactly like the bug being fixed — so a stale one is DROPPED rather than
 * queried. Anything not naming `clientes` is treated as absent.
 *
 * ⚠️ A bare `clientes/<id>` is CANONICALIZED, not passed through. The outerRef
 * invariant that "readers tolerate both forms" is about `parseSoftRead` /
 * `toOuterRef`, which NORMALIZE — a Firestore `==` cannot. And the bare form is
 * not even storable: `conversa.clienteOuterRef` is `outerRefSchema`,
 * `/^documents(\/[^/]+\/[^/]+)+$/`. Passing it through would produce the exact
 * silent empty-inbox this function exists to prevent.
 */
export function parseClienteParam(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const bare = raw.replace(/^documents\//, '');
  if (!bare.startsWith(`${COLECAO_CLIENTES}/`)) return null;
  // A prefix match alone would accept `clientes/` with no id.
  if (bare.length <= COLECAO_CLIENTES.length + 1) return null;
  return `documents/${bare}`;
}

/**
 * ⚠️ THE INVARIANT: while a cliente filter is active the query is EXACTLY
 * `clienteOuterRef == <ref>` ordered by `ultima_modificacao desc`, on the
 * `todas` tab — no tab clause, no etiqueta, no integração, no other ordering.
 *
 * Every one of those adds a clause to the same query, so each pairing is a
 * composite needing its own index; without one Firestore Enterprise does not
 * throw, it silently full-scans and bills the scan, on a live `onSnapshot`
 * (root `CLAUDE.md` rule 1). Making the pairings impossible is what lets ONE
 * index — `chat(clienteOuterRef ASC, ultima_modificacao DESC)` — cover every
 * reachable combination.
 *
 * It also matches what the filter means: everything from this customer.
 */
export function ehTabPermitida(tab: ConversaTab): boolean {
  return tab === TAB_DO_FILTRO_CLIENTE;
}

/**
 * The cliente filter for a given URL, or null when that URL violates the
 * invariant.
 *
 * ⚠️ Enforced on READ as well as on write, because every param here is
 * deep-linkable by design: a hand-edited, bookmarked or shared
 * `?tab=pendentes&cliente=…` would otherwise reach Firestore as a shape no index
 * covers. Clamping here makes the property total rather than conventional.
 */
export function resolverFiltroCliente(params: URLSearchParams, tab: ConversaTab): string | null {
  const ref = parseClienteParam(params.get('cliente'));
  if (ref == null) return null;
  if (!ehTabPermitida(tab)) return null;
  for (const p of PARAMS_EXCLUSIVOS) {
    if (params.get(p)) return null;
  }
  return ref;
}

/**
 * Apply a cliente pick (or clear) to the URL params, in place.
 *
 * Setting one moves to `todas` and drops every exclusive param, so the query
 * falls back to `ultima_modificacao desc` — the ordering the index covers.
 */
export function aplicarFiltroCliente(params: URLSearchParams, ref: string | null): void {
  if (!ref) {
    params.delete('cliente');
    return;
  }
  params.set('cliente', ref);
  params.set('tab', TAB_DO_FILTRO_CLIENTE);
  for (const p of PARAMS_EXCLUSIVOS) params.delete(p);
}

/**
 * Apply a tab change to the URL params, in place — the other half of the
 * invariant: leaving `todas` clears the cliente filter rather than carrying it
 * into a combination nothing indexes.
 */
export function aplicarTab(params: URLSearchParams, tab: ConversaTab): void {
  // `atendimento` is the default, so it is represented by the param's absence.
  if (tab === 'atendimento') params.delete('tab');
  else params.set('tab', tab);
  // Each tab has its own default ordering; drop an explicit ordem so the new tab
  // falls back to its default (legacy per-tab order state).
  params.delete('ordem');
  if (!ehTabPermitida(tab)) params.delete('cliente');
}

/**
 * Setting any exclusive param clears the cliente filter — the third leg of the
 * invariant, alongside `aplicarFiltroCliente` and `aplicarTab`.
 *
 * The UI disables these controls while a cliente chip is showing, so this is the
 * belt to that braces: a route reached some other way still cannot build an
 * unindexed query.
 */
export function limparClienteAoFiltrar(params: URLSearchParams): void {
  params.delete('cliente');
}
