import {
  freightCapsFor,
  type FreightTipoCapabilities,
  type IntegracaoFrete,
} from '@delfrance/schemas';

import { runEtiquetaGates } from './gates';
import { genericLabelProvider } from './providers/genericLabel';
import { melhorEnviosProvider } from './providers/melhorEnvios';
import { mercadoLivreProvider } from './providers/mercadoLivre';
import { unsupportedMarketplaceProvider } from './providers/unsupportedMarketplace';
import type { CheckoutEtiquetaProvider, EtiquetaOutcome, EtiquetaProviderInput } from './types';

/**
 * The etiqueta provider registry — the carrier-agnostic dispatch that replaces
 * the legacy `switch (tipo)` in `emitirOuImprimirFrete.dart`. Adding a carrier
 * is one provider file + one `PROVIDERS` row (see `README.md`); gates, the UI
 * bridge, and the other providers stay untouched.
 */

/** Registered providers, indexed by every tipo each one claims via `.tipos`. */
export const PROVIDERS: Readonly<Partial<Record<IntegracaoFrete, CheckoutEtiquetaProvider>>> =
  buildProviderMap([
    melhorEnviosProvider,
    mercadoLivreProvider,
    unsupportedMarketplaceProvider,
    genericLabelProvider,
  ]);

function buildProviderMap(
  providers: readonly CheckoutEtiquetaProvider[],
): Partial<Record<IntegracaoFrete, CheckoutEtiquetaProvider>> {
  const map: Partial<Record<IntegracaoFrete, CheckoutEtiquetaProvider>> = {};
  for (const provider of providers) {
    for (const tipo of provider.tipos) {
      if (map[tipo] !== undefined) {
        // Two providers claiming the same tipo is a wiring bug — fail loud at
        // module load rather than silently letting registration order decide.
        throw new Error(`Etiqueta provider conflict for tipo "${tipo}".`);
      }
      map[tipo] = provider;
    }
  }
  return map;
}

/**
 * Resolve the provider for a freight tipo:
 *   - an exact tipo match in `PROVIDERS` wins;
 *   - else a `marketplaceOwned` tipo (a marketplace with no registered provider
 *     yet) → the unsupported-marketplace placeholder;
 *   - else → the generic label (motoboy / fob / outros / any unknown tipo).
 *
 * Note this deliberately does NOT reuse `etiquetaRowState`: its `'unsupported'`
 * bucket (every non-Melhor-Envio carrier) must fall through to the generic
 * label here, not dead-end.
 */
export function resolveEtiquetaProvider(
  tipo: IntegracaoFrete,
  caps: FreightTipoCapabilities,
): CheckoutEtiquetaProvider {
  const exact = PROVIDERS[tipo];
  if (exact !== undefined) return exact;
  if (caps.marketplaceOwned) return unsupportedMarketplaceProvider;
  return genericLabelProvider;
}

/**
 * The shared entry point: run the pre-gates, then dispatch to the resolved
 * provider. A `skip` (semFrete) or a blocked gate (the operator declined a
 * risky reprint) short-circuits before any provider runs. `input.intFrete` is
 * already resolved by the caller (the UI reads the integração doc first).
 */
export async function emitirOuImprimirEtiqueta(
  input: EtiquetaProviderInput,
): Promise<EtiquetaOutcome> {
  const gate = await runEtiquetaGates(input);
  if (gate.status === 'skip') return { status: 'skipped' };
  if (gate.status === 'blocked') return gate.outcome;

  const provider = resolveEtiquetaProvider(
    input.intFrete.tipo,
    freightCapsFor(input.intFrete.tipo),
  );
  return provider.emitirOuImprimir(input);
}
