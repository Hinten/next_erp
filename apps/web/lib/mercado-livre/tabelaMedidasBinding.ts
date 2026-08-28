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
 * the anúncio's**, because that comparison is the whole of what the server's
 * `resolveSizeChart` does:
 *
 *  1. `domain_id === catalog_domain` is a hard filter — a miss binds nothing;
 *  2. `BRAND` / `GENDER` are the attributes the scoring loop counts hits over
 *     against the link doc's own attributes, so a guia in the RIGHT domain whose
 *     gênero disagrees still binds nothing, and that failure is just as silent.
 *
 * ⚠️ **The server is the authority.** This module explains; it never decides.
 * Publish refuses the mismatch itself, before any ML call
 * (`publishCore.ts`'s `sizeChartIssue`), so a drift here shows a wrong ✓ — it
 * cannot let a bad payload out. The rules below are deliberately a
 * line-for-line mirror of `apps/mercado-livre/lib/marketplace/size-charts/sizeChart.ts`.
 */
import type { MlSizeChart } from '@delfrance/schemas';

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
 * ⚠️ `value_id` first, `value_name` as the fallback — the resolver's own order.
 * Comparing names only would paint a ✓ on a pair the server does not match
 * (two "Infantil" entries under different ML value ids), which is worse than
 * showing nothing: it sends the operator looking somewhere else.
 */
function bate(chart: AtributoValor | null, anuncio: AtributoValor | null): Verdito {
  if (chart == null || anuncio == null) return null;
  if (anuncio.value_id != null && chart.value_id != null)
    return chart.value_id === anuncio.value_id;
  if (anuncio.value_name != null && chart.value_name != null) {
    return chart.value_name === anuncio.value_name;
  }
  // One side carries no value at all — it cannot score, so there is no verdict
  // to give. Reporting `false` here would blame an attribute nobody filled in.
  return null;
}

/** How many of the anúncio's VALUED attributes this chart matches — the score. */
function pontos(chart: MlSizeChart, valorados: readonly AtributoValor[]): number {
  let hits = 0;
  for (const pa of valorados) {
    for (const ca of chart.attributes ?? []) {
      if (ca.id !== pa.id) continue;
      if (
        (pa.value_id != null && ca.value_id === pa.value_id) ||
        (pa.value_name != null && ca.value_name === pa.value_name)
      ) {
        hits += 1;
      }
    }
  }
  return hits;
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
  const valorados = attrs.filter((a) => a.value_id != null || a.value_name != null);

  const anuncio: AnuncioLado = {
    dominio: limpar(catalogDomain),
    valores: {
      BRAND: limpar(acharAtributo(attrs, 'BRAND')?.value_name),
      GENDER: limpar(acharAtributo(attrs, 'GENDER')?.value_name),
    },
  };

  // The resolver's candidate set: sent, and in the category's domain.
  const dominioAlvo = anuncio.dominio;
  const candidatos = charts.filter(
    (c) => limpar(c.id) != null && dominioAlvo != null && limpar(c.domain_id) === dominioAlvo,
  );
  // ⚠️ The legacy boundary: with NO valued anúncio attributes the first
  // candidate wins blindly; otherwise the best scorer wins and zero hits binds
  // nothing. Mirrored from `resolveSizeChart` — see this module's header.
  let vencedor: MlSizeChart | null = null;
  if (candidatos.length > 0) {
    if (valorados.length === 0) {
      vencedor = candidatos[0]!;
    } else {
      let melhor = 0;
      for (const c of candidatos) {
        const p = pontos(c, valorados);
        if (p > melhor) {
          melhor = p;
          vencedor = c;
        }
      }
    }
  }

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
      dominioOk: dominio == null || dominioAlvo == null ? null : dominio === dominioAlvo,
      enviada: limpar(c.id) != null,
      vincula: vencedor != null && c === vencedor,
    };
  });

  return { guias, anuncio, vinculada: guias.find((g) => g.vincula) ?? null };
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
  const dominioDaCategoria = avaliacao.anuncio.dominio;
  if (dominioDaCategoria == null) return null;
  // Something binds — nothing to warn about.
  if (avaliacao.vinculada != null) return null;

  const enviadas = avaliacao.guias.filter((g) => g.enviada);
  if (enviadas.length === 0) return null; // "never sent" is its own message, not a mismatch.
  const dominios = [
    ...new Set(enviadas.map((g) => g.dominio).filter((d): d is string => d != null)),
  ]
    .sort()
    .join(', ');
  if (dominios === '') return null;
  // A guia in the right domain exists but scored nothing — the domain is fine,
  // so blaming it would send the operator to change a correct field.
  if (enviadas.some((g) => g.dominioOk === true)) return null;

  const nome = nomeDaTabela ?? 'do produto';
  return (
    `A tabela de medidas "${nome}" está no domínio ${dominios}, mas esta categoria ` +
    `(${categoryId}) exige ${dominioDaCategoria}. Nenhuma guia será enviada — crie uma guia em ` +
    `${dominioDaCategoria} na tabela de medidas, ou escolha uma categoria de ${dominios}.`
  );
}
