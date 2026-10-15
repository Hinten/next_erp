/**
 * Loja Integrada REST v1 wire schemas of the ORDER import (master-plan steps 5
 * and 6): the pedido detail (`GET /v1/pedido/{numero}/`), the situação it
 * carries, one row of the situação history
 * (`GET /v1/situacao_historico/search/`), and the produto identity the import's
 * id_externo fallback reads (`GET /v1/produto/{id}/?id_externo=1`). RESPONSE
 * shapes only, written against the store owner's sanitized captures (D17), not
 * the public document's examples.
 *
 * ## The required set is minimal, on purpose
 *
 * The client validates the whole body before anyone reads a field, and the
 * importer PARKS a task on a `LiSchemaError` for good. So a field is required
 * only when no order can be imported without it:
 *
 *  - the pedido: `numero`, `situacao.codigo`, `data_modificacao`, and `itens`,
 *    `envios` and `pagamentos` as arrays (an ABSENT or `null` one reads as
 *    `[]`);
 *  - a history row: `id`, `numero`, `data` and `situacao.codigo`.
 *
 * Everything else is `.nullable().optional()`, and a field no mapper reads is
 * not declared at all — `.passthrough()` keeps it, and a declared field can
 * only add a way for the parse to fail. That is why the order expiry
 * (`data_expiracao`, never a boleto due date), the coupon, `integration_data`
 * and the PIX/boleto payment links are absent here.
 *
 * ## Passthrough
 *
 * Every object is `.passthrough()`: the provider adds fields without notice,
 * and a schema that stripped them would hide exactly the drift a later step
 * needs to see.
 *
 * ## The situação is read by its CODIGO only
 *
 * `liSituacaoSchema` declares `codigo` and nothing else that decides: the
 * `aprovado` / `cancelado` / `final` flags ride through `.passthrough()` but are
 * deliberately left untyped, because the flags cannot decide an estado — the
 * captured catalogue flags a delivered order and a chargeback identically. The
 * one table that maps a codigo is `situacaoPedidoLojaIntegrada.ts` in
 * `@delfrance/schemas`. `codigo` is a plain `z.string()`, never an enum: a
 * codigo this ERP does not know must still parse, so the importer can keep the
 * order and raise an aviso instead of parking it.
 *
 * ## Numbers
 *
 * Every numeric leaf goes through `wireInt()` / `wireNumber()` from
 * `@delfrance/core/wire`: money arrives as decimal STRINGS (line prices with
 * four decimals, quantities with three, totals with two), while one instalment
 * value arrived as a JSON number. Enforced by
 * `packages/config-eslint/rules/integration-response-numbers-tolerant.test.js`,
 * which scans every file under `src/`. Two deliberate exceptions, each stated
 * at its field:
 *
 *  - `itens[].preco_custo` is `z.unknown()`: its value is not reliably numeric,
 *    and one unreadable cost must never cost the order (the mapper reads it with
 *    `parseWireDecimal`, which answers `null`);
 *  - `envios[].forma_envio.id` is kept RAW (string or number): step 20's
 *    shipping-method key builder (`mapaFreteLojaIntegrada.ts` in
 *    `@delfrance/schemas`) is the authority on that id's form, and a coercion
 *    here would fold `'0141909'` or `' 141909'` into a key that builder
 *    deliberately refuses. ⚠️ Name no helper of that module in this file: the
 *    equivalence-fold inventory scans comments too.
 *
 * Text that only LOOKS numeric stays text end to end: `sku` (14 to 17 digits,
 * beyond what a safe integer guarantees), the CEP, the address number, the
 * card authorization code.
 */
import { wireInt, wireNumber } from '@delfrance/core/wire';
import { z } from 'zod';

/**
 * An identifier the provider may type either way, read as given — the older
 * per-field tolerance idiom, for ids that are only ever compared as TEXT or
 * checked for presence.
 */
const textoOuNumero = z.union([z.string(), z.number()]);

/** A free-text leaf, absent or `null` when the provider has nothing. */
const texto = () => z.string().nullable().optional();

/**
 * A list the import iterates. An ABSENT key and a JSON `null` both read as
 * `[]` — an order with no payment yet or no shipment may well send `null`, and a
 * refusal here would park it for good. A value that is neither (an object, a
 * string) is still refused. The `.nullish().transform()` idiom of
 * `mlShipmentOrdersSchema`.
 */
function lista<T extends z.ZodType>(item: T) {
  return z
    .array(item)
    .nullish()
    .transform((v) => v ?? []);
}

/**
 * The situação as an order (or a history row) embeds it. Only `codigo` is
 * typed; see the module header for why the flags are not.
 */
export const liSituacaoSchema = z
  .object({
    codigo: z.string(),
    /** The provider's numeric id — diagnostic only, never a key. */
    id: wireInt().nullable().optional(),
  })
  .passthrough();

export type SituacaoLiWire = z.infer<typeof liSituacaoSchema>;

/**
 * `itens[].produto`: the captures show a resource-URI STRING, while the public
 * document's current example shows an OBJECT. Both are accepted; the importer
 * tells an LI produto id from an `id_externo` by the form (step 5).
 */
export const liProdutoDoItemSchema = z.union([
  z.string(),
  z
    .object({
      resource_uri: texto(),
      id_externo: textoOuNumero.nullable().optional(),
    })
    .passthrough(),
]);

/** One order line. */
export const liPedidoItemSchema = z
  .object({
    id: wireInt().nullable().optional(),
    linha: wireInt().nullable().optional(),
    sku: texto(),
    nome: texto(),
    tipo: texto(),
    quantidade: wireNumber().nullable().optional(),
    preco_venda: wireNumber().nullable().optional(),
    preco_cheio: wireNumber().nullable().optional(),
    preco_promocional: wireNumber().nullable().optional(),
    preco_subtotal: wireNumber().nullable().optional(),
    /**
     * ⚠️ `z.unknown()`, NOT `wireNumber()`: an empty or non-numeric string here
     * would fail the whole order. The mapper reads it with `parseWireDecimal`.
     * The `.optional()` is load-bearing: Zod 4 rejects an ABSENT key under a
     * bare `z.unknown()`.
     */
    preco_custo: z.unknown().optional(),
    produto: liProdutoDoItemSchema.nullable().optional(),
    /** The parent produto's resource URI, for a variation line. */
    produto_pai: texto(),
    peso: wireNumber().nullable().optional(),
    altura: wireNumber().nullable().optional(),
    largura: wireNumber().nullable().optional(),
    profundidade: wireNumber().nullable().optional(),
  })
  .passthrough();

export type PedidoItemLi = z.infer<typeof liPedidoItemSchema>;

/**
 * An order's shipping method. In the provider's wire, `id` names the gateway
 * and `code` the service inside it, so one id can carry several codes; a
 * pickup method arrives with `tipo: null`.
 */
export const liFormaEnvioSchema = z
  .object({
    /** Kept RAW — see the module header. */
    id: textoOuNumero.nullable().optional(),
    code: texto(),
    nome: texto(),
    tipo: texto(),
  })
  .passthrough();

/** One shipment of an order. `prazo` is in days. */
export const liPedidoEnvioSchema = z
  .object({
    id: wireInt().nullable().optional(),
    objeto: texto(),
    link_rastreio: texto(),
    prazo: wireInt().nullable().optional(),
    valor: wireNumber().nullable().optional(),
    data_criacao: texto(),
    data_modificacao: texto(),
    forma_envio: liFormaEnvioSchema.nullable().optional(),
  })
  .passthrough();

export type PedidoEnvioLi = z.infer<typeof liPedidoEnvioSchema>;

/** The payment method an order's payment used. */
export const liFormaPagamentoSchema = z
  .object({
    id: wireInt().nullable().optional(),
    codigo: texto(),
    nome: texto(),
  })
  .passthrough();

/** The instalment plan: `{}` on a PIX or boleto payment. */
export const liParcelamentoSchema = z
  .object({
    numero_parcelas: wireInt().nullable().optional(),
    valor_parcela: wireNumber().nullable().optional(),
  })
  .passthrough();

/**
 * One payment of an order.
 *
 * ⚠️ `valor_pago` is a copy of the amount DUE, not a paid signal: it equals
 * `valor` on an order still awaiting payment. Whether a payment was captured
 * comes from the situação codigo alone.
 */
export const liPedidoPagamentoSchema = z
  .object({
    id: wireInt().nullable().optional(),
    valor: wireNumber().nullable().optional(),
    valor_pago: wireNumber().nullable().optional(),
    pagamento_tipo: texto(),
    forma_pagamento: liFormaPagamentoSchema.nullable().optional(),
    parcelamento: liParcelamentoSchema.nullable().optional(),
    bandeira: texto(),
    authorization_code: texto(),
  })
  .passthrough();

export type PedidoPagamentoLi = z.infer<typeof liPedidoPagamentoSchema>;

/** The buyer: the order's fiscal identity. */
export const liPedidoClienteSchema = z
  .object({
    id: wireInt().nullable().optional(),
    nome: texto(),
    razao_social: texto(),
    cpf: texto(),
    cnpj: texto(),
    email: texto(),
    telefone_celular: texto(),
    telefone_principal: texto(),
  })
  .passthrough();

/** The delivery address, with the recipient's name (who may not be the buyer). */
export const liEnderecoEntregaSchema = z
  .object({
    nome: texto(),
    razao_social: texto(),
    cpf: texto(),
    cnpj: texto(),
    ie: texto(),
    cep: texto(),
    endereco: texto(),
    numero: texto(),
    complemento: texto(),
    bairro: texto(),
    cidade: texto(),
    estado: texto(),
    pais: texto(),
    referencia: texto(),
  })
  .passthrough();

/**
 * `GET /v1/pedido/{numero}/` — the order detail the import re-fetches for every
 * notification.
 *
 * ⚠️ Keyed by `numero`, never by the top-level `id` the GET also carries: the
 * path, every resource URI and the deterministic pedido id all use the numero.
 *
 * `id_anymarket` is read for presence only (one of the hub guard's markers).
 * The order's own `id_externo` is NOT a hub marker — a store-side ERP may stamp
 * it through the platform's API on an ordinary storefront order — and nothing
 * reads it, so it is not declared: `.passthrough()` keeps it, whatever its
 * shape.
 */
export const liPedidoSchema = z
  .object({
    numero: wireInt(),
    situacao: liSituacaoSchema,
    data_modificacao: z.string(),
    data_criacao: texto(),
    valor_total: wireNumber().nullable().optional(),
    valor_subtotal: wireNumber().nullable().optional(),
    valor_envio: wireNumber().nullable().optional(),
    valor_desconto: wireNumber().nullable().optional(),
    cliente: liPedidoClienteSchema.nullable().optional(),
    endereco_entrega: liEnderecoEntregaSchema.nullable().optional(),
    itens: lista(liPedidoItemSchema),
    envios: lista(liPedidoEnvioSchema),
    pagamentos: lista(liPedidoPagamentoSchema),
    id_anymarket: textoOuNumero.nullable().optional(),
    cliente_obs: texto(),
    utm_campaign: texto(),
  })
  .passthrough();

export type PedidoLi = z.infer<typeof liPedidoSchema>;

/**
 * One row of `GET /v1/situacao_historico/search/?numero=` — a situação change
 * of one order, `situacao_anterior` → `situacao`, at `data` (a naive stamp).
 * The first change of an order may have no previous situação.
 */
export const liSituacaoHistoricoLinhaSchema = z
  .object({
    id: wireInt(),
    numero: wireInt(),
    data: z.string(),
    situacao: liSituacaoSchema,
    situacao_anterior: liSituacaoSchema.nullable().optional(),
  })
  .passthrough();

export type SituacaoHistoricoLinhaLi = z.infer<typeof liSituacaoHistoricoLinhaSchema>;

/**
 * `GET /v1/produto/{id}/?id_externo=1` as the order import reads it: only the
 * LI produto id the store's external id resolves to. The full produto schema
 * arrives with the product import (step 9).
 */
export const liProdutoIdentidadeSchema = z
  .object({
    id: wireInt(),
    sku: texto(),
  })
  .passthrough();

export type ProdutoIdentidadeLi = z.infer<typeof liProdutoIdentidadeSchema>;
