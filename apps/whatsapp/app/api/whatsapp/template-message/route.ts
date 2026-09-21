import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ORIGEM_CONVERSA,
  ESTADO_ENVIO,
  TIPO_MENSAGEM,
  idFromRef,
  mesmoDestinoWhatsapp,
  whatsappDestinoSchema,
} from '@delfrance/schemas';
import { conversaCollection, mensagemCollection } from '@delfrance/data/admin/collections';
import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { dispatchOutbound } from '@/lib/whatsapp/outbound';
import { WhatsappVinculoConflitoError } from '@/lib/whatsapp/contatos';
import { isWhatsappError, whatsappErrorResponse } from '@/lib/whatsapp/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const bodySchema = z.object({
  conversaId: z
    .string()
    .min(1)
    .regex(/^[^/]+$/),
  whatsappDestino: whatsappDestinoSchema,
  whatsappIntegracaoId: z.string().min(1),
});
/** Persist the accepted recipient before Graph. The shared sender claim excludes a concurrent trigger. */
export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.chat.write);
  if ('error' in auth) return auth.error;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success)
    return NextResponse.json(
      { error: 'Conversa e destino WhatsApp são obrigatórios.' },
      { status: 400 },
    );
  const body = parsed.data;
  const db = getAdminFirestore();
  const messageId = randomUUID();
  const ref = mensagemCollection.docRef(db, { conversaId: body.conversaId }, messageId);
  try {
    const data = await db.runTransaction(async (tx) => {
      const snap = await tx.get(conversaCollection.docRef(db, {}, body.conversaId));
      const conversa = snap.exists ? conversaCollection.parseRead(snap.data()) : null;
      if (!conversa || conversa.origem !== ORIGEM_CONVERSA.whatsapp)
        throw new WhatsappVinculoConflitoError('Conversa WhatsApp não encontrada.');
      if (
        !mesmoDestinoWhatsapp(conversa.whatsappDestino, body.whatsappDestino) ||
        idFromRef(conversa.integracaoOuterRef ?? '') !== body.whatsappIntegracaoId
      )
        throw new WhatsappVinculoConflitoError(
          'O destino mudou. Revise a conversa antes de enviar.',
        );
      const data = mensagemCollection.parse({
        tipo: TIPO_MENSAGEM.comum,
        conteudo: 'Olá, podemos dar continuidade no seu atendimento?',
        estadoEnvio: ESTADO_ENVIO.salva,
        whatsappTemplate: 'reabertura_conversa',
        whatsappDestino: body.whatsappDestino,
        whatsappIntegracaoId: body.whatsappIntegracaoId,
        user_id: auth.caller.uid,
        usarioMensagemOuterRef: 'documents/usuarios/' + auth.caller.uid,
        timestamp: Date.now(),
        data_cadastro: Date.now(),
      });
      tx.create(ref, data);
      return data;
    });
    const result = await dispatchOutbound(db, body.conversaId, messageId, data);
    if (result.kind === 'error')
      return NextResponse.json(
        { error: result.reason, code: 'WA_TEMPLATE_SEND_FAILED' },
        { status: 502 },
      );
    return NextResponse.json({
      ok: true,
      messageId: result.kind === 'sent' ? result.wamid : messageId,
    });
  } catch (error) {
    if (error instanceof WhatsappVinculoConflitoError)
      return NextResponse.json(
        { error: error.message, code: 'WA_DESTINO_CONFLITO' },
        { status: 409 },
      );
    if (isWhatsappError(error)) return whatsappErrorResponse(error);
    throw error;
  }
}
