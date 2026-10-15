import { NextResponse, type NextRequest } from 'next/server';

// /api/nfe/* endpoints are called from the apps/web browser (a different
// origin in both dev and prod), so the CORS preflight rules from
// apps/integrations apply here too. processar-pendentes is also reachable
// from Cloud Scheduler (server-to-server, no preflight) — the matcher
// covers it harmlessly because OPTIONS isn't issued there.
//
// ⚠️ Allow-Methods must list every NON-safelisted verb a route under the
// matcher exports. `DELETE /api/nfe/certificado` was missing, so certificate
// removal never left the browser: the preflight refused it, the fetch failed as
// a TypeError, and the operator saw "Falha ao remover o certificado" from day one
// (#1680). Pinned repo-wide by
// packages/config-eslint/rules/cors-proxy-covers-routes.test.js.

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
  if (allowed) {
    applyCors(res.headers, allowed);
    // The DANFE / CC-e routes name their file via Content-Disposition, and a
    // cross-origin `fetch` cannot read that header unless it is exposed — the
    // browser silently answered `null`, so every download fell back to a
    // generic name (#1680).
    res.headers.set('Access-Control-Expose-Headers', 'Content-Disposition');
  }
  return res;
}

export const config = {
  matcher: '/api/nfe/:path*',
};
