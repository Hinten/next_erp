/**
 * Staging datetime wire-shape sampler (issue #483, prerequisite of #155/#485).
 *
 * READ-ONLY. Samples a few live docs per validator-whitelisted collection and
 * reports the actual runtime shape (`number` / `iso-string` / `Timestamp` /
 * `null`) of every schema-declared datetime field, plus any datetime-shaped
 * value discovered nested where the schema doesn't declare one (this is how the
 * `Cheque.bomPara` / webchat `abertura`/`fechamento` ISO exceptions surface).
 *
 * The point (#155): before the rules-gen validator skip for `format:'date-time'`
 * is lifted (#485) or the non-fiscal datetime wire shape is standardized (#484),
 * confirm on real data whether legacy docs still carry ms/µs ints, ISO strings,
 * or Firestore Timestamps. Paste this script's Markdown output into #155.
 *
 * Usage (staging, from repo root):
 *   pnpm --filter @delfrance/test-fixtures sample:datetime
 *   pnpm --filter @delfrance/test-fixtures sample:datetime --limit 10 --json
 *
 * Requires the same staging credentials as the seed scripts
 * (FIREBASE_SERVICE_ACCOUNT[_PATH] + FIREBASE_PROJECT_ID from ../../.env.local).
 * No writes, no schema/rules change.
 */
import { pathToFileURL } from 'node:url';
import type { z } from 'zod';
import { type Firestore } from 'firebase-admin/firestore';
import { ALL_DOMAINS } from '@delfrance/schemas';
import { VALIDATOR_WHITELIST } from '@delfrance/rules-gen';
import { db } from './admin';
import {
  type DatetimeFieldSpec,
  type Observation,
  type ValueShape,
  KNOWN_ISO_EXCEPTIONS,
  collectObservations,
  datetimeFieldsForSchema,
  normalizePath,
} from './datetime-shapes';

export interface Options {
  limit: number;
  parentScan: number;
  json: boolean;
  serviceAccountPath?: string;
}

export function parseOptions(argv: string[]): Options {
  let limit = 5;
  let parentScan = 0;
  let json = false;
  let serviceAccountPath: string | undefined;
  // Only treat the following token as a flag's value when it isn't itself a
  // flag, so `--limit --json` doesn't swallow `--json` (and silently fall back
  // to the default limit). Mirrors the parsing in args.ts.
  const valueFor = (index: number): string | undefined => {
    const next = argv[index + 1];
    return next !== undefined && !next.startsWith('-') ? next : undefined;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--limit') {
      const value = valueFor(i);
      if (value !== undefined) {
        limit = Math.max(1, Number.parseInt(value, 10) || 5);
        i += 1;
      }
    } else if (arg === '--parent-scan') {
      const value = valueFor(i);
      if (value !== undefined) {
        parentScan = Math.max(1, Number.parseInt(value, 10) || 0);
        i += 1;
      }
    } else if (arg === '--service-account' || arg === '-s') {
      const value = valueFor(i);
      if (value !== undefined) {
        serviceAccountPath = value;
        i += 1;
      }
    } else if (arg === '--json') {
      json = true;
    }
  }
  return { limit, parentScan: parentScan || limit * 5, json, serviceAccountPath };
}

/** Map each whitelisted collection path to its DomainSchema, in whitelist order. */
function whitelistedSchemas(): Array<{ path: string; schema: z.ZodTypeAny }> {
  const byPath = new Map<string, z.ZodTypeAny>();
  for (const domain of ALL_DOMAINS) byPath.set(domain.meta.collectionPath, domain.schema);
  const out: Array<{ path: string; schema: z.ZodTypeAny }> = [];
  for (const path of VALIDATOR_WHITELIST) {
    const schema = byPath.get(path);
    if (!schema) {
      throw new Error(
        `Whitelisted collection "${path}" has no DomainSchema in ALL_DOMAINS — cannot sample.`,
      );
    }
    out.push({ path, schema });
  }
  return out;
}

/**
 * Sample up to `limit` docs at a collection path. Handles a root collection
 * (`clientes`) and a one-level subcollection (`pedidos/{pedidoId}/pagamentos`),
 * the only two shapes in the whitelist. Every read is `.limit(...)`-bounded.
 */
async function sampleCollection(
  firestore: Firestore,
  path: string,
  options: Options,
): Promise<Array<Record<string, unknown>>> {
  const segments = path.split('/');
  if (segments.length === 1) {
    const snap = await firestore.collection(segments[0]!).limit(options.limit).get();
    return snap.docs.map((d) => d.data());
  }
  if (segments.length === 3 && segments[1]!.startsWith('{')) {
    const [parent, , sub] = segments;
    const parents = await firestore.collection(parent!).limit(options.parentScan).get();
    const docs: Array<Record<string, unknown>> = [];
    for (const parentDoc of parents.docs) {
      if (docs.length >= options.limit) break;
      const remaining = options.limit - docs.length;
      const subSnap = await parentDoc.ref.collection(sub!).limit(remaining).get();
      for (const subDoc of subSnap.docs) docs.push(subDoc.data());
    }
    return docs;
  }
  throw new Error(`Unsupported collection depth for sampling: "${path}"`);
}

export interface FieldReport {
  path: string;
  expected: string;
  shapeCounts: Map<ValueShape, number>;
  presentDocs: number;
  example: unknown;
}

export interface DiscoveredReport {
  path: string;
  shape: ValueShape;
  count: number;
  example: unknown;
}

export interface CollectionReport {
  path: string;
  sampled: number;
  fields: FieldReport[];
  discovered: DiscoveredReport[];
}

function expectedLabel(spec: DatetimeFieldSpec): string {
  if (spec.format === 'iso') return "ISO string (format: 'date-time')";
  return spec.unit === 'us' ? 'number (µs-int)' : 'number (ms-int)';
}

function bump<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

export function buildReport(
  path: string,
  schema: z.ZodTypeAny,
  docs: Array<Record<string, unknown>>,
): CollectionReport {
  const specs = datetimeFieldsForSchema(schema);
  // De-duplicate by path (a nullable field yields one spec after anyOf recursion).
  const specByPath = new Map<string, DatetimeFieldSpec>();
  for (const spec of specs) if (!specByPath.has(spec.path)) specByPath.set(spec.path, spec);
  const declaredPaths = new Set(specByPath.keys());
  // `collectObservations` matches interest by leaf NAME (that's all it can do
  // while walking), so it records every value whose name is a declared datetime
  // field — including same-named fields at different paths (e.g. top-level
  // `timestamp` and `freteInicial.timestamp` on a pedido). Attribution back to
  // the right field then happens by normalized PATH below, not by name.
  const declaredNames = new Set([...specByPath.values()].map((s) => s.name));
  const interesting = new Set<string>([...declaredNames, ...KNOWN_ISO_EXCEPTIONS]);

  const perDoc: Observation[][] = docs.map((doc) => collectObservations(doc, interesting));

  const fields: FieldReport[] = [...specByPath.values()].map((spec) => {
    const shapeCounts = new Map<ValueShape, number>();
    let presentDocs = 0;
    let example: unknown;
    for (const observations of perDoc) {
      // Match by full (array-normalized) path so a same-named field on another
      // path can't be attributed here. An array-valued field can match more
      // than once per doc — count each occurrence, but the doc only once.
      const matches = observations.filter((o) => normalizePath(o.path) === spec.path);
      if (matches.length > 0) presentDocs += 1;
      for (const match of matches) {
        bump(shapeCounts, match.shape);
        if (example === undefined) example = match.example;
      }
    }
    return { path: spec.path, expected: expectedLabel(spec), shapeCounts, presentDocs, example };
  });

  // Datetime-shaped values (Timestamp / ISO string) found where no datetime
  // field is declared — grouped by path with array indices normalized. Excluded
  // by declared PATH (not name), so a legacy shape on a same-named-but-nested
  // field stays attributed to its field row above instead of vanishing here.
  const discoveredMap = new Map<string, DiscoveredReport>();
  for (const observations of perDoc) {
    for (const obs of observations) {
      const normalized = normalizePath(obs.path);
      if (declaredPaths.has(normalized)) continue;
      const key = `${normalized}|${obs.shape}`;
      const existing = discoveredMap.get(key);
      if (existing) existing.count += 1;
      else
        discoveredMap.set(key, {
          path: normalized,
          shape: obs.shape,
          count: 1,
          example: obs.example,
        });
    }
  }

  return {
    path,
    sampled: docs.length,
    fields,
    discovered: [...discoveredMap.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function renderShapeCounts(counts: Map<ValueShape, number>, absent: number): string {
  const parts = [...counts.entries()].map(([shape, count]) => `${shape}×${count}`);
  if (absent > 0) parts.push(`absent×${absent}`);
  return parts.length > 0 ? parts.join(', ') : '—';
}

export function renderMarkdown(reports: CollectionReport[], options: Options): string {
  const lines: string[] = [];
  lines.push('## Staging datetime wire-shape sample');
  lines.push('');
  lines.push(
    `Project: \`${process.env.FIREBASE_PROJECT_ID ?? '(from service account)'}\` · ` +
      `Database: \`${process.env.FIREBASE_DATABASE_ID?.trim() || 'default'}\` · ` +
      `sample size: ${options.limit} doc(s)/collection · run: ${new Date().toISOString()}`,
  );
  lines.push('');
  lines.push(
    '> Read-only sample of live staging docs (#483). `number (ms-int)` / ' +
      '`number (µs-int)` is the expected codec shape; `iso-string` or `Timestamp` ' +
      'on a declared field is a legacy shape the validator flip (#485) must tolerate.',
  );

  for (const report of reports) {
    lines.push('');
    lines.push(`### \`${report.path}\` — sampled ${report.sampled} doc(s)`);
    if (report.sampled === 0) {
      lines.push('');
      lines.push('_No documents found in this collection on staging._');
      continue;
    }
    lines.push('');
    lines.push('| Field | Expected (schema) | Observed shapes |');
    lines.push('|---|---|---|');
    for (const field of report.fields) {
      const absent = report.sampled - field.presentDocs;
      const flag =
        [...field.shapeCounts.keys()].some((s) => s !== 'number' && s !== 'null') &&
        field.expected.startsWith('number')
          ? ' ⚠️'
          : '';
      lines.push(
        `| \`${field.path}\` | ${field.expected} | ${renderShapeCounts(field.shapeCounts, absent)}${flag} |`,
      );
    }
    if (report.discovered.length > 0) {
      lines.push('');
      lines.push(
        'Datetime-shaped values found where the schema declares none (nested/undeclared):',
      );
      lines.push('');
      lines.push('| Path | Shape | Count | Example |');
      lines.push('|---|---|---|---|');
      for (const d of report.discovered) {
        lines.push(`| \`${d.path}\` | ${d.shape} | ${d.count} | \`${String(d.example)}\` |`);
      }
    }
  }

  // Explicit ISO-exception check (acceptance criterion of #483).
  lines.push('');
  lines.push('### ISO-exception check');
  const bomPara: DiscoveredReport[] = [];
  for (const report of reports) {
    for (const d of report.discovered) {
      if (d.path.split('.').pop()?.replace(/\[\]$/, '') === 'bomPara') {
        bomPara.push(d);
      }
    }
  }
  if (bomPara.length > 0) {
    lines.push(
      `- \`Cheque.bomPara\`: found — ${bomPara
        .map((d) => `\`${d.path}\` ${d.shape}×${d.count}`)
        .join(
          ', ',
        )}. (New schema writes µs-int via \`microsSinceEpoch()\`; a legacy ISO string here is the documented exception.)`,
    );
  } else {
    lines.push(
      '- `Cheque.bomPara`: not present in the sampled pedidos/pagamentos (no cheque payments in the sample, or field absent).',
    );
  }
  lines.push(
    '- webchat `abertura`/`fechamento`: out of scope — `webchat` is not in `VALIDATOR_WHITELIST`, so it is not sampled here. Any ISO `abertura`/`fechamento` nested in the sampled collections would appear in the discovered rows above.',
  );
  return lines.join('\n');
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const firestore = db(options.serviceAccountPath);
  const targets = whitelistedSchemas();
  const reports: CollectionReport[] = [];
  for (const { path, schema } of targets) {
    const docs = await sampleCollection(firestore, path, options);
    reports.push(buildReport(path, schema, docs));
  }
  process.stdout.write(`${renderMarkdown(reports, options)}\n`);
  if (options.json) {
    const serializable = reports.map((r) => ({
      path: r.path,
      sampled: r.sampled,
      fields: r.fields.map((f) => ({
        path: f.path,
        expected: f.expected,
        shapes: Object.fromEntries(f.shapeCounts),
        presentDocs: f.presentDocs,
      })),
      discovered: r.discovered,
    }));
    process.stdout.write(`\n<!-- json -->\n${JSON.stringify(serializable, null, 2)}\n`);
  }
}

// Run only when executed directly (`tsx src/sample-datetime-shapes.ts`), not
// when imported by the unit test — importing must have no side effects.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
