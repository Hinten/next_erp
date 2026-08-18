/**
 * What one listing's `'button'`-mode save did, and how to report N of them.
 *
 * ⚠️ This exists because "Salvar anúncios" is **conta-level** and a conta can
 * hold several listings on one produto (#781), so one click drives N saves.
 * Every branch of `runSave` except `'invalid'` already tells the operator what
 * happened — a red notification, or the conflict modal. None of them can say
 * that a SIBLING was skipped, which is the failure a per-listing button could
 * not produce: listing A silently blocked on an invalid title while listing B
 * fires an unqualified green "Anúncio salvo." for the same click, so the
 * operator reads success for a save that did half the job.
 */

/**
 * `'saved'` covers the legitimate no-op too (`ListingNothingChangedError`),
 * which shows its own notification — the operator was told, so it is not a
 * shortfall.
 */
export type ListingSaveOutcome = 'saved' | 'invalid' | 'conflict' | 'failed';

export interface ListingSaveResumo {
  color: 'yellow' | 'red';
  message: string;
}

/**
 * The one notification that covers the whole click, or `null` when the
 * per-listing signals already said everything true.
 *
 * Returning `null` for the single-listing conflict/failure cases is deliberate:
 * the conflict modal and the red notification are louder and more specific than
 * a summary would be, and repeating them trains people to dismiss toasts. The
 * single-listing `'invalid'` case is NOT one of those — it is the exit that
 * shows nothing at all.
 */
export function resumoSalvarAnuncios(
  outcomes: readonly ListingSaveOutcome[],
): ListingSaveResumo | null {
  const total = outcomes.length;
  if (total === 0) return null;

  const saved = outcomes.filter((o) => o === 'saved').length;
  if (saved === total) return null;

  // A single listing that failed loudly already explained itself.
  if (total === 1 && !outcomes.includes('invalid')) return null;

  const motivo = outcomes.includes('invalid')
    ? 'Corrija os campos destacados.'
    : outcomes.includes('conflict')
      ? 'Revise as diferenças antes de salvar.'
      : 'Veja o erro informado.';

  return {
    // Yellow when something DID land — the operator has to know both halves.
    color: saved > 0 ? 'yellow' : 'red',
    message:
      total === 1
        ? `Anúncio não salvo. ${motivo}`
        : `${String(saved)} de ${String(total)} anúncios salvos. ${motivo}`,
  };
}
