'use client';

import { SimpleGrid, Stack, Text } from '@mantine/core';
import { NumberField } from './fields';
import type { ImpostoConfigValue } from './types';

export interface RetencaoSectionProps {
  value: ImpostoConfigValue;
  onChange: (next: ImpostoConfigValue) => void;
  disabled?: boolean;
}

const RET_FIELDS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'vBCPIS', label: 'BC do PIS retido' },
  { key: 'vRetPIS', label: 'PIS retido' },
  { key: 'vBCCOFINS', label: 'BC da COFINS retida' },
  { key: 'vRetCOFINS', label: 'COFINS retida' },
  { key: 'vBCCSLL', label: 'BC da CSLL retida' },
  { key: 'vRetCSLL', label: 'CSLL retida' },
  { key: 'vBCIRRF', label: 'BC do IRRF' },
  { key: 'vIRRF', label: 'IRRF retido' },
  { key: 'vBCRetPrev', label: 'BC da retenção previdenciária' },
  { key: 'vRetPrev', label: 'Retenção previdenciária' },
];

/** Retenções (PIS/COFINS/CSLL/IRRF/Prev) — rolled up into `<total><retTrib>`. */
export function RetencaoSection({ value, onChange, disabled }: RetencaoSectionProps) {
  const ret = (value.retencao ?? {}) as Record<string, unknown>;

  function patch(key: string, v: number | null) {
    onChange({ ...value, retencao: { ...ret, [key]: v } as never });
  }

  return (
    <Stack gap="sm">
      <Text c="dimmed" size="xs">
        Valores retidos na fonte (opcionais). Somados no total da NF-e.
      </Text>
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
        {RET_FIELDS.map((f) => (
          <NumberField
            key={f.key}
            label={`${f.label} (R$)`}
            value={(ret[f.key] as number | null) ?? null}
            onChange={(v) => patch(f.key, v)}
            disabled={disabled}
          />
        ))}
      </SimpleGrid>
    </Stack>
  );
}
