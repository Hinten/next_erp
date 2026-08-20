/**
 * The chat inbox's `?cliente=` filter param: how it is read, and the invariant
 * that keeps it answerable by ONE Firestore index.
 *
 * Pure functions over `URLSearchParams` rather than logic inside the router
 * callbacks in `useConversaFilters`, so the invariant below is directly
 * assertable — it is a correctness property with a billing consequence, not a
 * detail of how a hook happens to be wired.
 */
import { type ConversaTab } from './conversaConstraints';

/** The collection a cliente filter value must name. */
const COLECAO_CLIENTES = 'clientes';

/** The one tab the cliente filter may coexist with. See `ehTabPermitida`. */
export const TAB_DO_FILTRO_CLIENTE: ConversaTab = 'todas';

/**
 * Read the `?cliente=` param, or null.
 *
 * ⚠️ Before #1159 this param held `documents/usuarios/<uid>`, and those URLs are
 * bookmarked, pasted into chats and sitting in browser history. Such a value
 * would now match no conversa at all — producing an empty inbox that looks
 * exactly like the bug being fixed — so a stale one is DROPPED rather than
 * queried. Anything not naming `clientes` is treated as absent.
 *
 * Both stored ref shapes are accepted (`documents/clientes/<id>` and the bare
 * `clientes/<id>`), matching the outerRef invariant that readers tolerate both.
 */
export function parseClienteParam(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const bare = raw.replace(/^documents\//, '');
  if (!bare.startsWith(`${COLECAO_CLIENTES}/`)) return null;
  // A prefix match alone would accept `clientes/` with no id.
  return bare.length > COLECAO_CLIENTES.length + 1 ? raw : null;
}

/**
 * ⚠️ THE INVARIANT: a cliente filter only ever coexists with the `todas` tab.
 *
 * The filter STACKS on the tab's base clauses, so `atendimento` + cliente is a
 * four-clause composite and `pendentes` + cliente a three-clause one — each
 * needing its own index, and each silently full-scanning without one, because
 * Firestore Enterprise does not throw on an unindexed query, it bills the scan
 * (root `CLAUDE.md` rule 1). Pinning the pairing makes ONE index —
 * `chat(clienteOuterRef ASC, ultima_modificacao DESC)` — cover every reachable
 * combination.
 *
 * It also matches what the filter means: everything from this customer.
 */
export function ehTabPermitida(tab: ConversaTab): boolean {
  return tab === TAB_DO_FILTRO_CLIENTE;
}

/**
 * Apply a cliente pick (or clear) to the URL params, in place.
 *
 * Setting one moves to `todas` and drops any explicit `ordem`, so the query
 * falls back to `ultima_modificacao desc` — the ordering the index covers.
 */
export function aplicarFiltroCliente(params: URLSearchParams, ref: string | null): void {
  if (!ref) {
    params.delete('cliente');
    return;
  }
  params.set('cliente', ref);
  params.set('tab', TAB_DO_FILTRO_CLIENTE);
  params.delete('ordem');
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
