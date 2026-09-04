/**
 * `GET /api/marketplace/shopee/conta?integracaoId=…` — connection status for a
 * Shopee account. Requires `PERM.integracao.read`.
 *
 * ## It must work with NO valid access token
 *
 * Token refresh is step 2, so today a stored access token is dead within four
 * hours of the connect. If this route needed one it would report every conta as
 * broken from lunchtime onwards. It does not: `get_shops_by_partner` is
 * **Public-signed** — no token in the base string — so the authorization state
 * is readable regardless.
 *
 * Consequently:
 *
 *  - **no credential stored** → `connected: false` at HTTP 200, with ZERO
 *    provider calls. A conta that was never connected is a state to render, not
 *    a failure;
 *  - **an EXPIRED credential** → still `connected: true`, with `expireTime` and
 *    `diasParaExpirar`. The 4-hour access token and the 7–365-day authorization
 *    are two different clocks (see `../../../../../lib/shopee/conta/status.ts`),
 *    and only the second one means "reconnect";
 *  - **`get_shop_info`** runs only while the access token is live, and it is a
 *    SIDE read: a failure there degrades to `loja: null` at 200 rather than
 *    costing the operator the whole answer.
 */
import { NextResponse } from 'next/server';
import {
  ShopeeApiError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeSchemaError,
  createShopeeClient,
  createShopeePartnerClient,
} from '@delfrance/integrations-shopee';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import type { ShopeeConfig } from '@/lib/shopee/env';
import { loadShopeeContext } from '@/lib/shopee/core/shopee';
import { isShopeeError, shopeeErrorResponse } from '@/lib/shopee/core/respond';
import { findAuthorizedShop } from '@/lib/shopee/conta/shops';
import {
  CONTA_DESCONECTADA,
  type ShopeeContaStatus,
  type ShopeeLoja,
  diasParaExpirar,
} from '@/lib/shopee/conta/status';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * A stored expiry we can actually compare against a clock.
 *
 * ⚠️ `parseRead` is SOFT — it logs and returns the RAW document on a schema
 * mismatch (migration tolerance, rule 8) — so `expirationDate` is not guaranteed
 * to be a number here. A comparison against `undefined` answers `false` for
 * reasons that have nothing to do with freshness, so an uncomparable value is
 * treated as EXPIRED: the worst outcome is one skipped side read.
 */
function expiryOf(cred: { expirationDate: unknown }): number | null {
  const raw = cred.expirationDate;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/** Same tolerance for the token itself: an unusable value is no token at all. */
function accessTokenOf(cred: { access_token: unknown }): string | null {
  const raw = cred.access_token;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
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

    const shopId = ctx.conta.shop_id;
    if (shopId == null) {
      // The consent never completed (or completed against a main account, whose
      // shop fan-out is a later step): there is no shop to ask Shopee about.
      return NextResponse.json(CONTA_DESCONECTADA);
    }

    const now = Date.now();
    const expiraEm = expiryOf(cred);
    const credencial = {
      expiraEm: expiraEm ?? 0,
      expirada: expiraEm === null || expiraEm <= now,
    };

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

    const status: ShopeeContaStatus = {
      connected: true,
      shopId: shop.shopId,
      mainAccountId: ctx.conta.main_account_id,
      authTime: shop.authTime,
      expireTime: shop.expireTime,
      diasParaExpirar: diasParaExpirar(shop.expireTime, now),
      loja: credencial.expirada ? null : await readLoja(ctx.config, shopId, cred),
      credencial,
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
 * ⚠️ The narrowing is a POSITIVE list: the request-scoped failures that say
 * nothing about the account behind them. Anything else rethrows and reaches the
 * route's own catch (rule 6).
 */
async function readLoja(
  config: ShopeeConfig,
  shopId: number,
  cred: { access_token: unknown },
): Promise<ShopeeLoja | null> {
  const accessToken = accessTokenOf(cred);
  if (accessToken === null) return null;

  const client = createShopeeClient({
    partnerId: config.partnerId,
    partnerKey: config.partnerKey,
    hosts: config.hosts,
    shopId,
    getAccessToken: async () => accessToken,
  });

  try {
    const info = await client.getShopInfo();
    return { shopName: info.shop_name, region: info.region, status: info.status };
  } catch (err) {
    if (
      err instanceof ShopeeApiError ||
      err instanceof ShopeeHttpError ||
      err instanceof ShopeeNetworkError ||
      err instanceof ShopeeSchemaError
    ) {
      console.warn('[shopee/conta] get_shop_info falhou; seguindo sem os dados da loja', {
        shopId,
        erro: err.name,
        mensagem: err.message,
      });
      return null;
    }
    throw err;
  }
}
