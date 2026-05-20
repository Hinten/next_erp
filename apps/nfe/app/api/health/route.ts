import { NextResponse } from 'next/server';

import { getNFeRuntime } from '@/lib/nfe/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Liveness + cert/ambiente diagnostics. Returns 503 if the runtime can't
 * boot (missing cert, expired cert, missing chain) — App Hosting can
 * surface that to deploy gates.
 */
export function GET() {
  try {
    const rt = getNFeRuntime();
    return NextResponse.json({
      status: 'ok',
      service: 'nfe',
      ambiente: rt.ambiente,
      uf: rt.uf,
      cert: {
        subjectCommonName: rt.diagnostics.subjectCommonName,
        notAfter: rt.diagnostics.notAfter,
      },
      chainSource: rt.diagnostics.chainSource,
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
