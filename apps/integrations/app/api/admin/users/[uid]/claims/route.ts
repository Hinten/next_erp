import { NextResponse } from 'next/server';
import { PERM, hasPerm } from '@delfrance/auth';
import {
  aggregatePermissoes,
  type Cargo,
  isSuperUserBits,
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

function decodeCallerBits(perms: string | undefined): bigint {
  try {
    return BigInt(perms ?? '0');
  } catch {
    return 0n;
  }
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

  let callerBits: bigint;
  try {
    const decoded = await getAdminAuth().verifyIdToken(idToken);
    if (!hasPerm(decoded.permissions as string | undefined, PERM.configuracoes.write)) {
      return err(403, { error: 'Sem permissão configuracoes.write.' });
    }
    callerBits = decodeCallerBits(decoded.permissions as string | undefined);
  } catch {
    return err(401, { error: 'Token inválido ou expirado.' });
  }

  const db = getAdminFirestore();
  const userSnap = await db.collection('usuarios').doc(uid).get();
  const user = userSnap.data() as Usuario | undefined;
  if (!user) return err(404, { error: 'Usuário não encontrado.' });

  const cargosById = new Map<string, Cargo>();
  await Promise.all(
    user.cargos.map(async (cid) => {
      const snap = await db.collection('cargos').doc(cid).get();
      const data = snap.data();
      if (data) cargosById.set(cid, data as Cargo);
    }),
  );

  const bits = aggregatePermissoes(user, cargosById);

  // Cascade-permission guard: a caller can only push a claim recomputation
  // that lands within their own bitmask. Otherwise an under-privileged admin
  // could edit a user's cargos to grant bits they don't hold themselves.
  if ((bits & ~callerBits) !== 0n) {
    return err(403, {
      error:
        'Você não pode promover este usuário com permissões superiores às suas.',
    });
  }
  if (user.isSuperUser && !isSuperUserBits(callerBits)) {
    return err(403, {
      error: 'Apenas superusuários podem recomputar claims de superusuários.',
    });
  }

  await getAdminAuth().setCustomUserClaims(uid, {
    permissions: bits.toString(),
  });

  return NextResponse.json({ uid, permissions: bits.toString() });
}
