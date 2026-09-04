'use client';

import { Group, Stack, Switch, Text } from '@mantine/core';
import { TimeInput } from '@mantine/dates';
import type { HorarioWebchat, PeriodoWebchat } from '@delfrance/schemas';
import type { FieldRenderProps } from '@delfrance/ui';
import { applyWeekdayEdit, defaultHorario, fromHHMM, toHHMM } from './horarioFuncionamento';

const WEEKDAYS: ReadonlyArray<{ key: keyof PeriodoWebchat; label: string }> = [
  { key: 'domingo', label: 'Domingo' },
  { key: 'segunda', label: 'Segunda-feira' },
  { key: 'terca', label: 'Terça-feira' },
  { key: 'quarta', label: 'Quarta-feira' },
  { key: 'quinta', label: 'Quinta-feira' },
  { key: 'sexta', label: 'Sexta-feira' },
  { key: 'sabado', label: 'Sábado' },
];

/**
 * Custom `renderInput` for `horario_funcionamento` (`PeriodoWebchat[] | null`
 * on the wire — same shape as `whatsapp`'s editor). Only the FIRST período is
 * surfaced, but every additional one is PRESERVED verbatim on save
 * (`applyWeekdayEdit`). Each weekday toggles independently: off → that day's
 * entry is `null`; on → abertura/fechamento time inputs appear, defaulting to
 * 08:00–18:00 until edited.
 */
export function HorarioFuncionamentoField({
  value,
  onChange,
  disabled,
  label,
  hint,
}: FieldRenderProps) {
  const periods = (value as PeriodoWebchat[] | null) ?? [];
  const period: PeriodoWebchat = periods[0] ?? {};
  const extraPeriodos = Math.max(0, periods.length - 1);

  function updateDay(day: keyof PeriodoWebchat, next: HorarioWebchat | null): void {
    onChange(applyWeekdayEdit(periods, day, next));
  }

  return (
    <Stack gap="xs">
      <Text fw={500} size="sm">
        {label}
      </Text>
      {hint && (
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      )}
      {extraPeriodos > 0 && (
        <Text size="xs" c="dimmed" fs="italic">
          {extraPeriodos > 1
            ? `+${extraPeriodos} períodos adicionais preservados`
            : '+1 período adicional preservado'}
        </Text>
      )}
      {WEEKDAYS.map(({ key, label: dayLabel }) => {
        const horario = period[key] ?? null;
        const active = horario != null;
        return (
          <Group key={key} align="flex-end" gap="sm" wrap="wrap">
            <Switch
              label={dayLabel}
              checked={active}
              disabled={disabled}
              onChange={(e) => {
                updateDay(key, e.currentTarget.checked ? defaultHorario() : null);
              }}
            />
            <TimeInput
              label={`${dayLabel} — Abertura`}
              value={toHHMM(horario?.aberturaHora, horario?.aberturaMinuto)}
              disabled={disabled || !active}
              onChange={(e) => {
                if (!horario) return;
                const parsed = fromHHMM(e.currentTarget.value);
                if (parsed)
                  updateDay(key, {
                    ...horario,
                    aberturaHora: parsed.hour,
                    aberturaMinuto: parsed.minute,
                  });
              }}
            />
            <TimeInput
              label={`${dayLabel} — Fechamento`}
              value={toHHMM(horario?.fechamentoHora, horario?.fechamentoMinuto)}
              disabled={disabled || !active}
              onChange={(e) => {
                if (!horario) return;
                const parsed = fromHHMM(e.currentTarget.value);
                if (parsed)
                  updateDay(key, {
                    ...horario,
                    fechamentoHora: parsed.hour,
                    fechamentoMinuto: parsed.minute,
                  });
              }}
            />
          </Group>
        );
      })}
    </Stack>
  );
}
