'use client';

import { NumberInput } from '@mantine/core';
import { useFormContext } from 'react-hook-form';
import type { FieldConfig, FieldRenderProps } from '@delfrance/ui';

/**
 * A number field of the "Dimensões e peso" tab whose value is DERIVED for a kit.
 *
 * For a kit, the Kit tab rolls the components up (`dimensoesDoKit` via
 * `KitManager`'s `syncPesoToForm`) and the `recalcularDimensoesKit` Cloud Task
 * keeps writing it whenever a component changes (#1152) — so an operator edit
 * here would be silently overwritten. Read-only is the honest UI, mirroring
 * `CustoField`'s read-only `custo` (Flutter's dynamic `getPesoBrutoKg` /
 * `getPesoLiquidoKg`). For a non-kit it is a plain editable number input.
 *
 * Gated on `ehKit` read live via `useFormContext` (null outside a provider —
 * guard with `?.`).
 */
function DimensaoKitField({ step, ...props }: FieldRenderProps & { step: number }) {
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
      step={step}
      style={{ maxWidth: 320 }}
    />
  );
}

/**
 * `renderInput` for the kit-derived weight fields (`pesoBrutoKg`/`pesoLiquidoKg`)
 * — read-only when the produto is a kit. Static (no `db`/`produtoId`), so it's
 * wired directly in `produtoFields.ts`.
 */
export const pesoRenderInput: FieldConfig['renderInput'] = (props) => (
  <DimensaoKitField {...props} step={0.1} />
);

/**
 * `renderInput` for the kit-derived box fields (`alturaCm`/`larguraCm`/
 * `profundidadeCm`). Same lock as the weight — both halves of the rollup are
 * server-owned on a kit, so neither may be hand-edited (#1152).
 */
export const dimensaoRenderInput: FieldConfig['renderInput'] = (props) => (
  <DimensaoKitField {...props} step={1} />
);
