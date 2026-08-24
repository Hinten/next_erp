'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useFormContext, useFormState } from 'react-hook-form';
import type { Firestore } from 'firebase/firestore';
import { FirebaseError } from 'firebase/app';
import { Alert, Anchor, Badge, Button, Group, Loader, Modal, Stack, Text } from '@mantine/core';
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
import { createListingDraft, removeListingDraft } from '@/lib/mercado-livre/listingDraft';
import { DEFAULT_LISTING_TYPE } from '@/lib/mercado-livre/listingFields';
import {
  estadoLabel,
  publishSummary,
  refMatchesIntegracao,
} from '@/lib/mercado-livre/listingLinks';
import { enviarEstoqueParaIntegracao } from '@/lib/marketplace/estoque/registry';
import type { StockPushIntegracao, StockPushRow } from '@/lib/marketplace/estoque/types';
import {
  resumoSalvarAnuncios,
  type ListingSaveOutcome,
} from '@/lib/mercado-livre/listingSaveOutcome';
import type { ListingSaveFn } from './ListingForm';
import { ContaPanel } from './ContaPanel';
import { ContaTabs } from './ContaTabs';
import { NovoAnuncioModal } from './NovoAnuncioModal';

/**
 * The produto editor's **Mercado Livre** tab: one card per registered ML account
 * (integração tipo 1) holding every listing that account has on this produto —
 * its live status, its editable fields, and the Publicar/Republicar action that
 * drives `POST /publicar` on the apps/mercado-livre backend.
 *
 * The link docs are read live and edited through their own transaction, so
 * listing edits are decoupled from the produto form's save — but they still ride
 * along with it, through the flush ref the page wires into `ObjectView`'s
 * `onAfterSave`. Live because the backend mutates these docs while the tab is
 * open: the `/publicar` route, the `items` status sync, and the price and stock
 * senders all write the same link doc.
 */

/** How many Mercado Livre accounts the tab strip will show. */
const MAX_CONTAS = 50;

/**
 * How many link docs the tab reads for one produto.
 *
 * ⚠️ Deliberately NOT `MAX_CONTAS`. The two used to be one constant, on the
 * reasoning that "they must match, or an account past the link-doc cap would
 * falsely render as 'Não publicado'" — which held only while a produto carried
 * at most one anúncio per account. It no longer does, so a shared bound of 50
 * would start dropping links well before the 50th account, and the failure is
 * silent in exactly the way that comment warned about: a listing that exists
 * renders as absent, and "Novo anúncio" offers to make another one.
 *
 * Four per account is generous for a real catalogue, and the alert below says so
 * out loud when the cap is actually reached rather than truncating quietly.
 */
const MAX_LINKS = MAX_CONTAS * 4;

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
  // `loading` is load-bearing: `usePermission` answers `allowed: false` WHILE it
  // loads, so without it the publish tooltip tells a fully-privileged operator
  // they lack permission on every page load (`publishDisabled.ts`).
  const { allowed: canPublish, loading: permLoading } = usePermission(PERM.integracao.write);
  // ⚠️ A DIFFERENT bit from the one above. Firestore gates a `produtoMercadoLivre`
  // doc by the parent produto's permissions (`subcollections.ts` copies
  // `produtoMeta.permissions` wholesale), so deleting a link doc needs
  // `d_produto` delete — not `integracao.write`, which governs the ML API calls.
  // Offering the control on the wrong bit would put the failure in the rules.
  const { allowed: canDelete } = usePermission(PERM.produto.delete);

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
    () => buildQuery(produtoMercadoLivreLinkCollection.ref(db, { produtoId }), [limit(MAX_LINKS)]),
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

  /**
   * The publish in flight, if any.
   *
   * Names the LISTING, not just the account: a produto can carry several
   * anúncios on one account, so a bare conta id would spin every one of their
   * buttons. `withPrices` narrows it further — the two publish actions share one
   * handler, and without it both of a listing's buttons would light up and leave
   * the operator unable to tell which is running.
   *
   * `contaId` rides along because the account-level gates still read it.
   */
  const [publishing, setPublishing] = useState<{
    contaId: string;
    linkDocId: string;
    withPrices: boolean;
  } | null>(null);
  /** The conta whose draft is being created, if any. */
  const [criando, setCriando] = useState<string | null>(null);
  /** The conta whose "Novo anúncio" dialog is open, if any. */
  const [novoAnuncioConta, setNovoAnuncioConta] = useState<string | null>(null);
  /** The link doc the operator is being asked to confirm removing, if any. */
  const [excluirAlvo, setExcluirAlvo] = useState<string | null>(null);
  /** The link doc whose delete is in flight, if any. */
  const [excluindo, setExcluindo] = useState<string | null>(null);
  /** The link doc id currently being re-checked against ML (#781), if any. */
  const [rechecking, setRechecking] = useState<string | null>(null);
  /** The link doc id whose public ML URL is being resolved, if any. */
  const [abrindoAnuncio, setAbrindoAnuncio] = useState<string | null>(null);
  /**
   * Listing URLs resolved from ML this session, keyed by link doc id.
   *
   * Only User-Products listings ever land here — a legacy one is a pure string
   * transform the strip does itself. It is component state and not a Firestore
   * field on purpose — see the ⚠️ in `apps/mercado-livre/lib/marketplace/anuncios/anuncioUrl.ts`: a persisted
   * URL is a cache that can go stale silently, and it costs one request to
   * resolve.
   */
  const [urlPorLink, setUrlPorLink] = useState<Record<string, string>>({});
  /** The conta whose stock push is in flight (#819), if any. */
  const [sendingStock, setSendingStock] = useState<string | null>(null);
  /**
   * The last push outcome per LISTING, keyed by link doc id. Rendered inline in
   * each anúncio block rather than as a toast, because a conta can hold several
   * listings on one produto and one toast could only describe one of them.
   */
  const [stockResultByLink, setStockResultByLink] = useState<Record<string, StockPushRow>>({});
  /**
   * 422 ML_PUBLISH_BLOCKED issue lists, keyed by LINK DOC id so they render
   * inline beside the listing that was refused instead of as a transient toast.
   *
   * Per listing rather than per account since publishing became per listing: a
   * 422 describes one publish, and keying it by conta painted every sibling
   * listing's fields red for a rejection that was never about them.
   */
  const [blockedIssues, setBlockedIssues] = useState<Record<string, string[]>>({});
  /** What "Novo anúncio" will use, per conta, while its dialog is open. */
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

  // Which listings are still loading the metadata their form is made of. Same
  // shape as `dirtyIds` above and for the same reason: the gate is per-account,
  // so account A's half-loaded attribute grid must not block a publish to B.
  const [loadingIds, setLoadingIds] = useState<ReadonlySet<string>>(() => new Set());
  const handleLoadingChange = useCallback((linkDocId: string, loading: boolean) => {
    setLoadingIds((prev) => {
      // Identity-preserving, exactly like `handleDirtyChange`: every ListingForm
      // reports on mount and on every query transition, and a fresh Set each
      // time is an infinite render loop.
      if (prev.has(linkDocId) === loading) return prev;
      const next = new Set(prev);
      if (loading) next.add(linkDocId);
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
  /**
   * Push this produto's price through the shared marketplace price rail (#804) —
   * the same `POST /enviar-precos` the produtos table's row action uses, not the
   * account-wide `atualizar-precos` job. Synchronous and bounded, so it reports a
   * per-listing outcome instead of a job id, and it cannot collide with a running
   * bulk job the way a second job-doc would.
   *
   * `baixarPreco: true` matches that rail's own default for a hand-picked
   * selection: naming the produto IS the explicit intent, and it is what the
   * legacy per-produto action did unconditionally.
   */
  async function pushPrices(integracaoId: string) {
    if (!client) return;
    try {
      const result = await client.enviarPrecos({
        integracaoId,
        produtoIds: [produtoId],
        baixarPreco: true,
      });
      // ⚠️ Per-listing failure is DATA on this rail, not an HTTP error: a 200 can
      // carry nothing but failures, so the toast has to read the envelope rather
      // than treat "no throw" as success.
      const { enviados, pulados, falhas } = result.resumo;
      const total = enviados + pulados + falhas;
      notifications.show({
        color: enviados > 0 ? 'green' : 'yellow',
        title: enviados > 0 ? 'Preços atualizados' : 'Nenhum preço enviado',
        message:
          total === 0
            ? 'Nenhum anúncio elegível para atualização de preço.'
            : `${enviados} de ${total} anúncio(s) — reduções incluídas.` +
              (falhas > 0 ? ` ${falhas} com falha.` : ''),
      });
    } catch (err) {
      if (err instanceof MercadoLivreClientHttpError) {
        notifications.show({
          color: 'yellow',
          title: 'Anúncio publicado, preços não',
          message: err.message,
        });
        return;
      }
      if (err instanceof MercadoLivreClientNetworkError) {
        notifications.show({
          color: 'yellow',
          title: 'Anúncio publicado, preços não',
          message: 'Não foi possível contatar o serviço do Mercado Livre.',
        });
        return;
      }
      throw err;
    }
  }

  /**
   * Create a draft listing for an account, from the "Novo anúncio" dialog.
   *
   * The `modo` is decided from what the account already holds, not from which
   * button was pressed — there is only one button now. An account with nothing
   * gets the deterministic, transaction-guarded first draft; one that already
   * has an anúncio gets a fresh auto-id, because a second listing is intent and
   * has nothing to be deduplicated against (`listingDraft.ts`).
   */
  async function handleNovoAnuncio(integracaoId: string) {
    setCriando(integracaoId);
    try {
      const jaTem = links.some((l) => refMatchesIntegracao(l.data.contaOuterRef, integracaoId));
      const { outcome } = await createListingDraft(db, produtoId, {
        integracaoId,
        produtoNome,
        listingTypeId: listingTypeByConta[integracaoId] ?? DEFAULT_LISTING_TYPE,
        nowMs: Date.now(),
        modo: jaTem ? 'adicional' : 'primeiro',
      });
      setNovoAnuncioConta(null);
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
      setCriando(null);
    }
  }

  /**
   * Remove a draft listing the operator confirmed.
   *
   * The guard lives in the transaction, not here: a publish landing between the
   * confirm opening and this call would make the listing live, and deleting it
   * then orphans a real Mercado Livre anúncio. `'published'` is that race,
   * caught — it is reported, not retried.
   */
  async function handleExcluirAnuncio(linkDocId: string) {
    setExcluindo(linkDocId);
    try {
      const outcome = await removeListingDraft(db, produtoId, linkDocId);
      setExcluirAlvo(null);
      // ⚠️ Drop the listing's 422 issues with the listing itself. `blockedIssues`
      // is keyed by link doc id and otherwise only cleared at the START of a
      // publish for that same id — and the FIRST draft on an account takes the
      // integração id as its doc id (deliberately; `listingDraft.ts`). So
      // publicar → 422 → excluir → novo anúncio lands the fresh draft on the
      // same key and greets the operator with a red "Publicação bloqueada" from
      // a publish that was never attempted on it, with its form fields painted
      // to match. Cosmetic, but exactly where they are deciding whether to
      // publish.
      if (outcome === 'removed') {
        setBlockedIssues((prev) => {
          if (!(linkDocId in prev)) return prev;
          const { [linkDocId]: _descartado, ...resto } = prev;
          return resto;
        });
      }
      if (outcome === 'published') {
        notifications.show({
          color: 'yellow',
          message: 'O anúncio foi publicado enquanto você confirmava — não foi excluído.',
        });
        return;
      }
      notifications.show({
        color: outcome === 'removed' ? 'green' : 'yellow',
        message: outcome === 'removed' ? 'Anúncio excluído.' : 'Este anúncio já não existe.',
      });
    } catch (err) {
      if (err instanceof FirebaseError) {
        notifications.show({ color: 'red', message: err.message });
        return;
      }
      throw err;
    } finally {
      setExcluindo(null);
    }
  }

  /**
   * Publish, optionally followed by a price push for THIS produto.
   *
   * The two are separate calls on purpose. A publish deliberately does not carry
   * prices — the PUT it sends per listing omits them (#798), so a republish to
   * fix a photo, a title or an attribute cannot silently bypass the price flow's
   * "Permitir baixar preços" guard, and cannot 400 on an item whose seller opted
   * it into ML's own price automation. `withPrices` is the operator saying they
   * meant the price too.
   */
  async function handlePublish(integracaoId: string, linkDocId: string, withPrices = false) {
    if (!client) return;
    setPublishing({ contaId: integracaoId, linkDocId, withPrices });
    setBlockedIssues((prev) => ({ ...prev, [linkDocId]: [] }));
    try {
      // ⚠️ `linkDocId` is what makes a SECOND anúncio on this account
      // publishable at all. Without it the backend resolves the account's first
      // link doc, so publishing the second would silently re-publish the first
      // (`publish.ts`). The route 404s an id this produto does not have or that
      // belongs to another account.
      //
      // `listingTypeId` is deliberately absent: every listing reaching this
      // point has a link doc, whose persisted `listing_type_id` the backend
      // prefers on a re-publish anyway. The parameter that used to sit here was
      // gated on a branch that only ever passed `false`.
      const result = await client.publicar({ integracaoId, produtoId, linkDocId });
      notifications.show({
        color: 'green',
        title: 'Publicado no Mercado Livre',
        message: publishSummary(result),
      });
      // Only after the publish SUCCEEDED: pricing a listing that failed to
      // publish either 404s or updates the stale version.
      if (withPrices) await pushPrices(integracaoId);
    } catch (err) {
      if (err instanceof MercadoLivreClientHttpError) {
        if (err.code === 'ML_PUBLISH_BLOCKED' && err.issues && err.issues.length > 0) {
          setBlockedIssues((prev) => ({ ...prev, [linkDocId]: err.issues! }));
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
   * Open this listing's public Mercado Livre page in a new tab, resolving the
   * URL from ML first — ported from the old Flutter screen's link button
   * (`cadastroProdutoMLNew.dart:134-156`).
   *
   * Only reached for a **User-Products** listing: its link doc holds a FAMILY
   * id, which addresses nothing public, so the strip has nothing to build an
   * href from. A legacy listing already renders a plain anchor.
   *
   * ⚠️ The tab is opened SYNCHRONOUSLY, before the await. A `window.open` that
   * runs after one has lost the user activation the click granted and is
   * popup-blocked — the one hazard the Flutter original never had to handle.
   * The blank tab is navigated once the URL lands, and closed if it never does.
   *
   * The answer is cached in `urlPorLink`, which turns the strip's control back
   * into an ordinary anchor — so this runs at most once per listing, and a
   * browser that refused the tab outright (`aba == null`) still leaves the
   * operator that anchor to click.
   */
  async function handleAbrirAnuncio(integracaoId: string, linkDocId: string) {
    if (!client) return;
    const aba = window.open('', '_blank');
    setAbrindoAnuncio(linkDocId);
    try {
      const { url } = await client.linkAnuncio({ integracaoId, produtoId, linkDocId });
      setUrlPorLink((prev) => ({ ...prev, [linkDocId]: url }));
      abrir(aba, url);
    } catch (err) {
      aba?.close();
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
      setAbrindoAnuncio(null);
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

  /**
   * Editor-wide data the write actions depend on that has NOT arrived.
   *
   * `contasSnap`/`linksSnap` are absent on purpose — the early return below
   * means we never render at all while those two load. These three do not stop
   * a render: the produto doc (`fotos`/`nome`/`ehUsado`), its extraData
   * (`condicao`, the second input to `resolveCondicaoAnuncio`) and the tenant
   * claims all resolve AFTER the buttons are on screen, which is the window a
   * publish could previously be fired in.
   */
  /**
   * The accounts, in the order their tabs appear.
   *
   * Sorted by name here rather than with an `orderBy` on the query: the rows are
   * already in memory and bounded at `MAX_CONTAS`, so a client-side sort costs
   * nothing and leaves the live query untouched. Without it the strip inherits
   * Firestore's doc-id order — invisible when the cards were stacked, arbitrary
   * as a row of tabs.
   */
  const contasOrdenadas = useMemo(
    () => [...contas].sort((a, b) => a.data.nome.localeCompare(b.data.nome, 'pt-BR')),
    [contas],
  );
  const contasPorId = useMemo(
    () => new Map(contasOrdenadas.map((c) => [c.id, c])),
    [contasOrdenadas],
  );

  /**
   * Each account's link docs, grouped once instead of re-filtered per render of
   * every panel. Accounts with no anúncio are absent, not empty — the panel
   * falls back to `[]`.
   */
  const linksPorConta = useMemo(() => {
    const porConta = new Map<string, { id: string; data: ProdutoMercadoLivreLink }[]>();
    for (const conta of contasOrdenadas) {
      // The stock sweep loops EVERY listing this conta holds on the produto
      // (bulkEstoquePlan's link join deliberately has no `limit(1)`), so
      // rendering only the first one hid a latched sibling completely (#781).
      const doConta = links.filter((l) => refMatchesIntegracao(l.data.contaOuterRef, conta.id));
      if (doConta.length > 0) porConta.set(conta.id, doConta);
    }
    return porConta;
  }, [contasOrdenadas, links]);

  const tabItems = useMemo(
    () =>
      contasOrdenadas.map((conta) => {
        const doConta = linksPorConta.get(conta.id) ?? [];
        return {
          id: conta.id,
          label: conta.data.nome,
          badge:
            doConta.length === 0 ? (
              <Badge color="gray" variant="light" size="sm">
                Não publicado
              </Badge>
            ) : doConta.length > 1 ? (
              <Badge color="gray" variant="light" size="sm">
                {doConta.length}
              </Badge>
            ) : undefined,
          // With one account on screen at a time, an unsaved edit can sit behind
          // a tab the operator is not looking at — and the produto's own save
          // would report a failure pointing at a tab they are already on. The
          // mark is what makes that edit findable.
          dirty: doConta.some((l) => dirtyIds.has(l.id)),
        };
      }),
    [contasOrdenadas, linksPorConta, dirtyIds],
  );

  /**
   * Which account opens first: the first one that already has an anúncio on this
   * produto, else the first account. Opening the tab onto a live listing beats
   * opening it onto whichever account happens to sort first and has nothing.
   */
  const contaInicial = useMemo(
    () => contasOrdenadas.find((c) => linksPorConta.has(c.id))?.id ?? null,
    [contasOrdenadas, linksPorConta],
  );

  const carregandoGeral = produtoSnap.loading || extraDataSnap.loading || permLoading;

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
          {/* The alert `MAX_LINKS` exists for. Splitting the bound stopped the
              cap being reached at 50 links, but a cap reached is still a cap:
              past it the tail is dropped, an account whose anúncios all landed
              there reads "Não publicado", and "Novo anúncio" offers to make
              another. Saying so is the difference between a limit and a lie. */}
          {links.length >= MAX_LINKS && (
            <Alert color="yellow" variant="light" data-testid="ml-limite-anuncios">
              Este produto tem {MAX_LINKS} anúncios ou mais. A lista abaixo está truncada — nem
              todos aparecem, e uma conta pode aparecer como não publicada mesmo tendo anúncio.
            </Alert>
          )}
          <ContaTabs
            items={tabItems}
            defaultId={contaInicial}
            renderPanel={(contaId) => {
              const conta = contasPorId.get(contaId);
              if (!conta) return null;
              return (
                <ContaPanel
                  produtoId={produtoId}
                  db={db}
                  conta={{
                    id: conta.id,
                    nome: conta.data.nome,
                    tipo: conta.data.tipo,
                    ativo: conta.data.ativo !== false,
                  }}
                  contaLinks={linksPorConta.get(contaId) ?? []}
                  produtoNome={produtoNome}
                  produtoEhUsado={produtoEhUsado}
                  produtoCondicao={produtoCondicao}
                  produtoFotoCount={produtoFotoCount}
                  produtoDirty={produtoDirty}
                  carregandoGeral={carregandoGeral}
                  canPublish={canPublish}
                  hasClient={client != null}
                  disabled={disabled}
                  dirtyIds={dirtyIds}
                  loadingIds={loadingIds}
                  issuesByLink={blockedIssues}
                  stockResultByLink={stockResultByLink}
                  urlPorLink={urlPorLink}
                  rechecking={rechecking}
                  abrindoAnuncio={abrindoAnuncio}
                  publishing={publishing}
                  savingConta={savingConta}
                  sendingStock={sendingStock}
                  criando={criando}
                  onPublish={(cId, linkDocId, withPrices) =>
                    void handlePublish(cId, linkDocId, withPrices)
                  }
                  onNovoAnuncio={setNovoAnuncioConta}
                  onExcluirAnuncio={canDelete ? setExcluirAlvo : undefined}
                  excluindo={excluindo}
                  onSalvarAnuncios={(cId, linkIds) => void handleSalvarAnuncios(cId, linkIds)}
                  onEnviarEstoque={(alvo, temLatch) => void handleEnviarEstoque(alvo, temLatch)}
                  onReverificar={handleReverificar}
                  onAbrirAnuncio={(integracaoId, linkDocId) =>
                    void handleAbrirAnuncio(integracaoId, linkDocId)
                  }
                  onDirtyChange={handleDirtyChange}
                  onLoadingChange={handleLoadingChange}
                  registerFlush={registerFlush}
                />
              );
            }}
          />
          {novoAnuncioConta != null && (
            <NovoAnuncioModal
              opened
              onClose={() => setNovoAnuncioConta(null)}
              contaNome={contasPorId.get(novoAnuncioConta)?.data.nome ?? ''}
              adicional={linksPorConta.has(novoAnuncioConta)}
              listingTypeId={listingTypeByConta[novoAnuncioConta] ?? DEFAULT_LISTING_TYPE}
              onListingTypeChange={(v) =>
                setListingTypeByConta((prev) => ({ ...prev, [novoAnuncioConta]: v }))
              }
              onConfirm={() => void handleNovoAnuncio(novoAnuncioConta)}
              criando={criando === novoAnuncioConta}
            />
          )}
          {/* Immediate on confirm, not staged behind the produto's save. This tab
              is self-contained — its documents are created and written directly,
              never through the produto form — so a delete that waited for
              "Salvar alterações" would disagree with the create beside it.
              `MacrosTab` is the in-repo precedent. */}
          <Modal
            opened={excluirAlvo != null}
            onClose={() => setExcluirAlvo(null)}
            title="Excluir anúncio"
            centered
          >
            <Stack gap="md">
              <Text size="sm">
                Este anúncio nunca foi publicado no Mercado Livre. Excluí-lo remove apenas o
                rascunho deste produto.
              </Text>
              <Group justify="flex-end" gap="sm">
                <Button
                  type="button"
                  variant="default"
                  onClick={() => setExcluirAlvo(null)}
                  disabled={excluindo != null}
                >
                  Cancelar
                </Button>
                <Button
                  type="button"
                  color="red"
                  onClick={() => excluirAlvo && void handleExcluirAnuncio(excluirAlvo)}
                  loading={excluindo != null}
                >
                  Excluir
                </Button>
              </Group>
            </Stack>
          </Modal>
        </Stack>
      )}
    </OuterFormDirty>
  );
}

/**
 * Send a tab that was opened synchronously at click time to its destination.
 *
 * `window.open('', '_blank')` cannot carry `noopener`: that flag makes it return
 * null, and the handle is exactly what is needed to navigate the tab once the
 * URL arrives. The opener link is therefore severed by hand, before the
 * destination loads.
 */
function abrir(aba: Window | null, url: string): void {
  if (!aba) return;
  aba.opener = null;
  aba.location.replace(url);
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
