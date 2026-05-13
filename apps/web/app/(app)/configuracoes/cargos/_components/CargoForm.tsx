'use client';

import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Alert,
  Button,
  Group,
  Stack,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core';
import type { z } from 'zod';
import {
  type Cargo,
  cargoSchema,
  decodePermissoes,
  encodePermissoes,
} from '@delfrance/schemas';
import { useState } from 'react';
import { PermissionEditor } from '../../_components/PermissionEditor';

type CargoFormInput = z.input<typeof cargoSchema>;

export interface CargoFormProps {
  defaultValues?: Cargo;
  submitLabel?: string;
  onSubmit: (values: Cargo) => Promise<void>;
  /**
   * Bitmask of permissions the *current* user holds. The form blocks saving
   * cargos with bits outside this set so users can't elevate other roles
   * beyond their own privileges. Firestore rules are still the security
   * boundary; this is a UX guard.
   */
  callerBits: bigint;
}

export function CargoForm({
  defaultValues,
  submitLabel = 'Salvar',
  onSubmit,
  callerBits,
}: CargoFormProps) {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<CargoFormInput, unknown, Cargo>({
    resolver: zodResolver(cargoSchema),
    defaultValues: defaultValues ?? { nome: '', permissoes: '0' },
    mode: 'onBlur',
  });

  async function handleSubmit(values: Cargo) {
    setSubmitError(null);
    const bits = decodePermissoes(values);
    const excess = bits & ~callerBits;
    if (excess !== 0n) {
      setSubmitError(
        'Você não tem permissão para atribuir todos os bits selecionados.',
      );
      return;
    }
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
          name="descricao"
          render={({ field, fieldState }) => (
            <Textarea
              {...field}
              value={field.value ?? ''}
              label="Descrição"
              error={fieldState.error?.message}
              maxLength={500}
              autosize
              minRows={2}
            />
          )}
        />

        <Stack gap="xs">
          <Title order={4}>Permissões</Title>
          <Controller
            control={form.control}
            name="permissoes"
            render={({ field }) => (
              <PermissionEditor
                value={decodePermissoes({ permissoes: field.value ?? '0' })}
                onChange={(next) => field.onChange(encodePermissoes(next))}
              />
            )}
          />
        </Stack>

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
