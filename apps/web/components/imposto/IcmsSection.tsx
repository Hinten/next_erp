'use client';

import { Alert, Code, Stack, Text } from '@mantine/core';
import {
  CRT_LABELS,
  CSOSN_LABELS,
  CST_ICMS_LABELS,
  MOD_BC_LABELS,
  MOD_BCST_LABELS,
  SUBCONFIG_POR_CSOSN,
  SUBCONFIGS_ICMS_SN,
  csosnSchema,
  ehCrtSimplesNacional,
  type SubConfigIcmsSn,
} from '@delfrance/schemas';
import { EnumSelect, SubConfigGrid, type FieldSpec } from './fields';
import type { ImpostoConfigValue } from './types';

/**
 * The editable fields of each Simples Nacional sub-config slot. WHICH slot a
 * CSOSN reads is `SUBCONFIG_POR_CSOSN` (`@delfrance/schemas`) — the same table
 * the NF-e engine emits from, so the editor cannot show one slot while the
 * engine reads another.
 */
const ESPECS_POR_SUBCONFIG: Record<SubConfigIcmsSn, FieldSpec[]> = {
  csosn101: [icmsRate('pCredSN'), icmsMoney('vCredICMSSN')],
  csosn201: [
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
  csosn202ou203: [
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
  csosn500: [
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
  csosn900: [
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

/** Every SN slot set to null — one active treatment at a time. */
const SLOTS_SN_VAZIOS: Readonly<Record<SubConfigIcmsSn, null>> = Object.fromEntries(
  SUBCONFIGS_ICMS_SN.map((slot) => [slot, null]),
) as Record<SubConfigIcmsSn, null>;

const SEM_ERROS: ReadonlyMap<string, string> = new Map();

export interface IcmsSectionProps {
  value: ImpostoConfigValue;
  onChange: (next: ImpostoConfigValue) => void;
  disabled?: boolean;
  /** RHF error node for `configuracaoICMS`, if any. */
  errorNode?: Record<string, unknown>;
  /**
   * What the NF-e engine would refuse, keyed by field path
   * (`configuracaoICMS.csosn500.vBCSTRet`, `configuracaoICMS.csosn`) — the
   * host derives it from `problemasDeEmissaoDoImposto`. An RHF error on the
   * same field wins.
   */
  errosPorCampo?: ReadonlyMap<string, string>;
}

/**
 * ICMS editor. Drives the `configuracaoICMS` block: CRT → (Simples Nacional)
 * CSOSN + its conditional sub-config. Regime Normal (CRT 3/4) is preserved but
 * not edited here (issue #312) — the existing blob round-trips untouched.
 */
export function IcmsSection({
  value,
  onChange,
  disabled,
  errorNode,
  errosPorCampo = SEM_ERROS,
}: IcmsSectionProps) {
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
    patchIcms({ csosn: next ?? null, ...SLOTS_SN_VAZIOS });
  }

  function patchSub(slot: SubConfigIcmsSn, patch: Record<string, unknown>) {
    const cur = (icms[slot] ?? {}) as Record<string, unknown>;
    patchIcms({ [slot]: { ...cur, ...patch } });
  }

  // The SN predicate and the CSOSN → slot table are the engine's own
  // (`@delfrance/schemas` regrasDeEmissao). Both guard raw soft-read values: a
  // legacy numeric CRT reads as "not SN", and an off-enum CSOSN has no slot
  // (`undefined`, so nothing renders) — `null` is a CSOSN that reads no slot.
  const isSN = ehCrtSimplesNacional(crt);
  const csosnValido = csosnSchema.safeParse(csosn);
  const slot = csosnValido.success ? SUBCONFIG_POR_CSOSN[csosnValido.data] : undefined;
  const rhf = (errorNode ?? {}) as Record<string, unknown>;
  const erroCsosn =
    (rhf.csosn as { message?: string } | undefined)?.message ??
    errosPorCampo.get('configuracaoICMS.csosn');

  function errosDoSlot(s: SubConfigIcmsSn): Record<string, { message?: string } | undefined> {
    const rhfDoSlot = (rhf[s] ?? {}) as Record<string, { message?: string } | undefined>;
    const erros: Record<string, { message?: string } | undefined> = {};
    for (const { key } of ESPECS_POR_SUBCONFIG[s]) {
      const message = rhfDoSlot[key]?.message ?? errosPorCampo.get(`configuracaoICMS.${s}.${key}`);
      if (message != null) erros[key] = { message };
    }
    return erros;
  }

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
            error={erroCsosn}
          />
          {csosn != null && slot === null && (
            <Text c="dimmed" size="sm">
              CSOSN {csosn} não possui campos adicionais de ICMS.
            </Text>
          )}
          {slot != null && (
            <SubConfigGrid
              config={(icms[slot] as Record<string, unknown> | null) ?? null}
              specs={ESPECS_POR_SUBCONFIG[slot]}
              onPatch={(patch) => patchSub(slot, patch)}
              disabled={disabled}
              errorNode={errosDoSlot(slot)}
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
