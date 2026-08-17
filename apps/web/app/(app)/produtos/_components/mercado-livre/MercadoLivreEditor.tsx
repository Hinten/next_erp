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
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { PERM } from '@delfrance/auth';
import {
  INTEGRACAO_TIPO,
  PRODUTO_EXTRA_DATA_DOC_ID,
  type ProdutoMercadoLivreLink,
} from '@delfrance/schemas';
import { buildQuery, limit, whereEqual } from '@delfrance/data';
import { useDocSnapshot, useSnapshot } from '@delfrance/data/hooks';

import { usePermission } from '@/lib/auth';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { produtoExtraDataCollection } from '@/lib/data/produtoExtraDataCollection';
import { produtoMercadoLivreLinkCollection } from '@/lib/data/produtoMercadoLivreLinkCollection';
import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
  useMercadoLivreClient,
} from '@/lib/mercado-livre/client';
import { flushListings } from '@/lib/mercado-livre/flushListings';
import { publishDisabledReason } from '@/lib/mercado-livre/publishDisabled';
import { createListingDraft } from '@/lib/mercado-livre/listingDraft';
import { DEFAULT_LISTING_TYPE, LISTING_TYPE_OPTIONS } from '@/lib/mercado-livre/listingFields';
import {
  estadoLabel,
  isStockLatched,
  refMatchesIntegracao,
} from '@/lib/mercado-livre/listingLinks';
import { enviarEstoqueParaIntegracao } from '@/lib/marketplace/estoque/registry';
import type { StockPushIntegracao, StockPushRow } from '@/lib/marketplace/estoque/types';
import { ListingDetails } from './ListingDetails';
import {
  resumoSalvarAnuncios,
  type ListingSaveOutcome,
} from '@/lib/mercado-livre/listingSaveOutcome';
import { ListingForm, type ListingSaveFn } from './ListingForm';
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
  // The listing's condição is derived from this, not edited per listing. Read
  // from the SAVED doc deliberately: publish sends the saved produto, so showing
  // an unsaved toggle would promise a value publish would not use — the same
  // reason the card already warns "a publicação envia os dados salvos".
  const produtoEhUsado = produtoSnap.data?.data.ehUsado ?? false;
  // ⚠️ `extraData.condicao` is the SECOND input publish resolves the condition
  // from (`resolveCondicaoAnuncio`), and it lives in its own singleton
  // subcollection — nothing about it is derivable from the produto doc. Without
  // it this tab showed "Novo" for a produto marked **Recondicionado** two tabs
  // away while the first publish sent `used`. Memoized for the same reason as
  // `produtoDocRef`: `docRef()` returns a fresh object per call, which would
  // re-subscribe the listener on every render.
  const extraDataRef = useMemo(
    () => produtoExtraDataCollection.docRef(db, { produtoId }, PRODUTO_EXTRA_DATA_DOC_ID),
    [db, produtoId],
  );
  const extraDataSnap = useDocSnapshot(extraDataRef);
  // null while loading, so the derivation falls through to the next tier rather
  // than asserting "novo" for a beat and flipping.
  const produtoCondicao = extraDataSnap.data?.data.condicao ?? null;

  const [publishing, setPublishing] = useState<string | null>(null);
  /** The conta whose draft is being created, if any. */
  const [preparing, setPreparing] = useState<string | null>(null);
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

  // Each listing form registers ONE save closure, invoked with the mode that
  // decides how a failure is reported: `'flush'` throws `AfterSaveBlockedError`
  // for `ObjectView`'s `onAfterSave`, `'button'` notifies and swallows.
  const flushesRef = useRef(new Map<string, ListingSaveFn>());
  const registerFlush = useCallback((linkDocId: string, save: ListingSaveFn | null) => {
    if (save) flushesRef.current.set(linkDocId, save);
    else flushesRef.current.delete(linkDocId);
  }, []);

  useEffect(() => {
    if (!flushRef) return;
    flushRef.current = () =>
      flushListings([...flushesRef.current.values()].map((save) => () => save('flush')));
    const ref = flushRef;
    return () => {
      ref.current = null;
    };
  }, [flushRef]);

  /** The conta whose "Salvar anúncio" is in flight, if any. */
  const [savingConta, setSavingConta] = useState<string | null>(null);

  /**
   * Save every dirty listing in ONE conta card.
   *
   * Per-card rather than per-listing because the button now sits beside
   * Publicar, which is itself a conta-level action — and a conta can hold several
   * listings on one produto (#781), so a single button that saved only the first
   * would silently discard edits to the others.
   *
   * `'button'` mode: each form reports its own failure (notification or conflict
   * modal) and does not throw, so one conflict cannot abandon a sibling's save.
   *
   * ⚠️ …with ONE exception, and it is why the outcomes are collected. A listing
   * whose fields are invalid returns silently — its errors render inline, above
   * this button. Driving N listings from one click means listing A can be skipped
   * that way while listing B fires an unqualified green "Anúncio salvo." for the
   * same click, so the operator reads success for a save that did half the job.
   * A per-listing button could not produce that; a conta-level one can, so the
   * shortfall has to be said out loud.
   */
  const handleSalvarAnuncios = useCallback(async (contaId: string, linkIds: readonly string[]) => {
    setSavingConta(contaId);
    try {
      const outcomes: ListingSaveOutcome[] = [];
      for (const linkId of linkIds) {
        const save = flushesRef.current.get(linkId);
        if (save) outcomes.push(await save('button'));
      }
      const resumo = resumoSalvarAnuncios(outcomes);
      if (resumo) notifications.show({ color: resumo.color, message: resumo.message });
    } finally {
      setSavingConta(null);
    }
  }, []);

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
        listingTypeId: listingTypeByConta[integracaoId] ?? DEFAULT_LISTING_TYPE,
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
          ? { listingTypeId: listingTypeByConta[integracaoId] ?? DEFAULT_LISTING_TYPE }
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
            // ⚠️ At least one PUBLISHED listing, not merely a link doc. A draft from
            // "Preparar anúncio" has `id == null`, and the stock push has nothing to
            // send for it — the backend answers `sem-id-externo` / "O anúncio ainda
            // não foi publicado no Mercado Livre". Offering the button there is a
            // guaranteed no-op dressed as an action. `some`, not `every`, so a conta
            // holding one published listing and one draft keeps the button.
            //
            // ⚠️ Empty string counts as NOT published, matching the backend
            // exactly: `bulkEstoquePlan` takes `link.id !== ''` as its test and
            // answers `sem-item-id` otherwise. The schema permits `''` —
            // `id: z.string().nullable().default(null)` carries no `.min(1)` — and
            // the Flutter app is a live concurrent writer to these same docs, so
            // a `!= null` check leaves the same dead button one value narrower.
            const hasPublished = contaLinks.some((l) => (l.data.id ?? '') !== '');
            const issues = blockedIssues[conta.id] ?? [];
            const dirtyLinkIds = contaLinks.filter((l) => dirtyIds.has(l.id)).map((l) => l.id);
            const contaDirty = dirtyLinkIds.length > 0;
            const publishBlocked = produtoDirty || contaDirty;
            // Publish refuses a create with no category ("categoria do Mercado
            // Livre não definida"). Saying so here beats a round trip that comes
            // back as a 422 the operator has to read.
            const missingCategoria = primary != null && (primary.category_id ?? '') === '';
            // One place decides both whether Publicar is disabled and what the
            // tooltip says, so the two can never disagree — the previous shape
            // had the conditions inline and the explanations in three separate
            // `<Text>` blocks that covered only half of them.
            const publishReason = publishDisabledReason({
              disabled: Boolean(disabled),
              canPublish,
              hasClient: client != null,
              publishingThisConta: publishing === conta.id,
              publishingOtherConta: publishing !== null && publishing !== conta.id,
              produtoDirty,
              contaDirty,
              missingCategoria,
            });

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
                      {/* The read-only publication facts come BEFORE the editable
                          form: they are what the operator opens the tab to check
                          (is it live? at what price? what did ML reject?), and
                          they were previously buried under a long form. */}
                      <ListingDetails link={l.data} produtoFotoCount={produtoFotoCount} />
                      <ListingForm
                        produtoId={produtoId}
                        linkDocId={l.id}
                        integracaoId={conta.id}
                        produtoNome={produtoNome}
                        produtoEhUsado={produtoEhUsado}
                        produtoCondicao={produtoCondicao}
                        link={l.data}
                        db={db}
                        canWrite={canPublish}
                        disabled={disabled}
                        onDirtyChange={handleDirtyChange}
                        registerFlush={registerFlush}
                      />
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
                    {contaDirty && (
                      // Beside Publicar on purpose: saving the anúncio and
                      // publishing it are the two halves of one decision, and this
                      // button previously sat at the far end of a long form where
                      // it read as unrelated to the action group.
                      //
                      // ⚠️ Gated on `contaDirty` (derived from `dirtyIds`), NOT on
                      // the form's RHF `isDirty` as the old button was. `dirtyIds`
                      // is fed by `onDirtyChange(id, isDirty || attrDirty)`, so an
                      // ATTRIBUTE-only edit now enables it — previously that edit
                      // left the only save button greyed out and reachable solely
                      // through the produto's own "Salvar alterações".
                      <Button
                        type="button"
                        variant="light"
                        onClick={() => void handleSalvarAnuncios(conta.id, dirtyLinkIds)}
                        loading={savingConta === conta.id}
                        disabled={disabled || !canPublish || savingConta !== null}
                      >
                        {/* Plural counts the listings it will actually SAVE, not
                            the listings in the card — "Salvar anúncios" beside a
                            card holding two listings of which one is dirty would
                            promise more than the click does. */}
                        {dirtyLinkIds.length > 1 ? 'Salvar anúncios' : 'Salvar anúncio'}
                      </Button>
                    )}
                    {hasPublished && (
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
                    {needsListingType ? (
                      <>
                        <Select
                          label="Tipo de anúncio"
                          data={[...LISTING_TYPE_OPTIONS]}
                          value={listingTypeByConta[conta.id] ?? DEFAULT_LISTING_TYPE}
                          onChange={(v) =>
                            setListingTypeByConta((prev) => ({
                              ...prev,
                              [conta.id]: v ?? DEFAULT_LISTING_TYPE,
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
                      // ⚠️ The <span> is load-bearing: Mantine turns pointer
                      // events OFF on a disabled button, so a Tooltip wrapping it
                      // directly never fires. Wrapping an inline-block element
                      // instead is the idiom that works — see `PermGate`.
                      // ⚠️ A wrapper does not change the button's accessible name
                      // (`Publicar no Mercado Livre` / `Republicar`), which the
                      // vendas e2e locates by role+name. An `aria-label` here
                      // would silently break it.
                      <Tooltip
                        label={publishReason}
                        disabled={publishReason == null}
                        withArrow
                        position="bottom"
                        multiline
                        w={260}
                      >
                        <span style={{ display: 'inline-block' }}>
                          <Button
                            type="button"
                            variant={isFirstPublish ? 'filled' : 'light'}
                            onClick={() => handlePublish(conta.id, false)}
                            loading={publishing === conta.id}
                            disabled={publishReason != null}
                          >
                            {isFirstPublish ? 'Publicar no Mercado Livre' : 'Republicar'}
                          </Button>
                        </span>
                      </Tooltip>
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
