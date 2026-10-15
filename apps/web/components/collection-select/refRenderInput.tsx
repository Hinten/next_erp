'use client';

import type { ZodObject, ZodRawShape } from 'zod';
import type { CollectionHandle } from '@delfrance/data';
import type { FieldConfig, FieldRenderProps } from '@delfrance/ui';
import { CollectionSelect } from './CollectionSelect';

/**
 * Wrap a collection in a `renderInput` that the schema-driven ObjectView can
 * mount. `required` only controls the Mantine asterisk + clearable flag — the
 * actual gate on save is schema validation. The picker emits the Flutter-ODM
 * doc-path string `documents/<collection>/<id>` (the format every outer-ref
 * field is typed for), keeping writes byte-compatible with the legacy app.
 */
export function refRenderInput<S extends ZodObject<ZodRawShape>>(
  collection: CollectionHandle<S>,
  required: boolean,
  labelField: string = 'nome',
  searchFields?: string[],
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
      />
    );
  }
  return RefInput;
}
