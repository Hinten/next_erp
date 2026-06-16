import { NextResponse } from 'next/server';

import { NFeCertError } from '@delfrance/integrations-nfe';

import { getNFeRuntime } from '@/lib/nfe/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Liveness + ambiente/cert diagnostics. The service boots WITHOUT an env cert
 * (per-filial certs), so `cert` is `null` when no `NFE_CERT_*` is configured (or
 * it's expired/invalid — an env-cert problem no longer downs the service).
 * Returns 503 only on a bad `NFE_AMBIENTE` or a missing TLS chain.
 */
export function GET() {
  try {
    const base = getNFeRuntime();
    // The env cert is optional + lazy; a bad one shouldn't fail health.
    let env = null;
    try {
      env = base.envRuntime();
    } catch (e) {
      if (!(e instanceof NFeCertError)) throw e;
    }
    return NextResponse.json({
      status: 'ok',
      service: 'nfe',
      ambiente: base.ambiente,
      uf: base.uf,
      cert: env
        ? {
            subjectCommonName: env.diagnostics.subjectCommonName,
            notAfter: env.diagnostics.notAfter,
          }
        : null,
      chainSource: env?.diagnostics.chainSource ?? null,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      {
        status: 'error',
        service: 'nfe',
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}
