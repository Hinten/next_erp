'use client';

/**
 * Etiqueta actions inside the `/pedidos` FreteCell HoverCard — buy-or-reprint
 * (Melhor Envio), fetch-and-print (Mercado Livre, Shopee) or the carrier-less
 * generic label (motoboy/outros, PDF or ZPL2), dispatched by carrier `tipo`.
 *
 * The tipo is the DISPATCH tipo (`tipoDeDespacho`, #1523): a marketplace-owned
 * frete block names it outright — a Shopee pedido has no `int_frete` ref at all
 * — and otherwise the int_frete doc does (cached, shared across rows on the same
 * integração). The buy's heavier cart resolution stays lazy in
 * `EtiquetaComprarModal`, and the fetch-label + generic-label paths both reuse
 * the shared checkout etiqueta registry (gates + provider).
 *
 * ⚠️ The dialogs and the in-flight flag live in the PAGE host
 * (`EtiquetaAcaoHost`), not here: this component is unmounted by the HoverCard
 * on the first mouse move, and a flow it owned would die with it.
 */
import { useMemo, useState } from 'react';
import { Button, Stack, Text } from '@mantine/core';
import { IconPrinter, IconShoppingCart, IconTruckDelivery } from '@tabler/icons-react';
import { FirebaseError } from 'firebase/app';
import { type DocumentReference, getDoc } from 'firebase/firestore';
import { useQuery } from '@tanstack/react-query';
import {
  INTEGRACAO_FRETE,
  freightCapsFor,
  isFreteMarketplaceOwned,
  type IntegracaoFrete,
  type Pedido,
} from '@delfrance/schemas';

import { intFreteTipoQueryKey } from './rowReadPrefetch';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useFreightClient } from '@/lib/freight/client';
import { freightErrorMessage } from '@/lib/freight/errorMessage';
import { useMercadoLivreClient } from '@/lib/mercado-livre/client';
import {
  showCopyableNotification,
  showErrorNotification,
} from '@/lib/notifications/showErrorNotification';
import { resolverIntFrete, tipoDeDespacho } from '@/lib/checkout/etiqueta/intFrete';
import { emitirOuImprimirEtiqueta } from '@/lib/checkout/etiqueta/registry';
import type { EtiquetaProviderUi } from '@/lib/checkout/etiqueta/types';
import { printJob } from '@/lib/print-agent/printJob';
import { useShopeeClient } from '@/lib/shopee/client';
import { etiquetaMismatch, etiquetaRowState } from './etiquetaActions';
import { EtiquetaComprarModal } from './EtiquetaComprarModal';
import { useEtiquetaAcao, useEtiquetaAcaoValor, type EtiquetaAcaoChave } from './EtiquetaAcaoHost';

export function EtiquetaRowAction({ pedido, pedidoId }: { pedido: Pedido; pedidoId: string }) {
  const db = getFirebaseFirestore();
  const client = useFreightClient();
  const mlClient = useMercadoLivreClient();
  const shopeeClient = useShopeeClient();
  const frete = pedido.freteInicial;
  const blocoTipo = frete?.externalOptionIntegracao ?? null;

  const intRef = useMemo(
    () => dereferenceOuterRef(db, frete?.integracaoFreteOuterRef) as DocumentReference | null,
    [db, frete?.integracaoFreteOuterRef],
  );
  const intFreteId = intRef?.id ?? null;
  const { data: docTipo } = useQuery<IntegracaoFrete | null>({
    // The shared key builder, not a hand-rolled copy — this and `FreteCell`
    // must agree exactly, and they had already drifted in the absent-ref case
    // (`null` here vs `''` there), which is two cache entries for one document.
    queryKey: intFreteTipoQueryKey(intRef?.path ?? ''),
    // A marketplace-owned block already names the dispatch tipo — the document
    // could not change it (`tipoDeDespacho`), so it is not read at all.
    enabled: intRef != null && !isFreteMarketplaceOwned(blocoTipo),
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const snap = await getDoc(intRef!);
      return snap.exists() ? ((snap.data() as { tipo?: IntegracaoFrete }).tipo ?? null) : null;
    },
  });
  const tipo = tipoDeDespacho(docTipo, blocoTipo);

  // The page host when there is one; otherwise this row's own instance, whose
  // dialogs it then renders itself (hooks stay unconditional).
  const host = useEtiquetaAcao();
  const local = useEtiquetaAcaoValor();
  const acao = host ?? local.valor;
  const dialogosLocais = host === null ? local.elementos : null;
  const emAndamento = acao.emAndamento(pedidoId);
  const [comprarOpen, setComprarOpen] = useState(false);

  const printLabelId = frete?.printLabelId ?? null;
  // The generic-label tipos (motoboy/outros) share the 'imprimir' action with
  // Melhor Envio's reprint, but render the label on demand instead of calling the
  // ME HTTP client — see the render branch below.
  const isGenericLabel = tipo != null && freightCapsFor(tipo).labelMode === 'generic';

  const { action, needsPostedConfirm } = etiquetaRowState({
    tipo,
    printLabelId,
    externalOptionId: frete?.externalOptionId ?? null,
    externalId: frete?.externalId ?? null,
    estado: frete?.estado,
  });

  // A fetch-label button is live when the client of THE provider it reaches is
  // — never another marketplace's (#1523 W15: a Shopee row used to be disabled
  // on the Mercado Livre client). A tipo with no entry here stays live: a
  // provider that needs a client reports its own 'error' outcome when it is null.
  let clienteDoFetchPresente = true;
  if (tipo === INTEGRACAO_FRETE.mercadoLivre) clienteDoFetchPresente = mlClient !== null;
  else if (tipo === INTEGRACAO_FRETE.shopee) clienteDoFetchPresente = shopeeClient !== null;

  // Legacy pre-print confirm: a reverse label on a saída (or a non-reverse one
  // on an entrada) is usually a mistake — ask before printing.
  const mismatch = etiquetaMismatch(frete?.ehReverso, pedido.ehSaida);

  /** Run the direction-mismatch confirm; true = proceed (or no mismatch). */
  async function confirmMismatch(): Promise<boolean> {
    if (!mismatch) return true;
    return acao.confirm({
      title: 'Confirmação',
      message:
        mismatch === 'saida-reversa'
          ? 'Este pedido é uma Saída, porém o frete prestes a ser impresso é de devolução. Deseja imprimir mesmo assim?'
          : 'Isto é uma Entrada, porém o frete prestes a ser impresso é de saída. Deseja imprimir mesmo assim?',
      confirmLabel: 'Confirmar',
      cancelLabel: 'Cancelar',
    });
  }

  async function run(kind: 'imprimir' | 'rastrear') {
    if (!client || !intFreteId || !printLabelId) return;
    try {
      if (kind === 'imprimir') {
        const { url } = await client.imprimir(intFreteId, printLabelId);
        window.open(url, '_blank', 'noopener,noreferrer');
      } else {
        const { tracking } = await client.rastrear(intFreteId, printLabelId);
        showCopyableNotification({
          color: 'blue',
          title: 'Rastreio Melhor Envio',
          message: JSON.stringify(tracking, null, 2),
        });
      }
    } catch (err) {
      const msg = freightErrorMessage(err);
      if (msg === null) throw err;
      showErrorNotification({
        title: kind === 'imprimir' ? 'Falha ao imprimir etiqueta' : 'Falha ao rastrear',
        message: msg,
      });
    }
  }

  // Run an etiqueta action through the shared checkout etiqueta registry —
  // the same gates (sem-frete skip, posted-risk confirm) and provider
  // dispatch the checkout post-save uses. Serves the marketplace fetch-label
  // (Mercado Livre, Shopee) and the carrier-less generic label (no client
  // needed — `genericLabelProvider` only uses `deps.printJob`); a provider that
  // does need a client reports its own 'error' outcome when it is null (see
  // `mercadoLivreProvider`), so this stays a single guard.
  async function runEmitirOuImprimir(formato: 'pdf' | 'zpl2') {
    if (!frete) return;
    if (!(await confirmMismatch())) return;
    try {
      // The row caches only the tipo — resolve the integration lazily, with
      // the SAME rule the checkout uses: a Shopee block needs no document.
      const intFrete = await resolverIntFrete(db, frete);
      if (intFrete === null) {
        showErrorNotification({
          title: 'Etiqueta',
          message: 'Integração de frete não encontrada.',
        });
        return;
      }
      const ui: EtiquetaProviderUi = {
        confirmRisk: (msg) =>
          acao.confirm({
            title: 'Atenção',
            message: msg,
            confirmLabel: 'Continuar',
            cancelLabel: 'Cancelar',
          }),
        notify: (n) =>
          showCopyableNotification({
            title: n.title,
            message: n.message,
            color: n.color ?? 'blue',
          }),
        openUrl: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
        // Neither the marketplace fetch nor the generic label ever buys a label
        // — mirror the reprint modal for a provider that calls this anyway.
        comprarEtiqueta: async () => {
          showCopyableNotification({
            title: 'Etiqueta',
            message: 'Compra de etiqueta não se aplica a este frete.',
            color: 'yellow',
          });
          return { status: 'cancelled' };
        },
        escolherEnvio: acao.escolherEnvio,
      };
      const outcome = await emitirOuImprimirEtiqueta({
        db,
        pedido,
        pedidoId,
        frete,
        intFrete,
        formato,
        deps: {
          freightClient: client,
          nfeClient: null,
          mercadoLivreClient: mlClient,
          shopeeClient,
          printJob,
        },
        ui,
      });
      if (outcome.status === 'error') {
        showErrorNotification({ title: 'Etiqueta', message: outcome.message });
      } else if (outcome.status === 'unsupported') {
        showCopyableNotification({ title: 'Etiqueta', message: outcome.reason, color: 'yellow' });
      } else if (outcome.status === 'needs-quote') {
        showCopyableNotification({
          title: 'Etiqueta',
          message: 'Selecione um serviço de frete no pedido antes de gerar a etiqueta.',
          color: 'yellow',
        });
      }
      // printed / opened / skipped — silent, like the checkout post-save.
    } catch (err) {
      if (err instanceof FirebaseError) {
        showErrorNotification({ title: 'Falha ao imprimir etiqueta', message: err.message });
      } else {
        throw err;
      }
    }
  }

  /** Start `fn` as this pedido's `chave` action through the host (refused while one runs). */
  function iniciar(chave: EtiquetaAcaoChave, fn: () => Promise<void>) {
    void acao.executar(pedidoId, chave, fn);
  }

  if (action === 'none') return null;
  if (action === 'unsupported') {
    return (
      <Text size="xs" c="dimmed">
        Emissão de etiqueta para esta transportadora ainda não suportada.
      </Text>
    );
  }
  if (action === 'quote-first') {
    return (
      <Text size="xs" c="dimmed">
        Cote e selecione um frete no pedido para comprar a etiqueta.
      </Text>
    );
  }

  if (action === 'fetch-label') {
    // Legacy parity (`pedidoTableView.dart:1569-1602`): ZPL2 is the primary
    // entry, PDF the sub-action. The posted-risk confirm runs inside the
    // registry gates (via `ui.confirmRisk`), not here. The button text is
    // carrier-neutral on purpose — the ML e2e pins it.
    return (
      <Stack gap="xs">
        {dialogosLocais}
        <Button
          size="xs"
          leftSection={<IconPrinter size={14} />}
          onClick={() => iniciar('fetch-zpl2', () => runEmitirOuImprimir('zpl2'))}
          loading={emAndamento === 'fetch-zpl2'}
          disabled={!clienteDoFetchPresente || emAndamento !== null}
        >
          Imprimir Etiqueta Transporte (ZPL2)
        </Button>
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPrinter size={14} />}
          onClick={() => iniciar('fetch-pdf', () => runEmitirOuImprimir('pdf'))}
          loading={emAndamento === 'fetch-pdf'}
          disabled={!clienteDoFetchPresente || emAndamento !== null}
        >
          Imprimir Etiqueta Transporte (PDF)
        </Button>
      </Stack>
    );
  }

  // The carrier-less generic label (motoboy/outros) — no buy step, no tracking,
  // rendered on demand from the pedido data via the shared registry (the same
  // path the checkout post-save uses). Both formats are offered, ZPL2 first, the
  // way the legacy row action ordered them (`pedidoTableView.dart:1582-1602`
  // registers zpl2 as the default and pdf as the sub-action) — except that in
  // legacy the ZPL2 entry never produced ZPL at all.
  if (action === 'imprimir' && isGenericLabel) {
    return (
      <Stack gap="xs">
        {needsPostedConfirm && (
          <Text size="xs" c="orange">
            Etiqueta já emitida — reimprimir pode duplicar a etiqueta.
          </Text>
        )}
        {dialogosLocais}
        <Button
          size="xs"
          leftSection={<IconPrinter size={14} />}
          onClick={() => iniciar('generico-zpl2', () => runEmitirOuImprimir('zpl2'))}
          loading={emAndamento === 'generico-zpl2'}
          disabled={emAndamento !== null}
        >
          Imprimir etiqueta (ZPL2)
        </Button>
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPrinter size={14} />}
          onClick={() => iniciar('generico-pdf', () => runEmitirOuImprimir('pdf'))}
          loading={emAndamento === 'generico-pdf'}
          disabled={emAndamento !== null}
        >
          Imprimir etiqueta (PDF)
        </Button>
      </Stack>
    );
  }

  if (action === 'comprar') {
    return (
      <>
        <Button
          size="xs"
          leftSection={<IconShoppingCart size={14} />}
          onClick={() => setComprarOpen(true)}
          disabled={!client}
        >
          Comprar etiqueta
        </Button>
        <EtiquetaComprarModal
          opened={comprarOpen}
          onClose={() => setComprarOpen(false)}
          pedido={pedido}
          pedidoId={pedidoId}
          intFreteId={intFreteId}
          needsPostedConfirm={needsPostedConfirm}
        />
      </>
    );
  }

  // Gate the print behind the direction-mismatch confirm when needed.
  async function onImprimir() {
    if (!(await confirmMismatch())) return;
    await run('imprimir');
  }

  // action === 'imprimir' && !isGenericLabel — a bought Melhor Envio label:
  // reprint + track.
  return (
    <Stack gap="xs">
      {needsPostedConfirm && (
        <Text size="xs" c="orange">
          Etiqueta já emitida — reimprimir pode duplicar a etiqueta.
        </Text>
      )}
      {dialogosLocais}
      <Button
        size="xs"
        variant="light"
        leftSection={<IconPrinter size={14} />}
        onClick={() => iniciar('imprimir', onImprimir)}
        loading={emAndamento === 'imprimir'}
        disabled={!client || emAndamento !== null}
      >
        Imprimir etiqueta
      </Button>
      <Button
        size="xs"
        variant="light"
        leftSection={<IconTruckDelivery size={14} />}
        onClick={() => iniciar('rastrear', () => run('rastrear'))}
        loading={emAndamento === 'rastrear'}
        disabled={!client || emAndamento !== null}
      >
        Rastrear
      </Button>
    </Stack>
  );
}
