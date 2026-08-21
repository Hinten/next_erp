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
 * `apps/mercado-livre/lib/marketplace/importacao/import.ts`), and (b) only creating the
 * paired cliente when THIS call actually minted the usuario, so a concurrent
 * loser never doubles the cliente.
 *
 * Collection note: the sem-auth contact is stored in `usuarios` (this repo's
 * collection) — legacy used `user`. The lookup is by the `externalId` FIELD
 * (identical to the legacy hash), so a migrated contact is found rather than
 * duplicated, regardless of the doc-id/collection difference.
 */
import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { clienteCollection, usuarioCollection } from '@delfrance/data/admin/collections';
import { telefoneQueryShapes } from '@delfrance/core/phone';
import {
  idFromRef,
  sanitizeTelefone,
  type Cliente,
  type Conversa,
  type Usuario,
} from '@delfrance/schemas';

import { WHATSAPP_CANAL, externalId } from './ids';

/** A resolved WhatsApp contact: the `usuarios` doc id plus its parsed data. */
export interface DiscoveredUsuario {
  /** `usuarios/<id>` document id. */
  readonly id: string;
  readonly usuario: Usuario;
}

/**
 * What `discoverUserByPhoneNumber` hands back: the usuario, plus the `clientes`
 * doc behind it.
 *
 * The cliente was always resolved here — every branch below either finds, links
 * or mints one — it just was not returned, so the conversa builder had nothing
 * to point `clienteOuterRef` at and wrote only `usarioOuterRef`. That left the
 * inbox's Cliente filter unable to match a WhatsApp thread and an ML thread with
 * the same field (#1159).
 *
 * `clienteId` is `null` only when the cliente genuinely cannot be determined —
 * a usuario whose `userCliente` link is dangling or absent. Callers must treat
 * that as "unknown", never as "no cliente".
 */
export interface DiscoveredContato extends DiscoveredUsuario {
  /** `clientes/<id>` document id, or null when it could not be resolved. */
  readonly clienteId: string | null;
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

/** `documents/clientes/<id>` — the same wire format, for `conversa.clienteOuterRef`. */
export function clienteOuterRef(clienteId: string): string {
  return `documents/clientes/${clienteId}`;
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
 * The `cliente.userCliente` values that point at `usuarios/<id>`.
 *
 * ⚠️ BOTH shapes have to be tried. `usuarioOuterRef()` writes the
 * `documents/`-prefixed form, but the migrated corpus carries bare
 * `usuarios/<id>` too, and Firestore cannot normalize a stored value inside a
 * `where` — so a single-shape lookup silently misses half the population. Same
 * disjunction `clienteUserRefCandidates` uses on the web side.
 */
function userClienteCandidates(usuarioId: string): string[] {
  return [`documents/usuarios/${usuarioId}`, `usuarios/${usuarioId}`];
}

/**
 * The `clientes` doc linked to a usuario, or null when nothing points at it.
 *
 * Only branch (a) needs this — the other three already hold the cliente id from
 * the work they just did. Backed by the `clientes(userCliente ASC)` index that
 * already exists; on Enterprise an unindexed read would silently full-scan
 * (root `CLAUDE.md` rule 1), so do not widen this query without checking
 * `firestore.indexes.json`.
 *
 * `limit(2)`, not `limit(1)`: more than one cliente claiming the same usuario is
 * a real data defect and picking the arbitrary first would hide it. Reported and
 * resolved as unknown, so the conversa carries no `clienteOuterRef` rather than
 * a guessed one — the same refusal `claimCliente` makes for ML ids (#1067).
 */
async function findClienteIdByUsuario(db: Firestore, usuarioId: string): Promise<string | null> {
  const snap = await clienteCollection
    .ref(db, {})
    .where('userCliente', 'in', userClienteCandidates(usuarioId))
    .limit(2)
    .get();
  if (snap.docs.length > 1) {
    console.warn('[whatsapp] mais de um cliente aponta para o mesmo usuario', {
      usuarioId,
      clienteIds: snap.docs.map((d) => d.id),
    });
    return null;
  }
  return snap.docs[0]?.id ?? null;
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

/**
 * Create the paired `clientes` doc for a freshly-minted sem-auth usuario.
 *
 * `telefone` is the Cloud API `wa_id`, which already carries a country code, so
 * `sanitizeTelefone` is a no-op for every value Meta can send. It runs anyway:
 * this is the ONE cliente write in the repo that used to store a phone without
 * passing it through the shared normalizer, and "usually a no-op" is not a
 * property worth relying on when a one-call detour makes it a guarantee.
 */
async function createClienteForUser(
  db: Firestore,
  usuarioId: string,
  nome: string | null,
  telefone: string,
): Promise<string> {
  const ref = await clienteCollection.add(
    db,
    {},
    {
      nome: nome != null && nome !== '' ? nome : null,
      telefone: sanitizeTelefone(telefone),
      userCliente: usuarioOuterRef(usuarioId),
    },
  );
  return ref.id;
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
): Promise<DiscoveredContato> {
  const extId = externalId(WHATSAPP_CANAL, from);

  // (a) existing sem-auth usuario by externalId. The ONE branch that does no
  // cliente work of its own, so it is the one that has to look the link up.
  const found = await findUsuarioByExternalId(db, extId);
  if (found) {
    const clienteId = await findClienteIdByUsuario(db, found.id);
    if (name != null && name !== '' && isPlaceholderName(found.usuario.nome)) {
      await usuarioCollection.merge(db, {}, found.id, { nome: name });
      return { id: found.id, usuario: { ...found.usuario, nome: name }, clienteId };
    }
    return { ...found, clienteId };
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
    // The loser of a concurrent first call did NOT mint the cliente, so it has
    // to read the one the winner made rather than assume there is none.
    const clienteId = created.created
      ? await createClienteForUser(db, created.id, name ?? null, from)
      : await findClienteIdByUsuario(db, created.id);
    return { id: created.id, usuario: created.usuario, clienteId };
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
          // This IS the cliente that claimed the usuario — no lookup needed.
          clienteId: c.id,
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
  return { id: created.id, usuario: created.usuario, clienteId: target.id };
}

/**
 * `fixConversaAnonima` (fix_conversa_anonima.dart) — once a real user is known,
 * upgrade a still-anonymous conversa `nome` (and the matching cliente `nome`) to
 * the user's name. Best-effort: the caller wraps it so a failure never blocks
 * message ingestion (legacy caught + logged the same way).
 *
 * The paired cliente is resolved through `findClienteIdByUsuario`, so this needs
 * the resolved user's id, not the conversa id.
 *
 * ⚠️ It used to run its own `userCliente == usuarioOuterRef(user.id)` query
 * (legacy `Cliente.documents.userCliente__isEqualTo(user)`) — the single-shape
 * lookup the helper above exists to replace. A migrated contact whose cliente
 * stores the BARE `usuarios/<id>` form matched nothing, so the conversa `nome`
 * was upgraded and the cliente `nome` silently was not: exactly the population
 * the dual-shape candidates were added for. Reusing the helper also inherits its
 * ambiguity refusal — with two claimants this skips rather than renaming a
 * coin-flip cliente, which for a cosmetic best-effort upgrade is the right call.
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

  const clienteId = await findClienteIdByUsuario(db, user.id);
  if (clienteId == null) return;
  const doc = await clienteCollection.docRef(db, {}, clienteId).get();
  if (!doc.exists) return;
  const cliente = clienteCollection.parseRead(doc.data(), clienteCollection.docPath({}, clienteId));
  if (isPlaceholderName(cliente.nome)) {
    await clienteCollection.merge(db, {}, clienteId, { nome });
  }
}
