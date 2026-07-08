import { ESTADO_FRETE_LABELS, isFreteJaPostado } from '@delfrance/schemas';

import type { EtiquetaOutcome, EtiquetaProviderInput } from './types';

/**
 * The shared pre-gates every etiqueta action runs BEFORE dispatching to a
 * provider — the carrier-agnostic part of the legacy `emitirOuImprimirFrete`
 * (`.old/lib/despacho/pages/emitirOuImprimirFrete.dart:35-157`). Keeping them
 * here means each provider can assume: the frete is not `semFrete`, an
 * already-posted reprint has been risk-confirmed, and the integration is
 * resolved (the registry resolves it and passes `input.intFrete`).
 *
 * Pure except for the single `ui.confirmRisk` await (the risky-reprint
 * confirmation) — no reads, no writes, no other side effects.
 */

export type EtiquetaGatesResult =
  /** `semFrete` — nothing to print; the caller returns a silent skip. */
  | { status: 'skip' }
  /** A gate stopped the flow with a ready outcome (the operator declined). */
  | { status: 'blocked'; outcome: EtiquetaOutcome }
  /** All gates passed — dispatch to the provider. */
  | { status: 'proceed' };

/** The `modalidadeFrete` code for "sem ocorrência de transporte" (no shipping). */
const MODALIDADE_SEM_FRETE = '9';

/**
 * Run the shared pre-gates in legacy order:
 *
 *   1. `modalidade === '9'` (semFrete) → skip silently (nothing to ship).
 *   2. Already-posted risk: when the frete has left the draft states
 *      (`isFreteJaPostado`), a reprint/reemit can duplicate a paid label, so
 *      the operator must confirm. `ui.confirmRisk` collapses the legacy
 *      two-step dialog into one boolean; declining → blocked with a silent
 *      `skipped` (the legacy `return`).
 *
 * Integration resolution (legacy step 3) is the CALLER's job — `input.intFrete`
 * is already resolved when we get here.
 */
export async function runEtiquetaGates(
  input: Pick<EtiquetaProviderInput, 'frete' | 'ui'>,
): Promise<EtiquetaGatesResult> {
  const { frete, ui } = input;

  // 1. Sem frete — no shipment, no label.
  if (frete.modalidade === MODALIDADE_SEM_FRETE) {
    return { status: 'skip' };
  }

  // 2. Already-posted reprint → risk confirm. `isFreteJaPostado` already
  //    excludes `checkFinalizado`; the explicit check mirrors the legacy guard
  //    `estado != checkFinalizado && jaPostado.contains(estado)`.
  if (frete.estado !== 'checkFinalizado' && isFreteJaPostado(frete.estado)) {
    const estadoLabel = ESTADO_FRETE_LABELS[frete.estado] ?? frete.estado;
    const proceed = await ui.confirmRisk(
      'Este frete já foi postado e não deveria ter sua etiqueta reemitida ou reimpressa ' +
        `(estado atual: ${estadoLabel}). A reemissão pode gerar etiquetas duplicadas e ` +
        'problemas operacionais. Tem certeza absoluta de que deseja prosseguir?',
    );
    if (!proceed) {
      return { status: 'blocked', outcome: { status: 'skipped' } };
    }
  }

  return { status: 'proceed' };
}
