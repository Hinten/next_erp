/**
 * Pure form logic for the medidas-screen Mercado Livre chart editor (Step 5c
 * MVP). No React / IO here — the tab component drives the ML client and calls
 * these to walk the domain technical-specs tree and assemble the write-shape
 * chart submitted to `POST size-charts/sync`.
 *
 * Scope (MVP, apparel/`SIZE` domains): the create flow needs only the domain's
 * single `grid_template_required` attribute (GENDER) + its allowed values,
 * plus one row per size variante carrying a `SIZE` attribute. Measurement
 * columns (the `?section=grids` GRID spec), footwear `main_attribute_candidate`
 * sizing, `_FROM/_TO` connectors and unit overrides are deferred — the server
 * synthesizes the SIZE main attribute from the rows (`chartCreatePayload`), so
 * a size-only chart is a valid create for apparel domains.
 */
import { type MlSizeChart, type Variante, varianteFakePath } from '@delfrance/schemas';

/** One selectable value of a spec attribute (`{id, name}`). */
export interface ChartSpecValue {
  id: string;
  name: string;
}

/** The domain's grid-template attribute (GENDER) the editor must ask for. */
export interface GridTemplateAttribute {
  id: string;
  name: string;
  values: ChartSpecValue[];
}

export type GridTemplateResult =
  | { ok: true; template: GridTemplateAttribute }
  /** The domain exposes no chart template (not a chart-required domain). */
  | { ok: false; reason: 'none' }
  /** More than one template — the legacy UI punted to support here too. */
  | { ok: false; reason: 'multiple' };

/** A raw spec attribute as it appears under a GRID component. */
interface RawSpecAttribute {
  id?: unknown;
  name?: unknown;
  tags?: unknown;
  values?: unknown;
}

/**
 * Every attribute across the spec tree, regardless of nesting. The ML shape is
 * `{ input: { groups: [{ components: [{ components: [{ attributes: [...] }] }] }] } }`
 * (a GRID component nests its column components), but ML has reshaped these
 * trees before — so the walk is defensive: it follows `input`, `groups`,
 * `components` and `attributes` wherever they appear.
 */
function collectAttributes(specs: Record<string, unknown>): RawSpecAttribute[] {
  const out: RawSpecAttribute[] = [];
  const seen = new Set<unknown>();

  const visit = (node: unknown): void => {
    if (node == null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.attributes)) {
      for (const a of obj.attributes) {
        if (a && typeof a === 'object') out.push(a as RawSpecAttribute);
      }
    }
    // Recurse into the structural keys only — never into an attribute's own
    // `values`, so a value that happens to carry `attributes` can't leak in.
    for (const key of ['input', 'groups', 'components'] as const) {
      if (key in obj) visit(obj[key]);
    }
  };

  visit(specs);
  return out;
}

function hasTag(attr: RawSpecAttribute, tag: string): boolean {
  return Array.isArray(attr.tags) && attr.tags.includes(tag);
}

function toSpecValues(raw: unknown): ChartSpecValue[] {
  if (!Array.isArray(raw)) return [];
  const out: ChartSpecValue[] = [];
  for (const v of raw) {
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.id === 'string' && typeof o.name === 'string') {
        out.push({ id: o.id, name: o.name });
      }
    }
  }
  return out;
}

/**
 * Find the domain's single `grid_template_required` attribute (GENDER) — the
 * one value the chart editor must collect (legacy `medidasCadastro.dart`
 * 1405-1424: exactly one expected; zero = not a chart domain; more than one =
 * unsupported).
 */
export function extractGridTemplate(specs: Record<string, unknown>): GridTemplateResult {
  const templates = collectAttributes(specs).filter((a) => hasTag(a, 'grid_template_required'));
  if (templates.length === 0) return { ok: false, reason: 'none' };
  if (templates.length > 1) return { ok: false, reason: 'multiple' };
  const t = templates[0]!;
  return {
    ok: true,
    template: {
      id: typeof t.id === 'string' ? t.id : '',
      name: typeof t.name === 'string' ? t.name : typeof t.id === 'string' ? t.id : '',
      values: toSpecValues(t.values),
    },
  };
}

/**
 * One chart row per size variante: `varianteUid` binds the row to the variante
 * at publish (`findChartRow` matches the last path segment), and the `SIZE`
 * attribute carries the size label the listing shows (`value_name`).
 */
export function rowsFromVariantes(
  grupoId: string,
  variantes: readonly Variante[],
): NonNullable<MlSizeChart['rows']> {
  return variantes.map((v) => ({
    varianteUid: varianteFakePath(grupoId, v.id),
    id: null,
    attributes: [{ id: 'SIZE', value_name: v.nome }],
  }));
}

export interface BuildChartInput {
  nome: string;
  /** FULL domain id (`'MLB-T_SHIRTS'`) — the write schema requires the prefix. */
  domainId: string;
  /** The grid-template attribute id (usually `GENDER`) + the chosen value. */
  templateId: string;
  templateValue: ChartSpecValue;
  grupoId: string;
  variantes: readonly Variante[];
}

/**
 * Assemble a `mlSizeChartWriteSchema`-shaped NEW chart (id null → the server
 * creates it on ML). `main_attribute` is left empty on purpose — the server
 * synthesizes the SIZE main attribute from the rows.
 */
export function buildNewChart(input: BuildChartInput): MlSizeChart {
  return {
    id: null,
    nome: input.nome.trim(),
    domain_id: input.domainId,
    tipo: 'CLOTHING_MEASURE',
    grupoDeVariacoesUid: `documents/grupoDeVariacoes/${input.grupoId}`,
    attributes: [
      {
        id: input.templateId,
        value_id: input.templateValue.id,
        value_name: input.templateValue.name,
      },
    ],
    main_attribute: [],
    rows: rowsFromVariantes(input.grupoId, input.variantes),
  };
}
