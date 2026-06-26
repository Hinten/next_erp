'use client';

import { useEffect, useMemo, useState } from 'react';
import { Divider, NumberInput, Select, Stack, Switch, Text, TextInput } from '@mantine/core';
import type { Firestore } from 'firebase/firestore';
import {
  ORIGEM_PRODUTO_LABELS,
  impostoProdutoSchema,
  operacaoIdFromImpostoRef,
  type ImpostoProduto,
} from '@delfrance/schemas';
import { buildQuery, limit, orderByField } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { operacaoCollection } from '@/lib/data/operacaoCollection';
import { impostoProdutoCollection } from '@/lib/data/impostoProdutoCollection';

// Operações are few (fiscal operations); a bounded, name-ordered query suffices.
const OPERACAO_LIMIT = 200;
const IMPOSTO_LIMIT = 200;

const ORIGEM_OPTIONS = Object.entries(ORIGEM_PRODUTO_LABELS).map(([value, label]) => ({
  value,
  label,
}));

interface OperacaoRow {
  id: string;
  nome: string;
  padrao: boolean;
}

/** A blank imposto entry scoped to one operação (Flutter typo wire key). */
function emptyImposto(operacaoId: string): ImpostoProduto {
  return impostoProdutoSchema.parse({ impostoOpercaoOuterRef: `operacao/${operacaoId}` });
}

/** Raw RHF error node for one imposto entry. */
interface ImpostoErrorNode {
  NCM?: { message?: string };
  CEST?: { message?: string };
}

/**
 * Reforma Tributária (IBS/CBS/IS) per-operação config. Stored nested on the
 * imposto row via the schema's `.passthrough()` (the deep tribute configs
 * aren't typed on `ImpostoProduto`), and strict-validated server-side by the
 * tribute engine at emission. Only the "tributação integral" shape is
 * registerable here (CST + cClassTrib + the three alíquotas); the Anexo III
 * code tables live in the Portal, not in the app.
 */
interface RtcConfigForm {
  CST?: string | null;
  cClassTrib?: string | null;
  pIBSUF?: number | null;
  pIBSMun?: number | null;
  pCBS?: number | null;
}
type ImpostoProdutoWithRtc = ImpostoProduto & { configuracaoIBSCBS?: RtcConfigForm | null };

export interface ImpostoManagerProps {
  produtoId: string | null;
  db: Firestore;
  /** Transient `impostos` form value (null until seeded). */
  value: ImpostoProduto[] | null;
  onChange: (next: ImpostoProduto[]) => void;
  errorTree?: unknown;
  disabled?: boolean;
}

/**
 * Impostos tab (Flutter `ImpostoManager`). One imposto override per active
 * operação, scoped by `impostoOpercaoOuterRef` and saved at
 * `produtos/<id>/imposto/<operacaoId>` ATOMICALLY with the produto doc (the
 * page's `transactionWrites`). This slice edits the **Dados Gerais** fields only;
 * the deep ICMS/IPI/PIS config stays pass-through (NF-e Regime Normal).
 *
 * The user picks an operação, then edits its fiscal fields; the value is held in
 * the form and persisted on save. Seeds the transient field from the loaded
 * imposto subcollection merged with the active operações, re-seeding if
 * ObjectView's produto-doc reset wipes it back to null.
 */
export function ImpostoManager({
  produtoId,
  db,
  value,
  onChange,
  errorTree,
  disabled,
}: ImpostoManagerProps) {
  // Active operações (bounded, name-ordered; `ativo` filtered client-side).
  const operacoesQuery = useMemo(
    () => buildQuery(operacaoCollection.ref(db, {}), [orderByField('nome'), limit(OPERACAO_LIMIT)]),
    [db],
  );
  const operacoesSnap = useSnapshot(operacoesQuery);
  const operacoes: OperacaoRow[] = useMemo(
    () =>
      (operacoesSnap.data ?? [])
        .filter((o) => o.data.ativo !== false)
        .map((o) => ({ id: o.id, nome: o.data.nome, padrao: o.data.padrao === true })),
    [operacoesSnap.data],
  );

  // Existing imposto docs (edit mode), keyed by operação id (= doc id).
  const impostosQuery = useMemo(
    () =>
      produtoId
        ? buildQuery(impostoProdutoCollection.ref(db, { produtoId }), [limit(IMPOSTO_LIMIT)])
        : null,
    [db, produtoId],
  );
  const impostosSnap = useSnapshot(impostosQuery);

  // Seed the transient array once operações (and, in edit mode, the imposto
  // docs) have loaded — one entry per active operação merged with its saved doc.
  useEffect(() => {
    if (value != null) return;
    if (operacoesSnap.loading) return;
    if (produtoId && impostosSnap.loading) return;
    if (operacoes.length === 0) return;
    const byOperacao = new Map<string, ImpostoProduto>();
    for (const d of impostosSnap.data ?? []) {
      const opId = operacaoIdFromImpostoRef(d.data.impostoOpercaoOuterRef);
      // Skip a null-scoped (default-fallback) imposto — it is not a per-operação
      // entry; leaving it out of the form keeps it untouched on save (rather than
      // rewriting its scope to a fake `operacao/<docId>`).
      if (!opId) continue;
      byOperacao.set(opId, { ...d.data, id: d.id, impostoOpercaoOuterRef: `operacao/${opId}` });
    }
    onChange(operacoes.map((op) => byOperacao.get(op.id) ?? emptyImposto(op.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [produtoId, operacoesSnap.loading, impostosSnap.loading, operacoes.length, value]);

  // The picked operação tab (default = padrão, else the first active operação).
  const defaultOperacaoId = useMemo(
    () => operacoes.find((o) => o.padrao)?.id ?? operacoes[0]?.id ?? null,
    [operacoes],
  );
  // Explicit user pick (null until they switch); falls back to the default
  // operação — derived, so no setState-in-effect / cascading render.
  const [pickedId, setPickedId] = useState<string | null>(null);
  const activeId = pickedId ?? defaultOperacaoId;

  const rows = value ?? [];

  if (operacoesSnap.error) {
    return (
      <Text c="red" size="sm">
        Falha ao carregar operações: {operacoesSnap.error.message}
      </Text>
    );
  }
  if (operacoes.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        {operacoesSnap.loading
          ? 'Carregando operações…'
          : 'Cadastre ao menos uma operação para poder cadastrar os impostos do produto.'}
      </Text>
    );
  }

  const activeIndex = rows.findIndex(
    (r) => operacaoIdFromImpostoRef(r.impostoOpercaoOuterRef) === activeId,
  );
  const active = activeIndex >= 0 ? rows[activeIndex] : null;
  const errNode =
    (Array.isArray(errorTree)
      ? (errorTree[activeIndex] as ImpostoErrorNode | undefined)
      : undefined) ?? {};

  const patchActive = (patch: Partial<ImpostoProduto>) => {
    if (!activeId) return;
    const next = [...rows];
    if (activeIndex >= 0 && active) {
      next[activeIndex] = { ...active, ...patch };
    } else {
      // Operação not yet in the array (e.g. added after the seed) — append it.
      next.push({ ...emptyImposto(activeId), ...patch });
    }
    onChange(next);
  };

  const v = active ?? emptyImposto(activeId ?? '');
  const str = (k: keyof ImpostoProduto) => (v[k] as string | null) ?? '';

  // RTC (IBS/CBS/IS) — nested under the active row via passthrough.
  const rtc = (v as ImpostoProdutoWithRtc).configuracaoIBSCBS ?? null;
  const rtcEnabled = rtc != null;
  const patchRtc = (patch: Partial<RtcConfigForm>) =>
    patchActive({ configuracaoIBSCBS: { ...(rtc ?? {}), ...patch } } as Partial<ImpostoProduto>);
  const toggleRtc = (on: boolean) =>
    patchActive({
      configuracaoIBSCBS: on
        ? (rtc ?? { CST: null, cClassTrib: null, pIBSUF: null, pIBSMun: null, pCBS: null })
        : null,
    } as Partial<ImpostoProduto>);

  return (
    <Stack>
      <Select
        label="Operação"
        description="Cada operação fiscal pode ter um imposto específico."
        data={operacoes.map((o) => ({ value: o.id, label: o.nome }))}
        value={activeId}
        onChange={setPickedId}
        allowDeselect={false}
        disabled={disabled}
      />

      <Select
        label="Origem"
        data={ORIGEM_OPTIONS}
        value={str('origem') || null}
        onChange={(val) => patchActive({ origem: val })}
        clearable
        disabled={disabled}
      />
      <TextInput
        label="CFOP"
        value={str('cfop')}
        onChange={(e) => patchActive({ cfop: e.currentTarget.value || null })}
        disabled={disabled}
      />
      <TextInput
        label="CFOP interestadual"
        value={str('cfopInterestadual')}
        onChange={(e) => patchActive({ cfopInterestadual: e.currentTarget.value || null })}
        disabled={disabled}
      />
      <TextInput
        label="NCM"
        description="8 dígitos."
        maxLength={8}
        value={str('NCM')}
        onChange={(e) => patchActive({ NCM: e.currentTarget.value || null })}
        error={errNode.NCM?.message}
        disabled={disabled}
      />
      <TextInput
        label="NVE"
        value={str('NVE')}
        onChange={(e) => patchActive({ NVE: e.currentTarget.value || null })}
        disabled={disabled}
      />
      <TextInput
        label="CEST"
        description="7 dígitos."
        maxLength={7}
        value={str('CEST')}
        onChange={(e) => patchActive({ CEST: e.currentTarget.value || null })}
        error={errNode.CEST?.message}
        disabled={disabled}
      />
      <TextInput
        label="Indicador de escala"
        value={str('indEscala')}
        onChange={(e) => patchActive({ indEscala: e.currentTarget.value || null })}
        disabled={disabled}
      />
      <TextInput
        label="CNPJ do fabricante"
        value={str('CNPJFab')}
        onChange={(e) => patchActive({ CNPJFab: e.currentTarget.value || null })}
        disabled={disabled}
      />
      <TextInput
        label="Código de benefício fiscal (cBenef)"
        value={str('cBenef')}
        onChange={(e) => patchActive({ cBenef: e.currentTarget.value || null })}
        disabled={disabled}
      />
      <TextInput
        label="EX TIPI"
        value={str('extipi')}
        onChange={(e) => patchActive({ extipi: e.currentTarget.value || null })}
        disabled={disabled}
      />
      <TextInput
        label="Unidade tributável"
        value={str('unidade')}
        onChange={(e) => patchActive({ unidade: e.currentTarget.value || null })}
        disabled={disabled}
      />
      <Switch
        label="Compõe o valor total da NF-e"
        checked={v.compoeValorTotalDaNFe === true}
        onChange={(e) => patchActive({ compoeValorTotalDaNFe: e.currentTarget.checked })}
        disabled={disabled}
      />

      <Divider my="xs" label="Reforma Tributária (IBS/CBS/IS)" labelPosition="left" />
      <Text size="xs" c="dimmed">
        NT 2025.002. Só é emitida quando a filial tem a Reforma Tributária ativada (Configurações →
        NF-e). Para o Simples Nacional ainda é facultativa (obrigatória só em 04/01/2027) — teste
        primeiro em homologação. Os códigos (CST / cClassTrib) vêm das tabelas do Portal Nacional.
      </Text>
      <Switch
        label="Configurar IBS/CBS/IS para esta operação"
        checked={rtcEnabled}
        onChange={(e) => toggleRtc(e.currentTarget.checked)}
        disabled={disabled}
      />
      {rtcEnabled && (
        <>
          <TextInput
            label="CST IBS/CBS"
            description="3 dígitos."
            maxLength={3}
            value={rtc?.CST ?? ''}
            onChange={(e) => patchRtc({ CST: e.currentTarget.value || null })}
            disabled={disabled}
          />
          <TextInput
            label="cClassTrib"
            description="6 dígitos (tabela Anexo III)."
            maxLength={6}
            value={rtc?.cClassTrib ?? ''}
            onChange={(e) => patchRtc({ cClassTrib: e.currentTarget.value || null })}
            disabled={disabled}
          />
          <NumberInput
            label="Alíquota IBS UF (%)"
            description="0,1% na fase de teste 2025–2026."
            value={rtc?.pIBSUF ?? ''}
            onChange={(val) => patchRtc({ pIBSUF: typeof val === 'number' ? val : null })}
            min={0}
            decimalScale={4}
            disabled={disabled}
          />
          <NumberInput
            label="Alíquota IBS Município (%)"
            value={rtc?.pIBSMun ?? ''}
            onChange={(val) => patchRtc({ pIBSMun: typeof val === 'number' ? val : null })}
            min={0}
            decimalScale={4}
            disabled={disabled}
          />
          <NumberInput
            label="Alíquota CBS (%)"
            description="0,9% na fase de teste 2025–2026."
            value={rtc?.pCBS ?? ''}
            onChange={(val) => patchRtc({ pCBS: typeof val === 'number' ? val : null })}
            min={0}
            decimalScale={4}
            disabled={disabled}
          />
        </>
      )}
    </Stack>
  );
}
