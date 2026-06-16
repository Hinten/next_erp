import { NextResponse, type NextRequest } from 'next/server';

// Admin (/api/admin/*) and freight (/api/freight/*) endpoints are called from
// the apps/web browser, which is on a different origin (dev: :3000 → :3001;
// prod: app-* → api-*). The route handlers carry `Authorization: Bearer
// <idToken>`, which makes them non-simple cross-origin requests — so the
// browser fires a CORS preflight. Without an OPTIONS handler + ACAO header on
// the response, the fetch surfaces as a CORS error ("falta cabeçalho
// 'Access-Control-Allow-Origin'"). The freight routes use both GET
// (oauth/start, conta) and POST (calculate), so GET is in the allowed methods.
// The Melhor Envio OAuth **callback** (/api/oauth/melhor-envio/callback) is a
// top-level browser redirect from ME + a server→ME token exchange — no
// preflight — so it stays OUT of the matcher, along with webhooks.

const DEV_ORIGIN = 'http://localhost:3000';

function allowedOrigins(): Set<string> {
  const extra = (process.env.ALLOWED_ADMIN_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
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
  matcher: ['/api/admin/:path*', '/api/freight/:path*'],
};
