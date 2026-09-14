'use client';

import { useMemo } from 'react';
import { TextInput } from '@mantine/core';
import type { Firestore } from 'firebase/firestore';
import { useAuth } from '@/lib/auth/useAuth';
import { useUsuarioNomes } from '@/components/UsuarioNome';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';

export interface VendedorFieldProps {
  db: Firestore;
  /** The pedido's stored `vendedorPedidoOuterRef`, in any legacy ref shape. */
  outerRef: unknown;
}

/**
 * The pedido's seller, read-only.
 *
 * ⚠️ This used to render the CURRENT user's email regardless of the pedido —
 * so opening a colleague's pedido attributed it to whoever was looking, and a
 * plain create displayed an email it then saved as `null`. The value shown here
 * is now the stored `vendedorPedidoOuterRef` and nothing else; `PedidoForm`
 * seeds that field on create so the two agree.
 *
 * Three states, kept distinct:
 *  - a ref to YOU     → your email, resolved from the auth session.
 *  - a ref to someone → their `usuarios.nome`, or `Usuário <8 chars>`.
 *  - no ref           → "—". Every pedido created before the seed landed, and
 *                       every marketplace import (which has no ERP seller).
 */
export function VendedorField({ db, outerRef }: VendedorFieldProps) {
  const { user } = useAuth();
  // Legacy docs carry outer-refs as a string, an opaque `{ path }` or a real
  // DocumentReference, so go through the generic deref instead of splitting the
  // string ourselves.
  const uid = useMemo(() => dereferenceOuterRef(db, outerRef)?.id ?? null, [db, outerRef]);
  const ehProprio = uid !== null && uid === user?.uid;

  // ⚠️ Your OWN pedido — the overwhelmingly common case — is answered from the
  // auth session with NO Firestore read. Reading `usuarios` requires
  // PERM.configuracoes.read, which a plain operator does not hold, so a read on
  // this path would be denied for most of the people who open this screen.
  // Only a pedido someone else created pays for the lookup.
  const nomes = useUsuarioNomes(uid !== null && !ehProprio ? [uid] : []);

  const valor =
    uid === null
      ? '—'
      : ehProprio
        ? (user?.email ?? uid)
        : (nomes[uid] ?? `Usuário ${uid.slice(0, 8)}`);

  return <TextInput label="Vendedor" value={valor} readOnly disabled />;
}
