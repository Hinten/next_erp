'use client';

import { useEffect } from 'react';
import { Group, Stack } from '@mantine/core';
import { getPrazoDespacho, type IntFrete } from '@delfrance/schemas';
import { dateToMicros } from '@delfrance/core/datetime';
import { FreteDateTimeField, FreteNumberField, fretePath, type PedidoFormHandle } from './fields';
import { TransportadoraFields } from './TransportadoraFields';
import { VolumesEditor } from './VolumesEditor';

/**
 * Retirada na loja — port of `RetirarNaLojaFreteWidget`
 * (`.old/lib/integracoes_frete/retirar_na_loja/widgets.dart`). The
 * dispatch deadline autofills from the integração's cut-off schedule when
 * the pedido is being created (or when the user just attached the
 * integração in this session) — never on a plain reload of an existing
 * pedido, so a no-op save stays byte-stable.
 */
export function RetiradaFields({
  form,
  disabled,
  integracao,
  isCreate,
}: {
  form: PedidoFormHandle;
  disabled?: boolean;
  integracao: IntFrete;
  isCreate: boolean;
}) {
  const prazoDespacho = form.watch(fretePath('prazoDespacho')) as number | null;
  const integracaoDirty = form.getFieldState(fretePath('integracaoFreteOuterRef')).isDirty;
  const horarios = integracao.horarioDeCorte;

  useEffect(() => {
    if (prazoDespacho != null || disabled) return;
    if (!isCreate && !integracaoDirty) return;
    const data = getPrazoDespacho(horarios, new Date());
    if (data) {
      form.setValue(fretePath('prazoDespacho'), dateToMicros(data), { shouldDirty: true });
    }
    // Re-run only when the schedule source changes — prazoDespacho is read
    // fresh inside and the fill is one-shot (non-null afterwards).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [horarios, isCreate, integracaoDirty]);

  return (
    <Stack gap="sm">
      <VolumesEditor form={form} disabled={disabled} />

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

      <TransportadoraFields form={form} disabled={disabled} />
    </Stack>
  );
}
