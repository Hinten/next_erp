/**
 * The pedido → conta LADDER of the label flow (#1523, step 15): may this
 * pedido's label be printed, and through which conta? ONE copy, for the label
 * route and the `baixar:etiqueta` CLI (review 1, R5-3).
 *
 * The two surfaces used to carry a ladder each — the route over the NF-e conta
 * predicate, the CLI over a re-typed copy of it with renamed motivos — and
 * nothing but a comment said they agreed (#1369). Now both call these two
 * functions, and each keeps only what is its OWN: a pedido document that does
 * not exist is the route's 404 and the CLI's `pedido-nao-encontrado`, so the
 * pedido half takes a document that exists.
 *
 * Pure: the caller reads the pedido (raw, never parsed) and the conta, and
 * hands them in. No I/O, no clock, no environment.
 *
 * ## The pedido — {@link avaliarPedidoParaEtiquetaShopee}, rungs in order
 *
 * 1. Ownership is `provaDeIdentidadeShopee` — the id must recompute from
 *    `(conta, order_sn)` — and NEVER `avaliarPedidoParaNfeShopee`, whose
 *    `bloquearEmissaoNFe` rung would refuse the label of every order that never
 *    gets an NF-e from this ERP (R-r, S39). No proof ⇒ `nao-shopee`.
 * 2. The block: refused only when `freteInicial.externalOptionIntegracao` is
 *    PRESENT and not EXACTLY `shopee` (⇒ `frete-de-outra-integracao`; `'Shopee'`
 *    is not ours). An absent block, an absent field and `null` all pass: a
 *    migrated legacy pedido keeps whatever the legacy app wrote, and step 7
 *    never rewrites that field (S40).
 *
 * ## The conta — {@link avaliarContaParaEtiquetaShopee}
 *
 * The NF-e upload's own predicate (`avaliarContaParaNfeShopee`) — missing or of
 * another tipo ⇒ `conta-nao-configurada`, `ativo !== true` ⇒ `conta-inativa` —
 * so the label and the NF-e cannot disagree about which conta may act. Its
 * refusal is mapped into this folder's vocabulary by an exhaustive switch: a
 * third refusal there is a COMPILE error here, never a silent
 * `conta-nao-configurada`. Both surfaces run it BEFORE a client is built, so a
 * refused conta costs no token read.
 */
import { INTEGRACAO_FRETE, type Integracao } from '@delfrance/schemas';

import { MOTIVO_NFE_SHOPEE } from '../nfe/errosNfe';
import { avaliarContaParaNfeShopee } from '../nfe/pedidoNfe';
import { provaDeIdentidadeShopee } from '../pedidos/reservaTravadaMapping';
import { MOTIVO_ETIQUETA_SHOPEE } from './motivosEtiqueta';

/** Why the PEDIDO half refused. */
export type MotivoPedidoEtiquetaShopee =
  | typeof MOTIVO_ETIQUETA_SHOPEE.naoShopee
  | typeof MOTIVO_ETIQUETA_SHOPEE.freteDeOutraIntegracao;

/** Why the CONTA half refused. */
export type MotivoContaEtiquetaShopee =
  | typeof MOTIVO_ETIQUETA_SHOPEE.contaNaoConfigurada
  | typeof MOTIVO_ETIQUETA_SHOPEE.contaInativa;

/** The pedido half's verdict: the proved conta and order, or the refusal. */
export type AlvoEtiquetaShopee =
  | { readonly ok: true; readonly contaId: string; readonly orderSn: string }
  | { readonly ok: false; readonly motivo: MotivoPedidoEtiquetaShopee };

/** The conta half's verdict. */
export type AvaliacaoContaEtiquetaShopee =
  | { readonly ok: true }
  | { readonly ok: false; readonly motivo: MotivoContaEtiquetaShopee };

/**
 * `freteInicial.externalOptionIntegracao` as STORED, or `null` when the block
 * or the field is absent. Anything else — another integração, a non-string —
 * is returned as is, and refused by the caller unless it is exactly `shopee`.
 */
function donoDoFrete(raw: Record<string, unknown>): unknown {
  const frete = raw['freteInicial'];
  if (frete === null || typeof frete !== 'object' || Array.isArray(frete)) return null;
  return (frete as Record<string, unknown>)['externalOptionIntegracao'] ?? null;
}

/**
 * The PEDIDO half of the ladder (see the module docblock).
 *
 * @param pedidoId the document id — the digest the proof recomputes.
 * @param raw the pedido document as stored; its ABSENCE is the caller's answer.
 */
export function avaliarPedidoParaEtiquetaShopee(
  pedidoId: string,
  raw: Record<string, unknown>,
): AlvoEtiquetaShopee {
  const prova = provaDeIdentidadeShopee(pedidoId, raw);
  if (prova === null) return { ok: false, motivo: MOTIVO_ETIQUETA_SHOPEE.naoShopee };

  const dono = donoDoFrete(raw);
  if (dono !== null && dono !== INTEGRACAO_FRETE.shopee) {
    return { ok: false, motivo: MOTIVO_ETIQUETA_SHOPEE.freteDeOutraIntegracao };
  }
  return { ok: true, contaId: prova.contaId, orderSn: prova.orderSn };
}

/** What the NF-e conta predicate refuses with. */
type MotivoContaNfe = Extract<
  ReturnType<typeof avaliarContaParaNfeShopee>,
  { ok: false }
>['motivo'];

/** The NF-e refusal in the label's vocabulary — exhaustive, so a new one stops compiling here. */
function motivoDaConta(motivo: MotivoContaNfe): MotivoContaEtiquetaShopee {
  switch (motivo) {
    case MOTIVO_NFE_SHOPEE.contaNaoConfigurada:
      return MOTIVO_ETIQUETA_SHOPEE.contaNaoConfigurada;
    case MOTIVO_NFE_SHOPEE.contaInativa:
      return MOTIVO_ETIQUETA_SHOPEE.contaInativa;
    default: {
      const nunca: never = motivo;
      return nunca;
    }
  }
}

/**
 * The CONTA half of the ladder (see the module docblock).
 *
 * @param conta the cached `readConta` answer, or `null` when there is none.
 */
export function avaliarContaParaEtiquetaShopee(
  conta: Integracao | null,
): AvaliacaoContaEtiquetaShopee {
  const v = avaliarContaParaNfeShopee(conta);
  return v.ok ? { ok: true } : { ok: false, motivo: motivoDaConta(v.motivo) };
}
