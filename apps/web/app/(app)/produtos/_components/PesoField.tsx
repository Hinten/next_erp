'use client';

import { NumberInput } from '@mantine/core';
import { useFormContext } from 'react-hook-form';
import type { FieldConfig, FieldRenderProps } from '@delfrance/ui';

/**
 * A weight (kg) field for the Dimensões tab. For a kit, the weight is DYNAMIC —
 * the Kit tab computes Σ(component peso × quantidade) into this field
 * (`KitManager` `syncPesoToForm`), so it is read-only here, mirroring
 * `CustoField`'s read-only `custo` for kits (Flutter dynamic
 * `getPesoBrutoKg`/`getPesoLiquidoKg`). For a non-kit it's a plain editable
 * number input. Gated on `ehKit` read live via `useFormContext` (null outside a
 * provider — guard with `?.`).
 */
function PesoField(props: FieldRenderProps) {
  const form = useFormContext();
  const ehKit = form?.watch('ehKit') === true;
  return (
    <NumberInput
      label={props.label}
      description={
        ehKit ? 'Calculado automaticamente a partir dos componentes do kit.' : props.hint
      }
      value={(props.value as number | null) ?? ''}
      onChange={(val) => props.onChange(typeof val === 'number' ? val : null)}
      onBlur={props.onBlur}
      disabled={props.disabled || ehKit}
      error={props.error}
      min={0}
      step={0.1}
      style={{ maxWidth: 320 }}
    />
  );
}

/**
 * `renderInput` for the kit-derived weight fields (`pesoBrutoKg`/`pesoLiquidoKg`)
 * — read-only when the produto is a kit. Static (no `db`/`produtoId`), so it's
 * wired directly in `produtoFields.ts`.
 */
export const pesoRenderInput: FieldConfig['renderInput'] = (props) => <PesoField {...props} />;
