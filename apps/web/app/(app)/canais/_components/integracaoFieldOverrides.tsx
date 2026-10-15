'use client';

import { TextInput } from '@mantine/core';
import { validateCNPJ } from '@delfrance/core/documents';
import type { FieldConfig, FieldRenderProps, ValidationIssue } from '@delfrance/ui';
import { depositoCollection } from '@/lib/data/depositoCollection';
import { listaDePrecosCollection } from '@/lib/data/listaDePrecosCollection';
import { operacaoCollection } from '@/lib/data/operacaoCollection';
import { refRenderInput } from '@/components/collection-select/refRenderInput';
import { filialRefRenderInput } from '@/components/pickers/FilialPicker';
import { CnpjInput } from '@/components/inputs/CnpjInput';
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
    'portfolioId',
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
 * The NF-e intermediador pair: the `<infIntermed>` `CNPJ` and `idCadIntTran`
 * that `buildInfIntermed` (`apps/nfe`) reads off the conta, and throws without,
 * whenever the operação flags `indIntermed = '1'`. Both sit in
 * `integracaoCamposDeSistema` — hidden by default — and a channel form opts in
 * to them with `integracaoExcludedFields(…, …, { intermediador: true })`.
 */
export const CAMPOS_INTERMEDIADOR = ['cpf_cnpj', 'idCadIntTran'] as const;

/** `integracaoSchema.idCadIntTran` is `max(60)`; the input stops typing there. */
export const MAX_ID_CAD_INT_TRAN = 60;

/**
 * The NF-e XSD types `idCadIntTran` as `TString` with `minLength 2`
 * (`leiauteNFe_v4.00.xsd`); `integracaoSchema` carries no minimum, so the
 * form's `validarIntermediador` holds it.
 */
export const MIN_ID_CAD_INT_TRAN = 2;

/**
 * Plain text input for `idCadIntTran`, capped at `MAX_ID_CAD_INT_TRAN`. The
 * default `ObjectView` string input has no length cap, so a 61st character
 * would only surface as a validation error on save; here it is never typed.
 *
 * Keystrokes pass through untouched — trimming on every keystroke would eat
 * the space an operator is typing between two words. The edges are trimmed on
 * SAVE instead, by `aparaIdCadIntTran`.
 */
function IdCadIntTranInput({
  value,
  onChange,
  onBlur,
  error,
  label,
  hint,
  disabled,
}: FieldRenderProps) {
  return (
    <TextInput
      label={label}
      description={hint}
      value={(value as string | null | undefined) ?? ''}
      onChange={(e) => onChange(e.currentTarget.value)}
      onBlur={onBlur}
      error={error}
      disabled={disabled}
      maxLength={MAX_ID_CAD_INT_TRAN}
    />
  );
}

/**
 * `prepareForSave` for `idCadIntTran`: trims the edges, and a value that is
 * blank once trimmed is saved as `null`, never `''`.
 *
 * ⚠️ Not tidiness. The XSD's `TString` pattern refuses leading and trailing
 * whitespace, and the NF-e serializer copies the value verbatim, so an
 * identifier pasted with a trailing space would save cleanly here and only
 * fail at emission, as an XSD error. `ObjectView` applies this before
 * validation as well as before the write, so `validarIntermediador` sees the
 * value that will be stored.
 */
export function aparaIdCadIntTran(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const aparado = v.trim();
  return aparado === '' ? null : aparado;
}

/**
 * The field config for the intermediador pair, for the channel forms that opt
 * in to it. A FACTORY like `integracaoFieldsCompartilhados`, for the same
 * reason: every consumer gets the same `renderInput`, and none can drop it by
 * spreading an override over it.
 *
 * `cpf_cnpj` goes through `CnpjInput`, which stores the cleaned value
 * (`[0-9A-Z]`, uppercase, at most 14 characters) — the shape
 * `integracaoSchema.cpf_cnpj`'s regex accepts for an alphanumeric CNPJ.
 *
 * ⚠️ A form that opts in must ALSO pass `validarIntermediador` as its
 * `ObjectView` `validate`: neither the input nor the schema refuses a value
 * that is not a CNPJ (see there).
 */
export function integracaoFieldsIntermediador(): Record<string, FieldConfig> {
  return {
    cpf_cnpj: { label: 'CNPJ do intermediador', renderInput: CnpjInput },
    idCadIntTran: {
      label: 'Identificador no intermediador',
      renderInput: IdCadIntTranInput,
      prepareForSave: aparaIdCadIntTran,
    },
  };
}

/**
 * The `ObjectView` `validate` for a form that opts in to the intermediador
 * pair. Both fields stay optional — `buildInfIntermed` requires them only when
 * the operação flags `indIntermed = '1'` — but a value that IS filled must be
 * one the NF-e can carry:
 *
 * - `cpf_cnpj` must be a valid CNPJ (`validateCNPJ`: 14 characters,
 *   `[0-9A-Z]{12}` + 2 digits, check digits verified — the alphanumeric CNPJ
 *   included). Neither guard upstream says so: `integracaoSchema.cpf_cnpj`'s
 *   regex accepts ANY run of digits (`\d*`), and `CnpjInput` caps the length
 *   but sets no minimum. So a CNPJ missing one digit, an 11-digit CPF or a
 *   wrong check digit would all save, and `buildInfIntermed` — which checks
 *   only that the value is truthy — would hand it to the XSD's `TCnpj` at
 *   emission.
 * - `idCadIntTran` must have at least `MIN_ID_CAD_INT_TRAN` characters once
 *   trimmed.
 *
 * Form-only on purpose, like `filialFormSchema`'s checksum: the read schema
 * stays tolerant of whatever a migrated conta carries. The trade-off is the
 * same one the filial form accepts — a conta that arrives with an invalid
 * stored CNPJ cannot be saved until the operator corrects it, which is the
 * moment to find out rather than at emission. Pure: values in, issues out.
 */
export function validarIntermediador(values: Record<string, unknown>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const cnpj = values.cpf_cnpj;
  if (typeof cnpj === 'string' && cnpj !== '' && !validateCNPJ(cnpj)) {
    issues.push({
      path: 'cpf_cnpj',
      message: 'CNPJ inválido (14 caracteres; pode conter letras maiúsculas).',
    });
  }
  const id = values.idCadIntTran;
  if (typeof id === 'string') {
    const aparado = id.trim();
    if (aparado !== '' && aparado.length < MIN_ID_CAD_INT_TRAN) {
      issues.push({
        path: 'idCadIntTran',
        message: `O identificador tem no mínimo ${MIN_ID_CAD_INT_TRAN} caracteres.`,
      });
    }
  }
  return issues;
}

/**
 * Never user-pickable on a channel form unless the channel opts in:
 *  - `tipo` is pinned per screen in `defaultValues`.
 *  - `cpf_cnpj`, `idCadIntTran` (`CAMPOS_INTERMEDIADOR`) stay out unless the
 *    form passes `{ intermediador: true }` to `integracaoExcludedFields`. Amazon
 *    is the first consumer (master plan step 21-conta): the migrated conta
 *    carries both, and its NF-e needs them.
 *  - `modalidadeFreteImportacao` stays out until the milestone that consumes it
 *    surfaces it (no channel opts in to it).
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

/** Opt-ins on top of the default exclusion list. */
export interface ExclusaoIntegracaoOpts {
  /**
   * Keep `CAMPOS_INTERMEDIADOR` on the form. Only those two: every other
   * system field, `modalidadeFreteImportacao` included, stays excluded.
   */
  readonly intermediador?: boolean;
}

/**
 * The exclusion list for one channel's form: the system stamps, every OTHER
 * channel's account fields, and whatever `extra` the channel hides of its own
 * (Mercado Livre hides `user_id` — a `serverOwnedFields` routing key stamped by
 * the OAuth exchange; WhatsApp hides `verificado` — set server-side by the
 * Cloud API verification flow).
 *
 * `dono: null` means "owns no per-channel field" (Balcão), so every channel's
 * fields are excluded. `opts.intermediador` keeps the intermediador pair
 * visible; `extra` is applied last, so it can still hide either of them.
 *
 * The result is de-duplicated; order carries no meaning — `ObjectView` filters
 * with `.includes`.
 */
export function integracaoExcludedFields(
  dono: CanalComCampos | null,
  extra: readonly string[] = [],
  opts: ExclusaoIntegracaoOpts = {},
): string[] {
  const visiveis = new Set<string>(opts.intermediador === true ? CAMPOS_INTERMEDIADOR : []);
  const excluidos = new Set<string>(integracaoCamposDeSistema.filter((c) => !visiveis.has(c)));
  for (const [canal, campos] of Object.entries(CAMPOS_POR_CANAL)) {
    if (canal === dono) continue;
    for (const campo of campos) excluidos.add(campo);
  }
  for (const campo of extra) excluidos.add(campo);
  return [...excluidos];
}
