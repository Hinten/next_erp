'use client';

import { useQuery } from '@tanstack/react-query';
import { Text, Tooltip } from '@mantine/core';
import { getDoc } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import { usePermission } from '@/lib/auth';
import { usuarioCollection } from '@/lib/data/usuarioCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

/**
 * Renders the actor of a server-owned audit row.
 *
 * The stored value is an outer-ref (`documents/usuarios/<uid>`) with THREE
 * meaningful states, and collapsing any two of them would lie about the trail:
 *
 *  - a ref      → the resolved person's name.
 *  - `null`     → the trigger looked and found no end user (an Admin-SDK write:
 *                 a marketplace import, a webhook, the estoque sync's own
 *                 write-back, a script). "Sistema".
 *  - `undefined`→ the row predates the field entirely. "—", never "Sistema".
 *
 * ⚠️ Reading `usuarios` requires `PERM.configuracoes.read`, which a plain
 * operator may not hold. Without it this renders the short uid and issues NO
 * read at all — a 50-row feed must not fire 50 permission-denied gets, nor
 * repeat a "sem permissão" sentence on every line.
 */

/** `documents/usuarios/<uid>` → `<uid>`; null for anything else. */
export function uidFromUsuarioRef(ref: string | null | undefined): string | null {
  if (typeof ref !== 'string') return null;
  const parts = ref.split('/');
  return parts.length >= 2 && parts[parts.length - 2] === 'usuarios'
    ? (parts[parts.length - 1] ?? null)
    : null;
}

/**
 * Resolve many uids in ONE cached wave rather than one query per row.
 *
 * Keyed on the sorted uid list so paging in more rows refetches only when the
 * set actually changes, and `staleTime` keeps a tab switch free — a `usuarios`
 * doc cannot change while the feed is open in any way the feed cares about.
 * Same reasoning as the checkout tab's produto resolution.
 */
export function useUsuarioNomes(uids: ReadonlyArray<string>): Record<string, string> {
  const podeLer = usePermission(PERM.configuracoes.read);
  const distinct = [...new Set(uids)].sort();

  const { data } = useQuery({
    queryKey: ['usuarioNomes', distinct],
    enabled: podeLer && distinct.length > 0,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<Record<string, string>> => {
      const db = getFirebaseFirestore();
      const entries = await Promise.all(
        distinct.map(async (uid) => {
          const snap = await getDoc(usuarioCollection.docRef(db, {}, uid));
          const nome = snap.data()?.nome;
          return [uid, typeof nome === 'string' && nome.trim() !== '' ? nome : uid] as const;
        }),
      );
      return Object.fromEntries(entries);
    },
  });

  return data ?? {};
}

export interface UsuarioNomeProps {
  /** The stored `usuarioOuterRef`: a ref, `null`, or absent. */
  outerRef: string | null | undefined;
  /** Resolved uid → nome, from {@link useUsuarioNomes}. */
  nomes: Record<string, string>;
}

export function UsuarioNome({ outerRef, nomes }: UsuarioNomeProps) {
  if (outerRef === undefined) {
    return (
      <Tooltip label="Registro anterior à gravação do autor.">
        <Text component="span" size="xs" c="dimmed">
          —
        </Text>
      </Tooltip>
    );
  }
  if (outerRef === null) {
    return (
      <Tooltip label="Automação: importação de marketplace, webhook ou rotina do servidor.">
        <Text component="span" size="xs" c="dimmed">
          Sistema
        </Text>
      </Tooltip>
    );
  }

  const uid = uidFromUsuarioRef(outerRef);
  if (uid === null) {
    return (
      <Text component="span" size="xs" c="dimmed">
        —
      </Text>
    );
  }
  // Falls back to the uid while the wave is in flight, and permanently when the
  // reader lacks `configuracoes` read.
  return (
    <Tooltip label={uid}>
      <Text component="span" size="xs">
        {nomes[uid] ?? `Usuário ${uid.slice(0, 8)}`}
      </Text>
    </Tooltip>
  );
}
