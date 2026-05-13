'use client';

import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { FirebaseError } from 'firebase/app';
import {
  Alert,
  Button,
  Group,
  Select,
  Stack,
  TextInput,
  Textarea,
} from '@mantine/core';
import {
  type Cliente,
  TIPO_CLIENTE_LABELS,
  clienteSchema,
} from '@delfrance/schemas';
import {
  formatCNPJ,
  formatCPF,
  validateCNPJ,
  validateCPF,
} from '@delfrance/core/documents';
import { useState } from 'react';

const tipoOptions = (
  Object.entries(TIPO_CLIENTE_LABELS) as Array<[Cliente['tipo'] & string, string]>
).map(([value, label]) => ({ value, label }));

export interface ClienteFormProps {
  defaultValues?: Cliente;
  submitLabel?: string;
  onSubmit: (values: Cliente) => Promise<void>;
}

export function ClienteForm({
  defaultValues,
  submitLabel = 'Salvar',
  onSubmit,
}: ClienteFormProps) {
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [docWarning, setDocWarning] = useState<string | null>(null);

  const form = useForm<Cliente>({
    resolver: zodResolver(clienteSchema),
    defaultValues: defaultValues ?? {},
    mode: 'onBlur',
  });

  async function handleSubmit(values: Cliente) {
    setSubmitError(null);
    // Validate CPF/CNPJ via the BR DocumentProvider when present. This is
    // a soft warning surfaced in the form, not a block — backend rules
    // are still the source of truth.
    if (values.cpf_cnpj) {
      const isValid =
        values.cpf_cnpj.length === 11
          ? validateCPF(values.cpf_cnpj)
          : values.cpf_cnpj.length === 14
            ? validateCNPJ(values.cpf_cnpj)
            : false;
      if (!isValid) {
        setDocWarning('CPF/CNPJ com checksum inválido — confira antes de salvar.');
      } else {
        setDocWarning(null);
      }
    }
    try {
      await onSubmit(values);
    } catch (err) {
      if (err instanceof FirebaseError) {
        setSubmitError(err.message);
      } else {
        throw err;
      }
    }
  }

  const cpfCnpj = form.watch('cpf_cnpj');
  const formatted =
    cpfCnpj && cpfCnpj.length === 11
      ? formatCPF(cpfCnpj)
      : cpfCnpj && cpfCnpj.length === 14
        ? formatCNPJ(cpfCnpj)
        : null;

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
              error={fieldState.error?.message}
              maxLength={255}
            />
          )}
        />

        <Controller
          control={form.control}
          name="tipo"
          render={({ field, fieldState }) => (
            <Select
              label="Tipo"
              data={tipoOptions}
              value={field.value ?? null}
              onChange={(v) => field.onChange(v as Cliente['tipo'])}
              error={fieldState.error?.message}
              clearable
            />
          )}
        />

        <Controller
          control={form.control}
          name="cpf_cnpj"
          render={({ field, fieldState }) => (
            <TextInput
              {...field}
              value={field.value ?? ''}
              label="CPF / CNPJ"
              description={formatted ?? 'Apenas números'}
              error={fieldState.error?.message}
              maxLength={14}
              inputMode="numeric"
            />
          )}
        />

        <Controller
          control={form.control}
          name="email"
          render={({ field, fieldState }) => (
            <TextInput
              {...field}
              value={field.value ?? ''}
              label="E-mail"
              type="email"
              error={fieldState.error?.message}
              maxLength={255}
            />
          )}
        />

        <Controller
          control={form.control}
          name="telefone"
          render={({ field, fieldState }) => (
            <TextInput
              {...field}
              value={field.value ?? ''}
              label="Telefone"
              description="Apenas números, com DDI (ex.: 5511999998888)"
              error={fieldState.error?.message}
              maxLength={16}
              inputMode="tel"
            />
          )}
        />

        <Group grow>
          <Controller
            control={form.control}
            name="ie"
            render={({ field, fieldState }) => (
              <TextInput
                {...field}
                value={field.value ?? ''}
                label="Inscrição Estadual"
                error={fieldState.error?.message}
                maxLength={16}
              />
            )}
          />
          <Controller
            control={form.control}
            name="imun"
            render={({ field, fieldState }) => (
              <TextInput
                {...field}
                value={field.value ?? ''}
                label="Inscrição Municipal"
                error={fieldState.error?.message}
                maxLength={15}
              />
            )}
          />
        </Group>

        <Controller
          control={form.control}
          name="observacoesInternas"
          render={({ field, fieldState }) => (
            <Textarea
              {...field}
              value={field.value ?? ''}
              label="Observações internas"
              error={fieldState.error?.message}
              maxLength={255}
              autosize
              minRows={2}
            />
          )}
        />

        {docWarning && <Alert color="yellow">{docWarning}</Alert>}
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
