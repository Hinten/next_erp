import { NextResponse } from 'next/server';
import { z } from 'zod';
import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMercadoLivreContext } from '@/lib/marketplace/core/mercadoLivre';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/core/respond';
import { createChartApi } from '@/lib/marketplace/size-charts/sizeChartApi';
import {
  chartRecoveryRequestSchema,
  recoverSizeChart,
} from '@/lib/marketplace/size-charts/sizeChartRecovery';
import { SizeChartOperationError } from '@/lib/marketplace/size-charts/sizeChartOperation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const requestSchema = chartRecoveryRequestSchema.extend({
  integracaoId: z.string().min(1),
  tabMediId: z.string().min(1),
});

export async function POST(req: Request): Promise<NextResponse> {
  const caller = await verifyCaller(req, PERM.integracao.write);
  if ('error' in caller) return caller.error;
  try {
    const input: unknown = await req.json();
    const body = requestSchema.parse(input);
    const db = getAdminFirestore();
    const context = await loadMercadoLivreContext(db, body.integracaoId);
    const account = await context.resolveChannelContext();
    return NextResponse.json(
      await recoverSizeChart(
        { db, api: createChartApi(account.accessToken), integracaoId: body.integracaoId },
        body.tabMediId,
        body,
      ),
    );
  } catch (err) {
    if (err instanceof SyntaxError || err instanceof z.ZodError)
      return NextResponse.json({ error: 'Solicitação de recuperação inválida.' }, { status: 400 });
    if (err instanceof SizeChartOperationError)
      return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}
