'use client';

import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Alert,
  Button,
  Checkbox,
  Group,
  NumberInput,
  Stack,
  TextInput,
} from '@mantine/core';
import { type Produto, produtoSchema } from '@delfrance/schemas';

export interface ProdutoFormProps {
  defaultValues?: Produto;
  submitLabel?: string;
  onSubmit: (values: Produto) => Promise<void>;
}

const DEFAULTS: Produto = {
  nome: '',
  ehKit: false,
  ehKitVirtual: false,
  publicado: true,
  ofereceFreteGratis: false,
  permiteVendaSemEstoque: false,
  integracoesComProduto: [],
  marketplace: [],
};

export function ProdutoForm({
  defaultValues,
  submitLabel = 'Salvar',
  onSubmit,
}: ProdutoFormProps) {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<Produto>({
    resolver: zodResolver(produtoSchema),
    defaultValues: defaultValues ?? DEFAULTS,
    mode: 'onBlur',
  });

  async function handleSubmit(values: Produto) {
    setSubmitError(null);
    try {
      await onSubmit(values);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Falha ao salvar.');
    }
  }

  return (
    <form onSubmit={form.handleSubmit(handleSubmit)}>
      <Stack>
        <Controller
          control={form.control}
          name="nome"
          render={({ field, fieldState }) => (
            <TextInput
              {...field}
              value={field.value ?? ''}
              label="Nome"
              required
              error={fieldState.error?.message}
              maxLength={100}
            />
          )}
        />

        <Group grow>
          <Controller
            control={form.control}
            name="sku"
            render={({ field, fieldState }) => (
              <TextInput
                {...field}
                value={field.value ?? ''}
                label="SKU"
                error={fieldState.error?.message}
                maxLength={255}
              />
            )}
          />
          <Controller
            control={form.control}
            name="gtin"
            render={({ field, fieldState }) => (
              <TextInput
                {...field}
                value={field.value ?? ''}
                label="GTIN / EAN"
                error={fieldState.error?.message}
                maxLength={255}
              />
            )}
          />
        </Group>

        <Controller
          control={form.control}
          name="codFornecedor"
          render={({ field, fieldState }) => (
            <TextInput
              {...field}
              value={field.value ?? ''}
              label="Código no fornecedor"
              error={fieldState.error?.message}
              maxLength={255}
            />
          )}
        />

        <Group grow>
          <Controller
            control={form.control}
            name="pesoLiquidoKg"
            render={({ field, fieldState }) => (
              <NumberInput
                value={field.value ?? ''}
                onChange={(v) =>
                  field.onChange(typeof v === 'number' ? v : null)
                }
                onBlur={field.onBlur}
                label="Peso líquido (kg)"
                description="Em kilogramas"
                error={fieldState.error?.message}
                decimalScale={3}
                min={0}
              />
            )}
          />
          <Controller
            control={form.control}
            name="pesoBrutoKg"
            render={({ field, fieldState }) => (
              <NumberInput
                value={field.value ?? ''}
                onChange={(v) =>
                  field.onChange(typeof v === 'number' ? v : null)
                }
                onBlur={field.onBlur}
                label="Peso bruto (kg)"
                error={fieldState.error?.message}
                decimalScale={3}
                min={0}
              />
            )}
          />
        </Group>

        <Group grow>
          <Controller
            control={form.control}
            name="alturaCm"
            render={({ field }) => (
              <NumberInput
                value={field.value ?? ''}
                onChange={(v) =>
                  field.onChange(typeof v === 'number' ? v : null)
                }
                onBlur={field.onBlur}
                label="Altura (cm)"
                decimalScale={2}
                min={0}
              />
            )}
          />
          <Controller
            control={form.control}
            name="larguraCm"
            render={({ field }) => (
              <NumberInput
                value={field.value ?? ''}
                onChange={(v) =>
                  field.onChange(typeof v === 'number' ? v : null)
                }
                onBlur={field.onBlur}
                label="Largura (cm)"
                decimalScale={2}
                min={0}
              />
            )}
          />
          <Controller
            control={form.control}
            name="profundidadeCm"
            render={({ field }) => (
              <NumberInput
                value={field.value ?? ''}
                onChange={(v) =>
                  field.onChange(typeof v === 'number' ? v : null)
                }
                onBlur={field.onBlur}
                label="Profundidade (cm)"
                decimalScale={2}
                min={0}
              />
            )}
          />
        </Group>

        <Group>
          <Controller
            control={form.control}
            name="publicado"
            render={({ field }) => (
              <Checkbox
                checked={!!field.value}
                onChange={(e) => field.onChange(e.currentTarget.checked)}
                onBlur={field.onBlur}
                label="Publicado"
              />
            )}
          />
          <Controller
            control={form.control}
            name="ehKit"
            render={({ field }) => (
              <Checkbox
                checked={!!field.value}
                onChange={(e) => field.onChange(e.currentTarget.checked)}
                onBlur={field.onBlur}
                label="É kit"
              />
            )}
          />
          <Controller
            control={form.control}
            name="ofereceFreteGratis"
            render={({ field }) => (
              <Checkbox
                checked={!!field.value}
                onChange={(e) => field.onChange(e.currentTarget.checked)}
                onBlur={field.onBlur}
                label="Frete grátis"
              />
            )}
          />
          <Controller
            control={form.control}
            name="permiteVendaSemEstoque"
            render={({ field }) => (
              <Checkbox
                checked={!!field.value}
                onChange={(e) => field.onChange(e.currentTarget.checked)}
                onBlur={field.onBlur}
                label="Permite venda sem estoque"
              />
            )}
          />
        </Group>

        <Controller
          control={form.control}
          name="crossdocking"
          render={({ field, fieldState }) => (
            <NumberInput
              value={field.value ?? ''}
              onChange={(v) =>
                field.onChange(typeof v === 'number' ? v : null)
              }
              onBlur={field.onBlur}
              label="Crossdocking"
              description="Prazo extra de postagem em dias"
              error={fieldState.error?.message}
              min={0}
            />
          )}
        />

        {submitError && <Alert color="red">{submitError}</Alert>}

        <Group justify="flex-end">
          <Button type="submit" loading={form.formState.isSubmitting}>
            {submitLabel}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
