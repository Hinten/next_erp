/**
 * Buyer→usuario resolution for the Mercado Livre claims import (Step 14) —
 * port of the `cliente.userCliente` flow in `getClaimMercadoLivre`
 * (`.old/packages/canais_de_venda/mercado_livre/lib/src/tasks.dart:1861-1878`)
 * on top of `Usuario.getOrCreateUsuarioSemAuth` + `generateExternalId`
 * (`.old/packages/user/lib/src/models.dart:100-104,214-259`).
 *
 * Identity: the sem-auth buyer contact is keyed by the `externalId` FIELD,
 * `sha256('<canalDeVendas>-<mlUserId>')` where `canalDeVendas` is the conta
 * doc's `pathWithDocuments` WITH its leading slash
 * (`/documents/integracao/<contaId>`) — byte-identical in both apps, so a doc
 * created by either side is found by the other. Legacy's DOC-ID formula
 * (models.dart:220, hashing `externalId + nome + apelido`, interpolating a null
 * apelido as the literal string `"null"`) is DELIBERATELY not ported: neither
 * app ever locates the doc by id — only by the `externalId` field — so this
 * port keys the doc on the externalId hash itself, which also turns legacy's
 * racy find-then-create into `.create()` + an ALREADY_EXISTS re-lookup
 * (mirroring `apps/whatsapp/lib/whatsapp/discoverUser.ts`).
 *
 * Refresh-on-hit parity (models.dart:242-255): a found usuario gets `nome`
 * updated when the cliente carries a different non-empty name (legacy would
 * also overwrite with the `'Anônimo'` placeholder; this port never downgrades
 * a real name to it), and `apelido` when the buyer nickname is non-null and
 * differs. The cliente is then linked (`userCliente`) when unset or stale —
 * legacy's transactional `clienteTransaction.setUsuario` (tasks.dart:1866-1877).
 */
import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { clienteCollection, usuarioCollection } from '@delfrance/data/admin/collections';
import { isAlreadyExists } from '@delfrance/data/admin';
import { idFromRef, type Usuario } from '@delfrance/schemas';

import { usuarioExternalIdMl } from './claimIds';

/** The pedido's `clientePedidoOuterRef` resolved to a missing cliente doc. */
export class ClaimClienteNotFoundError extends Error {
  constructor(readonly clienteOuterRef: string) {
    super(`Cliente ${clienteOuterRef} não encontrado`);
    this.name = 'ClaimClienteNotFoundError';
  }
}

export interface ResolveClaimUsuarioArgs {
  /** The `integracao` account doc id (the ML conta). */
  readonly contaId: string;
  /** The pedido's cliente as an outer-ref string (`documents/clientes/<id>`). */
  readonly clienteOuterRef: string;
  /** The buyer player's ML user id (`Claims.getClientId`). */
  readonly buyerUserId: number;
  /** The buyer's site nickname, when the payload carried one. */
  readonly buyerNickname: string | null;
}

/**
 * `Usuario.generateExternalId(conta.docId.path, buyerUserId)` (models.dart:100)
 * — `sha256('<canal>-<id>')` with the conta path WITH its leading slash,
 * delegated to `claimIds.ts` (`usuarioExternalIdMl`) so the formula lives in
 * ONE place. Golden vector (pinned in the test):
 * `claimUsuarioExternalId('conta_abc123', 301110805)` =
 * `92ba54c7fac91eaa2221b4f07a155f846bf42642e9e16daa4eb9964a6d501014`.
 */
export function claimUsuarioExternalId(contaId: string, buyerUserId: number): string {
  return usuarioExternalIdMl(contaId, buyerUserId);
}

/** `documents/usuarios/<id>` — the wire format written to `clientes/<id>.userCliente`. */
function usuarioOuterRef(usuarioId: string): string {
  return `documents/usuarios/${usuarioId}`;
}

/** Find a `usuarios` doc by its `externalId` field. Null when none. */
async function findUsuarioByExternalId(
  db: Firestore,
  extId: string,
): Promise<{ id: string; usuario: Usuario } | null> {
  const snap = await usuarioCollection.ref(db, {}).where('externalId', '==', extId).limit(1).get();
  const doc = snap.docs[0];
  if (!doc) return null;
  return {
    id: doc.id,
    usuario: usuarioCollection.parseRead(doc.data(), usuarioCollection.docPath({}, doc.id)),
  };
}

/**
 * `getOrCreateUsuarioSemAuth` (models.dart:229-259) — find the sem-auth buyer
 * usuario by `externalId`, refreshing `nome`/`apelido` on a hit; else create it
 * at the deterministic externalId doc id (`.create()` + ALREADY_EXISTS
 * re-lookup so concurrent redeliveries converge on one doc).
 */
async function getOrCreateUsuario(
  db: Firestore,
  extId: string,
  clienteNome: string | null,
  buyerNickname: string | null,
): Promise<string> {
  const found = await findUsuarioByExternalId(db, extId);
  if (found) {
    const patch: Record<string, unknown> = {};
    if (clienteNome != null && clienteNome !== '' && clienteNome !== found.usuario.nome) {
      patch.nome = clienteNome;
    }
    if (buyerNickname != null && buyerNickname !== found.usuario.apelido) {
      patch.apelido = buyerNickname;
    }
    if (Object.keys(patch).length > 0) {
      await usuarioCollection.merge(db, {}, found.id, patch);
    }
    return found.id;
  }

  const usuario = usuarioCollection.parse({
    nome: clienteNome != null && clienteNome !== '' ? clienteNome : 'Anônimo',
    apelido: buyerNickname,
    colaborador: false,
    externalId: extId,
    email: null,
  });
  try {
    await usuarioCollection.docRef(db, {}, extId).create(usuario as DocumentData);
    return extId;
  } catch (err) {
    if (isAlreadyExists(err)) {
      // A concurrent redelivery won the create — converge on its doc.
      const again = await findUsuarioByExternalId(db, extId);
      if (again) return again.id;
    }
    throw err;
  }
}

/**
 * Resolve (or create) the claim buyer's `usuarios` doc from the pedido's
 * cliente (tasks.dart:1861-1878):
 *
 *  (a) `cliente.userCliente` pointing at a LIVE usuario wins (verified with a
 *      get, as legacy's `.reference.get()` did) — no writes;
 *  (b) else find-or-create by `externalId == claimUsuarioExternalId(...)`,
 *      refreshing `nome`/`apelido` on a hit;
 *  (c) finally link `cliente.userCliente` when unset or stale (covers a
 *      dangling ref whose target usuario is gone).
 */
export async function resolveClaimUsuario(
  db: Firestore,
  args: ResolveClaimUsuarioArgs,
): Promise<{ usuarioId: string }> {
  const clienteId = idFromRef(args.clienteOuterRef);
  const clienteSnap = await clienteCollection.docRef(db, {}, clienteId).get();
  if (!clienteSnap.exists) throw new ClaimClienteNotFoundError(args.clienteOuterRef);
  const cliente = clienteCollection.parseRead(
    clienteSnap.data(),
    clienteCollection.docPath({}, clienteId),
  );

  // (a) live userCliente link — return it untouched. A dangling ref (target
  // usuario deleted) falls through to find-or-create + re-link instead of
  // returning a ghost.
  const linked = cliente.userCliente;
  if (linked != null && linked !== '') {
    const linkedId = idFromRef(linked);
    const snap = await usuarioCollection.docRef(db, {}, linkedId).get();
    if (snap.exists) return { usuarioId: linkedId };
  }

  // (b) find-or-create the sem-auth buyer usuario.
  const extId = claimUsuarioExternalId(args.contaId, args.buyerUserId);
  const usuarioId = await getOrCreateUsuario(db, extId, cliente.nome, args.buyerNickname);

  // (c) link the cliente (legacy `clienteTransaction.setUsuario` + save).
  const desired = usuarioOuterRef(usuarioId);
  if (cliente.userCliente !== desired) {
    await clienteCollection.merge(db, {}, clienteId, { userCliente: desired });
  }
  return { usuarioId };
}
