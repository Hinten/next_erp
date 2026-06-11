'use client';

import type { FieldConfig } from '@delfrance/ui';
import { stripMarkedForDeletion } from '@delfrance/ui';
import { filialCollection } from '@/lib/data/filialCollection';
import { refRenderInput } from '@/components/collection-select/refRenderInput';
import { EnderecoOrigemInput } from './EnderecoOrigemInput';
import { FaixaCepEditor } from './FaixaCepEditor';
import { HorarioCorteEditor } from './HorarioCorteEditor';

/**
 * Drop staged-deletion marks, then collapse an emptied list to `null` — the
 * shape Flutter writes when a list is unset (its `fromJson` helpers accept
 * both, but `null` keeps new docs closest to legacy ones).
 */
function stripThenNullIfEmpty(value: unknown): unknown {
  const stripped = stripMarkedForDeletion(value);
  return Array.isArray(stripped) && stripped.length === 0 ? null : stripped;
}

/**
 * `fields` overrides shared by every `/logistica/*` create + edit ObjectView.
 *
 * - `filialIntegracaoFreteOuterRef` emits the Flutter-ODM doc-path string
 *   (`documents/filiais/<id>`) — the schema types it `z.string()` and the
 *   legacy app reads/writes exactly that format.
 * - `faixaCep` / `horarioDeCorte` use staged-deletion editors (DELETE_MARK →
 *   `stripMarkedForDeletion` at save, CLAUDE.md rule 7).
 * - `enderecoDeOrigem` is a nullable embedded Endereco behind a Switch.
 */
export const intFreteFields: Record<string, FieldConfig> = {
  filialIntegracaoFreteOuterRef: {
    label: 'Filial',
    // `filial` has no `nome` — display + ordering use `razaoSocial`.
    renderInput: refRenderInput(
      filialCollection,
      true,
      'razaoSocial',
      ['razaoSocial', 'fantasia', 'cnpj'],
      true,
    ),
  },
  faixaCep: {
    renderInput: FaixaCepEditor,
    prepareForSave: stripThenNullIfEmpty,
  },
  horarioDeCorte: {
    renderInput: HorarioCorteEditor,
    prepareForSave: stripThenNullIfEmpty,
  },
  enderecoDeOrigem: {
    renderInput: EnderecoOrigemInput,
  },
};
