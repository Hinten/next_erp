'use client';

import { Select, SimpleGrid, Stack, Switch, TagsInput, TextInput } from '@mantine/core';
import { ORIGEM_PRODUTO_LABELS, indEscalaFromScalar, nveFromScalar } from '@delfrance/schemas';
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

  // `NVE`/`indEscala` are stored in their real wire shapes (`string[]` / boolean),
  // but a doc that failed `parseSoftRead` for ANY unrelated reason comes back raw
  // — and then these two can still be the pre-#466 scalar the old editor wrote.
  // Fold through the SAME helpers storage uses, so what is displayed and what
  // would be stored can never disagree.
  const nve = Array.isArray(value.NVE)
    ? value.NVE
    : typeof value.NVE === 'string'
      ? (nveFromScalar(value.NVE) ?? [])
      : [];
  const indEscala =
    typeof value.indEscala === 'boolean'
      ? value.indEscala
      : typeof value.indEscala === 'string'
        ? indEscalaFromScalar(value.indEscala)
        : null;

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
        <TagsInput
          label="NVE"
          description="Até 8 códigos, 2 letras + 4 dígitos (ex.: AB1234). Enter para adicionar."
          maxTags={8}
          value={nve}
          onChange={(v) => set('NVE', v.length > 0 ? v : null)}
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
        <Select
          label="Indicador de escala"
          description="Produção em escala relevante (Convênio ICMS 52/2017)."
          placeholder="Não informado"
          clearable
          data={[
            { value: 'S', label: 'Sim' },
            { value: 'N', label: 'Não' },
          ]}
          value={indEscala === true ? 'S' : indEscala === false ? 'N' : null}
          onChange={(v) => set('indEscala', v === 'S' ? true : v === 'N' ? false : null)}
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
