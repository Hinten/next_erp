/**
 * `GET /api/oauth/amazon/callback?state=…&selling_partner_id=…&spapi_oauth_code=…`
 * — the redirect target registered on the app (`AMAZON_OAUTH_REDIRECT_URI`).
 *
 * PUBLIC: no Bearer token (it is a browser redirect from Seller Central) and
 * outside the CORS proxy's matcher. The signed `state` plus its single-use
 * record are the only trust anchors. The fifteen ordered steps live in
 * `lib/amazon/conta/conectar.ts`; this route only hands the query and the
 * dependencies over and turns the outcome into a redirect to `apps/web`:
 *
 *  - `${WEB_APP_URL}/canais/amazon[/<id>]?amazon=connected`, or
 *  - `…?amazon=error&reason=<motivo>` — a closed set of slugs;
 *  - a plain-text 500 only when `WEB_APP_URL` itself is unset.
 *
 * ⚠️ Never logged, answered or put in a URL: the code, any token, the client
 * secret, the state, either seller id, the ref, an LWA body or the raw query.
 * Every answer carries `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
 */
import type { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';

import { getAdminFirestore } from '@/lib/firebase/admin';
import { tratarCallbackAmazon } from '@/lib/amazon/conta/conectar';
import { amazonOauthState } from '@/lib/amazon/conta/oauthState';
import { redirecionarParaWeb, respostaSemWebAppUrl } from '@/lib/amazon/core/respond';
import { LOGGER_STDOUT_AMAZON } from '@/lib/amazon/core/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request): Promise<NextResponse> {
  const r = await tratarCallbackAmazon(new URL(req.url).searchParams, {
    db: getAdminFirestore(),
    ambiente: process.env,
    agora: () => Date.now(),
    estado: amazonOauthState,
    logger: LOGGER_STDOUT_AMAZON,
    increment: (by) => FieldValue.increment(by),
  });
  if (r.tipo === 'sem-web') return respostaSemWebAppUrl();
  return redirecionarParaWeb(r.webBase, r.caminho, r.retorno);
}
