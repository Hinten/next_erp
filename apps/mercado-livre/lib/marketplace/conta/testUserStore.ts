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
 * ⚠️ And the two writes differ on purpose: `put` overwrites (it only ever runs
 * on a role the caller just read as absent), `create` refuses. The refusal is
 * the point — an additional mint that landed on an existing document would
 * destroy a credential ML will not reissue.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { isAlreadyExists } from '@delfrance/data/admin';
import { usuariosTesteCollection } from '@delfrance/data/admin/collections';
import type { UsuarioTesteMercadoLivre, UsuarioTesteRole } from '@delfrance/schemas';

import { ROLES_A_CRIAR, TestUserGuardError } from './testUsers';
import type { TestUserStore } from './testUsers';

export function createTestUserStore(db: Firestore, integracaoId: string): TestUserStore {
  const ctx = { integracaoId };

  return {
    async put(record: UsuarioTesteMercadoLivre): Promise<void> {
      // `set`, not `merge`: the record is written once, whole, and a merge mask
      // would let a half-written earlier attempt survive underneath it.
      await usuariosTesteCollection
        .docRef(db, ctx, record.role)
        .set(usuariosTesteCollection.parse(record));
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

    async list(): Promise<UsuarioTesteMercadoLivre[]> {
      const snap = await usuariosTesteCollection.ref(db, ctx).get();
      const byRole = new Map<string, UsuarioTesteMercadoLivre>();
      for (const doc of snap.docs) {
        byRole.set(
          doc.id,
          usuariosTesteCollection.parseRead(
            doc.data(),
            usuariosTesteCollection.docPath(ctx, doc.id),
          ),
        );
      }
      // Seller first, then buyer, then anything else Firestore returned — the
      // order the UI reads in, independent of doc-id sort.
      const ordered = ROLES_A_CRIAR.map((role) => byRole.get(role)).filter(
        (r): r is UsuarioTesteMercadoLivre => r != null,
      );
      for (const [id, record] of byRole) {
        if (!ROLES_A_CRIAR.includes(id as UsuarioTesteRole)) ordered.push(record);
      }
      return ordered;
    },
  };
}
