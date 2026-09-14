import { FirebaseAuthError } from 'firebase-admin/auth';
import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { PERM } from '@delfrance/auth';
import {
  ACCESS_ACTION as A,
  accessIdSchema,
  cargoSchema,
  usuarioSchema,
  cargoEditorReadSchema,
  usuarioEditorReadSchema,
  type AccessCommand,
} from '@delfrance/schemas';
import { cargoCollection, usuarioCollection } from '@delfrance/data/admin/collections';
import {
  AccessError,
  startAccessOperation,
  snapshotVersion,
  actorCeiling,
  getAccessOperation,
  retryAccessOperation,
  provisionAccessUser,
  withAccessAuth,
} from '@delfrance/data/admin/cargo-claims';
import { getAdminAuth, getAdminFirestore } from './firebase/admin';
import { accessCaller, accessResponse } from './auth/access';

const mutationSchema = z.object({
  operationId: accessIdSchema,
  expectedVersion: z.string().nullable(),
  cargo: cargoSchema.nullable().default(null),
  usuario: usuarioSchema.nullable().default(null),
});
export function readEditor(req: Request, id: string, cargo: boolean) {
  return accessResponse(async () => {
    accessIdSchema.parse(id);
    const caller = await accessCaller(req);
    if ((caller.bits & PERM.configuracoes.read) === 0n)
      throw new AccessError(403, 'READ_PERMISSION', 'Sem permissão para consultar configurações.');
    const collection = cargo ? cargoCollection : usuarioCollection;
    const snap = await collection.docRef(getAdminFirestore(), {}, id).get();
    if (!snap.exists) throw new AccessError(404, 'NOT_FOUND', 'Registro não encontrado.');
    return NextResponse.json({
      value: cargo
        ? cargoEditorReadSchema.parse(snap.data())
        : usuarioEditorReadSchema.parse(snap.data()),
      version: snapshotVersion(snap),
    });
  });
}
export function mutateEditor(req: Request, action: AccessCommand['action'], id?: string) {
  return accessResponse(async () => {
    const caller = await accessCaller(req);
    const body = mutationSchema.parse(await req.json());
    const targetId = accessIdSchema.parse(id ?? body.operationId);
    const command = {
      action,
      targetId,
      expectedVersion: body.expectedVersion,
      cargo: body.cargo,
      usuario: body.usuario,
    };
    const op = await startAccessOperation(getAdminFirestore(), {
      id: body.operationId,
      actorId: caller.uid,
      tokenBits: caller.bits,
      command,
    });
    return NextResponse.json({ operationId: op.id, targetId }, { status: 202 });
  });
}
const createSchema = z.object({
  operationId: accessIdSchema,
  email: z.string().email().max(255),
  nome: z.string().min(1).max(255),
  senha: z.string().min(6).max(128),
  cargos: z.array(accessIdSchema).default([]),
  colaborador: z.boolean().default(false),
  isSuperUser: z.boolean().default(false),
});
export function createAccessUser(req: Request) {
  return accessResponse(async () => {
    const caller = await accessCaller(req);
    const body = createSchema.parse(await req.json());
    const uid =
      'access-' +
      createHash('sha256')
        .update(caller.uid + ':' + body.operationId)
        .digest('hex');
    const user = usuarioSchema.parse({ ...body, ativo: true });
    const op = await startAccessOperation(getAdminFirestore(), {
      id: body.operationId,
      actorId: caller.uid,
      tokenBits: caller.bits,
      command: {
        action: A.createUser,
        targetId: uid,
        expectedVersion: null,
        cargo: null,
        usuario: user,
      },
    });
    try {
      await provisionAccessUser(withAccessAuth(getAdminAuth(), FirebaseAuthError), op, body.senha);
    } catch (err) {
      if (err instanceof FirebaseAuthError)
        throw new AccessError(
          502,
          err.code,
          'A criação da conta não foi concluída. Acompanhe a operação.',
          op.id,
        );
      throw err;
    }
    return NextResponse.json({ uid, operationId: op.id, targetId: uid }, { status: 201 });
  });
}
export function readOperation(req: Request, id: string) {
  return accessResponse(async () => {
    accessIdSchema.parse(id);
    const caller = await accessCaller(req);
    const op = await getAccessOperation(getAdminFirestore(), id);
    // A self-demoted actor can still observe an already accepted operation.
    if (op.actorId !== caller.uid && (caller.bits & PERM.configuracoes.read) === 0n)
      throw new AccessError(403, 'READ_PERMISSION', 'Sem permissão para consultar esta operação.');
    return NextResponse.json(op);
  });
}
export function retryOperation(req: Request, id: string) {
  return accessResponse(async () => {
    accessIdSchema.parse(id);
    const caller = await accessCaller(req);
    await retryAccessOperation(getAdminFirestore(), id, caller.uid, caller.bits);
    return NextResponse.json(
      {
        operationId: id,
        targetId: (await getAccessOperation(getAdminFirestore(), id)).command.targetId,
      },
      { status: 202 },
    );
  });
}
export function refreshAccessUser(req: Request, uid: string) {
  return accessResponse(async () => {
    const caller = await accessCaller(req);
    const { operationId } = z.object({ operationId: accessIdSchema }).parse(await req.json());
    accessIdSchema.parse(uid);
    const db = getAdminFirestore();
    await actorCeiling(db, caller.uid, caller.bits);
    const snap = await usuarioCollection.docRef(db, {}, uid).get();
    if (!snap.exists) throw new AccessError(404, 'NOT_FOUND', 'Usuário não encontrado.');
    const op = await startAccessOperation(db, {
      id: operationId,
      actorId: caller.uid,
      tokenBits: caller.bits,
      command: {
        action: A.refreshUser,
        targetId: uid,
        expectedVersion: snapshotVersion(snap),
        cargo: null,
        usuario: null,
      },
    });
    return NextResponse.json({ uid, operationId: op.id, targetId: uid }, { status: 202 });
  });
}
