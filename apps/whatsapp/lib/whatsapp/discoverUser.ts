/**
 * Contact resolution for the WhatsApp inbound pipeline — port of
 * `.old/packages/canais_de_venda/whatsapp_cloud_api/lib/src/utils/discover_user.dart`
 * and `.../fix_conversa_anonima.dart`. Given an inbound sender's `wa_id` (and,
 * when the webhook carried it, their WhatsApp profile name) it finds-or-creates
 * the `usuarios` doc (and, on the create path, a paired `clientes` doc) the
 * conversa/mensagem will hang off.
 *
 * Idempotency: the audit flagged legacy's check-then-act (a plain
 * `first()`-then-`create()`) as racy — two webhook redeliveries could both miss
 * and both create. This port closes that by (a) keying the sem-auth `usuarios`
 * doc on the deterministic `externalId` hash as its document id and creating it
 * with `.create()` + an ALREADY_EXISTS re-lookup (mirroring
 * `apps/mercado-livre/lib/marketplace/import.ts`), and (b) only creating the
 * paired cliente when THIS call actually minted the usuario, so a concurrent
 * loser never doubles the cliente.
 *
 * Collection note: the sem-auth contact is stored in `usuarios` (this repo's
 * collection) — legacy used `user`. The lookup is by the `externalId` FIELD
 * (identical hash in both apps), so a doc created by either side is found by the
 * other regardless of the doc-id/collection difference.
 */
import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { clienteCollection, usuarioCollection } from '@delfrance/data/admin/collections';
import { telefoneQueryShapes } from '@delfrance/core/phone';
import { idFromRef, type Cliente, type Conversa, type Usuario } from '@delfrance/schemas';

import { WHATSAPP_CANAL, externalId } from './ids';

/** A resolved WhatsApp contact: the `usuarios` doc id plus its parsed data. */
export interface DiscoveredUsuario {
  /** `usuarios/<id>` document id. */
  readonly id: string;
  readonly usuario: Usuario;
}

/**
 * `documents/usuarios/<id>` — the wire format for a usuario outer reference,
 * matching the legacy Flutter `OuterRefField.toJson` (`pathWithDocuments`) shape
 * `documents/<col>/<id>`, applied to this repo's `usuarios` collection. This is
 * the format written to `clientes/<id>.userCliente` here and the format the
 * downstream conversa builder (#527 D2) must use for `usarioOuterRef`.
 */
export function usuarioOuterRef(usuarioId: string): string {
  return `documents/usuarios/${usuarioId}`;
}

/** gRPC ALREADY_EXISTS (code 6) from `docRef.create()` on a doc that now exists. */
function isAlreadyExists(err: unknown): boolean {
  return err instanceof Error && (err as { code?: unknown }).code === 6;
}

/**
 * Legacy placeholder-name test (discover_user.dart / fix_conversa_anonima.dart):
 * empty, `"anônimo"` or `"anonimo"` (case-insensitive) is a placeholder that a
 * real profile name should overwrite.
 */
function isPlaceholderName(name: string | null | undefined): boolean {
  if (name == null) return true;
  const lower = name.toLowerCase();
  return name === '' || lower === 'anônimo' || lower === 'anonimo';
}

/**
 * A non-empty name or the `'Anônimo'` fallback. The legacy Usuario model
 * tolerates an empty `nome`; this repo's `usuarioSchema` requires `min(1)`, so a
 * `''` (or null) name must collapse to the placeholder rather than crash the
 * write.
 */
function nameOrPlaceholder(name: string | null | undefined): string {
  return name != null && name !== '' ? name : 'Anônimo';
}

/** Find a `usuarios` doc by its `externalId` field. Null when none. */
async function findUsuarioByExternalId(
  db: Firestore,
  extId: string,
): Promise<DiscoveredUsuario | null> {
  const snap = await usuarioCollection.ref(db, {}).where('externalId', '==', extId).limit(1).get();
  const doc = snap.docs[0];
  if (!doc) return null;
  return {
    id: doc.id,
    usuario: usuarioCollection.parseRead(doc.data(), usuarioCollection.docPath({}, doc.id)),
  };
}

/**
 * `getOrCreateUsuarioSemAuth` (models.dart) — find the sem-auth usuario by
 * `externalId`, else create it at the deterministic doc id. Returns `created:
 * true` only when THIS call minted the doc (used to gate the paired-cliente
 * write). The `.create()` + ALREADY_EXISTS re-lookup makes concurrent first
 * calls converge on one doc.
 */
async function getOrCreateUsuarioSemAuth(
  db: Firestore,
  from: string,
  nome: string,
): Promise<DiscoveredUsuario & { created: boolean }> {
  const extId = externalId(WHATSAPP_CANAL, from);

  const existing = await findUsuarioByExternalId(db, extId);
  if (existing) return { ...existing, created: false };

  // Deterministic doc id = the externalId hash: stable across redeliveries, so a
  // concurrent create collides on the same id (ALREADY_EXISTS) instead of
  // forking a second doc.
  const id = extId;
  const usuario = usuarioCollection.parse({
    nome: nameOrPlaceholder(nome),
    email: null,
    externalId: extId,
  });
  try {
    await usuarioCollection.docRef(db, {}, id).create(usuario as DocumentData);
    return { id, usuario, created: true };
  } catch (err) {
    if (isAlreadyExists(err)) {
      const again = await findUsuarioByExternalId(db, extId);
      if (again) return { ...again, created: false };
    }
    throw err;
  }
}

/** Create the paired `clientes` doc for a freshly-minted sem-auth usuario. */
async function createClienteForUser(
  db: Firestore,
  usuarioId: string,
  nome: string | null,
  telefone: string,
): Promise<void> {
  await clienteCollection.add(
    db,
    {},
    {
      nome: nome != null && nome !== '' ? nome : null,
      telefone,
      userCliente: usuarioOuterRef(usuarioId),
    },
  );
}

/**
 * Resolve (or create) the WhatsApp sender's `usuarios` doc.
 *
 * Ports discover_user.dart exactly:
 *  (a) usuario by `externalId == externalId('whatsapp', from)` → on hit, rename a
 *      placeholder `nome` to the profile `name` when one was provided;
 *  (b) else clientes whose `telefone` is in `telefoneQueryShapes(from)`;
 *  (c) no clientes → create the sem-auth usuario + a paired cliente;
 *  (d) clientes found → sort by doc id asc; the first that already has a
 *      `userCliente` wins (return that usuario); otherwise create a sem-auth
 *      usuario and link it onto the first cliente.
 *
 * @param attempt internal retry counter for the ALREADY_EXISTS race (bounded to 1).
 */
export async function discoverUserByPhoneNumber(
  db: Firestore,
  from: string,
  name?: string | null,
  attempt = 0,
): Promise<DiscoveredUsuario> {
  const extId = externalId(WHATSAPP_CANAL, from);

  // (a) existing sem-auth usuario by externalId.
  const found = await findUsuarioByExternalId(db, extId);
  if (found) {
    if (name != null && name !== '' && isPlaceholderName(found.usuario.nome)) {
      await usuarioCollection.merge(db, {}, found.id, { nome: name });
      return { id: found.id, usuario: { ...found.usuario, nome: name } };
    }
    return found;
  }

  // (b) clientes by phone. `telefoneQueryShapes` yields the normalized + raw BR
  // shapes a `telefone` may be stored under (empty → no query).
  const shapes = telefoneQueryShapes(from);
  const clientes: Array<{ id: string; data: Cliente }> = [];
  if (shapes.length > 0) {
    const snap = await clienteCollection.ref(db, {}).where('telefone', 'in', shapes).get();
    for (const d of snap.docs) {
      clientes.push({
        id: d.id,
        data: clienteCollection.parseRead(d.data(), clienteCollection.docPath({}, d.id)),
      });
    }
  }

  // (c) no clientes → create both. Only mint the cliente when this call actually
  // created the usuario (a concurrent loser skips it → exactly one cliente).
  if (clientes.length === 0) {
    const created = await getOrCreateUsuarioSemAuth(db, from, nameOrPlaceholder(name));
    if (created.created) {
      await createClienteForUser(db, created.id, name ?? null, from);
    }
    return { id: created.id, usuario: created.usuario };
  }

  // (d) clientes found → deterministic order by doc id asc.
  clientes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const c of clientes) {
    const ref = c.data.userCliente;
    if (ref != null && ref !== '') {
      const userId = idFromRef(ref);
      const snap = await usuarioCollection.docRef(db, {}, userId).get();
      if (snap.exists) {
        return {
          id: userId,
          usuario: usuarioCollection.parseRead(snap.data(), usuarioCollection.docPath({}, userId)),
        };
      }
      // A dangling userCliente (target usuario gone) — fall through to the next
      // cliente, then to the create+link path, rather than returning a ghost.
    }
  }

  // No cliente carried a live userCliente → mint the sem-auth usuario and link
  // it onto the first cliente (legacy `clienteTarget.copyWith(usuario:).save()`).
  const target = clientes[0];
  if (!target) {
    // Unreachable (clientes.length > 0 checked above); re-run defensively.
    if (attempt < 1) return discoverUserByPhoneNumber(db, from, name, attempt + 1);
    throw new Error('discoverUserByPhoneNumber: cliente list vanished mid-resolution');
  }
  const created = await getOrCreateUsuarioSemAuth(
    db,
    from,
    nameOrPlaceholder(target.data.nome ?? name),
  );
  await clienteCollection.merge(db, {}, target.id, {
    userCliente: usuarioOuterRef(created.id),
  });
  return { id: created.id, usuario: created.usuario };
}

/**
 * `fixConversaAnonima` (fix_conversa_anonima.dart) — once a real user is known,
 * upgrade a still-anonymous conversa `nome` (and the matching cliente `nome`) to
 * the user's name. Best-effort: the caller wraps it so a failure never blocks
 * message ingestion (legacy caught + logged the same way).
 *
 * The paired cliente is found by `userCliente == usuarioOuterRef(user.id)`
 * (legacy `Cliente.documents.userCliente__isEqualTo(user)`), so this needs the
 * resolved user's id, not the conversa id.
 *
 * @param conversaId the `chat/<id>` document id of `conversa`.
 */
export async function fixConversaAnonima(
  db: Firestore,
  conversaId: string,
  conversa: Pick<Conversa, 'nome'>,
  user: DiscoveredUsuario,
): Promise<void> {
  if (!isPlaceholderName(conversa.nome)) return;

  const nome = user.usuario.nome;

  // The downstream conversa builder writes through `conversaCollection`; here we
  // only patch the two `nome` fields, so a lazy import of the handle keeps this
  // module's dependency surface small.
  const { conversaCollection } = await import('@delfrance/data/admin/collections');
  await conversaCollection.merge(db, {}, conversaId, { nome });

  const snap = await clienteCollection
    .ref(db, {})
    .where('userCliente', '==', usuarioOuterRef(user.id))
    .limit(1)
    .get();
  const doc = snap.docs[0];
  if (!doc) return;
  const cliente = clienteCollection.parseRead(doc.data(), clienteCollection.docPath({}, doc.id));
  if (isPlaceholderName(cliente.nome)) {
    await clienteCollection.merge(db, {}, doc.id, { nome });
  }
}
