'use client';

import type { FieldConfig } from '@delfrance/ui';
import { stripMarkedForDeletion } from '@delfrance/ui';
import { enderecoNestedFields } from '@/components/inputs/enderecoFields';
import { filialRefRenderInput } from '@/components/pickers/FilialPicker';
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
 * Freight origin reuses the shared embedded-endereço field config but
 * **re-exposes** `telefone` + `email`: Melhor Envio requires `from.phone` for
 * some carriers (e.g. Jadlog), so the origin address must let the operator set
 * them (they stay hidden on the cliente + filial `sede` forms).
 */
const enderecoOrigemFields: Record<string, FieldConfig> = {
  ...enderecoNestedFields,
  telefone: { label: 'Telefone' },
  email: { label: 'E-mail' },
};

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
 *   its own tab — rendered by ObjectView's native nullable-object support
 *   (the same schema-driven path as the address modal and filial `sede`),
 *   reusing the shared `enderecoNestedFields` (hidden recebedor/system fields +
 *   the CEP ViaCEP lookup) and seeding Brazil when the Switch is turned on.
 *   Unsectioned fields land on the first tab (`SECTION.geral`).
 */
export const intFreteFields: Record<string, FieldConfig> = {
  filialIntegracaoFreteOuterRef: {
    label: 'Filial',
    renderInput: filialRefRenderInput(true),
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
    label: 'Informar endereço de origem',
    hint: 'Desligado: a origem dos envios é a sede da filial.',
    // NFe origin is domestic: country code 1058 / Brasil. `estado` is a
    // required enum with no schema default — preselect SP so the Switch-on
    // form opens valid (the user can change it).
    defaultValue: { cPais: '1058', pais: 'Brasil', estado: 'SP' },
    fields: enderecoOrigemFields,
  },
};
