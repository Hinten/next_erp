'use client';

import type { FieldConfig } from '@delfrance/ui';
import { depositoCollection } from '@/lib/data/depositoCollection';
import { listaDePrecosCollection } from '@/lib/data/listaDePrecosCollection';
import { operacaoCollection } from '@/lib/data/operacaoCollection';
import { refRenderInput } from '@/components/collection-select/refRenderInput';
import { filialRefRenderInput } from '@/components/pickers/FilialPicker';
import { CorInput } from '@/components/inputs/CorInput';

/**
 * The `integracao` field config every channel screen shares — the six outer-ref
 * pickers plus `cor`/`nome`/`ativo`/`padrao` — and the exclusion-list algebra
 * that hides the OTHER channels' flat account fields.
 *
 * Before this module the same block was copied into `balcaoFieldOverrides`,
 * `mercadoLivreFieldOverrides` and `whatsappFieldOverrides`, each carrying a
 * comment asserting what the other two did ("Mirrors the Balcão overrides.",
 * "mirrors `balcaoFields`/`mercadoLivreFields`") — the smell the root
 * `CLAUDE.md` names: reviewers cannot diff three files by eye, the copies drift
 * toward plausible, and a new per-channel field has to be remembered in four
 * places at once. The totality test in `integracaoFieldOverrides.test.ts` is
 * what makes forgetting it fail CI instead of leaking a raw number input into
 * every other channel's form.
 *
 * ⚠️ This is a FACTORY, not a base object callers spread and override. A
 * spread-and-override would let a consumer replace `filialIntegracaoPedidoOuterRef`
 * with `{ label, hint }` and silently drop its `renderInput`, turning an
 * optimized picker back into a raw text input — the exact failure the shared
 * module exists to prevent. Per-channel wording is a PARAMETER instead.
 */

/** Grammatical gender of a channel name — picks `do`/`ao` vs `da`/`à`. */
export type GeneroCanal = 'm' | 'f';

export interface CamposCompartilhadosOpts {
  /**
   * Channel name for the two order/stock hints ("Filial dos pedidos importados
   * do Mercado Livre."). Omitted → those fields render with no hint, which is
   * what Balcão and WhatsApp do today.
   */
  readonly canal?: string;
  /**
   * Grammatical gender of `canal`, so the hints contract correctly:
   * `'m'` → "do Mercado Livre" / "ao Mercado Livre";
   * `'f'` → "da Shopee" / "à Shopee". Defaults to `'m'`.
   */
  readonly generoCanal?: GeneroCanal;
  /** `ObjectView` section/tab these fields belong to (WhatsApp's `'Geral'`). */
  readonly section?: string;
}

/**
 * The shared block. Every consumer gets the SAME `renderInput` per field; only
 * the hints (via `canal`) and the tab (via `section`) vary.
 */
export function integracaoFieldsCompartilhados(
  opts: CamposCompartilhadosOpts = {},
): Record<string, FieldConfig> {
  const { canal, generoCanal = 'm', section } = opts;
  const de = generoCanal === 'f' ? 'da' : 'do';
  const ao = generoCanal === 'f' ? 'à' : 'ao';

  // `section: undefined` would be a key present with an undefined value, which
  // `ObjectView` reads as "no section" all the same — but spreading keeps the
  // objects shaped exactly like the hand-written ones they replace.
  const secao = section === undefined ? {} : { section };

  return {
    filialIntegracaoPedidoOuterRef: {
      label: 'Filial',
      ...secao,
      // Shared optimized picker (5 most-recent + regex search); emits the
      // `documents/filiais/<id>` doc-path string like every other outer ref.
      renderInput: filialRefRenderInput(true),
      ...(canal === undefined ? {} : { hint: `Filial dos pedidos importados ${de} ${canal}.` }),
    },
    tabelaNormalOuterRef: {
      label: 'Tabela de preços',
      ...secao,
      renderInput: refRenderInput(listaDePrecosCollection, true),
    },
    tabelaPromocionalOuterRef: {
      label: 'Tabela promocional',
      ...secao,
      renderInput: refRenderInput(listaDePrecosCollection, false),
    },
    operacaoOuterRef: {
      label: 'Operação fiscal',
      ...secao,
      renderInput: refRenderInput(operacaoCollection, false),
    },
    operacaoDevolucaoOuterRef: {
      label: 'Operação de devolução',
      ...secao,
      renderInput: refRenderInput(operacaoCollection, false),
    },
    depositoOuterRef: {
      label: 'Depósito',
      ...secao,
      renderInput: refRenderInput(depositoCollection, true),
      ...(canal === undefined
        ? {}
        : { hint: `Depósito de onde o estoque é enviado ${ao} ${canal}.` }),
    },
    // Surfaced now that the colour is READ somewhere: /produtos paints one badge
    // per canal de venda with it. While this field stayed excluded, every ML
    // conta had `cor = null` and rendered neutral grey — and ML is the channel
    // most produtos are listed on, so the column's colour said nothing.
    //
    // ⚠️ The hint rides on `canal` rather than being unconditional: Balcão and
    // WhatsApp render `cor` with NO hint today, and PR A must not change a
    // shipped screen. A channel that names itself gets it (Mercado Livre today,
    // Shopee next).
    cor: {
      ...secao,
      renderInput: CorInput,
      ...(canal === undefined
        ? {}
        : {
            hint: 'Cor de destaque do canal — usada nos badges de "Canais de venda" em /produtos.',
          }),
    },
    nome: { label: 'Nome', ...secao },
    ativo: { label: 'Ativo', ...secao },
    padrao: { label: 'Padrão', ...secao },
  };
}

/**
 * The flat per-channel account fields on `integracaoSchema` (parity audit
 * #289), grouped by the channel that owns them. A channel screen shows its OWN
 * entries (or hides them deliberately, via `extra`) and hides everyone else's:
 * left visible, they render as raw number/text inputs on a form that has no
 * business writing them.
 *
 * ⚠️ Adding a field here is only half the job — it must also exist on
 * `integracaoSchema`, and the totality test enumerates that shape, so a new
 * per-channel field that is registered NOWHERE reds CI instead of leaking into
 * every channel's form.
 */
export const CAMPOS_POR_CANAL = {
  mercadoLivre: ['user_id', 'modoEnvioMercadoLivre'],
  shopee: ['shop_id', 'main_account_id', 'tabelasAtacado'],
  amazon: ['selling_partner_id'],
  magalu: ['tenant_id'],
  whatsapp: [
    'wa_id',
    'waba_id',
    'phoneNumberId',
    'numero',
    'verificado',
    'mensagem_automatica',
    'mensagem_inatividade',
    'horario_funcionamento',
  ],
} as const satisfies Record<string, readonly string[]>;

export type CanalComCampos = keyof typeof CAMPOS_POR_CANAL;

/**
 * Never user-pickable on any channel form:
 *  - `tipo` is pinned per screen in `defaultValues`.
 *  - `cpf_cnpj`, `idCadIntTran`, `modalidadeFreteImportacao` stay out until the
 *    milestone that consumes them surfaces them.
 *  - `dataCadastro` / `ultimaModificacao` are stamped by `saveRecord`.
 */
export const integracaoCamposDeSistema: readonly string[] = [
  'tipo',
  'cpf_cnpj',
  'idCadIntTran',
  'modalidadeFreteImportacao',
  'dataCadastro',
  'ultimaModificacao',
];

/**
 * The exclusion list for one channel's form: the system stamps, every OTHER
 * channel's account fields, and whatever `extra` the channel hides of its own
 * (Mercado Livre hides `user_id` — a `serverOwnedFields` routing key stamped by
 * the OAuth exchange; WhatsApp hides `verificado` — set server-side by the
 * Cloud API verification flow).
 *
 * `dono: null` means "owns no per-channel field" (Balcão), so every channel's
 * fields are excluded.
 *
 * The result is de-duplicated; order carries no meaning (`ObjectView` and
 * `TableView` both consume it through `includes`).
 */
export function integracaoExcludedFields(
  dono: CanalComCampos | null,
  extra: readonly string[] = [],
): string[] {
  const excluidos = new Set<string>(integracaoCamposDeSistema);
  for (const [canal, campos] of Object.entries(CAMPOS_POR_CANAL)) {
    if (canal === dono) continue;
    for (const campo of campos) excluidos.add(campo);
  }
  for (const campo of extra) excluidos.add(campo);
  return [...excluidos];
}
