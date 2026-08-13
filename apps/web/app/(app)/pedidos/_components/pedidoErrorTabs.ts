/**
 * Field → tab routing + invalid-submit summary for the custom PedidoForm.
 *
 * PedidoForm is a bespoke (non-ObjectView) tabbed form, so it can't lean on
 * ObjectView's section/error plumbing. This module is the small, pure
 * equivalent: it maps a top-level react-hook-form error key to the tab that
 * owns the field, and turns a set of error keys into the same red-toast
 * wording ObjectView shows (`packages/ui/src/object/ObjectView.tsx`), so the
 * two forms read identically to users.
 */

/**
 * Pedido form tabs in display order. `value` is the Mantine tab value;
 * `label` is what the user sees (and what the toast names).
 */
export const PEDIDO_TABS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'principal', label: 'Principal' },
  { value: 'fiscal', label: 'Fiscal' },
  { value: 'frete', label: 'Frete' },
  { value: 'pagamento', label: 'Pagamento' },
  { value: 'link-pgto', label: 'Link Pgto' },
  { value: 'incidentes', label: 'Incidentes' },
  { value: 'devolucao', label: 'Devolução' },
  { value: 'checkout', label: 'Checkout' },
  { value: 'estado', label: 'Estado/Histórico' },
];

/**
 * Saída-only tabs — hidden on an entrada (inbound order): payment links,
 * incidents, returns and the dispatch checkout are sale-side flows the legacy
 * app never showed for an entrada.
 */
const SAIDA_ONLY_TABS: ReadonlyArray<string> = ['link-pgto', 'incidentes', 'devolucao', 'checkout'];

/**
 * Visible pedido-form tab values in display order for the given direction.
 * `estoque` (read-only, outside the error routing in PEDIDO_TABS) renders
 * last for both directions. PedidoForm drives both `Tabs.Tab` and
 * `Tabs.Panel` rendering from this list.
 */
export function pedidoTabs(isEntrada: boolean): string[] {
  const all = [...PEDIDO_TABS.map((t) => t.value), 'estoque'];
  if (!isEntrada) return all;
  return all.filter((value) => !SAIDA_ONLY_TABS.includes(value));
}

/**
 * Top-level RHF error key → tab value. RHF nests sub-field errors under the
 * top-level key, so this granularity is enough to route a tab marker.
 *
 * `pedidoResolver` regroups `_itensFlat` into `itens` before Zod runs, so item
 * validation errors land under `itens`; the synthetic "no items" error is
 * attached to `_itensFlat`. Both belong to the Principal tab.
 */
export const TAB_OF_FIELD: Readonly<Record<string, string>> = {
  // Principal
  ehSaida: 'principal',
  clientePedidoOuterRef: 'principal',
  operacaoPedidoOuterRef: 'principal',
  integracaoPedidoOuterRef: 'principal',
  listaDePrecosOuterRef: 'principal',
  vendedorPedidoOuterRef: 'principal',
  itens: 'principal',
  _itensFlat: 'principal',
  itensIds: 'principal',
  descontoTotal: 'principal',
  observacoesInternas: 'principal',
  valorCobrado: 'principal',
  valorCusto: 'principal',
  // Fiscal
  enderecoFiscalOuterRef: 'fiscal',
  infCpl: 'fiscal',
  bloquearEmissaoNFe: 'fiscal',
  chNFeReferenciadas: 'fiscal',
  // Frete
  freteInicial: 'frete',
  valorFreteInicial: 'frete',
  custoFreteInicial: 'frete',
  // Preview-only fields rendered read-only in their tabs via PlaceholderTab —
  // map them so a stray validation error marks the right tab instead of being
  // reported as "fora do formulário".
  estado: 'estado',
  itensDevolvidos: 'devolucao',
};

export interface PedidoErrorSummary {
  /** Tab values (e.g. `'principal'`) that contain at least one invalid field. */
  errorTabValues: Set<string>;
  /** First erroring tab in display order; `undefined` when all errors are out-of-form. */
  firstTab: string | undefined;
  /** Error keys with no tab mapping (validated but not rendered in any tab). */
  outsideKeys: string[];
  /** Red-toast message, mirroring ObjectView's invalid-submit wording. */
  message: string;
}

const LABEL_OF_TAB: Readonly<Record<string, string>> = Object.fromEntries(
  PEDIDO_TABS.map((t) => [t.value, t.label]),
);

/**
 * Summarize a set of RHF error keys into the erroring tabs (display order),
 * the first one to jump to, any out-of-form keys, and the user-facing toast
 * message — identical wording to ObjectView's invalid-submit handler so both
 * forms read the same.
 */
export function summarizePedidoErrors(errorKeys: string[]): PedidoErrorSummary {
  const present = new Set<string>();
  for (const key of errorKeys) {
    const tab = TAB_OF_FIELD[key];
    if (tab) present.add(tab);
  }
  // Erroring tabs in display order; out-of-form keys named separately.
  const erroringValues = PEDIDO_TABS.map((t) => t.value).filter((v) => present.has(v));
  const errorTabValues = new Set(erroringValues);
  const outsideKeys = errorKeys.filter((k) => !(k in TAB_OF_FIELD));
  const firstTab = erroringValues[0];

  const outsidePart =
    outsideKeys.length > 0 ? `campos inválidos fora do formulário (${outsideKeys.join(', ')})` : '';

  if (firstTab === undefined) {
    return {
      errorTabValues,
      firstTab,
      outsideKeys,
      message: `Não foi possível salvar: ${outsidePart || 'campos inválidos'}.`,
    };
  }

  const labels = erroringValues.map((v) => LABEL_OF_TAB[v]);
  const inTabs =
    labels.length === 1
      ? `Corrija os campos inválidos na aba "${labels[0]}".`
      : `Corrija os campos inválidos nas abas: ${labels.join(', ')}.`;

  return {
    errorTabValues,
    firstTab,
    outsideKeys,
    message: outsideKeys.length > 0 ? `${inTabs} Há também ${outsidePart}.` : inTabs,
  };
}
