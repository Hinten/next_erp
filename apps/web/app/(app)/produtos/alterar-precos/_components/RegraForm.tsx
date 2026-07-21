'use client';

/**
 * Single-strategy picker for the bulk manual price editor (#545) — port of
 * the legacy strategy dropdown + per-strategy formula rows
 * (`.old/lib/produtos/pages/alterarPrecoMassa.dart`, the `DropDownField`
 * L794-821 and the four `CalculoPrecoDetalhado`/`ValorFixo`/
 * `ComBaseNoPrecoAntigo`/`CopiarOutraTabela` widgets, L1019-1578).
 *
 * `Controller`'s `name` prop is cast via {@link regraPath} — the same
 * work-around `apps/web/app/(app)/pedidos/_components/tabs/frete/fields.tsx`
 * (`fretePath`) uses: `RegraInput` is a Zod discriminated union, and
 * react-hook-form's `Path<T>` doesn't resolve per-branch field names cleanly
 * for a union type. Since the fields actually rendered are always gated on
 * the CURRENT `tipo` (never referencing a field from a different branch),
 * this is safe in practice even though the cast erases some of RHF's static
 * name-checking.
 */
import { Controller, useWatch, type FieldPath, type UseFormReturn } from 'react-hook-form';
import { Group, NumberInput, Select, Stack, Text } from '@mantine/core';
import {
  defaultsFor,
  type RegraInput,
  type RegraOutput,
  type RegraTipo,
} from '@/lib/produtos/bulkPreco/regraSchema';

export interface RegraFormProps {
  form: UseFormReturn<RegraInput, unknown, RegraOutput>;
  /** Every active lista de preços — feeds the `copiarOutraTabela` source picker. */
  listaOptions: ReadonlyArray<{ value: string; label: string }>;
  /** The TARGET lista (top of the page) — excluded from the "copy from" options
   * so a strategy can't copy a lista onto itself. */
  targetListaId: string | null;
}

const REGRA_OPTIONS: { value: RegraTipo; label: string }[] = [
  { value: 'detalhado', label: 'Cálculo Detalhado' },
  { value: 'valorFixo', label: 'Valor Fixo' },
  { value: 'precoAtual', label: 'Com base no preço atual' },
  { value: 'copiarOutraTabela', label: 'Copiar de outra tabela' },
];

function regraPath(key: string): FieldPath<RegraInput> {
  return key as FieldPath<RegraInput>;
}

/** Coerce Mantine `NumberInput`'s payload to a number, or `null` when cleared —
 * mirrors `CurrencyInput`'s `parseBrl` / `FormulaListEditor`'s `parseLimiar`.
 * Never forces an empty field back to `0`: the F1 lesson. */
function parseRegraNumber(v: number | string): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

interface RegraNumberFieldProps {
  form: UseFormReturn<RegraInput, unknown, RegraOutput>;
  name: string;
  label: string;
  decimalScale?: number;
  min?: number;
  max?: number;
  w?: number | string;
}

function RegraNumberField({
  form,
  name,
  label,
  decimalScale = 2,
  min,
  max,
  w = 110,
}: RegraNumberFieldProps) {
  return (
    <Controller
      control={form.control}
      name={regraPath(name)}
      render={({ field, fieldState }) => (
        <NumberInput
          label={label}
          aria-label={label}
          value={(field.value as unknown as number | null | undefined) ?? ''}
          onChange={(v) => (field.onChange as (val: number | null) => void)(parseRegraNumber(v))}
          onBlur={field.onBlur}
          error={fieldState.error?.message}
          decimalScale={decimalScale}
          min={min}
          max={max}
          w={w}
        />
      )}
    />
  );
}

interface RegraSelectFieldProps {
  form: UseFormReturn<RegraInput, unknown, RegraOutput>;
  name: string;
  label: string;
  data: ReadonlyArray<{ value: string; label: string }>;
  placeholder?: string;
}

function RegraSelectField({ form, name, label, data, placeholder }: RegraSelectFieldProps) {
  return (
    <Controller
      control={form.control}
      name={regraPath(name)}
      render={({ field, fieldState }) => (
        <Select
          label={label}
          placeholder={placeholder}
          data={[...data]}
          value={(field.value as unknown as string | null | undefined) ?? null}
          onChange={(v) => (field.onChange as (val: string | null) => void)(v)}
          onBlur={field.onBlur}
          error={fieldState.error?.message}
          searchable
          w={260}
        />
      )}
    />
  );
}

export function RegraForm({ form, listaOptions, targetListaId }: RegraFormProps) {
  // Cast for the same reason as `regraPath` below: RHF's `Path<T>` doesn't
  // resolve a discriminated union's common `tipo` field cleanly, so the exact
  // inferred value type isn't relied on here.
  const watchedTipo = useWatch({ control: form.control, name: regraPath('tipo') });
  const tipo = watchedTipo as unknown as RegraTipo;
  const outraListaOptions = listaOptions.filter((o) => o.value !== targetListaId);

  return (
    <Stack gap="sm">
      <Select
        label="Regra"
        data={REGRA_OPTIONS}
        value={tipo}
        onChange={(value) => {
          if (!value) return;
          form.reset(defaultsFor(value as RegraTipo));
        }}
        allowDeselect={false}
        w={280}
      />

      {tipo === 'detalhado' && (
        <Stack gap="xs">
          <Group gap="xs" align="flex-end" wrap="wrap">
            <Text size="sm">Preço de</Text>
            <RegraNumberField form={form} name="valorMinimo" label="Valor Mínimo" />
            <Text size="sm">até</Text>
            <RegraNumberField form={form} name="valorMaximo" label="Valor Máximo" />
          </Group>
          <Group gap={6} align="flex-end" wrap="wrap">
            <Text size="sm">= (Custo +</Text>
            <RegraNumberField
              form={form}
              name="lucro"
              label="Lucro"
              decimalScale={4}
              min={0}
              max={1}
              w={90}
            />
            <Text size="sm">x Custo +</Text>
            <RegraNumberField form={form} name="tarifaFixa" label="Tarifa fixa" w={100} />
            <Text size="sm">) / (1 - (</Text>
            <RegraNumberField
              form={form}
              name="comissao"
              label="Comissão"
              decimalScale={4}
              min={0}
              max={1}
              w={90}
            />
            <Text size="sm">+</Text>
            <RegraNumberField
              form={form}
              name="imposto"
              label="Simples Nacional"
              decimalScale={4}
              min={0}
              max={1}
              w={130}
            />
            <Text size="sm">+</Text>
            <RegraNumberField
              form={form}
              name="frete"
              label="Frete"
              decimalScale={4}
              min={0}
              max={1}
              w={90}
            />
            <Text size="sm">+</Text>
            <RegraNumberField
              form={form}
              name="marketing"
              label="Marketing"
              decimalScale={4}
              min={0}
              max={1}
              w={90}
            />
            <Text size="sm">)) x (1 +</Text>
            <RegraNumberField
              form={form}
              name="margemSeguranca"
              label="Margem de Segurança"
              decimalScale={4}
              min={0}
              max={1}
              w={140}
            />
            <Text size="sm">)</Text>
          </Group>
        </Stack>
      )}

      {tipo === 'valorFixo' && (
        <Group gap="xs" align="flex-end" wrap="wrap">
          <Text size="sm">Preço de</Text>
          <RegraNumberField form={form} name="valorMinimo" label="Valor Mínimo" />
          <Text size="sm">até</Text>
          <RegraNumberField form={form} name="valorMaximo" label="Valor Máximo" />
          <Text size="sm">=</Text>
          <RegraNumberField form={form} name="novoPreco" label="Novo Preco" />
        </Group>
      )}

      {tipo === 'precoAtual' && (
        <Stack gap="xs">
          <Group gap="xs" align="flex-end" wrap="wrap">
            <Text size="sm">Preço de</Text>
            <RegraNumberField form={form} name="valorMinimo" label="Valor Mínimo" />
            <Text size="sm">até</Text>
            <RegraNumberField form={form} name="valorMaximo" label="Valor Máximo" />
          </Group>
          <Group gap={6} align="flex-end" wrap="wrap">
            <Text size="sm">= Preço Atual + (Preço Atual x</Text>
            <RegraNumberField
              form={form}
              name="percentual"
              label="Percentual"
              decimalScale={4}
              min={0}
              max={1}
              w={90}
            />
            <Text size="sm">) +</Text>
            <RegraNumberField form={form} name="valorFixo" label="Valor fixo" w={100} />
          </Group>
        </Stack>
      )}

      {tipo === 'copiarOutraTabela' && (
        <Group gap="xs" align="flex-end" wrap="wrap">
          <Text size="sm">Preço de</Text>
          <RegraNumberField form={form} name="valorMinimo" label="Valor Mínimo" />
          <Text size="sm">até</Text>
          <RegraNumberField form={form} name="valorMaximo" label="Valor Máximo" />
          <Text size="sm">=</Text>
          <RegraSelectField
            form={form}
            name="outraListaId"
            label="Copiar de"
            data={outraListaOptions}
            placeholder="Selecione a tabela de origem"
          />
        </Group>
      )}
    </Stack>
  );
}
