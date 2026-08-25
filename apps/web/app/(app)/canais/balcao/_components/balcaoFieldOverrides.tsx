'use client';

import type { FieldConfig } from '@delfrance/ui';
import { depositoCollection } from '@/lib/data/depositoCollection';
import { listaDePrecosCollection } from '@/lib/data/listaDePrecosCollection';
import { operacaoCollection } from '@/lib/data/operacaoCollection';
import { refRenderInput } from '@/components/collection-select/refRenderInput';
import { filialRefRenderInput } from '@/components/pickers/FilialPicker';
import { CorInput } from '@/components/inputs/CorInput';

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
 *  - the per-channel account fields below (#289) are irrelevant to a counter
 *    register — see each field's own comment.
 */
export const balcaoExcludedFields = [
  'tipo',
  'cpf_cnpj',
  'idCadIntTran',
  'modalidadeFreteImportacao',
  'dataCadastro',
  'ultimaModificacao',
  'user_id', // latent leak (rendered as a raw number input) — per-channel field, hidden here, surfaced by their own channel screens/flows
  'shop_id', // per-channel fields — hidden here, surfaced by their own channel screens/flows
  'main_account_id', // per-channel fields — hidden here, surfaced by their own channel screens/flows
  'tabelasAtacado', // per-channel fields — hidden here, surfaced by their own channel screens/flows
  'selling_partner_id', // per-channel fields — hidden here, surfaced by their own channel screens/flows
  'tenant_id', // per-channel fields — hidden here, surfaced by their own channel screens/flows
  'wa_id', // WhatsApp field (#528) — hidden here, surfaced by its own channel screen
  'waba_id', // WhatsApp field — hidden here, surfaced by its own channel screen
  'phoneNumberId', // WhatsApp field (#528) — hidden here, surfaced by its own channel screen
  'numero', // WhatsApp field (#528) — hidden here, surfaced by its own channel screen
  'verificado', // WhatsApp field (#528) — hidden here, surfaced by its own channel screen
  'mensagem_automatica', // WhatsApp field (#528) — hidden here, surfaced by its own channel screen
  'mensagem_inatividade', // WhatsApp field (#528) — hidden here, surfaced by its own channel screen
  'horario_funcionamento', // WhatsApp field (#528) — hidden here, surfaced by its own channel screen
];
