'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { Firestore } from 'firebase/firestore';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  List,
  Loader,
  Select,
  Stack,
  Text,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { PERM } from '@delfrance/auth';
import { INTEGRACAO_TIPO, type ProdutoMercadoLivreLink } from '@delfrance/schemas';
import { buildQuery, limit, whereEqual } from '@delfrance/data';
import { useDocSnapshot, useSnapshot } from '@delfrance/data/hooks';

import { usePermission } from '@/lib/auth';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { produtoMercadoLivreLinkCollection } from '@/lib/data/produtoMercadoLivreLinkCollection';
import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
  useMercadoLivreClient,
} from '@/lib/mercado-livre/client';
import { estadoLabel, refMatchesIntegracao } from '@/lib/mercado-livre/listingLinks';
import { ListingDetails } from './ListingDetails';
import { ListingStatusStrip } from './ListingStatusStrip';

/**
 * The produto editor's **Mercado Livre** tab: one row per registered ML account
 * (integração tipo 1) showing the persisted publish status from the
 * `produtos/{id}/produtoMercadoLivre` link doc (live snapshot — the doc the
 * Flutter app reads too) and a Publicar/Republicar action that drives
 * `POST /publicar` on the apps/mercado-livre backend.
 *
 * Self-contained like the Estoque tab: publishing is decoupled from the form's
 * save — the backend reads the SAVED produto, so unsaved edits don't ride along.
 */

/**
 * MLB listing types offered on a FIRST publish (a re-publish reuses the link
 * doc's persisted `listing_type_id`).
 */
const LISTING_TYPES = [
  { value: 'gold_special', label: 'Clássico' },
  { value: 'gold_pro', label: 'Premium' },
];

/**
 * Bound for BOTH queries (accounts and link docs) — they must match, or an
 * account past the link-doc cap would falsely render as "Não publicado".
 */
const MAX_CONTAS = 50;

export function MercadoLivreEditor({
  produtoId,
  db,
  disabled,
}: {
  produtoId: string;
  db: Firestore;
  disabled?: boolean;
}) {
  const client = useMercadoLivreClient();
  // The backend publicar route is PERM.integracao.write-gated — gate the button
  // by the same bit so a viewer isn't offered an action that will 403.
  const { allowed: canPublish } = usePermission(PERM.integracao.write);

  const contasQuery = useMemo(
    () =>
      buildQuery(integracaoCollection.ref(db, {}), [
        whereEqual('tipo', INTEGRACAO_TIPO.mercadoLivre),
        limit(MAX_CONTAS),
      ]),
    [db],
  );
  const contasSnap = useSnapshot(contasQuery);
  const contas = contasSnap.data ?? [];

  const linksQuery = useMemo(
    () => buildQuery(produtoMercadoLivreLinkCollection.ref(db, { produtoId }), [limit(MAX_CONTAS)]),
    [db, produtoId],
  );
  const linksSnap = useSnapshot(linksQuery);
  const links = useMemo(() => linksSnap.data ?? [], [linksSnap.data]);

  // Listing pictures are DERIVED from the produto's fotos at publish time — the
  // link doc has no picture field — so the count is what tells the operator, up
  // front, whether the publish will be blocked for "produto sem fotos" or will
  // silently drop everything past the 10th.
  const produtoSnap = useDocSnapshot(produtoCollection.docRef(db, {}, produtoId));
  const produtoFotoCount = produtoSnap.data?.data.fotos?.length ?? 0;

  const [publishing, setPublishing] = useState<string | null>(null);
  /** The link doc id currently being re-checked against ML (#781), if any. */
  const [rechecking, setRechecking] = useState<string | null>(null);
  // 422 ML_PUBLISH_BLOCKED issue lists, kept per account so they render inline
  // in the offending row instead of a transient toast.
  const [blockedIssues, setBlockedIssues] = useState<Record<string, string[]>>({});
  const [listingTypeByConta, setListingTypeByConta] = useState<Record<string, string>>({});

  async function handlePublish(integracaoId: string, needsListingType: boolean) {
    if (!client) return;
    setPublishing(integracaoId);
    setBlockedIssues((prev) => ({ ...prev, [integracaoId]: [] }));
    try {
      const result = await client.publicar({
        integracaoId,
        produtoId,
        ...(needsListingType
          ? { listingTypeId: listingTypeByConta[integracaoId] ?? LISTING_TYPES[0]!.value }
          : {}),
      });
      notifications.show({
        color: 'green',
        title: 'Publicado no Mercado Livre',
        message: `Anúncio ${result.itemId} — ${estadoLabel(result.estado)}.`,
      });
    } catch (err) {
      if (err instanceof MercadoLivreClientHttpError) {
        if (err.code === 'ML_PUBLISH_BLOCKED' && err.issues && err.issues.length > 0) {
          setBlockedIssues((prev) => ({ ...prev, [integracaoId]: err.issues! }));
        } else if (err.status === 409) {
          notifications.show({
            color: 'red',
            message:
              'Conta Mercado Livre não conectada — reconecte em Canais de venda → Mercado Livre.',
          });
        } else {
          notifications.show({ color: 'red', message: err.message });
        }
        return;
      }
      if (err instanceof MercadoLivreClientNetworkError) {
        notifications.show({
          color: 'red',
          message: 'Não foi possível contatar o serviço do Mercado Livre.',
        });
        return;
      }
      throw err;
    } finally {
      setPublishing(null);
    }
  }

  /**
   * Re-read ONE listing from ML and record its real state (#781). The stock
   * sender stops sending to a listing stamped `estado 'E'` — it writes that only
   * after ML confirmed the anúncio is healthy, so the payload was at fault. An
   * `items` webhook normally clears it, but a listing nobody touches never fires
   * one, and this is the manual way out. The live `useSnapshot` above repaints
   * the row as soon as the server write lands.
   */
  async function handleReverificar(integracaoId: string, linkDocId: string) {
    if (!client) return;
    setRechecking(linkDocId);
    try {
      const result = await client.reverificarAnuncio({ integracaoId, produtoId, linkDocId });
      notifications.show({
        color: result.enviavel ? 'green' : 'yellow',
        title: `Anúncio reverificado — ${estadoLabel(result.estado)}`,
        message: result.enviavel
          ? 'O envio de estoque volta a rodar no próximo ciclo (até 15 minutos).'
          : 'O Mercado Livre ainda não aceita envio de estoque para este anúncio.',
      });
    } catch (err) {
      if (err instanceof MercadoLivreClientHttpError) {
        notifications.show({ color: 'red', message: err.message });
        return;
      }
      if (err instanceof MercadoLivreClientNetworkError) {
        notifications.show({
          color: 'red',
          message: 'Não foi possível contatar o serviço do Mercado Livre.',
        });
        return;
      }
      throw err;
    } finally {
      setRechecking(null);
    }
  }

  if (contasSnap.loading || linksSnap.loading) {
    return (
      <Group justify="center" py="md">
        <Loader size="sm" />
      </Group>
    );
  }

  const snapshotError = contasSnap.error ?? linksSnap.error;
  if (snapshotError) {
    return (
      <Alert color="red" variant="light">
        Erro ao carregar as contas Mercado Livre: {snapshotError.message}
      </Alert>
    );
  }

  if (contas.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        Nenhuma conta Mercado Livre cadastrada.{' '}
        <Anchor component={Link} href="/canais/mercado-livre" size="sm">
          Cadastrar em Canais de venda
        </Anchor>
        .
      </Text>
    );
  }

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        A publicação envia os dados <strong>salvos</strong> do produto — salve as alterações antes
        de publicar.
      </Text>
      {contas.map((conta) => {
        // The stock sweep loops EVERY listing this conta holds on the produto
        // (estoquePlan's link join deliberately has no `limit(1)`), so rendering
        // only the first one hid a latched sibling completely (#781).
        const contaLinks = links.filter((l) =>
          refMatchesIntegracao(l.data.contaOuterRef, conta.id),
        );
        // Publishing still targets the CONTA, not one listing — it reads the same
        // primary link it always did.
        const primary: ProdutoMercadoLivreLink | null = contaLinks[0]?.data ?? null;
        const isFirstPublish = primary?.id == null;
        const needsListingType = isFirstPublish && primary?.listing_type_id == null;
        const issues = blockedIssues[conta.id] ?? [];

        return (
          <Card key={conta.id} withBorder padding="md" data-testid={`ml-conta-${conta.id}`}>
            <Stack gap="sm">
              <Group justify="space-between">
                <Text fw={600}>{conta.data.nome}</Text>
                {contaLinks.length === 0 && (
                  <Badge color="gray" variant="light">
                    Não publicado
                  </Badge>
                )}
              </Group>

              {contaLinks.map((l) => (
                <Stack key={l.id} gap="sm" data-testid={`ml-anuncio-${l.id}`}>
                  <ListingStatusStrip
                    link={l.data}
                    canWrite={Boolean(client) && canPublish}
                    disabled={Boolean(disabled) || rechecking !== null}
                    rechecking={rechecking === l.id}
                    onReverificar={() => handleReverificar(conta.id, l.id)}
                  />
                  <ListingDetails link={l.data} produtoFotoCount={produtoFotoCount} />
                </Stack>
              ))}

              {issues.length > 0 && (
                <Alert color="red" variant="light" title="Publicação bloqueada">
                  <List size="sm">
                    {issues.map((issue) => (
                      <List.Item key={issue}>{issue}</List.Item>
                    ))}
                  </List>
                </Alert>
              )}

              <Group align="flex-end" gap="sm">
                {needsListingType && (
                  <Select
                    label="Tipo de anúncio"
                    data={LISTING_TYPES}
                    value={listingTypeByConta[conta.id] ?? LISTING_TYPES[0]!.value}
                    onChange={(v) =>
                      setListingTypeByConta((prev) => ({
                        ...prev,
                        [conta.id]: v ?? LISTING_TYPES[0]!.value,
                      }))
                    }
                    allowDeselect={false}
                    disabled={disabled || !canPublish}
                    w={160}
                  />
                )}
                <Button
                  type="button"
                  variant={isFirstPublish ? 'filled' : 'light'}
                  onClick={() => handlePublish(conta.id, needsListingType)}
                  loading={publishing === conta.id}
                  disabled={disabled || !client || !canPublish || publishing !== null}
                >
                  {isFirstPublish ? 'Publicar no Mercado Livre' : 'Republicar'}
                </Button>
                {!canPublish && (
                  <Text size="xs" c="dimmed">
                    Requer permissão de escrita em integrações.
                  </Text>
                )}
              </Group>
            </Stack>
          </Card>
        );
      })}
    </Stack>
  );
}

// `refMatchesIntegracao`, `parseEstado` and `estadoLabel` now live in
// `@/lib/mercado-livre/listingLinks` — the listing editor, the status strip and
// their unit tests all read the same implementation.
