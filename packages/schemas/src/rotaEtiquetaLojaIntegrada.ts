import { z } from 'zod';
import { TIPOS_ALVO_MAPA_FRETE_LI } from './mapaFreteLojaIntegrada';
import { estadoFreteSchema } from './shared/frete';
import { naoDocId, outerRefSchema } from './shared/outerRef';

/* -------------------------------------------------------------------------- */
/*       Loja Integrada label routing: the wire contract of the PUT route      */
/* -------------------------------------------------------------------------- */

/**
 * The shared wire contract of `PUT /api/marketplace/loja-integrada/pedidos/[pedidoId]/rota-etiqueta`
 * (`apps/loja-integrada`, master plan step 15, #1825) and its callers in `apps/web` (the `/pedidos`
 * row action and the checkout's router). ONE definition, imported by both sides: `apps/web` has no
 * dependency edge to any app.
 *
 * The route re-points a pedido that still names its conta's Loja Integrada `int_frete` doc at the
 * label target the conta's `mapa` (or an operator's choice) resolves, through the pure resolver in
 * `mapaFreteLojaIntegrada.ts`. It makes no call to Loja Integrada. Its error envelope is
 * `erroContaLojaIntegradaSchema`, with the `CODIGO_ERRO_LI` codes.
 *
 * ⚠️ A NEW file on purpose, not a block inside `shared/frete.ts` or `integracao.ts`: both sit on
 * the NF-e live lane's path list.
 */

/**
 * The request body. `escolha` is the `int_frete` doc id the operator picked ("Escolher
 * transportadora…"), or `null` to route by the stored override or the conta's `mapa`. The id is a
 * bare document id: non-empty, no `/`, never `.` or `..`.
 *
 * Strict: an unknown key is a 400.
 */
export const corpoRotaEtiquetaLiSchema = z.strictObject({
  escolha: z
    .string()
    .min(1)
    .refine((id) => !naoDocId(id), { message: 'escolha precisa ser um id de documento' })
    .nullable(),
});
export type CorpoRotaEtiquetaLi = z.input<typeof corpoRotaEtiquetaLiSchema>;

/** The three answers of the route (all HTTP 200). */
export const tipoRespostaRotaEtiquetaLiSchema = z.enum(['roteado', 'ja-roteado', 'recusado']);
export type TipoRespostaRotaEtiquetaLi = z.infer<typeof tipoRespostaRotaEtiquetaLiSchema>;

/** Named members of {@link tipoRespostaRotaEtiquetaLiSchema} — see `delfrance/prefer-schema-enum`. */
export const TIPO_RESPOSTA_ROTA_ETIQUETA_LI = {
  roteado: 'roteado',
  jaRoteado: 'ja-roteado',
  recusado: 'recusado',
} as const satisfies Record<string, TipoRespostaRotaEtiquetaLi>;

/**
 * The target the pedido is routed through: its doc id, its tipo (one of the five label targets)
 * and its `nome` (`null` when the doc carries none). NEVER the target document itself — a Melhor
 * Envio `int_frete` holds credentials; the caller reads the doc under its own permission when it
 * needs more.
 */
const alvoRotaEtiquetaLiSchema = z.object({
  id: z.string().min(1),
  tipo: z.enum(TIPOS_ALVO_MAPA_FRETE_LI),
  nome: z.string().nullable(),
});

/**
 * The routing fields of the pedido's `freteInicial` AFTER the call — as written (`roteado`) or as
 * found (`ja-roteado`), so the caller can repaint the pedido without re-reading it. Every ref is
 * the canonical `documents/…` form.
 *
 * - `externalOptionId`: the Melhor Envio service for a Melhor Envio target, else `null`.
 * - `integracaoTargetOuterRef`: the per-pedido override, when one is stored or was just chosen.
 * - `estado`: the freight estado; `null` when the stored one is not a known estado — on BOTH
 *   ends: the route sends `null` for one it does not know, and a reader reads an estado it does
 *   not know (one a newer backend added) as `null` too, so the backend, which deploys first,
 *   never fails the whole answer in an older browser after its write already landed.
 */
const rotaEtiquetaLiSchema = z.object({
  integracaoFreteOuterRef: outerRefSchema,
  externalOptionId: z.string().nullable(),
  integracaoTargetOuterRef: outerRefSchema.nullable(),
  estado: estadoFreteSchema.nullable().catch(null),
});

/**
 * What the route answers with 200:
 *
 * - `roteado` — the pedido was re-pointed now;
 * - `ja-roteado` — it already named a label target (another tab, a checkout, or the import routed
 *   it first); nothing was written, whatever the `escolha`;
 * - `recusado` — a decision, not an error: `motivo` is a `MOTIVO_ROTA_ETIQUETA_LI` code. A plain
 *   string, so a motivo a newer backend adds still parses in an older browser (which shows its
 *   generic copy).
 *
 * NON-strict on purpose, like `statusContaLojaIntegradaSchema`: unknown keys are stripped, never
 * refused, so the target document can never ride along by accident.
 */
export const respostaRotaEtiquetaLiSchema = z.discriminatedUnion('tipo', [
  z.object({
    tipo: z.literal(TIPO_RESPOSTA_ROTA_ETIQUETA_LI.roteado),
    alvo: alvoRotaEtiquetaLiSchema,
    rota: rotaEtiquetaLiSchema,
  }),
  z.object({
    tipo: z.literal(TIPO_RESPOSTA_ROTA_ETIQUETA_LI.jaRoteado),
    alvo: alvoRotaEtiquetaLiSchema,
    rota: rotaEtiquetaLiSchema,
  }),
  z.object({
    tipo: z.literal(TIPO_RESPOSTA_ROTA_ETIQUETA_LI.recusado),
    motivo: z.string().min(1),
  }),
]);
export type RespostaRotaEtiquetaLi = z.infer<typeof respostaRotaEtiquetaLiSchema>;
