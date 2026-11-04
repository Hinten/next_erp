import { NextResponse, type NextRequest } from 'next/server';

// The callable marketplace endpoints (/api/marketplace/*) are invoked from the
// apps/web browser, which is on a different origin (dev: :3000 → :3011; prod:
// app-* → amazon-*). They carry `Authorization: Bearer <idToken>`, which makes
// them non-simple cross-origin requests — so the browser fires a CORS preflight.
// Without an OPTIONS handler + ACAO header on the response, the fetch surfaces
// as a CORS error.
//
// The public OAuth callback (/api/oauth/amazon/callback) is a top-level browser
// NAVIGATION from Seller Central, never a cross-origin fetch, so it stays OUT of
// the matcher. So does the push receiver (/api/webhooks/amazon): a
// server-to-server POST from the AWS relay, authenticated by its relay key.
//
// The methods are the conta routes' verbs: GET (status) and POST (OAuth start).
// POST is CORS-safelisted, but a Bearer header preflights it anyway, so it is
// listed explicitly.
//
// Every answer here also carries `Referrer-Policy: no-referrer` (step-2 plan §3
// decision 7): `next.config.ts` sets it site-wide, and this explicit copy is
// what `proxy.test.ts` can observe on the preflight. The preflight, which no
// route answers, also carries `Cache-Control: no-store` — the routes set both
// headers themselves (`lib/amazon/core/respond.ts`).

const DEV_ORIGIN = 'http://localhost:3000';

function allowedOrigins(): Set<string> {
  const extra = (process.env.ALLOWED_ADMIN_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  // #821/T5: a page served from a developer machine has no business making
  // credentialed cross-origin calls to a production backend, so the dev origin
  // is a DEV-ONLY convenience (it keeps `pnpm dev` config-free).
  // ⚠️ In production the allow-list is EXACTLY `ALLOWED_ADMIN_ORIGINS` — a
  // backend deployed without that variable set allows no origin at all.
  if (process.env.NODE_ENV === 'production') return new Set<string>(extra);
  return new Set<string>([DEV_ORIGIN, ...extra]);
}

function pickOrigin(reqOrigin: string | null): string | null {
  if (!reqOrigin) return null;
  return allowedOrigins().has(reqOrigin) ? reqOrigin : null;
}

function applyCors(headers: Headers, allowed: string) {
  headers.set('Access-Control-Allow-Origin', allowed);
  headers.set('Vary', 'Origin');
}

export function proxy(req: NextRequest) {
  const allowed = pickOrigin(req.headers.get('origin'));

  if (req.method === 'OPTIONS') {
    const res = new NextResponse(null, { status: 204 });
    res.headers.set('Referrer-Policy', 'no-referrer');
    // The preflight is an answer like any other (`respond.ts` sets the same
    // pair). It does not touch the CORS-preflight cache, which `Max-Age` governs.
    res.headers.set('Cache-Control', 'no-store');
    // Disallowed origin: a bare 204 that does not echo it back; the browser blocks.
    if (!allowed) return res;
    applyCors(res.headers, allowed);
    res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.headers.set('Access-Control-Allow-Headers', 'authorization, content-type');
    res.headers.set('Access-Control-Max-Age', '86400');
    return res;
  }

  const res = NextResponse.next();
  res.headers.set('Referrer-Policy', 'no-referrer');
  if (allowed) applyCors(res.headers, allowed);
  return res;
}

export const config = {
  matcher: ['/api/marketplace/:path*'],
};
