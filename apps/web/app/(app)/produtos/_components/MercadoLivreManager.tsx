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
import {
  ESTADO_PUBLICACAO_ML_LABELS,
  type EstadoPublicacaoMl,
  INTEGRACAO_TIPO,
  type ProdutoMercadoLivreLink,
  estadoPublicacaoMlSchema,
} from '@delfrance/schemas';
import { buildQuery, limit, whereEqual } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';

import { usePermission } from '@/lib/auth';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { produtoMercadoLivreLinkCollection } from '@/lib/data/produtoMercadoLivreLinkCollection';
import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
  useMercadoLivreClient,
} from '@/lib/mercado-livre/client';

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

/** Badge color per old-shape estado code. */
const ESTADO_COLORS: Record<EstadoPublicacaoMl, string> = {
  r: 'gray',
  a: 'blue',
  ep: 'blue',
  v: 'yellow',
  p: 'green',
  pa: 'yellow',
  c: 'gray',
  E: 'red',
  am: 'orange',
};

/**
 * MLB listing types offered on a FIRST publish (a re-publish reuses the link
 * doc's persisted `listing_type_id`).
 */
const LISTING_TYPES = [
  { value: 'gold_special', label: 'Clássico' },
  { value: 'gold_pro', label: 'Premium' },
];

export function MercadoLivreManager({
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
        limit(50),
      ]),
    [db],
  );
  const contasSnap = useSnapshot(contasQuery);
  const contas = contasSnap.data ?? [];

  const linksQuery = useMemo(
    () => buildQuery(produtoMercadoLivreLinkCollection.ref(db, { produtoId }), [limit(20)]),
    [db, produtoId],
  );
  const linksSnap = useSnapshot(linksQuery);
  const links = useMemo(() => linksSnap.data ?? [], [linksSnap.data]);

  const [publishing, setPublishing] = useState<string | null>(null);
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
        const link = links.find((l) => refMatchesIntegracao(l.data.contaOuterRef, conta.id));
        const linkData: ProdutoMercadoLivreLink | null = link?.data ?? null;
        const estado = parseEstado(linkData?.estado);
        const isFirstPublish = linkData?.id == null;
        const needsListingType = isFirstPublish && linkData?.listing_type_id == null;
        const issues = blockedIssues[conta.id] ?? [];
        const persistedErrors = (linkData?.errors ?? []).filter(
          (e): e is string => typeof e === 'string' && e.length > 0,
        );

        return (
          <Card key={conta.id} withBorder padding="md" data-testid={`ml-conta-${conta.id}`}>
            <Stack gap="sm">
              <Group justify="space-between">
                <Text fw={600}>{conta.data.nome}</Text>
                {linkData ? (
                  <Badge color={estado ? ESTADO_COLORS[estado] : 'gray'}>
                    {estado ? ESTADO_PUBLICACAO_ML_LABELS[estado] : 'Desconhecido'}
                  </Badge>
                ) : (
                  <Badge color="gray" variant="light">
                    Não publicado
                  </Badge>
                )}
              </Group>

              {linkData?.id != null && <Text size="sm">Anúncio {linkData.id}</Text>}

              {persistedErrors.length > 0 && (
                <Alert color="red" variant="light" title="Última publicação falhou">
                  <List size="sm">
                    {persistedErrors.map((e) => (
                      <List.Item key={e}>{e}</List.Item>
                    ))}
                  </List>
                </Alert>
              )}

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

/**
 * The old wire shape stores the account pointer as a bare `integracao/<id>`
 * path string (sometimes prefixed, e.g. `documents/integracao/<id>`) — same
 * matcher as the server-side `publishProduto`.
 */
function refMatchesIntegracao(ref: string | null | undefined, integracaoId: string): boolean {
  if (!ref) return false;
  return ref === `integracao/${integracaoId}` || ref.endsWith(`/integracao/${integracaoId}`);
}

/** Soft-parse the single-char estado code (Flutter may hold unknown values). */
function parseEstado(value: string | null | undefined): EstadoPublicacaoMl | null {
  const parsed = estadoPublicacaoMlSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Human label for an estado code coming back from the publish response. */
function estadoLabel(estado: string): string {
  const parsed = parseEstado(estado);
  return parsed ? ESTADO_PUBLICACAO_ML_LABELS[parsed] : estado;
}
