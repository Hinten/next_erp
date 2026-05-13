import { NextResponse } from 'next/server';
import { z } from 'zod';
import { PERM, hasPerm } from '@delfrance/auth';
import {
  aggregatePermissoes,
  type Cargo,
  type Usuario,
} from '@delfrance/schemas';
import { getAdminAuth, getAdminFirestore } from '@/lib/firebase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const createUserSchema = z.object({
  email: z.string().email().max(255),
  nome: z.string().min(1).max(255),
  senha: z.string().min(6).max(128),
  cargos: z.array(z.string()).default([]),
  colaborador: z.boolean().default(false),
  isSuperUser: z.boolean().default(false),
  grupoEconomico: z.string().min(1),
});

interface ErrorBody {
  error: string;
  code?: string;
}

function err(status: number, body: ErrorBody) {
  return NextResponse.json(body, { status });
}

function mapFirebaseError(e: unknown): { status: number; body: ErrorBody } {
  const code = (e as { code?: string }).code;
  switch (code) {
    case 'auth/email-already-exists':
      return { status: 409, body: { error: 'E-mail já cadastrado.', code } };
    case 'auth/invalid-email':
      return { status: 400, body: { error: 'E-mail inválido.', code } };
    case 'auth/invalid-password':
    case 'auth/weak-password':
      return {
        status: 400,
        body: { error: 'Senha fraca: mínimo 6 caracteres.', code },
      };
    default:
      return {
        status: 500,
        body: {
          error: e instanceof Error ? e.message : 'Erro interno.',
          code,
        },
      };
  }
}

/**
 * Verifies the caller's Firebase ID token, then asserts the caller can write
 * to `configuracoes` AND belongs to the target `grupoEconomico`. Returns the
 * decoded token on success; sends an error response on failure.
 */
async function verifyCaller(req: Request, grupoEconomico: string) {
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: err(401, { error: 'Authorization Bearer token ausente.' }) };
  }
  const idToken = authHeader.slice('Bearer '.length);
  try {
    const decoded = await getAdminAuth().verifyIdToken(idToken);
    const callerGE = decoded.grupoEconomico as string | undefined;
    if (callerGE !== grupoEconomico) {
      return {
        error: err(403, {
          error: 'Grupo econômico do chamador não corresponde ao alvo.',
        }),
      };
    }
    const perms = decoded.permissions as string | undefined;
    if (!hasPerm(perms, PERM.configuracoes.write)) {
      return {
        error: err(403, { error: 'Sem permissão configuracoes.write.' }),
      };
    }
    return { decoded };
  } catch {
    return { error: err(401, { error: 'Token inválido ou expirado.' }) };
  }
}

export async function POST(req: Request) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return err(400, { error: 'Body JSON inválido.' });
  }

  const parsed = createUserSchema.safeParse(json);
  if (!parsed.success) {
    return err(400, {
      error: `Validação falhou: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    });
  }
  const body = parsed.data;

  const auth = await verifyCaller(req, body.grupoEconomico);
  if (auth.error) return auth.error;

  const db = getAdminFirestore();

  // Load referenced cargos to aggregate the permissions bitmask. Drop any
  // cargo IDs that don't belong to this tenant — silent prune is intentional
  // so a stale UI cache doesn't get a confusing rejection.
  const cargosById = new Map<string, Cargo>();
  await Promise.all(
    body.cargos.map(async (cid) => {
      const snap = await db.collection('cargos').doc(cid).get();
      const data = snap.data();
      if (data && data.grupoEconomico === body.grupoEconomico) {
        cargosById.set(cid, data as Cargo);
      }
    }),
  );

  const bits = aggregatePermissoes(
    { cargos: [...cargosById.keys()], isSuperUser: body.isSuperUser },
    cargosById,
  );

  // Create the Firebase Auth user FIRST — if this fails, no Firestore garbage
  // is left behind. Claims + doc write happen after, in order.
  let uid: string;
  try {
    const created = await getAdminAuth().createUser({
      email: body.email,
      password: body.senha,
      displayName: body.nome,
    });
    uid = created.uid;
  } catch (e) {
    const { status, body } = mapFirebaseError(e);
    return err(status, body);
  }

  await getAdminAuth().setCustomUserClaims(uid, {
    grupoEconomico: body.grupoEconomico,
    permissions: bits.toString(),
  });

  const usuarioDoc: Usuario = {
    nome: body.nome,
    email: body.email,
    cargos: [...cargosById.keys()],
    colaborador: body.colaborador,
    ativo: true,
    isSuperUser: body.isSuperUser,
    grupoEconomico: body.grupoEconomico,
    jaFoiColaborador: body.colaborador,
    jaFoiSuperUser: body.isSuperUser,
    ultimoAcesso: null,
    timestamp: new Date().toISOString(),
  };
  await db.collection('usuarios').doc(uid).set(usuarioDoc);

  return NextResponse.json({ uid }, { status: 201 });
}
