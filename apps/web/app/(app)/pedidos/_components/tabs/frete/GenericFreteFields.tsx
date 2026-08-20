'use client';

import { Group, Select, Stack } from '@mantine/core';
import { Controller } from 'react-hook-form';
import type { Firestore } from 'firebase/firestore';
import { INTEGRACAO_FRETE_LABELS, integracoesFreteSchema } from '@delfrance/schemas';
import {
  FreteDateTimeField,
  FreteNumberField,
  FreteSwitchField,
  FreteTextField,
  fretePath,
  type PedidoFormHandle,
} from './fields';
import { TransportadoraFields } from './TransportadoraFields';
import { VolumesEditor } from './VolumesEditor';

/**
 * Catch-all frete editor — port of `WidgetDeFreteGenerica`
 * (`.old/lib/pedido/widgets/frete_inicial_widget.dart:530-652`). Renders
 * for `tipo='outros'` and when no integração is selected.
 */
export function GenericFreteFields({
  form,
  db,
  disabled,
}: {
  form: PedidoFormHandle;
  db: Firestore;
  disabled?: boolean;
}) {
  return (
    <Stack gap="sm">
      <Group gap="xs" grow align="end">
        <FreteTextField form={form} name="externalId" label="ID externo" disabled={disabled} />
        <FreteTextField
          form={form}
          name="externalOptionId"
          label="Opção externa (ID)"
          disabled={disabled}
        />
        <Controller
          control={form.control}
          name={fretePath('externalOptionIntegracao')}
          render={({ field }) => (
            <Select
              label="Integração da opção externa"
              data={integracoesFreteSchema.options.map((value) => ({
                value,
                label: INTEGRACAO_FRETE_LABELS[value],
              }))}
              value={(field.value as string | null) ?? null}
              onChange={(v) => field.onChange(v)}
              clearable
              disabled={disabled}
            />
          )}
        />
      </Group>

      <TransportadoraFields form={form} disabled={disabled} />

      <Group gap="xs" grow align="end">
        <FreteTextField form={form} name="vagao" label="Vagão" maxLength={20} disabled={disabled} />
        <FreteTextField form={form} name="balsa" label="Balsa" maxLength={20} disabled={disabled} />
        <FreteTextField
          form={form}
          name="codRastreio"
          label="Código de rastreio"
          maxLength={200}
          disabled={disabled}
        />
      </Group>

      <VolumesEditor form={form} db={db} disabled={disabled} />

      <Group gap="xs" grow align="end">
        <FreteNumberField
          form={form}
          name="valorCobrado"
          label="Valor cobrado"
          description="Valor cobrado do cliente"
          disabled={disabled}
        />
        <FreteNumberField
          form={form}
          name="custoCalculado"
          label="Custo calculado"
          disabled={disabled}
        />
        <FreteNumberField form={form} name="custoFinal" label="Custo final" disabled={disabled} />
        <FreteNumberField
          form={form}
          name="valor_assegurado"
          label="Valor assegurado"
          disabled={disabled}
        />
      </Group>

      <Group gap="xs" grow align="end">
        <FreteNumberField
          form={form}
          name="prazoExtra"
          label="Prazo extra (dias)"
          decimalScale={0}
          disabled={disabled}
        />
        <FreteDateTimeField
          form={form}
          name="prazoDespacho"
          label="Data máxima para despacho"
          disabled={disabled}
        />
        <FreteDateTimeField
          form={form}
          name="dataPrevisaoEntrega"
          label="Previsão de entrega"
          disabled={disabled}
        />
        <FreteDateTimeField
          form={form}
          name="dataEntrega"
          label="Data de entrega"
          disabled={disabled}
        />
      </Group>

      <Group gap="lg">
        <FreteSwitchField form={form} name="ehReverso" label="Frete reverso" disabled={disabled} />
        <FreteSwitchField form={form} name="maoPropria" label="Mão própria" disabled={disabled} />
        <FreteSwitchField
          form={form}
          name="avisoRecebimento"
          label="Aviso de recebimento"
          disabled={disabled}
        />
      </Group>
    </Stack>
  );
}
