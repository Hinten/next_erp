'use client';

import { useFormContext } from 'react-hook-form';
import { Button, Group, MultiSelect, Select, Stack } from '@mantine/core';
import { z } from 'zod';
import {
  FIN_NFE_OPERACAO_LABELS,
  IND_INTERMED_OPERACAO_LABELS,
  IND_PRES_OPERACAO_LABELS,
  ORIGEM_PRODUTO_LABELS,
  TIPO_NFE_LABELS,
  operacaoSchema,
  ufSchema,
} from '@delfrance/schemas';
import { valuesEqual } from '@delfrance/core';
import type { FieldConfig } from '@delfrance/ui';
import {
  ImpostoConfigEditor,
  IMPOSTO_CONFIG_KEYS,
  type ImpostoConfigValue,
} from '@/components/imposto';

export const OPERACAO_SECTIONS = [
  'Dados gerais',
  'Impostos (padrão)',
  'Regras de imposto',
] as const;

/** `estados` is a legacy duplicate of `estadosDestino`; `timestamp` is stamped. */
export const OPERACAO_EXCLUDED_FIELDS = ['timestamp', 'estados'];

/** The transient host field for the self-contained Macros (regras) tab. */
export const OPERACAO_TRANSIENT_FIELDS = ['macros'];

/**
 * Wider page schema: the operação doc + a transient `macros` host field that
 * renders the self-contained regras editor (never written to the doc).
 * operacaoSchema has no top-level refine, so `.extend` is safe.
 */
export const operacaoPageSchema = operacaoSchema.extend({
  macros: z.unknown().nullable().default(null),
});

function toOptions(labels: Record<string, string>) {
  return Object.entries(labels).map(([value, label]) => ({ value, label }));
}

const UF_OPTIONS = ufSchema.options.map((uf) => ({ value: uf, label: uf }));
const ALL_UFS: string[] = [...ufSchema.options];

/**
 * Bridges the operação form (RHF context) to the {@link ImpostoConfigEditor}:
 * the deep tax config lives on the operação doc as separate `configuracao*`
 * fields, so the editor reads/writes them via `useFormContext`. Dados Gerais
 * (origem/CFOP/…) live in the operação's own "Dados gerais" tab, so they're
 * hidden here (`showDadosGerais={false}`).
 */
function OperacaoImpostoField({ disabled }: { disabled?: boolean }) {
  const { watch, setValue, formState } = useFormContext();

  const blob: ImpostoConfigValue = {
    configuracaoICMS: watch('configuracaoICMS'),
    configuracaoIPI: watch('configuracaoIPI'),
    configuracaoPIS: watch('configuracaoPIS'),
    configuracaoCOFINS: watch('configuracaoCOFINS'),
    configuracaoPISST: watch('configuracaoPISST'),
    configuracaoISSQN: watch('configuracaoISSQN'),
    retencao: watch('retencao'),
    configuracaoIBSCBS: watch('configuracaoIBSCBS'),
  };

  function handleChange(next: ImpostoConfigValue) {
    for (const key of IMPOSTO_CONFIG_KEYS) {
      const nv = (next[key] ?? null) as unknown;
      if (!valuesEqual(nv, (blob[key] ?? null) as unknown)) {
        setValue(key, nv, { shouldDirty: true, shouldValidate: false });
      }
    }
  }

  return (
    <ImpostoConfigEditor
      value={blob}
      onChange={handleChange}
      showDadosGerais={false}
      disabled={disabled}
      errorTree={formState.errors}
    />
  );
}

/**
 * Static per-field overrides (module-level so ObjectView's identity-tracked
 * `fields` stays stable). The page merges the runtime-bound `macros` host on top.
 */
export const operacaoStaticFields: Record<string, FieldConfig> = {
  // Dados gerais
  nome: { section: 'Dados gerais', label: 'Nome' },
  naturezaDaOperacao: {
    section: 'Dados gerais',
    label: 'Natureza da operação',
    hint: 'Descrição da operação que consta na nota fiscal (máx. 60 caracteres).',
  },
  tipo: {
    section: 'Dados gerais',
    label: 'Tipo de operação',
    renderInput: (p) => (
      <Select
        label={p.label}
        description={p.hint}
        error={p.error}
        disabled={p.disabled}
        data={toOptions(TIPO_NFE_LABELS)}
        value={p.value == null ? null : String(p.value)}
        onChange={(v) => p.onChange(v == null ? null : Number(v))}
        onBlur={p.onBlur}
        allowDeselect={false}
      />
    ),
  },
  ehFiscal: { section: 'Dados gerais', label: 'É fiscal?', hint: 'Emite nota fiscal.' },
  ehServico: { section: 'Dados gerais', label: 'É serviço?' },
  ehExterior: { section: 'Dados gerais', label: 'É comércio exterior?' },
  ehConsumidorFinal: { section: 'Dados gerais', label: 'Operação com consumidor final?' },
  padrao: { section: 'Dados gerais', label: 'Operação padrão?' },
  ativo: { section: 'Dados gerais', label: 'Ativo?' },
  movimentaEstoque: { section: 'Dados gerais', label: 'Movimenta estoque?' },
  movimentaIndisponivelEstoque: {
    section: 'Dados gerais',
    label: 'Movimenta indisponibilização do estoque?',
  },
  finNFe: {
    section: 'Dados gerais',
    label: 'Finalidade da emissão',
    renderInput: (p) => (
      <Select
        label={p.label}
        description={p.hint}
        error={p.error}
        disabled={p.disabled}
        data={toOptions(FIN_NFE_OPERACAO_LABELS)}
        value={p.value == null ? null : String(p.value)}
        onChange={(v) => p.onChange(v == null ? null : Number(v))}
        onBlur={p.onBlur}
        clearable
      />
    ),
  },
  indPres: {
    section: 'Dados gerais',
    label: 'Indicador de presença do comprador',
    options: toOptions(IND_PRES_OPERACAO_LABELS),
  },
  indIntermed: {
    section: 'Dados gerais',
    label: 'Indicador de intermediador',
    options: toOptions(IND_INTERMED_OPERACAO_LABELS),
  },
  cfop: { section: 'Dados gerais', label: 'CFOP' },
  cfopInterestadual: { section: 'Dados gerais', label: 'CFOP interestadual' },
  origem: {
    section: 'Dados gerais',
    label: 'Origem padrão',
    hint: 'Preenchida nos itens da NF-e quando o item não tiver origem.',
    options: toOptions(ORIGEM_PRODUTO_LABELS),
  },
  NCM: { section: 'Dados gerais', label: 'NCM padrão', hint: '8 dígitos.' },
  CEST: { section: 'Dados gerais', label: 'CEST padrão', hint: '7 dígitos.' },
  unidade: { section: 'Dados gerais', label: 'Unidade padrão' },
  estadosDestino: {
    section: 'Dados gerais',
    label: 'Estados de destino',
    hint: 'Vazio aplica a todos os estados.',
    renderInput: (p) => {
      const selected = (p.value as string[] | null) ?? [];
      const allSelected = selected.length === ALL_UFS.length;
      return (
        <Stack gap={6}>
          <MultiSelect
            label={p.label}
            description={p.hint}
            error={p.error}
            disabled={p.disabled}
            data={UF_OPTIONS}
            value={selected}
            onChange={(arr) => p.onChange(arr.length > 0 ? arr : null)}
            searchable
            clearable
            comboboxProps={{ withinPortal: true }}
          />
          <Group gap="xs">
            <Button
              size="compact-xs"
              variant="light"
              onClick={() => p.onChange([...ALL_UFS])}
              disabled={p.disabled || allSelected}
            >
              Selecionar todos
            </Button>
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              onClick={() => p.onChange(null)}
              disabled={p.disabled || selected.length === 0}
            >
              Limpar estados
            </Button>
          </Group>
        </Stack>
      );
    },
  },
  infCpl: {
    section: 'Dados gerais',
    label: 'Informações complementares',
    kind: 'longText',
  },

  // Impostos (padrão) — the deep tax config editor + hidden sibling configs.
  configuracaoICMS: {
    section: 'Impostos (padrão)',
    label: 'Configuração tributária padrão',
    renderInput: (p) => <OperacaoImpostoField disabled={p.disabled} />,
  },
  configuracaoIPI: { hidden: true },
  configuracaoPIS: { hidden: true },
  configuracaoCOFINS: { hidden: true },
  configuracaoPISST: { hidden: true },
  configuracaoISSQN: { hidden: true },
  retencao: { hidden: true },
  configuracaoIBSCBS: { hidden: true },
};
