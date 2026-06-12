import type { FreteInicialFormState } from './types';

const isBlank = (v: string | null | undefined): boolean => v == null || v.trim() === '';

/**
 * Normalize `freteInicial` before validation/save:
 *
 *   - An all-empty `transportadora` collapses to `null` — legacy parity with
 *     `_transportadoraFromJson` (`.old/packages/pedido/lib/src/models.dart:850`),
 *     which maps an empty map to null, so a Flutter-written doc never carries
 *     a carrier block with every field blank.
 *
 * Runs inside `pedidoResolver`, so both validation and the saved doc see the
 * normalized shape (validate-what-you-save).
 */
export function normalizeFreteInicial(
  frete: FreteInicialFormState | null | undefined,
): FreteInicialFormState | null {
  if (frete == null) return null;
  const t = frete.transportadora;
  if (
    t &&
    isBlank(t.cnpj) &&
    isBlank(t.ie) &&
    isBlank(t.nome) &&
    isBlank(t.endereco) &&
    isBlank(t.municipio) &&
    isBlank(t.uf)
  ) {
    return { ...frete, transportadora: null };
  }
  return frete;
}
