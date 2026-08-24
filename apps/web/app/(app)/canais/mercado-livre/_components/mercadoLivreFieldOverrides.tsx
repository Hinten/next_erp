'use client';

import type { FieldConfig } from '@delfrance/ui';
import { depositoCollection } from '@/lib/data/depositoCollection';
import { listaDePrecosCollection } from '@/lib/data/listaDePrecosCollection';
import { operacaoCollection } from '@/lib/data/operacaoCollection';
import { refRenderInput } from '@/components/collection-select/refRenderInput';
import { filialRefRenderInput } from '@/components/pickers/FilialPicker';

/**
 * Field config shared by the Mercado Livre create and edit screens — the
 * shared `integracao` outer-ref selectors the later ML milestones consume:
 * filial + operações (order import), tabelas de preço (price sync) and
 * depósito (stock push). Mirrors the Balcão overrides.
 */
export const mercadoLivreFields: Record<string, FieldConfig> = {
  filialIntegracaoPedidoOuterRef: {
    label: 'Filial',
    hint: 'Filial dos pedidos importados do Mercado Livre.',
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
    hint: 'Depósito de onde o estoque é enviado ao Mercado Livre.',
    renderInput: refRenderInput(depositoCollection, true),
  },
  modoEnvioMercadoLivre: {
    label: 'Modo de envio',
    hint: 'Enviado em toda publicação e republicação desta conta. Vazio: não enviar o modo — o Mercado Livre aplica o padrão da conta.',
  },
  nome: { label: 'Nome' },
  ativo: { label: 'Ativo' },
  padrao: { label: 'Padrão' },
};

/**
 * Fields hidden from the Mercado Livre form:
 *  - `tipo` is pinned to 1 (mercadoLivre) in defaultValues — never user-pickable.
 *  - `cpf_cnpj`, `idCadIntTran`, `modalidadeFreteImportacao`, `cor` stay out of
 *    this first slice (surfaced later by the milestone that consumes them).
 *  - `dataCadastro` is stamped automatically on create.
 *  - the per-channel account fields below (#289) are irrelevant here too —
 *    even `user_id`, which IS this channel's own field, is stamped by the
 *    OAuth connect flow, not hand-edited — see each field's own comment.
 */
export const mercadoLivreExcludedFields = [
  'tipo',
  'cpf_cnpj',
  'idCadIntTran',
  'modalidadeFreteImportacao',
  'cor',
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
