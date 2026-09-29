'use client';

import { useFormContext, useWatch } from 'react-hook-form';
import { Alert, Button, Group, MultiSelect, Select, Stack, Text } from '@mantine/core';
import { z } from 'zod';
import {
  FIN_NFE_OPERACAO,
  FIN_NFE_OPERACAO_LABELS,
  REGRA_DOCUMENTO,
  TP_NF_CREDITO_LABELS,
  TP_NF_DEBITO_LABELS,
  descreverViolacaoDocumento,
  tpNFCreditoSchema,
  tpNFDebitoSchema,
  violacoesDaOperacao,
  type FinNFeOperacao,
  type RegraDocumento,
  IND_INTERMED_OPERACAO_LABELS,
  IND_PRES_OPERACAO_LABELS,
  ORIGEM_PRODUTO_LABELS,
  TIPO_NFE_LABELS,
  operacaoSchema,
  problemasDeEmissaoDoImposto,
  ufSchema,
} from '@delfrance/schemas';
import { valuesEqual } from '@delfrance/core';
import type { FieldConfig, FieldRenderProps, ValidationIssue } from '@delfrance/ui';
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

/** `estados` is a legacy duplicate of `estadosDestino`; stamps are system fields. */
export const OPERACAO_EXCLUDED_FIELDS = ['timestamp', 'ultimaModificacao', 'estados'];

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

/**
 * The form field each operação-level rule (`violacoesDaOperacao`, the SAME
 * rules the emission refuses with) points at. A rule missing here would land
 * on `finNFe`, never vanish.
 */
const CAMPO_DA_REGRA: Partial<Record<RegraDocumento, string>> = {
  [REGRA_DOCUMENTO.creditoNaoEhEntrada]: 'tipo',
  [REGRA_DOCUMENTO.debitoNaoEhSaida]: 'tipo',
  [REGRA_DOCUMENTO.creditoRetornoNaoEhEntrada]: 'tipo',
  [REGRA_DOCUMENTO.tpNFDebitoIndevido]: 'tpNFDebito',
  [REGRA_DOCUMENTO.tpNFDebitoAusente]: 'tpNFDebito',
  [REGRA_DOCUMENTO.tpNFCreditoIndevido]: 'tpNFCredito',
  [REGRA_DOCUMENTO.tpNFCreditoAusente]: 'tpNFCredito',
};

/**
 * `ObjectView.validate` for both operação pages: the NT 2025.002 finalidade /
 * tipo rules (B25-110/120, B25.1, B25.2) that SEFAZ would reject every nota
 * of this operação for. The emission date is unknown here, so 1145 (crédito
 * 02 before 2029) is left to the emission.
 */
export function validarOperacao(values: Record<string, unknown>): ValidationIssue[] {
  const finNFe = typeof values.finNFe === 'number' ? values.finNFe : FIN_NFE_OPERACAO.normal;
  return violacoesDaOperacao({
    finNFe,
    tpNF: values.tipo === 1 ? '1' : '0',
    // A value outside the enum is the schema resolver's error, not these rules'.
    tpNFDebito: tpNFDebitoSchema.safeParse(values.tpNFDebito).data ?? null,
    tpNFCredito: tpNFCreditoSchema.safeParse(values.tpNFCredito).data ?? null,
    anoEmissao: null,
  }).map((v) => ({
    path: CAMPO_DA_REGRA[v.regra] ?? 'finNFe',
    message: descreverViolacaoDocumento(v),
  }));
}

/**
 * The tipo of a nota de débito/crédito — shown only for its finalidade, or
 * while it still holds a value (so a stale one stays visible and clearable
 * next to the error `validarOperacao` puts on it).
 */
function TipoNotaAjusteSelect({
  p,
  finalidade,
  labels,
}: {
  p: FieldRenderProps;
  finalidade: FinNFeOperacao;
  labels: Record<string, string>;
}) {
  const finNFe = useWatch({ name: 'finNFe' }) as unknown;
  if (finNFe !== finalidade && p.value == null) return null;
  return (
    <Select
      label={p.label}
      description={p.hint}
      error={p.error}
      disabled={p.disabled}
      data={Object.entries(labels).map(([value, label]) => ({
        value,
        label: `${value} — ${label}`,
      }))}
      value={(p.value as string | null) ?? null}
      onChange={(v) => p.onChange(v)}
      onBlur={p.onBlur}
      clearable
    />
  );
}

const UF_OPTIONS = ufSchema.options.map((uf) => ({ value: uf, label: uf }));
const ALL_UFS: string[] = [...ufSchema.options];

/**
 * The operação page's `validate` (both the edit and the create page): refuses
 * to save a default tax config the NF-e engine would refuse (#1655). The
 * operação doc IS the resolver's last tier, and the engine's tier gate
 * (`impostoSchema`) reads the whole doc — `origem` lives on the Dados gerais
 * tab — so the check runs on every value, not just the `configuracao*` keys.
 *
 * Every issue lands on `configuracaoICMS`: it is the one VISIBLE key of the
 * "Impostos (padrão)" tab (the PIS/COFINS keys are hidden fields, whose issues
 * ObjectView would park outside the form), so the tab is flagged and the
 * editor there shows each message inline. Module-level so ObjectView's
 * resolver memo, keyed on `validate`'s identity, stays stable.
 */
export function validarImpostoDaOperacao(values: Record<string, unknown>): ValidationIssue[] {
  return problemasDeEmissaoDoImposto(values).map((problema) => ({
    path: 'configuracaoICMS',
    message: problema.mensagem,
  }));
}

/**
 * The operação form's ONE `validate` (ObjectView takes a single function): the
 * finalidade/tipo rules of a nota de débito/crédito ({@link validarOperacao},
 * #330) and the tax config the NF-e engine would refuse
 * ({@link validarImpostoDaOperacao}, #1655).
 */
export function validarFormularioDaOperacao(values: Record<string, unknown>): ValidationIssue[] {
  return [...validarOperacao(values), ...validarImpostoDaOperacao(values)];
}

/**
 * Bridges the operação form (RHF context) to the {@link ImpostoConfigEditor}:
 * the deep tax config lives on the operação doc as separate `configuracao*`
 * fields, so the editor reads/writes them via `useFormContext`. Dados Gerais
 * (origem/CFOP/…) live in the operação's own "Dados gerais" tab, so they're
 * hidden here (`showDadosGerais={false}`).
 */
function OperacaoImpostoField({ disabled }: { disabled?: boolean }) {
  const { control, watch, setValue, formState } = useFormContext();
  // The WHOLE operação, not just the blob below: the engine's tier gate needs
  // `origem`/`cfop`/`NCM` from the Dados gerais tab (see validarImpostoDaOperacao).
  // `useWatch`, never a bare `watch()`: the argument-less `watch()` flips RHF's
  // form-wide `watchAll`, so every keystroke in ANY operação field would
  // re-render the whole ObjectView; `useWatch` re-renders only this editor.
  const valores = useWatch({ control });
  const problemas = problemasDeEmissaoDoImposto(valores);

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
      problemas={problemas}
    />
  );
}

/**
 * What the ERP emits of a nota de crédito/débito, stated where the finalidade
 * is chosen — the emission refuses the rest with the same words.
 */
function NotaAjusteAviso() {
  const finNFe = useWatch({ name: 'finNFe' }) as unknown;
  if (finNFe !== FIN_NFE_OPERACAO.credito && finNFe !== FIN_NFE_OPERACAO.debito) return null;
  return (
    <Alert color="blue" variant="light">
      <Text size="sm">
        Nota de crédito/débito (NT 2025.002): emitida só com a Reforma Tributária ativa na filial.
        Os itens levam só IBS/CBS — exceto crédito 03/04 e débito 07, que mantêm ICMS, PIS e COFINS.
        Nos débitos 01, 02, 03, 05, 07 e 08 a classificação vem do tipo, e os valores de IBS e CBS
        de cada item são informados na aba Fiscal do pedido; nos demais tipos, cada item precisa da
        configuração de IBS/CBS. Crédito 02 (ZFM) e 05 (sucessão) ainda não são emitidos.
      </Text>
    </Alert>
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
      <Stack gap={6}>
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
        <NotaAjusteAviso />
      </Stack>
    ),
  },
  tpNFDebito: {
    section: 'Dados gerais',
    label: 'Tipo de nota de débito',
    renderInput: (p) => (
      <TipoNotaAjusteSelect
        p={p}
        finalidade={FIN_NFE_OPERACAO.debito}
        labels={TP_NF_DEBITO_LABELS}
      />
    ),
  },
  tpNFCredito: {
    section: 'Dados gerais',
    label: 'Tipo de nota de crédito',
    renderInput: (p) => (
      <TipoNotaAjusteSelect
        p={p}
        finalidade={FIN_NFE_OPERACAO.credito}
        labels={TP_NF_CREDITO_LABELS}
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
