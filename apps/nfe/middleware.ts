import { NextResponse, type NextRequest } from 'next/server';

// /api/nfe/* endpoints are called from the apps/web browser (a different
// origin in both dev and prod), so the CORS preflight rules from
// apps/integrations apply here too. processar-pendentes is also reachable
// from Cloud Scheduler (server-to-server, no preflight) — the matcher
// covers it harmlessly because OPTIONS isn't issued there.

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

export function middleware(req: NextRequest) {
  const allowed = pickOrigin(req.headers.get('origin'));

  if (req.method === 'OPTIONS') {
    if (!allowed) {
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
  matcher: '/api/nfe/:path*',
};
