'use client';

import { useMemo } from 'react';
import { Alert, Group, Select, Stack } from '@mantine/core';
import type { Firestore } from 'firebase/firestore';
import { faixaCepOptionString, getPrazoDespacho, type IntFrete } from '@delfrance/schemas';
import { dateToMicros } from '@delfrance/core/datetime';
import {
  FreteDateTimeField,
  FreteNumberField,
  FreteSwitchField,
  fretePath,
  type PedidoFormHandle,
} from './fields';
import { faixaLabel, parseFaixaOptionString, selectableFaixas } from './faixaCep';
import { VolumesEditor } from './VolumesEditor';

/**
 * Motoboy — port of `MotoboyFreteWidget`
 * (`.old/lib/integracoes_frete/motoboy/widgets.dart`). The "Opção de
 * entrega" dropdown offers the integração's faixas de CEP that contain the
 * destination CEP; picking one stamps `externalOptionId` with the legacy
 * optionString and copies valor/custo into the money fields.
 */
export function MotoboyFields({
  form,
  db,
  disabled,
  integracao,
  cepDestino,
}: {
  form: PedidoFormHandle;
  db: Firestore;
  disabled?: boolean;
  integracao: IntFrete;
  cepDestino: string | null;
}) {
  const optionSelected = form.watch(fretePath('externalOptionId')) as string | null;

  const selectable = useMemo(
    () => selectableFaixas(integracao.faixaCep, cepDestino),
    [integracao.faixaCep, cepDestino],
  );

  // Stored option not in the selectable list (CEP changed, faixa edited…):
  // keep it visible — legacy parity with FaixaDeCep.fromOptionString.
  const { options, invalidStored } = useMemo(() => {
    const opts = selectable.map((f) => ({
      value: faixaCepOptionString(f),
      label: faixaLabel(f),
    }));
    if (optionSelected && !opts.some((o) => o.value === optionSelected)) {
      const parsed = parseFaixaOptionString(optionSelected);
      if (parsed) {
        opts.push({ value: optionSelected, label: faixaLabel(parsed) });
        return { options: opts, invalidStored: false };
      }
      return { options: opts, invalidStored: true };
    }
    return { options: opts, invalidStored: false };
  }, [selectable, optionSelected]);

  const onOptionChange = (value: string | null) => {
    form.setValue(fretePath('externalOptionId'), value, { shouldDirty: true });
    if (value == null) {
      // Legacy clears the money fields to 0 (not null) on deselect.
      form.setValue(fretePath('valorCobrado'), 0, { shouldDirty: true });
      form.setValue(fretePath('custoCalculado'), 0, { shouldDirty: true });
      form.setValue(fretePath('custoFinal'), 0, { shouldDirty: true });
      return;
    }
    const option = parseFaixaOptionString(value);
    if (option) {
      form.setValue(fretePath('valorCobrado'), option.valor, { shouldDirty: true });
      form.setValue(fretePath('custoCalculado'), option.custo, { shouldDirty: true });
      form.setValue(fretePath('custoFinal'), option.custo, { shouldDirty: true });
    }
    const dataPostagem = getPrazoDespacho(integracao.horarioDeCorte, new Date());
    form.setValue(fretePath('prazoDespacho'), dataPostagem ? dateToMicros(dataPostagem) : null, {
      shouldDirty: true,
    });
  };

  return (
    <Stack gap="sm">
      <VolumesEditor form={form} db={db} disabled={disabled} />

      {invalidStored && <Alert color="yellow">A opção de entrega selecionada não é válida.</Alert>}
      <Select
        label="Opção de entrega"
        data={options}
        value={optionSelected}
        onChange={onOptionChange}
        placeholder={
          cepDestino
            ? 'Selecione uma faixa de CEP…'
            : 'Selecione um endereço de entrega para listar as opções'
        }
        nothingFoundMessage="Nenhuma faixa de CEP cobre o endereço de entrega."
        clearable
        disabled={disabled}
        error={optionSelected == null ? 'Selecione uma opção de entrega' : undefined}
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
