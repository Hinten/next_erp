import { FirebaseError } from 'firebase/app';
import {
  INTEGRACAO_FRETE,
  TIPO_RESPOSTA_ROTA_ETIQUETA_LI,
  freightCapsFor,
  type FreightTipoCapabilities,
  type FreteDoPedido,
  type IntegracaoFrete,
  type RespostaRotaEtiquetaLi,
} from '@delfrance/schemas';

import { rotearEtiquetaLi } from '@/lib/loja-integrada/rotaEtiqueta';

import { resolverIntFrete } from '../intFrete';
import type { CheckoutEtiquetaProvider, EtiquetaOutcome, EtiquetaProviderInput } from '../types';

/**
 * The Loja Integrada ROUTER provider (master plan step 15).
 *
 * A Loja Integrada store mints no label: the conta's `int_frete` doc holds a
 * `mapa` from the store's shipping methods to the carriers the ERP drives. A
 * pedido routed at import already names its carrier, and never reaches this
 * provider. One still on the conta's doc does (`resolverIntFrete` resolves the
 * doc, tipo `lojaIntegrada`), and the label goes in two steps:
 *
 *  1. **Route** — the `apps/loja-integrada` backend's `rota-etiqueta` route,
 *     through `deps.lojaIntegradaClient` (`rotearEtiquetaLi`, with no
 *     `escolha`: the operator's own pick lives on the `/pedidos` row). It
 *     re-points the pedido at the carrier the stored override or the conta's
 *     `mapa` names — server-side, with a guarded write — and answers the
 *     routing fields. It makes no call to Loja Integrada itself.
 *  2. **Delegate** — the routed freight ({@link freteRoteadoLi}) is resolved
 *     to the TARGET's `int_frete` doc (read here, by the client, under its own
 *     permission: the answer never ships that document), and the target's own
 *     provider prints: the generic label, or the Melhor Envio buy / reprint.
 *
 * The shared gates (sem frete, the posted-risk confirm) already ran in the
 * registry, under this provider — so it calls the target's `emitirOuImprimir`,
 * never the registry's entry point, and they run once. The target's own
 * checks (the paid re-check's soft gates, the buy modal's gate) run there,
 * with the chain's carried verdict: the input spreads into the delegated one.
 *
 * A refusal is the operator's to fix on the row: it is notified with its copy
 * and returns `unsupported`. A call that produced no decision is an `error`.
 *
 * ⚠️ The target provider comes from an INJECTED resolver — the registry's own
 * `resolveEtiquetaProvider` — so this file does not import the registry that
 * registers it (no cycle).
 */

/** Resolves a freight tipo to its provider: the registry's `resolveEtiquetaProvider`. */
export type ResolverProvedorEtiqueta = (
  tipo: IntegracaoFrete,
  caps: FreightTipoCapabilities,
) => CheckoutEtiquetaProvider;

/** A routing answer that names a target. */
type RespostaRoteada = Extract<
  RespostaRotaEtiquetaLi,
  {
    tipo:
      | typeof TIPO_RESPOSTA_ROTA_ETIQUETA_LI.roteado
      | typeof TIPO_RESPOSTA_ROTA_ETIQUETA_LI.jaRoteado;
  }
>;

/** The routing fields of an answer (`resposta.rota`). */
export type RotaVigenteLi = RespostaRoteada['rota'];

/**
 * The routing fields the pedido's freight holds NOW, from a routing answer and
 * the freight the caller holds:
 *
 * - `roteado` — every field as the route WROTE it. A `null` option is written:
 *   the option belongs to its ref, and a carrier other than Melhor Envio has
 *   none.
 * - `ja-roteado` — the fields as the route FOUND them, except a `null` option:
 *   the route answers a stored option it cannot read as `null`, which says
 *   nothing about the option, so a usable one the caller holds is kept.
 */
export function rotaVigenteLi(
  frete: Pick<FreteDoPedido, 'externalOptionId'>,
  resposta: RespostaRoteada,
): RotaVigenteLi {
  const { rota } = resposta;
  if (
    resposta.tipo === TIPO_RESPOSTA_ROTA_ETIQUETA_LI.jaRoteado &&
    rota.externalOptionId === null
  ) {
    return { ...rota, externalOptionId: frete.externalOptionId };
  }
  return rota;
}

/**
 * `frete` with the routing fields of `resposta` laid over it
 * ({@link rotaVigenteLi}); an estado the route did not know (`null` on the
 * wire) keeps the caller's. Every other field — the money, the shipping-method
 * key, the label id — is the caller's, untouched.
 */
export function freteRoteadoLi(frete: FreteDoPedido, resposta: RespostaRoteada): FreteDoPedido {
  const rota = rotaVigenteLi(frete, resposta);
  return {
    ...frete,
    integracaoFreteOuterRef: rota.integracaoFreteOuterRef,
    externalOptionId: rota.externalOptionId,
    integracaoTargetOuterRef: rota.integracaoTargetOuterRef,
    estado: rota.estado ?? frete.estado,
  };
}

const SEM_INTEGRACAO: EtiquetaOutcome = {
  status: 'error',
  message: 'Integração de frete não encontrada.',
};

/** Where a refusal at checkout sends the operator. */
const DICA_DA_LISTA = 'Use "Definir transportadora" na lista de pedidos.';

/** Build the router provider over the registry's resolver. */
export function createLojaIntegradaRouterProvider(
  resolver: ResolverProvedorEtiqueta,
): CheckoutEtiquetaProvider {
  const roteador: CheckoutEtiquetaProvider = {
    tipos: [INTEGRACAO_FRETE.lojaIntegrada],

    async emitirOuImprimir(input: EtiquetaProviderInput): Promise<EtiquetaOutcome> {
      // The router routes the pedido its DOC names; a `bloco` integration has
      // none (unreachable: the block tipo of a Loja Integrada pedido is null,
      // and `lojaIntegrada` is not a marketplace tipo).
      if (input.intFrete.fonte !== 'doc') return SEM_INTEGRACAO;

      // A null client answers the "não respondeu" copy, with no call.
      const resultado = await rotearEtiquetaLi(
        input.deps.lojaIntegradaClient,
        input.pedidoId,
        null,
      );
      if (resultado.tipo === 'erro') return { status: 'error', message: resultado.mensagem };
      if (resultado.tipo === TIPO_RESPOSTA_ROTA_ETIQUETA_LI.recusado) {
        input.ui.notify({
          title: 'Etiqueta',
          message: `${resultado.mensagem} ${DICA_DA_LISTA}`,
          color: 'yellow',
        });
        return {
          status: 'unsupported',
          reason: 'A transportadora deste pedido da Loja Integrada não foi definida.',
        };
      }

      const frete = freteRoteadoLi(input.frete, resultado);
      let intFrete: Awaited<ReturnType<typeof resolverIntFrete>>;
      try {
        intFrete = await resolverIntFrete(input.db, frete);
      } catch (err) {
        // The route already wrote: the pedido IS routed, and a reprint from
        // "Outros Checkouts" or the row picks it up.
        if (!(err instanceof FirebaseError)) throw err;
        return {
          status: 'error',
          message: `Transportadora definida, mas não foi possível lê-la: ${err.message}`,
        };
      }
      if (intFrete === null) return SEM_INTEGRACAO;

      const alvo = resolver(intFrete.tipo, freightCapsFor(intFrete.tipo));
      // Unreachable: a route names one of the five label targets, never a
      // router. A loop would route the pedido again on every pass.
      if (alvo === roteador) return SEM_INTEGRACAO;

      return alvo.emitirOuImprimir({
        ...input,
        frete,
        pedido: { ...input.pedido, freteInicial: frete },
        intFrete,
      });
    },
  };
  return roteador;
}
