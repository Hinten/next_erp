import { NextResponse, type NextRequest } from 'next/server';

// The callable marketplace endpoints (/api/marketplace/*) are invoked from the
// apps/web browser, which is on a different origin (dev: :3000 → :3006; prod:
// app-* → mercado-livre-*). They carry `Authorization: Bearer <idToken>`, which
// makes them non-simple cross-origin requests — so the browser fires a CORS
// preflight. Without an OPTIONS handler + ACAO header on the response, the fetch
// surfaces as a CORS error. The Mercado Livre OAuth **callback**
// (/api/oauth/mercado-livre/callback) is a top-level browser redirect from ML +
// a server→ML token exchange — no preflight — so it stays OUT of the matcher,
// along with the webhook (server→server).

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
    if (!allowed) {
      // Disallowed origin: don't echo it back; the browser will block.
      return new NextResponse(null, { status: 204 });
    }
    const res = new NextResponse(null, { status: 204 });
    applyCors(res.headers, allowed);
    res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.headers.set('Access-Control-Allow-Headers', 'authorization, content-type');
    res.headers.set('Access-Control-Max-Age', '86400');
    return res;
  }

  const res = NextResponse.next();
  if (allowed) applyCors(res.headers, allowed);
  return res;
}

export const config = {
  matcher: ['/api/marketplace/:path*'],
};
