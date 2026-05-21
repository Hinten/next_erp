'use client';

import { ColorInput } from '@mantine/core';
import type { ZodObject, ZodRawShape } from 'zod';
import { type CollectionHandle } from '@delfrance/data';
import type { FieldConfig, FieldRenderProps } from '@delfrance/ui';
import { depositoCollection } from '@/lib/data/depositoCollection';
import { filialCollection } from '@/lib/data/filialCollection';
import { listaDePrecosCollection } from '@/lib/data/listaDePrecosCollection';
import { operacaoCollection } from '@/lib/data/operacaoCollection';
import { CollectionSelect } from './CollectionSelect';

/**
 * Wrap a collection in a `renderInput` that the schema-driven ObjectView can
 * mount. `required` only controls the Mantine asterisk + clearable flag — the
 * actual gate on save is the Firestore client rejecting `undefined` for the
 * mandatory `z.unknown()` refs in `integracaoSchema`.
 */
function refRenderInput<S extends ZodObject<ZodRawShape>>(
  collection: CollectionHandle<S>,
  required: boolean,
  labelField: string = 'nome',
): FieldConfig['renderInput'] {
  function RefInput(props: FieldRenderProps) {
    return (
      <CollectionSelect
        collection={collection}
        labelField={labelField}
        label={props.label}
        hint={props.hint}
        value={props.value}
        onChange={props.onChange}
        onBlur={props.onBlur}
        disabled={props.disabled}
        error={props.error}
        required={required}
      />
    );
  }
  return RefInput;
}

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
  const full = body.length === 3
    ? body.split('').map((c) => c + c).join('')
    : body;
  return Number.parseInt(full, 16);
}

function CorInput({
  value,
  onChange,
  onBlur,
  label,
  hint,
  disabled,
  error,
}: FieldRenderProps) {
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
    // `filial` has no `nome` field — Firestore's orderBy would drop every
    // doc if we asked for `nome` here, leaving an empty dropdown.
    renderInput: refRenderInput(filialCollection, true, 'razaoSocial'),
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
