'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Center, Group, Loader, SimpleGrid, Stack } from '@mantine/core';
import { getDoc } from 'firebase/firestore';
import { FirebaseError } from 'firebase/app';
import { useSearchParams } from 'next/navigation';
import { flattenPedidoItens, type EstadoFrete, type ScanLogEntry } from '@delfrance/schemas';
import { PERM } from '@delfrance/auth';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth, usePermission } from '@/lib/auth';
import { useNFeClient } from '@/lib/nfe/client';
import { useFreightClient } from '@/lib/freight/client';
import { useLojaIntegradaClient } from '@/lib/loja-integrada/client';
import { conferirAntesDeDespacharLi } from '@/lib/loja-integrada/conferenciaDespacho';
import type { ConferenciaLiCarregada } from '@/lib/loja-integrada/conferenciaPagamento';
import { preverRotaEtiquetaLi } from '@/lib/loja-integrada/rotaEtiqueta';
import { useMercadoLivreClient } from '@/lib/mercado-livre/client';
import { useShopeeClient } from '@/lib/shopee/client';
import { useEscolherEnvio } from '@/components/etiqueta/EscolherEnvioDialog';
import {
  showCopyableNotification,
  showErrorNotification,
} from '@/lib/notifications/showErrorNotification';
import { pedidoCollection } from '@/lib/data/pedidoCollection';
import {
  CheckoutPedidoNotFoundError,
  findPedidoCandidates,
  loadCheckoutData,
  type PedidoCandidate,
} from '@/lib/checkout/loadPedidoCheckout';
import {
  CheckoutSaveError,
  evaluatePreSave,
  salvarCheckoutTransacao,
  type ConfirmKind,
} from '@/lib/checkout/saveCheckout';
import { avisoDeEtiquetaAntesDoCheckoutLi } from '@/lib/checkout/conferenciaLojaIntegrada';
import { runCheckoutPostSave, type PostSaveResult } from '@/lib/checkout/postSave';
import type { EtiquetaProviderUi } from '@/lib/checkout/etiqueta/types';

import { useCheckoutReducer } from './useCheckoutReducer';
import { useScanPipeline } from './useScanPipeline';
import { useConfirm } from './useConfirm';
import { useComprarEtiquetaBridge } from './useComprarEtiquetaBridge';
import { PedidoFinder } from './PedidoFinder';
import { PedidoHeader } from './PedidoHeader';
import { CheckoutBanners } from './CheckoutBanners';
import { ScanInput } from './ScanInput';
import { ScanLogPane } from './ScanLogPane';
import { ExpectedPane } from './ExpectedPane';
import { BottomBar } from './BottomBar';
import { CheckoutSidebar } from './CheckoutSidebar';
import type { CheckoutFixture } from './fixtures';

export interface CheckoutScreenProps {
  /** Optional in-memory data seam (PR 7 harness); omitted in production. */
  fixture?: CheckoutFixture;
}

/**
 * The checkout screen orchestrator. Owns the single reducer + the scan pipeline
 * and wires the async flows library (load / save / post-save) to the UI. Every
 * async op carries the epoch it started under (see `checkoutReducer`), so a
 * pedido swap mid-flight is a no-op.
 */
export function CheckoutScreen({ fixture }: CheckoutScreenProps) {
  const db = getFirebaseFirestore();
  const { user } = useAuth();
  // Saving a checkout writes pedidos/{id}/checkout + advances the pedido — a
  // pedido.write action. The route only gates read (an operator must load/view
  // a pedido); the write action gates here, mirroring PedidoForm's Save button.
  const { allowed: canWrite } = usePermission(PERM.pedido.write);
  const nfeClient = useNFeClient();
  const freightClient = useFreightClient();
  const mercadoLivreClient = useMercadoLivreClient();
  const shopeeClient = useShopeeClient();
  // The Loja Integrada paid re-check asks it: the save's own gate below, and
  // the soft gates (reprint, generic label) of the post-save.
  const lojaIntegradaClient = useLojaIntegradaClient();

  const { state, dispatch, bumpEpoch, currentEpoch } = useCheckoutReducer();
  // What Salvar is waiting on, when it is not the save itself (the Loja
  // Integrada paid re-check can take a cold start plus a paced read).
  const [statusSalvar, setStatusSalvar] = useState<string | null>(null);
  // Latest state for the async handlers (avoids stale closures without re-binding).
  // Updated post-commit; handlers run after commit, so they always read the latest.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  const { enqueueScan, resetQueue } = useScanPipeline({
    db,
    currentEpoch,
    getIndex: () => stateRef.current.scanIndex,
    dispatch,
  });

  const confirmDialog = useConfirm();
  const comprarBridge = useComprarEtiquetaBridge(state.pedido);
  // The Shopee pickup/drop-off question (#1523). Its element renders at the
  // screen root below, beside the confirm — never inside another `<Modal>`
  // (see `useConfirm`'s `element` doc for the wedge that causes).
  const envioDialog = useEscolherEnvio();

  const finderRef = useRef<HTMLInputElement>(null);
  const scanRef = useRef<HTMLInputElement>(null);

  // ── Load ──────────────────────────────────────────────────────────────────
  const loadPedido = useCallback(
    async (pedidoId: string) => {
      const epoch = bumpEpoch();
      resetQueue(epoch);
      dispatch({ type: 'load/start', epoch, pedidoId });
      try {
        const data = fixture ? await fixture.load(pedidoId) : await loadCheckoutData(db, pedidoId);
        dispatch({ type: 'load/success', epoch, data });
      } catch (err) {
        if (err instanceof CheckoutPedidoNotFoundError) {
          dispatch({ type: 'load/error', epoch, message: `Pedido ${pedidoId} não encontrado.` });
        } else if (err instanceof FirebaseError) {
          dispatch({ type: 'load/error', epoch, message: 'Erro ao carregar o pedido.' });
          showErrorNotification({ title: 'Erro ao carregar', message: err.message });
        } else {
          throw err;
        }
      }
    },
    [db, fixture, bumpEpoch, resetQueue, dispatch],
  );

  // ── Finder ──────────────────────────────────────────────────────────────────
  const handleFind = useCallback(
    async (text: string) => {
      dispatch({ type: 'finder/busy', busy: true });
      try {
        const result = fixture?.find
          ? await fixture.find(text)
          : await findPedidoCandidates(db, text);
        if (result.kind === 'none') {
          dispatch({ type: 'finder/busy', busy: false });
          showErrorNotification({
            title: 'Pedido não encontrado',
            message: `Nenhum pedido de saída corresponde a "${text}".`,
          });
        } else if (result.kind === 'one') {
          dispatch({ type: 'finder/busy', busy: false });
          await loadPedido(result.candidate.id);
        } else {
          dispatch({ type: 'finder/many', candidates: result.candidates });
        }
      } catch (err) {
        dispatch({ type: 'finder/busy', busy: false });
        if (err instanceof FirebaseError) {
          showErrorNotification({ title: 'Erro ao buscar', message: err.message });
        } else {
          throw err;
        }
      }
    },
    [db, fixture, loadPedido, dispatch],
  );

  const handlePick = useCallback(
    (candidate: PedidoCandidate) => {
      dispatch({ type: 'finder/dismiss' });
      void loadPedido(candidate.id);
    },
    [loadPedido, dispatch],
  );

  // ── Scan / delete / clear / reload ──────────────────────────────────────────
  const handleDelete = useCallback(
    (uid: string) => dispatch({ type: 'scan/delete', entryUid: uid, nowMs: Date.now() }),
    [dispatch],
  );

  const handleClear = useCallback(() => {
    const epoch = bumpEpoch();
    resetQueue(epoch);
    dispatch({ type: 'clear', epoch });
    scanRef.current?.focus();
  }, [bumpEpoch, resetQueue, dispatch]);

  const handleReload = useCallback(() => {
    const { pedidoId } = stateRef.current;
    if (pedidoId) void loadPedido(pedidoId);
  }, [loadPedido]);

  // ── Etiqueta provider UI (injected into runCheckoutPostSave) ─────────────────
  const ui = useMemo<EtiquetaProviderUi>(
    () => ({
      confirmRisk: (msg) =>
        confirmDialog.confirm({
          title: 'Atenção',
          message: msg,
          confirmLabel: 'Continuar',
          danger: true,
        }),
      notify: (n) =>
        showCopyableNotification({
          title: n.title,
          message: n.message,
          color: (n.color as never) ?? 'blue',
        }),
      openUrl: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
      comprarEtiqueta: comprarBridge.comprarEtiqueta,
      escolherEnvio: envioDialog.escolherEnvio,
      // The acknowledged-risk question of the Loja Integrada soft gates: the
      // SAME dialog, with its "Estou ciente do risco" tick required.
      confirmarCiente: ({ titulo, mensagem }) =>
        confirmDialog.confirm({
          title: titulo,
          message: mensagem,
          confirmLabel: 'Continuar',
          cancelLabel: 'Cancelar',
          danger: true,
          ciencia: true,
        }),
    }),
    [confirmDialog, comprarBridge.comprarEtiqueta, envioDialog.escolherEnvio],
  );

  const reportPostSave = useCallback((post: PostSaveResult) => {
    // NF-e
    if (!post.nfe.ok && post.nfe.pending) {
      showCopyableNotification({
        title: 'NF-e',
        message: 'NF-e em processamento — reimprima pelo painel quando aprovada.',
        color: 'yellow',
      });
    } else if (!post.nfe.ok) {
      showErrorNotification(post.nfe.notification);
    }
    // DANFE
    if (post.danfe && typeof post.danfe === 'object' && 'notification' in post.danfe) {
      showErrorNotification(post.danfe.notification);
    } else if (post.danfe === 'downloaded') {
      showCopyableNotification({
        title: 'DANFE',
        message: 'Impressora indisponível — DANFE baixado.',
        color: 'blue',
      });
    }
    // Etiqueta
    const et = post.etiqueta;
    if (et && 'status' in et) {
      if (et.status === 'error') {
        showErrorNotification({ title: 'Etiqueta', message: et.message });
      } else if (et.status === 'unsupported') {
        showCopyableNotification({ title: 'Etiqueta', message: et.reason, color: 'yellow' });
      } else if (et.status === 'needs-quote') {
        showCopyableNotification({
          title: 'Etiqueta',
          message: 'Selecione um serviço de frete no pedido antes de gerar a etiqueta.',
          color: 'yellow',
        });
      }
    }
  }, []);

  // ── Save ─────────────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    const snap = stateRef.current;
    const { pedido, pedidoId, engine, itens, existingCheckout, produtos } = snap;
    if (!pedido || !pedidoId || !engine || !user || snap.saving) return;
    dispatch({ type: 'save/start' });

    try {
      // 1. Fresh re-fetch for the gates + tx re-validation baseline.
      const freshSnap = await getDoc(pedidoCollection.docRef(db, {}, pedidoId));
      const freshData = freshSnap.exists() ? freshSnap.data() : null;
      const fresh = freshData
        ? {
            estado: freshData.estado,
            numero: freshData.numero,
            freteInicial: freshData.freteInicial,
            // The marketplace dispute overlay (#1322) — server-owned, written
            // by the `onIncidenteBloqueioSync` trigger.
            disputaAbertaEm: freshData.disputaAbertaEm,
            bloqueiosLiberados: freshData.bloqueiosLiberados,
          }
        : null;
      const freshItens = freshData ? flattenPedidoItens(freshData.itens) : [];

      // 2. Gate confirm-loop.
      const confirmed = new Set<ConfirmKind>();
      let estadoContinuar: EstadoFrete | null = null;
      const log: readonly ScanLogEntry[] = engine.log;
      for (;;) {
        const result = evaluatePreSave({
          loaded: { estado: pedido.estado, itens, freteInicial: pedido.freteInicial },
          fresh,
          freshItens,
          expected: engine.expected,
          log,
          produtos,
          existingCheckout,
          confirmed,
        });
        if (result.ok) {
          estadoContinuar = result.estadoContinuar;
          break;
        }
        if (result.decision === 'block') {
          showErrorNotification({ title: result.title, message: result.message });
          return;
        }
        // decision === 'confirm'
        const confirmedOk = await confirmDialog.confirm({
          title: result.title,
          message: result.message,
        });
        if (!confirmedOk) return;
        confirmed.add(result.kind);
      }

      // 2b. An order imported from Loja Integrada (master plan step 15) —
      // AFTER the loop's last dialog, so the paid answer is as fresh as it can
      // be when the transaction commits, and BEFORE it: the check is a network
      // read, and a transaction callback must never hold one. Any other pedido
      // reads and calls nothing here (the identity hash says no).
      let conferenciaLi: ConferenciaLiCarregada | null = null;
      if (freshData) {
        // (1) The read-only preview of the label route: warn while the stock
        // has not left yet that the label will be refused after the save.
        const avisoEtiqueta = await avisoDeEtiquetaAntesDoCheckoutLi({
          pedidoId,
          pedido: freshData,
          prever: (p) => preverRotaEtiquetaLi(db, p),
        });
        if (avisoEtiqueta !== null) {
          const seguir = await confirmDialog.confirm({
            title: 'Etiqueta',
            message: avisoEtiqueta,
            confirmLabel: 'Continuar',
          });
          if (!seguir) return;
        }
        // (2) Gate (i), the paid re-check: a verdict that does not authorise
        // dispatch blocks; one that cannot be verified asks; a `pago` rides the
        // post-save so the label's own gate does not ask again.
        setStatusSalvar('Conferindo pagamento na Loja Integrada…');
        let conferencia: Awaited<ReturnType<typeof conferirAntesDeDespacharLi>>;
        try {
          conferencia = await conferirAntesDeDespacharLi({
            client: lojaIntegradaClient,
            pedidoId,
            pedido: freshData,
            gate: 'checkout',
          });
        } finally {
          setStatusSalvar(null);
        }
        if (conferencia.acao === 'bloquear') {
          showErrorNotification({
            title: 'Pagamento não confirmado na Loja Integrada',
            message: conferencia.mensagem,
          });
          return;
        }
        if (conferencia.acao === 'confirmar') {
          const seguir = await confirmDialog.confirm({
            title: 'Atenção',
            message: conferencia.mensagem,
            confirmLabel: 'Continuar',
            danger: true,
          });
          if (!seguir) return;
        } else {
          conferenciaLi = conferencia.conferenciaLi;
        }
      }

      // 3. Transaction.
      try {
        await salvarCheckoutTransacao(db, {
          pedidoId,
          uid: user.uid,
          log,
          estadoContinuar,
          nowMs: Date.now(),
        });
      } catch (err) {
        if (err instanceof CheckoutSaveError) {
          showErrorNotification({ title: 'Não foi possível salvar', message: err.message });
          return;
        }
        throw err;
      }

      showCopyableNotification({
        title: 'Checkout salvo',
        message: `Pedido ${pedido.numero ?? pedidoId} conferido com sucesso.`,
        color: 'green',
      });

      // 4. Post-save (NF-e DANFE + etiqueta) — best-effort; the checkout is committed.
      try {
        const post = await runCheckoutPostSave({
          db,
          nfeClient,
          freightClient,
          mercadoLivreClient,
          shopeeClient,
          lojaIntegradaClient,
          pedido,
          pedidoId,
          formatoDanfe: snap.formatoDanfe,
          formatoEtiqueta: snap.formatoEtiqueta,
          ui,
          conferenciaLi,
        });
        reportPostSave(post);
      } catch (err) {
        if (err instanceof FirebaseError) {
          showErrorNotification({ title: 'Pós-salvamento', message: err.message });
        } else {
          throw err;
        }
      }

      // 5. Reset the screen + focus the finder for the next pedido.
      const epoch = bumpEpoch();
      resetQueue(epoch);
      dispatch({ type: 'reset', epoch });
      finderRef.current?.focus();
    } finally {
      dispatch({ type: 'save/done' });
    }
  }, [
    db,
    user,
    nfeClient,
    freightClient,
    mercadoLivreClient,
    shopeeClient,
    lojaIntegradaClient,
    ui,
    confirmDialog,
    reportPostSave,
    bumpEpoch,
    resetQueue,
    dispatch,
  ]);

  // ── Deep link (?pedido=<id|numero>) — resolve once on mount ──────────────────
  const searchParams = useSearchParams();
  const deepLinkRef = useRef(false);
  useEffect(() => {
    if (deepLinkRef.current) return;
    const param = searchParams.get('pedido');
    if (param) {
      deepLinkRef.current = true;
      void handleFind(param);
    }
  }, [searchParams, handleFind]);

  // ── Focus management ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (state.status === 'loaded') scanRef.current?.focus();
    else if (state.status === 'empty') finderRef.current?.focus();
  }, [state.status, state.epoch]);

  const loaded = state.status === 'loaded' && state.engine !== null && state.pedido !== null;

  return (
    <Stack gap="md" h="calc(100vh - 120px)">
      <PedidoFinder
        ref={finderRef}
        onFind={handleFind}
        busy={state.finderBusy}
        manyCandidates={state.manyCandidates}
        onPick={handlePick}
        onDismiss={() => dispatch({ type: 'finder/dismiss' })}
      />

      {state.status === 'loading' && (
        <Center flex={1}>
          <Loader />
        </Center>
      )}

      {state.status === 'error' && state.message && (
        <Alert color="red" variant="light" title="Erro">
          {state.message}
        </Alert>
      )}

      {loaded && state.pedido && state.pedidoId && state.engine && (
        <Group align="stretch" gap="md" style={{ flex: 1, minHeight: 0 }} wrap="nowrap">
          <Stack gap="sm" style={{ flex: 1, minWidth: 0 }}>
            <PedidoHeader pedido={state.pedido} pedidoId={state.pedidoId} />
            <CheckoutBanners
              observacoesInternas={state.pedido.observacoesInternas}
              existingCheckout={state.existingCheckout}
              incidentes={state.incidentes}
            />
            <ScanInput ref={scanRef} onScan={enqueueScan} />
            <SimpleGrid cols={2} spacing="md" style={{ flex: 1, minHeight: 0 }}>
              <ScanLogPane log={state.engine.log} onDelete={handleDelete} />
              <ExpectedPane db={db} expected={state.engine.expected} produtos={state.produtos} />
            </SimpleGrid>
            <BottomBar
              onClear={handleClear}
              onReload={handleReload}
              onSave={handleSave}
              saving={state.saving}
              status={statusSalvar}
              canSave={user !== null && canWrite}
            />
          </Stack>
          <CheckoutSidebar
            db={db}
            pedido={state.pedido}
            pedidoId={state.pedidoId}
            uid={user?.uid ?? null}
            nfeClient={nfeClient}
            freightClient={freightClient}
            mercadoLivreClient={mercadoLivreClient}
            shopeeClient={shopeeClient}
            lojaIntegradaClient={lojaIntegradaClient}
            formatoDanfe={state.formatoDanfe}
            onFormatoDanfe={(v) => dispatch({ type: 'format/danfe', value: v })}
            formatoEtiqueta={state.formatoEtiqueta}
            onFormatoEtiqueta={(v) => dispatch({ type: 'format/etiqueta', value: v })}
            onReload={handleReload}
          />
        </Group>
      )}

      {confirmDialog.element}
      {comprarBridge.element}
      {envioDialog.element}
    </Stack>
  );
}
