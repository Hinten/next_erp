import { NextResponse } from 'next/server';
import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { listarVinculosWhatsapp } from '@/lib/whatsapp/vinculos';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  const auth = await verifyCaller(req, PERM.chat.read | PERM.cliente.read);
  if ('error' in auth) return auth.error;
  const params = new URL(req.url).searchParams;
  const limit = Number(params.get('limit') ?? 30);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    return NextResponse.json({ error: 'Limite inválido.' }, { status: 400 });
  return NextResponse.json(
    await listarVinculosWhatsapp(getAdminFirestore(), {
      integracaoId: params.get('integracaoId') ?? undefined,
      cursor: params.get('cursor') ?? undefined,
      limit,
    }),
  );
}
