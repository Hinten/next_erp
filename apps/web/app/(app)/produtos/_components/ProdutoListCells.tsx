'use client';

import { useState } from 'react';
import {
  ActionIcon,
  Badge,
  Center,
  Group,
  Image,
  Modal,
  Skeleton,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconCurrencyReal, IconPhotoOff } from '@tabler/icons-react';
import { type Firestore } from 'firebase/firestore';
import { formatReais } from '@delfrance/core';
import {
  INTEGRACAO_TIPO_LABELS,
  type Integracao,
  type IntegracaoTipo,
  type Produto,
} from '@delfrance/schemas';
import type { ListaDePrecosRow } from '@/lib/data/useListasDePrecos';
import type { IntegracoesStatus } from '@/lib/data/useIntegracoes';
import { integracaoBadgeStyle } from '@/lib/integracoes/cor';
import { coverArquivoId, useProdutoFotoUrl } from '@/lib/produtos/fotoCapa';

/** Edge of the square thumbnail rendered in the Foto column, in px. */
const THUMB_PX = 40;

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
  // A URL that resolved and then failed to LOAD is a fourth state the ref
  // cannot predict — the arquivo doc still points at an object storage has
  // since lost, or the download URL expired. Without this the row renders the
  // browser's own broken-image glyph at whatever size it likes, which is the
  // one variant that also breaks the fixed row height.
  const [loadFailed, setLoadFailed] = useState(false);
  // `resolved && url === null` is a produto whose ref went nowhere (deleted
  // arquivo, or one with no `url`); render the placeholder, never a skeleton
  // that would spin for the life of the page.
  const hasFoto = coverArquivoId(produto) !== null && !(resolved && url === null) && !loadFailed;

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
      // Mantine's own `fallbackSrc` would need a second image to fetch; the
      // placeholder above is already the right answer, so re-render into it.
      fallbackSrc={undefined}
      onError={() => setLoadFailed(true)}
    />
  );
}

/**
 * The produto's price in the default lista de preços, plus a button opening
 * every OTHER lista it is priced in.
 *
 * Both halves are legacy's (`produtoTableView.dart:1742-1813`): the default
 * value inline so the common question needs no click, and an
 * `Icons.attach_money` button onto a Tabela | Preço dialog for the rest.
 * `—` when the produto carries no entry for the default lista (or while that
 * lista is still resolving) — the same degradation legacy had when its
 * price-list future was empty (`produtoTableView.dart:1763`).
 *
 * ⚠️ The button is HIDDEN, not disabled, when the produto has no prices at
 * all. A disabled control still reads as "there is something here", and on a
 * catalog where most rows are priced, the rows that are not are exactly the
 * ones worth spotting from across the table.
 */
export function ProdutoPrecoCell({
  produto,
  listas,
  listaPadraoId,
}: {
  produto: Produto;
  /** Every lista, ordered by nome — from the table-wide `useListasDePrecos`. */
  listas: ReadonlyArray<ListaDePrecosRow>;
  listaPadraoId: string | null;
}) {
  const [aberto, setAberto] = useState(false);
  const precos = produto.precos ?? null;
  const valorPadrao = listaPadraoId ? precos?.[listaPadraoId]?.valor : undefined;

  // Only listas this produto is actually priced in, in the order they were
  // read (nome asc). A lista with no entry is not a zero — it is a price this
  // produto does not have, and listing it as `—` would pad the dialog with
  // rows that say nothing.
  const linhas = listas
    .map((l) => ({ id: l.id, nome: l.data.nome, valor: precos?.[l.id]?.valor }))
    .filter((l): l is { id: string; nome: string; valor: number } => typeof l.valor === 'number');

  return (
    <>
      <Group gap={4} wrap="nowrap">
        {typeof valorPadrao === 'number' ? (
          <Text size="sm">{formatReais(valorPadrao)}</Text>
        ) : (
          <Text size="sm" c="dimmed">
            —
          </Text>
        )}
        {linhas.length > 0 && (
          <Tooltip label="Ver todos os preços" withinPortal>
            <ActionIcon
              variant="subtle"
              size="sm"
              aria-label={`Ver todos os preços de ${produto.nome}`}
              onClick={(e) => {
                // The whole row is a link to the produto editor. Without both
                // of these the dialog would open and the router would navigate
                // away from it in the same click.
                e.stopPropagation();
                e.preventDefault();
                setAberto(true);
              }}
            >
              <IconCurrencyReal size={16} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>

      <Modal
        opened={aberto}
        onClose={() => setAberto(false)}
        title={`${produto.nome} (${produto.sku ?? 'Sem SKU'}) — Preços`}
        // The modal lives inside a table ROW, which is itself a link. A click
        // anywhere in the dialog would otherwise bubble back out to it.
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
        }}
      >
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Tabela</Table.Th>
              <Table.Th ta="right">Preço</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {linhas.map((l) => (
              <Table.Tr key={l.id}>
                <Table.Td>
                  <Group gap="xs" wrap="nowrap">
                    {l.nome}
                    {l.id === listaPadraoId && (
                      <Badge size="xs" variant="light" color="blue">
                        padrão
                      </Badge>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td ta="right">{formatReais(l.valor)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Modal>
    </>
  );
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
