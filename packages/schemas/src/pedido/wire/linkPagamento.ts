import { z } from 'zod';
import { somarDiasCivis } from '@delfrance/core/datetime';
import { roundReais } from '@delfrance/core/money';
import {
  MODO_LINK_PAGAMENTO,
  linkPagamentoIdSchema,
  modoLinkPagamentoSchema,
  statusLinkPagamentoSchema,
  tipoPagamentoMpSchema,
} from '../collection/linkPgtoMercadoPago';
import { estadoPedidoSchema } from '../collection/pedido';
import { LIMITES_LINK_PAGAMENTO, motivoRecusaLinkSchema } from '../pureLogic/linkPagamento';

/*
 * The ONE request / response contract of the Mercado Pago payment-link routes
 * (#367), shared by `apps/mercado-pago` (the routes, which validate the request
 * with the STRICT schemas) and `apps/web` (the client, which validates the
 * response with the tolerant ones through `lerRespostaJson`).
 *
 * Declared once, here, because the two sides used to be designed apart and
 * disagreed on the route paths, the body fields, the enum values and the response
 * shapes — every call would have answered 400 or thrown a response-validation
 * error. Browser-safe: only zod, `@delfrance/core` and sibling schemas.
 *
 * Request schemas are `z.strictObject` (an unknown key is a client bug worth a
 * 400); response schemas are plain `z.object` (a backend that adds a field must
 * not break a client that has not shipped yet).
 */

/* -------------------------------------------------------------------------- */
/*                         Limits, routes, permissions                         */
/* -------------------------------------------------------------------------- */

/** The three routes of `apps/mercado-pago`. All `POST`, all under the same prefix. */
export const ROTA_LINK_PAGAMENTO = {
  criar: '/api/payments/mercado-pago/links/criar',
  cancelar: '/api/payments/mercado-pago/links/cancelar',
  sincronizar: '/api/payments/mercado-pago/links/sincronizar',
} as const;

/**
 * The permission masks of the feature. Literal `bigint`s because this package
 * cannot import `@delfrance/auth`; `packages/data` pins each against `PERM` in a
 * test, so a renumbered bit reds CI instead of silently locking users out.
 *
 * ⚠️ `hasPerm` / `usePermission` require ALL the bits of a mask, so a combined
 * mask is a genuine AND:
 *  - `ler`          — `pagamento.read`: see the tab (the links and the payments
 *    that settle them are read on the same bit).
 *  - `gerenciar`    — `pedido.write | pagamento.write`: create, cancel and
 *    synchronise. The route flips the pedido's estado, hence `pedido.write`.
 *  - `listarContas` — `metodoPagamento.read`: read the `metodo_pgto` accounts to
 *    fill the account picker.
 */
export const PERM_LINK_PAGAMENTO = {
  ler: 1n << 24n,
  gerenciar: (1n << 17n) | (1n << 25n),
  listarContas: 1n << 27n,
} as const;

/* -------------------------------------------------------------------------- */
/*                               Field schemas                                 */
/* -------------------------------------------------------------------------- */

/**
 * The label the operator types for each payer — a FIRST name (LGPD): letters
 * (any script), marks, space, apostrophe, dot and hyphen, at most
 * {@link LIMITES_LINK_PAGAMENTO}`.nomePagadorMax` characters after trimming.
 * A space and a dot are allowed so two payers with the same name can be told
 * apart (`Maria S.`); a digit is not.
 */
export const nomePagadorSchema = z
  .string()
  .trim()
  .min(1)
  .max(LIMITES_LINK_PAGAMENTO.nomePagadorMax)
  .regex(/^[\p{L}\p{M}' .-]+$/u);

/**
 * What one link charges: at least {@link LIMITES_LINK_PAGAMENTO}`.valorMinimo`
 * and at most two decimals. A value with a third decimal is REJECTED, not
 * rounded — the amount sent to Mercado Pago must be exactly the amount the
 * operator saw, or the batch would no longer add up to the pedido's total.
 * (`z.number()` already rejects `NaN` and `±Infinity` in Zod 4.)
 */
export const valorLinkPagamentoSchema = z
  .number()
  .min(LIMITES_LINK_PAGAMENTO.valorMinimo)
  .refine((valor) => roundReais(valor) === valor, 'no máximo 2 casas decimais');

/**
 * A pedido id as the routes accept it: 1..64 of `[A-Za-z0-9_-]`. Doubles as
 * Mercado Pago's `external_reference` rule (at most 64 characters, letters,
 * digits, hyphen and underscore), so any id that passes here can be sent as one.
 */
export const pedidoIdLinkSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** A civil date `YYYY-MM-DD` that exists on the calendar (`2026-02-30` does not). */
const dataCivilSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((data) => somarDiasCivis(data, 0) !== null, 'data inválida');

/* -------------------------------------------------------------------------- */
/*                                   criar                                     */
/* -------------------------------------------------------------------------- */

/**
 * `POST` {@link ROTA_LINK_PAGAMENTO}`.criar` body.
 *
 *  - `modo: 'individual'` — one link per payer (a vaquinha is N of them, or a
 *    single link for one payer). `quantidadeMaxima` must be `null`.
 *  - `modo: 'compartilhado'` — ONE link paid `quantidadeMaxima` times; `links`
 *    then has exactly one entry, whose `valor` is each payment's amount.
 *
 * The link ids are minted by the CLIENT (`newDocId()`, 20 characters) so a
 * retried request reuses them and the server can recognise a replay.
 * `valorCobradoEsperado` is the pedido total the operator SAW: the server
 * answers 409 `valorDesatualizado` when the stored total differs.
 * `expiraEm` is a civil date in `America/Sao_Paulo`; the server turns it into
 * that day's `23:59:59-03:00`. `preencherPagador` prefills the pedido's cliente
 * in the checkout and is only meaningful for a single individual link.
 *
 * Cross-field rules live in `superRefine`; each issue carries the `path` of the
 * offending field and a pt-BR message the form can show as-is.
 */
export const criarLinksPagamentoBodySchema = z
  .strictObject({
    pedidoId: pedidoIdLinkSchema,
    metodoId: z.string().min(1).max(128),
    modo: modoLinkPagamentoSchema,
    valorCobradoEsperado: z.number(),
    expiraEm: dataCivilSchema,
    // At most three of the four types, so one payment method always stays enabled.
    tiposExcluidos: z.array(tipoPagamentoMpSchema).max(3).default([]),
    parcelasMaximas: z
      .number()
      .int()
      .min(1)
      .max(LIMITES_LINK_PAGAMENTO.parcelasMax)
      .nullable()
      .default(null),
    quantidadeMaxima: z
      .number()
      .int()
      .min(2)
      .max(LIMITES_LINK_PAGAMENTO.quantidadeMaximaMax)
      .nullable()
      .default(null),
    preencherPagador: z.boolean().default(false),
    links: z
      .array(
        z.strictObject({
          linkId: linkPagamentoIdSchema,
          nomePagador: nomePagadorSchema.nullable(),
          valor: valorLinkPagamentoSchema,
        }),
      )
      .min(1)
      .max(LIMITES_LINK_PAGAMENTO.linksPorLoteMax),
  })
  .superRefine((corpo, ctx) => {
    const vistos = new Set<string>();
    corpo.links.forEach((link, indice) => {
      if (vistos.has(link.linkId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['links', indice, 'linkId'],
          message: 'Identificador de link repetido.',
        });
      }
      vistos.add(link.linkId);
    });

    const tipos = new Set<string>();
    corpo.tiposExcluidos.forEach((tipo, indice) => {
      if (tipos.has(tipo)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tiposExcluidos', indice],
          message: 'Tipo de pagamento repetido.',
        });
      }
      tipos.add(tipo);
    });

    if (corpo.modo === MODO_LINK_PAGAMENTO.compartilhado) {
      if (corpo.links.length !== 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['links'],
          message: 'O link compartilhado tem exatamente um link.',
        });
      }
      if (corpo.quantidadeMaxima === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['quantidadeMaxima'],
          message: 'Informe quantas pessoas vão pagar o link compartilhado.',
        });
      }
    } else if (corpo.quantidadeMaxima !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['quantidadeMaxima'],
        message: 'A quantidade máxima só vale para o link compartilhado.',
      });
    }

    if (
      corpo.preencherPagador &&
      (corpo.modo !== MODO_LINK_PAGAMENTO.individual || corpo.links.length !== 1)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['preencherPagador'],
        message: 'Só é possível preencher o pagador em um único link individual.',
      });
    }
  });

/** The body as the client builds it (defaults not yet applied). */
export type CriarLinksPagamentoBody = z.input<typeof criarLinksPagamentoBodySchema>;
/** The body after the route parsed it (defaults applied). */
export type CriarLinksPagamentoBodyParsed = z.output<typeof criarLinksPagamentoBodySchema>;

/** One link the route created (or, on a replay, found already created). */
export const linkCriadoSchema = z.object({
  /** The link's DOC id — the one the client minted. */
  linkId: z.string(),
  /** Mercado Pago's preference id. */
  preferenceId: z.string(),
  /** The checkout URL to send to the payer (`init_point`). */
  link: z.string(),
  valorCobrado: z.number(),
  nomePagador: z.string().nullable(),
  /** Deadline, epoch MILLISECONDS. */
  dataExpiracao: z.number(),
  modo: modoLinkPagamentoSchema,
  quantidadeMaxima: z.number().int().nullable(),
});
export type LinkCriado = z.infer<typeof linkCriadoSchema>;

/**
 * `criar` response. `estado` is the estado the pedido moved to (`null` when the
 * creation left it alone — only `iniciado` flips). `reaproveitado` is `true`
 * when every link id already existed and the stored links were returned as-is.
 */
export const criarLinksPagamentoRespostaSchema = z.object({
  links: z.array(linkCriadoSchema),
  estado: estadoPedidoSchema.nullable(),
  reaproveitado: z.boolean(),
});
export type CriarLinksPagamentoResposta = z.infer<typeof criarLinksPagamentoRespostaSchema>;

/* -------------------------------------------------------------------------- */
/*                                  cancelar                                   */
/* -------------------------------------------------------------------------- */

/** `POST` {@link ROTA_LINK_PAGAMENTO}`.cancelar` body. */
export const cancelarLinkPagamentoBodySchema = z.strictObject({
  pedidoId: pedidoIdLinkSchema,
  linkId: linkPagamentoIdSchema,
});
export type CancelarLinkPagamentoBody = z.infer<typeof cancelarLinkPagamentoBodySchema>;

/** `cancelar` response: the link's stored status afterwards. */
export const cancelarLinkPagamentoRespostaSchema = z.object({
  linkId: z.string(),
  status: statusLinkPagamentoSchema,
});
export type CancelarLinkPagamentoResposta = z.infer<typeof cancelarLinkPagamentoRespostaSchema>;

/* -------------------------------------------------------------------------- */
/*                                sincronizar                                  */
/* -------------------------------------------------------------------------- */

/** `POST` {@link ROTA_LINK_PAGAMENTO}`.sincronizar` body. */
export const sincronizarLinksPagamentoBodySchema = z.strictObject({
  pedidoId: pedidoIdLinkSchema,
});
export type SincronizarLinksPagamentoBody = z.infer<typeof sincronizarLinksPagamentoBodySchema>;

/**
 * `sincronizar` response: what the pull from Mercado Pago found and did.
 * `truncado` is `true` when the search hit its page cap and more payments may
 * exist; `transicoes` are the estados the pedido moved through.
 */
export const sincronizarLinksPagamentoRespostaSchema = z.object({
  encontrados: z.number().int(),
  reconciliados: z.number().int(),
  ignorados: z.number().int(),
  falhas: z.array(z.object({ paymentId: z.string(), motivo: z.string() })),
  transicoes: z.array(estadoPedidoSchema),
  truncado: z.boolean(),
});
export type SincronizarLinksPagamentoResposta = z.infer<
  typeof sincronizarLinksPagamentoRespostaSchema
>;

/* -------------------------------------------------------------------------- */
/*                                   errors                                    */
/* -------------------------------------------------------------------------- */

/**
 * The `code` of an error body, so a client tells a refusal from version skew: a
 * `404` WITHOUT a code is a backend that predates the route (or a proxy), while
 * `MP_CONTA_NAO_CONFIGURADA` is a real answer about the account.
 */
export const CODIGO_ERRO_LINK = {
  corpoInvalido: 'LINK_BODY_INVALIDO',
  naoElegivel: 'LINK_NAO_ELEGIVEL',
  linkNaoEncontrado: 'LINK_NAO_ENCONTRADO',
  pedidoNaoEncontrado: 'PEDIDO_NAO_ENCONTRADO',
  contaNaoConfigurada: 'MP_CONTA_NAO_CONFIGURADA',
  requisicaoRepetida: 'MP_REQUISICAO_REPETIDA',
} as const;

/**
 * The error body of every link route. `reason` accompanies `LINK_NAO_ELEGIVEL`
 * (409) and names why, in the same vocabulary the client-side gate uses
 * (`MOTIVO_RECUSA_LINK_LABELS`).
 */
export const erroLinkPagamentoSchema = z.object({
  error: z.string(),
  code: z.string().nullable().optional(),
  reason: motivoRecusaLinkSchema.nullable().optional(),
});
export type ErroLinkPagamento = z.infer<typeof erroLinkPagamentoSchema>;
