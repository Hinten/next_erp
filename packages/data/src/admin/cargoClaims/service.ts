import { createHash, randomUUID } from 'node:crypto';
import type { AccessAuth as Auth } from './claims';
import type { DocumentSnapshot, Firestore, Transaction } from 'firebase-admin/firestore';
import { ZodError } from 'zod';
import {
  ACCESS_ACTION as A,
  ACCESS_PHASE as P,
  accessCommandSchema,
  cargoSchema,
  usuarioSchema,
  isSuperUserBits,
  type AccessCommand,
  type AccessOperation,
} from '@delfrance/schemas';
import { cargoCollection, usuarioCollection } from '../collections';
import {
  accessControl,
  accessOperations,
  AccessError,
  busy,
  isCargo,
  VALIDATION_PAGE_SIZE,
  APPLICATION_PAGE_SIZE,
  LEASE_MS,
  MAX_ATTEMPTS,
} from './model';
import {
  actorCeiling,
  getAuthUser,
  prepareClaims,
  readCargos,
  writeClaims,
  usuarioAccessSchema,
} from './claims';

export function snapshotVersion(doc: DocumentSnapshot): string | null {
  return doc.exists && doc.updateTime
    ? `${doc.updateTime.seconds}:${doc.updateTime.nanoseconds}`
    : null;
}
function targetRef(db: Firestore, command: AccessCommand) {
  return (isCargo({ command }) ? cargoCollection : usuarioCollection).docRef(
    db,
    {},
    command.targetId,
  );
}
function fingerprint(command: AccessCommand) {
  return createHash('sha256')
    .update(JSON.stringify(accessCommandSchema.parse(command)))
    .digest('hex');
}
export async function getAccessOperation(db: Firestore, id: string) {
  const doc = await accessOperations.docRef(db, {}, id).get();
  if (!doc.exists) throw new AccessError(404, 'OPERATION_MISSING', 'Operação não encontrada.');
  return accessOperations.parse(doc.data());
}
export async function getActiveOperationId(db: Firestore) {
  const doc = await accessControl.docRef(db, {}, 'current').get();
  return doc.exists ? accessControl.parse(doc.data()).activeId : null;
}

function validateCommand(command: AccessCommand) {
  const cargo = isCargo({ command });
  if (
    (cargo && command.action !== A.deleteCargo && !command.cargo) ||
    (!cargo && command.action !== A.refreshUser && !command.usuario) ||
    (cargo && command.usuario !== null) ||
    (!cargo && command.cargo !== null) ||
    (command.action === A.deleteCargo && command.cargo !== null) ||
    (command.action === A.refreshUser && command.usuario !== null)
  ) {
    throw new AccessError(400, 'COMMAND_INVALID', 'Comando de acesso inválido.');
  }
  const create = command.action === A.createCargo || command.action === A.createUser;
  if (create !== (command.expectedVersion === null))
    throw new AccessError(400, 'VERSION_REQUIRED', 'Versão do registro inválida.');
}

/** Short transaction: no Auth calls and no holder scan. Every participating
 * source writer reserves this same global slot before changing authorization.
 */
export async function startAccessOperation(
  db: Firestore,
  input: {
    id: string;
    actorId: string;
    tokenBits: bigint;
    command: AccessCommand;
  },
) {
  const command = accessCommandSchema.parse(input.command);
  validateCommand(command);
  return db.runTransaction(async (tx) => {
    const opRef = accessOperations.docRef(db, {}, input.id);
    const controlRef = accessControl.docRef(db, {}, 'current');
    const previous = await tx.get(opRef);
    if (previous.exists) {
      const op = accessOperations.parse(previous.data());
      if (op.actorId !== input.actorId || fingerprint(op.command) !== fingerprint(command)) {
        throw new AccessError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'Identificador já utilizado com outro comando.',
        );
      }
      return op;
    }
    const control = await tx.get(controlRef);
    const active = control.exists ? accessControl.parse(control.data()).activeId : null;
    if (active) busy(active);
    const current = await tx.get(targetRef(db, command));
    if (snapshotVersion(current) !== command.expectedVersion)
      throw new AccessError(
        409,
        'VERSION_CONFLICT',
        'O registro foi alterado. Recarregue a página.',
      );
    const ceiling = await actorCeiling(db, input.actorId, input.tokenBits, tx);
    if ((BigInt(command.cargo?.permissoes ?? '0') & ~ceiling) !== 0n) {
      throw new AccessError(
        403,
        'CASCADE_PERMISSION',
        'Você não pode atribuir permissões superiores às suas.',
      );
    }
    if (!isCargo({ command })) {
      const old = current.exists ? usuarioAccessSchema.parse(current.data()) : null;
      if ((old?.isSuperUser || command.usuario?.isSuperUser) && !isSuperUserBits(ceiling)) {
        throw new AccessError(
          403,
          'SUPERUSER_PERMISSION',
          'Apenas superusuários podem alterar superusuários.',
        );
      }
      if (command.usuario && command.action === A.createUser) {
        const roles = await readCargos(db, command.usuario.cargos, tx);
        prepareClaims(command.usuario, roles, { disabled: false, customClaims: {} }, ceiling);
      }
      if (command.usuario && command.usuario.externalId !== (old?.externalId ?? null)) {
        throw new AccessError(
          400,
          'USER_IDENTITY',
          'A identidade externa do usuário não pode ser alterada.',
        );
      }
    }
    const now = Date.now();
    const op: AccessOperation = {
      id: input.id,
      actorId: input.actorId,
      ceiling: ceiling.toString(),
      command,
      phase: command.action === A.createUser ? P.provisioning : P.validating,
      committed: false,
      cursor: null,
      validated: 0,
      processed: 0,
      updated: 0,
      unchanged: 0,
      missing: 0,
      external: 0,
      attempts: 0,
      startedAt: now,
      progressAt: now,
      finishedAt: null,
      leaseOwner: null,
      leaseUntil: 0,
      errorCode: null,
      errorMessage: null,
      errorTarget: null,
    };
    tx.create(opRef, op);
    tx.set(controlRef, { activeId: input.id, lastId: input.id });
    return op;
  });
}

/** The lease exceeds both the HTTP worker lifetime and its dispatch deadline.
 * No lease takeover is possible while a preceding deployed invocation can run.
 */
async function acquire(db: Firestore, id: string, owner: string) {
  return db.runTransaction(async (tx) => {
    const ref = accessOperations.docRef(db, {}, id);
    const doc = await tx.get(ref);
    const control = await tx.get(accessControl.docRef(db, {}, 'current'));
    if (!doc.exists || !control.exists || accessControl.parse(control.data()).activeId !== id)
      return null;
    const op = accessOperations.parse(doc.data());
    if (
      op.phase === P.failed ||
      op.phase === P.rejected ||
      op.phase === P.completed ||
      op.leaseUntil > Date.now()
    )
      return null;
    if (op.attempts >= MAX_ATTEMPTS) {
      tx.update(ref, {
        phase: op.committed ? P.failed : P.rejected,
        errorCode: 'WORKER_RETRIES_EXHAUSTED',
        errorMessage:
          'A execução não conseguiu registrar progresso. A operação precisa de atenção.',
        leaseOwner: null,
        leaseUntil: 0,
        progressAt: Date.now(),
        finishedAt: op.committed ? null : Date.now(),
      });
      if (!op.committed)
        tx.set(accessControl.docRef(db, {}, 'current'), { activeId: null, lastId: op.id });
      return null;
    }
    const next = {
      ...op,
      attempts: op.attempts + 1,
      leaseOwner: owner,
      leaseUntil: Date.now() + LEASE_MS,
    };
    tx.set(ref, next);
    return next;
  });
}

async function owned(tx: Transaction, db: Firestore, op: AccessOperation) {
  const doc = await tx.get(accessOperations.docRef(db, {}, op.id));
  const control = await tx.get(accessControl.docRef(db, {}, 'current'));
  const fresh = accessOperations.parse(doc.data());
  if (
    !control.exists ||
    accessControl.parse(control.data()).activeId !== op.id ||
    fresh.leaseOwner !== op.leaseOwner ||
    fresh.leaseUntil <= Date.now() ||
    fresh.phase !== op.phase ||
    fresh.cursor !== op.cursor
  ) {
    throw new AccessError(409, 'LEASE_LOST', 'Execução substituída por outra tentativa.');
  }
  return fresh;
}

async function checkpoint(
  db: Firestore,
  op: AccessOperation,
  patch: Partial<AccessOperation>,
  release = false,
) {
  await db.runTransaction(async (tx) => {
    const fresh = await owned(tx, db, op);
    tx.set(accessOperations.docRef(db, {}, op.id), {
      ...fresh,
      errorCode: null,
      errorMessage: null,
      errorTarget: null,
      ...patch,
      leaseOwner: null,
      leaseUntil: 0,
      progressAt: Date.now(),
    });
    if (release) tx.set(accessControl.docRef(db, {}, 'current'), { activeId: null, lastId: op.id });
  });
}

async function subjects(db: Firestore, op: AccessOperation, size: number) {
  if (!isCargo(op)) {
    if (op.cursor) return [];
    if (op.command.usuario) return [{ uid: op.command.targetId, user: op.command.usuario }];
    const doc = await usuarioCollection.docRef(db, {}, op.command.targetId).get();
    return doc.exists ? [{ uid: doc.id, user: usuarioAccessSchema.parse(doc.data()) }] : [];
  }
  let query = usuarioCollection
    .ref(db, {})
    .where('cargos', 'array-contains', op.command.targetId)
    .orderBy('__name__')
    .limit(size);
  if (op.cursor) query = query.startAfter(op.cursor);
  const page = await query.get();
  return page.docs.map((doc) => ({ uid: doc.id, user: usuarioAccessSchema.parse(doc.data()) }));
}

async function commitMutation(db: Firestore, op: AccessOperation) {
  await db.runTransaction(async (tx) => {
    const fresh = await owned(tx, db, op);
    const ref = targetRef(db, op.command);
    const target = await tx.get(ref);
    if (snapshotVersion(target) !== op.command.expectedVersion)
      throw new AccessError(409, 'VERSION_CONFLICT', 'O registro mudou durante a validação.');
    // All supported permission writers remain excluded by the global slot.
    // Re-read actor data nonetheless; no stale token can authorize the commit.
    const currentCeiling = await actorCeiling(db, op.actorId, BigInt(op.ceiling), tx);
    if ((BigInt(op.ceiling) & ~currentCeiling) !== 0n)
      throw new AccessError(
        403,
        'ACTOR_PERMISSION',
        'As permissões do administrador mudaram durante a validação.',
      );
    const now = Date.now();
    if (op.command.action === A.deleteCargo) tx.delete(ref);
    else if (isCargo(op)) {
      const old = target.exists ? cargoSchema.parse(target.data()) : null;
      tx.set(ref, {
        ...target.data(),
        ...op.command.cargo!,
        timestamp: old?.timestamp ?? now,
        ultimaModificacao: now,
      });
    } else if (op.command.usuario) {
      const old = target.exists ? usuarioSchema.parse(target.data()) : null;
      const user = op.command.usuario;
      tx.set(ref, {
        ...target.data(),
        ...user,
        timestamp: old?.timestamp ?? now,
        ultimaModificacao: now,
        jaFoiColaborador: !!old?.jaFoiColaborador || user.colaborador,
        jaFoiSuperUser: !!old?.jaFoiSuperUser || user.isSuperUser,
      });
    }
    tx.set(accessOperations.docRef(db, {}, op.id), {
      ...fresh,
      phase: P.applying,
      committed: true,
      cursor: null,
      leaseOwner: null,
      leaseUntil: 0,
      attempts: 0,
      progressAt: now,
    });
  });
}

async function validatePage(db: Firestore, auth: Auth, op: AccessOperation) {
  const page = await subjects(db, op, VALIDATION_PAGE_SIZE);
  const candidates = page.filter(({ user }) => user.externalId === null);
  const accounts = candidates.length
    ? (await auth.getUsers(candidates.map(({ uid }) => ({ uid })))).users
    : [];
  const byId = new Map(accounts.map((account) => [account.uid, account]));
  const cargos = await readCargos(
    db,
    page.flatMap(({ user }) => user.cargos),
  );
  if (isCargo(op)) {
    if (op.command.cargo) cargos.set(op.command.targetId, op.command.cargo);
    else cargos.delete(op.command.targetId);
  }
  for (const { uid, user } of candidates) {
    op.errorTarget = uid;
    const account = byId.get(uid);
    if (account) prepareClaims(user, cargos, account, BigInt(op.ceiling));
  }
  // The empty terminal page keeps the transaction that commits the mutation
  // separate from the last validation checkpoint, including exact multiples.
  if (page.length === 0) {
    const actor = await getAuthUser(auth, op.actorId);
    if (!actor || actor.disabled)
      throw new AccessError(403, 'ACTOR_DISABLED', 'A conta do administrador foi desabilitada.');
    await commitMutation(db, op);
  } else
    await checkpoint(db, op, {
      cursor: page.at(-1)!.uid,
      validated: op.validated + page.length,
      attempts: 0,
    });
}

async function applyPage(db: Firestore, auth: Auth, op: AccessOperation) {
  const page = await subjects(db, op, APPLICATION_PAGE_SIZE);
  const cargos = await readCargos(
    db,
    page.flatMap(({ user }) => user.cargos),
  );
  const counts = {
    updated: op.updated,
    unchanged: op.unchanged,
    missing: op.missing,
    external: op.external,
  };
  const began = op.leaseUntil - LEASE_MS;
  let processed = 0;
  for (const { uid, user } of page) {
    op.errorTarget = uid;
    // Stop starting RPCs at 80s; even an in-flight SDK retry window must finish
    // before the 240s lease permits takeover (the function deadline is 120s).
    if (Date.now() - began > 80_000) break;
    if (user.externalId !== null) counts.external++;
    else {
      const account = await getAuthUser(auth, uid);
      // Auth SDK 14.2 uses 25s RPC timeouts and at most 4 retries. Do not start
      // another Auth write after the 80s budget: its retry window must fit the lease.
      if (Date.now() - began > 80_000) break;
      if (!account) counts.missing++;
      else
        counts[
          await writeClaims(auth, uid, prepareClaims(user, cargos, account, BigInt(op.ceiling)))
        ]++;
    }
    processed++;
  }
  if (page.length && !processed)
    throw new AccessError(
      503,
      'SLICE_BUDGET_EXHAUSTED',
      'O serviço de autenticação excedeu o prazo deste lote. Retome a operação.',
    );
  const done = page.length === 0;
  await checkpoint(
    db,
    op,
    {
      ...counts,
      processed: op.processed + processed,
      cursor: processed ? page[processed - 1]!.uid : op.cursor,
      attempts: 0,
      phase: done ? P.completed : P.applying,
      finishedAt: done ? Date.now() : null,
    },
    done,
  );
}

/** One bounded slice. Unknown errors keep the lease until its safe deadline;
 * the watchdog re-dispatches. Typed failures are diagnosed without logging data.
 */
export async function processAccessOperation(db: Firestore, auth: Auth, id: string) {
  const op = await acquire(db, id, randomUUID());
  if (!op) return;
  try {
    if (op.phase === P.provisioning) {
      const account = await getAuthUser(auth, op.command.targetId);
      if (account) await checkpoint(db, op, { phase: P.validating, attempts: 0 });
      else if (Date.now() - op.startedAt > LEASE_MS)
        throw new AccessError(
          422,
          'PROVISIONING_INCOMPLETE',
          'A criação da conta não foi concluída. Envie uma nova solicitação.',
        );
      else await checkpoint(db, op, { attempts: 0 });
    } else if (op.phase === P.validating) await validatePage(db, auth, op);
    else if (op.phase === P.applying) await applyPage(db, auth, op);
  } catch (err) {
    if (
      !(err instanceof AccessError) &&
      !(err instanceof auth.errorType) &&
      !(err instanceof ZodError)
    )
      throw err;
    if (err instanceof AccessError && err.code === 'LEASE_LOST') return;
    const permanent = err instanceof AccessError || err instanceof ZodError;
    const exhausted = op.attempts >= MAX_ATTEMPTS;
    const stop = permanent || exhausted;
    const rejected = stop && !op.committed;
    await checkpoint(
      db,
      op,
      {
        attempts: op.attempts,
        phase: rejected ? P.rejected : stop ? P.failed : op.phase,
        errorCode:
          err instanceof AccessError || err instanceof auth.errorType
            ? err.code
            : 'INVALID_AUTHORIZATION_DATA',
        errorMessage:
          err instanceof AccessError
            ? err.message
            : 'Não foi possível atualizar as permissões. Consulte o diagnóstico da operação.',
        errorTarget: op.errorTarget ?? op.command.targetId,
        finishedAt: rejected ? Date.now() : null,
      },
      rejected,
    );
    console.warn('access-operation failure', {
      operationId: id,
      phase: op.phase,
      permanent,
      attempts: op.attempts,
    });
  }
}

export async function retryAccessOperation(
  db: Firestore,
  id: string,
  actorId: string,
  tokenBits: bigint,
) {
  return db.runTransaction(async (tx) => {
    const ref = accessOperations.docRef(db, {}, id);
    const doc = await tx.get(ref);
    if (!doc.exists) throw new AccessError(404, 'OPERATION_MISSING', 'Operação não encontrada.');
    const op = accessOperations.parse(doc.data());
    const control = await tx.get(accessControl.docRef(db, {}, 'current'));
    if (
      !control.exists ||
      accessControl.parse(control.data()).activeId !== id ||
      op.phase !== P.failed ||
      op.leaseUntil > Date.now()
    ) {
      throw new AccessError(409, 'NOT_RETRYABLE', 'A operação não está disponível para retomada.');
    }
    // Resuming this immutable, already committed command does not authorize
    // a new mutation. Preserve the original actor's accepted authorization,
    // including self-demotion; other actors must cover the original ceiling.
    if (actorId !== op.actorId) {
      const ceiling = await actorCeiling(db, actorId, tokenBits, tx);
      if ((BigInt(op.ceiling) & ~ceiling) !== 0n)
        throw new AccessError(
          403,
          'RETRY_PERMISSION',
          'A retomada por outro administrador requer as permissões originais.',
        );
    }
    tx.update(ref, {
      phase: P.applying,
      attempts: 0,
      errorCode: null,
      errorMessage: null,
      errorTarget: null,
      progressAt: Date.now(),
    });
  });
}

// The API never persists a password. Reserve a deterministic Auth UID before
// provisioning; a crashed response is recoverable by the watchdog's UID lookup.
export async function provisionAccessUser(auth: Auth, op: AccessOperation, password: string) {
  if (op.phase !== P.provisioning) return;
  const user = op.command.usuario!;
  const existing = await getAuthUser(auth, op.command.targetId);
  if (existing) return;
  if (Date.now() - op.startedAt > 80_000)
    throw new AccessError(
      409,
      'PROVISIONING_EXPIRED',
      'A criação da conta expirou. A operação será reconciliada.',
      op.id,
    );
  try {
    await auth.createUser({
      uid: op.command.targetId,
      email: user.email!,
      displayName: user.nome,
      password,
    });
  } catch (err) {
    if (err instanceof auth.errorType && err.code === 'auth/uid-already-exists') return;
    throw err;
  }
}
