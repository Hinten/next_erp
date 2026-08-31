/**
 * What the produto's tabela de medidas would bind on this anúncio — and where
 * it disagrees with it.
 *
 * ⚠️ **This exists because the three values that decide a size-chart binding
 * were invisible on the produto's Mercado Livre tab** (#1087). A publish whose
 * tabela sat in `MLB-SHIRTS` while the category asked for `MLB-T_SHIRTS` was
 * simply sent without `SIZE_GRID_ID`, and Mercado Livre answered
 * `Attribute [SIZE_GRID_ID] is missing` — a message naming neither domain,
 * though the ERP held both. The operator had nothing to compare.
 *
 * ⚠️ **Showing the three values is not enough on its own; each is shown AGAINST
 * the anúncio's**, because that comparison is the whole of what
 * `resolveSizeChart` does:
 *
 *  1. `domain_id === catalog_domain` is a hard filter — a miss binds nothing;
 *  2. `BRAND` / `GENDER` are the attributes the scoring loop counts hits over
 *     against the link doc's own attributes, so a guia in the RIGHT domain whose
 *     gênero disagrees still binds nothing, and that failure is just as silent.
 *
 * ⚠️ **The DECISION is imported, not re-implemented.** `resolveSizeChart` comes
 * from `@delfrance/schemas` and publish calls that same function, so the
 * `vincula` badge and the warning are literally the answer publish will reach.
 * What lives here is only the per-attribute DISPLAY layer over it — which guia
 * cell earns a ✓ — because the server has no reason to compute that.
 *
 * ⚠️ This module used to hold a hand-written copy and call itself a
 * "line-for-line mirror" of the server's, which is the exact phrase the root
 * `CLAUDE.md` names as the smell. It had drifted twice by the time anyone
 * checked: `bate()` short-circuited on `value_id` where the resolver ORs (a red
 * ✗ on a row this same module labelled *vincula*), and the first-candidate
 * fallback keyed on the FILTERED attribute list where the resolver keys on the
 * RAW one (a green *vincula* on a pair publish refuses). Do not reintroduce a
 * local copy of any of it.
 */
import { type MlSizeChart, type SizeChartResolution, resolveSizeChart } from '@delfrance/schemas';

/** The attribute ids ML asks a fashion chart to carry, in display order. */
export const GUIA_ATRIBUTOS = ['BRAND', 'GENDER'] as const;
export type GuiaAtributoId = (typeof GUIA_ATRIBUTOS)[number];

/** One side of a comparison — the chart's, or the anúncio's. */
export interface AtributoValor {
  id?: string;
  value_id?: string | null;
  value_name?: string | null;
}

/** `null` = not comparable, which is NOT the same as "they differ". */
export type Verdito = boolean | null;

export interface GuiaAvaliada {
  /** The ML chart id — `null` when the guia was never sent. */
  chartId: string | null;
  nome: string | null;
  dominio: string | null;
  /** Display value per attribute (`value_name`), `null` when the guia has none. */
  valores: Record<GuiaAtributoId, string | null>;
  /** Per-attribute verdict against the anúncio. `null` = one side has no value. */
  veredito: Record<GuiaAtributoId, Verdito>;
  dominioOk: Verdito;
  /** False when the guia carries no ML id — it cannot bind whatever else agrees. */
  enviada: boolean;
  /** True for the ONE guia publish would actually bind. */
  vincula: boolean;
}

export interface AnuncioLado {
  dominio: string | null;
  valores: Record<GuiaAtributoId, string | null>;
}

export interface AvaliacaoTabela {
  guias: GuiaAvaliada[];
  anuncio: AnuncioLado;
  /** The guia that binds, or `null` — the same answer the server reaches. */
  vinculada: GuiaAvaliada | null;
  /**
   * WHY, straight from the resolver — the same discriminant publish refuses on.
   *
   * ⚠️ Carried out rather than re-derived. The warning below used to work out
   * "is this a domain divergence?" from the guias, with hand-copies of two
   * server guards; one of those copies was wrong on the server first and the
   * copy inherited it.
   */
  resolucao: SizeChartResolution;
}

function limpar(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function acharAtributo(
  attrs: readonly AtributoValor[] | null | undefined,
  id: GuiaAtributoId,
): AtributoValor | null {
  return (attrs ?? []).find((a) => a.id === id) ?? null;
}

/**
 * Does a chart attribute HIT an anúncio attribute?
 *
 * ⚠️ **An OR, not an if/else-if** — the scoring rule inside `resolveSizeChart`,
 * which decides the badge. A matching `value_name` counts as a hit *even when
 * the `value_id`s disagree*, so short-circuiting on ids once both sides carry
 * one renders a red ✗ on a row this same file simultaneously labels
 * **vincula**: the cell and the badge describing one decision and disagreeing.
 * The resolver binds it, so the ✗ was the wrong half.
 *
 * ⚠️ This is the ONE place the rule is restated, and only because a per-cell
 * verdict is a different question from "which guia wins" — the resolver answers
 * the second and never the first. `NO cell may contradict the badge beside it`
 * in the test file is what keeps the restatement honest.
 */
function bate(chart: AtributoValor | null, anuncio: AtributoValor | null): Verdito {
  if (chart == null || anuncio == null) return null;
  const porId = anuncio.value_id != null && chart.value_id === anuncio.value_id;
  const porNome = anuncio.value_name != null && chart.value_name === anuncio.value_name;
  if (porId || porNome) return true;
  // No verdict unless the two are actually comparable on some field: an
  // attribute nobody filled in cannot score, and reporting `false` would blame
  // it for a miss it had no part in.
  const comparavel =
    (anuncio.value_id != null && chart.value_id != null) ||
    (anuncio.value_name != null && chart.value_name != null);
  return comparavel ? false : null;
}

/**
 * Evaluate every guia of this tabela against this anúncio.
 *
 * `catalogDomain` is the category's `settings.catalog_domain`; `linkAttributes`
 * are the anúncio's own stored attributes. Both may be null while their queries
 * are in flight — the caller decides whether it has enough to render.
 */
export function avaliarTabela(
  charts: readonly MlSizeChart[],
  catalogDomain: string | null,
  linkAttributes: readonly AtributoValor[] | null,
): AvaliacaoTabela {
  const attrs = linkAttributes ?? [];

  const anuncio: AnuncioLado = {
    dominio: limpar(catalogDomain),
    valores: {
      BRAND: limpar(acharAtributo(attrs, 'BRAND')?.value_name),
      GENDER: limpar(acharAtributo(attrs, 'GENDER')?.value_name),
    },
  };

  // ⚠️ THE decision — the server's own function, not a copy of it. Everything
  // this module used to re-derive here (the candidate filter, the
  // first-candidate fallback, the best-scorer loop) drifted from it; the badge
  // is now literally the answer publish will reach.
  const resolucao = resolveSizeChart(charts, catalogDomain, attrs);
  const vencedor = resolucao.chart;
  const dominioAlvo = anuncio.dominio;
  /** Same equality the resolver applies — RAW, so `limpar` only decides display. */
  const mesmoDominio = (c: MlSizeChart): boolean =>
    limpar(c.domain_id) != null && dominioAlvo != null && c.domain_id === catalogDomain;

  const guias = charts.map<GuiaAvaliada>((c) => {
    const dominio = limpar(c.domain_id);
    return {
      chartId: limpar(c.id),
      nome: limpar(c.nome),
      dominio,
      valores: {
        BRAND: limpar(acharAtributo(c.attributes, 'BRAND')?.value_name),
        GENDER: limpar(acharAtributo(c.attributes, 'GENDER')?.value_name),
      },
      veredito: {
        BRAND: bate(acharAtributo(c.attributes, 'BRAND'), acharAtributo(attrs, 'BRAND')),
        GENDER: bate(acharAtributo(c.attributes, 'GENDER'), acharAtributo(attrs, 'GENDER')),
      },
      dominioOk: dominio == null || dominioAlvo == null ? null : mesmoDominio(c),
      enviada: limpar(c.id) != null,
      vincula: vencedor != null && c === vencedor,
    };
  });

  return { guias, anuncio, vinculada: guias.find((g) => g.vincula) ?? null, resolucao };
}

/**
 * The warning to show above the table, or `null`.
 *
 * ⚠️ It fires ONLY on the unambiguous case — the anúncio's category uses a guia,
 * the tabela has guias that were sent, and none of them is in the category's
 * domain. Every input is required: while one is still loading the answer is
 * `null`, so the panel never flashes an accusation at an operator whose data
 * simply has not arrived (the convention `MercadoLivreEditor` already follows
 * for `produtoFotoCount` and `produtoMarca`).
 *
 * ⚠️ The wording mirrors the server's own refusal so the screen and the 422
 * cannot tell the operator two different stories.
 */
export function avisoDominioTabela(input: {
  nomeDaTabela: string | null;
  avaliacao: AvaliacaoTabela | null;
  /** Does the category carry a size-chart attribute? `null` = still loading. */
  categoriaUsaGuia: boolean | null;
  categoryId: string | null;
}): string | null {
  const { avaliacao, categoriaUsaGuia, categoryId, nomeDaTabela } = input;
  if (avaliacao == null || categoriaUsaGuia !== true || categoryId == null) return null;
  // ⚠️ ONE test, the resolver's own. Every guard this used to re-derive —
  // "something binds", "nothing was sent", "a guia in the right domain exists" —
  // is already folded into that discriminant, and re-deriving them is what let a
  // wrong copy of two of them ship.
  const { resolucao } = avaliacao;
  if (resolucao.motivo !== 'dominio-divergente') return null;

  const dominios = resolucao.dominiosDaTabela.join(', ');
  const nome = nomeDaTabela ?? 'do produto';
  if (dominios === '') {
    // A legacy guia may carry no `domain_id` at all — say only what is true.
    return (
      `A tabela de medidas "${nome}" não tem nenhuma guia no domínio ` +
      `${resolucao.dominioDaCategoria}, que é o exigido por esta categoria ` +
      `(${categoryId}). Crie uma guia nesse domínio na tabela de medidas.`
    );
  }
  return (
    `A tabela de medidas "${nome}" está no domínio ${dominios}, mas esta categoria ` +
    `(${categoryId}) exige ${resolucao.dominioDaCategoria}. Nenhuma guia será enviada — ` +
    `crie uma guia em ${resolucao.dominioDaCategoria} na tabela de medidas, ou escolha uma ` +
    `categoria de ${dominios}.`
  );
}
