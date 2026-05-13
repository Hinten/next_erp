'use client';

import { useMemo } from 'react';
import { MultiSelect, Skeleton, Stack, Text } from '@mantine/core';
import { buildQuery, orderByField } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { decodePermissoes } from '@delfrance/schemas';
import { useTenant } from '@/lib/auth';
import { cargoCollection } from '@/lib/data/cargoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export interface CargoMultiSelectProps {
  value: string[];
  onChange: (next: string[]) => void;
  error?: string;
  label?: string;
}

/**
 * Mantine MultiSelect populated from the `cargos` collection. Cargos whose
 * bitmask includes bits the current caller does NOT possess are disabled —
 * the caller can't assign roles more privileged than themselves (mirrors the
 * Flutter `cascade-permission filter` behaviour). Already-assigned cargos
 * that exceed the caller's bits stay visible (so we don't silently drop
 * existing assignments) but cannot be added.
 */
export function CargoMultiSelect({
  value,
  onChange,
  error,
  label = 'Cargos',
}: CargoMultiSelectProps) {
  const { claims } = useTenant();
  const callerBits = useMemo(() => {
    try {
      return claims?.permissions ? BigInt(claims.permissions) : 0n;
    } catch (err) {
      if (err instanceof SyntaxError) {
        return 0n;
      }
      throw err;
    }
  }, [claims?.permissions]);

  const q = useMemo(() => {
    const base = cargoCollection.ref(getFirebaseFirestore(), {});
    return buildQuery(base, [orderByField('nome')]);
  }, []);

  const { data, loading } = useSnapshot(q);

  const options = useMemo(() => {
    if (!data) return [];
    return data.map(({ id, data: c }) => {
      const bits = decodePermissoes(c);
      const excess = bits & ~callerBits;
      const assignable = excess === 0n;
      return {
        value: id,
        label: assignable ? c.nome : `${c.nome} (sem permissão para atribuir)`,
        disabled: !assignable && !value.includes(id),
      };
    });
  }, [data, callerBits, value]);

  if (loading) {
    return (
      <Stack gap={4}>
        <Text size="sm" fw={500}>
          {label}
        </Text>
        <Skeleton height={36} />
      </Stack>
    );
  }

  return (
    <MultiSelect
      label={label}
      data={options}
      value={value}
      onChange={onChange}
      error={error}
      placeholder="Selecione um ou mais cargos"
      searchable
      clearable
    />
  );
}
