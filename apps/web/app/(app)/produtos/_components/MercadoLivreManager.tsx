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
  ESTADO_PUBLICACAO_ML,
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
import { enviarEstoqueParaIntegracao } from '@/lib/marketplace/estoque/registry';
import type { StockPushIntegracao, StockPushRow } from '@/lib/marketplace/estoque/types';

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

/**
 * Bound for BOTH queries (accounts and link docs) — they must match, or an
 * account past the link-doc cap would falsely render as "Não publicado".
 */
const MAX_CONTAS = 50;

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

  const [publishing, setPublishing] = useState<string | null>(null);
  /** The link doc id currently being re-checked against ML (#781), if any. */
  const [rechecking, setRechecking] = useState<string | null>(null);
  /** The conta whose stock push is in flight (#819), if any. */
  const [sendingStock, setSendingStock] = useState<string | null>(null);
  /**
   * The last push outcome per LISTING, keyed by link doc id. Rendered inline in
   * each anúncio block rather than as a toast, because a conta can hold several
   * listings on one produto and one toast could only describe one of them.
   */
  const [stockResultByLink, setStockResultByLink] = useState<Record<string, StockPushRow>>({});
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
          ? 'O envio de estoque volta a rodar no próximo ciclo (até 15 minutos) — ou clique em ' +
            'Enviar estoque para enviar agora.'
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

  /**
   * Push this produto's CURRENT stock to every listing this conta holds on it
   * (#819) — the on-demand twin of the 15-minute sweep.
   *
   * Per CONTA, not per listing: the backend takes `{ integracaoId, produtoIds }`
   * and the sender loops every anúncio the conta holds (the link join
   * deliberately has no `limit(1)` — see the comment below and #781). A
   * per-listing button would imply an endpoint that does not exist.
   *
   * `reenviarComErro` is passed for a LATCHED listing only. An explicit click on
   * a listing the UI is already showing as "parado" is unambiguous consent, so
   * the tab does not need the bulk dialog's checkbox.
   */
  async function handleEnviarEstoque(
    // The registry's own type, not a hand-rolled shape with `tipo: number`.
    // Widening it to `number` forced an `as never` at the call below, which
    // silenced exactly the check that keeps an invalid tipo from reaching
    // `resolveStockPushProvider`.
    conta: StockPushIntegracao,
    temLatched: boolean,
  ) {
    setSendingStock(conta.id);
    try {
      const result = await enviarEstoqueParaIntegracao({
        integracao: conta,
        produtoIds: [produtoId],
        nomePorProdutoId: new Map(),
        reenviarComErro: temLatched,
        deps: { mercadoLivre: client },
      });
      setStockResultByLink((prev) => {
        const next = { ...prev };
        for (const row of result.rows) {
          if (row.linkDocId != null) next[row.linkDocId] = row;
        }
        return next;
      });
      // A row that names no listing (conta-level failure, or a produto with no
      // anúncio here) has nowhere inline to land — surface it as a toast.
      const semAnuncio = result.rows.filter((r) => r.linkDocId == null);
      for (const row of semAnuncio) {
        notifications.show({
          color: row.outcome === 'enviado' ? 'green' : row.outcome === 'falha' ? 'red' : 'yellow',
          message: row.mensagem,
        });
      }
    } finally {
      setSendingStock(null);
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

              {contaLinks.map((l) => {
                const d: ProdutoMercadoLivreLink = l.data;
                const estado = parseEstado(d.estado);
                const persistedErrors = (d.errors ?? []).filter(
                  (e): e is string => typeof e === 'string' && e.length > 0,
                );
                const latched = estado === ESTADO_PUBLICACAO_ML.erro && d.id != null;

                return (
                  <Stack key={l.id} gap="xs" data-testid={`ml-anuncio-${l.id}`}>
                    <Group justify="space-between">
                      <Text size="sm">
                        {d.id != null ? `Anúncio ${d.id}` : 'Rascunho — ainda não publicado'}
                      </Text>
                      <Badge color={estado ? ESTADO_COLORS[estado] : 'gray'}>
                        {estado ? ESTADO_PUBLICACAO_ML_LABELS[estado] : 'Desconhecido'}
                      </Badge>
                    </Group>

                    {persistedErrors.length > 0 && (
                      // `errors` is written by the publish flow, the price sync AND
                      // the stock sender, so the title must not blame any one of
                      // them — it used to read "Última publicação falhou" and
                      // reported stock failures as publish failures (#781).
                      <Alert color="red" variant="light" title="Última falha do Mercado Livre">
                        <List size="sm">
                          {persistedErrors.map((e) => (
                            <List.Item key={e}>{e}</List.Item>
                          ))}
                        </List>
                      </Alert>
                    )}

                    {latched && (
                      <Group gap="sm" align="center">
                        <Button
                          type="button"
                          variant="default"
                          size="xs"
                          onClick={() => handleReverificar(conta.id, l.id)}
                          loading={rechecking === l.id}
                          disabled={disabled || !client || !canPublish || rechecking !== null}
                        >
                          Reverificar anúncio
                        </Button>
                        <Text size="xs" c="dimmed">
                          O envio de estoque está parado para este anúncio.
                        </Text>
                      </Group>
                    )}

                    {stockResultByLink[l.id] && (
                      <Text
                        size="xs"
                        c={
                          stockResultByLink[l.id]!.outcome === 'enviado'
                            ? 'green'
                            : stockResultByLink[l.id]!.outcome === 'falha'
                              ? 'red'
                              : 'dimmed'
                        }
                        data-testid={`ml-envio-estoque-${l.id}`}
                      >
                        {stockResultByLink[l.id]!.mensagem}
                      </Text>
                    )}
                  </Stack>
                );
              })}

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
                {contaLinks.length > 0 && (
                  // Deliberately NOT disabled while a listing is latched: the
                  // push is precisely the operation whose skip row explains WHY
                  // it is latched, and after a re-arm it is how the operator
                  // verifies. The legacy action sent regardless and let the
                  // per-listing gate answer.
                  <Button
                    type="button"
                    variant="default"
                    onClick={() =>
                      void handleEnviarEstoque(
                        {
                          id: conta.id,
                          nome: conta.data.nome,
                          tipo: conta.data.tipo,
                          ativo: conta.data.ativo !== false,
                        },
                        contaLinks.some(
                          (l) => parseEstado(l.data.estado) === ESTADO_PUBLICACAO_ML.erro,
                        ),
                      )
                    }
                    loading={sendingStock === conta.id}
                    disabled={disabled || !client || !canPublish || sendingStock !== null}
                  >
                    Enviar estoque
                  </Button>
                )}
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
 * The old wire shape stores the account pointer as `documents/integracao/<id>`
 * (`pathWithDocuments` — the form the new publish flow writes too); the bare
 * `integracao/<id>` form is tolerated on read only, defensively. Same matcher
 * as the server-side `publishProduto`.
 */
function refMatchesIntegracao(ref: string | null | undefined, integracaoId: string): boolean {
  if (!ref) return false;
  return ref === `integracao/${integracaoId}` || ref.endsWith(`/integracao/${integracaoId}`);
}

/** Soft-parse the short estado code (Flutter may hold unknown values). */
function parseEstado(value: string | null | undefined): EstadoPublicacaoMl | null {
  const parsed = estadoPublicacaoMlSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Human label for an estado code coming back from the publish response. */
function estadoLabel(estado: string): string {
  const parsed = parseEstado(estado);
  return parsed ? ESTADO_PUBLICACAO_ML_LABELS[parsed] : estado;
}
