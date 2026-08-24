'use client';

import { Badge, Center, Group, Image, Skeleton, Text, Tooltip } from '@mantine/core';
import { IconPhotoOff } from '@tabler/icons-react';
import { getDocs, type Firestore } from 'firebase/firestore';
import { useQuery } from '@tanstack/react-query';
import { buildQuery, orderByField } from '@delfrance/data';
import { formatReais } from '@delfrance/core';
import {
  INTEGRACAO_TIPO_LABELS,
  type Integracao,
  type IntegracaoTipo,
  type Produto,
} from '@delfrance/schemas';
import { listaDePrecosCollection } from '@/lib/data/listaDePrecosCollection';
import type { IntegracoesStatus } from '@/lib/data/useIntegracoes';
import { integracaoBadgeStyle } from '@/lib/integracoes/cor';
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
 *
 * It reads the whole (small) collection rather than
 * `where('padrao','==',true).limit(1)` on purpose. The narrower query scans less
 * per call, but it needs its own `listaDePrecos(padrao)` index — a fifth entry
 * in the coordinated index deploy — and a second round trip whenever no lista
 * is flagged padrão, which is exactly the fallback legacy relied on
 * (`produtoTableView.dart:1759`). `listaDePrecos` is a cadastro with a handful
 * of rows, and this runs once per table with a 5-minute `staleTime`, so the
 * scan it saves does not pay for the deploy step. Revisit if the collection
 * ever grows past a page.
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
  const { url, resolved } = useProdutoFotoUrl(db, produto);
  // `resolved && url === null` is a produto whose ref went nowhere (deleted
  // arquivo, or one with no `url`); render the placeholder, never a skeleton
  // that would spin for the life of the page.
  const hasFoto = coverArquivoId(produto) !== null && !(resolved && url === null);

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
  if (!resolved || url === null) return <Skeleton w={THUMB_PX} h={THUMB_PX} radius="sm" />;
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
/**
 * The "Canais de venda" column — one badge per integração a produto is listed
 * on, painted in that channel's registered `cor`.
 *
 * `produto.integracoesComProduto` holds bare `integracao` document ids, which
 * is why this needs the `byId` map the page loads once for the whole table
 * (`useIntegracoes`) rather than a read per row. Without the join the generic
 * array renderer prints `N item(s)` — the count that this column replaces.
 *
 * Legacy showed the same set as plain text, sorted alphabetically, with the
 * `nome(tipo)` label in a tooltip (`produtoTableView.dart:1701-1739`). Kept:
 * the sort, the tooltip label, and rendering NOTHING for a produto on no
 * channel (its `SizedBox.shrink()`). Added: the colour, which legacy stored on
 * `Integracao.cor` but only ever used in the sales chart.
 *
 * ⚠️ An id that resolves to nothing is shown, not dropped. The denorm drifts —
 * `apps/mercado-livre/lib/marketplace/preco/precoReconciliacao.ts` documents
 * produtos whose `integracoesComProduto` disagrees with the live listings — and
 * the id can also name a deleted conta. Silently rendering an empty cell would
 * read as "listed nowhere", which is the opposite of what the row says.
 *
 * ⚠️ `desconhecida` is reserved for that DATA verdict, which is why `status` is
 * a required prop rather than an empty `byId` being read as "nothing resolves".
 * The lookup is empty while it loads and empty when it fails — a user without
 * `PERM.integracao.read` gets `permission-denied` — and in both cases every
 * badge on every row would claim a drifted denorm. Those are system states and
 * they render as such: a skeleton while pending, one explicit "indisponível"
 * badge on error.
 */
export function ProdutoIntegracoesCell({
  produto,
  byId,
  status,
}: {
  produto: Produto;
  byId: Map<string, Integracao>;
  status: IntegracoesStatus;
}) {
  const ids = produto.integracoesComProduto ?? [];
  if (ids.length === 0) return null;

  // Sized like a badge so the column does not reflow when the lookup lands.
  if (status === 'pending') {
    return (
      <Group gap={4} wrap="wrap">
        {ids.map((id) => (
          <Skeleton key={id} h={20} w={72} radius="xl" />
        ))}
      </Group>
    );
  }

  if (status === 'error') {
    return (
      <Tooltip label={`Não foi possível carregar os canais de venda (${ids.length}).`} withArrow>
        <Badge size="sm" variant="light" color="gray">
          indisponível
        </Badge>
      </Tooltip>
    );
  }

  // Sorted by the label the operator reads, not by id — legacy's `opcoes.sort()`.
  // Unresolved ids sort last, together, under their placeholder label.
  const entries = ids
    .map((id) => ({ id, integracao: byId.get(id) ?? null }))
    .sort((a, b) =>
      (a.integracao?.nome ?? '\uffff').localeCompare(b.integracao?.nome ?? '\uffff', 'pt-BR'),
    );

  return (
    <Group gap={4} wrap="wrap">
      {entries.map(({ id, integracao }) => {
        if (integracao === null) {
          return (
            <Tooltip key={id} label={`Integração não encontrada (${id})`} withArrow>
              <Badge size="sm" variant="light" color="gray">
                desconhecida
              </Badge>
            </Tooltip>
          );
        }
        // No registered `cor` → a neutral badge rather than an invented colour.
        // Every Mercado Livre conta is in that state today: `cor` is excluded
        // from that channel's form.
        const style = integracaoBadgeStyle(integracao.cor);
        const tipoLabel = INTEGRACAO_TIPO_LABELS[integracao.tipo as IntegracaoTipo];
        return (
          <Tooltip key={id} label={`${integracao.nome} (${tipoLabel})`} withArrow>
            <Badge
              size="sm"
              variant={style ? 'filled' : 'light'}
              color={style ? undefined : 'gray'}
              style={style ?? undefined}
            >
              {integracao.nome}
            </Badge>
          </Tooltip>
        );
      })}
    </Group>
  );
}
