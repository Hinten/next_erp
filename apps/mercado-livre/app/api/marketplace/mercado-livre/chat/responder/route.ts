/**
 * `POST /api/marketplace/mercado-livre/chat/responder` — send a reply on a
 * Mercado Livre conversa from the unified inbox (#533).
 *
 * Body: `{ integracaoId, conversaId, texto }`. Gated on `PERM.mensagem.write` —
 * writing into a thread is a mensagem-level act, not an integração-level one.
 *
 * ⚠️ **SYNCHRONOUS by design.** WhatsApp replies are written to Firestore and
 * transmitted by a trigger, which buys free retries; that pays when failures are
 * transient. An ML reply is single-shot and its refusals are terminal and
 * operator-actionable — already answered, thread blocked, mediation open, grant
 * dead — so the operator must see the real reason with their text still on
 * screen. See `lib/marketplace/chat/chatOutbound.ts`.
 *
 * ⚠️ The stored `conversa.respostaBloqueada` is a UI hint and is NEVER trusted
 * here: the handler re-reads the question or the pack from ML and that read is
 * the authority.
 *
 * Responses:
 *  - 200 `{ conversaId, mensagemId, respostaBloqueada }`
 *  - 400 `ML_BODY_INVALIDO` — malformed body
 *  - 409 with the refusal's own code (`ML_NAO_RESPONDIVEL`, `ML_TEXTO_LONGO`, …)
 *    and an operator-facing `error` — the composer renders it verbatim
 *  - ML/context failures map through `mercadoLivreErrorResponse` (409 on a dead
 *    grant, 502 on an ML rejection, 503 on a transport failure)
 */
import { NextResponse } from 'next/server';
import { createMercadoLivreApi } from '@delfrance/integrations-mercado-livre';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  ChatOutboundRefusedError,
  responderConversaMercadoLivre,
} from '@/lib/marketplace/chat/chatOutbound';
import { loadMercadoLivreContext } from '@/lib/marketplace/core/mercadoLivre';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/core/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function asNumberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.mensagem.write);
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
  const texto = typeof body.texto === 'string' ? body.texto : '';
  if (integracaoId === '' || conversaId === '') {
    return NextResponse.json(
      { error: 'integracaoId e conversaId são obrigatórios.', code: 'ML_BODY_INVALIDO' },
      { status: 400 },
    );
  }

  const db = getAdminFirestore();
  try {
    const ctx = await loadMercadoLivreContext(db, integracaoId);
    const channelCtx = await ctx.resolveChannelContext();
    const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });

    const result = await responderConversaMercadoLivre(
      { db, api, conta: { userId: asNumberOrNull(ctx.conta.user_id) }, nowMs: Date.now() },
      { conversaId, texto },
    );
    return NextResponse.json(result);
  } catch (err) {
    // A refusal is the operator's to fix, so it answers 409 with its own reason
    // rather than a generic 500 — the composer shows the text verbatim.
    if (err instanceof ChatOutboundRefusedError) {
      return NextResponse.json({ error: err.motivo, code: err.codigo }, { status: 409 });
    }
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}
