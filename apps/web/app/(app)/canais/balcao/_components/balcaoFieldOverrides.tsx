'use client';

import { ColorInput } from '@mantine/core';
import type { FieldConfig, FieldRenderProps } from '@delfrance/ui';
import { depositoCollection } from '@/lib/data/depositoCollection';
import { listaDePrecosCollection } from '@/lib/data/listaDePrecosCollection';
import { operacaoCollection } from '@/lib/data/operacaoCollection';
import { refRenderInput } from '@/components/collection-select/refRenderInput';
import { filialRefRenderInput } from '@/components/pickers/FilialPicker';

/** RGB int (`0xRRGGBB`) → `#rrggbb`. */
function intToHex(value: number): string {
  const clamped = Math.max(0, Math.min(0xffffff, Math.trunc(value)));
  return `#${clamped.toString(16).padStart(6, '0')}`;
}

/** `#rrggbb` (or `#rgb`) → RGB int. Anything else → null. */
function hexToInt(hex: string): number | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  const body = m?.[1];
  if (!body) return null;
  const full =
    body.length === 3
      ? body
          .split('')
          .map((c) => c + c)
          .join('')
      : body;
  return Number.parseInt(full, 16);
}

function CorInput({ value, onChange, onBlur, label, hint, disabled, error }: FieldRenderProps) {
  const hex = typeof value === 'number' ? intToHex(value) : '';
  return (
    <ColorInput
      label={label}
      description={hint ?? 'Cor de destaque para identificar o canal.'}
      value={hex}
      onChange={(next) => {
        if (!next) {
          onChange(null);
          return;
        }
        const int = hexToInt(next);
        onChange(int);
      }}
      onBlur={onBlur}
      disabled={disabled}
      error={error}
      format="hex"
    />
  );
}

/**
 * The four outer-ref selectors + the `cor` color picker shared by the
 * Balcão create and edit screens.
 */
export const balcaoFields: Record<string, FieldConfig> = {
  filialIntegracaoPedidoOuterRef: {
    label: 'Filial',
    // Shared optimized picker (5 most-recent + regex search); emits the
    // `documents/filiais/<id>` doc-path string like every other outer ref.
    renderInput: filialRefRenderInput(true),
  },
  tabelaNormalOuterRef: {
    label: 'Tabela de preços',
    renderInput: refRenderInput(listaDePrecosCollection, true),
  },
  tabelaPromocionalOuterRef: {
    label: 'Tabela promocional',
    renderInput: refRenderInput(listaDePrecosCollection, false),
  },
  operacaoOuterRef: {
    label: 'Operação fiscal',
    renderInput: refRenderInput(operacaoCollection, false),
  },
  operacaoDevolucaoOuterRef: {
    label: 'Operação de devolução',
    renderInput: refRenderInput(operacaoCollection, false),
  },
  depositoOuterRef: {
    label: 'Depósito',
    renderInput: refRenderInput(depositoCollection, true),
  },
  cor: { renderInput: CorInput },
  nome: { label: 'Nome' },
  ativo: { label: 'Ativo' },
  padrao: { label: 'Padrão' },
};

/**
 * Fields hidden from the Balcão form:
 *  - `tipo` is pinned to 7 (balcao) in defaultValues — never user-pickable.
 *  - `cpf_cnpj`, `idCadIntTran`, `modalidadeFreteImportacao` are marketplace-
 *    oriented and irrelevant for a counter register.
 *  - `dataCadastro` is stamped automatically on create.
 */
export const balcaoExcludedFields = [
  'tipo',
  'cpf_cnpj',
  'idCadIntTran',
  'modalidadeFreteImportacao',
  'dataCadastro',
];
