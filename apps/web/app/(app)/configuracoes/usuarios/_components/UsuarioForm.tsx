'use client';

import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Alert,
  Button,
  Checkbox,
  Group,
  Stack,
  TextInput,
} from '@mantine/core';
import type { z } from 'zod';
import { type Usuario, usuarioSchema } from '@delfrance/schemas';
import { useState } from 'react';
import { CargoMultiSelect } from './CargoMultiSelect';

type UsuarioFormInput = z.input<typeof usuarioSchema>;

export interface UsuarioFormProps {
  defaultValues: Usuario;
  submitLabel?: string;
  onSubmit: (values: Usuario) => Promise<void>;
  /** Whether the current viewer is a superuser (controls `isSuperUser` toggle visibility). */
  callerIsSuperUser: boolean;
}

export function UsuarioForm({
  defaultValues,
  submitLabel = 'Salvar',
  onSubmit,
  callerIsSuperUser,
}: UsuarioFormProps) {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<UsuarioFormInput, unknown, Usuario>({
    resolver: zodResolver(usuarioSchema),
    defaultValues,
    mode: 'onBlur',
  });

  async function handleSubmit(values: Usuario) {
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
              error={fieldState.error?.message}
              maxLength={255}
              required
            />
          )}
        />

        <Controller
          control={form.control}
          name="email"
          render={({ field }) => (
            <TextInput
              {...field}
              value={field.value ?? ''}
              label="E-mail"
              description="O e-mail não pode ser alterado após a criação."
              type="email"
              disabled
            />
          )}
        />

        <Controller
          control={form.control}
          name="cargos"
          render={({ field, fieldState }) => (
            <CargoMultiSelect
              value={field.value ?? []}
              onChange={field.onChange}
              error={fieldState.error?.message}
            />
          )}
        />

        <Controller
          control={form.control}
          name="colaborador"
          render={({ field }) => (
            <Checkbox
              label="Colaborador interno"
              checked={field.value ?? false}
              onChange={(e) => field.onChange(e.currentTarget.checked)}
            />
          )}
        />

        <Controller
          control={form.control}
          name="ativo"
          render={({ field }) => (
            <Checkbox
              label="Ativo"
              checked={field.value ?? false}
              onChange={(e) => field.onChange(e.currentTarget.checked)}
            />
          )}
        />

        {callerIsSuperUser && (
          <Controller
            control={form.control}
            name="isSuperUser"
            render={({ field }) => (
              <Checkbox
                label="Superusuário (acesso total)"
                checked={field.value ?? false}
                onChange={(e) => field.onChange(e.currentTarget.checked)}
              />
            )}
          />
        )}

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
