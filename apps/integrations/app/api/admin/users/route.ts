import { NextResponse } from 'next/server';
import { z } from 'zod';
import { PERM, hasPerm } from '@delfrance/auth';
import { cargoCollection, usuarioCollection } from '@delfrance/data/admin/collections';
import { aggregatePermissoes, type Cargo, isSuperUserBits, type Usuario } from '@delfrance/schemas';
import { getAdminAuth, getAdminFirestore } from '@/lib/firebase/admin';
import { rootLog } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = rootLog.child({ mod: 'admin/users' });

const createUserSchema = z.object({
  email: z.string().email().max(255),
  nome: z.string().min(1).max(255),
  senha: z.string().min(6).max(128),
  cargos: z.array(z.string()).default([]),
  colaborador: z.boolean().default(false),
  isSuperUser: z.boolean().default(false),
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

async function verifyCaller(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: err(401, { error: 'Authorization Bearer token ausente.' }) };
  }
  const idToken = authHeader.slice('Bearer '.length);
  try {
    const decoded = await getAdminAuth().verifyIdToken(idToken);
    const perms = decoded.permissions as string | undefined;
    if (!hasPerm(perms, PERM.configuracoes.write)) {
      return {
        error: err(403, { error: 'Sem permissão configuracoes.write.' }),
      };
    }
    return { decoded };
  } catch (e) {
    log.error({ err: e }, 'verifyIdToken failed');
    // firebase-admin throws `FirebaseAuthError` (an Error subclass with a
    // string `code` like `auth/id-token-expired`). We can't `instanceof` it
    // because the class isn't part of the package's public runtime API; the
    // duck-typed Error+code check covers it without depending on internals.
    if (e instanceof Error && typeof (e as { code?: unknown }).code === 'string') {
      return { error: err(401, { error: 'Token inválido ou expirado.' }) };
    }
    throw e;
  }
}

function decodeCallerBits(perms: string | undefined): bigint {
  try {
    return BigInt(perms ?? '0');
  } catch (e) {
    if (e instanceof SyntaxError) {
      return 0n;
    }
    throw e;
  }
}

export async function POST(req: Request) {
  let json: unknown;
  try {
    json = await req.json();
  } catch (e) {
    if (e instanceof SyntaxError) {
      return err(400, { error: 'Body JSON inválido.' });
    }
    throw e;
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

  const auth = await verifyCaller(req);
  if (auth.error) return auth.error;
  const { decoded } = auth;
  const callerBits = decodeCallerBits(decoded.permissions as string | undefined);

  const db = getAdminFirestore();

  const cargosById = new Map<string, Cargo>();
  await Promise.all(
    body.cargos.map(async (cid) => {
      const snap = await cargoCollection.docRef(db, {}, cid).get();
      const data = snap.data();
      if (data)
        cargosById.set(cid, cargoCollection.parseRead(data, cargoCollection.docPath({}, cid)));
    }),
  );

  const bits = aggregatePermissoes(
    { cargos: [...cargosById.keys()], isSuperUser: body.isSuperUser },
    cargosById,
  );

  // Cascade-permission guard: prevent privilege escalation. A caller can only
  // grant bits that the caller already holds. Form-side guards are UX; this
  // is the security boundary (until Firestore rules cover it too).
  if ((bits & ~callerBits) !== 0n) {
    return err(403, {
      error: 'Você não pode atribuir cargos com permissões que ultrapassem as suas.',
    });
  }
  if (body.isSuperUser && !isSuperUserBits(callerBits)) {
    return err(403, {
      error: 'Apenas superusuários podem criar superusuários.',
    });
  }

  let uid: string;
  try {
    const created = await getAdminAuth().createUser({
      email: body.email,
      password: body.senha,
      displayName: body.nome,
    });
    uid = created.uid;
  } catch (e) {
    if (e instanceof Error && typeof (e as { code?: unknown }).code === 'string') {
      const { status, body } = mapFirebaseError(e);
      return err(status, body);
    }
    throw e;
  }

  await getAdminAuth().setCustomUserClaims(uid, {
    permissions: bits.toString(),
  });

  const usuarioDoc: Usuario = {
    nome: body.nome,
    email: body.email,
    cargos: [...cargosById.keys()],
    colaborador: body.colaborador,
    ativo: true,
    isSuperUser: body.isSuperUser,
    jaFoiColaborador: body.colaborador,
    jaFoiSuperUser: body.isSuperUser,
    ultimoAcesso: null,
    timestamp: new Date().toISOString(),
  };
  await usuarioCollection.set(db, {}, uid, usuarioDoc);

  return NextResponse.json({ uid }, { status: 201 });
}
