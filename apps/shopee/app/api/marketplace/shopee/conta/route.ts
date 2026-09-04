/**
 * `GET /api/marketplace/shopee/conta?integracaoId=…` — connection status for a
 * Shopee account. Requires `PERM.integracao.read`.
 *
 * ## It must work with NO valid access token
 *
 * A stored access token dies within four hours of the connect. Step 2's token
 * store renews it on the next call that needs one, but a renewal can be in
 * flight elsewhere, or refused outright — so this route still has to answer
 * fully without a live token, and it can: `get_shops_by_partner` is
 * **Public-signed** — no token in the base string — so the authorization state
 * is readable regardless.
 *
 * Consequently:
 *
 *  - **no credential stored** → `connected: false` at HTTP 200, with ZERO
 *    provider calls. A conta that was never connected is a state to render, not
 *    a failure;
 *  - **an EXPIRED stored credential** → still `connected: true`, with
 *    `expireTime` and `diasParaExpirar` — and normally with `loja` too, because
 *    the shop read renews the token on its way through. The 4-hour access token
 *    and the 7–365-day authorization are two different clocks (see
 *    `../../../../../lib/shopee/conta/status.ts`), and only the second one means
 *    "reconnect";
 *  - **`get_shop_info`** is a SIDE read: a failure there — including a renewal
 *    held by another instance and a dead grant — degrades to `loja: null` at 200
 *    rather than costing the operator the whole answer.
 */
import { NextResponse } from 'next/server';
import {
  ShopeeApiError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
  createShopeePartnerClient,
} from '@delfrance/integrations-shopee';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { type ShopeeContext, loadShopeeContext } from '@/lib/shopee/core/shopee';
import { type CredencialArmazenada, expiryOf } from '@/lib/shopee/core/credentialStore';
import { isShopeeError, shopeeErrorResponse } from '@/lib/shopee/core/respond';
import {
  ShopeeRefreshEmAndamentoError,
  ShopeeSemCredencialError,
} from '@/lib/shopee/core/tokenStore';
import { findAuthorizedShop } from '@/lib/shopee/conta/shops';
import {
  CONTA_DESCONECTADA,
  type ShopeeContaStatus,
  type ShopeeLoja,
  diasParaExpirar,
} from '@/lib/shopee/conta/status';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The `credencial` block of the wire shape. */
type CredencialWire = NonNullable<ShopeeContaStatus['credencial']>;

/**
 * The second clock, as the panel renders it.
 *
 * `expiryOf` lives in `core/credentialStore.ts` with the document shape it
 * tolerates; only the terminal-failure stamp is read here, because this route is
 * its one reader.
 *
 * ⚠️ `parseRead` is SOFT — it logs and returns the RAW document on a schema
 * mismatch (migration tolerance, rule 8) — and `ultimaFalhaRefresh` is an
 * unmodelled `.passthrough()` key on top of that, so nothing about its shape may
 * be assumed. Anything that is not literally `terminal === true` reads as "no
 * terminal failure": the wrong-way default here would tell an operator to
 * reconnect a perfectly healthy conta.
 */
function credencialDe(cred: CredencialArmazenada, nowMs: number): CredencialWire {
  const expiraEm = expiryOf(cred);
  const falha: unknown = cred.ultimaFalhaRefresh;
  const renovacaoFalhou =
    typeof falha === 'object' &&
    falha !== null &&
    (falha as Record<string, unknown>).terminal === true;
  return {
    expiraEm: expiraEm ?? 0,
    expirada: expiraEm === null || expiraEm <= nowMs,
    renovacaoFalhou,
  };
}

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.read);
  if ('error' in auth) return auth.error;

  const integracaoId = new URL(req.url).searchParams.get('integracaoId');
  if (!integracaoId) {
    return NextResponse.json({ error: 'integracaoId é obrigatório.' }, { status: 400 });
  }

  const db = getAdminFirestore();
  try {
    const ctx = await loadShopeeContext(db, integracaoId);

    // Fresh read, never cached: it IS the OAuth credential.
    const cred = await ctx.readCredential();
    if (cred === null) return NextResponse.json(CONTA_DESCONECTADA);

    // The credential clock is computed BEFORE the shop guard: a stored
    // credential is a fact about the conta whether or not a shop is known, and
    // `status.ts` documents `credencial: null` as "nothing stored at all".
    const now = Date.now();
    const credencial = credencialDe(cred, now);

    const shopId = ctx.conta.shop_id;
    if (shopId == null) {
      // A credential exists but the consent was main-account-scoped (the
      // callback denormalises only the id class it carried), so there is no
      // shop to ask Shopee about until the shop fan-out lands in a later step.
      // Echo the second clock, as the revoked branch below does, so the two
      // clocks stay distinguishable even in the disconnected state.
      return NextResponse.json({
        ...CONTA_DESCONECTADA,
        mainAccountId: ctx.conta.main_account_id,
        credencial,
      });
    }

    const partnerClient = createShopeePartnerClient({
      partnerId: ctx.config.partnerId,
      partnerKey: ctx.config.partnerKey,
      hosts: ctx.config.hosts,
    });
    const shop = await findAuthorizedShop(partnerClient, shopId);
    if (shop === null) {
      // The authorization was revoked or lapsed. `shopId` is echoed so the
      // operator can see WHICH shop stopped answering, and `credencial` so the
      // two clocks stay distinguishable even in the disconnected state.
      return NextResponse.json({ ...CONTA_DESCONECTADA, shopId, credencial });
    }

    // ⚠️ ORDER IS LOAD-BEARING. `readLoja` goes through the token store, so it
    // can RENEW the pair on its way through; reading the credential only
    // afterwards is what keeps this answer self-consistent. Derived from the
    // first read, `expirada: true` would sit next to a populated `loja` — the
    // panel would tell the operator the token is dead while showing data that
    // could only have come from a live one.
    const loja = await readLoja(ctx);
    const depois = await ctx.readCredential();

    const status: ShopeeContaStatus = {
      connected: true,
      shopId: shop.shopId,
      mainAccountId: ctx.conta.main_account_id,
      authTime: shop.authTime,
      expireTime: shop.expireTime,
      diasParaExpirar: diasParaExpirar(shop.expireTime, now),
      loja,
      // A document that vanished between the two reads is an operator
      // disconnecting mid-request. The first read is what this answer was in
      // fact computed from, so it is reported rather than `null` — which
      // `status.ts` defines as "nothing was ever stored", a different claim.
      credencial: depois === null ? credencial : credencialDe(depois, Date.now()),
    };
    return NextResponse.json(status);
  } catch (err) {
    if (isShopeeError(err)) return shopeeErrorResponse(err);
    throw err;
  }
}

/**
 * The shop's name / region / lifecycle state — a SIDE read that degrades.
 *
 * It is ALWAYS attempted, even when the stored token was already stale: the
 * client takes its token from the store, so a stale pair is renewed on the way
 * in and the read succeeds. Gating on the stored expiry would skip the read that
 * repairs it.
 *
 * ⚠️ The narrowing is a POSITIVE list: the request-scoped failures that say
 * nothing about the account behind them. Anything else rethrows and reaches the
 * route's own catch (rule 6).
 *
 * ⚠️ Three of the six are degraded ON PURPOSE, against the reflex of surfacing
 * them:
 *
 *  - `ShopeeRefreshEmAndamentoError` — another instance holds the renewal lease.
 *    Nothing is wrong with this conta; the next request finds the fresh pair.
 *  - `ShopeeSemCredencialError` — the document vanished between the read above
 *    and this call.
 *  - `ShopeeReauthRequiredError` — the grant is dead, and the operator DOES have
 *    to act. Answering 409 here is nevertheless the wrong move: it would throw
 *    away `expireTime` and `diasParaExpirar`, which this route already read
 *    WITHOUT a token and which are the authoritative statement about the
 *    authorization. That is the legacy defect in mirror image — the Flutter app
 *    reported the conta's health from the 4-hour clock and never read the
 *    365-day one. The dead grant reaches the panel through
 *    `credencial.renovacaoFalhou` instead, next to both clocks.
 *
 * ⚠️ `ShopeeReauthRequiredError` is named EXPLICITLY even though it extends
 * `ShopeeApiError` and the line below it already matches. The arms are a single
 * `||`, so today the extra line changes no verdict — it is there so that
 * narrowing the `ShopeeApiError` arm one day (surfacing a generic Shopee failure
 * rather than degrading it, a defensible change) cannot silently take the dead
 * grant back to a 409 with it. The order is most-derived-first to match
 * `core/respond.ts`, where it IS load-bearing.
 */
async function readLoja(ctx: ShopeeContext): Promise<ShopeeLoja | null> {
  try {
    const info = await ctx.createShopClient().getShopInfo();
    return { shopName: info.shop_name, region: info.region, status: info.status };
  } catch (err) {
    if (
      err instanceof ShopeeReauthRequiredError ||
      err instanceof ShopeeApiError ||
      err instanceof ShopeeHttpError ||
      err instanceof ShopeeNetworkError ||
      err instanceof ShopeeSchemaError ||
      err instanceof ShopeeRefreshEmAndamentoError ||
      err instanceof ShopeeSemCredencialError
    ) {
      console.warn('[shopee/conta] get_shop_info falhou; seguindo sem os dados da loja', {
        integracaoId: ctx.integracaoId,
        shopId: ctx.conta.shop_id,
        erro: err.name,
        mensagem: err.message,
      });
      return null;
    }
    throw err;
  }
}
