/**
 * What Amazon's `getInvoiceStatus` answer SAYS about an order's NF-e (step 14,
 * PR 14-b): {@link lerStatusNfeAmazon} over a 2xx body, and
 * {@link leituraDaFalhaDeStatusNfeAmazon} over a refused status read. Pure: no
 * call, no clock, no Firestore, no logger.
 *
 * ## Exact strings, the PascalCase vocabulary only
 *
 * The Delivery API answers in PascalCase (`Accepted`); the order's own
 * `tax.taxInvoicing.invoiceStatus` is UPPER_SNAKE (`ACCEPTED`) and is NEVER
 * read here — this module imports the package's three PascalCase constant
 * tables and never `INVOICE_STATUS_AMAZON` (a source scan in the test pins it).
 * Every comparison is exact: no case fold, no trim, so `'ACCEPTED'`,
 * `'accepted'` and `'Accepted '` are unknown tokens, never a guess. And each
 * field is read against ITS OWN vocabulary: `Errored` is an `invoiceStatus`
 * value, so on `orderInvoicingStatus` it is unknown.
 *
 * ## The order, in this exact sequence
 *
 * 1. A non-empty `errors` list reads `indeterminado`, whatever else the body
 *    holds — the model puts `errors` on every response, a 200 included, and a
 *    blind submit on such a body is exactly what reading status first exists to
 *    prevent. `errors` absent, `null` or `[]` goes on.
 * 2. Any token outside its field's vocabulary ⇒ `indeterminado`.
 * 3. `orderInvoicingStatus` (the model: "the invoicing status of the order,
 *    considering the aggregated results of all invoices sent"), then
 *    `invoiceStatus`, then `invoices[].status` — the order #1938 states.
 *
 * ⚠️ The aggregate never says WHICH invoice is ours, and `invoices[].id` is not
 * our access key (capture C2, n=1), so every reading below is about the
 * ORDER's invoices, never "our" one (step-14 plan §3 decision 16).
 *
 * | `orderInvoicingStatus` | `invoiceStatus` | `invoices[]` | reading |
 * | --- | --- | --- | --- |
 * | absent | `NotFound` | absent, `[]`, or every row `NotFound` | `sem-nota` |
 * | absent | absent | absent or `[]` | `sem-nota` |
 * | `Processing` | any | any | `processando` |
 * | absent | `Processing` | any | `processando` |
 * | `Accepted` | `Accepted` or absent | non-empty, EVERY row `Accepted` | `aceita` |
 * | absent | `Accepted` | absent, or every row `Accepted` | `aceita` |
 * | `Rejected` | any | any | `recusada` |
 * | absent | `Errored` | any | `recusada` |
 * | `PartiallyAccepted` | any | some row `Processing` | `processando` |
 * | `PartiallyAccepted` | any | no row `Processing`, some `Accepted` | `aceita-com-recusa` |
 * | `PartiallyAccepted` | any | absent, `[]`, or neither | `parcial` |
 * | anything else | | | `indeterminado` |
 *
 * - Acceptance is DERIVED, never trusted from the aggregate: `Accepted` with a
 *   row still `Processing` (or with no row at all) contradicts itself and is
 *   `indeterminado`.
 * - `PartiallyAccepted` is SPLIT: once any earlier invoice of the order was
 *   rejected, the aggregate stays `PartiallyAccepted` for good —
 *   `[Rejected(old), Processing(new)]` at the first rung, `[Rejected(old),
 *   Accepted(new)]` once settled. Reading it as terminal would dead-end the
 *   only retry path.
 *
 * ## A refused status read ({@link leituraDaFalhaDeStatusNfeAmazon})
 *
 * The task reads status only for an order the live `getOrder` gate has just
 * proved to exist as a merchant-fulfilled Delivery order, so a 404 or a 400
 * whose codes hold `EntityNotFound` is read as `sem-nota`: a wrong submit on
 * such an order is refused by Amazon and ingests nothing, while reading it as
 * "stop" would block every upload if that is how Amazon says "no invoice yet"
 * (step-14 plan §3 decision 7; a capture may flip it). Any other 4xx/3xx (a 400
 * `InvalidInput`) and a 2xx off its schema are `indeterminado`. A credential
 * refusal, a 429, a 5xx, a cut connection, a refused input
 * (`AmazonConfigError`) or anything unknown answers `null`: not a reading, the
 * caller's to handle.
 */
import {
  AmazonAuthError,
  AmazonHttpError,
  AmazonNotFoundError,
  AmazonSchemaError,
  AmazonThrottleError,
  type RespostaStatusNotaFiscal,
  STATUS_FATURAMENTO_PEDIDO_AMAZON,
  STATUS_FATURA_ENTREGA_AMAZON,
  STATUS_FATURA_ITEM_AMAZON,
} from '@delfrance/integrations-amazon-sp-api';

import { LEITURA_ANTES_NFE_AMAZON } from './tarefaNfe';

/* -------------------------------------------------------------------------- */
/*                                the readings                                */
/* -------------------------------------------------------------------------- */

/** Every reading. `sem-nota` and `recusada` are spelled by `tarefaNfe.ts` (module header there). */
export const LEITURA_STATUS_NFE_AMAZON = {
  semNota: LEITURA_ANTES_NFE_AMAZON.semNota,
  processando: 'processando',
  aceita: 'aceita',
  recusada: LEITURA_ANTES_NFE_AMAZON.recusada,
  aceitaComRecusa: 'aceita-com-recusa',
  parcial: 'parcial',
  indeterminado: 'indeterminado',
} as const;

export type TipoLeituraStatusNfe =
  (typeof LEITURA_STATUS_NFE_AMAZON)[keyof typeof LEITURA_STATUS_NFE_AMAZON];

/** Which part of the answer made a reading `indeterminado`. */
export type CampoStatusNfeAmazon =
  | 'errors'
  | 'orderInvoicingStatus'
  | 'invoiceStatus'
  | 'invoices'
  | 'combinacao'
  | 'resposta';

/** The token that stands for any value outside every Delivery vocabulary. */
export const VALOR_STATUS_OUTRO = '<outro>';

/** One reading of an order's invoices. */
export type LeituraStatusNfe =
  | { readonly tipo: Exclude<TipoLeituraStatusNfe, 'indeterminado'> }
  | {
      readonly tipo: typeof LEITURA_STATUS_NFE_AMAZON.indeterminado;
      /** Where the reading broke. */
      readonly campo: CampoStatusNfeAmazon;
      /**
       * The first unknown token, CLOSED: a Delivery constant as Amazon spelled
       * it, {@link VALOR_STATUS_OUTRO} for anything else, `null` where no single
       * token is to blame (an `errors` list, a contradiction, a refused read).
       */
      readonly valor: string | null;
    };

const leitura = (tipo: Exclude<TipoLeituraStatusNfe, 'indeterminado'>): LeituraStatusNfe => ({
  tipo,
});

const indeterminado = (campo: CampoStatusNfeAmazon, valor: string | null): LeituraStatusNfe => ({
  tipo: LEITURA_STATUS_NFE_AMAZON.indeterminado,
  campo,
  valor,
});

/* -------------------------------------------------------------------------- */
/*                               the vocabularies                             */
/* -------------------------------------------------------------------------- */

const DO_PEDIDO: readonly string[] = Object.values(STATUS_FATURAMENTO_PEDIDO_AMAZON);
const DA_FATURA: readonly string[] = Object.values(STATUS_FATURA_ENTREGA_AMAZON);
const DO_ITEM: readonly string[] = Object.values(STATUS_FATURA_ITEM_AMAZON);
const CONHECIDOS: ReadonlySet<string> = new Set([...DO_PEDIDO, ...DA_FATURA, ...DO_ITEM]);

/** A token as a reading may carry it: a known Delivery constant, else {@link VALOR_STATUS_OUTRO}. */
function valorFechado(valor: unknown): string {
  return typeof valor === 'string' && CONHECIDOS.has(valor) ? valor : VALOR_STATUS_OUTRO;
}

/** `absent` for `null`/`undefined`; the value when it is in `vocabulario`; `desconhecido` otherwise. */
function token(
  valor: unknown,
  vocabulario: readonly string[],
):
  | { readonly tipo: 'ausente' }
  | { readonly tipo: 'conhecido'; readonly valor: string }
  | {
      readonly tipo: 'desconhecido';
    } {
  if (valor === null || valor === undefined) return { tipo: 'ausente' };
  return typeof valor === 'string' && vocabulario.includes(valor)
    ? { tipo: 'conhecido', valor }
    : { tipo: 'desconhecido' };
}

/* -------------------------------------------------------------------------- */
/*                                 the reader                                 */
/* -------------------------------------------------------------------------- */

/** What the order says, once every token is known (module header's table). */
function lerAgregado(
  pedido: string | null,
  fatura: string | null,
  itens: readonly string[],
): LeituraStatusNfe {
  const algum = (s: string) => itens.some((i) => i === s);
  const todos = (s: string) => itens.every((i) => i === s);

  if (pedido !== null) {
    switch (pedido) {
      case STATUS_FATURAMENTO_PEDIDO_AMAZON.processing:
        return leitura(LEITURA_STATUS_NFE_AMAZON.processando);
      case STATUS_FATURAMENTO_PEDIDO_AMAZON.rejected:
        return leitura(LEITURA_STATUS_NFE_AMAZON.recusada);
      case STATUS_FATURAMENTO_PEDIDO_AMAZON.accepted:
        return (fatura === null || fatura === STATUS_FATURA_ENTREGA_AMAZON.accepted) &&
          itens.length > 0 &&
          todos(STATUS_FATURA_ITEM_AMAZON.accepted)
          ? leitura(LEITURA_STATUS_NFE_AMAZON.aceita)
          : indeterminado('combinacao', null);
      case STATUS_FATURAMENTO_PEDIDO_AMAZON.partiallyAccepted:
        if (algum(STATUS_FATURA_ITEM_AMAZON.processing)) {
          return leitura(LEITURA_STATUS_NFE_AMAZON.processando);
        }
        return algum(STATUS_FATURA_ITEM_AMAZON.accepted)
          ? leitura(LEITURA_STATUS_NFE_AMAZON.aceitaComRecusa)
          : leitura(LEITURA_STATUS_NFE_AMAZON.parcial);
      default:
        return indeterminado('orderInvoicingStatus', valorFechado(pedido));
    }
  }

  switch (fatura) {
    case null:
      return itens.length === 0
        ? leitura(LEITURA_STATUS_NFE_AMAZON.semNota)
        : indeterminado('combinacao', null);
    case STATUS_FATURA_ENTREGA_AMAZON.notFound:
      return todos(STATUS_FATURA_ITEM_AMAZON.notFound)
        ? leitura(LEITURA_STATUS_NFE_AMAZON.semNota)
        : indeterminado('combinacao', null);
    case STATUS_FATURA_ENTREGA_AMAZON.processing:
      return leitura(LEITURA_STATUS_NFE_AMAZON.processando);
    case STATUS_FATURA_ENTREGA_AMAZON.accepted:
      return todos(STATUS_FATURA_ITEM_AMAZON.accepted)
        ? leitura(LEITURA_STATUS_NFE_AMAZON.aceita)
        : indeterminado('combinacao', null);
    case STATUS_FATURA_ENTREGA_AMAZON.errored:
      return leitura(LEITURA_STATUS_NFE_AMAZON.recusada);
    default:
      return indeterminado('invoiceStatus', valorFechado(fatura));
  }
}

/**
 * The reading of a 2xx `getInvoiceStatus` body (module header). Total: never
 * throws, whatever the (already schema-parsed, tolerant) body holds.
 */
export function lerStatusNfeAmazon(dados: RespostaStatusNotaFiscal): LeituraStatusNfe {
  // 1. A non-empty `errors` list wins over everything.
  const erros = dados.errors;
  if (Array.isArray(erros) && erros.length > 0) return indeterminado('errors', null);

  // 2. Every token against its own field's vocabulary, exactly.
  const pedido = token(dados.orderInvoicingStatus, DO_PEDIDO);
  if (pedido.tipo === 'desconhecido') {
    return indeterminado('orderInvoicingStatus', valorFechado(dados.orderInvoicingStatus));
  }
  const fatura = token(dados.invoiceStatus, DA_FATURA);
  if (fatura.tipo === 'desconhecido') {
    return indeterminado('invoiceStatus', valorFechado(dados.invoiceStatus));
  }
  const itens: string[] = [];
  for (const linha of dados.invoices ?? []) {
    const item = token(linha.status, DO_ITEM);
    // A row without a status is no reading either.
    if (item.tipo !== 'conhecido') return indeterminado('invoices', valorFechado(linha.status));
    itens.push(item.valor);
  }

  // 3. The aggregate, then the invoice, then the rows.
  return lerAgregado(
    pedido.tipo === 'conhecido' ? pedido.valor : null,
    fatura.tipo === 'conhecido' ? fatura.valor : null,
    itens,
  );
}

/* -------------------------------------------------------------------------- */
/*                              a refused status read                         */
/* -------------------------------------------------------------------------- */

/** The `errors[].code` of an answer about the ORDER entity (the submit's 400 sandbox, too). */
export const CODIGO_ENTIDADE_NAO_ENCONTRADA_AMAZON = 'EntityNotFound';

/**
 * A REFUSED status read as a reading (module header), or `null` when the
 * failure is not a reading at all — the caller's (a credential refusal, a 429,
 * a 5xx, a cut connection, a refused input, a bug). Subclasses are tested
 * before their base, so a 401 or a 429 never reads as a 4xx answer.
 */
export function leituraDaFalhaDeStatusNfeAmazon(err: unknown): LeituraStatusNfe | null {
  if (err instanceof AmazonNotFoundError) return leitura(LEITURA_STATUS_NFE_AMAZON.semNota);
  if (err instanceof AmazonAuthError || err instanceof AmazonThrottleError) return null;
  if (err instanceof AmazonHttpError) {
    if (err.transitorio) return null;
    if (err.status === 400 && err.codigosErro.includes(CODIGO_ENTIDADE_NAO_ENCONTRADA_AMAZON)) {
      return leitura(LEITURA_STATUS_NFE_AMAZON.semNota);
    }
    return indeterminado('resposta', null);
  }
  if (err instanceof AmazonSchemaError) return indeterminado('resposta', null);
  return null;
}
