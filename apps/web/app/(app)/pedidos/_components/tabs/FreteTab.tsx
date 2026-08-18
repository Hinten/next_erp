'use client';

import { useEffect, useMemo, useRef } from 'react';
import { Alert, Divider, Group, Select, Skeleton, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconExclamationCircle } from '@tabler/icons-react';
import { Controller } from 'react-hook-form';
import { type Firestore } from 'firebase/firestore';
import {
  MODALIDADE_FRETE,
  ESTADO_FRETE_LABELS,
  MODALIDADE_FRETE_LABELS,
  estadoFreteSchema,
  isFreteMarketplaceOwned,
  modalidadeFreteSchema,
  type ModalidadeFrete,
} from '@delfrance/schemas';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { ClientePicker } from '@/components/pickers/ClientePicker';
import { EnderecoPicker, useEnderecoFromRef } from '@/components/pickers/EnderecoPicker';
import { intFreteCollection } from '@/lib/data/intFreteCollection';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import type { FreteInicialFormState, VolumeFormState } from '../types';
import { collectFreteErrors } from '../freteErrors';
import { FreteSwitchField, fretePath, type PedidoFormHandle } from './frete/fields';
import { seedFreteInicial } from './frete/seedFreteInicial';
import { pesoPedido, shouldSeedVolume, volumePadrao } from './frete/pesoPedido';
import { useProdutoPesoMap } from './frete/useProdutoPesoMap';
import { IntegracaoFreteSelect } from './frete/IntegracaoFreteSelect';
import { GenericFreteFields } from './frete/GenericFreteFields';
import { RetiradaFields } from './frete/RetiradaFields';
import { MotoboyFields } from './frete/MotoboyFields';
import { FobFields } from './frete/FobFields';
import { MelhorEnvioFields } from './frete/MelhorEnvioFields';
import { MarketplaceReadOnly } from './frete/MarketplaceReadOnly';

export interface FreteTabProps {
  form: PedidoFormHandle;
  db: Firestore;
  disabled?: boolean;
  /** Present in edit mode; absent on /pedidos/novo. */
  pedidoId?: string;
}

/**
 * Frete tab — port of the legacy `FreteInicialWidget`
 * (`.old/lib/pedido/widgets/frete_inicial_widget.dart`). The modalidade
 * selector gates everything: '9' (sem frete) collapses the editor but keeps
 * whatever `freteInicial` data the doc carries (legacy semantics). Picking
 * a freight modalidade on a pedido without `freteInicial` seeds the block
 * via `freteDoPedidoSchema.parse`, so every wire key starts at its Flutter
 * default.
 */
export function FreteTab({ form, db, disabled, pedidoId }: FreteTabProps) {
  const freteInicial = form.watch('freteInicial');
  const modalidade: ModalidadeFrete = freteInicial?.modalidade ?? MODALIDADE_FRETE.semTransporte;
  const temFrete = freteInicial != null && modalidade !== MODALIDADE_FRETE.semTransporte;
  // Direction of the pedido — seeds `ehReverso` on a fresh freteInicial
  // (entrada → reverse by default).
  const ehSaida = form.watch('ehSaida') ?? true;

  const clientePedidoOuterRef = form.watch('clientePedidoOuterRef');

  // Surface every invalid `freteInicial` field — including derived/cache fields
  // with no rendered input, which only mark the tab and never show inline
  // (#218). Reading `formState.errors` here subscribes the tab to error changes.
  const freteErrors = collectFreteErrors(form.formState.errors.freteInicial);

  const { endereco: enderecoFrete } = useEnderecoFromRef(
    db,
    freteInicial?.enderecoFreteOuterReference,
  );
  const cepDestino = enderecoFrete?.cep ?? null;

  const integracaoRef = useMemo(
    () => dereferenceOuterRef(db, freteInicial?.integracaoFreteOuterRef),
    [db, freteInicial?.integracaoFreteOuterRef],
  );
  const integracaoDocRef = useMemo(
    () => (integracaoRef ? intFreteCollection.docRef(db, {}, integracaoRef.id) : null),
    [db, integracaoRef],
  );
  const { data: integracaoDoc, loading: loadingIntegracao } = useDocSnapshot(integracaoDocRef);

  function onModalidadeChange(value: string | null) {
    const next = modalidadeFreteSchema.safeParse(value);
    if (!next.success) return;
    if (next.data === '9') {
      // Sem frete: collapse but keep the stored data (legacy parity).
      if (freteInicial) {
        form.setValue(fretePath('modalidade'), '9', { shouldDirty: true, shouldValidate: true });
      }
      return;
    }
    if (!freteInicial) {
      const seeded = seedFreteInicial(next.data, ehSaida);
      form.setValue('freteInicial', seeded as unknown as FreteInicialFormState, {
        shouldDirty: true,
        shouldValidate: true,
      });
      return;
    }
    form.setValue(fretePath('modalidade'), next.data, { shouldDirty: true, shouldValidate: true });
  }

  function onIntegracaoChange(id: string | null) {
    const currentId = integracaoRef?.id ?? null;
    form.setValue(fretePath('integracaoFreteOuterRef'), id ? `documents/int_frete/${id}` : null, {
      shouldDirty: true,
      shouldValidate: true,
    });
    if (id === currentId) return;

    // The integração changed → its quote (calculated for the old origin/account)
    // and any bought label (tied to the old ME account) are now stale. Clear
    // them so a stale `printLabelId` can't be printed/tracked against the new
    // integração. Only act when there is actually something to invalidate.
    const hadQuote = (form.getValues(fretePath('externalOptionId')) as string | null) != null;
    const hadLabel = (form.getValues(fretePath('printLabelId')) as string | null) != null;
    if (!hadQuote && !hadLabel) return;

    const dirty = { shouldDirty: true } as const;
    form.setValue(fretePath('externalOptionId'), null, dirty);
    form.setValue(fretePath('externalOptionIntegracao'), null, dirty);
    form.setValue(fretePath('externalOptionData'), null, dirty);
    form.setValue(fretePath('externalOptionSelectionDate'), null, dirty);
    form.setValue(fretePath('valorCobrado'), 0, dirty);
    form.setValue(fretePath('custoCalculado'), 0, dirty);
    form.setValue(fretePath('custoFinal'), 0, dirty);
    form.setValue(fretePath('dataPrevisaoEntrega'), null, dirty);
    form.setValue(fretePath('printLabelId'), null, dirty);
    form.setValue(fretePath('codRastreio'), null, dirty);
    form.setValue(fretePath('estado'), 'iniciado', dirty);
    // Drop any stale freteInicial validation errors from the previous quote —
    // validation runs onBlur, so without this the error Alert (#218) can keep
    // showing errors for fields we just reset. Re-run validation against the
    // reset values so a still-invalid field re-surfaces immediately.
    form.clearErrors('freteInicial');
    void form.trigger('freteInicial');

    if (hadLabel) {
      notifications.show({
        color: 'yellow',
        title: 'Etiqueta desvinculada',
        message:
          'A integração de frete foi alterada — a etiqueta e a cotação anteriores foram desvinculadas. Cote e compre novamente.',
      });
    }
  }

  const tipo = integracaoDoc?.data.tipo;
  // Marketplace-managed freight (importer owns the whole block): lock the
  // common header fields too — modalidade, endereço, recebedor, status and
  // the integração itself — not just the per-tipo body. Remapping a
  // marketplace shipping option happens via the integração's `mapa`, never
  // by hand-editing the pedido. While the integração doc is still resolving
  // the header stays locked as well (tipo unknown = ownership unknown); a
  // resolved-but-missing doc unlocks it so a dangling ref can be fixed.
  // Shared predicate with the pedido estado reconcile, which refuses to authorize
  // dispatch on a marketplace-owned block (#702). The two feed it DIFFERENT tipos
  // and can disagree: here it is the resolved `int_frete` doc, server-side it is
  // `freteInicial.externalOptionIntegracao` (no extra read inside the transaction).
  const marketplaceOwned = isFreteMarketplaceOwned(tipo);
  const headerDisabled =
    disabled || marketplaceOwned || (integracaoRef != null && loadingIntegracao);

  // Auto-weight + default Volume (#371, port of the legacy ME widget's
  // seed-if-empty init). Only fetches/considers seeding when there's a real
  // chance of it: frete active, not marketplace-owned (that block is
  // importer-owned end to end — never inject a fabricated Volume into it),
  // and no volume already stored. `pendingActivationRef` further latches to a
  // genuine same-session `temFrete` false→true transition (a live
  // `onModalidadeChange`, not the initial load of an already-active pedido)
  // so the seed's `shouldDirty: true` is always a real user action — it never
  // races the page's post-load server-truth correction, which only repaints
  // a still-clean form, nor re-fabricates a Volume an operator removed and
  // saved on purpose.
  const itensFlat = form.watch('_itensFlat') ?? [];
  const hasStoredVolumes = !!freteInicial?.volumes && freteInicial.volumes.length > 0;
  const produtoUidsForPeso = useMemo(
    () =>
      temFrete && !marketplaceOwned && !hasStoredVolumes
        ? itensFlat.filter((i) => !i._delete && !!i.produtoUid).map((i) => i.produtoUid as string)
        : [],
    [temFrete, marketplaceOwned, hasStoredVolumes, itensFlat],
  );
  const produtoPesoById = useProdutoPesoMap(db, produtoUidsForPeso);
  const wasTemFreteRef = useRef(temFrete);
  const pendingActivationRef = useRef(false);
  const autoSeededVolumeRef = useRef(false);
  useEffect(() => {
    const wasTemFrete = wasTemFreteRef.current;
    wasTemFreteRef.current = temFrete;
    if (!wasTemFrete && temFrete) pendingActivationRef.current = true;

    if (autoSeededVolumeRef.current) return;
    if (produtoPesoById === undefined) return; // batch still in flight
    const currentVolumes = form.getValues(fretePath('volumes')) as VolumeFormState[] | null;
    const shouldSeed = shouldSeedVolume({
      pendingActivation: pendingActivationRef.current,
      marketplaceOwned,
      volumes: currentVolumes,
      produtoPesoById,
    });
    if (!shouldSeed) return;
    autoSeededVolumeRef.current = true;
    const peso = pesoPedido(
      itensFlat
        .filter((i) => !i._delete)
        .map((i) => ({
          produtoUid: i.produtoUid,
          quantidade: i.quantidade,
        })),
      produtoPesoById,
    );
    form.setValue(fretePath('volumes'), [volumePadrao(peso)], {
      shouldDirty: true,
      shouldValidate: true,
    });
  }, [temFrete, marketplaceOwned, itensFlat, produtoPesoById, form]);

  function renderTipoFields() {
    if (!integracaoRef) return <GenericFreteFields form={form} disabled={disabled} />;
    if (loadingIntegracao) return <Skeleton height={120} />;
    if (!integracaoDoc) {
      return (
        <Alert color="yellow">
          A integração de frete vinculada a este pedido não foi encontrada.
        </Alert>
      );
    }
    if (marketplaceOwned && tipo) {
      return <MarketplaceReadOnly frete={freteInicial!} tipo={tipo} />;
    }
    switch (tipo) {
      case 'retiradaNaLoja':
        return (
          <RetiradaFields
            form={form}
            disabled={disabled}
            integracao={integracaoDoc.data}
            isCreate={!pedidoId}
          />
        );
      case 'motoboy':
        return (
          <MotoboyFields
            form={form}
            disabled={disabled}
            integracao={integracaoDoc.data}
            cepDestino={cepDestino}
          />
        );
      case 'fob':
        return <FobFields form={form} disabled={disabled} />;
      case 'melhorEnvios':
        return (
          <MelhorEnvioFields
            form={form}
            disabled={disabled}
            integracao={integracaoDoc.data}
            cepDestino={cepDestino}
            intFreteId={integracaoDoc.id}
            pedidoId={pedidoId}
          />
        );
      default:
        return <GenericFreteFields form={form} disabled={disabled} />;
    }
  }

  return (
    <Stack>
      {freteErrors.length > 0 && (
        <Alert
          color="red"
          title="Corrija os campos do frete"
          icon={<IconExclamationCircle size={16} />}
        >
          <Stack gap={2}>
            {freteErrors.map((e) => (
              <Text key={e.path} size="sm">
                <Text span fw={500}>
                  {e.label}:
                </Text>{' '}
                {e.message}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}

      <Select
        label="Modalidade de frete"
        data={modalidadeFreteSchema.options.map((value) => ({
          value,
          label: MODALIDADE_FRETE_LABELS[value],
        }))}
        value={modalidade}
        onChange={onModalidadeChange}
        allowDeselect={false}
        disabled={headerDisabled}
      />

      {!temFrete && (
        <Text size="sm" c="dimmed">
          Sem ocorrência de transporte. Selecione outra modalidade para configurar o frete.
        </Text>
      )}

      {temFrete && (
        <Stack gap="sm">
          {/* The integração drives the tipo (and the whole body below), so it
              comes first — picking it is the entry point for configuring the
              frete. */}
          <IntegracaoFreteSelect
            db={db}
            value={integracaoRef?.id ?? null}
            currentFallback={
              integracaoDoc
                ? {
                    id: integracaoDoc.id,
                    nome: integracaoDoc.data.nome,
                    tipo: integracaoDoc.data.tipo,
                  }
                : null
            }
            onChange={onIntegracaoChange}
            disabled={headerDisabled}
          />
          <Text size="xs" c="dimmed">
            A integração de frete define o tipo de cálculo e as opções disponíveis abaixo.
          </Text>

          <Divider label="Entrega" labelPosition="left" />

          <EnderecoPicker
            db={db}
            clienteOuterRef={clientePedidoOuterRef}
            value={freteInicial.enderecoFreteOuterReference}
            onChange={(docPath) =>
              form.setValue(fretePath('enderecoFreteOuterReference'), docPath, {
                shouldDirty: true,
                shouldValidate: true,
              })
            }
            disabled={headerDisabled}
          />

          <Controller
            control={form.control}
            name={fretePath('clienteRecebedorOuterReference')}
            render={({ field, fieldState }) => (
              <ClientePicker
                fieldName={field.name}
                label="Quem recebe"
                value={field.value}
                onChange={field.onChange}
                onBlur={field.onBlur}
                disabled={headerDisabled}
                error={fieldState.error?.message}
              />
            )}
          />

          <Controller
            control={form.control}
            name={fretePath('estado')}
            render={({ field, fieldState }) => (
              <Select
                label="Status do frete"
                data={estadoFreteSchema.options.map((value) => ({
                  value,
                  label: ESTADO_FRETE_LABELS[value],
                }))}
                value={(field.value as string | null) ?? 'iniciado'}
                onChange={(v) => field.onChange(v)}
                allowDeselect={false}
                searchable
                disabled={headerDisabled}
                error={fieldState.error?.message}
              />
            )}
          />

          <FreteSwitchField
            form={form}
            name="ehReverso"
            label="Frete reverso"
            description="Transporte no sentido cliente → loja (padrão em entradas)."
            disabled={headerDisabled}
          />

          <Divider />

          <Group grow align="flex-start">
            {renderTipoFields()}
          </Group>
        </Stack>
      )}
    </Stack>
  );
}
