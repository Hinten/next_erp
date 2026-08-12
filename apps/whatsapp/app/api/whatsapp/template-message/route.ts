/**
 * `POST /api/whatsapp/template-message` — send the standard "reabertura de
 * conversa" template to a WhatsApp conversa and record it as an outbound
 * `mensagem`. Body: `{ conversaId }`.
 *
 * Port of legacy `addMensagemPadraoWhatsapp`
 * (`.old/lib/chat/providers/conversaProvider.dart:1015-1042`): a template is the
 * only message shape Meta allows OUTSIDE the 24h customer-service window, so the
 * inbox's "Enviar mensagem padrão" action goes through this route rather than
 * writing a plain outbound text (which the 24h rule would reject).
 *
 * ── Gate ───────────────────────────────────────────────────────────────────────
 * `PERM.chat.write` (bit 49). The route writes the `mensagem` doc with the Admin
 * SDK, so `PERM.mensagem.write` (bit 52) would ALSO be defensible; we gate on
 * `chat.write` because the action is a conversa-level operation surfaced from the
 * conversa header (parity with the composer's participant/reply gating), and the
 * mensagem write is a server-side side effect the operator never performs directly.
 *
 * ── Send-then-write (PRE-ANCHORED) ─────────────────────────────────────────────
 * The template is sent FIRST, then the mensagem is written at
 * `mensagemDocId(contaId, wamid)` carrying `mid = wamid` + `estadoEnvio =
 * enviando`. Writing FIRST (as a plain `salva`/`mid: null` text) would race the
 * #529 `sendOutbound` trigger into a SECOND, duplicate send — the trigger's
 * discriminator sends any `salva` + `tipo` not in `{e,!}` + `mid == null` +
 * whatsapp-origem doc. Anchoring the doc to the wamid up front (mid set,
 * `enviando`) excludes it from that discriminator, and lets the #527 status
 * pipeline (`processStatus`, which reads `mensagemDocId(contaId, status.id)`)
 * locate the delivery callback. This is the SAME re-anchored shape
 * `dispatchOutbound` produces, just written directly.
 */
import { NextResponse } from 'next/server';
import type { DocumentData } from 'firebase-admin/firestore';
import { ORIGEM_CONVERSA, ESTADO_ENVIO, idFromRef } from '@delfrance/schemas';
import { conversaCollection, mensagemCollection } from '@delfrance/data/admin/collections';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { fromNumberFromSenderId, mensagemDocId } from '@/lib/whatsapp/ids';
import { loadWhatsappContext } from '@/lib/whatsapp/whatsapp';
import { isWhatsappError, whatsappErrorResponse } from '@/lib/whatsapp/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The approved re-open template + its user-facing text (legacy parity). */
const TEMPLATE_NAME = 'reabertura_conversa';
const TEMPLATE_TEXT = 'Olá, podemos dar continuidade no seu atendimento?';

/** gRPC `ALREADY_EXISTS` — a `create()` that lost the race to a redelivery. */
const GRPC_ALREADY_EXISTS = 6;

interface TemplateBody {
  conversaId?: unknown;
}

async function readJsonBody(req: Request): Promise<TemplateBody> {
  try {
    return (await req.json()) as TemplateBody;
  } catch (err) {
    if (err instanceof SyntaxError) return {};
    throw err;
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.chat.write);
  if ('error' in auth) return auth.error;

  const body = await readJsonBody(req);
  const conversaId = typeof body.conversaId === 'string' ? body.conversaId : '';
  if (!conversaId) {
    return NextResponse.json({ error: 'conversaId é obrigatório.' }, { status: 400 });
  }

  const db = getAdminFirestore();

  // 1. Load the conversa (admin handle). Missing → 404.
  const convSnap = await conversaCollection.docRef(db, {}, conversaId).get();
  if (!convSnap.exists) {
    return NextResponse.json({ error: 'Conversa não encontrada.' }, { status: 404 });
  }
  const conversa = conversaCollection.parseRead(
    convSnap.data(),
    conversaCollection.docPath({}, conversaId),
  );

  // 2. Template messages only apply to WhatsApp conversas.
  if (conversa.origem !== ORIGEM_CONVERSA.whatsapp) {
    return NextResponse.json(
      {
        error: 'Mensagem padrão disponível apenas para conversas do WhatsApp.',
        code: 'WA_NOT_WHATSAPP',
      },
      { status: 400 },
    );
  }

  // 3. Recipient + owning account.
  if (!conversa.sender_id) {
    return NextResponse.json(
      { error: 'Conversa sem sender_id — destino indisponível.', code: 'WA_NO_SENDER' },
      { status: 400 },
    );
  }
  const to = fromNumberFromSenderId(conversa.sender_id);
  if (!to) {
    return NextResponse.json(
      { error: 'sender_id sem número de destino.', code: 'WA_NO_SENDER' },
      { status: 400 },
    );
  }
  if (!conversa.integracaoOuterRef) {
    return NextResponse.json(
      { error: 'Conversa sem integração vinculada.', code: 'WA_NO_INTEGRACAO' },
      { status: 400 },
    );
  }
  const contaId = idFromRef(conversa.integracaoOuterRef);
  if (!contaId) {
    return NextResponse.json(
      { error: `integração inválida: ${conversa.integracaoOuterRef}`, code: 'WA_NO_INTEGRACAO' },
      { status: 400 },
    );
  }

  // 4. Send the template (Graph errors → mapped via respond.ts).
  let wamid: string;
  try {
    const ctx = await loadWhatsappContext(db, contaId);
    const client = await ctx.buildClient();
    const res = await client.sendTemplate({ to, templateName: TEMPLATE_NAME });
    wamid = res.messageId;
  } catch (err) {
    if (isWhatsappError(err)) return whatsappErrorResponse(err);
    throw err;
  }

  // 5. Send-then-write (PRE-ANCHORED): create the mensagem at its wamid doc id so
  //    the #529 trigger's discriminator excludes it (mid set, estadoEnvio =
  //    enviando). ALREADY_EXISTS = a redelivery already wrote it → idempotent.
  const now = Date.now();
  const msgId = mensagemDocId(contaId, wamid);
  try {
    await mensagemCollection.docRef(db, { conversaId }, msgId).create(
      mensagemCollection.parse({
        tipo: 'c',
        conteudo: TEMPLATE_TEXT,
        estadoEnvio: ESTADO_ENVIO.enviando,
        mid: wamid,
        user_id: auth.caller.uid,
        usarioMensagemOuterRef: `documents/usuarios/${auth.caller.uid}`,
        timestamp: now,
        data_cadastro: now,
        lastExternalUpdateDateTime: null,
      }) as DocumentData,
    );
  } catch (err) {
    // A non-Error throwable can't be a gRPC status — surface it as a 500 rather
    // than masking it as WA_TEMPLATE_WRITE_FAILED (mirrors outbound.ts's
    // reanchor + this route's own conversa-bump catch).
    if (!(err instanceof Error)) throw err;
    if ((err as { code?: unknown }).code === GRPC_ALREADY_EXISTS) {
      // Redelivery — the wamid's doc already exists; fall through (idempotent).
    } else {
      // The template WAS delivered but persisting failed — not the caller's fault.
      console.error('[whatsapp] template enviado mas falha ao gravar a mensagem', {
        conversaId,
        contaId,
        wamid,
        message: err.message,
      });
      return NextResponse.json(
        {
          error: 'Template enviado, mas falha ao registrar a mensagem.',
          code: 'WA_TEMPLATE_WRITE_FAILED',
        },
        { status: 502 },
      );
    }
  }

  // 6. Converter-stripped conversa bump: `merge` runs `parseMergePatch`, a PARTIAL
  //    validate that keeps only the provided key — it never re-parses/defaults the
  //    whole doc, so nome/origem/refs/etiqueta are untouched. Best-effort: the
  //    template + mensagem already landed, so a failed ordering bump is non-fatal.
  try {
    await conversaCollection.merge(db, {}, conversaId, { ultima_modificacao: now });
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    console.warn('[whatsapp] template gravado mas falha ao atualizar a conversa', {
      conversaId,
      message: err.message,
    });
  }

  return NextResponse.json({ ok: true, messageId: wamid });
}
