'use client';

import { SimpleGrid, Stack, Switch, TextInput } from '@mantine/core';
import { ORIGEM_PRODUTO_LABELS } from '@delfrance/schemas';
import { EnumSelect } from './fields';
import type { ImpostoConfigValue } from './types';

export interface DadosGeraisSectionProps {
  value: ImpostoConfigValue;
  onChange: (next: ImpostoConfigValue) => void;
  disabled?: boolean;
  errorNode?: Record<string, { message?: string } | undefined>;
}

/** Dados Gerais fiscais (origem, CFOP, NCM, CEST, …) — the per-item overrides. */
export function DadosGeraisSection({
  value,
  onChange,
  disabled,
  errorNode,
}: DadosGeraisSectionProps) {
  function set(key: keyof ImpostoConfigValue, v: unknown) {
    onChange({ ...value, [key]: v });
  }
  const text = (key: keyof ImpostoConfigValue) => (value[key] as string | null) ?? '';
  const err = (key: string) => errorNode?.[key]?.message;

  return (
    <Stack gap="sm">
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
        <EnumSelect
          label="Origem"
          labels={ORIGEM_PRODUTO_LABELS}
          value={(value.origem as string | null) ?? null}
          onChange={(v) => set('origem', v)}
          disabled={disabled}
          error={err('origem')}
        />
        <TextInput
          label="CFOP"
          value={text('cfop')}
          onChange={(e) => set('cfop', e.currentTarget.value || null)}
          error={err('cfop')}
          disabled={disabled}
        />
        <TextInput
          label="CFOP interestadual"
          value={text('cfopInterestadual')}
          onChange={(e) => set('cfopInterestadual', e.currentTarget.value || null)}
          error={err('cfopInterestadual')}
          disabled={disabled}
        />
        <TextInput
          label="NCM"
          description="8 dígitos."
          maxLength={8}
          value={text('NCM')}
          onChange={(e) => set('NCM', e.currentTarget.value || null)}
          error={err('NCM')}
          disabled={disabled}
        />
        <TextInput
          label="NVE"
          value={text('NVE')}
          onChange={(e) => set('NVE', e.currentTarget.value || null)}
          disabled={disabled}
        />
        <TextInput
          label="CEST"
          description="7 dígitos."
          maxLength={7}
          value={text('CEST')}
          onChange={(e) => set('CEST', e.currentTarget.value || null)}
          error={err('CEST')}
          disabled={disabled}
        />
        <TextInput
          label="Indicador de escala"
          value={text('indEscala')}
          onChange={(e) => set('indEscala', e.currentTarget.value || null)}
          disabled={disabled}
        />
        <TextInput
          label="CNPJ do fabricante"
          value={text('CNPJFab')}
          onChange={(e) => set('CNPJFab', e.currentTarget.value || null)}
          disabled={disabled}
        />
        <TextInput
          label="Código de benefício fiscal (cBenef)"
          value={text('cBenef')}
          onChange={(e) => set('cBenef', e.currentTarget.value || null)}
          disabled={disabled}
        />
        <TextInput
          label="EX TIPI"
          value={text('extipi')}
          onChange={(e) => set('extipi', e.currentTarget.value || null)}
          disabled={disabled}
        />
        <TextInput
          label="Unidade tributável"
          maxLength={6}
          value={text('unidade')}
          onChange={(e) => set('unidade', e.currentTarget.value || null)}
          disabled={disabled}
        />
      </SimpleGrid>
      <Switch
        label="Compõe o valor total da NF-e"
        checked={value.compoeValorTotalDaNFe === true}
        onChange={(e) => set('compoeValorTotalDaNFe', e.currentTarget.checked)}
        disabled={disabled}
      />
    </Stack>
  );
}
