/**
 * `GET /api/nfe/danfe` — render the DANFE for an authorized NF-e.
 *
 * The document is rendered from the NF-e's persisted procNFe
 * (`pedidos/{pedidoId}/nfev4/{nfeId}.xml_nfe_proc`), never re-generated. Serves
 * the simplificado PDF, the A4 retrato / paisagem PDFs, and the zpl2 Zebra
 * label.
 *
 * Query: `?pedidoId&nfeId&format=simplificado|retrato|paisagem|zpl2&dpi=203`
 *
 * Returns:
 *   200  application/pdf            — `format=simplificado` (attachment)
 *        text/plain; charset=utf-8  — `format=zpl2`
 *   400  bad query
 *   401  no/invalid token
 *   403  insufficient perm (needs PERM.fiscal.read)
 *   404  pedido / NF-e not found
 *   422  NF-e not renderable (estado not aprovada/cancelada, or no procNFe)
 *   500  unexpected error
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { authError, PERM, verifyCaller } from '@/lib/nfe/auth';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { safeLog } from '@/lib/nfe/log';
import { NFeDanfeFormatError } from '@delfrance/integrations-nfe/danfe';

import {
  danfeArtifactService,
  NFeDanfeError,
  NFePedidoNotFoundError,
} from '@/lib/nfe/orchestrator';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const querySchema = z.object({
  pedidoId: z.string().min(1).max(200),
  nfeId: z.string().min(1).max(200),
  // simplificado + retrato (A4 portrait) + paisagem (A4 landscape) + zpl2.
  format: z.enum(['simplificado', 'retrato', 'paisagem', 'zpl2']).default('simplificado'),
  // ZPL printhead density; ignored by the PDF formats.
  dpi: z.coerce.number().int().min(150).max(600).optional(),
});

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.fiscal.read);
  if ('error' in auth) return auth.error;

  let query: z.infer<typeof querySchema>;
  try {
    const url = new URL(req.url);
    query = querySchema.parse(Object.fromEntries(url.searchParams));
  } catch (e) {
    if (e instanceof z.ZodError) {
      return authError(400, { error: 'Bad query', code: e.issues[0]?.message });
    }
    throw e;
  }

  try {
    const artifact = await danfeArtifactService(getAdminFirestore(), query.pedidoId, query.nfeId, {
      format: query.format,
      dpi: query.dpi,
    });
    // Stream the body as-is — no copy. A Node `Buffer` (PDF) is Uint8Array-backed
    // and a `string` (ZPL) is a valid body; undici accepts both. The cast is only
    // because the DOM lib's `BodyInit` doesn't model Node's `Buffer` type.
    return new NextResponse(artifact.body as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': artifact.contentType,
        'Content-Disposition': `attachment; filename="${artifact.filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    if (e instanceof NFePedidoNotFoundError) {
      return authError(404, { error: e.message });
    }
    if (e instanceof NFeDanfeError) {
      return authError(422, { error: e.message });
    }
    // Corrupted persisted XML (malformed date lexical) — deterministic
    // "not renderable", same 422 semantics as NFeDanfeError, not a 500.
    if (e instanceof NFeDanfeFormatError) {
      return authError(422, { error: e.message });
    }
    safeLog('error', '[nfe/danfe]', e);
    return authError(500, {
      error: e instanceof Error ? e.message : 'Erro interno',
      code: e instanceof Error ? e.name : undefined,
    });
  }
}
