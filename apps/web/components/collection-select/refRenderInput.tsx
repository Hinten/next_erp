'use client';

import type { ZodObject, ZodRawShape } from 'zod';
import { type CollectionHandle } from '@delfrance/data';
import type { FieldConfig, FieldRenderProps } from '@delfrance/ui';
import { CollectionSelect } from './CollectionSelect';

/**
 * Wrap a collection in a `renderInput` that the schema-driven ObjectView can
 * mount. `required` only controls the Mantine asterisk + clearable flag — the
 * actual gate on save is schema validation (or the Firestore client rejecting
 * `undefined` for mandatory `z.unknown()` refs).
 *
 * `emitDocPath` switches the emitted value from a native `DocumentReference`
 * to the Flutter-ODM doc-path string `documents/<collection>/<id>` — required
 * for refs the schema types as `z.string()` (e.g. `int_frete`'s
 * `filialIntegracaoFreteOuterRef`), keeping writes byte-compatible with the
 * legacy app.
 */
export function refRenderInput<S extends ZodObject<ZodRawShape>>(
  collection: CollectionHandle<S>,
  required: boolean,
  labelField: string = 'nome',
  searchFields?: string[],
  emitDocPath: boolean = false,
): FieldConfig['renderInput'] {
  function RefInput(props: FieldRenderProps) {
    return (
      <CollectionSelect
        collection={collection}
        labelField={labelField}
        searchFields={searchFields}
        fieldName={props.name}
        label={props.label}
        hint={props.hint}
        value={props.value}
        onChange={props.onChange}
        onBlur={props.onBlur}
        disabled={props.disabled}
        error={props.error}
        required={required}
        emitDocPath={emitDocPath}
      />
    );
  }
  return RefInput;
}
