'use client';

import { Stack, TextInput } from '@mantine/core';
import { CST_IPI_LABELS, IPI_TRIB_CSTS } from '@delfrance/schemas';
import { EnumSelect, NumberField } from './fields';
import type { ImpostoConfigValue } from './types';

export interface IpiSectionProps {
  value: ImpostoConfigValue;
  onChange: (next: ImpostoConfigValue) => void;
  disabled?: boolean;
}

/** IPI editor: `cEnq` + CST → the `<IPITrib>` (tributado) value fields. */
export function IpiSection({ value, onChange, disabled }: IpiSectionProps) {
  const ipi = (value.configuracaoIPI ?? {}) as Record<string, unknown>;
  const cst = (ipi.CST as string | null) ?? null;
  const tributado = cst != null && IPI_TRIB_CSTS.has(cst as never);

  function patch(fieldPatch: Record<string, unknown>) {
    onChange({ ...value, configuracaoIPI: { ...ipi, ...fieldPatch } as never });
  }

  return (
    <Stack gap="sm">
      <EnumSelect
        label="CST do IPI"
        labels={CST_IPI_LABELS}
        value={cst}
        onChange={(v) => {
          if (!v) return onChange({ ...value, configuracaoIPI: null });
          // `cEnq` is XSD-required (Código de Enquadramento Legal); default '999'.
          patch({ CST: v, cEnq: (ipi.cEnq as string | null) ?? '999' });
        }}
        disabled={disabled}
      />
      {cst != null && (
        <>
          <TextInput
            label="Código de enquadramento legal (cEnq)"
            description="1 a 3 caracteres — normalmente '999' (Tributação normal IPI - Outros)."
            maxLength={3}
            value={(ipi.cEnq as string | null) ?? ''}
            onChange={(e) => patch({ cEnq: e.currentTarget.value || null })}
            disabled={disabled}
          />
          {tributado && (
            <>
              <NumberField
                label="Valor da BC do IPI (R$)"
                value={(ipi.vBC as number | null) ?? null}
                onChange={(v) => patch({ vBC: v })}
                disabled={disabled}
              />
              <NumberField
                label="Alíquota do IPI (%)"
                value={(ipi.pIPI as number | null) ?? null}
                onChange={(v) => patch({ pIPI: v })}
                disabled={disabled}
              />
              <NumberField
                label="Quantidade total na unidade padrão"
                value={(ipi.qUnid as number | null) ?? null}
                onChange={(v) => patch({ qUnid: v })}
                disabled={disabled}
              />
              <NumberField
                label="Valor por unidade tributável (R$)"
                value={(ipi.vUnid as number | null) ?? null}
                onChange={(v) => patch({ vUnid: v })}
                disabled={disabled}
              />
              <NumberField
                label="Valor do IPI (R$)"
                value={(ipi.vIPI as number | null) ?? null}
                onChange={(v) => patch({ vIPI: v })}
                disabled={disabled}
              />
            </>
          )}
        </>
      )}
    </Stack>
  );
}
