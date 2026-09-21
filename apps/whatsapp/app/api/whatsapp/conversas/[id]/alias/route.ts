import { NextResponse } from 'next/server';
import {
  whatsappConversaAliasCollection,
  whatsappMensagemAliasCollection,
} from '@delfrance/data/admin/collections';
import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
export const dynamic = 'force-dynamic';
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await verifyCaller(req, PERM.chat.read);
  if ('error' in auth) return auth.error;
  const { id } = await context.params;
  const db = getAdminFirestore();
  const alias = await whatsappConversaAliasCollection.docRef(db, {}, id).get();
  const mensagemId = new URL(req.url).searchParams.get('mensagemId');
  const messageAlias = mensagemId
    ? await whatsappMensagemAliasCollection.docRef(db, { conversaId: id }, mensagemId).get()
    : null;
  return NextResponse.json({
    conversaId: alias.exists
      ? String(alias.data()?.conversaId)
      : messageAlias?.exists
        ? String(messageAlias.data()?.conversaId)
        : null,
    mensagemId: messageAlias?.exists ? String(messageAlias.data()?.mensagemId) : null,
  });
}
