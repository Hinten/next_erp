'use client';

import { Autocomplete, Checkbox, Group, Select, Stack, Text, TextInput } from '@mantine/core';

import {
  draftTypedValue,
  effectiveUnit,
  emptyRow,
  isNaRow,
  isNumericAttr,
  naRow,
  numberUnitOptions,
  resolveTypedValue,
  rowFromSelect,
  selectOptions,
  selectValueOf,
  unitOptions,
  widgetKind,
  type AttrRow,
} from '@/lib/mercado-livre/attributeForm';
import type { MercadoLivreCategoriaAtributo } from '@/lib/mercado-livre/client';
import { unitLabel } from '@/lib/mercado-livre/units';

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
 *  - **A `number_unit` pairs that box with a unit control** — a `Select` when ML
 *    allows a choice, a plain label when it does not. Same shape the size-chart
 *    grid uses for its measurement columns.
 *  - **A multivalued `list` renders as a single `Select` anyway** — see the note
 *    on the hint below.
 *
 * ⚠️ The free-text branch keeps the operator's RAW draft while they type and only
 * resolves it on blur. Resolving on change rewrites the text under the caret —
 * a trailing space was trimmed away, and text matching a known value snapped
 * back to that value's canonical name — which between them made a space
 * impossible to type and `Nike Air` impossible to enter at all.
 */
export function AttributeField({ attr, row, onChange, disabled, error }: AttributeFieldProps) {
  const kind = widgetKind(attr);
  const na = isNaRow(row);
  const label = attr.name ?? attr.id;
  // The unit the field is CURRENTLY on — stored, else the category default. Both
  // typing handlers below carry it, so neither one can reset the other's half.
  const unit = effectiveUnit(attr, row);
  const unitOpts = unitOptions(attr, row.unit_id);
  // The `number_unit` branch renders its error message OUTSIDE the input (see
  // there), so Mantine never wires it up. ⚠️ `aria-errormessage` rather than
  // `aria-describedby`: Mantine sets `aria-describedby` itself AFTER spreading
  // the rest of the props, so one passed in is silently overwritten with
  // undefined — verified — while `aria-errormessage` reaches the input. It is
  // also the right attribute here, being the standard partner of the
  // `aria-invalid` that `error` already sets.
  const errorId = `${attr.id}-erro`;

  function setValue(next: AttrRow) {
    // ⚠️ Only report an ACTUAL change. `onBlur` fires this on every focus loss,
    // and the parent turns any report into a new rows array, which `ListingForm`
    // reads as "the operator edited the attributes" — so an unconditional write
    // would raise unsaved changes on a listing nobody touched, just from tabbing
    // past a field.
    if (sameRow(next, row)) return;
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
        // `emptyRow`, not a bare literal: a `number_unit` blank still carries the
        // unit the picker shows, or unticking N/A would leave the row and the
        // screen disagreeing and the next blur would report a phantom edit.
        setValue(e.currentTarget.checked ? naRow(attr.id) : emptyRow(attr))
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
          // case-insensitively) and falls back to free text. That resolution
          // waits for blur; until then the draft is stored verbatim.
          data={attr.values.map((v) => v.name ?? '').filter((n) => n !== '')}
          value={row.value_name ?? ''}
          onChange={(typed) =>
            // `null`: this branch only ever serves `string` and `number`, neither
            // of which carries a unit — `number_unit` has its own branch below.
            setValue(draftTypedValue(attr, isNumericAttr(attr) ? digitsOnly(typed) : typed, null))
          }
          // ⚠️ Resolve what the INPUT holds, not what the `row` prop holds. The
          // two agree only once React has re-rendered with the last keystroke,
          // and blur is a separate event from change — reading the prop makes
          // this handler's correctness depend on that flush having happened, and
          // a stale read here overwrites the newest character with an older
          // resolution. The DOM node is the one source that is never behind.
          onBlur={(e) =>
            setValue(
              resolveTypedValue(
                attr,
                isNumericAttr(attr) ? digitsOnly(e.currentTarget.value) : e.currentTarget.value,
                null,
              ),
            )
          }
          maxLength={attr.valueMaxLength ?? undefined}
          inputMode={isNumericAttr(attr) ? 'numeric' : undefined}
          disabled={disabled || na}
          error={error}
        />
      )}

      {kind === 'number_unit' && (
        <>
          {/* ⚠️ `align="flex-end"` pins both controls to the same baseline while
              the label and description above them make the value input taller.
              That only holds because the error message is rendered BELOW the
              whole Group instead of under the input — inside it, flagging a
              required attribute would shove the unit picker down. */}
          <Group gap="xs" wrap="nowrap" align="flex-end">
            <Autocomplete
              style={{ flex: 1 }}
              label={label}
              description={hint}
              // Only the values measured in the CURRENT unit, and only their
              // number: the box no longer holds ML's `'355 mL'`, so offering it
              // whole would suggest text the field immediately strips.
              data={numberUnitOptions(attr, unit)}
              value={row.value_name ?? ''}
              onChange={(typed) => setValue(draftTypedValue(attr, digitsOnly(typed), unit))}
              // ⚠️ Resolve what the INPUT holds, not what the `row` prop holds —
              // see the note on the free-text branch above.
              onBlur={(e) =>
                setValue(resolveTypedValue(attr, digitsOnly(e.currentTarget.value), unit))
              }
              maxLength={attr.valueMaxLength ?? undefined}
              // `decimal`, not `numeric`: `digitsOnly` admits `.` and `,`, and a
              // measurement is routinely fractional. Same call `SizeChartGrid`
              // makes for its numeric cells.
              inputMode="decimal"
              disabled={disabled || na}
              // Boolean: the border turns red here, the message renders once below.
              error={error != null}
              aria-errormessage={error != null ? errorId : undefined}
            />
            {unitOpts.length > 1 ? (
              <Select
                w={104}
                // ⚠️ `aria-label`, not `label`. A visible label would sit above
                // the Select and break the baseline this Group depends on, and
                // the unit is already named by the field it belongs to.
                aria-label={`Unidade de ${label}`}
                data={unitOpts}
                value={unit}
                // Spread the row so changing the unit never clears the number —
                // but ⚠️ DROP `value_id`. On a `number_unit` that id names the
                // PAIR, not the number: ML answers `'355 mL'` with
                // `value_id: '3681798'`, so once the unit moves to litres the id
                // describes a different measurement. Left in place it outranks
                // the value name at ML and the operator's change is discarded —
                // and it would also skip the resolution in `attributesForSave`.
                // `?? unit` because Mantine can still report null.
                onChange={(v) => setValue({ ...row, value_id: null, unit_id: v ?? unit })}
                allowDeselect={false}
                comboboxProps={{ withinPortal: true }}
                disabled={disabled || na}
              />
            ) : (
              unit != null && (
                // ML allows exactly one unit here, so there is nothing to pick —
                // but it still has to be VISIBLE, which is the whole complaint.
                <Text size="xs" c="dimmed" pb={8}>
                  {unitLabel(unit)}
                </Text>
              )
            )}
          </Group>
          {error != null && (
            <Text id={errorId} size="xs" c="var(--mantine-color-error)">
              {error}
            </Text>
          )}
        </>
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

function sameRow(a: AttrRow, b: AttrRow): boolean {
  return (
    a.id === b.id &&
    a.value_id === b.value_id &&
    a.value_name === b.value_name &&
    a.unit_id === b.unit_id
  );
}

/** ML rejects a non-numeric value on `number`/`number_unit` outright. */
function digitsOnly(value: string): string {
  return value.replace(/[^\d.,]/g, '');
}
