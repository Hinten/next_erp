import {
  INTEGRACAO_TIPO_LABELS,
  type IntegracaoTipo,
  MARKETPLACE_TIPO_CAPS,
  type MarketplaceCapabilities,
} from '@delfrance/schemas';

const LISTA = new Intl.ListFormat('pt-BR', { style: 'long', type: 'conjunction' });

/**
 * The `/canais` Alert's closing clause — which channels are BUILT here — read
 * off `MARKETPLACE_TIPO_CAPS` rather than written out.
 *
 * ⚠️ The sentence this replaces said "hoje só o Mercado Livre está
 * implementado", and it went false at Shopee's step-22 flip (#1530) with no test
 * to notice: a list of channels typed into a page is a second copy of the
 * table, and copies drift toward plausible. Derived, it follows every later
 * flip by itself.
 *
 * Takes the table as an argument (defaulting to the live one) so the plural,
 * the singular and the empty case can be pinned without editing the table.
 */
export function fraseDosCanaisImplementados(
  tabela: Partial<
    Record<IntegracaoTipo, Pick<MarketplaceCapabilities, 'implementado'>>
  > = MARKETPLACE_TIPO_CAPS,
): string {
  const nomes = Object.entries(tabela)
    .filter(([, caps]) => caps?.implementado === true)
    .map(([tipo]) => INTEGRACAO_TIPO_LABELS[Number(tipo) as IntegracaoTipo]);
  if (nomes.length === 0) return 'nenhum está implementado ainda.';
  const rotulo = nomes.length === 1 ? 'implementado hoje' : 'implementados hoje';
  return `${rotulo}: ${LISTA.format(nomes)}.`;
}
