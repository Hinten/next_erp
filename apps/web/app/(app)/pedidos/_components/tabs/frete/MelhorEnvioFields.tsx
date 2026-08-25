'use client';

import { useMemo, useState } from 'react';
import { Alert, Button, Group, Select, Stack } from '@mantine/core';
import type { Firestore } from 'firebase/firestore';
import type { IntFrete } from '@delfrance/schemas';
import { millisToMicros, nowMicros } from '@delfrance/core/datetime';
import {
  type CalculateOption,
  FreightHttpError,
  FreightNetworkError,
  FreightReauthRequiredError,
  FreightValidationError,
  buildCalculatePayload,
  isErroredOption,
  parseMePrice,
  toVolumeInput,
} from '@delfrance/integrations-freight-br/http-client';

import { useFreightClient } from '@/lib/freight/client';
import type { VolumeFormState } from '../../types';
import {
  FreteDateTimeField,
  FreteNumberField,
  FreteSwitchField,
  fretePath,
  type PedidoFormHandle,
} from './fields';
import { VolumesEditor } from './VolumesEditor';
import { EtiquetaMelhorEnvioPanel } from './EtiquetaMelhorEnvioPanel';

/**
 * Melhor Envio — quote step (F4). Replaces the F4 placeholder: edit the
 * volumes, click **Calcular frete**, pick a carrier/service from the live
 * `shipment/calculate` quotes, and the selection stamps
 * `externalOptionId` / `externalOptionData` and the money fields
 * (`custom_price` → valorCobrado/custoCalculado/custoFinal). Etiqueta
 * purchase/print/tracking arrive in F5.
 *
 * All ME calls go through `apps/integrations` (the browser never holds a
 * ME token). Origin CEP comes from the integração's "Endereço de origem"
 * (configured on /logistica/melhor-envios); destination CEP from the
 * "Quem recebe" address.
 */
export function MelhorEnvioFields({
  form,
  db,
  disabled,
  integracao,
  cepDestino,
  intFreteId,
  pedidoId,
}: {
  form: PedidoFormHandle;
  db: Firestore;
  disabled?: boolean;
  integracao: IntFrete;
  cepDestino: string | null;
  intFreteId: string;
  /** Present in edit mode (a saved pedido) — gates the etiqueta panel. */
  pedidoId?: string;
}) {
  const client = useFreightClient();
  const cepOrigem = integracao.enderecoDeOrigem?.cep ?? null;

  const selectedOptionId = form.watch(fretePath('externalOptionId')) as string | null;
  const volumes = (form.watch(fretePath('volumes')) as VolumeFormState[] | null) ?? [];
  const valorAssegurado = form.watch(fretePath('valor_assegurado')) as number | null;

  // Seed the quote list from the persisted selection so a previously-picked
  // option still shows after a tab switch — `PedidoForm`'s Tabs use
  // `keepMounted={false}`, which unmounts this tab and would otherwise drop the
  // local `quotes` state (the Select then vanishes even though the form still
  // holds `externalOptionId`/`externalOptionData`).
  const [quotes, setQuotes] = useState<CalculateOption[] | null>(() => {
    const saved = form.getValues(fretePath('externalOptionData')) as CalculateOption | null;
    return saved ? [saved] : null;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canQuote = Boolean(client) && Boolean(cepOrigem) && Boolean(cepDestino) && !disabled;

  async function handleCalcular() {
    if (!client || !cepOrigem || !cepDestino) return;
    setLoading(true);
    setError(null);
    try {
      const payload = buildCalculatePayload({
        fromPostalCode: cepOrigem,
        toPostalCode: cepDestino,
        volumes: volumes.map(toVolumeInput),
        insuranceValue: valorAssegurado,
      });
      setQuotes(await client.calculate(intFreteId, payload));
    } catch (err) {
      if (err instanceof FreightReauthRequiredError) {
        setError('Conta Melhor Envio desconectada. Reconecte em Logística › Melhor Envio.');
        return;
      }
      if (err instanceof FreightValidationError) {
        const msgs = Object.values(err.errors).flat();
        setError(msgs.length > 0 ? msgs.join('; ') : err.message);
        return;
      }
      if (err instanceof FreightHttpError) {
        setError(err.message);
        return;
      }
      if (err instanceof FreightNetworkError) {
        setError('Falha de rede ao cotar o frete.');
        return;
      }
      throw err;
    } finally {
      setLoading(false);
    }
  }

  const quoteOptions = useMemo(() => {
    if (!quotes) return [];
    return quotes.map((q) => {
      const errored = isErroredOption(q);
      const carrier = `${q.company?.name ?? ''} ${q.name}`.trim();
      const price = q.custom_price ?? q.price;
      const label = errored
        ? `${carrier} — indisponível`
        : `${carrier} — R$ ${price ?? '?'}${q.delivery_time != null ? ` (${q.delivery_time} dia(s))` : ''}`;
      return { value: String(q.id), label, disabled: errored };
    });
  }, [quotes]);

  function onSelectQuote(value: string | null) {
    if (value == null) {
      // Clear every quote-derived field so no metadata from a previous
      // selection lingers after the user clears the option.
      form.setValue(fretePath('externalOptionId'), null, { shouldDirty: true });
      form.setValue(fretePath('externalOptionIntegracao'), null, { shouldDirty: true });
      form.setValue(fretePath('externalOptionData'), null, { shouldDirty: true });
      form.setValue(fretePath('externalOptionSelectionDate'), null, { shouldDirty: true });
      form.setValue(fretePath('valorCobrado'), 0, { shouldDirty: true });
      form.setValue(fretePath('custoCalculado'), 0, { shouldDirty: true });
      form.setValue(fretePath('custoFinal'), 0, { shouldDirty: true });
      form.setValue(fretePath('dataPrevisaoEntrega'), null, { shouldDirty: true });
      return;
    }
    const option = quotes?.find((q) => String(q.id) === value);
    if (!option || isErroredOption(option)) return;
    // ⚠️ `?? 0` is a deliberate, visible choice, not a coercion. `parseMePrice`
    // returns null rather than inventing a value (it replaced a private
    // `Number(s)` here, which read '' as 0, '0x1F' as 31 and '1e3' as 1000), so
    // falling back to zero is this screen SAYING "quote it at R$ 0,00". It is
    // reachable only for an option ME priced unreadably — the no-price case is
    // already filtered by `isErroredOption` above.
    const price = parseMePrice(option.custom_price ?? option.price) ?? 0;
    // Strip any `undefined` so Firestore accepts the stored snapshot.
    const optionData = JSON.parse(JSON.stringify(option)) as Record<string, unknown>;

    form.setValue(fretePath('externalOptionId'), value, { shouldDirty: true });
    // `externalOptionIntegracao` is the integração **tipo** enum
    // (`integracoesFreteSchema`), not a doc id — mirrors the legacy
    // `createOrderTool.dart` (`integracao.tipo`). Writing `intFreteId` here
    // failed the enum on save, and since the field has no input the error was
    // invisible (#218). `integracaoFreteOuterRef` already carries which int_frete.
    form.setValue(fretePath('externalOptionIntegracao'), integracao.tipo, { shouldDirty: true });
    form.setValue(fretePath('externalOptionData'), optionData, { shouldDirty: true });
    form.setValue(fretePath('externalOptionSelectionDate'), nowMicros(), { shouldDirty: true });
    form.setValue(fretePath('valorCobrado'), price, { shouldDirty: true });
    form.setValue(fretePath('custoCalculado'), price, { shouldDirty: true });
    form.setValue(fretePath('custoFinal'), price, { shouldDirty: true });
    if (option.delivery_time != null) {
      form.setValue(
        fretePath('dataPrevisaoEntrega'),
        millisToMicros(Date.now() + option.delivery_time * 86_400_000),
        { shouldDirty: true },
      );
    }
  }

  return (
    <Stack gap="sm">
      <VolumesEditor form={form} db={db} disabled={disabled} />

      {!cepOrigem && (
        <Alert color="yellow">
          Configure o endereço de origem da integração Melhor Envio para cotar.
        </Alert>
      )}
      {!cepDestino && (
        <Alert color="yellow">Selecione um endereço de entrega (Quem recebe) para cotar.</Alert>
      )}

      <Group>
        <Button
          type="button"
          variant="light"
          onClick={handleCalcular}
          loading={loading}
          disabled={!canQuote}
        >
          Calcular frete
        </Button>
      </Group>

      {error && <Alert color="red">{error}</Alert>}

      {quotes && (
        <Select
          label="Opção de frete"
          data={quoteOptions}
          value={selectedOptionId}
          onChange={onSelectQuote}
          placeholder="Selecione uma cotação"
          nothingFoundMessage="Nenhuma cotação disponível."
          clearable
          disabled={disabled}
        />
      )}

      <Group gap="xs" grow align="end">
        <FreteNumberField
          form={form}
          name="valorCobrado"
          label="Valor cobrado"
          disabled={disabled}
        />
        <FreteNumberField
          form={form}
          name="custoCalculado"
          label="Custo calculado"
          disabled={disabled}
        />
        <FreteNumberField form={form} name="custoFinal" label="Custo final" disabled={disabled} />
      </Group>

      <Group gap="xs" grow align="end">
        <FreteNumberField
          form={form}
          name="valor_assegurado"
          label="Valor assegurado"
          disabled={disabled}
        />
        <FreteDateTimeField
          form={form}
          name="dataPrevisaoEntrega"
          label="Previsão de entrega"
          disabled={disabled}
        />
      </Group>

      <Group gap="lg">
        <FreteSwitchField
          form={form}
          name="avisoRecebimento"
          label="Aviso de recebimento"
          disabled={disabled}
        />
        <FreteSwitchField form={form} name="maoPropria" label="Mão própria" disabled={disabled} />
        <FreteSwitchField form={form} name="ehReverso" label="Frete reverso" disabled={disabled} />
      </Group>

      {pedidoId && <EtiquetaMelhorEnvioPanel form={form} intFreteId={intFreteId} />}
    </Stack>
  );
}
