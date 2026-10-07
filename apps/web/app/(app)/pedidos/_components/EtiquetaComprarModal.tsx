'use client';

/**
 * Buy-etiqueta confirm + progress modal for the `/pedidos` row action. Ports the
 * legacy `emitirOuImprimirFrete` posted-state risk confirmation (condensed to a
 * single "Estou ciente do risco" checkbox), then resolves the cart from the
 * pedido doc and buys via `client.comprar`, showing the print link on success.
 *
 * The cart is resolved on open (not on the buy click) so config errors surface
 * immediately and the resolved sender location can feed the **agency picker**
 * (#377): for drop-off carriers (Jadlog) the operator sees the carrier's nearby
 * agencies, prefilled with the nearest — the same one the server auto-resolve
 * would silently pick — and the choice is sent on the cart insert. When the
 * carrier has no agencies (Correios) or the lookup fails, no picker shows and
 * the server-side `ensureCartAgency` fallback applies unchanged.
 */
import { useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Group, Modal, Select, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { formatReais } from '@delfrance/core/money';
import type { Pedido } from '@delfrance/schemas';
import {
  type Agency,
  FreightCompraEmAndamentoError,
  FreightEtiquetaDesvinculadaError,
  FreightHttpError,
  FreightTimeoutError,
  withCartAgency,
} from '@delfrance/integrations-freight-br/http-client';

import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useFreightClient } from '@/lib/freight/client';
import { freightErrorMessage } from '@/lib/freight/errorMessage';
import { freightQueryRetry } from '@/lib/freight/queryRetry';
import {
  showCopyableNotification,
  showErrorNotification,
} from '@/lib/notifications/showErrorNotification';
import { resolveEtiquetaCartInput } from './etiquetaActions';

interface BuyResult {
  readonly printUrl: string;
  readonly tracking: string | null;
}

/**
 * Picker label: agency name + its city when the passthrough `address` carries
 * one. The ME agency address shape isn't modeled (schema keeps it passthrough),
 * so read it defensively — `city` shows up as a string or a `{ city }` object
 * depending on the endpoint version.
 */
function agencyLabel(agency: Agency): string {
  const name = agency.name?.trim() ? agency.name : `Agência ${agency.id}`;
  const address = (agency as Record<string, unknown>).address;
  let city: string | null = null;
  if (address != null && typeof address === 'object') {
    const rawCity = (address as Record<string, unknown>).city;
    if (typeof rawCity === 'string') city = rawCity;
    else if (rawCity != null && typeof rawCity === 'object') {
      const nested = (rawCity as Record<string, unknown>).city;
      if (typeof nested === 'string') city = nested;
    }
  }
  return city ? `${name} — ${city}` : name;
}

export function EtiquetaComprarModal({
  opened,
  onClose,
  pedido,
  pedidoId,
  intFreteId,
  needsPostedConfirm,
}: {
  opened: boolean;
  onClose: () => void;
  pedido: Pedido;
  pedidoId: string;
  intFreteId: string | null;
  needsPostedConfirm: boolean;
}) {
  const db = getFirebaseFirestore();
  const client = useFreightClient();
  const [ack, setAck] = useState(false);
  const [buying, setBuying] = useState(false);
  const [result, setResult] = useState<BuyResult | null>(null);
  /** The operator's picker choice; null → the derived default (nearest). */
  const [agencyChoice, setAgencyChoice] = useState<string | null>(null);

  // Show the ME account saldo before confirming (the legacy showed it in the
  // buy dialog). Fresh each open (staleTime 0) — a prior buy changes it.
  const conta = useQuery({
    queryKey: ['freightConta', intFreteId],
    enabled: opened && client != null && intFreteId != null,
    staleTime: 0,
    // Never re-sent after a timeout (#1094) — the default single retry otherwise.
    retry: freightQueryRetry,
    queryFn: () => client!.conta(intFreteId!),
  });
  const saldo = conta.data?.balance?.balance ?? null;
  const saldoLabel = conta.isLoading
    ? 'Carregando…'
    : saldo != null
      ? formatReais(saldo)
      : 'Desconhecido';
  const custoFrete = pedido.freteInicial?.custoFinal ?? pedido.freteInicial?.custoCalculado ?? null;
  const saldoInsuficiente = saldo != null && custoFrete != null && saldo < custoFrete;

  // Resolve the cart from the pedido doc on open (reads several docs). Errors
  // surface here as an Alert instead of only after the buy click.
  const cartInput = useQuery({
    queryKey: ['etiquetaCartInput', pedidoId],
    enabled: opened,
    staleTime: 0,
    queryFn: () => resolveEtiquetaCartInput(db, pedido, pedidoId),
  });
  const resolved = cartInput.data?.ok ? cartInput.data : null;
  const resolveError = cartInput.data && !cartInput.data.ok ? cartInput.data.error : null;

  // The drop-off agencies of the selected service's carrier near the sender.
  // Empty (Correios / unknown carrier / no sender location) → no picker, and
  // the buy degrades to the server-side auto-resolve exactly as before.
  const agenciasEnabled =
    opened &&
    client != null &&
    resolved != null &&
    resolved.remetente.estado != null &&
    resolved.remetente.cidade != null;
  const agencias = useQuery({
    queryKey: [
      'freightAgencias',
      resolved?.intFreteId,
      resolved?.payload.service,
      resolved?.remetente.estado,
      resolved?.remetente.cidade,
    ],
    enabled: agenciasEnabled,
    // ⚠️ Not after a timeout (#1094): `agenciasSettling` below holds Comprar
    // disabled until this settles, so a retried timeout blocked the buy for two
    // full budgets. The default single retry otherwise.
    retry: freightQueryRetry,
    queryFn: () =>
      client!.agencias(resolved!.intFreteId, {
        service: resolved!.payload.service,
        state: resolved!.remetente.estado!,
        city: resolved!.remetente.cidade!,
      }),
  });
  const agencies = useMemo(() => agencias.data?.agencies ?? [], [agencias.data]);
  // Block the buy until the agency lookup settles (review): cached data keeps
  // the modal rendered through a refetch (`isLoading` false), and buying
  // mid-flight could send the payload without an `agency` — in the
  // no-agency-in-city case the server auto-resolve finds nothing either and the
  // cart insert dies with ME's opaque 500. `isPending` covers the enable-gap
  // render before the fetch starts; an errored lookup releases the buy (the
  // auto-resolve degrade stays available).
  const agenciasSettling = agenciasEnabled && (agencias.isPending || agencias.isFetching);

  // Prefill: the persisted choice (`externalOptionData.agency`) when it is
  // still in the list, else the first agency — ME orders by proximity, so
  // that is the nearest, the same pick the silent auto-resolve makes.
  const defaultAgency = useMemo(() => {
    if (agencies.length === 0) return null;
    const persisted = pedido.freteInicial?.externalOptionData?.agency;
    const match =
      typeof persisted === 'number' && agencies.some((a) => a.id === persisted)
        ? persisted
        : agencies[0]!.id;
    return String(match);
  }, [agencies, pedido.freteInicial?.externalOptionData?.agency]);
  const agencyValue = agencyChoice ?? defaultAgency;

  function handleClose() {
    setAck(false);
    setBuying(false);
    setResult(null);
    setAgencyChoice(null);
    onClose();
  }

  async function handleBuy() {
    if (!client || !resolved || cartInput.isFetching || agenciasSettling) return;
    setBuying(true);
    try {
      const picked = agencyValue != null ? Number(agencyValue) : Number.NaN;
      const r = await client.comprar(
        resolved.intFreteId,
        pedidoId,
        withCartAgency(resolved.payload, Number.isFinite(picked) ? picked : null),
        pedido.freteInicial?.printLabelId ?? null,
      );
      setResult({ printUrl: r.printUrl, tracking: r.tracking });
    } catch (err) {
      // ⚠️ These outcomes are NOT a red "Falha" with Comprar re-armed — the
      // modal closes, so there is no button left to re-click. Reopening it
      // re-resolves the cart from the pedido; the cart query cached for THIS
      // opening (and, in the checkout, the frozen `pedido`) may be stale:
      //  - a timeout — our 360 s deadline, the platform's 504, or the route
      //    saying Melhor Envio stopped answering a paid step (#1094/#1679): the
      //    outcome is unknown, check first;
      //  - another buy of this pedido holds the server's claim (#1677, a 423):
      //    re-clicking only gets the same answer until it ends;
      //  - the label was PAID but the pedido no longer points at it (#1677,
      //    `ME_ETIQUETA_DESVINCULADA`): the next buy would start fresh and pay
      //    AGAIN, so this one is red, stays until dismissed, and names the label;
      //  - any other 412 — the frete changed before checkout (`ME_FRETE_ALTERADO`,
      //    nothing paid): this opening's cart was built from the OLD frete, and
      //    re-clicking would fresh-buy the old service. Only the claim answers
      //    412 on `comprar`.
      if (err instanceof FreightTimeoutError || err instanceof FreightCompraEmAndamentoError) {
        showCopyableNotification({
          title:
            err instanceof FreightCompraEmAndamentoError
              ? 'Compra de etiqueta em andamento'
              : 'Tempo esgotado ao comprar etiqueta',
          message: err.message,
          color: 'yellow',
        });
        handleClose();
        return;
      }
      if (err instanceof FreightEtiquetaDesvinculadaError) {
        showCopyableNotification({
          title: 'Etiqueta paga, mas não vinculada ao pedido',
          message: err.message,
          color: 'red',
          autoClose: false,
        });
        handleClose();
        return;
      }
      if (err instanceof FreightHttpError && err.status === 412) {
        showCopyableNotification({
          title: 'O frete do pedido mudou',
          message: err.message,
          color: 'yellow',
        });
        handleClose();
        return;
      }
      const msg = freightErrorMessage(err);
      if (msg === null) throw err;
      showErrorNotification({ title: 'Falha ao comprar etiqueta', message: msg });
    } finally {
      setBuying(false);
    }
  }

  return (
    <Modal opened={opened} onClose={handleClose} title="Comprar etiqueta" centered>
      {result ? (
        <Stack>
          <Alert color="green" variant="light">
            Etiqueta comprada com sucesso.
            {result.tracking ? ` Rastreio: ${result.tracking}` : ''}
          </Alert>
          <Group justify="flex-end">
            <Button
              variant="light"
              onClick={() => window.open(result.printUrl, '_blank', 'noopener,noreferrer')}
            >
              Abrir etiqueta
            </Button>
            <Button onClick={handleClose}>Fechar</Button>
          </Group>
        </Stack>
      ) : (
        <Stack>
          <Text size="sm">
            Pedido {pedido.numero ?? pedidoId}. A compra debita o saldo da conta Melhor Envio e gera
            a etiqueta.
          </Text>
          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              Saldo Atual
            </Text>
            <Text size="sm" fw={500}>
              {saldoLabel}
            </Text>
          </Group>
          {agencias.isLoading && (
            <Text size="sm" c="dimmed">
              Buscando agências de postagem…
            </Text>
          )}
          {agencies.length > 0 && (
            <Select
              label="Agência de postagem"
              description="Unidade da transportadora onde o pacote será postado."
              data={agencies.map((a) => ({ value: String(a.id), label: agencyLabel(a) }))}
              value={agencyValue}
              onChange={setAgencyChoice}
              searchable
              allowDeselect={false}
              disabled={buying}
            />
          )}
          {resolveError && (
            <Alert color="red" variant="light">
              {resolveError}
            </Alert>
          )}
          {cartInput.isError && (
            <Alert color="red" variant="light">
              Não foi possível carregar os dados do pedido para a compra.
            </Alert>
          )}
          {saldoInsuficiente && (
            <Alert color="orange" variant="light">
              Saldo insuficiente para o frete
              {custoFrete != null ? ` (${formatReais(custoFrete)})` : ''}. A compra pode ser
              recusada pelo Melhor Envio.
            </Alert>
          )}
          {needsPostedConfirm && (
            <Alert color="orange" title="Atenção" variant="light">
              Este frete já tem uma etiqueta emitida — reemitir pode gerar etiquetas duplicadas e
              problemas operacionais.
              <Checkbox
                mt="sm"
                label="Estou ciente do risco"
                checked={ack}
                onChange={(e) => setAck(e.currentTarget.checked)}
              />
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={handleClose} disabled={buying}>
              Cancelar
            </Button>
            <Button
              onClick={handleBuy}
              // `isFetching` (not `isLoading`) also spins through a cached
              // reopen's refetch — the resolved payload must be fresh at buy.
              loading={buying || cartInput.isFetching || agenciasSettling}
              disabled={!client || !resolved || (needsPostedConfirm && !ack)}
              color={needsPostedConfirm ? 'orange' : undefined}
            >
              Comprar etiqueta
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
