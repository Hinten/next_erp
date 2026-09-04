/**
 * `GET /api/oauth/shopee/callback?code=…&state=…&shop_id=…` — the redirect
 * target registered on the Shopee app.
 *
 * **No Bearer token** — it is a browser redirect from Shopee — so the signed
 * `state` plus its single-use record are the ONLY trust anchors. Shopee's
 * "OAuth" is authorization-code SHAPED but is not RFC 6749: no `client_secret`
 * in the request (the HMAC `sign` stands in), no `scope`, and no PKCE. The
 * legacy Flutter app sent no `state` at all.
 *
 * ## The order of the five checks, and why each sits where it does
 *
 *  1. **state secret** — without the HMAC key nothing here can be trusted;
 *     redirect to the LIST page (no id is trustworthy yet) with `reason=config`.
 *  2. **`state` present** — FAIL CLOSED. `guide 20` documents `state` as echoed
 *     "as-is", but its callback parameter table lists only `code`, `shop_id` and
 *     `main_account_id`. Until a live round trip settles that contradiction, a
 *     callback without a state is refused rather than trusted.
 *  3. **`verifyState`** — proves we minted it and it is fresh. It does NOT prove
 *     it is unused.
 *  4. **`code` present** — checked AFTER the state verifies and BEFORE the
 *     attempt is consumed. A cancelled consent must not burn the single-use
 *     attempt: with no code there is nothing to exchange, and forcing the
 *     operator to restart from `oauth/start` would be a worse answer than
 *     letting them retry the same pending attempt.
 *  5. **`consume`** — single-use redemption, BEFORE the exchange. A replay of a
 *     captured callback finds the attempt consumed and lands as `bad_state`,
 *     before anything touches the credential. Its failure is deliberately NOT an
 *     `exchange` error: nothing about the Shopee `code` can rescue an attempt we
 *     have no record of.
 *
 * ⚠️ **Never logged**: the `code` (a live credential until it is exchanged), the
 * partner key, any token, and any response body — on a schema failure that body
 * IS the token response (#1015). The failure log carries field PATHS instead.
 */
import { NextResponse } from 'next/server';
import {
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeNetworkError,
  ShopeeSchemaError,
  type ShopeeAuthSubject,
} from '@delfrance/integrations-shopee';
import { OauthStateError, verifyState } from '@delfrance/data/admin/oauth-state';

import { getAdminFirestore } from '@/lib/firebase/admin';
import { shopeeRedirectUri, shopeeStateSecret, webBase } from '@/lib/shopee/env';
import { shopeeOauthState } from '@/lib/shopee/conta/oauthState';
import { ShopeeContaNotConfiguredError, loadShopeeContext } from '@/lib/shopee/core/shopee';
import { ShopeeCredencialInvalidaError } from '@/lib/shopee/core/credentialStore';
import { isShopeeError } from '@/lib/shopee/core/respond';
import { describeValidationFailure } from '@/lib/shopee/core/validationIssues';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Shopee's own `error` strings → the redirect slug.
 *
 * ⚠️ `invalid_main_acount_id` is spelled that way BY SHOPEE (one `c` short of
 * "account"). The typo is the wire value; "correcting" it here would silently
 * stop matching.
 *
 * ⚠️ A `Map`, not an object literal. `err.code` is an arbitrary provider string,
 * and `REASON_BY_CODE['constructor']` on an object would answer a truthy
 * FUNCTION that sails past `?? …`.
 */
const REASON_BY_CODE = new Map<string, string>([
  ['invalid_code', 'codigo_invalido'],
  ['invalid_shop_id', 'loja_invalida'],
  ['invalid_main_acount_id', 'loja_invalida'],
]);

/**
 * Map a failure to a DISTINCT redirect `reason`. Slugs only — never Shopee's
 * own text in a query string.
 *
 * ⚠️ MOST-DERIVED FIRST, and on this channel that ordering is load-bearing:
 * `ShopeeSchemaError` and `ShopeeNetworkError` extend `ShopeeError` **directly**
 * (not `ShopeeApiError`), so testing `ShopeeApiError` first cannot swallow them
 * — but testing the base `ShopeeError` anywhere but last would collapse every
 * diagnosis into one slug. That is Melhor Envio's trap 2.
 *
 * ⚠️ `server_config`, not `config` — `config` already means "the state secret is
 * unset" on the LIST page, and reusing it would merge two unrelated causes.
 *
 * ℹ️ `ShopeeHttpError` (a non-2xx whose body is not an envelope — under the
 * coming IP allow-list, an EDGE rejection) deliberately reaches the `exchange`
 * fallback: no slug is defined for it yet, and inventing one that `apps/web`
 * does not render would be a contract nobody honours. It stays distinguishable
 * in the log line, which carries `erro` and `status`.
 */
function exchangeFailureReason(err: unknown): string {
  if (err instanceof ShopeeApiError) {
    return REASON_BY_CODE.get(err.code) ?? 'shopee_rejeitou';
  }
  if (err instanceof ShopeeConfigError) return 'server_config';
  if (err instanceof ShopeeContaNotConfiguredError) return 'conta';
  if (err instanceof ShopeeCredencialInvalidaError) return 'resposta_invalida';
  if (err instanceof ShopeeSchemaError) return 'resposta_invalida';
  if (err instanceof ShopeeNetworkError) return 'rede';
  return 'exchange';
}

/**
 * The diagnostics that survive into the log line.
 *
 * ⚠️ Never `err.body` and never a token. On a schema failure the body IS the
 * credential, so only the field PATHS travel.
 */
function errorDetail(err: unknown): {
  status?: number;
  code?: string;
  requestId?: string | null;
  camposInvalidos?: readonly string[];
} {
  if (err instanceof ShopeeApiError) {
    return { status: err.httpStatus, code: err.code, requestId: err.requestId };
  }
  const campos = describeValidationFailure(err);
  if (campos !== null) return { camposInvalidos: campos };
  if (err instanceof ShopeeCredencialInvalidaError) return { camposInvalidos: err.campos };
  return {};
}

/** Redirect to a specific Shopee account page with status params. */
function backToAccount(integracaoId: string, params: Record<string, string>): NextResponse {
  const url = new URL(`${webBase()}/canais/shopee/${integracaoId}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url.toString());
}

/** Redirect to the account list (used before a trustworthy id is known). */
function backToList(params: Record<string, string>): NextResponse {
  const url = new URL(`${webBase()}/canais/shopee`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url.toString());
}

/**
 * A callback id, strictly.
 *
 * ⚠️ `/^\d+$/` plus `Number.isSafeInteger`, never `parseInt`:
 * `parseInt('123abc')` answers `123` and `Number('')` answers `0`. A truncated
 * id signs cleanly and either fails with `error_sign` or — the reason this is a
 * strict guard — authorises the WRONG shop.
 */
function parseId(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Shopee sends `shop_id` OR `main_account_id`, never both. */
function subjectFrom(params: URLSearchParams): ShopeeAuthSubject | null {
  const shopId = parseId(params.get('shop_id'));
  if (shopId !== null) return { kind: 'shop', shopId };
  const mainAccountId = parseId(params.get('main_account_id'));
  if (mainAccountId !== null) return { kind: 'main_account', mainAccountId };
  return null;
}

export async function GET(req: Request): Promise<NextResponse> {
  const params = new URL(req.url).searchParams;

  const secret = shopeeStateSecret();
  if (secret === null) return backToList({ shopee: 'error', reason: 'config' });

  // Fail closed: `guide 20`'s callback table omits `state`, so its absence is
  // refused rather than treated as an unauthenticated but acceptable consent.
  const state = params.get('state');
  if (!state) return backToList({ shopee: 'error', reason: 'bad_state' });

  const db = getAdminFirestore();

  let integracaoId: string;
  let nonce: string;
  try {
    const verified = verifyState(state, secret);
    integracaoId = verified.id;
    nonce = verified.nonce;
  } catch (err) {
    if (err instanceof OauthStateError) return backToList({ shopee: 'error', reason: 'bad_state' });
    throw err;
  }

  // AFTER verifyState (so the account page is a trustworthy destination) and
  // BEFORE consume (so a cancelled consent does not burn the attempt).
  const code = params.get('code');
  if (!code) return backToAccount(integracaoId, { shopee: 'error', reason: 'missing_params' });

  const subject = subjectFrom(params);
  if (subject === null) {
    return backToAccount(integracaoId, { shopee: 'error', reason: 'loja_invalida' });
  }

  try {
    // Single-use: a replay of this same state finds the attempt consumed and
    // lands here as `bad_state`, before anything touches the credential.
    await shopeeOauthState.consume(db, integracaoId, nonce);
  } catch (err) {
    if (err instanceof OauthStateError) return backToList({ shopee: 'error', reason: 'bad_state' });
    throw err;
  }

  try {
    const ctx = await loadShopeeContext(db, integracaoId);
    await ctx.exchangeAndPersist(code, subject);
    return backToAccount(integracaoId, { shopee: 'connected' });
  } catch (err) {
    if (isShopeeError(err)) {
      const reason = exchangeFailureReason(err);
      // The ONLY record of this failure — the operator otherwise sees a slug in
      // a toast and nothing else. `redirectUri` is included because it is
      // computed from env and is otherwise unobservable from outside the
      // running backend, and it is the single most likely misconfiguration.
      console.error('[shopee/oauth-callback] falha ao trocar o code por tokens', {
        integracaoId,
        reason,
        erro: err.name,
        mensagem: err.message,
        redirectUri: shopeeRedirectUri(),
        ...errorDetail(err),
      });
      return backToAccount(integracaoId, { shopee: 'error', reason });
    }
    throw err;
  }
}
