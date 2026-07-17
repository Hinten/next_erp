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

/**
 * The inbox list state, mirrored in the URL query so it survives navigation
 * to `/chat/[id]` and back and is shareable/deep-linkable. Params:
 *   `tab` · `ordem` · `integracao` · `etiqueta` · `cliente` · `busca`
 * (`cliente` holds the resolved `usarioOuterRef`, i.e. `documents/usuarios/<uid>`;
 * `busca` holds the cross-conversation search term — its PRESENCE, even empty,
 * puts the list pane in global-search mode so the state survives navigation into
 * a thread and back).
 */
export interface ConversaFiltersState {
  tab: ConversaTab;
  ordem: ConversaOrdem;
  integracaoId: string | null;
  etiqueta: number | null;
  /** Resolved `usarioOuterRef` of the cliente filter (or null). */
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
  const clienteRef = searchParams.get('cliente') || null;
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
    (nextTab: ConversaTab) =>
      commit((p) => {
        if (nextTab === 'atendimento') p.delete('tab');
        else p.set('tab', nextTab);
        // Each tab has its own default ordering; drop an explicit ordem so the
        // new tab falls back to its default (legacy per-tab order state).
        p.delete('ordem');
      }),
    [commit],
  );

  const setOrdem = useCallback(
    (nextOrdem: ConversaOrdem) =>
      commit((p) => {
        if (nextOrdem === DEFAULT_ORDEM[parseTab(p.get('tab'))]) p.delete('ordem');
        else p.set('ordem', nextOrdem);
      }),
    [commit],
  );

  const setIntegracao = useCallback(
    (id: string | null) => commit((p) => (id ? p.set('integracao', id) : p.delete('integracao'))),
    [commit],
  );

  const setEtiqueta = useCallback(
    (cor: number | null) =>
      commit((p) => (cor != null ? p.set('etiqueta', String(cor)) : p.delete('etiqueta'))),
    [commit],
  );

  const setCliente = useCallback(
    (ref: string | null) => commit((p) => (ref ? p.set('cliente', ref) : p.delete('cliente'))),
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
