'use client';

import { Divider, Stack, Switch, Text } from '@mantine/core';
import { CST_PIS_COFINS_LABELS } from '@delfrance/schemas';
import { EnumSelect, NumberField } from './fields';
import type { ImpostoConfigValue } from './types';

export interface PisCofinsSectionProps {
  value: ImpostoConfigValue;
  onChange: (next: ImpostoConfigValue) => void;
  disabled?: boolean;
}

/** PIS, COFINS and PIS-ST editors (Simples Nacional + back-compat PIS-ST). */
export function PisCofinsSection({ value, onChange, disabled }: PisCofinsSectionProps) {
  const pis = (value.configuracaoPIS ?? {}) as Record<string, unknown>;
  const cofins = (value.configuracaoCOFINS ?? {}) as Record<string, unknown>;
  const pisst = (value.configuracaoPISST ?? {}) as Record<string, unknown>;

  function patch(
    key: keyof ImpostoConfigValue,
    sub: Record<string, unknown>,
    fieldPatch: Record<string, unknown>,
  ) {
    onChange({ ...value, [key]: { ...sub, ...fieldPatch } as never });
  }
  function clear(key: keyof ImpostoConfigValue) {
    onChange({ ...value, [key]: null });
  }

  return (
    <Stack gap="md">
      <Stack gap="sm">
        <Text fw={500} size="sm">
          PIS
        </Text>
        <EnumSelect
          label="CST do PIS"
          labels={CST_PIS_COFINS_LABELS}
          value={(pis.CST as string | null) ?? null}
          onChange={(v) =>
            v ? patch('configuracaoPIS', pis, { CST: v }) : clear('configuracaoPIS')
          }
          disabled={disabled}
        />
        {pis.CST != null && (
          <>
            <NumberField
              label="Alíquota do PIS (%)"
              value={(pis.pPIS as number | null) ?? null}
              onChange={(v) => patch('configuracaoPIS', pis, { pPIS: v })}
              disabled={disabled}
            />
            <NumberField
              label="Alíquota do PIS por unidade (R$)"
              value={(pis.vAliqProd as number | null) ?? null}
              onChange={(v) => patch('configuracaoPIS', pis, { vAliqProd: v })}
              disabled={disabled}
            />
          </>
        )}
      </Stack>

      <Divider />

      <Stack gap="sm">
        <Text fw={500} size="sm">
          COFINS
        </Text>
        <EnumSelect
          label="CST da COFINS"
          labels={CST_PIS_COFINS_LABELS}
          value={(cofins.CST as string | null) ?? null}
          onChange={(v) =>
            v ? patch('configuracaoCOFINS', cofins, { CST: v }) : clear('configuracaoCOFINS')
          }
          disabled={disabled}
        />
        {cofins.CST != null && (
          <>
            <NumberField
              label="Alíquota da COFINS (%)"
              value={(cofins.pCOFINS as number | null) ?? null}
              onChange={(v) => patch('configuracaoCOFINS', cofins, { pCOFINS: v })}
              disabled={disabled}
            />
            <NumberField
              label="Alíquota da COFINS por unidade (R$)"
              value={(cofins.vAliqProd as number | null) ?? null}
              onChange={(v) => patch('configuracaoCOFINS', cofins, { vAliqProd: v })}
              disabled={disabled}
            />
          </>
        )}
      </Stack>

      <Divider />

      <Stack gap="sm">
        <Text fw={500} size="sm">
          PIS ST
        </Text>
        <Switch
          label="Compõe o valor total da nota"
          checked={pisst.compoeTotalNota === true}
          onChange={(e) =>
            patch('configuracaoPISST', pisst, { compoeTotalNota: e.currentTarget.checked })
          }
          disabled={disabled}
        />
        <NumberField
          label="Alíquota do PIS ST (%)"
          value={(pisst.pPIS as number | null) ?? null}
          onChange={(v) => patch('configuracaoPISST', pisst, { pPIS: v })}
          disabled={disabled}
        />
        <NumberField
          label="Alíquota do PIS ST por unidade (R$)"
          value={(pisst.vAliqProd as number | null) ?? null}
          onChange={(v) => patch('configuracaoPISST', pisst, { vAliqProd: v })}
          disabled={disabled}
        />
      </Stack>
    </Stack>
  );
}
