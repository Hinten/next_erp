'use client';

import { Fragment, useMemo } from 'react';
import { Text, type TextProps } from '@mantine/core';
import type { Firestore } from 'firebase/firestore';
import type { Produto } from '@delfrance/schemas';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { grupoDeVariacoesCollection } from '@/lib/data/grupoDeVariacoesCollection';

/**
 * Render a produto's variation groups' names joined with " · " (e.g.
 * "Tamanho · Cor"). Reads one `grupoDeVariacoes` doc per uid — only while
 * `produto.grupoDeVariacoesUid` is non-empty (renders nothing otherwise, so the
 * common no-variation produto issues no reads).
 */
export function ProdutoVariacaoLabel({
  db,
  produto,
  ...textProps
}: { db: Firestore; produto: Produto | null } & TextProps) {
  const uids = useMemo(
    () => (produto?.grupoDeVariacoesUid ?? []).filter((u): u is string => !!u),
    [produto?.grupoDeVariacoesUid],
  );
  if (uids.length === 0) return null;
  return (
    <Text size="xs" c="dimmed" {...textProps}>
      {uids.map((uid, i) => (
        <Fragment key={uid}>
          {i > 0 && ' · '}
          <GrupoNome db={db} uid={uid} />
        </Fragment>
      ))}
    </Text>
  );
}

function GrupoNome({ db, uid }: { db: Firestore; uid: string }) {
  const ref = useMemo(() => grupoDeVariacoesCollection.docRef(db, {}, uid), [db, uid]);
  const { data } = useDocSnapshot(ref);
  return <>{data?.data.nome ?? '…'}</>;
}
