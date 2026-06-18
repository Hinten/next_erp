'use client';

import { useMemo } from 'react';
import { Alert, Divider, Group, Select, Skeleton, Stack, Text } from '@mantine/core';
import { Controller } from 'react-hook-form';
import { type Firestore } from 'firebase/firestore';
import {
  ESTADO_FRETE_LABELS,
  MODALIDADE_FRETE_LABELS,
  estadoFreteSchema,
  freteDoPedidoSchema,
  modalidadeFreteSchema,
  type ModalidadeFrete,
} from '@delfrance/schemas';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { ClientePicker } from '@/components/pickers/ClientePicker';
import { EnderecoPicker, useEnderecoFromRef } from '@/components/pickers/EnderecoPicker';
import { intFreteCollection } from '@/lib/data/intFreteCollection';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import type { FreteInicialFormState } from '../types';
import { fretePath, type PedidoFormHandle } from './frete/fields';
import { IntegracaoFreteSelect } from './frete/IntegracaoFreteSelect';
import { GenericFreteFields } from './frete/GenericFreteFields';
import { RetiradaFields } from './frete/RetiradaFields';
import { MotoboyFields } from './frete/MotoboyFields';
import { FobFields } from './frete/FobFields';
import { MelhorEnvioFields } from './frete/MelhorEnvioFields';
import { MarketplaceReadOnly } from './frete/MarketplaceReadOnly';

const MARKETPLACE_TIPOS = new Set(['mercadoLivre', 'lojaIntegrada', 'amz', 'magalu', 'shopee']);

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
  const modalidade: ModalidadeFrete = freteInicial?.modalidade ?? '9';
  const temFrete = freteInicial != null && modalidade !== '9';

  const clientePedidoOuterRef = form.watch('clientePedidoOuterRef');

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
      const seeded = freteDoPedidoSchema.parse({ estado: 'iniciado', modalidade: next.data });
      form.setValue('freteInicial', seeded as unknown as FreteInicialFormState, {
        shouldDirty: true,
        shouldValidate: true,
      });
      return;
    }
    form.setValue(fretePath('modalidade'), next.data, { shouldDirty: true, shouldValidate: true });
  }

  const tipo = integracaoDoc?.data.tipo;
  // Marketplace-managed freight (importer owns the whole block): lock the
  // common header fields too — modalidade, endereço, recebedor, status and
  // the integração itself — not just the per-tipo body. Remapping a
  // marketplace shipping option happens via the integração's `mapa`, never
  // by hand-editing the pedido. While the integração doc is still resolving
  // the header stays locked as well (tipo unknown = ownership unknown); a
  // resolved-but-missing doc unlocks it so a dangling ref can be fixed.
  const marketplaceOwned = tipo != null && MARKETPLACE_TIPOS.has(tipo);
  const headerDisabled =
    disabled || marketplaceOwned || (integracaoRef != null && loadingIntegracao);

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
            onChange={(id) =>
              form.setValue(
                fretePath('integracaoFreteOuterRef'),
                id ? `documents/int_frete/${id}` : null,
                { shouldDirty: true, shouldValidate: true },
              )
            }
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
                emitDocPath
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

          <Divider />

          <Group grow align="flex-start">
            {renderTipoFields()}
          </Group>
        </Stack>
      )}
    </Stack>
  );
}
