'use client';

import type { FieldConfig } from '@delfrance/ui';
import { stripMarkedForDeletion } from '@delfrance/ui';
import { filialRefRenderInput } from '@/components/pickers/FilialPicker';
import { EnderecoOrigemInput } from './EnderecoOrigemInput';
import { FaixaCepEditor } from './FaixaCepEditor';
import { HorarioCorteEditor } from './HorarioCorteEditor';
import { SECTION } from './slices';

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
 * - `filialIntegracaoFreteOuterRef` uses the shared optimized `FilialPicker`
 *   emitting the Flutter-ODM doc-path string (`documents/filiais/<id>`) —
 *   the schema types it `z.string()` and the legacy app reads/writes exactly
 *   that format.
 * - `faixaCep` / `horarioDeCorte` use staged-deletion editors (DELETE_MARK →
 *   `stripMarkedForDeletion` at save, CLAUDE.md rule 7), each on its own tab.
 * - `enderecoDeOrigem` is a nullable embedded Endereco behind a Switch, on
 *   its own tab. Unsectioned fields land on the first tab (`SECTION.geral`).
 */
export const intFreteFields: Record<string, FieldConfig> = {
  filialIntegracaoFreteOuterRef: {
    label: 'Filial',
    renderInput: filialRefRenderInput(true, /* emitDocPath */ true),
  },
  faixaCep: {
    section: SECTION.faixasCep,
    renderInput: FaixaCepEditor,
    prepareForSave: stripThenNullIfEmpty,
  },
  horarioDeCorte: {
    section: SECTION.horarios,
    renderInput: HorarioCorteEditor,
    prepareForSave: stripThenNullIfEmpty,
  },
  enderecoDeOrigem: {
    section: SECTION.enderecoOrigem,
    renderInput: EnderecoOrigemInput,
  },
};
