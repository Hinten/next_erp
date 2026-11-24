/**
 * The stock OUTCOME write-back of the Amazon stock sync (step 12, PR 12-d),
 * pure: the three shapes a link doc's `envioEstoqueAmazon` field takes, and
 * whether a new one replaces the stored one. Its reader and the preconditioned
 * `update` are `envioEstoqueFirestore.ts`'s binding of the listings flows'
 * shared write-back (`listings/envioListingFirestore.ts`).
 *
 * ## The watermark: `emMs`, strictly newer wins
 *
 * {@link decidirGravacaoEnvioEstoque} binds the listings flows' shared
 * watermark (`listings/envioListing.ts`, whose header holds the rule) to the
 * stock outcome. `emMs` is OUR submission instant (a patch: right before the
 * PATCH; a feed: right before `createFeed`), so a provisional `incerto` is
 * replaced by its own retry's outcome (a later submission).
 *
 * ## The three shapes (each parsed by `envioEstoqueAmazonSchema`)
 *
 *  - {@link envioDoPatch} — Amazon answered a PATCH of `quantidade`:
 *    `ACCEPTED` ⇒ `aceito` (or `aceito-com-avisos` when the answer carries an
 *    issue), `INVALID` ⇒ `recusado`; any other status tells nothing about
 *    whether the quantity applied, so it is kept as `incerto` (no id, no
 *    issue: a send whose outcome is unknown, which the plan's recent-send rule
 *    still counts). Amazon's issues are kept, `ERROR` ones first, at most
 *    `MAX_PROBLEMAS_ENVIO_ESTOQUE_AMAZON`;
 *  - {@link envioIncerto} — a PATCH of `quantidade` whose answer was lost,
 *    written BEFORE its retry so the retry reads it as a recent send;
 *  - {@link envioDoFeed} — a feed report's problems for one SKU: `quantidade:
 *    null` (the sent quantities live only inside the never-stored document),
 *    `recusado` when one is an `ERROR`, `aceito-com-avisos` when there are
 *    only others, `aceito` with none.
 *
 * Severities are compared EXACTLY, as Amazon spells them.
 *
 * PURE: no Firestore, no clock, no network.
 */
import type { EnvioListingAmazon } from '@delfrance/integrations-amazon-sp-api';
import {
  type EnvioEstoqueAmazon,
  MAX_PROBLEMAS_ENVIO_ESTOQUE_AMAZON,
  RESULTADO_ENVIO_ESTOQUE_AMAZON,
  type ResultadoEnvioEstoqueAmazon,
  VIA_ENVIO_ESTOQUE_AMAZON,
  envioEstoqueAmazonSchema,
} from '@delfrance/schemas';

import { decidirGravacaoEnvioListing } from '../listings/envioListing';

/** The two submission statuses a PATCH answer is read by, as the model spells them. */
export const STATUS_ENVIO_LISTING_AMAZON = {
  aceito: 'ACCEPTED',
  invalido: 'INVALID',
} as const;

/** The issue severity that refuses, as Amazon spells it. */
export const SEVERIDADE_ERRO_AMAZON = 'ERROR';

/** One issue in the link docs' shape: what a feed report's reducer and a PATCH answer both give. */
export interface ProblemaEnvioEstoqueAmazon {
  readonly code?: string | null;
  readonly message?: string | null;
  readonly severity?: string | null;
  readonly attributeNames?: readonly string[] | null;
  readonly categories?: readonly string[] | null;
}

/**
 * What {@link envioDoPatch} reads of Amazon's answer to a PATCH: the package's
 * `EnvioListingAmazon` is one (a test pins it).
 */
export interface RespostaPatchEstoqueAmazon {
  readonly status?: EnvioListingAmazon['status'];
  readonly submissionId?: EnvioListingAmazon['submissionId'];
  readonly issues?: readonly ProblemaEnvioEstoqueAmazon[] | null;
}

/**
 * Whether `novo` replaces the stored outcome (module header): nothing readable
 * stored, or a STRICTLY older `emMs`. Equal keeps the stored. The listings
 * flows' shared watermark (`listings/envioListing.ts`), bound to the stock
 * outcome.
 */
export function decidirGravacaoEnvioEstoque(
  armazenado: unknown,
  novo: EnvioEstoqueAmazon,
): boolean {
  return decidirGravacaoEnvioListing(armazenado, novo);
}

/** An issue in the link shape: every field present, `null` when Amazon left it out. */
function paraProblema(issue: ProblemaEnvioEstoqueAmazon) {
  return {
    code: issue.code ?? null,
    message: issue.message ?? null,
    severity: issue.severity ?? null,
    attributeNames: issue.attributeNames ? [...issue.attributeNames] : null,
    categories: issue.categories ? [...issue.categories] : null,
  };
}

/** The issues kept: `ERROR` ones first (each group in Amazon's order), at most the cap. */
function problemasGuardados(issues: readonly ProblemaEnvioEstoqueAmazon[]) {
  const erros = issues.filter((i) => i.severity === SEVERIDADE_ERRO_AMAZON);
  const outros = issues.filter((i) => i.severity !== SEVERIDADE_ERRO_AMAZON);
  return [...erros, ...outros].slice(0, MAX_PROBLEMAS_ENVIO_ESTOQUE_AMAZON).map(paraProblema);
}

/** A non-empty string, or `null`. */
function textoNaoVazio(valor: unknown): string | null {
  return typeof valor === 'string' && valor !== '' ? valor : null;
}

/**
 * The outcome of a PATCH of `quantidade` that Amazon answered (module header).
 *
 * @throws {ZodError} an `emMs` or a `quantidade` outside a non-negative safe integer.
 */
export function envioDoPatch(
  resposta: RespostaPatchEstoqueAmazon,
  emMs: number,
  quantidade: number,
): EnvioEstoqueAmazon {
  const issues = resposta.issues ?? [];
  let resultado: ResultadoEnvioEstoqueAmazon;
  if (resposta.status === STATUS_ENVIO_LISTING_AMAZON.aceito) {
    resultado =
      issues.length > 0
        ? RESULTADO_ENVIO_ESTOQUE_AMAZON.aceitoComAvisos
        : RESULTADO_ENVIO_ESTOQUE_AMAZON.aceito;
  } else if (resposta.status === STATUS_ENVIO_LISTING_AMAZON.invalido) {
    resultado = RESULTADO_ENVIO_ESTOQUE_AMAZON.recusado;
  } else {
    return envioIncerto(emMs, quantidade);
  }
  return envioEstoqueAmazonSchema.parse({
    via: VIA_ENVIO_ESTOQUE_AMAZON.patch,
    emMs,
    quantidade,
    resultado,
    submissionId: textoNaoVazio(resposta.submissionId),
    feedId: null,
    problemas: problemasGuardados(issues),
  });
}

/**
 * The provisional outcome of a PATCH of `quantidade` whose answer was lost
 * (module header).
 *
 * @throws {ZodError} an `emMs` or a `quantidade` outside a non-negative safe integer.
 */
export function envioIncerto(emMs: number, quantidade: number): EnvioEstoqueAmazon {
  return envioEstoqueAmazonSchema.parse({
    via: VIA_ENVIO_ESTOQUE_AMAZON.patch,
    emMs,
    quantidade,
    resultado: RESULTADO_ENVIO_ESTOQUE_AMAZON.incerto,
    submissionId: null,
    feedId: null,
    problemas: [],
  });
}

/**
 * One SKU's outcome from a feed report (module header). `emMs` is the feed's
 * submission instant (`antesDoEnvioMs`).
 *
 * @throws {ZodError} an `emMs` outside a non-negative safe integer, or a
 *   `feedId` outside the feed record's grammar.
 */
export function envioDoFeed(
  problemas: readonly ProblemaEnvioEstoqueAmazon[],
  feedId: string,
  emMs: number,
): EnvioEstoqueAmazon {
  const resultado = problemas.some((p) => p.severity === SEVERIDADE_ERRO_AMAZON)
    ? RESULTADO_ENVIO_ESTOQUE_AMAZON.recusado
    : problemas.length > 0
      ? RESULTADO_ENVIO_ESTOQUE_AMAZON.aceitoComAvisos
      : RESULTADO_ENVIO_ESTOQUE_AMAZON.aceito;
  return envioEstoqueAmazonSchema.parse({
    via: VIA_ENVIO_ESTOQUE_AMAZON.feed,
    emMs,
    quantidade: null,
    resultado,
    submissionId: null,
    feedId,
    problemas: problemasGuardados(problemas),
  });
}
