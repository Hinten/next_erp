import { NextResponse } from 'next/server';
import { PERM, hasPerm } from '@delfrance/auth';
import {
  aggregatePermissoes,
  type Cargo,
  type Usuario,
} from '@delfrance/schemas';
import { getAdminAuth, getAdminFirestore } from '@/lib/firebase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ErrorBody {
  error: string;
}

function err(status: number, body: ErrorBody) {
  return NextResponse.json(body, { status });
}

/**
 * Recompute the target user's custom claims from their current Firestore doc.
 * Idempotent — safe to call on every edit. Used by the web app right after
 * saving usuario changes so the next token refresh reflects new cargos.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ uid: string }> },
) {
  const { uid } = await params;

  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return err(401, { error: 'Authorization Bearer token ausente.' });
  }
  const idToken = authHeader.slice('Bearer '.length);

  let callerGE: string | undefined;
  try {
    const decoded = await getAdminAuth().verifyIdToken(idToken);
    callerGE = decoded.grupoEconomico as string | undefined;
    if (!hasPerm(decoded.permissions as string | undefined, PERM.configuracoes.write)) {
      return err(403, { error: 'Sem permissão configuracoes.write.' });
    }
  } catch {
    return err(401, { error: 'Token inválido ou expirado.' });
  }

  const db = getAdminFirestore();
  const userSnap = await db.collection('usuarios').doc(uid).get();
  const user = userSnap.data() as Usuario | undefined;
  if (!user) return err(404, { error: 'Usuário não encontrado.' });
  if (user.grupoEconomico !== callerGE) {
    return err(403, { error: 'Usuário pertence a outro grupo econômico.' });
  }

  const cargosById = new Map<string, Cargo>();
  await Promise.all(
    user.cargos.map(async (cid) => {
      const snap = await db.collection('cargos').doc(cid).get();
      const data = snap.data();
      if (data && data.grupoEconomico === user.grupoEconomico) {
        cargosById.set(cid, data as Cargo);
      }
    }),
  );

  const bits = aggregatePermissoes(user, cargosById);

  await getAdminAuth().setCustomUserClaims(uid, {
    grupoEconomico: user.grupoEconomico,
    permissions: bits.toString(),
  });

  return NextResponse.json({ uid, permissions: bits.toString() });
}
