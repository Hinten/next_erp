import { NextResponse } from 'next/server';
import { z } from 'zod';
import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { preverVinculoWhatsapp } from '@/lib/whatsapp/vinculos';
import { WhatsappVinculoConflitoError } from '@/lib/whatsapp/contatos';

export const dynamic = 'force-dynamic';
const idSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^/]+$/);
type Context = { params: Promise<{ id: string }> };

export async function GET(req: Request, context: Context) {
  const auth = await verifyCaller(req, PERM.chat.read | PERM.cliente.read);
  if ('error' in auth) return auth.error;
  const { id } = await context.params;
  const parsed = z.object({ id: idSchema, clienteId: idSchema }).safeParse({
    id,
    clienteId: new URL(req.url).searchParams.get('clienteId'),
  });
  if (!parsed.success)
    return NextResponse.json({ error: 'Contato ou cliente inválido.' }, { status: 400 });
  try {
    const result = await preverVinculoWhatsapp(
      getAdminFirestore(),
      parsed.data.id,
      parsed.data.clienteId,
    );
    return result
      ? NextResponse.json(result)
      : NextResponse.json(
          { error: 'Contato, integração ou cliente não encontrado.' },
          { status: 404 },
        );
  } catch (error) {
    if (!(error instanceof WhatsappVinculoConflitoError)) throw error;
    return NextResponse.json(
      { error: error.message, code: 'WA_VINCULO_CONFLITO' },
      { status: 409 },
    );
  }
}
