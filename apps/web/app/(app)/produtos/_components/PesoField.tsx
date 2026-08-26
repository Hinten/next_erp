'use client';

import { useFormContext } from 'react-hook-form';
import { DecimalInput, type FieldConfig, type FieldRenderProps } from '@delfrance/ui';

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
 *
 * ⚠️ The input is `DecimalInput`, never a bare `<NumberInput>`. This field is
 * where the "the form keeps clearing itself" report came from: Mantine emits a
 * STRING for every in-progress decimal, and the old
 * `typeof val === 'number' ? val : null` answered `5,` with `null`, so the
 * controlled value re-rendered empty and no decimal could ever be typed.
 */
function DimensaoKitField({ decimalScale, step, ...props }: DimensaoKitFieldProps) {
  const form = useFormContext();
  const ehKit = form?.watch('ehKit') === true;
  return (
    <DecimalInput
      label={props.label}
      description={
        ehKit ? 'Calculado automaticamente a partir dos componentes do kit.' : props.hint
      }
      value={(props.value as number | null | undefined) ?? null}
      onChange={props.onChange}
      onBlur={props.onBlur}
      disabled={props.disabled || ehKit}
      error={props.error}
      min={0}
      step={step}
      decimalScale={decimalScale}
      style={{ maxWidth: 320 }}
    />
  );
}

type DimensaoKitFieldProps = FieldRenderProps & { decimalScale: number; step: number };

/**
 * `renderInput` for the kit-derived weight fields (`pesoBrutoKg`/`pesoLiquidoKg`)
 * — read-only when the produto is a kit. Static (no `db`/`produtoId`), so it's
 * wired directly in `produtoFields.ts`. Three decimals: the stored unit is kg
 * and the operator weighs in grams.
 */
export const pesoRenderInput: FieldConfig['renderInput'] = (props) => (
  <DimensaoKitField {...props} decimalScale={3} step={0.1} />
);

/**
 * `renderInput` for the kit-derived box fields (`alturaCm`/`larguraCm`/
 * `profundidadeCm`). Same lock as the weight — both halves of the rollup are
 * server-owned on a kit, so neither may be hand-edited (#1152). Two decimals:
 * publish rounds these UP to whole centimetres anyway (`dimensoesDoPacote`), so
 * more precision would be recorded and then discarded.
 */
export const dimensaoRenderInput: FieldConfig['renderInput'] = (props) => (
  <DimensaoKitField {...props} decimalScale={2} step={1} />
);
