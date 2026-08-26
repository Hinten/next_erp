'use client';

import { useMemo } from 'react';
import { Alert, Badge, Group, Stack, Table, Text, Tooltip } from '@mantine/core';
import type { Firestore } from 'firebase/firestore';
import { buildQuery, groupQuery, limit, whereEqual } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import {
  type MlAttributeWire,
  type VariacaoMercadoLivreLink,
  precisaConsultarModeracao,
  toOuterRef,
} from '@delfrance/schemas';

import { variacaoMercadoLivreLinkCollection } from '@/lib/data/variacaoMercadoLivreLinkCollection';
import { mlbProductUrl } from '@/lib/mercado-livre/listingLinks';
import {
  corDaModeracao,
  moderacoesDoLink,
  secoesLabel,
} from '@/lib/mercado-livre/listingModeracoes';

/**
 * How many members are subscribed to at once. Generous — a família is a handful
 * of listings — but a cap reached silently reads as "this is all of them", which
 * on a status table is exactly the wrong thing to imply, so the note below says
 * when it bites. Mirrors `MAX_LINKS` in the editor.
 */
const MAX_MEMBROS = 60;

/** Raw ML status → the badge colour, mirroring the parent strip's `ESTADO_COLORS`. */
const STATUS_COLORS: Record<string, string> = {
  active: 'green',
  paused: 'yellow',
  under_review: 'orange',
  closed: 'gray',
};

/** Raw ML status → what an operator reads. Unknown values fall back to the raw. */
const STATUS_LABELS: Record<string, string> = {
  active: 'Ativo',
  paused: 'Pausado',
  under_review: 'Em revisão',
  closed: 'Encerrado',
};

export interface VariacoesAnuncioTableProps {
  produtoId: string;
  /** The FAMILY's `produtoMercadoLivre` doc id — the key the members hang off. */
  linkDocId: string;
  db: Firestore;
  /** The parent link's `isUserProductModel`. Legacy listings render nothing. */
  isUserProducts: boolean;
  /** The parent's own raw status — used to mark the reading the family reports. */
  linkStatus: string | null;
  linkSubStatus: string[] | null;
}

/**
 * Each variation's OWN Mercado Livre status, under the anúncio it belongs to.
 *
 * Under User Products a produto with variations is not one listing: every member
 * is its own ML item with its own lifecycle, and the parent link can only carry a
 * FOLD of them (`upFamilyStatus.ts`, #1142). So the tab used to show one family
 * status and nothing per variation — an operator could see "pausado" and had no
 * way to learn WHICH variation ML paused, or why. The raw per-member
 * `status`/`sub_status`/`moderacoes` have been on disk since #1142; this is their
 * first reader.
 *
 * ⚠️ **This component owns its own subscription, unlike everything else under
 * {@link AnuncioBlock}.** That block is documented as purely presentational
 * because its state is either cross-account or a single-flight lock — neither
 * applies to a read-only per-listing query. The decisive reason is mechanical:
 * the editor renders N listings, and subscribing per listing from there would
 * mean N hooks for a variable N, which React forbids. A component per anúncio is
 * the only shape that works, so the subscription lives with the thing that needs
 * it.
 *
 * ⚠️ A **classic** query, never a Pipeline. `usePipelineSnapshot` is one-shot
 * (no `onSnapshot` analogue in firebase@12) and reports `fromCache: undefined`
 * because it never touches the local cache, so a Pipeline would pay a full server
 * round trip on every mount AND leave this table stale after every "Reverificar
 * anúncio" — whose entire feedback model is the live snapshot repainting. Nothing
 * here needs a Pipeline anyway: no join, no aggregate, one indexed equality.
 *
 * ⚠️ ONE indexed equality reaches Firestore; everything else — ordering, the
 * variation label, the fold marker — is computed in memory off the cached
 * snapshot (root `CLAUDE.md` rule 1: an unindexed collection-group read does not
 * fail on Enterprise, it silently full-scans and bills the data scanned). Never
 * widen this query.
 */
export function VariacoesAnuncioTable({
  produtoId,
  linkDocId,
  db,
  isUserProducts,
  linkStatus,
  linkSubStatus,
}: VariacoesAnuncioTableProps) {
  // Rebuilt rather than read off a member: every writer stores this ref through
  // `variacaoMercadoLivreLinkCollection.parse()` and `toOuterRef` normalises to
  // `documents/…`, so an exact `==` is safe and it is the same key the server's
  // own fold reads by. Rides the declared `produtoMercadoLivreOuterRef`
  // COLLECTION_GROUP index.
  const membrosQuery = useMemo(
    () =>
      isUserProducts
        ? buildQuery(
            groupQuery(db, 'variacaoMercadoLivre', variacaoMercadoLivreLinkCollection.converter),
            [
              whereEqual(
                'produtoMercadoLivreOuterRef',
                toOuterRef(`produtos/${produtoId}/produtoMercadoLivre/${linkDocId}`),
              ),
              limit(MAX_MEMBROS),
            ],
          )
        : null,
    [db, isUserProducts, produtoId, linkDocId],
  );
  const membrosSnap = useSnapshot(membrosQuery);

  const linhas = useMemo(() => {
    const rows = (membrosSnap.data ?? [])
      .map((r) => ({ id: r.id, data: r.data }))
      // ⚠️ A member with no `itemId` is not a listing of its own — the legacy
      // `variations[]` shape leaves it null. It has no ML status to show and
      // never will, so it is not a row here.
      .filter((r) => (r.data.itemId ?? '') !== '');
    // Sorted in memory: a second `orderBy` would need another index for nothing.
    return rows.sort((a, b) => rotulo(a.data).localeCompare(rotulo(b.data), 'pt-BR'));
  }, [membrosSnap.data]);

  if (!isUserProducts || linhas.length === 0) return null;

  return (
    <Stack gap="xs">
      <Group gap="xs" align="baseline">
        <Text fw={600} size="sm">
          Variações no Mercado Livre
        </Text>
        <Text size="xs" c="dimmed">
          {linhas.length === 1 ? '1 anúncio' : `${String(linhas.length)} anúncios`} — cada variação
          é um anúncio próprio, com status independente. O status do anúncio acima é o resumo de
          todas.
        </Text>
      </Group>

      {linhas.length >= MAX_MEMBROS && (
        <Alert color="yellow" variant="light">
          Mostrando as primeiras {MAX_MEMBROS} variações deste anúncio. Pode haver outras que não
          aparecem aqui.
        </Alert>
      )}

      <Table striped highlightOnHover withTableBorder verticalSpacing="xs" fz="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Variação</Table.Th>
            <Table.Th>SKU</Table.Th>
            <Table.Th>Anúncio</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th>Motivo</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {linhas.map(({ id, data }) => (
            <Table.Tr key={id}>
              <Table.Td>{rotulo(data)}</Table.Td>
              <Table.Td>{data.sku ?? <Text c="dimmed">—</Text>}</Table.Td>
              <Table.Td>
                <ItemLink itemId={data.itemId} />
              </Table.Td>
              <Table.Td>
                <StatusCell
                  data={data}
                  reportadoNoAnuncio={ehOFoldWinner(data, linkStatus, linkSubStatus)}
                />
              </Table.Td>
              <Table.Td>
                <MotivoCell data={data} />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

/**
 * The status badge, plus the marker for the reading the family is reporting.
 *
 * ⚠️ `status: null` is **"nunca observado"**, never "encerrado". The schema is
 * emphatic about it and the fold depends on it: a member that was never observed
 * is unknown, and letting a null read as closed is exactly what would take a live
 * produto out of both ML sweeps. A member link written before #1142 — or one ML
 * has simply never fired a notification for — sits here legitimately.
 */
function StatusCell({
  data,
  reportadoNoAnuncio,
}: {
  data: VariacaoMercadoLivreLink;
  reportadoNoAnuncio: boolean;
}) {
  const status = data.status;
  const subStatus = (data.sub_status ?? []).filter((s) => s.trim() !== '');
  return (
    <Group gap={6} wrap="wrap">
      {status == null ? (
        <Tooltip
          label="O Mercado Livre ainda não informou o status desta variação. Use Reverificar anúncio para consultar agora."
          multiline
          w={280}
        >
          <Badge color="gray" variant="outline">
            Nunca consultado
          </Badge>
        </Tooltip>
      ) : (
        <Badge color={STATUS_COLORS[status] ?? 'blue'} variant="light">
          {STATUS_LABELS[status] ?? status}
        </Badge>
      )}
      {subStatus.map((s) => (
        <Badge key={s} color="gray" variant="outline" tt="none">
          {s}
        </Badge>
      ))}
      {reportadoNoAnuncio && (
        <Tooltip label="É este o status que aparece no resumo do anúncio acima." multiline w={260}>
          <Badge color="blue" variant="dot">
            No resumo
          </Badge>
        </Tooltip>
      )}
    </Group>
  );
}

/**
 * ML's reason for this member's state, when there is one.
 *
 * Reuses the parent strip's moderation helpers rather than restating them, so a
 * member and its family describe a moderação the same way — including the third
 * state (`moderacoes == null` + a status that says one exists = "ML says there is
 * a reason and nobody has fetched it yet"), which is user-visible and must not
 * collapse into "no moderation" (#1239).
 */
function MotivoCell({ data }: { data: VariacaoMercadoLivreLink }) {
  const moderacoes = moderacoesDoLink(data);
  if (moderacoes.length > 0) {
    return (
      <Stack gap={2}>
        {moderacoes.map((m, i) => (
          <Text key={i} size="xs" c={corDaModeracao([m])}>
            {m.motivo ?? `Moderado pelo Mercado Livre (${m.nome ?? ''})`}
            {m.secoes.length > 0 ? ` — ${secoesLabel(m.secoes)}` : ''}
          </Text>
        ))}
      </Stack>
    );
  }
  if (data.moderacoes == null && precisaConsultarModeracao(data.status, data.sub_status)) {
    return (
      <Text size="xs" c="orange">
        O Mercado Livre indica uma moderação — use Reverificar anúncio para ver o motivo.
      </Text>
    );
  }
  return <Text c="dimmed">—</Text>;
}

/** The member's own listing on Mercado Livre, when it has been published. */
function ItemLink({ itemId }: { itemId: string | null }) {
  const url = itemId == null ? null : mlbProductUrl(itemId);
  if (itemId == null) return <Text c="dimmed">—</Text>;
  if (url == null) return <Text ff="monospace">{itemId}</Text>;
  return (
    <Text
      component="a"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      ff="monospace"
      c="blue"
    >
      {itemId}
    </Text>
  );
}

/**
 * What identifies this variation to an operator: its ML attributes
 * (`Cor: Azul · Tamanho: M`), falling back to the SKU and then the item id.
 *
 * Read off the member link itself rather than the child produto, so the table
 * costs no second query — `attributes` and `sku` are stored right here by
 * publish and by the importer.
 */
function rotulo(data: VariacaoMercadoLivreLink): string {
  const partes = (data.attributes ?? [])
    .map(descreverAtributo)
    .filter((p): p is string => p != null);
  if (partes.length > 0) return partes.join(' · ');
  return data.sku ?? data.itemId ?? '—';
}

function descreverAtributo(a: MlAttributeWire): string | null {
  const valor = (a.value_name ?? '').trim();
  if (valor === '') return null;
  const nome = (a.name ?? '').trim();
  return nome === '' ? valor : `${nome}: ${valor}`;
}

/**
 * Is this the reading the family's parent link is currently reporting?
 *
 * Derived by COMPARING the stored values, deliberately — not by re-running
 * `foldFamilyStatus`. The fold's ladder and its two tie-break rungs live on the
 * server beside the stock gate they borrow from, and a browser copy would be free
 * to drift from it silently. The parent takes the winner's `status` and
 * `sub_status` verbatim, so an equality is a faithful read of the OUTCOME without
 * duplicating the rule that produced it.
 *
 * ⚠️ It marks a READING, not a unique member: two members with identical
 * status/sub_status both match, which is honest — either of them could be the one
 * the fold picked, and the label says "no resumo" rather than naming a winner.
 */
function ehOFoldWinner(
  data: VariacaoMercadoLivreLink,
  linkStatus: string | null,
  linkSubStatus: string[] | null,
): boolean {
  if (data.status == null || linkStatus == null) return false;
  if (data.status !== linkStatus) return false;
  const a = [...(data.sub_status ?? [])].sort();
  const b = [...(linkSubStatus ?? [])].sort();
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
