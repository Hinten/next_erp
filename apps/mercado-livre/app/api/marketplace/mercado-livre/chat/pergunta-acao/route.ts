/**
 * `POST /api/marketplace/mercado-livre/chat/pergunta-acao` — the two moderation
 * actions a seller has on a Mercado Livre question (#533): delete it from the
 * listing, or block its author from asking again.
 *
 * Body: `{ integracaoId, conversaId, acao: 'excluir' | 'bloquear' }`.
 *
 * ⚠️ Gated on **`PERM.mensagem.delete`**, not `mensagem.write`. Both actions are
 * destructive and PUBLIC — a deleted question disappears from the listing for
 * everyone, and a blocked buyer cannot ask again on any of this seller's items.
 * Neither is undoable from here.
 *
 * ⚠️ Neither writes to the thread. Deleting a question is not "our message went
 * away": ML changes the question's status, and the next `questions` notification
 * reflects that through the importer, which is the one writer of that state.
 */
import { NextResponse } from 'next/server';
import { createMercadoLivreApi } from '@delfrance/integrations-mercado-livre';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  ChatOutboundRefusedError,
  acaoPerguntaMercadoLivre,
  type AcaoPergunta,
} from '@/lib/marketplace/chatOutbound';
import { loadMercadoLivreContext } from '@/lib/marketplace/mercadoLivre';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ACOES: ReadonlySet<string> = new Set<AcaoPergunta>(['excluir', 'bloquear']);

function asNumberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.mensagem.delete);
  if ('error' in auth) return auth.error;

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json(
        { error: 'Body JSON inválido.', code: 'ML_BODY_INVALIDO' },
        { status: 400 },
      );
    }
    throw err;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return NextResponse.json(
      { error: 'Body JSON inválido.', code: 'ML_BODY_INVALIDO' },
      { status: 400 },
    );
  }
  const body = parsed as Record<string, unknown>;
  const integracaoId = typeof body.integracaoId === 'string' ? body.integracaoId.trim() : '';
  const conversaId = typeof body.conversaId === 'string' ? body.conversaId.trim() : '';
  const acao = typeof body.acao === 'string' ? body.acao : '';
  if (integracaoId === '' || conversaId === '' || !ACOES.has(acao)) {
    return NextResponse.json(
      {
        error: 'integracaoId, conversaId e uma ação válida são obrigatórios.',
        code: 'ML_BODY_INVALIDO',
      },
      { status: 400 },
    );
  }

  const db = getAdminFirestore();
  try {
    const ctx = await loadMercadoLivreContext(db, integracaoId);
    const channelCtx = await ctx.resolveChannelContext();
    const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });

    const result = await acaoPerguntaMercadoLivre(
      { db, api, conta: { userId: asNumberOrNull(ctx.conta.user_id) }, nowMs: Date.now() },
      { conversaId, acao: acao as AcaoPergunta },
    );
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ChatOutboundRefusedError) {
      return NextResponse.json({ error: err.motivo, code: err.codigo }, { status: 409 });
    }
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}
