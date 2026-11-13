import { NextResponse } from 'next/server';
import { FirebaseFunctionsError } from 'firebase-admin/functions';
import { z } from 'zod';
import { createMercadoLivreApi } from '@delfrance/integrations-mercado-livre';
import { produtoMercadoLivreLinkCollection } from '@delfrance/data/admin/collections';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { naoDocId, refMatchesIntegracao } from '@/lib/marketplace/core/linkRefs';
import { loadMercadoLivreContext } from '@/lib/marketplace/core/mercadoLivre';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/core/respond';
import {
  handleUptinMigration,
  isUptinTarget,
  startUptinMigration,
  UptinError,
  UPTIN_CHECK_DELAY_SECONDS,
} from '@/lib/marketplace/importacao/importMigration';
import {
  createMlTaskScheduler,
  MlTasksDisabledError,
} from '@/lib/marketplace/notificacoes/mlTasks';
import {
  persistNotificationFailure,
  type MlNotificationPayload,
} from '@/lib/marketplace/notificacoes/notificacao';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const docId = z.string().refine((value) => !naoDocId(value));
const inputSchema = z.object({
  integracaoId: docId,
  produtoId: docId,
  linkDocId: docId,
  acao: z.enum(['iniciar', 'reverificar']),
});

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;
  let input: unknown;
  try {
    input = await req.json();
  } catch (err) {
    if (err instanceof SyntaxError)
      return NextResponse.json({ error: 'Body JSON inválido.' }, { status: 400 });
    throw err;
  }
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Informe a conta, o produto, o anúncio e a ação de migração.' },
      { status: 400 },
    );
  }

  const { integracaoId, produtoId, linkDocId, acao } = parsed.data;
  const db = getAdminFirestore();
  const link = (
    await produtoMercadoLivreLinkCollection.docRef(db, { produtoId }, linkDocId).get()
  ).data();
  if (!link || !refMatchesIntegracao(link.contaOuterRef, integracaoId)) {
    return NextResponse.json({ error: 'Anúncio não encontrado nesta conta.' }, { status: 404 });
  }
  const target = { integracaoId, produtoId, linkDocId, itemId: link.id };
  if (link.isUserProductModel === true || !isUptinTarget(target)) {
    return NextResponse.json(
      { error: 'Selecione um anúncio legado publicado no Mercado Livre.' },
      { status: 409 },
    );
  }

  try {
    const ctx = await loadMercadoLivreContext(db, integracaoId);
    const channelCtx = await ctx.resolveChannelContext();
    const sellerUserId = typeof ctx.conta.user_id === 'number' ? ctx.conta.user_id : null;
    const api = createMercadoLivreApi({
      getAccessToken: channelCtx.getAccessToken,
      onAccessTokenRejected: channelCtx.invalidateAccessToken,
      fetch: (resource, init) => fetch(resource, { ...init, signal: AbortSignal.timeout(15_000) }),
    });
    const deps = { db, api, integracaoId, sellerUserId };
    const estado =
      acao === 'reverificar'
        ? await handleUptinMigration(deps, target.itemId, target)
        : await startUptinMigration(deps, target.itemId, target, async () => {
            const payload: MlNotificationPayload = {
              id: null,
              resource: `/items/${target.itemId}`,
              topic: 'items',
              user_id: sellerUserId,
              application_id: null,
              attempts: null,
              sent: null,
              received: Date.now(),
              actions: null,
            };
            try {
              await createMlTaskScheduler().enqueue(payload, {
                scheduleDelaySeconds: UPTIN_CHECK_DELAY_SECONDS,
              });
            } catch (err) {
              if (!(err instanceof FirebaseFunctionsError || err instanceof MlTasksDisabledError))
                throw err;
              await persistNotificationFailure(
                db,
                payload,
                'Falha ao agendar a verificação da migração UPtin.',
              );
            }
          });
    return NextResponse.json({ estado }, { status: estado === 'iniciada' ? 202 : 200 });
  } catch (err) {
    if (err instanceof UptinError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}
