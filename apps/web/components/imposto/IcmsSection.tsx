'use client';

import { Alert, Code, Stack, Text } from '@mantine/core';
import {
  CRT_LABELS,
  CSOSN_LABELS,
  CST_ICMS_LABELS,
  MOD_BC_LABELS,
  MOD_BCST_LABELS,
} from '@delfrance/schemas';
import { EnumSelect, SubConfigGrid, type FieldSpec } from './fields';
import type { ImpostoConfigValue } from './types';

/** The CSOSN sub-config slot + its editable fields (Simples Nacional surface). */
const CSOSN_SUBCONFIG: Record<string, { subKey: string; specs: FieldSpec[] } | null> = {
  '101': { subKey: 'csosn101', specs: [icmsRate('pCredSN'), icmsMoney('vCredICMSSN')] },
  '102': null,
  '103': null,
  '300': null,
  '400': null,
  '201': {
    subKey: 'csosn201',
    specs: [
      icmsRate('pCredSN'),
      icmsMoney('vCredICMSSN'),
      icmsSelect('modBCST', MOD_BCST_LABELS),
      icmsRate('pMVAST'),
      icmsRate('pRedBCST'),
      icmsMoney('vBCST'),
      icmsRate('pICMSST'),
      icmsMoney('vICMSST'),
      icmsMoney('vBCFCPST'),
      icmsRate('pFCPST'),
      icmsMoney('vFCPST'),
    ],
  },
  '202': { subKey: 'csosn202ou203', specs: csosn202specs() },
  '203': { subKey: 'csosn202ou203', specs: csosn202specs() },
  '500': {
    subKey: 'csosn500',
    specs: [
      icmsMoney('vBCSTRet'),
      icmsRate('pST'),
      icmsMoney('vICMSSubstituto'),
      icmsMoney('vICMSSTRet'),
      icmsMoney('vBCFCPSTRet'),
      icmsRate('pFCPSTRet'),
      icmsMoney('vFCPSTRet'),
      icmsRate('pRedBCEfet'),
      icmsMoney('vBCEfet'),
      icmsRate('pICMSEfet'),
      icmsMoney('vICMSEfet'),
    ],
  },
  '900': {
    subKey: 'csosn900',
    specs: [
      icmsSelect('modBC', MOD_BC_LABELS),
      icmsMoney('vBC'),
      icmsRate('pRedBC'),
      icmsRate('pICMS'),
      icmsMoney('vICMS'),
      icmsSelect('modBCST', MOD_BCST_LABELS),
      icmsRate('pMVAST'),
      icmsRate('pRedBCST'),
      icmsMoney('vBCST'),
      icmsRate('pICMSST'),
      icmsMoney('vICMSST'),
      icmsMoney('vBCFCPST'),
      icmsRate('pFCPST'),
      icmsMoney('vFCPST'),
      icmsRate('pCredSN'),
      icmsMoney('vCredICMSSN'),
    ],
  },
};

function icmsMoney(key: string): FieldSpec {
  return { key, label: key, kind: 'money' };
}
function icmsRate(key: string): FieldSpec {
  return { key, label: key, kind: 'rate' };
}
function icmsSelect(key: string, labels: Record<string, string>): FieldSpec {
  return { key, label: key, kind: 'select', labels };
}
function csosn202specs(): FieldSpec[] {
  return [
    icmsSelect('modBCST', MOD_BCST_LABELS),
    icmsRate('pMVAST'),
    icmsRate('pRedBCST'),
    icmsMoney('vBCST'),
    icmsRate('pICMSST'),
    icmsMoney('vICMSST'),
    icmsMoney('vBCFCPST'),
    icmsRate('pFCPST'),
    icmsMoney('vFCPST'),
  ];
}

const SIMPLES_NACIONAL = new Set(['1', '2']);

export interface IcmsSectionProps {
  value: ImpostoConfigValue;
  onChange: (next: ImpostoConfigValue) => void;
  disabled?: boolean;
  /** RHF error node for `configuracaoICMS`, if any. */
  errorNode?: Record<string, unknown>;
}

/**
 * ICMS editor. Drives the `configuracaoICMS` block: CRT → (Simples Nacional)
 * CSOSN + its conditional sub-config. Regime Normal (CRT 3/4) is preserved but
 * not edited here (issue #312) — the existing blob round-trips untouched.
 */
export function IcmsSection({ value, onChange, disabled, errorNode }: IcmsSectionProps) {
  const icms = (value.configuracaoICMS ?? {}) as Record<string, unknown>;
  const crt = (icms.crt as string | null) ?? null;
  const csosn = (icms.csosn as string | null) ?? null;

  // Patch the configuracaoICMS object; `crt` is always carried so the typed
  // schema stays valid.
  function patchIcms(patch: Record<string, unknown>) {
    onChange({ ...value, configuracaoICMS: { ...icms, ...patch } as never });
  }

  function setCrt(next: string | null) {
    // Preserve every existing sub-config (don't drop the other regime's data).
    patchIcms({ crt: next ?? undefined });
  }

  function setCsosn(next: string | null) {
    // Clear the sibling SN sub-configs (one active treatment); keep Regime Normal
    // (`icms*`) blobs intact for a lossless round-trip.
    patchIcms({
      csosn: next ?? null,
      csosn101: null,
      csosn201: null,
      csosn202ou203: null,
      csosn500: null,
      csosn900: null,
    });
  }

  function patchSub(subKey: string, patch: Record<string, unknown>) {
    const cur = (icms[subKey] ?? {}) as Record<string, unknown>;
    patchIcms({ [subKey]: { ...cur, ...patch } });
  }

  const isSN = crt != null && SIMPLES_NACIONAL.has(crt);
  const sub = csosn ? CSOSN_SUBCONFIG[csosn] : undefined;
  const subErrors = (errorNode ?? {}) as Record<string, Record<string, { message?: string }>>;

  return (
    <Stack gap="sm">
      <EnumSelect
        label="Regime tributário (CRT)"
        labels={CRT_LABELS}
        value={crt}
        onChange={setCrt}
        disabled={disabled}
        clearable={false}
        required
      />

      {crt == null && (
        <Text c="dimmed" size="sm">
          Selecione o regime tributário para configurar o ICMS.
        </Text>
      )}

      {isSN && (
        <>
          <EnumSelect
            label="CSOSN"
            description="Código de Situação da Operação do Simples Nacional."
            labels={CSOSN_LABELS}
            value={csosn}
            onChange={setCsosn}
            disabled={disabled}
            clearable={false}
            required
          />
          {csosn != null && sub === null && (
            <Text c="dimmed" size="sm">
              CSOSN {csosn} não possui campos adicionais de ICMS.
            </Text>
          )}
          {sub && (
            <SubConfigGrid
              config={(icms[sub.subKey] as Record<string, unknown> | null) ?? null}
              specs={sub.specs}
              onPatch={(patch) => patchSub(sub.subKey, patch)}
              disabled={disabled}
              errorNode={subErrors[sub.subKey]}
            />
          )}
        </>
      )}

      {crt != null && !isSN && (
        <Alert color="yellow" title="Regime Normal / MEI">
          A edição detalhada do ICMS do Regime Normal (CST) ainda não está disponível nesta tela
          (issue #312). A configuração existente é preservada ao salvar.
          {typeof icms.cst === 'string' && (
            <Text size="sm" mt="xs">
              CST atual: <Code>{icms.cst}</Code> — {CST_ICMS_LABELS[icms.cst as never] ?? '—'}
            </Text>
          )}
        </Alert>
      )}
    </Stack>
  );
}
