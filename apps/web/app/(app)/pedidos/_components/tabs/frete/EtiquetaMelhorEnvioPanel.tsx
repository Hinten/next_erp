'use client';

/**
 * Melhor Envio etiqueta panel (F5.3) — the buy/print/track step that follows
 * the F4 quote. Rendered inside `MelhorEnvioFields` in edit mode only (a saved
 * pedido). It resolves the cart primitives in the browser (filial origin,
 * recipient endereço + cliente, pedido itens), builds the ME cart payload via
 * the pure `buildPedidoCartPayload`, and drives the
 * `apps/melhor-envio` comprar/imprimir/rastrear routes through
 * `useFreightClient`.
 *
 * The buy persists `freteInicial.printLabelId` server-side before checkout
 * (anti-loss) and is idempotent on resume; we mirror the resulting estado /
 * tracking back into the form so the UI updates without a reload.
 */
import { useMemo, useState } from 'react';
import { Alert, Button, Code, Divider, Group, Modal, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPrinter, IconShoppingCart, IconTruckDelivery } from '@tabler/icons-react';
import { getDoc, type DocumentReference } from 'firebase/firestore';
import { useQuery } from '@tanstack/react-query';
import type { Endereco, EstadoFrete, Filial, IntFrete } from '@delfrance/schemas';

import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useFreightClient } from '@/lib/freight/client';
import { freightErrorMessage } from '@/lib/freight/errorMessage';
import { showErrorNotification } from '@/lib/notifications/showErrorNotification';
import type { FlatItem, FreteInicialFormState } from '../../types';
import { resolveNfeChave } from '../../etiquetaActions';
import { fretePath, type PedidoFormHandle } from './fields';
import { buildPedidoCartPayload, type ClienteDestinoLike } from './melhorEnvioCart';

/** Estados where the label is already bought — Comprar stays disabled to
 *  prevent a double purchase. A fresh/partial pedido (anything else) can buy
 *  or resume. */
const ESTADOS_COMPRADOS: ReadonlySet<EstadoFrete> = new Set([
  'aguardandoPostagem',
  'postado',
  'recebidoPelaTransportadora',
  'aCaminho',
  'tentandoRealizarEntrega',
  'entregue',
  'falhaNaEntrega',
  'cancelado',
]);

/** One-shot resolve of an outer ref (any legacy shape) to its typed doc.
 *  `loading` is true only while a present ref is in flight — so callers can
 *  tell "still resolving" apart from "absent / not found". */
function useResolvedDoc<T>(outerRef: unknown): { data: T | null; loading: boolean } {
  const db = getFirebaseFirestore();
  const ref = useMemo(
    () => dereferenceOuterRef(db, outerRef) as DocumentReference<T> | null,
    [db, outerRef],
  );
  const { data, isLoading } = useQuery<T | null>({
    queryKey: ['etiquetaDoc', ref?.path ?? null],
    enabled: ref != null,
    staleTime: 60_000,
    queryFn: async () => {
      const snap = await getDoc(ref!);
      return snap.exists() ? (snap.data() as T) : null;
    },
  });
  return { data: ref ? (data ?? null) : null, loading: ref != null && isLoading };
}

export function EtiquetaMelhorEnvioPanel({
  form,
  disabled,
  integracao,
  intFreteId,
  pedidoId,
}: {
  form: PedidoFormHandle;
  disabled?: boolean;
  integracao: IntFrete;
  intFreteId: string;
  pedidoId: string;
}) {
  const client = useFreightClient();

  const printLabelId = form.watch(fretePath('printLabelId')) as string | null;
  const externalOptionId = form.watch(fretePath('externalOptionId')) as string | null;
  const estado = form.watch(fretePath('estado')) as EstadoFrete;
  const isDirty = form.formState.isDirty;

  // Resolve the cart parties. Origin address is embedded on the integração;
  // the filial (razão social/CNPJ/IE/CNAE) and recipient cliente/endereço come
  // from outer refs.
  const enderecoOrigem = integracao.enderecoDeOrigem;
  const { data: filial, loading: filialLoading } = useResolvedDoc<Filial>(
    integracao.filialIntegracaoFreteOuterRef,
  );
  const { data: clienteDestino } = useResolvedDoc<ClienteDestinoLike>(
    form.watch('clientePedidoOuterRef'),
  );
  const { data: enderecoDestino, loading: enderecoLoading } = useResolvedDoc<Endereco>(
    form.watch(fretePath('enderecoFreteOuterReference')),
  );

  const [busy, setBusy] = useState<null | 'comprar' | 'imprimir' | 'rastrear'>(null);
  const [rastreio, setRastreio] = useState<unknown>(null);

  // The buy needs the origin (filial identity + address) and the destination
  // address fully resolved — `useResolvedDoc` returns null while loading, so
  // without this gate a fast click would build a payload with empty strings
  // and fail at ME with a 422 (or stamp a label with blank parties).
  const cartResolving = filialLoading || enderecoLoading;
  const cartReady = filial != null && enderecoDestino != null && enderecoOrigem != null;

  const jaComprado = printLabelId != null && ESTADOS_COMPRADOS.has(estado);
  const canComprar =
    Boolean(client) &&
    !disabled &&
    Boolean(externalOptionId) &&
    !isDirty &&
    !jaComprado &&
    busy === null &&
    cartReady;

  async function handleComprar() {
    if (!client) return;
    setBusy('comprar');
    try {
      const invoiceKey = await resolveNfeChave(getFirebaseFirestore(), pedidoId);
      const payload = buildPedidoCartPayload({
        frete: form.getValues('freteInicial') as FreteInicialFormState,
        enderecoOrigem,
        filial,
        enderecoDestino,
        clienteDestino,
        itens: form.getValues('_itensFlat') as FlatItem[],
        pedidoNumero: form.getValues('numero'),
        invoiceKey,
      });
      const result = await client.comprar(intFreteId, pedidoId, payload, printLabelId);
      // The route already persisted these to the doc; mirror them into the
      // form (not dirtying) so the UI reflects the purchase without a reload.
      form.setValue(fretePath('printLabelId'), result.printLabelId, { shouldDirty: false });
      form.setValue(fretePath('estado'), result.estado as EstadoFrete, { shouldDirty: false });
      if (result.tracking != null) {
        form.setValue(fretePath('codRastreio'), result.tracking, { shouldDirty: false });
      }
      notifications.show({
        color: 'green',
        title: 'Etiqueta comprada',
        message: result.tracking ? `Rastreio: ${result.tracking}` : 'Etiqueta gerada com sucesso.',
      });
    } catch (err) {
      const msg = freightErrorMessage(err);
      if (msg === null) throw err;
      showErrorNotification({ title: 'Falha ao comprar etiqueta', message: msg });
    } finally {
      setBusy(null);
    }
  }

  async function handleImprimir() {
    if (!client || !printLabelId) return;
    setBusy('imprimir');
    try {
      const { url } = await client.imprimir(intFreteId, printLabelId);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      const msg = freightErrorMessage(err);
      if (msg === null) throw err;
      showErrorNotification({ title: 'Falha ao imprimir etiqueta', message: msg });
    } finally {
      setBusy(null);
    }
  }

  async function handleRastrear() {
    if (!client || !printLabelId) return;
    setBusy('rastrear');
    try {
      const { tracking } = await client.rastrear(intFreteId, printLabelId);
      setRastreio(tracking);
    } catch (err) {
      const msg = freightErrorMessage(err);
      if (msg === null) throw err;
      showErrorNotification({ title: 'Falha ao rastrear', message: msg });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Stack gap="xs">
      <Divider label="Etiqueta" labelPosition="left" />

      {!externalOptionId && (
        <Text size="sm" c="dimmed">
          Cote e selecione uma opção de frete acima para comprar a etiqueta.
        </Text>
      )}
      {externalOptionId && isDirty && !jaComprado && (
        <Alert color="yellow" variant="light">
          Salve o pedido antes de comprar a etiqueta.
        </Alert>
      )}
      {externalOptionId && !isDirty && !jaComprado && cartResolving && (
        <Text size="sm" c="dimmed">
          Carregando dados da etiqueta…
        </Text>
      )}
      {externalOptionId && !isDirty && !jaComprado && !cartResolving && !cartReady && (
        <Alert color="yellow" variant="light">
          {!enderecoOrigem
            ? 'Configure o endereço de origem da integração Melhor Envio para comprar a etiqueta.'
            : !filial
              ? 'Filial da integração de frete não encontrada — verifique a configuração da integração.'
              : 'Selecione um endereço de entrega para comprar a etiqueta.'}
        </Alert>
      )}

      <Group gap="sm">
        {!jaComprado && (
          <Button
            type="button"
            leftSection={<IconShoppingCart size={16} />}
            onClick={handleComprar}
            loading={busy === 'comprar'}
            disabled={!canComprar}
          >
            {printLabelId ? 'Retomar compra' : 'Comprar etiqueta'}
          </Button>
        )}

        {printLabelId && (
          <>
            <Button
              type="button"
              variant="light"
              leftSection={<IconPrinter size={16} />}
              onClick={handleImprimir}
              loading={busy === 'imprimir'}
              disabled={!client || busy !== null}
            >
              Imprimir
            </Button>
            <Button
              type="button"
              variant="light"
              leftSection={<IconTruckDelivery size={16} />}
              onClick={handleRastrear}
              loading={busy === 'rastrear'}
              disabled={!client || busy !== null}
            >
              Rastrear
            </Button>
          </>
        )}
      </Group>

      {printLabelId && (
        <Text size="xs" c="dimmed">
          Etiqueta: <Code>{printLabelId}</Code>
        </Text>
      )}

      <Modal
        opened={rastreio !== null}
        onClose={() => setRastreio(null)}
        title="Rastreio Melhor Envio"
        size="lg"
      >
        <Code block>{JSON.stringify(rastreio, null, 2)}</Code>
      </Modal>
    </Stack>
  );
}
