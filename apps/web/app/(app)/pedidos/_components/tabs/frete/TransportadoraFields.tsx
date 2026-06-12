'use client';

import { Accordion, Group, Select, TextInput } from '@mantine/core';
import { ufSchema } from '@delfrance/schemas';
import type { TransportadoraFormState } from '../../types';
import type { PedidoFormHandle } from './fields';
import { fretePath } from './fields';

const EMPTY: TransportadoraFormState = {
  cnpj: null,
  ie: null,
  nome: null,
  endereco: null,
  municipio: null,
  uf: null,
};

/**
 * "Dados fiscais da transportadora" — collapsible like the legacy
 * `TransportadoraFiscalDataWidget` (ExpansionTile). Field names are the
 * Flutter wire names (`cnpj`/`ie`/`nome`/`endereco`/`municipio`/`uf`);
 * an all-empty block collapses to `null` at save time
 * (`normalizeFreteInicial`).
 */
export function TransportadoraFields({
  form,
  disabled,
}: {
  form: PedidoFormHandle;
  disabled?: boolean;
}) {
  const transportadora =
    (form.watch(fretePath('transportadora')) as TransportadoraFormState | null) ?? null;

  const set = (key: keyof TransportadoraFormState, value: string | null) => {
    form.setValue(
      fretePath('transportadora'),
      { ...(transportadora ?? EMPTY), [key]: value },
      { shouldDirty: true, shouldValidate: true },
    );
  };

  const text = (
    key: Exclude<keyof TransportadoraFormState, 'uf'>,
    label: string,
    maxLength: number,
  ) => (
    <TextInput
      label={label}
      value={transportadora?.[key] ?? ''}
      onChange={(e) => set(key, e.currentTarget.value || null)}
      maxLength={maxLength}
      disabled={disabled}
      style={{ flex: 1, minWidth: 180 }}
    />
  );

  return (
    <Accordion variant="contained" defaultValue={transportadora?.nome ? 'transportadora' : null}>
      <Accordion.Item value="transportadora">
        <Accordion.Control>Dados fiscais da transportadora</Accordion.Control>
        <Accordion.Panel>
          <Group gap="xs" align="end">
            {text('cnpj', 'CNPJ', 14)}
            {text('ie', 'Inscrição Estadual', 14)}
            {text('nome', 'Razão social ou nome', 60)}
            {text('endereco', 'Endereço', 60)}
            {text('municipio', 'Município', 60)}
            <Select
              label="UF"
              data={[...ufSchema.options]}
              value={transportadora?.uf ?? null}
              onChange={(v) => set('uf', v)}
              clearable
              searchable
              disabled={disabled}
              w={110}
            />
          </Group>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}
