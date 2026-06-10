/**
 * `GET /api/nfe/carta-correcao/danfe` — render the Carta de Correção PDF for a
 * specific registrada CC-e.
 *
 * The document is rendered from the NF-e's persisted procNFe
 * (`pedidos/{pedidoId}/nfev4/{nfeId}.xml_nfe_proc`) + the CC-e record
 * (`…/cartacorrecao/{cceId}`), never re-generated.
 *
 * Query: `?pedidoId&nfeId&cceId`
 *
 * Returns:
 *   200  application/pdf  — attachment
 *   400  bad query
 *   401  no/invalid token
 *   403  insufficient perm (needs PERM.fiscal.read)
 *   404  pedido / NF-e / CC-e not found
 *   422  not renderable (no procNFe, or the CC-e isn't registrada)
 *   500  unexpected error
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { authError, PERM, verifyCaller } from '@/lib/nfe/auth';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { safeLog } from '@/lib/nfe/log';
import {
  cartaCorrecaoArtifactService,
  NFeDanfeError,
  NFePedidoNotFoundError,
} from '@/lib/nfe/orchestrator';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const querySchema = z.object({
  pedidoId: z.string().min(1).max(200),
  nfeId: z.string().min(1).max(200),
  // The specific cartacorrecao doc id — a NF-e may carry many CC-e.
  cceId: z.string().min(1).max(200),
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
    const artifact = await cartaCorrecaoArtifactService(
      getAdminFirestore(),
      query.pedidoId,
      query.nfeId,
      query.cceId,
    );
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
    safeLog('error', '[nfe/carta-correcao/danfe]', e);
    return authError(500, {
      error: e instanceof Error ? e.message : 'Erro interno',
      code: e instanceof Error ? e.name : undefined,
    });
  }
}
