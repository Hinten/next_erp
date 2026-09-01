import { z } from 'zod';
import { mlAttributeWireSchema } from './produto/collection/mercadoLivreLink';
import { millisSinceEpoch } from './shared/datetime';

/**
 * READ-side slice of the `tabMedi` doc's `tabelasDeMedidasMercadoLivre` map —
 * the old Flutter wire shape (`TabelaDeMedidasMercadoLivreList`, tabelaMedidas
 * models.dart): the map is keyed by **integração doc id** (the legacy
 * `ContaMercadoLivre` collection IS `integracao`) and each value holds
 * `{ tabelas: [...] }` — one entry per ML size chart the conta owns for this
 * tabela.
 *
 * The base `tabelaDeMedidasSchema` keeps the field as `z.record(z.unknown())`
 * on purpose — it is written from OUTSIDE the medidas CRUD. `sizeChartSync.ts`
 * authors it today (`:537`, merging only `tabelasDeMedidasMercadoLivre.<conta>`
 * through `mlSizeChartWriteSchema` below), the migrated corpus carries entries
 * from the legacy app, and the sibling `tabelasMedidasShopee` — modelled just as
 * loosely at `tabelaDeMedidas.ts:30` — has no writer in this repo at all. The new
 * medidas CRUD authors none of them. These schemas exist for CONSUMERS —
 * the publish flow reads the chart id / domain / rows to bind `SIZE_GRID_ID` /
 * `SIZE_GRID_ROW_ID` at export time. Everything is `.passthrough()` + optional
 * so a legacy doc can
 * never fail the parse; `mlSizeChartsForConta` soft-parses and returns `[]`
 * on any mismatch.
 */

/** One chart row (`RowTabelaMedidasML`): binds a Variante to an ML row id. */
export const mlSizeChartRowSchema = z
  .object({
    /** Fake path of the Variante this row measures (the row↔variation join). */
    varianteUid: z.string().nullable().optional(),
    /** FULL ML row id (`'<chartId>:<n>'`) — null until sent to ML. */
    id: z.string().nullable().optional(),
    attributes: z.array(mlAttributeWireSchema).nullable().optional(),
    /**
     * ML's COMPUTED `SIZE` for this row, cached off the create/row responses.
     *
     * ERP-only and deliberately NOT inside `attributes`: every valued entry
     * there is re-sent on the next row PUT, and ML rejects a computed attribute
     * in a row body. For an apparel chart (main attribute = `SIZE`) this merely
     * mirrors the row's own SIZE; for a footwear chart, whose main attribute is
     * `EU_SIZE`/`M_US_SIZE`/…, it is the ONLY place the listing's size value
     * exists. A Flutter save strips it — the publish binding then falls back to
     * the row's own SIZE exactly as before.
     */
    sizeCalculado: mlAttributeWireSchema.nullable().optional(),
  })
  .passthrough();
export type MlSizeChartRow = z.infer<typeof mlSizeChartRowSchema>;

/** One ML size chart (`TabelaDeMedidasMercadoLivre`). */
export const mlSizeChartSchema = z
  .object({
    /** ML chart id — null until created on ML (unsendable to a listing). */
    id: z.string().nullable().optional(),
    main_attribute_id: z.string().nullable().optional(),
    nome: z.string().nullable().optional(),
    /** Fake path of the size variation group the rows bind to. */
    grupoDeVariacoesUid: z.string().nullable().optional(),
    /** FULL domain id (`'MLB-PANTS'`) — matched against `settings.catalog_domain`. */
    domain_id: z.string().nullable().optional(),
    /** `BODY_MEASURE` | `CLOTHING_MEASURE` (legacy `TipoTabelaDeMedidasML`). */
    tipo: z.string().nullable().optional(),
    attributes: z.array(mlAttributeWireSchema).nullable().optional(),
    main_attribute: z.array(mlAttributeWireSchema).nullable().optional(),
    rows: z.array(mlSizeChartRowSchema).nullable().optional(),
    /**
     * When the operator asked ML to delete this chart (ms epoch), or null.
     *
     * ERP-only. `DELETE /catalog/charts/{id}` is a REQUEST: ML checks
     * asynchronously (up to 24h) that no listing still links the chart and
     * silently keeps it if one does, so the entry stays on the doc until a
     * `chart_status` re-read confirms the removal. A Flutter save strips this
     * field, which degrades to "no deletion requested" — the operator simply
     * asks again.
     */
    exclusaoSolicitadaEm: millisSinceEpoch().nullable().optional(),
  })
  .passthrough();
export type MlSizeChart = z.infer<typeof mlSizeChartSchema>;

/** The per-conta map value: `{ tabelas: [...] }`. */
export const mlSizeChartsForContaSchema = z
  .object({
    tabelas: z.array(mlSizeChartSchema).nullable().optional(),
  })
  .passthrough();

/**
 * WRITE-side chart schema — what the sync flow accepts and persists into the
 * SHARED `tabelasDeMedidasMercadoLivre` map. Stricter than the read slice on
 * the fields the live Flutter app parses strictly (`json['nome'] as String`,
 * `json['domain_id'] as String`, `TipoTabelaDeMedidasML.fromJson` throwing on
 * unknown values). ⚠️ Protecting that legacy reader is void — there is no dual
 * run (root `CLAUDE.md` rule 8) — but the constraints stand on their own:
 * `nome` ≤ 60 IS the ML chart-name limit, and `domain_id` must be the FULL
 * `SITE-DOMAIN` form or ML rejects the chart.
 */
export const mlSizeChartWriteSchema = mlSizeChartSchema.extend({
  nome: z.string().min(1).max(60),
  domain_id: z.string().regex(/^[^-]+-.+$/),
  tipo: z.enum(['BODY_MEASURE', 'CLOTHING_MEASURE']).nullable().optional(),
});

/**
 * Soft-read the conta's chart list off `tabMedi.tabelasDeMedidasMercadoLivre`.
 * Any shape mismatch (or a missing conta key) yields `[]` — a malformed legacy
 * entry must degrade to "no chart", never block a publish.
 */
export function mlSizeChartsForConta(
  map: Record<string, unknown> | null | undefined,
  integracaoId: string,
): MlSizeChart[] {
  const entry = map?.[integracaoId];
  if (entry == null) return [];
  const parsed = mlSizeChartsForContaSchema.safeParse(entry);
  if (!parsed.success) return [];
  return parsed.data.tabelas ?? [];
}

/* ------------------------------------------------------------------------- *
 * Chart SELECTION — the one implementation, shared by both surfaces.
 *
 * ⚠️ It lives here because `apps/web` re-implemented it by hand and the two
 * copies drifted TWICE: `bate()` short-circuited on `value_id` where the server
 * ORs the two checks (a red ✗ on a row the same module labelled *vincula*), and
 * the first-candidate fallback keyed on the FILTERED attribute list where the
 * server keys on the RAW one (a green *vincula* on a pair publish refuses).
 * Prose was the only thing holding them together, and prose is what was wrong.
 *
 * ⚠️ **Pure and total — no clock, no network, no Firestore.** That is what lets
 * it live here and be shared, exactly as `precisaConsultarModeracao` does after
 * #1239. `apps/web` has no dependency edge to `apps/mercado-livre` and none is
 * possible, so packages is the only shared home.
 * ------------------------------------------------------------------------- */

/**
 * Minimal structural slice for the attribute-hit scoring — satisfied by both
 * the plugin's `MlAttribute` (the link doc's attributes) and the schema's
 * `MlAttributeWire` (the chart's attributes).
 */
export interface ScoringAttribute {
  /**
   * Optional because the plugin's `MlAttribute` allows an id-less entry (ML's
   * custom characteristic, which only ever appears in a variation's
   * combinations). One can never score: the chart's own attributes always carry
   * an id, so `ca.id !== pa.id` rejects it on every comparison.
   */
  id?: string;
  value_id?: string | null;
  value_name?: string | null;
}

/**
 * Why no chart bound — one code per structurally different cause, each carrying
 * the strings an operator needs to act on it.
 *
 * ⚠️ `guias-nao-enviadas` and `dominio-divergente` are a deliberate SPLIT of
 * what used to be one `candidates.length === 0` exit. A guia sitting in the
 * RIGHT domain with no ML id is an un-sent draft — telling that operator their
 * domain is wrong sends them to change the one field that is already correct.
 */
export type SizeChartResolution =
  | { chart: MlSizeChart; motivo: null }
  | { chart: null; motivo: 'categoria-sem-dominio' }
  | { chart: null; motivo: 'guias-nao-enviadas'; dominioDaCategoria: string }
  | {
      chart: null;
      motivo: 'dominio-divergente';
      /**
       * Distinct domains the tabela's guias declare — sent or not.
       *
       * ⚠️ Deliberately NOT restricted to the sent ones. This branch is only
       * reached when NO guia sits in the category's domain, so every guia here
       * is in the wrong one and whether it went to ML is a second problem the
       * operator only gets to once the domain agrees. Listing the sent subset
       * would print an empty list for a tabela nobody has synced yet.
       *
       * May be empty when no guia declares a domain at all (legacy data — the
       * read schema allows a null `domain_id`); the message must cope.
       */
      dominiosDaTabela: string[];
      dominioDaCategoria: string;
    }
  | { chart: null; motivo: 'sem-atributos-correspondentes'; dominioDaCategoria: string };

/**
 * The no-chart half of {@link SizeChartResolution}.
 *
 * ⚠️ A `motivo: null` resolution ALWAYS carries a usable chart: every return
 * path with one hands back a member of `candidates`, and `candidates` is
 * filtered on a non-blank `id`. So a caller that has excluded this type has a
 * chart id, and needs no second "but what if the id is blank" branch.
 */
export type SizeChartMiss = Exclude<SizeChartResolution, { motivo: null }>;

export function resolveSizeChart(
  tabelas: readonly MlSizeChart[],
  catalogDomain: string | null,
  linkAttributes: readonly ScoringAttribute[] | null,
): SizeChartResolution {
  if (!catalogDomain) return { chart: null, motivo: 'categoria-sem-dominio' };
  // A guia with no ML id was never sent, so it can never be bound — that is a
  // different fact from its domain, and the two are reported separately below.
  const candidates = tabelas.filter(
    (t) => t.id != null && t.id !== '' && t.domain_id === catalogDomain,
  );
  if (candidates.length === 0) {
    // ⚠️ The test is "a guia in THIS domain exists but was not sent", and it has
    // to be exactly that. Widening it to "nothing was sent at all" reads as the
    // same thing and is not: a tabela whose only guia is MLB-SHIRTS, unsent,
    // would be told it "tem guia no domínio MLB-T_SHIRTS" — a domain it does not
    // have — and sending that guia would still bind nothing. That is the mirror
    // image of the mistake this split exists to avoid.
    if (tabelas.some((t) => t.domain_id === catalogDomain)) {
      return { chart: null, motivo: 'guias-nao-enviadas', dominioDaCategoria: catalogDomain };
    }
    return {
      chart: null,
      motivo: 'dominio-divergente',
      dominiosDaTabela: [
        ...new Set(
          tabelas.map((t) => t.domain_id).filter((d): d is string => d != null && d !== ''),
        ),
      ].sort(),
      dominioDaCategoria: catalogDomain,
    };
  }

  // Legacy boundary (models.dart:91): the first-candidate fallback fires ONLY
  // when the RAW attribute list is null/empty. A non-empty list whose entries
  // are all unvalued (real stored data — ML-imported stubs, valueList-only
  // attrs) goes through the scoring loop, hits nothing, and binds NO chart —
  // falling back blindly there could bind the wrong gender's chart.
  const raw = linkAttributes ?? [];
  if (raw.length === 0) return { chart: candidates[0]!, motivo: null };

  // Only VALUED produto attributes can "hit" a chart in the scoring.
  const produtoAttrs = raw.filter((a) => a.value_id != null || a.value_name != null);

  let best: MlSizeChart | null = null;
  let bestHits = 0;
  for (const chart of candidates) {
    let hits = 0;
    for (const pa of produtoAttrs) {
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
    if (hits > bestHits) {
      best = chart;
      bestHits = hits;
    }
  }
  // Zero hits everywhere ⇒ no chart (legacy: a valued-attribute produto must
  // actually match a chart; falling back blindly could bind a wrong gender).
  if (best == null) {
    return {
      chart: null,
      motivo: 'sem-atributos-correspondentes',
      dominioDaCategoria: catalogDomain,
    };
  }
  return { chart: best, motivo: null };
}
