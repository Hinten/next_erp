import { microsToMillis, millisToMicros } from '@delfrance/core/datetime';

/** Numeric-epoch unit a `kind: 'datetime'` field is stored in. */
export type EpochUnit = 'ms' | 'us';

/**
 * Format a numeric-epoch value (milliseconds or microseconds since epoch) as
 * the local `YYYY-MM-DD HH:mm:ss` string Mantine's `DateTimePicker` speaks.
 * Wall-clock in the user's timezone, matching the legacy Flutter client.
 *
 * Shared by the generic `FieldRenderer` (`kind: 'datetime'`) and the bespoke
 * pedido frete inputs so there is one conversion implementation.
 */
export function epochToPickerString(
  value: number | null | undefined,
  unit: EpochUnit,
): string | null {
  if (value == null) return null;
  const ms = unit === 'us' ? microsToMillis(value) : value;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Parse the picker's local string back to a numeric epoch in `unit`. */
export function pickerStringToEpoch(value: string | null, unit: EpochUnit): number | null {
  if (!value) return null;
  // 'YYYY-MM-DD HH:mm:ss' → ISO-local; bare 'YYYY-MM-DD' gets midnight.
  const iso = value.includes(' ')
    ? value.replace(' ', 'T')
    : value.length === 10
      ? `${value}T00:00:00`
      : value;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return unit === 'us' ? millisToMicros(d.getTime()) : d.getTime();
}
