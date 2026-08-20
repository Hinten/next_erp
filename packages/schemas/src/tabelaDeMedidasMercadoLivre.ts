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
