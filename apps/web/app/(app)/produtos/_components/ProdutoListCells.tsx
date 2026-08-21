'use client';

import { Center, Image, Skeleton, Text } from '@mantine/core';
import { IconPhotoOff } from '@tabler/icons-react';
import { getDocs, type Firestore } from 'firebase/firestore';
import { useQuery } from '@tanstack/react-query';
import { buildQuery, orderByField } from '@delfrance/data';
import { formatReais } from '@delfrance/core';
import type { Produto } from '@delfrance/schemas';
import { listaDePrecosCollection } from '@/lib/data/listaDePrecosCollection';
import { coverArquivoId, useProdutoFotoUrl } from '@/lib/produtos/fotoCapa';

/** Edge of the square thumbnail rendered in the Foto column, in px. */
const THUMB_PX = 40;

/**
 * Id of the DEFAULT lista de preços — the one the Preço column prices against.
 *
 * Legacy picked `padrao == true`, falling back to the first by nome
 * (`.old/lib/produtos/pages/produtoTableView.dart:1759`), and loaded the list
 * ONCE per screen rather than per row (`:1343`). Same here: one cached
 * `useQuery` for the whole table, so 50 rows cost one read, not 50.
 *
 * The `orderBy nome` rides the `listaDePrecos(nome ASC)` index declared for
 * `listaDePrecosMeta.defaultQuery` (#159) — without it this would full-scan on
 * Enterprise. Returns `null` while loading or when no lista exists.
 */
export function useListaPrecoPadraoId(db: Firestore): string | null {
  const { data } = useQuery({
    queryKey: ['listaPrecoPadraoId'],
    // The default lista changes about as often as the price book itself.
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<string | null> => {
      const snap = await getDocs(
        buildQuery(listaDePrecosCollection.ref(db, {}), [orderByField('nome')]),
      );
      const padrao = snap.docs.find((d) => d.data().padrao === true);
      return (padrao ?? snap.docs[0])?.id ?? null;
    },
  });
  return data ?? null;
}

/**
 * Cover photo for a produto row. `fotos` carries only `arquivos/<id>` refs, so
 * the URL comes from {@link useProdutoFotoUrl} — a one-shot cached read keyed by
 * arquivo id, deliberately not a per-row listener (see that module).
 *
 * Three states, all sized identically so rows never reflow: no photo at all →
 * a muted placeholder icon; ref present but URL still resolving → a skeleton;
 * resolved → the 200px derivative.
 */
export function ProdutoFotoCell({ db, produto }: { db: Firestore; produto: Produto }) {
  const url = useProdutoFotoUrl(db, produto);
  const hasFoto = coverArquivoId(produto) !== null;

  if (!hasFoto) {
    return (
      <Center
        w={THUMB_PX}
        h={THUMB_PX}
        bg="var(--mantine-color-gray-1)"
        role="img"
        aria-label="Sem foto"
        style={{ borderRadius: 'var(--mantine-radius-sm)' }}
      >
        <IconPhotoOff size={Math.round(THUMB_PX * 0.5)} color="var(--mantine-color-gray-5)" />
      </Center>
    );
  }
  if (url === null) return <Skeleton w={THUMB_PX} h={THUMB_PX} radius="sm" />;
  return (
    <Image
      src={url}
      alt=""
      w={THUMB_PX}
      h={THUMB_PX}
      fit="cover"
      radius="sm"
      fallbackSrc={undefined}
    />
  );
}

/**
 * The produto's price in the default lista de preços, mirroring what legacy's
 * "Preço" column showed. `—` when the produto carries no entry for that lista
 * (or while the default lista is still resolving) — the same degradation legacy
 * had when its price-list future was empty (`produtoTableView.dart:1763`).
 */
export function ProdutoPrecoCell({
  produto,
  listaPadraoId,
}: {
  produto: Produto;
  listaPadraoId: string | null;
}) {
  const valor = listaPadraoId ? produto.precos?.[listaPadraoId]?.valor : undefined;
  if (typeof valor !== 'number') {
    return (
      <Text size="sm" c="dimmed">
        —
      </Text>
    );
  }
  return <Text size="sm">{formatReais(valor)}</Text>;
}
