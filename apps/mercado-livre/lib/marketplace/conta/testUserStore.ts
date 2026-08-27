/**
 * Firestore-backed {@link TestUserStore} over the admin-only
 * `integracao/{integracaoId}/usuariosTeste` subcollection.
 *
 * Split from `testUsers.ts` for the same reason `tokenStore.ts` is split from
 * `mercadoLivre.ts`: the orchestration's ordering rules are the part worth
 * testing offline, and they should not drag a Firestore dependency along.
 *
 * ⚠️ **Never an auto-id.** The pair bootstrap keys on the ROLE, which is what
 * makes a re-run after a partial failure reuse the seller instead of minting a
 * second one; an ADDITIONAL mint keys on `${role}-${mlUserId}` (`docIdAdicional`),
 * which is unique by construction and therefore cannot land on top of the pair.
 * ML caps the account at ten test users and never shows a password twice, so a
 * generated id — which nothing could look up again — would be the worst of both.
 *
 * ⚠️ And the two writes differ on purpose. `create` refuses any existing
 * document; `put` is idempotent for the SAME ML account (re-writing identical
 * content is what makes a partial pair re-run safe) and refuses a DIFFERENT one.
 * Neither can replace a stored credential, which is the whole point — ML will
 * not reissue one.
 *
 * ⚠️ `put` was a bare `set`, safe only by argument: it is reached only after
 * `reutilizavel` read the role as absent. That argument is one refactor away
 * from being false, and the thing it protects cannot be restored, so the check
 * now lives IN the write. It reads inside the transaction and compares against
 * the `tx.get` snapshot rather than a value read outside it — root `CLAUDE.md`
 * rule 7, class A: the decision is re-derived from the document the write lands
 * on, so an OCC retry re-runs it.
 */
import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { isAlreadyExists } from '@delfrance/data/admin';
import { usuariosTesteCollection } from '@delfrance/data/admin/collections';
import type { UsuarioTesteMercadoLivre, UsuarioTesteRole } from '@delfrance/schemas';

import { ROLES_A_CRIAR, TestUserGuardError } from './testUsers';
import type { TestUserStore, UsuarioTesteRegistrado } from './testUsers';

export function createTestUserStore(db: Firestore, integracaoId: string): TestUserStore {
  const ctx = { integracaoId };

  return {
    async put(record: UsuarioTesteMercadoLivre): Promise<void> {
      const ref = usuariosTesteCollection.docRef(db, ctx, record.role);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists) {
          // ⚠️ Re-derived from the snapshot this write lands on, never from a
          // read taken before the transaction opened.
          const guardado = usuariosTesteCollection.parseRead(
            snap.data(),
            usuariosTesteCollection.docPath(ctx, record.role),
          );
          // `parseRead` is soft — an unparseable document comes back raw rather
          // than throwing, so `id` may be absent. That still fails this test,
          // which is the safe direction: a document we cannot read is a document
          // we must not replace.
          if (guardado.id !== record.id) {
            throw new TestUserGuardError(
              'ML_USUARIO_TESTE_DUPLICADO',
              409,
              `O documento ${record.role} já guarda outro usuário de teste do Mercado Livre. ` +
                'Nada foi sobrescrito — a senha guardada continua intacta, e o Mercado Livre ' +
                'não reemite nenhuma.',
              { docId: record.role },
            );
          }
        }
        // `set`, not `merge`: the record is written once, whole, and a merge mask
        // would let a half-written earlier attempt survive underneath it.
        tx.set(ref, usuariosTesteCollection.parse(record) as DocumentData);
      });
    },

    async create(docId: string, record: UsuarioTesteMercadoLivre): Promise<void> {
      try {
        // `create`, not `set`: on a doc that already exists this throws
        // ALREADY_EXISTS instead of replacing an unrecoverable password.
        await usuariosTesteCollection
          .docRef(db, ctx, docId)
          .create(usuariosTesteCollection.parse(record));
      } catch (err) {
        // Narrowed to the ONE expected failure (root `CLAUDE.md` rule 6); every
        // other Firestore error still surfaces as a 500, which is what it is.
        if (!isAlreadyExists(err)) throw err;
        throw new TestUserGuardError(
          'ML_USUARIO_TESTE_DUPLICADO',
          409,
          `Já existe um usuário de teste registrado em ${docId}. Nada foi sobrescrito — ` +
            'a senha guardada continua intacta, e o Mercado Livre não reemite nenhuma.',
          { docId },
        );
      }
    },

    async list(): Promise<UsuarioTesteRegistrado[]> {
      const snap = await usuariosTesteCollection.ref(db, ctx).get();
      // ⚠️ Keyed on the DOC ID, not the role: `comprador` and every
      // `comprador-<mlUserId>` carry the same `role`, so a role-keyed map would
      // collapse every additional mint into one entry — the panel would then
      // show a buyer count that never grows, which is indistinguishable from an
      // overwrite. Each record carries its doc id out for the same reason.
      const porDocId = new Map<string, UsuarioTesteRegistrado>();
      for (const doc of snap.docs) {
        porDocId.set(doc.id, {
          ...usuariosTesteCollection.parseRead(
            doc.data(),
            usuariosTesteCollection.docPath(ctx, doc.id),
          ),
          docId: doc.id,
        });
      }
      // Seller first, then buyer, then anything else Firestore returned — the
      // order the UI reads in, independent of doc-id sort.
      const ordered = ROLES_A_CRIAR.map((role) => porDocId.get(role)).filter(
        (r): r is UsuarioTesteRegistrado => r != null,
      );
      for (const [id, record] of porDocId) {
        if (!ROLES_A_CRIAR.includes(id as UsuarioTesteRole)) ordered.push(record);
      }
      return ordered;
    },
  };
}
