'use client';

/**
 * Etiqueta actions inside the `/pedidos` FreteCell HoverCard — buy-or-reprint
 * (Melhor Envio) or fetch-and-print (Mercado Livre), dispatched by carrier
 * `tipo`. Resolves the tipo from the int_frete doc (cached, shared across rows
 * on the same integração); the buy's heavier cart resolution stays lazy in
 * `EtiquetaComprarModal`, and the fetch-label path reuses the shared checkout
 * etiqueta registry (gates + provider).
 */
import { useMemo, useState } from 'react';
import { Button, Stack, Text } from '@mantine/core';
import { IconPrinter, IconShoppingCart, IconTruckDelivery } from '@tabler/icons-react';
import { FirebaseError } from 'firebase/app';
import { type DocumentReference, getDoc } from 'firebase/firestore';
import { useQuery } from '@tanstack/react-query';
import type { IntFrete, IntegracaoFrete, Pedido } from '@delfrance/schemas';

import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useFreightClient } from '@/lib/freight/client';
import { freightErrorMessage } from '@/lib/freight/errorMessage';
import { useMercadoLivreClient } from '@/lib/mercado-livre/client';
import {
  showCopyableNotification,
  showErrorNotification,
} from '@/lib/notifications/showErrorNotification';
import { emitirOuImprimirEtiqueta } from '@/lib/checkout/etiqueta/registry';
import type { EtiquetaProviderUi } from '@/lib/checkout/etiqueta/types';
import { printJob } from '@/lib/print-agent/printJob';
import { etiquetaMismatch, etiquetaRowState } from './etiquetaActions';
import { EtiquetaComprarModal } from './EtiquetaComprarModal';
import { useConfirmDialog } from './ConfirmDialog';

export function EtiquetaRowAction({ pedido, pedidoId }: { pedido: Pedido; pedidoId: string }) {
  const db = getFirebaseFirestore();
  const client = useFreightClient();
  const mlClient = useMercadoLivreClient();
  const frete = pedido.freteInicial;

  const intRef = useMemo(
    () => dereferenceOuterRef(db, frete?.integracaoFreteOuterRef) as DocumentReference | null,
    [db, frete?.integracaoFreteOuterRef],
  );
  const intFreteId = intRef?.id ?? null;
  const { data: tipo } = useQuery<IntegracaoFrete | null>({
    queryKey: ['intFreteTipo', intRef?.path ?? null],
    enabled: intRef != null,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const snap = await getDoc(intRef!);
      return snap.exists() ? ((snap.data() as { tipo?: IntegracaoFrete }).tipo ?? null) : null;
    },
  });

  const [busy, setBusy] = useState<null | 'imprimir' | 'rastrear' | 'fetch-zpl2' | 'fetch-pdf'>(
    null,
  );
  const [comprarOpen, setComprarOpen] = useState(false);
  const { confirm, element: confirmElement } = useConfirmDialog();
  const printLabelId = frete?.printLabelId ?? null;

  const { action, needsPostedConfirm } = etiquetaRowState({
    tipo: tipo ?? null,
    printLabelId,
    externalOptionId: frete?.externalOptionId ?? null,
    externalId: frete?.externalId ?? null,
    estado: frete?.estado,
  });

  // Legacy pre-print confirm: a reverse label on a saída (or a non-reverse one
  // on an entrada) is usually a mistake — ask before printing.
  const mismatch = etiquetaMismatch(frete?.ehReverso, pedido.ehSaida);

  /** Run the direction-mismatch confirm; true = proceed (or no mismatch). */
  async function confirmMismatch(): Promise<boolean> {
    if (!mismatch) return true;
    return confirm({
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
    setBusy(kind);
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
    } finally {
      setBusy(null);
    }
  }

  // Fetch + print the marketplace label through the shared checkout etiqueta
  // registry — the same gates (sem-frete skip, posted-risk confirm) and
  // provider the checkout post-save dispatches.
  async function runFetchLabel(formato: 'pdf' | 'zpl2') {
    if (!frete || !intRef || !mlClient || busy !== null) return;
    if (!(await confirmMismatch())) return;
    setBusy(formato === 'zpl2' ? 'fetch-zpl2' : 'fetch-pdf');
    try {
      // The row caches only the tipo — resolve the full IntFrete doc lazily.
      const snap = await getDoc(intRef);
      if (!snap.exists()) {
        showErrorNotification({
          title: 'Etiqueta',
          message: 'Integração de frete não encontrada.',
        });
        return;
      }
      const data = snap.data() as IntFrete;
      const ui: EtiquetaProviderUi = {
        confirmRisk: (msg) =>
          confirm({
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
        // A marketplace label is fetched, never bought — mirror the reprint modal.
        comprarEtiqueta: async () => {
          showCopyableNotification({
            title: 'Etiqueta',
            message: 'Compra de etiqueta não se aplica a este frete.',
            color: 'yellow',
          });
          return { status: 'cancelled' };
        },
      };
      const outcome = await emitirOuImprimirEtiqueta({
        db,
        pedido,
        pedidoId,
        frete,
        intFrete: { id: snap.id, tipo: data.tipo, data },
        formato,
        deps: { freightClient: client, nfeClient: null, mercadoLivreClient: mlClient, printJob },
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
    } finally {
      setBusy(null);
    }
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
    // registry gates (via `ui.confirmRisk`), not here.
    return (
      <Stack gap="xs">
        {confirmElement}
        <Button
          size="xs"
          leftSection={<IconPrinter size={14} />}
          onClick={() => void runFetchLabel('zpl2')}
          loading={busy === 'fetch-zpl2'}
          disabled={!mlClient || busy !== null}
        >
          Imprimir Etiqueta Transporte (ZPL2)
        </Button>
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPrinter size={14} />}
          onClick={() => void runFetchLabel('pdf')}
          loading={busy === 'fetch-pdf'}
          disabled={!mlClient || busy !== null}
        >
          Imprimir Etiqueta Transporte (PDF)
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

  // action === 'imprimir' — a bought label: reprint + track.
  return (
    <Stack gap="xs">
      {needsPostedConfirm && (
        <Text size="xs" c="orange">
          Etiqueta já emitida — reimprimir pode duplicar a etiqueta.
        </Text>
      )}
      {confirmElement}
      <Button
        size="xs"
        variant="light"
        leftSection={<IconPrinter size={14} />}
        onClick={() => void onImprimir()}
        loading={busy === 'imprimir'}
        disabled={!client || busy !== null}
      >
        Imprimir etiqueta
      </Button>
      <Button
        size="xs"
        variant="light"
        leftSection={<IconTruckDelivery size={14} />}
        onClick={() => run('rastrear')}
        loading={busy === 'rastrear'}
        disabled={!client || busy !== null}
      >
        Rastrear
      </Button>
    </Stack>
  );
}
