import { z } from 'zod';
import { mlAttributeWireSchema } from './produto/collection/mercadoLivreLink';

/**
 * READ-side slice of the `tabMedi` doc's `tabelasDeMedidasMercadoLivre` map —
 * the old Flutter wire shape (`TabelaDeMedidasMercadoLivreList`, tabelaMedidas
 * models.dart): the map is keyed by **integração doc id** (the legacy
 * `ContaMercadoLivre` collection IS `integracao`) and each value holds
 * `{ tabelas: [...] }` — one entry per ML size chart the conta owns for this
 * tabela.
 *
 * The base `tabelaDeMedidasSchema` keeps the field as `z.record(z.unknown())`
 * on purpose (the live Flutter app authors it; the new medidas CRUD never
 * touches it). These schemas exist for CONSUMERS — the publish flow reads the
 * chart id / domain / rows to bind `SIZE_GRID_ID` / `SIZE_GRID_ROW_ID` at
 * export time. Everything is `.passthrough()` + optional so a legacy doc can
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
