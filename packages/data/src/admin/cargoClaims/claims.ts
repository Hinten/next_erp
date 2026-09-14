import type { Auth, UserRecord } from 'firebase-admin/auth';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { PERM, rulesClaimsFromBits } from '@delfrance/auth';
import {
  cargoSchema,
  effectiveUsuarioPermissoes,
  isSuperUserBits,
  usuarioSchema,
  type Usuario,
  type Cargo,
} from '@delfrance/schemas';
import { cargoCollection, usuarioCollection } from '../collections';
import { AccessError, VALIDATION_PAGE_SIZE } from './model';

export const usuarioAccessSchema = usuarioSchema.pick({
  cargos: true,
  ativo: true,
  colaborador: true,
  isSuperUser: true,
  externalId: true,
});
const cargoAccessSchema = cargoSchema.pick({ permissoes: true });

export async function readCargos(db: Firestore, ids: string[], tx?: Transaction) {
  const result = new Map<string, Pick<Cargo, 'permissoes'>>();
  const unique = [...new Set(ids)].sort();
  for (let i = 0; i < unique.length; i += VALIDATION_PAGE_SIZE) {
    const refs = unique
      .slice(i, i + VALIDATION_PAGE_SIZE)
      .map((id) => cargoCollection.docRef(db, {}, id));
    const docs = tx ? await tx.getAll(...refs) : await db.getAll(...refs);
    for (const doc of docs) if (doc.exists) result.set(doc.id, cargoAccessSchema.parse(doc.data()));
  }
  return result;
}

export async function actorCeiling(
  db: Firestore,
  uid: string,
  tokenBits: bigint,
  tx?: Transaction,
) {
  const ref = usuarioCollection.docRef(db, {}, uid);
  const doc = tx ? await tx.get(ref) : await ref.get();
  if (!doc.exists)
    throw new AccessError(403, 'ACTOR_MISSING', 'Usuário autenticado não encontrado.');
  const user = usuarioAccessSchema.parse(doc.data());
  const cargos = await readCargos(db, user.cargos, tx);
  const ceiling = effectiveUsuarioPermissoes(user, cargos) & tokenBits;
  if ((ceiling & PERM.configuracoes.write) === 0n)
    throw new AccessError(403, 'ACTOR_PERMISSION', 'Sem permissão atual para alterar acessos.');
  return ceiling;
}

export function prepareClaims(
  user: Pick<Usuario, 'cargos' | 'ativo' | 'colaborador' | 'isSuperUser' | 'externalId'>,
  cargos: Map<string, Pick<Cargo, 'permissoes'>>,
  account: Pick<UserRecord, 'disabled' | 'customClaims'>,
  ceiling: bigint,
) {
  const bits = account.disabled ? 0n : effectiveUsuarioPermissoes(user, cargos);
  if ((bits & ~ceiling) !== 0n || (user.isSuperUser && !isSuperUserBits(ceiling))) {
    throw new AccessError(
      403,
      'CASCADE_PERMISSION',
      'As permissões de um usuário afetado ultrapassam as suas.',
    );
  }
  const projected: Record<string, unknown> = {
    permissions: bits.toString(),
    su: isSuperUserBits(bits),
    ...rulesClaimsFromBits(bits),
  };
  const old: Record<string, unknown> = account.customClaims ?? {};
  const unrelated = Object.fromEntries(
    Object.entries(old).filter(
      ([key]) => key !== 'permissions' && key !== 'su' && !key.startsWith('d_'),
    ),
  );
  const claims = { ...unrelated, ...projected };
  if (Buffer.byteLength(JSON.stringify(claims), 'utf8') > 1000) {
    throw new AccessError(
      422,
      'CLAIMS_TOO_LARGE',
      'As claims resultantes excedem o limite do Firebase Auth.',
    );
  }
  const unchanged =
    Object.entries(projected).every(([key, value]) => old[key] === value) &&
    Object.keys(old)
      .filter((key) => key.startsWith('d_'))
      .every((key) => key in projected);
  return { claims, unchanged };
}

export async function getAuthUser(auth: AccessAuth, uid: string) {
  try {
    return await auth.getUser(uid);
  } catch (err) {
    if (err instanceof auth.errorType && err.code === 'auth/user-not-found') return null;
    throw err;
  }
}

export async function writeClaims(
  auth: AccessAuth,
  uid: string,
  prepared: ReturnType<typeof prepareClaims>,
) {
  if (prepared.unchanged) return 'unchanged' as const;
  try {
    await auth.setCustomUserClaims(uid, prepared.claims);
    return 'updated' as const;
  } catch (err) {
    if (err instanceof auth.errorType && err.code === 'auth/user-not-found')
      return 'missing' as const;
    throw err;
  }
}

/** Apps supply the SDK instance/error constructor; data has no runtime Admin import. */
export type AccessAuth = Pick<
  Auth,
  'getUser' | 'getUsers' | 'createUser' | 'setCustomUserClaims'
> & {
  errorType: abstract new (...args: never[]) => Error & { code: string };
};
export function withAccessAuth(client: Auth, errorType: AccessAuth['errorType']): AccessAuth {
  return {
    errorType,
    getUser: (...args) => client.getUser(...args),
    getUsers: (...args) => client.getUsers(...args),
    createUser: (...args) => client.createUser(...args),
    setCustomUserClaims: (...args) => client.setCustomUserClaims(...args),
  };
}
