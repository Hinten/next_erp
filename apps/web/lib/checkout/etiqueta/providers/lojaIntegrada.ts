import { FirebaseError } from 'firebase/app';
import {
  INTEGRACAO_FRETE,
  MOTIVO_ROTA_ETIQUETA_LI,
  TIPO_RESPOSTA_ROTA_ETIQUETA_LI,
  freightCapsFor,
  type FreightTipoCapabilities,
  type FreteDoPedido,
  type IntegracaoFrete,
  type MotivoRotaEtiquetaLi,
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
 *  2. **Delegate** — the routed freight ({@link aplicarRotaLi}) is resolved
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
 * A refusal is notified with its copy — plus a pointer to the row's carrier
 * picker where that pick can route what this call could not — and returns
 * `unsupported`. A call that produced no decision is an `error`.
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

/** The routing fields of an answer (`resposta.rota`), as written or as found. */
export type RotaLi = RespostaRoteada['rota'];

/**
 * `frete` with the routing fields of a routing answer laid over it — the ONE
 * place that does it: the router provider here, and the `/pedidos` host for a
 * route it registered (`freteComRotaConhecida`).
 *
 * Every routing field is taken as the route answered it, a `null` option
 * included: the option belongs to its ref, and the freight a caller holds while
 * it asks still names the Loja Integrada doc, so its option came with THAT ref.
 * A `null` on the wire — written for a carrier other than Melhor Envio, or a
 * stored option that is null or unusable — therefore never inherits it: the
 * target quotes first instead of buying a service nobody chose for it. Only an
 * estado the route did not know (`null` on the wire) keeps the caller's. Every
 * other field — the money, the shipping-method key, the label id — is the
 * caller's, untouched.
 */
export function aplicarRotaLi(frete: FreteDoPedido, rota: RotaLi): FreteDoPedido {
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

/**
 * Where a refusal at checkout sends the operator — only when the `/pedidos`
 * row can do what this call could not. Its "Definir transportadora" repeats
 * this very call (no `escolha`), so it would refuse again; its "Escolher
 * transportadora…" routes by the operator's own pick, which bypasses the
 * stored override and the conta's `mapa`.
 */
const DICA_DA_LISTA = 'Use "Escolher transportadora…" na lista de pedidos.';

/**
 * Whether the operator's pick can route a pedido the checkout's call refused,
 * per motivo — total by type, so a new motivo must say. `false` where the pick
 * meets the same refusal: the Loja Integrada doc guard and the pedido guard run
 * before any target is chosen, and a route that is already gone (`sem-rota-li`)
 * leaves nothing to pick for.
 */
const ESCOLHA_RESOLVE: Readonly<Record<MotivoRotaEtiquetaLi, boolean>> = {
  [MOTIVO_ROTA_ETIQUETA_LI.semMapeamento]: true,
  [MOTIVO_ROTA_ETIQUETA_LI.semChave]: true,
  // The pick never reads the `mapa` for its target: any carrier but Melhor
  // Envio (whose service comes from the method's row) routes.
  [MOTIVO_ROTA_ETIQUETA_LI.mapaInvalido]: true,
  [MOTIVO_ROTA_ETIQUETA_LI.alvoAusente]: true,
  [MOTIVO_ROTA_ETIQUETA_LI.alvoInativo]: true,
  [MOTIVO_ROTA_ETIQUETA_LI.alvoSemServico]: true,
  [MOTIVO_ROTA_ETIQUETA_LI.tipoNaoSuportado]: true,
  [MOTIVO_ROTA_ETIQUETA_LI.overrideInvalido]: true,
  // A pickup target needs no endereço.
  [MOTIVO_ROTA_ETIQUETA_LI.semEndereco]: true,
  [MOTIVO_ROTA_ETIQUETA_LI.docLiDivergente]: false,
  [MOTIVO_ROTA_ETIQUETA_LI.semRotaLi]: false,
  [MOTIVO_ROTA_ETIQUETA_LI.estadoNaoPago]: false,
  [MOTIVO_ROTA_ETIQUETA_LI.semFrete]: false,
  [MOTIVO_ROTA_ETIQUETA_LI.etiquetaJaComprada]: false,
};

/** The motivos {@link ESCOLHA_RESOLVE} answers `true` for — a wire string looks up prototype-safely. */
const MOTIVOS_COM_DICA: ReadonlySet<string> = new Set(
  Object.entries(ESCOLHA_RESOLVE)
    .filter(([, resolve]) => resolve)
    .map(([motivo]) => motivo),
);

/** The checkout copy of a refusal: its motivo's, plus the row hint where the row can help. */
function mensagemDaRecusa(motivo: string, mensagem: string): string {
  return MOTIVOS_COM_DICA.has(motivo) ? `${mensagem} ${DICA_DA_LISTA}` : mensagem;
}

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
          message: mensagemDaRecusa(resultado.motivo, resultado.mensagem),
          color: 'yellow',
        });
        return {
          status: 'unsupported',
          reason: 'A transportadora deste pedido da Loja Integrada não foi definida.',
        };
      }

      const frete = aplicarRotaLi(input.frete, resultado.rota);
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
