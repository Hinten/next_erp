/**
 * Firestore-backed {@link TestUserStore} over the admin-only
 * `integracao/{integracaoId}/usuariosTeste` subcollection.
 *
 * Split from `testUsers.ts` for the same reason `tokenStore.ts` is split from
 * `mercadoLivre.ts`: the orchestration's ordering rules are the part worth
 * testing offline, and they should not drag a Firestore dependency along.
 *
 * ⚠️ Doc id is the ROLE, never an auto-id. That is what makes a re-run after a
 * partial failure reuse the seller instead of minting a second one — ML caps the
 * account at ten test users and never shows a password twice.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { usuariosTesteCollection } from '@delfrance/data/admin/collections';
import type { UsuarioTesteMercadoLivre, UsuarioTesteRole } from '@delfrance/schemas';

import { ROLES_A_CRIAR } from './testUsers';
import type { TestUserStore } from './testUsers';

export function createTestUserStore(db: Firestore, integracaoId: string): TestUserStore {
  const ctx = { integracaoId };

  return {
    async get(role: UsuarioTesteRole): Promise<UsuarioTesteMercadoLivre | null> {
      const snap = await usuariosTesteCollection.docRef(db, ctx, role).get();
      if (!snap.exists) return null;
      return usuariosTesteCollection.parseRead(
        snap.data(),
        usuariosTesteCollection.docPath(ctx, role),
      );
    },

    async put(record: UsuarioTesteMercadoLivre): Promise<void> {
      // `set`, not `merge`: the record is written once, whole, and a merge mask
      // would let a half-written earlier attempt survive underneath it.
      await usuariosTesteCollection
        .docRef(db, ctx, record.role)
        .set(usuariosTesteCollection.parse(record));
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
