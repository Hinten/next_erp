import { NextResponse } from 'next/server';
import { hasPerm } from '@delfrance/auth';
import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  confirmarVinculoSchema,
  confirmarVinculoWhatsapp,
  detalheVinculoWhatsapp,
} from '@/lib/whatsapp/vinculos';
import { WhatsappVinculoConflitoError } from '@/lib/whatsapp/contatos';
import { solicitarReplayVinculo } from '@/lib/whatsapp/notificacao';
type Context = { params: Promise<{ id: string }> };
export const dynamic = 'force-dynamic';
export async function GET(req: Request, context: Context) {
  const auth = await verifyCaller(req, PERM.chat.read | PERM.cliente.read);
  if ('error' in auth) return auth.error;
  const { id } = await context.params;
  const result = await detalheVinculoWhatsapp(
    getAdminFirestore(),
    id,
    new URL(req.url).searchParams.get('cursor') ?? undefined,
  );
  return result
    ? NextResponse.json(result)
    : NextResponse.json({ error: 'Contato não encontrado.' }, { status: 404 });
}
export async function POST(req: Request, context: Context) {
  const auth = await verifyCaller(req, PERM.chat.read | PERM.chat.write | PERM.cliente.read);
  if ('error' in auth) return auth.error;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 });
  }
  const parsed = confirmarVinculoSchema.safeParse(raw);
  if (!parsed.success)
    return NextResponse.json(
      { error: 'Dados de vínculo inválidos.', details: parsed.error.flatten() },
      { status: 400 },
    );
  if (parsed.data.choice.kind === 'create' && !hasPerm(auth.caller.permissions, PERM.cliente.write))
    return NextResponse.json({ error: 'Sem permissão para criar clientes.' }, { status: 403 });
  const { id } = await context.params;
  const db = getAdminFirestore();
  try {
    const result = await confirmarVinculoWhatsapp(db, id, parsed.data, auth.caller.uid);
    if (result.replayPending) await solicitarReplayVinculo(db, id);
    return NextResponse.json(result);
  } catch (error) {
    if (!(error instanceof WhatsappVinculoConflitoError)) throw error;
    return NextResponse.json(
      {
        error: error.message,
        code: 'WA_VINCULO_CONFLITO',
        clienteId: error.clienteId,
        conversaId: error.conversaId,
      },
      { status: 409 },
    );
  }
}
