'use client';

import { useCallback, useMemo } from 'react';
import { Badge, Button, Divider, Group, Modal, Stack, Text } from '@mantine/core';
import { IconPrinter, IconTruck } from '@tabler/icons-react';
import type { Firestore } from 'firebase/firestore';
import type { NFeHttpClient } from '@delfrance/integrations-nfe/http-provider';
import type { FreightHttpClient } from '@delfrance/integrations-freight-br/http-client';
import type { MercadoLivreClient } from '@/lib/mercado-livre/client';
import {
  showCopyableNotification,
  showErrorNotification,
} from '@/lib/notifications/showErrorNotification';
import {
  reprintCheckoutDanfe,
  reprintCheckoutEtiqueta,
  type ReprintDanfeResult,
  type ReprintEtiquetaResult,
} from '@/lib/checkout/reprintCheckout';
import type { CheckoutDanfeFormat } from '@/lib/checkout/nfeFlow';
import type { EtiquetaProviderUi } from '@/lib/checkout/etiqueta/types';
import { usePrintInFlight } from './usePrintInFlight';
import { useConfirm } from './useConfirm';
import type { OutroCheckoutRow } from './useOutrosCheckouts';

/** `modalidadeFrete` code for "sem frete" — mirrors `etiqueta/gates.ts`. */
const MODALIDADE_SEM_FRETE = '9';

/**
 * Compile-time exhaustiveness guard for the two report switches below.
 *
 * ⚠️ Both switches are pure side effect (they only fire a toast), so a missing
 * arm is invisible: no type error, no lint error — `@typescript-eslint/switch-
 * exhaustiveness-check` is not enabled anywhere in this repo — and at runtime
 * just silence. Silence is precisely the failure these reporters exist to
 * remove: the stage times out, the mutex releases correctly, and the operator
 * still sees nothing. Deleting an arm now reds `tsc` instead.
 */
function assertNever(value: never): never {
  throw new Error(`Unhandled reprint result: ${JSON.stringify(value)}`);
}

function reportDanfe(r: ReprintDanfeResult): void {
  switch (r.status) {
    case 'printed':
      showCopyableNotification({
        title: 'DANFE',
        message: 'DANFE enviado para impressão.',
        color: 'green',
      });
      break;
    case 'downloaded':
      showCopyableNotification({
        title: 'DANFE',
        message: 'Impressora indisponível — DANFE baixado.',
        color: 'blue',
      });
      break;
    case 'pending':
      showCopyableNotification({
        title: 'NF-e',
        message: 'NF-e em processamento — reimprima quando aprovada.',
        color: 'yellow',
      });
      break;
    case 'no-nfe':
    case 'error':
      showErrorNotification(r.notification);
      break;
    case 'timeout':
      // Same wedge as the etiqueta twin: this button shares the print mutex, so
      // a stall here spun BOTH buttons with no toast.
      showErrorNotification({
        title: 'NF-e',
        message: `${r.message} Nada foi impresso. Verifique a conexão e tente novamente.`,
      });
      break;
    default:
      return assertNever(r);
  }
}

function reportEtiqueta(r: ReprintEtiquetaResult): void {
  switch (r.status) {
    case 'printed':
      showCopyableNotification({
        title: 'Etiqueta',
        message: 'Etiqueta enviada para impressão.',
        color: 'green',
      });
      break;
    case 'opened':
      // The label URL opened in a new tab (Melhor Envio) — it did NOT go to the
      // local print agent; say so, or an operator chasing a missing print is misled.
      showCopyableNotification({
        title: 'Etiqueta',
        message: 'Etiqueta aberta em nova aba.',
        color: 'green',
      });
      break;
    case 'skipped':
      break; // semFrete or the operator declined the posted-reprint risk — silent
    case 'needs-quote':
      showCopyableNotification({
        title: 'Etiqueta',
        message: 'Selecione um serviço de frete no pedido antes de gerar a etiqueta.',
        color: 'yellow',
      });
      break;
    case 'unsupported':
      showCopyableNotification({ title: 'Etiqueta', message: r.reason, color: 'yellow' });
      break;
    case 'error':
      showErrorNotification({ title: 'Etiqueta', message: r.message });
      break;
    case 'timeout':
      // Names the stage that hung. Before this, the same condition produced NO
      // toast at all — both buttons simply spun forever on the shared print
      // mutex, which is indistinguishable from a slow printer.
      showErrorNotification({
        title: 'Etiqueta',
        message: `${r.message} Nada foi impresso. Verifique a conexão e tente novamente.`,
      });
      break;
    default:
      // ⚠️ Exhaustiveness backstop. A missing arm here is SILENT — no toast, and
      // the operator sees exactly the "it froze" symptom this module exists to
      // remove. `@typescript-eslint/switch-exhaustiveness-check` is not enabled
      // in this repo, so nothing else catches it; this makes a new
      // `ReprintEtiquetaResult` member a typecheck error instead.
      return assertNever(r);
    case 'no-pedido':
      showErrorNotification({ title: 'Etiqueta', message: 'Pedido não encontrado.' });
      break;
    case 'no-frete':
      showCopyableNotification({
        title: 'Etiqueta',
        message: 'Este pedido não possui frete.',
        color: 'yellow',
      });
      break;
    case 'no-integration':
      showCopyableNotification({
        title: 'Etiqueta',
        message: 'Este frete não possui integração com transportadora.',
        color: 'yellow',
      });
      break;
  }
}

export interface OutroCheckoutModalProps {
  /** The FROZEN row to reprint; `null` closes the modal. */
  row: OutroCheckoutRow | null;
  onClose: () => void;
  db: Firestore;
  nfeClient: NFeHttpClient | null;
  freightClient: FreightHttpClient | null;
  mercadoLivreClient: MercadoLivreClient | null;
  formatoDanfe: CheckoutDanfeFormat;
  formatoEtiqueta: 'pdf' | 'zpl2';
}

/**
 * Reprint dialog for one past checkout (the "Outros Checkouts" row action).
 *
 * The wrong-label-bug armor lives here: the modal renders a FROZEN `row`
 * captured by the parent at click time (never an index into a live-reordering
 * list), and every reprint action derives its target from `row.pedidoId` — the
 * row's own id parsed from its doc path — passed straight into the reprint
 * helpers, which re-fetch THAT pedido's live frete. No shared "current pedido"
 * ref is ever read. A `usePrintInFlight` mutex drops a double-click so the local
 * print agent can't be POSTed twice.
 */
export function OutroCheckoutModal({
  row,
  onClose,
  db,
  nfeClient,
  freightClient,
  mercadoLivreClient,
  formatoDanfe,
  formatoEtiqueta,
}: OutroCheckoutModalProps) {
  const printInFlight = usePrintInFlight();
  const confirm = useConfirm();

  const ui = useMemo<EtiquetaProviderUi>(
    () => ({
      confirmRisk: (msg) =>
        confirm.confirm({
          title: 'Atenção',
          message: msg,
          confirmLabel: 'Continuar',
          danger: true,
        }),
      notify: (n) =>
        showCopyableNotification({
          title: n.title,
          message: n.message,
          color: n.color ?? 'blue',
        }),
      openUrl: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
      // A reprint surface doesn't buy: if the pedido never bought a label, send
      // the operator to the pedido rather than opening the buy flow here.
      comprarEtiqueta: async () => {
        showCopyableNotification({
          title: 'Etiqueta',
          message: 'Este pedido ainda não comprou etiqueta. Compre na tela do pedido.',
          color: 'yellow',
        });
        return { status: 'cancelled' };
      },
    }),
    [confirm],
  );

  const handleReimprimirNfe = useCallback(async () => {
    if (row === null) return;
    const { pedidoId } = row; // the row's OWN pedido — never a shared ref
    await printInFlight.run(async () => {
      const r = await reprintCheckoutDanfe({ db, nfeClient, pedidoId, formato: formatoDanfe });
      reportDanfe(r);
    });
  }, [row, db, nfeClient, formatoDanfe, printInFlight]);

  const handleReimprimirFrete = useCallback(async () => {
    if (row === null) return;
    const { pedidoId } = row; // the row's OWN pedido — never a shared ref
    await printInFlight.run(async () => {
      const r = await reprintCheckoutEtiqueta({
        db,
        pedidoId,
        freightClient,
        nfeClient,
        mercadoLivreClient,
        formato: formatoEtiqueta,
        ui,
      });
      reportEtiqueta(r);
    });
  }, [row, db, freightClient, nfeClient, mercadoLivreClient, formatoEtiqueta, ui, printInFlight]);

  const total = row?.itens.length ?? 0;
  const comErro = row?.itens.filter((i) => i.error != null).length ?? 0;
  const excluidos = row?.itens.filter((i) => i.dataExclusao != null).length ?? 0;
  const canReprintFrete = row !== null && row.frete.modalidade !== MODALIDADE_SEM_FRETE;

  return (
    <Modal
      opened={row !== null}
      onClose={onClose}
      centered
      title={row !== null ? `Reimpressão — Pedido ${row.numero ?? row.pedidoId}` : ''}
    >
      {row !== null && (
        <Stack gap="sm">
          {row.timestampMs != null && (
            <Text size="xs" c="dimmed">
              Conferido em {new Date(row.timestampMs).toLocaleString('pt-BR')}
            </Text>
          )}
          {row.obs != null && row.obs.length > 0 && (
            <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
              {row.obs}
            </Text>
          )}

          <Group gap="xs">
            <Badge variant="light" color="gray">
              {total} {total === 1 ? 'lançamento' : 'lançamentos'}
            </Badge>
            {comErro > 0 && (
              <Badge variant="light" color="red">
                {comErro} com erro
              </Badge>
            )}
            {excluidos > 0 && (
              <Badge variant="light" color="yellow">
                {excluidos} excluído{excluidos === 1 ? '' : 's'}
              </Badge>
            )}
          </Group>

          <Divider />

          <Group gap="sm" grow>
            <Button
              variant="light"
              leftSection={<IconPrinter size={16} />}
              loading={printInFlight.inFlight}
              onClick={handleReimprimirNfe}
            >
              Reimprimir NF-e
            </Button>
            {canReprintFrete && (
              <Button
                variant="light"
                color="teal"
                leftSection={<IconTruck size={16} />}
                loading={printInFlight.inFlight}
                onClick={handleReimprimirFrete}
              >
                Reimprimir Frete
              </Button>
            )}
          </Group>
        </Stack>
      )}
      {confirm.element}
    </Modal>
  );
}
