import { NextResponse, type NextRequest } from 'next/server';

// The callable WhatsApp endpoints (/api/whatsapp/*) are invoked from the
// apps/web browser, which is on a different origin (dev: :3000 → :3008; prod:
// app-* → whatsapp-*). They carry `Authorization: Bearer <idToken>`, which
// makes them non-simple cross-origin requests — so the browser fires a CORS
// preflight. Without an OPTIONS handler + ACAO header on the response, the fetch
// surfaces as a CORS error. The inbound WhatsApp webhook (#527) is a
// server→server call from Meta with no preflight, so it stays OUT of the
// matcher when it lands.

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
    res.headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.headers.set('Access-Control-Allow-Headers', 'authorization, content-type');
    res.headers.set('Access-Control-Max-Age', '86400');
    return res;
  }

  const res = NextResponse.next();
  if (allowed) applyCors(res.headers, allowed);
  return res;
}

export const config = {
  matcher: ['/api/whatsapp/:path*'],
};
