'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useFormContext, useFormState } from 'react-hook-form';
import type { Firestore } from 'firebase/firestore';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Divider,
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
import { flushListings } from '@/lib/mercado-livre/flushListings';
import { LISTING_TYPE_OPTIONS } from '@/lib/mercado-livre/listingFields';
import { estadoLabel, isStockLatched, refMatchesIntegracao } from '@/lib/mercado-livre/listingLinks';
import { enviarEstoqueParaIntegracao } from '@/lib/marketplace/estoque/registry';
import type { StockPushIntegracao, StockPushRow } from '@/lib/marketplace/estoque/types';
import { ListingDetails } from './ListingDetails';
import { ListingForm } from './ListingForm';
import { ListingStatusStrip } from './ListingStatusStrip';

/**
 * The produto editor's **Mercado Livre** tab: one card per registered ML account
 * (integração tipo 1) holding every listing that account has on this produto —
 * its live status, its editable fields, and the Publicar/Republicar action that
 * drives `POST /publicar` on the apps/mercado-livre backend.
 *
 * The link docs are read live (the same documents the Flutter app reads) and
 * edited through their own transaction, so listing edits are decoupled from the
 * produto form's save — but they still ride along with it, through the flush ref
 * the page wires into `ObjectView`'s `onAfterSave`.
 */

/**
 * Bound for BOTH queries (accounts and link docs) — they must match, or an
 * account past the link-doc cap would falsely render as "Não publicado".
 */
const MAX_CONTAS = 50;

export interface MercadoLivreEditorProps {
  produtoId: string;
  db: Firestore;
  disabled?: boolean;
  /** True while any listing holds unsaved edits — feeds ObjectView's `extraDirty`. */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * Receives a closure that commits every pending listing edit, so the produto's
   * "Salvar alterações" saves the Mercado Livre tab too. Left null while the tab
   * has never been opened, which the page's `?.` call handles.
   */
  flushRef?: React.MutableRefObject<(() => Promise<void>) | null>;
}

export function MercadoLivreEditor({
  produtoId,
  db,
  disabled,
  onDirtyChange,
  flushRef,
}: MercadoLivreEditorProps) {
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
  //
  // The ref MUST be memoized: `useDocSnapshot`'s effect depends on `[ref]` and
  // `docRef()` returns a fresh object every call, so an inline ref tears the
  // `onSnapshot` listener down and re-subscribes on every render.
  const produtoDocRef = useMemo(() => produtoCollection.docRef(db, {}, produtoId), [db, produtoId]);
  const produtoSnap = useDocSnapshot(produtoDocRef);
  // `null` while the snapshot is still loading — NOT 0. Collapsing the two made
  // the "produto sem fotos" alert flash on every open (see `ListingDetails`).
  const produtoFotoCount = produtoSnap.loading ? null : (produtoSnap.data?.data.fotos?.length ?? 0);

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

  // Which listings hold unsaved edits. A Set rather than a boolean because the
  // publish gate is per-account: an unsaved edit on account A must not block a
  // publish to account B.
  const [dirtyIds, setDirtyIds] = useState<ReadonlySet<string>>(() => new Set());
  const handleDirtyChange = useCallback((linkDocId: string, dirty: boolean) => {
    setDirtyIds((prev) => {
      // Returning the SAME set when nothing changed keeps this out of the render
      // loop — every ListingForm reports on mount and after every reset.
      if (prev.has(linkDocId) === dirty) return prev;
      const next = new Set(prev);
      if (dirty) next.add(linkDocId);
      else next.delete(linkDocId);
      return next;
    });
  }, []);

  const anyDirty = dirtyIds.size > 0;
  useEffect(() => {
    onDirtyChange?.(anyDirty);
  }, [anyDirty, onDirtyChange]);
  useEffect(
    () => () => {
      // Unmounting the tab must not leave the page's leave-guard armed forever.
      onDirtyChange?.(false);
    },
    [onDirtyChange],
  );

  const flushesRef = useRef(new Map<string, () => Promise<void>>());
  const registerFlush = useCallback((linkDocId: string, flush: (() => Promise<void>) | null) => {
    if (flush) flushesRef.current.set(linkDocId, flush);
    else flushesRef.current.delete(linkDocId);
  }, []);

  useEffect(() => {
    if (!flushRef) return;
    flushRef.current = () => flushListings(flushesRef.current.values());
    const ref = flushRef;
    return () => {
      ref.current = null;
    };
  }, [flushRef]);

  async function handlePublish(integracaoId: string, needsListingType: boolean) {
    if (!client) return;
    setPublishing(integracaoId);
    setBlockedIssues((prev) => ({ ...prev, [integracaoId]: [] }));
    try {
      const result = await client.publicar({
        integracaoId,
        produtoId,
        ...(needsListingType
          ? { listingTypeId: listingTypeByConta[integracaoId] ?? LISTING_TYPE_OPTIONS[0].value }
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
    <OuterFormDirty>
      {(produtoDirty) => (
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            A publicação envia os dados <strong>salvos</strong> do produto — salve as alterações
            antes de publicar.
          </Text>
          {contas.map((conta) => {
            // The stock sweep loops EVERY listing this conta holds on the produto
            // (bulkEstoquePlan's link join deliberately has no `limit(1)`), so
            // rendering only the first one hid a latched sibling completely (#781).
            const contaLinks = links.filter((l) =>
              refMatchesIntegracao(l.data.contaOuterRef, conta.id),
            );
            // Publishing still targets the CONTA, not one listing — it reads the same
            // primary link it always did.
            const primary: ProdutoMercadoLivreLink | null = contaLinks[0]?.data ?? null;
            const isFirstPublish = primary?.id == null;
            // Only when there is no link doc AT ALL. Once one exists — even an
            // unpublished draft — its `listing_type_id` is a field of the
            // listing form, and offering a second "Tipo de anúncio" control in
            // the same card would give the operator two inputs for one value
            // (and hand the e2e locator two elements to choose between).
            const needsListingType = contaLinks.length === 0;
            const issues = blockedIssues[conta.id] ?? [];
            const contaDirty = contaLinks.some((l) => dirtyIds.has(l.id));
            const publishBlocked = produtoDirty || contaDirty;

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

                  {contaLinks.map((l, index) => (
                    <Stack key={l.id} gap="sm" data-testid={`ml-anuncio-${l.id}`}>
                      {index > 0 && <Divider />}
                      <ListingStatusStrip
                        link={l.data}
                        canWrite={Boolean(client) && canPublish}
                        disabled={Boolean(disabled) || rechecking !== null}
                        rechecking={rechecking === l.id}
                        onReverificar={() => handleReverificar(conta.id, l.id)}
                      />
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
                      <ListingForm
                        produtoId={produtoId}
                        linkDocId={l.id}
                        link={l.data}
                        db={db}
                        canWrite={canPublish}
                        disabled={disabled}
                        onDirtyChange={handleDirtyChange}
                        registerFlush={registerFlush}
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
                    {contaLinks.length > 0 && (
                      // Deliberately NOT disabled while a listing is latched: the
                      // push is precisely the operation whose skip row explains WHY
                      // it is latched, and after a re-arm it is how the operator
                      // verifies. The legacy action sent regardless and let the
                      // per-listing gate answer.
                      //
                      // Nor is it blocked by `publishBlocked`: the push sends the
                      // stock Firestore already holds, never the pending form
                      // edits, so unsaved listing fields cannot make it ship a
                      // stale value the way a publish would.
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
                            contaLinks.some((l) => isStockLatched(l.data)),
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
                        data={[...LISTING_TYPE_OPTIONS]}
                        value={listingTypeByConta[conta.id] ?? LISTING_TYPE_OPTIONS[0].value}
                        onChange={(v) =>
                          setListingTypeByConta((prev) => ({
                            ...prev,
                            [conta.id]: v ?? LISTING_TYPE_OPTIONS[0].value,
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
                      disabled={
                        disabled ||
                        !client ||
                        !canPublish ||
                        publishing !== null ||
                        // The backend publishes the SAVED produto and the SAVED
                        // link doc, so publishing over pending edits ships the
                        // previous version and reports success.
                        publishBlocked
                      }
                    >
                      {isFirstPublish ? 'Publicar no Mercado Livre' : 'Republicar'}
                    </Button>
                    {publishBlocked && (
                      <Text size="xs" c="dimmed">
                        Salve as alterações pendentes antes de publicar.
                      </Text>
                    )}
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
      )}
    </OuterFormDirty>
  );
}

/**
 * `isDirty` of the SURROUNDING produto form, or `false` when this editor is
 * rendered outside one (component tests).
 *
 * Two components because hooks cannot be called conditionally and
 * `useFormState` needs a control: `useFormContext` is TYPED non-null but
 * actually returns `null` outside a provider (its context default), the same
 * caveat `VariationManager` documents. Subscribing through `useFormState` — not
 * reading `form.formState` — is what makes this re-render when the produto form
 * becomes dirty; the proxy only tracks reads in the component that created it.
 */
function OuterFormDirty({ children }: { children: (dirty: boolean) => ReactNode }) {
  const form = useFormContext();
  const control = form?.control;
  if (!control) return <>{children(false)}</>;
  return <SubscribedDirty control={control}>{children}</SubscribedDirty>;
}

function SubscribedDirty({
  control,
  children,
}: {
  control: NonNullable<ReturnType<typeof useFormContext>>['control'];
  children: (dirty: boolean) => ReactNode;
}) {
  const { isDirty } = useFormState({ control });
  return <>{children(isDirty)}</>;
}
