/**
 * Declarative constraint builder for the chat inbox conversa queries — the
 * single source of truth for "which where/orderBy/limit a given tab + ordering
 * + filter combination produces". Kept pure (returns a plain spec array, no
 * Firestore imports) so it can be asserted exhaustively in a unit test and then
 * mapped to real `QueryConstraint`s by the hook (`specToConstraint`).
 *
 * Ports the legacy `ConversaProvider._loadPage`
 * (`.old/lib/chat/providers/conversaProvider.dart:340-404`) tab/ordering
 * matrix, minus its `orderBy__origem()` tie-breaker (Firestore Enterprise runs
 * unindexed queries as scans, so the extra ordering — and its composite-index
 * cost — buys nothing here). The three hot default combos are backed by the
 * `chat` composite indexes in `firestore.indexes.json`.
 */

/** The three inbox tabs (legacy `MenuLateral` TabBar, sans the comentários tab). */
export type ConversaTab = 'atendimento' | 'pendentes' | 'todas';

/** Ordering options (legacy `ORDERING`), keyed for the URL `ordem` param. */
export type ConversaOrdem =
  | 'ultima' // ultima_modificacao desc (legacy `ultima_mensagem`)
  | 'prazo_asc' // prazo_resposta asc  (legacy `prazo_de_resposta_ascending`)
  | 'prazo_desc' // prazo_resposta desc (legacy `prazo_de_resposta_descending`)
  | 'cadastro_asc' // data_cadastro asc  (legacy `mais_antigas`)
  | 'cadastro_desc'; // data_cadastro desc (legacy `mais_recentes`)

export const CONVERSA_TABS: readonly ConversaTab[] = ['atendimento', 'pendentes', 'todas'];

export const CONVERSA_ORDENS: readonly ConversaOrdem[] = [
  'ultima',
  'prazo_asc',
  'prazo_desc',
  'cadastro_asc',
  'cadastro_desc',
];

export const ORDEM_LABELS: Record<ConversaOrdem, string> = {
  ultima: 'Última mensagem',
  prazo_asc: 'Prazo de resposta ↑',
  prazo_desc: 'Prazo de resposta ↓',
  cadastro_asc: 'Mais antigas',
  cadastro_desc: 'Mais recentes',
};

export const TAB_LABELS: Record<ConversaTab, string> = {
  atendimento: 'Atendimento',
  pendentes: 'Pendentes',
  todas: 'Todas',
};

/** Default ordering per tab (legacy `TabAtendimentoHits.order` defaults). */
export const DEFAULT_ORDEM: Record<ConversaTab, ConversaOrdem> = {
  atendimento: 'ultima',
  pendentes: 'prazo_asc',
  todas: 'ultima',
};

export const ESTADO_CONVERSA_NAO_RESPONDIDO = 0;
export const ESTADO_CONVERSA_EM_RESPOSTA = 1;

/** The integracao outer-ref format written by the pipeline (`documents/integracao/<id>`). */
export function integracaoOuterRefFor(integracaoId: string): string {
  return `documents/integracao/${integracaoId}`;
}

/** Composable filters that stack on top of the tab's base query. */
export interface ConversaFilterInput {
  /** Bare integração doc id — mapped to the `integracaoOuterRef` doc-path. */
  integracaoId?: string | null;
  /** Etiqueta ARGB int (`cor_etiqueta`); `null`/absent = no etiqueta filter. */
  etiqueta?: number | null;
  /**
   * Resolved `usarioOuterRef` (`documents/usuarios/<uid>`) of the cliente
   * filter — the value `conversa.usarioOuterRef` is matched against.
   */
  usarioOuterRef?: string | null;
}

export interface ConversaQueryInput extends ConversaFilterInput {
  tab: ConversaTab;
  ordem: ConversaOrdem;
  /** Current operator uid — required for the Atendimento tab's membership filter. */
  uid?: string | null;
  /** Page size (default 200 for the live page-1 listener). */
  limit?: number;
}

export type ConstraintSpec =
  | { kind: 'where'; op: '=='; field: string; value: unknown }
  | { kind: 'where'; op: 'array-contains'; field: string; value: unknown }
  | { kind: 'orderBy'; field: string; direction: 'asc' | 'desc' }
  | { kind: 'limit'; value: number };

const ORDER_SPEC: Record<ConversaOrdem, { field: string; direction: 'asc' | 'desc' }> = {
  ultima: { field: 'ultima_modificacao', direction: 'desc' },
  prazo_asc: { field: 'prazo_resposta', direction: 'asc' },
  prazo_desc: { field: 'prazo_resposta', direction: 'desc' },
  cadastro_asc: { field: 'data_cadastro', direction: 'asc' },
  cadastro_desc: { field: 'data_cadastro', direction: 'desc' },
};

/** Default live page size — matches the legacy `conversasPerPage = 200`. */
export const CONVERSA_PAGE_SIZE = 200;

/**
 * Build the ordered constraint spec for a tab/ordem/filter combination.
 * Order: base where clauses (tab) → filter where clauses → orderBy → limit.
 * The where order is deterministic (for test assertions) and irrelevant to
 * Firestore result semantics.
 */
export function conversaConstraintSpecs(input: ConversaQueryInput): ConstraintSpec[] {
  const specs: ConstraintSpec[] = [];

  // ── Tab base filters ──────────────────────────────────────────────────────
  if (input.tab === 'atendimento') {
    // Membership + em-resposta (legacy `usuarios__arrayContainsAny([uid])` +
    // `estadoConversa == emResposta`).
    specs.push({ kind: 'where', op: 'array-contains', field: 'usuarios', value: input.uid ?? '' });
    specs.push({
      kind: 'where',
      op: '==',
      field: 'estadoConversa',
      value: ESTADO_CONVERSA_EM_RESPOSTA,
    });
  } else if (input.tab === 'pendentes') {
    specs.push({
      kind: 'where',
      op: '==',
      field: 'estadoConversa',
      value: ESTADO_CONVERSA_NAO_RESPONDIDO,
    });
  }
  // 'todas' has no estado filter.

  // ── Composable filters ────────────────────────────────────────────────────
  if (input.integracaoId) {
    specs.push({
      kind: 'where',
      op: '==',
      field: 'integracaoOuterRef',
      value: integracaoOuterRefFor(input.integracaoId),
    });
  }
  if (input.etiqueta != null) {
    specs.push({ kind: 'where', op: '==', field: 'cor_etiqueta', value: input.etiqueta });
  }
  if (input.usarioOuterRef) {
    specs.push({ kind: 'where', op: '==', field: 'usarioOuterRef', value: input.usarioOuterRef });
  }

  // ── Ordering + limit ──────────────────────────────────────────────────────
  const order = ORDER_SPEC[input.ordem];
  specs.push({ kind: 'orderBy', field: order.field, direction: order.direction });
  specs.push({ kind: 'limit', value: input.limit ?? CONVERSA_PAGE_SIZE });

  return specs;
}
