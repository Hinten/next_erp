'use client';

import { Autocomplete, Checkbox, Group, Select, Stack, Text, TextInput } from '@mantine/core';

import {
  isNaRow,
  isNumericAttr,
  naRow,
  resolveTypedValue,
  rowFromSelect,
  selectOptions,
  selectValueOf,
  widgetKind,
  type AttrRow,
} from '@/lib/mercado-livre/attributeForm';
import type { MercadoLivreCategoriaAtributo } from '@/lib/mercado-livre/client';

export interface AttributeFieldProps {
  attr: MercadoLivreCategoriaAtributo;
  row: AttrRow;
  onChange: (row: AttrRow) => void;
  disabled?: boolean;
  error?: string;
}

/**
 * One Mercado Livre category attribute.
 *
 * The control is chosen by `widgetKind`, which the server's `valueType` drives.
 * Two of those choices are where this component earns its keep:
 *
 *  - **`string`/`number`/`number_unit` render as an `Autocomplete`, not a
 *    `Select`.** ML ships known values for these but still accepts anything, so
 *    a hard Select would refuse legitimate input.
 *  - **A multivalued `list` renders as a single `Select` anyway** — see the note
 *    on the hint below.
 */
export function AttributeField({ attr, row, onChange, disabled, error }: AttributeFieldProps) {
  const kind = widgetKind(attr);
  const na = isNaRow(row);
  const label = attr.name ?? attr.id;

  function setValue(next: AttrRow) {
    onChange(next);
  }

  const naToggle = attr.required ? (
    // Offered on required attributes only. ML accepts `-1` anywhere, but this
    // is the one place it unblocks something: without it a required attribute
    // the product genuinely has no value for could never be published.
    <Checkbox
      size="xs"
      label="Não se aplica"
      checked={na}
      disabled={disabled}
      onChange={(e) =>
        setValue(
          e.currentTarget.checked
            ? naRow(attr.id)
            : { id: attr.id, value_id: null, value_name: null, unit_id: null },
        )
      }
    />
  ) : null;

  const hint =
    kind === 'multiselect'
      ? // The stored shape (`MlAttribute`) and the wire transform
        // (`attributeToMercadoLivre`) both carry exactly ONE value per
        // attribute. Rendering a MultiSelect here would let an operator pick
        // three and ship one, which is the silent-loss class this whole stack
        // has been removing. One value, stated plainly, until the wire can
        // carry more.
        'O Mercado Livre aceita vários valores aqui, mas apenas um é enviado.'
      : (attr.hint ?? undefined);

  return (
    <Stack gap={4}>
      {kind === 'text' && (
        <Autocomplete
          label={label}
          description={hint}
          // An Autocomplete reports the LABEL, both when typed and when an
          // option is clicked — which is exactly what `resolveTypedValue`
          // expects, since it matches on the value NAME (accent- and
          // case-insensitively) and falls back to free text.
          data={attr.values.map((v) => v.name ?? '').filter((n) => n !== '')}
          value={row.value_name ?? ''}
          onChange={(typed) =>
            setValue(resolveTypedValue(attr, isNumericAttr(attr) ? digitsOnly(typed) : typed))
          }
          maxLength={attr.valueMaxLength ?? undefined}
          inputMode={isNumericAttr(attr) ? 'numeric' : undefined}
          disabled={disabled || na}
          error={error}
        />
      )}

      {(kind === 'select' || kind === 'multiselect') && (
        <Select
          label={label}
          description={hint}
          data={selectOptions(attr)}
          // A Select reports the option VALUE (ML's value id) — the mirror of
          // the Autocomplete above, hence `rowFromSelect` rather than
          // `resolveTypedValue`.
          value={selectValueOf(row)}
          onChange={(v) => setValue(rowFromSelect(attr, v))}
          searchable
          clearable
          disabled={disabled || na}
          error={error}
        />
      )}

      {kind === 'unsupported' && (
        <TextInput
          label={label}
          description={`Tipo não editável aqui (${attr.valueType ?? 'desconhecido'}).`}
          value={row.value_name ?? ''}
          readOnly
          disabled
        />
      )}

      {(naToggle != null || na) && (
        <Group gap="sm">
          {naToggle}
          {na && (
            <Text size="xs" c="dimmed">
              Enviado ao Mercado Livre como “não se aplica”.
            </Text>
          )}
        </Group>
      )}
    </Stack>
  );
}

/** ML rejects a non-numeric value on `number`/`number_unit` outright. */
function digitsOnly(value: string): string {
  return value.replace(/[^\d.,]/g, '');
}
