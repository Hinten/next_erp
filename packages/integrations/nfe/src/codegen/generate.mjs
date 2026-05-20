/* eslint-disable */
/**
 * NF-e XSD -> TypeScript generator.
 *
 * Reads the vendored SEFAZ XSD packs in `schemas/` and emits
 * `src/types/nfe-schema.ts`: TypeScript interfaces for every complexType plus
 * an ordered field-metadata table (`META`) the XML (de)serializer uses to
 * build/parse documents in the exact `xs:sequence` order SEFAZ requires.
 *
 * Zero dependencies (built-in minimal XML parser) so `gen:nfe-types` is just
 * `node src/codegen/generate.mjs`. Generated output is committed; re-run only
 * when the XSD packs change. See ADR 0004.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(HERE, '..', '..', 'schemas');
const OUT_FILE = join(HERE, '..', 'types', 'nfe-schema.ts');
const OUT_ZOD_FILE = join(HERE, '..', 'types', 'nfe-schema-zod.ts');

// ---------------------------------------------------------------------------
// Minimal XML parser — enough for XSD (no CDATA in structural nodes, no DTD).
// ---------------------------------------------------------------------------
function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Parse an XML string into a tree of { tag, attrs, children }. */
function parseXml(text) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt === -1) break;
    i = lt;
    if (text.startsWith('<?', i)) {
      i = text.indexOf('?>', i) + 2;
      continue;
    }
    if (text.startsWith('<!--', i)) {
      i = text.indexOf('-->', i) + 3;
      continue;
    }
    if (text.startsWith('<!', i)) {
      i = text.indexOf('>', i) + 1;
      continue;
    }
    const gt = text.indexOf('>', i);
    if (gt === -1) break;
    let raw = text.slice(i + 1, gt).trim();
    i = gt + 1;
    if (raw.startsWith('/')) {
      stack.pop();
      continue;
    }
    const selfClose = raw.endsWith('/');
    if (selfClose) raw = raw.slice(0, -1).trim();
    const sp = raw.search(/\s/);
    const tag = sp === -1 ? raw : raw.slice(0, sp);
    const attrs = {};
    if (sp !== -1) {
      const attrRe = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
      let m;
      while ((m = attrRe.exec(raw.slice(sp)))) attrs[m[1]] = decodeEntities(m[2]);
    }
    const node = { tag, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

const kids = (node, tag) => node.children.filter((c) => c.tag === tag);
const kid = (node, tag) => node.children.find((c) => c.tag === tag);

// ---------------------------------------------------------------------------
// Load every XSD and collect named definitions (xs:include = flat merge,
// all schemas share the portalfiscal namespace).
// ---------------------------------------------------------------------------
const complexTypes = new Map(); // name -> xs:complexType node
const simpleTypes = new Map(); // name -> xs:simpleType node
const rootElements = []; // { name, type }

const files = readdirSync(SCHEMA_DIR)
  .filter((f) => f.endsWith('.xsd') && f !== 'xmldsig-core-schema_v1.01.xsd')
  .sort();

for (const file of files) {
  const schema = kid(parseXml(readFileSync(join(SCHEMA_DIR, file), 'utf8')), 'xs:schema');
  if (!schema) continue;
  for (const c of schema.children) {
    if (c.tag === 'xs:complexType' && c.attrs.name) complexTypes.set(c.attrs.name, c);
    else if (c.tag === 'xs:simpleType' && c.attrs.name) simpleTypes.set(c.attrs.name, c);
    else if (c.tag === 'xs:element' && c.attrs.name && c.attrs.type) {
      if (!rootElements.some((r) => r.name === c.attrs.name))
        rootElements.push({ name: c.attrs.name, type: c.attrs.type });
    }
  }
}

// ---------------------------------------------------------------------------
// simpleType resolution -> { kind: 'string' | 'enum', values?: string[] }.
// All NF-e leaf values are kept as strings (exact decimal control on the wire);
// enumerations additionally yield a string-literal union.
// ---------------------------------------------------------------------------
const simpleCache = new Map();
function resolveSimpleNode(node) {
  const restriction = kid(node, 'xs:restriction');
  if (!restriction) {
    // xs:union / xs:list — not used by NF-e XSDs; fall back to string.
    return { kind: 'string' };
  }
  const enums = kids(restriction, 'xs:enumeration').map((e) => e.attrs.value);
  if (enums.length) return { kind: 'enum', values: enums };
  const base = restriction.attrs.base;
  if (base && !base.startsWith('xs:') && simpleTypes.has(base)) return resolveSimple(base);
  return { kind: 'string' };
}
function resolveSimple(name) {
  if (simpleCache.has(name)) return simpleCache.get(name);
  const node = simpleTypes.get(name);
  const result = node ? resolveSimpleNode(node) : { kind: 'string' };
  simpleCache.set(name, result);
  return result;
}

const tsUnion = (values) => values.map((v) => `'${v.replace(/'/g, "\\'")}'`).join(' | ');

// ---------------------------------------------------------------------------
// complexType -> interface + ordered FieldDef[].
// Inline anonymous complexTypes are synthesised into named interfaces.
// ---------------------------------------------------------------------------
const interfaces = []; // { name, fields: [{ jsName, tsType, optional }] }
const meta = []; // { name, defs: FieldDef[] }
const zodTypes = []; // { name, fields: [{ jsName, metaType, optional, list, enumValues }] }
const emitted = new Set();
let choiceSeq = 0;

/** Resolve an <xs:element> (or its inline type) within an owner type. */
function resolveElement(el, ownerName) {
  const name = el.attrs.name;
  const optional = el.attrs.minOccurs === '0';
  const list = el.attrs.maxOccurs != null && el.attrs.maxOccurs !== '1';

  // Referenced element (only ds:Signature occurs in NF-e) -> raw XML string.
  if (el.attrs.ref) {
    const local = el.attrs.ref.split(':').pop();
    return { jsName: local, tsType: 'string', metaType: '#raw', optional, list };
  }

  const type = el.attrs.type;
  if (type) {
    if (type.startsWith('ds:'))
      return { jsName: name, tsType: 'string', metaType: '#raw', optional, list };
    if (type.startsWith('xs:'))
      return { jsName: name, tsType: 'string', metaType: '#string', optional, list };
    if (complexTypes.has(type)) {
      emitComplexType(type);
      return { jsName: name, tsType: type, metaType: type, optional, list };
    }
    const simple = resolveSimple(type);
    return {
      jsName: name,
      tsType: simple.kind === 'enum' ? tsUnion(simple.values) : 'string',
      metaType: '#string',
      optional,
      list,
      enumValues: simple.kind === 'enum' ? simple.values : undefined,
    };
  }

  const inlineComplex = kid(el, 'xs:complexType');
  if (inlineComplex) {
    const synthName = `${ownerName}_${name}`;
    inlineComplex.attrs.name = synthName;
    complexTypes.set(synthName, inlineComplex);
    emitComplexType(synthName);
    return { jsName: name, tsType: synthName, metaType: synthName, optional, list };
  }

  const inlineSimple = kid(el, 'xs:simpleType');
  if (inlineSimple) {
    const simple = resolveSimpleNode(inlineSimple);
    return {
      jsName: name,
      tsType: simple.kind === 'enum' ? tsUnion(simple.values) : 'string',
      metaType: '#string',
      optional,
      list,
      enumValues: simple.kind === 'enum' ? simple.values : undefined,
    };
  }
  return { jsName: name, tsType: 'string', metaType: '#string', optional, list };
}

/** Walk a sequence/choice container, flattening elements in document order. */
function collectFields(container, ownerName, forceOptional, fields) {
  for (const c of container.children) {
    if (c.tag === 'xs:element') {
      const f = resolveElement(c, ownerName);
      fields.push({ ...f, kind: 'element', optional: f.optional || forceOptional });
    } else if (c.tag === 'xs:sequence') {
      collectFields(c, ownerName, forceOptional || c.attrs.minOccurs === '0', fields);
    } else if (c.tag === 'xs:choice') {
      const group = ++choiceSeq;
      const inner = [];
      collectFields(c, ownerName, true, inner);
      for (const f of inner) fields.push({ ...f, choiceGroup: group });
    }
  }
}

function emitComplexType(name) {
  if (emitted.has(name)) return;
  emitted.add(name);
  const node = complexTypes.get(name);
  if (!node) return;

  const fields = [];
  for (const c of node.children) {
    if (c.tag === 'xs:sequence' || c.tag === 'xs:choice') {
      if (c.tag === 'xs:choice') {
        const group = ++choiceSeq;
        const inner = [];
        collectFields(c, name, true, inner);
        for (const f of inner) fields.push({ ...f, choiceGroup: group });
      } else {
        collectFields(c, name, c.attrs.minOccurs === '0', fields);
      }
    }
  }
  for (const a of kids(node, 'xs:attribute')) {
    const simple =
      a.attrs.type && !a.attrs.type.startsWith('xs:') && simpleTypes.has(a.attrs.type)
        ? resolveSimple(a.attrs.type)
        : { kind: 'string' };
    fields.push({
      jsName: a.attrs.name,
      tsType: simple.kind === 'enum' ? tsUnion(simple.values) : 'string',
      metaType: '#string',
      optional: a.attrs.use !== 'required',
      list: false,
      kind: 'attribute',
      enumValues: simple.kind === 'enum' ? simple.values : undefined,
    });
  }

  // Dedupe same-named members. xs:choice branches can declare the same element
  // name twice (e.g. `IPI` in the `imposto` choice); a TS interface and the
  // runtime object both key by name, so collapse to the first occurrence —
  // which keeps the correct NF-e element order — and union differing types.
  const seen = new Map();
  const deduped = [];
  for (const f of fields) {
    const key = `${f.kind}:${f.jsName}`;
    const prev = seen.get(key);
    if (prev) {
      prev.optional = true;
      if (prev.tsType !== f.tsType) prev.tsType = `${prev.tsType} | ${f.tsType}`;
      continue;
    }
    seen.set(key, f);
    deduped.push(f);
  }
  fields.length = 0;
  fields.push(...deduped);

  interfaces.push({
    name,
    fields: fields.map((f) => ({
      jsName: f.jsName,
      tsType: f.list ? `Array<${f.tsType}>` : f.tsType,
      optional: f.optional,
    })),
  });
  meta.push({
    name,
    defs: fields.map((f) => ({
      name: f.jsName,
      kind: f.kind,
      type: f.metaType,
      optional: f.optional,
      list: f.list,
      ...(f.choiceGroup ? { choiceGroup: f.choiceGroup } : {}),
    })),
  });
  zodTypes.push({
    name,
    fields: fields.map((f) => ({
      jsName: f.jsName,
      metaType: f.metaType,
      optional: f.optional,
      list: f.list,
      enumValues: f.enumValues,
    })),
  });
}

for (const r of rootElements) if (complexTypes.has(r.type)) emitComplexType(r.type);

// ---------------------------------------------------------------------------
// Emit src/types/nfe-schema.ts
// ---------------------------------------------------------------------------
const propName = (s) => (/^[A-Za-z_$][\w$]*$/.test(s) ? s : `'${s}'`);
const out = [];
out.push('/* GENERATED by src/codegen/generate.mjs from schemas/. DO NOT EDIT. */');
out.push(`/* Source XSD packs: ${files.length} files — see schemas/MANIFEST.json. */`);
out.push('');
out.push('/** Ordered field descriptor used by the XML (de)serializer. */');
out.push('export interface FieldDef {');
out.push("  readonly name: string;");
out.push("  readonly kind: 'element' | 'attribute';");
out.push("  /** A complexType name, or '#string' (leaf) / '#raw' (opaque XML). */");
out.push('  readonly type: string;');
out.push('  readonly optional: boolean;');
out.push('  readonly list: boolean;');
out.push('  /** Members sharing a choiceGroup are mutually exclusive (xs:choice). */');
out.push('  readonly choiceGroup?: number;');
out.push('}');
out.push('');

for (const iface of interfaces) {
  out.push(`export interface ${iface.name} {`);
  for (const f of iface.fields) {
    out.push(`  ${propName(f.jsName)}${f.optional ? '?' : ''}: ${f.tsType};`);
  }
  if (iface.fields.length === 0) out.push('  [k: string]: never;');
  out.push('}');
  out.push('');
}

out.push('/** Ordered field metadata, keyed by complexType name. */');
out.push('export const META: Record<string, readonly FieldDef[]> = {');
for (const m of meta) {
  out.push(`  ${propName(m.name)}: [`);
  for (const d of m.defs) {
    const parts = [
      `name: '${d.name}'`,
      `kind: '${d.kind}'`,
      `type: '${d.type}'`,
      `optional: ${d.optional}`,
      `list: ${d.list}`,
    ];
    if (d.choiceGroup) parts.push(`choiceGroup: ${d.choiceGroup}`);
    out.push(`    { ${parts.join(', ')} },`);
  }
  out.push('  ],');
}
out.push('};');
out.push('');
out.push('/** Root elements: the XML tag and its complexType. */');
out.push('export const ROOTS = {');
for (const r of rootElements) {
  if (complexTypes.has(r.type)) out.push(`  ${propName(r.name)}: { xmlName: '${r.name}', type: '${r.type}' },`);
}
out.push('} as const;');
out.push('');

mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, out.join('\n'));
console.log(
  `Generated ${OUT_FILE}\n  ${files.length} XSD files, ${interfaces.length} interfaces, ` +
    `${rootElements.length} root elements.`,
);

// ---------------------------------------------------------------------------
// Emit src/types/nfe-schema-zod.ts
//
// Mirrors every complexType from src/types/nfe-schema.ts as a Zod schema so
// the tributary engine + the (de)serializer can validate values at runtime.
// `z.lazy(() => …)` is used everywhere a Zod schema references another so
// order-of-declaration doesn't matter and cycles are handled.
// ---------------------------------------------------------------------------

const zodOut = [];
zodOut.push('/* GENERATED by src/codegen/generate.mjs from schemas/. DO NOT EDIT. */');
zodOut.push(`/* Source XSD packs: ${files.length} files — see schemas/MANIFEST.json. */`);
zodOut.push('');
zodOut.push("import { z } from 'zod';");
zodOut.push('');
zodOut.push("import type {");
for (const t of zodTypes) zodOut.push(`  ${t.name},`);
zodOut.push("} from './nfe-schema';");
zodOut.push('');

function zodFieldExpr(f) {
  let expr;
  if (f.metaType === '#string' || f.metaType === '#raw') {
    if (f.enumValues && f.enumValues.length > 0) {
      // z.enum requires a non-empty literal tuple.
      const literals = f.enumValues.map((v) => `'${v.replace(/'/g, "\\'")}'`).join(', ');
      expr = `z.enum([${literals}])`;
    } else {
      expr = 'z.string()';
    }
  } else {
    // Complex type reference — wrap in z.lazy so forward refs work + cycles
    // don't blow the stack.
    expr = `z.lazy(() => ${f.metaType}Schema)`;
  }
  if (f.list) expr = `z.array(${expr})`;
  if (f.optional) expr = `${expr}.optional()`;
  return expr;
}

for (const t of zodTypes) {
  // Annotate with the matching TS type so editor tooltips show the same
  // shape as the interface.
  zodOut.push(
    `export const ${t.name}Schema: z.ZodType<${t.name}> = z.lazy(() => z.object({`,
  );
  for (const f of t.fields) {
    zodOut.push(`  ${propName(f.jsName)}: ${zodFieldExpr(f)},`);
  }
  if (t.fields.length === 0) {
    // Empty complexType — z.object({}) is fine but we mark it so callers know.
    zodOut.push('  // no fields declared by the XSD');
  }
  zodOut.push('})) as z.ZodType<' + t.name + '>;');
  zodOut.push('');
}

zodOut.push('/** Root → Zod schema for the matching complexType. Mirrors ROOTS. */');
zodOut.push('export const ROOTS_SCHEMAS = {');
for (const r of rootElements) {
  if (complexTypes.has(r.type)) {
    zodOut.push(`  ${propName(r.name)}: ${r.type}Schema,`);
  }
}
zodOut.push('} as const;');
zodOut.push('');

writeFileSync(OUT_ZOD_FILE, zodOut.join('\n'));
console.log(
  `Generated ${OUT_ZOD_FILE}\n  ${zodTypes.length} Zod schemas, ` +
    `${Object.keys(rootElements.filter((r) => complexTypes.has(r.type))).length} root schemas.`,
);
