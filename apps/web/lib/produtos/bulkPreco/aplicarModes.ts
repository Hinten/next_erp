/**
 * Apply-mode selection for the bulk price-recalculation screen (#544) — port
 * of the legacy `AplicarAteracaoEnum` + its filter in `aplicarAlteracoesDePrecos`
 * (`.old/lib/produtos/pages/alterarPrecoMassa2.dart:549-651`). A produto with
 * NO current price for the target lista (`precoAtual === null`) is included by
 * every mode — there is nothing to compare against, so the new price always
 * "wins".
 */

export const APLICAR_MODES = ['aumentar', 'diminuir', 'aplicarTudo'] as const;

export type AplicarMode = (typeof APLICAR_MODES)[number];

export const APLICAR_MODE_LABELS: Record<AplicarMode, string> = {
  aumentar: 'Aumentar preços',
  diminuir: 'Diminuir preços',
  aplicarTudo: 'Aplicar tudo',
};

/**
 * Whether a row should be included for the given apply mode — mirrors the
 * legacy per-mode `elements.add(...)` guards exactly (L618-647).
 */
export function deveAplicar(
  mode: AplicarMode,
  precoAtual: number | null,
  precoNovo: number,
): boolean {
  switch (mode) {
    case 'aumentar':
      return precoAtual === null || precoAtual < precoNovo;
    case 'diminuir':
      return precoAtual === null || precoAtual > precoNovo;
    case 'aplicarTudo':
      return precoAtual === null || precoAtual !== precoNovo;
    default: {
      const _exhaustive: never = mode;
      throw new Error(`AplicarMode desconhecido: ${String(_exhaustive)}`);
    }
  }
}
