'use client';

import { Group, Stack } from '@mantine/core';
import type { Firestore } from 'firebase/firestore';
import {
  FreteDateTimeField,
  FreteNumberField,
  FreteSwitchField,
  FreteTextField,
  type PedidoFormHandle,
} from './fields';
import { VolumesEditor } from './VolumesEditor';

/**
 * Frete por conta do destinatário (FOB) — port of `FreteFobWidget`
 * (`.old/lib/integracoes_frete/por_conta_do_destinatario/widgets.dart`).
 * Single volume max, tracking code, money fields and deadlines.
 */
export function FobFields({
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
      <VolumesEditor form={form} db={db} disabled={disabled} maxVolumes={1} />

      <FreteTextField
        form={form}
        name="codRastreio"
        label="Código de rastreio"
        maxLength={200}
        disabled={disabled}
      />

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
      </Group>

      <Group gap="xs" grow align="end">
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
      </Group>

      <FreteSwitchField form={form} name="ehReverso" label="Frete reverso" disabled={disabled} />
    </Stack>
  );
}
