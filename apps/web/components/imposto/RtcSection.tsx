'use client';

import { Alert, Divider, SimpleGrid, Stack, Switch, Text, TextInput } from '@mantine/core';
import { NumberField } from './fields';
import type { ImpostoConfigValue } from './types';

export interface RtcSectionProps {
  value: ImpostoConfigValue;
  onChange: (next: ImpostoConfigValue) => void;
  disabled?: boolean;
  /** Whether RTC emission is on for the filial (nfeConfig.emitirReformaTributaria). */
  emitRtc?: boolean;
}

/**
 * Reforma Tributária (IBS / CBS / IS) editor — NT 2025.002. Edits the
 * `configuracaoIBSCBS` blob (held leniently in storage). When RTC emission is
 * off on the filial, the config is still saved but not emitted — a hint says so.
 */
export function RtcSection({ value, onChange, disabled, emitRtc }: RtcSectionProps) {
  const rtc = (value.configuracaoIBSCBS ?? {}) as Record<string, unknown>;
  const is = (rtc.is ?? {}) as Record<string, unknown>;
  const hasIS = rtc.is != null;

  function patch(fieldPatch: Record<string, unknown>) {
    onChange({ ...value, configuracaoIBSCBS: { ...rtc, ...fieldPatch } as never });
  }
  function patchIS(fieldPatch: Record<string, unknown>) {
    patch({ is: { ...is, ...fieldPatch } });
  }

  return (
    <Stack gap="sm">
      {!emitRtc && (
        <Alert color="blue" variant="light">
          A Reforma Tributária só é emitida quando habilitada na filial (Configurações NF-e →
          “Emitir Reforma Tributária”). A configuração abaixo é salva de qualquer forma.
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
        <TextInput
          label="CST (IBS/CBS)"
          description="3 dígitos."
          maxLength={3}
          value={(rtc.CST as string | null) ?? ''}
          onChange={(e) => patch({ CST: e.currentTarget.value || null })}
          disabled={disabled}
        />
        <TextInput
          label="cClassTrib"
          description="6 dígitos (Anexo III/IV)."
          maxLength={6}
          value={(rtc.cClassTrib as string | null) ?? ''}
          onChange={(e) => patch({ cClassTrib: e.currentTarget.value || null })}
          disabled={disabled}
        />
        <NumberField
          label="Base de cálculo (R$)"
          description="Em branco usa o valor do item."
          value={(rtc.vBC as number | null) ?? null}
          onChange={(v) => patch({ vBC: v })}
          disabled={disabled}
        />
        <NumberField
          label="Alíquota IBS UF (%)"
          value={(rtc.pIBSUF as number | null) ?? null}
          onChange={(v) => patch({ pIBSUF: v })}
          disabled={disabled}
        />
        <NumberField
          label="Alíquota IBS Município (%)"
          value={(rtc.pIBSMun as number | null) ?? null}
          onChange={(v) => patch({ pIBSMun: v })}
          disabled={disabled}
        />
        <NumberField
          label="Alíquota CBS (%)"
          value={(rtc.pCBS as number | null) ?? null}
          onChange={(v) => patch({ pCBS: v })}
          disabled={disabled}
        />
      </SimpleGrid>

      <Divider />

      <Switch
        label="Tem Imposto Seletivo (IS)"
        checked={hasIS}
        onChange={(e) =>
          patch({ is: e.currentTarget.checked ? ((is as never) ?? ({} as never)) : null })
        }
        disabled={disabled}
      />
      {hasIS && (
        <Stack gap="sm">
          <Text c="dimmed" size="xs">
            Informe a alíquota ad valorem (pIS) ou a específica por unidade (pISEspec + qTrib).
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <TextInput
              label="CST do IS (CSTIS)"
              maxLength={3}
              value={(is.CSTIS as string | null) ?? ''}
              onChange={(e) => patchIS({ CSTIS: e.currentTarget.value || null })}
              disabled={disabled}
            />
            <TextInput
              label="cClassTribIS"
              maxLength={6}
              value={(is.cClassTribIS as string | null) ?? ''}
              onChange={(e) => patchIS({ cClassTribIS: e.currentTarget.value || null })}
              disabled={disabled}
            />
            <NumberField
              label="BC do IS (R$)"
              value={(is.vBCIS as number | null) ?? null}
              onChange={(v) => patchIS({ vBCIS: v })}
              disabled={disabled}
            />
            <NumberField
              label="Alíquota do IS (%)"
              value={(is.pIS as number | null) ?? null}
              onChange={(v) => patchIS({ pIS: v })}
              disabled={disabled}
            />
            <NumberField
              label="Alíquota específica do IS (R$/un)"
              value={(is.pISEspec as number | null) ?? null}
              onChange={(v) => patchIS({ pISEspec: v })}
              disabled={disabled}
            />
            <NumberField
              label="Quantidade tributável (qTrib)"
              value={(is.qTrib as number | null) ?? null}
              onChange={(v) => patchIS({ qTrib: v })}
              disabled={disabled}
            />
            <TextInput
              label="Unidade tributável (uTrib)"
              maxLength={6}
              value={(is.uTrib as string | null) ?? ''}
              onChange={(e) => patchIS({ uTrib: e.currentTarget.value || null })}
              disabled={disabled}
            />
          </SimpleGrid>
        </Stack>
      )}
    </Stack>
  );
}
