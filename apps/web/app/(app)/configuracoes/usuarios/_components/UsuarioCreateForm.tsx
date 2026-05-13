'use client';

import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Alert,
  Button,
  Checkbox,
  Group,
  PasswordInput,
  Stack,
  TextInput,
} from '@mantine/core';
import { z } from 'zod';
import { CargoMultiSelect } from './CargoMultiSelect';

const createUserInputSchema = z.object({
  nome: z.string().min(1, 'Obrigatório').max(255),
  email: z.string().email('E-mail inválido').max(255),
  senha: z.string().min(6, 'Mínimo 6 caracteres').max(128),
  cargos: z.array(z.string()).default([]),
  colaborador: z.boolean().default(false),
  isSuperUser: z.boolean().default(false),
});

type CreateUserInput = z.input<typeof createUserInputSchema>;
export type CreateUserValues = z.output<typeof createUserInputSchema>;

export interface UsuarioCreateFormProps {
  onSubmit: (values: CreateUserValues) => Promise<void>;
  /** Whether the current viewer is a superuser (controls `isSuperUser` toggle visibility). */
  callerIsSuperUser: boolean;
}

export function UsuarioCreateForm({
  onSubmit,
  callerIsSuperUser,
}: UsuarioCreateFormProps) {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<CreateUserInput, unknown, CreateUserValues>({
    resolver: zodResolver(createUserInputSchema),
    defaultValues: {
      nome: '',
      email: '',
      senha: '',
      cargos: [],
      colaborador: false,
      isSuperUser: false,
    },
    mode: 'onBlur',
  });

  async function handleSubmit(values: CreateUserValues) {
    setSubmitError(null);
    try {
      await onSubmit(values);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Falha ao criar usuário.');
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
          render={({ field, fieldState }) => (
            <TextInput
              {...field}
              value={field.value ?? ''}
              label="E-mail"
              type="email"
              error={fieldState.error?.message}
              maxLength={255}
              required
            />
          )}
        />

        <Controller
          control={form.control}
          name="senha"
          render={({ field, fieldState }) => (
            <PasswordInput
              {...field}
              value={field.value ?? ''}
              label="Senha provisória"
              description="O usuário poderá alterá-la depois."
              error={fieldState.error?.message}
              required
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
            Criar usuário
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
