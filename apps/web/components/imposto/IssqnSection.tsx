'use client';

import { SimpleGrid, Stack, Switch, Text, TextInput } from '@mantine/core';
import { IND_INCENTIVO_LABELS, IND_ISS_LABELS } from '@delfrance/schemas';
import { EnumSelect, NumberField } from './fields';
import type { ImpostoConfigValue } from './types';

export interface IssqnSectionProps {
  value: ImpostoConfigValue;
  onChange: (next: ImpostoConfigValue) => void;
  disabled?: boolean;
}

/**
 * ISSQN editor (services). The NF-e XSD makes `<imposto>` carry **either**
 * `<ICMS>` **or** `<ISSQN>` (xs:choice) — a toggle enables/clears the whole
 * ISSQN block, and emission skips ICMS when it is set.
 */
export function IssqnSection({ value, onChange, disabled }: IssqnSectionProps) {
  const issqn = (value.configuracaoISSQN ?? {}) as Record<string, unknown>;
  const enabled = value.configuracaoISSQN != null;

  function patch(fieldPatch: Record<string, unknown>) {
    onChange({ ...value, configuracaoISSQN: { ...issqn, ...fieldPatch } as never });
  }

  return (
    <Stack gap="sm">
      <Switch
        label="Tributar como serviço (ISSQN)"
        description="Quando ligado, a NF-e emite ISSQN no lugar do ICMS para os itens."
        checked={enabled}
        onChange={(e) =>
          onChange({
            ...value,
            configuracaoISSQN: e.currentTarget.checked ? ((issqn as never) ?? ({} as never)) : null,
          })
        }
        disabled={disabled}
      />

      {enabled && (
        <>
          <Text c="dimmed" size="xs">
            Campos obrigatórios do grupo ISSQN (validados ao salvar).
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <NumberField
              label="vBC (R$)"
              value={(issqn.vBC as number | null) ?? null}
              onChange={(v) => patch({ vBC: v })}
              disabled={disabled}
            />
            <NumberField
              label="Alíquota (%)"
              value={(issqn.vAliq as number | null) ?? null}
              onChange={(v) => patch({ vAliq: v })}
              disabled={disabled}
            />
            <NumberField
              label="Valor do ISSQN (R$)"
              value={(issqn.vISSQN as number | null) ?? null}
              onChange={(v) => patch({ vISSQN: v })}
              disabled={disabled}
            />
            <TextInput
              label="Município do fato gerador (cMunFG)"
              description="Código IBGE de 7 dígitos."
              maxLength={7}
              value={(issqn.cMunFG as string | null) ?? ''}
              onChange={(e) => patch({ cMunFG: e.currentTarget.value || null })}
              disabled={disabled}
            />
            <TextInput
              label="Item da lista de serviços (cListServ)"
              description="LC 116/2003, ex.: 01.05."
              value={(issqn.cListServ as string | null) ?? ''}
              onChange={(e) => patch({ cListServ: e.currentTarget.value || null })}
              disabled={disabled}
            />
            <EnumSelect
              label="Exigibilidade do ISS (indISS)"
              labels={IND_ISS_LABELS}
              value={(issqn.indISS as string | null) ?? null}
              onChange={(v) => patch({ indISS: v })}
              clearable={false}
              disabled={disabled}
            />
            <EnumSelect
              label="Incentivo fiscal (indIncentivo)"
              labels={IND_INCENTIVO_LABELS}
              value={(issqn.indIncentivo as string | null) ?? null}
              onChange={(v) => patch({ indIncentivo: v })}
              clearable={false}
              disabled={disabled}
            />
          </SimpleGrid>
        </>
      )}
    </Stack>
  );
}
