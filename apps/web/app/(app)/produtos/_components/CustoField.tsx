'use client';

import { Group } from '@mantine/core';
import type { Firestore } from 'firebase/firestore';
import { useFormContext } from 'react-hook-form';
import { CurrencyInput } from './CurrencyInput';
import { ProdutoHistoryButton } from './ProdutoHistoryButton';

export interface CustoFieldProps {
  /** `null` in create mode — the history button is hidden until the doc exists. */
  produtoId: string | null;
  db: Firestore;
  value: number | null;
  onChange: (next: number | null) => void;
  label?: string;
  hint?: string;
  disabled?: boolean;
  error?: string;
}

/**
 * The `custo` field of the Preço e custo tab: a BRL-masked input with its cost
 * history button right beside it (`historicoDeCusto`, read-only). Rendered via
 * the field's `renderInput` so it can reach the page's `db`/`produtoId`.
 */
export function CustoField({
  produtoId,
  db,
  value,
  onChange,
  label,
  hint,
  disabled,
  error,
}: CustoFieldProps) {
  // For a kit, the custo is DYNAMIC — the Kit tab computes Σ(component × qty) into
  // this field, so it is read-only here (matches the Flutter dynamic `getCusto`).
  const form = useFormContext();
  const ehKit = form?.watch('ehKit') === true;

  return (
    <Group wrap="nowrap" align="flex-end" gap="xs">
      <CurrencyInput
        label={label ?? 'Custo'}
        description={ehKit ? 'Calculado automaticamente a partir dos componentes do kit.' : hint}
        value={value}
        onChange={onChange}
        disabled={disabled || ehKit}
        error={error}
        style={{ flex: 1, maxWidth: 320 }}
      />
      {produtoId && (
        <ProdutoHistoryButton kind="custo" db={db} produtoId={produtoId} label="Custo" />
      )}
    </Group>
  );
}
