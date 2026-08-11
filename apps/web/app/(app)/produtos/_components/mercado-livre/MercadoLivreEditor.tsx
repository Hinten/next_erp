'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useFormContext, useFormState } from 'react-hook-form';
import type { Firestore } from 'firebase/firestore';
import { FirebaseError } from 'firebase/app';
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
import { createListingDraft } from '@/lib/mercado-livre/listingDraft';
import { LISTING_TYPE_OPTIONS } from '@/lib/mercado-livre/listingFields';
import { estadoLabel, refMatchesIntegracao } from '@/lib/mercado-livre/listingLinks';
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
  // Seeds a draft's title and the category suggestions. Empty until the
  // snapshot lands, which is why "Preparar anúncio" waits for it: the link
  // schema requires a non-empty `title`, so a draft built from '' would fail
  // its write-side parse rather than save something blank.
  const produtoNome = produtoSnap.data?.data.nome ?? '';

  const [publishing, setPublishing] = useState<string | null>(null);
  /** The conta whose draft is being created, if any. */
  const [preparing, setPreparing] = useState<string | null>(null);
  /** The link doc id currently being re-checked against ML (#781), if any. */
  const [rechecking, setRechecking] = useState<string | null>(null);
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

  /**
   * Create the link doc a fresh produto has never had.
   *
   * This is a plain Firestore write, not a call to the ML backend — nothing
   * reaches Mercado Livre until Publicar. The live `useSnapshot` above swaps the
   * card over to the full editor as soon as the write lands.
   */
  async function handlePreparar(integracaoId: string) {
    setPreparing(integracaoId);
    try {
      const { outcome } = await createListingDraft(db, produtoId, {
        integracaoId,
        produtoNome,
        listingTypeId: listingTypeByConta[integracaoId] ?? LISTING_TYPE_OPTIONS[0].value,
        nowMs: Date.now(),
      });
      notifications.show({
        color: outcome === 'created' ? 'green' : 'yellow',
        message:
          outcome === 'created'
            ? 'Rascunho criado. Escolha a categoria e revise os dados antes de publicar.'
            : 'Este anúncio já estava preparado.',
      });
    } catch (err) {
      if (err instanceof FirebaseError) {
        notifications.show({ color: 'red', message: err.message });
        return;
      }
      throw err;
    } finally {
      setPreparing(null);
    }
  }

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
    <OuterFormDirty>
      {(produtoDirty) => (
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            A publicação envia os dados <strong>salvos</strong> do produto — salve as alterações
            antes de publicar.
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
            // Only when there is no link doc AT ALL. Once one exists — even an
            // unpublished draft — its `listing_type_id` is a field of the
            // listing form, and offering a second "Tipo de anúncio" control in
            // the same card would give the operator two inputs for one value
            // (and hand the e2e locator two elements to choose between).
            const needsListingType = contaLinks.length === 0;
            const issues = blockedIssues[conta.id] ?? [];
            const contaDirty = contaLinks.some((l) => dirtyIds.has(l.id));
            const publishBlocked = produtoDirty || contaDirty;
            // Publish refuses a create with no category ("categoria do Mercado
            // Livre não definida"). Saying so here beats a round trip that comes
            // back as a 422 the operator has to read.
            const missingCategoria = primary != null && (primary.category_id ?? '') === '';

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
                      <ListingForm
                        produtoId={produtoId}
                        linkDocId={l.id}
                        integracaoId={conta.id}
                        produtoNome={produtoNome}
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
                    {needsListingType ? (
                      <>
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
                        {/* Publishing straight from here is impossible, not merely
                            unlikely: with no link doc there is no `category_id`,
                            and publish raises that as a 422 BEFORE it writes any
                            doc — so the failure leaves nothing behind and the
                            next attempt fails identically. The draft is what
                            breaks that cycle. */}
                        <Button
                          type="button"
                          variant="filled"
                          onClick={() => handlePreparar(conta.id)}
                          loading={preparing === conta.id}
                          disabled={
                            disabled || !canPublish || preparing !== null || produtoNome === ''
                          }
                        >
                          Preparar anúncio
                        </Button>
                      </>
                    ) : (
                      <Button
                        type="button"
                        variant={isFirstPublish ? 'filled' : 'light'}
                        onClick={() => handlePublish(conta.id, false)}
                        loading={publishing === conta.id}
                        disabled={
                          disabled ||
                          !client ||
                          !canPublish ||
                          publishing !== null ||
                          // The backend publishes the SAVED produto and the SAVED
                          // link doc, so publishing over pending edits ships the
                          // previous version and reports success.
                          publishBlocked ||
                          missingCategoria
                        }
                      >
                        {isFirstPublish ? 'Publicar no Mercado Livre' : 'Republicar'}
                      </Button>
                    )}
                    {publishBlocked && (
                      <Text size="xs" c="dimmed">
                        Salve as alterações pendentes antes de publicar.
                      </Text>
                    )}
                    {missingCategoria && !publishBlocked && (
                      <Text size="xs" c="dimmed">
                        Escolha a categoria do Mercado Livre antes de publicar.
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
