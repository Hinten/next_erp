/**
 * Why a size-chart control is disabled, in words.
 *
 * ⚠️ The medidas Mercado Livre tab had four buttons and four independent
 * disabling causes, and only two of them said anything on screen — as loose
 * `<Text c="dimmed">` blocks at the bottom of the card rather than anything
 * attached to the control. The two that were wholly silent are the two an
 * operator cannot guess: `readOnly` (ObjectView threads it down through
 * `renderInput`) and `!hasClient` (no authenticated Firebase user, so the ML
 * HTTP client is null). #1087 hit exactly that and could not tell permissions
 * from a broken client.
 *
 * Same shape as `publishDisabled.ts`, which fixed the identical problem on the
 * produto tab: one pure function decides, the caller feeds BOTH the `disabled`
 * prop and the tooltip from its answer, and the ordering is the whole
 * behaviour — cheaper to pin in a unit test than through a rendered card.
 *
 * ⚠️ Unlike `publishDisabledReason`, neither gate here takes a `loading` input.
 * `MedidasMercadoLivreManager` renders a `<Loader/>` until
 * `usePermission(...).loading` clears, so by the time any control below exists
 * the claims have settled and no input can be a loading artefact. That guard is
 * load-bearing: `usePermission` answers `allowed: false` WHILE LOADING, so
 * without it every ordinary page load would flash a permission denial at an
 * operator who has the bit.
 */

/** One control's verdict. `motivo` is non-null exactly when `disabled`. */
export interface SizeChartGate {
  disabled: boolean;
  motivo: string | null;
}

/**
 * Every message the size-chart surfaces can show, in one place.
 *
 * Exported because the two always-visible `<Text c="dimmed">` blocks on the
 * conta card render `semGrupos` and `semEscrita` too — a tooltip needs a hover
 * to be found, so the standing guidance stays. Reading both from here is what
 * stops the visible copy and the tooltip from drifting into two partial
 * stories (the bug `AnuncioBlock` documents at its own duplicate `<Text>`).
 */
export const SIZE_CHART_MOTIVOS = {
  semSessao: 'Sessão não autenticada — recarregue a página e entre novamente.',
  /**
   * ⚠️ Names `produto.write` because that is the ONLY thing that turns this on
   * today: `medidas/[id]/page.tsx` passes `readOnly={!canWrite}` with
   * `canWrite = usePermission(PERM.produto.write)`, and ObjectView turns
   * `readOnly` into the `disabled` this manager receives. It is deliberately a
   * different bit from `integracao.write` below, which is what made the silent
   * version so confusing — the card already talked about integrações.
   *
   * Mount the manager somewhere that sets `readOnly` for another reason, or
   * give the `mercadoLivre` field an `editable: false`, and this string has to
   * be revisited.
   */
  somenteLeitura:
    'A tabela de medidas está em modo somente leitura — requer permissão de escrita em produtos.',
  semEscrita: 'Requer permissão de escrita em integrações para enviar ao Mercado Livre.',
  ocupadoNestaGuia: 'Operação em andamento nesta guia…',
  // ⚠️ "outra guia", not "outra guia deste card": `busyChart` is global across
  // every conta on the page, so the guia holding the lock may belong to another
  // account entirely (see the ⚠️ on `busyChart` in the manager).
  ocupadoEmOutraGuia: 'Aguarde a operação em andamento em outra guia.',
  semGrupos: 'Cadastre um grupo de variações do tipo Tamanho para criar guias.',
  naoEnviada: 'Esta guia nunca foi enviada ao Mercado Livre — não há exclusão a verificar.',
  gradeVazia: 'Monte a grade da guia antes de pedir sugestões.',
  semNome: 'Dê um nome à guia antes de salvar o rascunho.',
  semDominio: 'Selecione o domínio.',
  salvandoRascunho: 'Salvando o rascunho…',
  enviando: 'Enviando ao Mercado Livre…',
} as const;

/** The four controls on a conta card in the medidas Mercado Livre tab. */
export type SizeChartAction = 'verificar' | 'editar' | 'excluir' | 'novaGuia';

/**
 * ⚠️ ONE `busy` field rather than a `rowBusy` + `anyBusy` pair. The pair makes
 * `{ rowBusy: true, anyBusy: false }` representable — a state the manager can
 * never produce (`rowBusy` compares `busyChart` against THIS row's key, so it
 * implies `busyChart !== null`) but one the type would let a caller pass, and
 * one where the gate would disable a control the original expression left
 * enabled. A three-way enum makes it unrepresentable, which is also what lets
 * the exhaustive test below sweep every legal input instead of most of them.
 */
export type SizeChartBusy = 'none' | 'estaGuia' | 'outraGuia';

export interface SizeChartGateInput {
  /** ObjectView's `disabled` — the tabela form is not editable. */
  readOnly: boolean;
  /** The ML HTTP client exists; false until there is an authenticated user. */
  hasClient: boolean;
  /** `PERM.integracao.write`. */
  canWrite: boolean;
  /** Which guia holds the single-operation lock, if any. */
  busy: SizeChartBusy;
  /** At least one grupo de variações do tipo Tamanho exists to bind rows to. */
  hasGrupos: boolean;
  /** The guia carries a Mercado Livre chart id — i.e. it has been sent. */
  enviada: boolean;
}

/**
 * One decision per control: permissions first, then what is in flight, then
 * what the operator still has to go and create.
 *
 * ⚠️ `!hasClient` LEADS, and that is not cosmetic. No client means no Firebase
 * user, and a userless session resolves to `claims: null` — so `readOnly` and
 * `canWrite` are BOTH down too, and reporting either would tell someone who
 * merely needs to sign in again that they lack a grant only an admin can give.
 * `publishDisabled.ts` learned this the same way.
 *
 * ⚠️ `readOnly` outranks `canWrite`, which INVERTS `publishDisabled.ts`'s order.
 * Deliberate, and not arbitrary: both are grants only an admin can give, so
 * neither is more actionable — but `readOnly` disables all four controls where
 * `canWrite` disables two, so it is the one that explains the whole tab. Report
 * the narrower gap first and an operator fixes it only to find the broader one
 * still there.
 */
export function sizeChartGate(action: SizeChartAction, input: SizeChartGateInput): SizeChartGate {
  return gate(motivoFor(action, input));
}

function motivoFor(action: SizeChartAction, input: SizeChartGateInput): string | null {
  if (!input.hasClient) return SIZE_CHART_MOTIVOS.semSessao;
  if (input.readOnly) return SIZE_CHART_MOTIVOS.somenteLeitura;
  // Opening the editor is a read: `editar` and `novaGuia` never needed the
  // write bit, and the modal gates its own "Enviar" on it.
  if ((action === 'verificar' || action === 'excluir') && !input.canWrite) {
    return SIZE_CHART_MOTIVOS.semEscrita;
  }
  // ⚠️ `novaGuia` is deliberately NOT gated on a running operation: it only
  // opens the editor, and the editor rebuilds the conta's array from the live
  // snapshot when it saves. Adding it here would be a behaviour change, not a
  // message — and this PR only explains the gates, it does not move them.
  if (action !== 'novaGuia') {
    if (input.busy === 'estaGuia') return SIZE_CHART_MOTIVOS.ocupadoNestaGuia;
    if (input.busy === 'outraGuia') return SIZE_CHART_MOTIVOS.ocupadoEmOutraGuia;
  }
  if (action === 'novaGuia' && !input.hasGrupos) return SIZE_CHART_MOTIVOS.semGrupos;
  // ⚠️ The one cause that is NEW rather than merely explained. `verifyDeletion`
  // opens with `if (!client || chart.id == null || chart.id === '') return;`, so
  // a guia flagged `exclusaoSolicitadaEm` with no ML id rendered an ENABLED
  // button that did nothing at all — the same complaint as a dead button with no
  // reason, one step worse. Unreachable through this app (a draft is dropped
  // from the array, never flagged), but the migrated corpus is not this app's
  // output.
  if (action === 'verificar' && !input.enviada) return SIZE_CHART_MOTIVOS.naoEnviada;
  return null;
}

/** The controls in the size-chart editor modal. */
export type SizeChartEditorAction = 'preencherIa' | 'cancelar' | 'salvarRascunho' | 'enviar';

export interface SizeChartEditorGateInput {
  /** `PERM.integracao.write`. */
  canWrite: boolean;
  /** Which call is in flight, if any. */
  busy: 'draft' | 'send' | null;
  /** The AI grid holds something worth sending — `chartAiGridIsFillable`. */
  aiFillable: boolean;
  /** The guia has a name. */
  hasNome: boolean;
  /** A domínio has been picked. */
  hasDominio: boolean;
  /** The first thing stopping a send, already in words, or null. */
  blockingError: string | null;
  /** The row cap message, already in words, or null. */
  overCap: string | null;
}

/**
 * Same ordering rule as {@link sizeChartGate} — permissions, then in flight,
 * then content.
 *
 * ⚠️ `blockingError` and `overCap` arrive already phrased (the modal derives
 * them for its own status line), so they are passed through verbatim rather
 * than restated here. That is what lets the status line become
 * `enviar.motivo ?? 'Pronto para enviar.'` — one source. It previously reported
 * neither `busy` nor `overCap`, so a send blocked by the row cap left the line
 * cheerfully saying the guia was ready.
 */
export function sizeChartEditorGate(
  action: SizeChartEditorAction,
  input: SizeChartEditorGateInput,
): SizeChartGate {
  return gate(editorMotivoFor(action, input));
}

function editorMotivoFor(
  action: SizeChartEditorAction,
  input: SizeChartEditorGateInput,
): string | null {
  // Only the two calls that reach Mercado Livre need the write bit. A draft is
  // a local Firestore write, and cancelling is not a write at all.
  if ((action === 'preencherIa' || action === 'enviar') && !input.canWrite) {
    return SIZE_CHART_MOTIVOS.semEscrita;
  }
  if (input.busy !== null) {
    return input.busy === 'draft'
      ? SIZE_CHART_MOTIVOS.salvandoRascunho
      : SIZE_CHART_MOTIVOS.enviando;
  }
  if (action === 'preencherIa' && !input.aiFillable) return SIZE_CHART_MOTIVOS.gradeVazia;
  if (action === 'salvarRascunho') {
    if (!input.hasNome) return SIZE_CHART_MOTIVOS.semNome;
    if (!input.hasDominio) return SIZE_CHART_MOTIVOS.semDominio;
  }
  if (action === 'enviar') {
    if (input.blockingError != null) return input.blockingError;
    if (input.overCap != null) return input.overCap;
  }
  return null;
}

/**
 * The single place `disabled` is derived, so a control can never be dead with
 * nothing to say — nor carry a reason while it is perfectly clickable.
 */
function gate(motivo: string | null): SizeChartGate {
  return { disabled: motivo !== null, motivo };
}
