/**
 * Tokens v2021-03-01 (`tokens_2021-03-01.json`): the Restricted Data Token (RDT)
 * mint, `createRestrictedDataToken` (`POST /tokens/2021-03-01/restrictedDataToken`),
 * through the WRITE client (`escrita.ts`) and the LWA access token:
 * {@link criarTokenRestrito}. The model's usage plan is 1 request per second,
 * burst 10.
 *
 * An RDT is a short-lived access token for ONE restricted operation; the app
 * passes it as the access token of the client that makes that call. Written
 * from the model and its sandbox examples, never from a live call (D11).
 *
 * ## One resource, not a generic minter
 *
 * The only resource this module mints for is {@link RECURSO_RESTRITO_AGENDAMENTO}
 * — `POST` on the Easy Ship bulk path (`easyShip.ts`) — and the parameter's type
 * is that closed literal. A type is a compile-time fence a cast can cross, so
 * the body is built from the CONSTANT's named keys, never from the argument's:
 * whatever resource a caller smuggles in, the body is EXACTLY
 * `{ restrictedResources: [{ method: 'POST', path: <the bulk path> }] }`:
 *
 * - no `dataElements`: the model marks it optional (no `minItems`), required
 *   only for the Orders API's buyer data, which this resource is not;
 * - no `targetApplication`: the token is for this application's own call, not
 *   delegated to another one.
 *
 * That is the documented form (the model's own sandbox sends neither), the same
 * rule `easyShip.ts` follows by omitting `packageDetails`.
 *
 * ## The response
 *
 * `restrictedDataToken` must be 1–4096 visible ASCII characters: a token with a
 * space, a line break or a control character is refused with
 * `AmazonSchemaError` (field paths only, never the value) rather than handed on
 * as a header value. `expiresIn` is read through `wireInt()` (a quoted number
 * must not cost the token) and may be absent.
 *
 * ⚠️ The token is a credential. This module never caches it, no error ever
 * carries it, and it reaches ONE place: the caller. The observer event of the
 * mint (`onChamada`) carries `corpo: null` STRUCTURALLY: the request core
 * (`client.ts`) builds every Tokens API event with `levaCorpo: false`, decided
 * from the path — the flag `lwa.ts` sets for every LWA event — so neither this
 * call site nor a cast decides it. The app's logger also classifies
 * this path as a secret one and excerpts nothing of it — a second fence, not
 * the only one.
 */
import { wireInt } from '@delfrance/core/wire';
import { z } from 'zod';

import { CAMINHO_AGENDAMENTO_EASY_SHIP } from './easyShip';
import type { SpApiEscritaClient } from './escrita';

/** The model's `operationId`, the call's label on the observer's event. */
export const OPERACAO_TOKEN_RESTRITO = 'createRestrictedDataToken';

/** The mint's path. */
export const CAMINHO_TOKEN_RESTRITO = '/tokens/2021-03-01/restrictedDataToken';

/** The one restricted resource this package mints a token for: the Easy Ship bulk. */
export const RECURSO_RESTRITO_AGENDAMENTO = Object.freeze({
  method: 'POST',
  path: CAMINHO_AGENDAMENTO_EASY_SHIP,
} as const);

/** The closed type of the resource parameter: that literal, nothing else. */
export type RecursoRestritoAmazon = typeof RECURSO_RESTRITO_AGENDAMENTO;

/** An RDT: visible ASCII, 1–4096 characters, never trimmed. */
const TOKEN_RESTRITO = /^[\x21-\x7E]{1,4096}$/;

/** `CreateRestrictedDataTokenResponse` (module header). */
export const respostaTokenRestritoSchema = z
  .object({
    restrictedDataToken: z.string().regex(TOKEN_RESTRITO),
    expiresIn: wireInt().nullish(),
  })
  .passthrough();

export type RespostaTokenRestrito = z.infer<typeof respostaTokenRestritoSchema>;

/** A minted RDT and its lifetime in seconds (`null` when Amazon sent none). */
export interface TokenRestritoAmazon {
  readonly token: string;
  readonly expiraEmS: number | null;
}

/**
 * `createRestrictedDataToken` for the one resource, through the write client
 * built with the LWA access token. Sent once; a 2xx whose token fails its
 * grammar is `AmazonSchemaError`, and any other failure is the client's error.
 * A cut or failed mint left nothing behind that matters: the caller mints again
 * on its next run, never reusing a token across runs.
 *
 * `recurso` names the resource at the type level only: the body reads the
 * constant (module header), so a cast cannot turn this into a generic minter.
 */
export async function criarTokenRestrito(
  escritor: SpApiEscritaClient,
  recurso: RecursoRestritoAmazon,
  sinal?: AbortSignal,
): Promise<TokenRestritoAmazon> {
  const corpo = JSON.stringify({
    restrictedResources: [
      { method: RECURSO_RESTRITO_AGENDAMENTO.method, path: RECURSO_RESTRITO_AGENDAMENTO.path },
    ],
  });

  const r = await escritor.post({
    operacao: OPERACAO_TOKEN_RESTRITO,
    caminho: CAMINHO_TOKEN_RESTRITO,
    corpo,
    schema: respostaTokenRestritoSchema,
    sinal,
  });

  return { token: r.dados.restrictedDataToken, expiraEmS: r.dados.expiresIn ?? null };
}
