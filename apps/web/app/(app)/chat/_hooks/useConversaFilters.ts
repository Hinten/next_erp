'use client';

import { useCallback, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  CONVERSA_ORDENS,
  CONVERSA_TABS,
  DEFAULT_ORDEM,
  type ConversaOrdem,
  type ConversaTab,
} from '@/lib/chat/conversaConstraints';
import {
  aplicarFiltroCliente,
  aplicarTab,
  limparClienteAoFiltrar,
  resolverFiltroCliente,
} from '@/lib/chat/clienteFilterParam';

/**
 * The inbox list state, mirrored in the URL query so it survives navigation
 * to `/chat/[id]` and back and is shareable/deep-linkable. Params:
 *   `tab` · `ordem` · `integracao` · `etiqueta` · `cliente` · `busca`
 * (`cliente` holds `documents/clientes/<id>`;
 * `busca` holds the cross-conversation search term — its PRESENCE, even empty,
 * puts the list pane in global-search mode so the state survives navigation into
 * a thread and back).
 */
export interface ConversaFiltersState {
  tab: ConversaTab;
  ordem: ConversaOrdem;
  integracaoId: string | null;
  etiqueta: number | null;
  /** `documents/clientes/<id>` of the cliente filter (or null). */
  clienteRef: string | null;
  /** Cross-conversation search term, or null when not in search mode. */
  busca: string | null;

  setTab: (tab: ConversaTab) => void;
  setOrdem: (ordem: ConversaOrdem) => void;
  setIntegracao: (id: string | null) => void;
  setEtiqueta: (cor: number | null) => void;
  setCliente: (ref: string | null) => void;
  /** Set the search term (empty string = search mode, blank input); null exits. */
  setBusca: (term: string | null) => void;

  /** Current query string (no leading `?`), e.g. to preserve on tile links. */
  queryString: string;
  /** Href to a conversa, carrying the current filters. */
  buildHref: (conversaId: string) => string;
}

function parseTab(raw: string | null): ConversaTab {
  return CONVERSA_TABS.includes(raw as ConversaTab) ? (raw as ConversaTab) : 'atendimento';
}

function parseOrdem(raw: string | null, tab: ConversaTab): ConversaOrdem {
  return CONVERSA_ORDENS.includes(raw as ConversaOrdem)
    ? (raw as ConversaOrdem)
    : DEFAULT_ORDEM[tab];
}

function parseEtiqueta(raw: string | null): number | null {
  if (raw == null || raw === '') return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

export function useConversaFilters(): ConversaFiltersState {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const tab = parseTab(searchParams.get('tab'));
  const ordem = parseOrdem(searchParams.get('ordem'), tab);
  const integracaoId = searchParams.get('integracao') || null;
  const etiqueta = parseEtiqueta(searchParams.get('etiqueta'));
  // ⚠️ Resolved against the WHOLE URL, not just its own param. Every param
  // here is deep-linkable by design, so a bookmarked or hand-edited
  // `?tab=pendentes&cliente=…` would otherwise reach Firestore as a shape no
  // index covers — see the INVARIANT in `clienteFilterParam.ts`.
  const clienteRef = resolverFiltroCliente(searchParams, tab);
  // NOT `|| null`: an empty `?busca=` means "search mode on, blank input" and
  // must stay distinct from an absent param (search mode off).
  const busca = searchParams.get('busca');

  // Push a mutated copy of the current params, replacing history so the
  // back button doesn't accumulate every filter tweak.
  const commit = useCallback(
    (mutate: (p: URLSearchParams) => void) => {
      const next = new URLSearchParams(searchParams.toString());
      mutate(next);
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const setTab = useCallback(
    (nextTab: ConversaTab) => commit((p) => aplicarTab(p, nextTab)),
    [commit],
  );

  // ⚠️ These three CLEAR the cliente filter — the third leg of the invariant,
  // alongside `aplicarFiltroCliente` and `aplicarTab`. Each adds a clause to
  // the same query, so pairing one with a cliente is a composite nothing
  // indexes. The UI disables them while a chip is showing; this is the belt
  // to that braces.
  const setOrdem = useCallback(
    (nextOrdem: ConversaOrdem) =>
      commit((p) => {
        if (nextOrdem === DEFAULT_ORDEM[parseTab(p.get('tab'))]) p.delete('ordem');
        else p.set('ordem', nextOrdem);
        limparClienteAoFiltrar(p);
      }),
    [commit],
  );

  const setIntegracao = useCallback(
    (id: string | null) =>
      commit((p) => {
        if (id) p.set('integracao', id);
        else p.delete('integracao');
        limparClienteAoFiltrar(p);
      }),
    [commit],
  );

  const setEtiqueta = useCallback(
    (cor: number | null) =>
      commit((p) => {
        if (cor != null) p.set('etiqueta', String(cor));
        else p.delete('etiqueta');
        limparClienteAoFiltrar(p);
      }),
    [commit],
  );

  // ⚠️ The cliente filter is EXCLUSIVE with the tab, the ordering, the etiqueta
  // and the integração — see the INVARIANT note in `clienteFilterParam.ts`,
  // which owns every mutation so the property is directly assertable.
  const setCliente = useCallback(
    (ref: string | null) => commit((p) => aplicarFiltroCliente(p, ref)),
    [commit],
  );

  const setBusca = useCallback(
    // `term === ''` keeps the param present (search mode, blank input); `null`
    // removes it (exit search mode). Any non-null string is set verbatim.
    (term: string | null) =>
      commit((p) => (term == null ? p.delete('busca') : p.set('busca', term))),
    [commit],
  );

  const queryString = searchParams.toString();
  const buildHref = useCallback(
    (conversaId: string) =>
      queryString ? `/chat/${conversaId}?${queryString}` : `/chat/${conversaId}`,
    [queryString],
  );

  return useMemo(
    () => ({
      tab,
      ordem,
      integracaoId,
      etiqueta,
      clienteRef,
      busca,
      setTab,
      setOrdem,
      setIntegracao,
      setEtiqueta,
      setCliente,
      setBusca,
      queryString,
      buildHref,
    }),
    [
      tab,
      ordem,
      integracaoId,
      etiqueta,
      clienteRef,
      busca,
      setTab,
      setOrdem,
      setIntegracao,
      setEtiqueta,
      setCliente,
      setBusca,
      queryString,
      buildHref,
    ],
  );
}
