#!/usr/bin/env node
// Loja Integrada API docs → plain text, from the official public OpenAPI document (no login needed).
//
//   node li-doc.mjs meta                       # source URL, HTTP last-modified, etag, sha256 of the cached copy
//   node li-doc.mjs info                       # title, version, servers, security schemes + the info prose
//                                              #   (authentication, throttling, "Novidades")
//   node li-doc.mjs tags                       # every tag with its operation count
//   node li-doc.mjs tag <name>                 # a tag's prose + its operations, e.g. tag "Webhook Pedidos"
//   node li-doc.mjs paths [regex]              # METHOD path — summary, optionally filtered, e.g. paths estoque
//   node li-doc.mjs op <METHOD> <path>         # one operation in full, e.g. op PUT /v1/produto_estoque/{produto_id}
//   node li-doc.mjs search <regex>             # every string in the document matching regex, with its JSON path
//
// Add --refresh to any command to re-download the document. In Git Bash on Windows, prefix
// `op` with MSYS_NO_PATHCONV=1, or the shell rewrites "/v1/..." into a Windows path.
//
// Provenance (verified 2026-10-07): api-docs.lojaintegrada.com.br is a subdomain of LI's own
// domain, served with LI's response headers, and LI's help center links it as the API
// documentation. The Scalar page there loads its OpenAPI document from the URL listed in
// /configuration.json, which is what this script reads. The older Apiary site
// (lojaintegrada.docs.apiary.io) is titled "Versão descontinuada" and is not used.
//
// This script only issues anonymous GETs to the documentation host. It never calls the API
// itself (api.awsli.com.br) and never needs a credential. The raw document is cached under
// ./cache/ next to this script (gitignored).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, 'cache');
const DOCS = 'https://api-docs.lojaintegrada.com.br';
const SPEC_FILE = join(CACHE, 'API-Loja-Integrada.json');
const META_FILE = join(CACHE, 'meta.json');
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

const argv = process.argv.slice(2);
const refresh = argv.includes('--refresh');
const [cmd, ...args] = argv.filter((a) => a !== '--refresh');

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (li-doc.mjs)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res;
}

async function loadSpec() {
  if (!refresh && existsSync(SPEC_FILE)) return JSON.parse(readFileSync(SPEC_FILE, 'utf8'));
  mkdirSync(CACHE, { recursive: true });
  const config = await (await get(`${DOCS}/configuration.json`)).json();
  const sources = Array.isArray(config.sources) ? config.sources : [];
  const source = sources.find((s) => s.default) ?? sources[0];
  if (!source?.url) throw new Error('configuration.json lists no OpenAPI source');
  const url = new URL(source.url, DOCS).toString();
  const res = await get(url);
  const text = await res.text();
  writeFileSync(SPEC_FILE, text);
  const meta = {
    url,
    lastModified: res.headers.get('last-modified'),
    etag: res.headers.get('etag'),
    sha256: createHash('sha256').update(text).digest('hex'),
    bytes: Buffer.byteLength(text),
    fetchedAt: new Date().toISOString(),
  };
  writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
  return JSON.parse(text);
}

const operations = (spec) =>
  Object.entries(spec.paths ?? {}).flatMap(([path, item]) =>
    METHODS.filter((m) => item?.[m]).map((m) => ({ method: m.toUpperCase(), path, op: item[m] })),
  );

const line = (o) => `${o.method.padEnd(7)}${o.path}${o.op.summary ? ` — ${o.op.summary}` : ''}`;

function walkStrings(node, path, visit) {
  if (typeof node === 'string') visit(path, node);
  else if (Array.isArray(node)) node.forEach((v, i) => walkStrings(v, `${path}[${i}]`, visit));
  else if (node && typeof node === 'object')
    for (const [k, v] of Object.entries(node)) walkStrings(v, `${path}.${k}`, visit);
}

function printOperation(o) {
  const { op } = o;
  console.log(`${o.method} ${o.path}`);
  if (op.tags?.length) console.log(`tags: ${op.tags.join(', ')}`);
  if (op.operationId) console.log(`operationId: ${op.operationId}`);
  if (op.summary) console.log(`summary: ${op.summary}`);
  if (op.description) console.log(`\n${op.description}`);
  for (const [title, value] of [
    ['parameters', op.parameters],
    ['requestBody', op.requestBody],
    ['responses', op.responses],
  ]) {
    if (value === undefined) continue;
    console.log(`\n## ${title}\n${JSON.stringify(value, null, 2)}`);
  }
}

function usage() {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 16).join('\n'));
  process.exitCode = 1;
}

const spec = cmd ? await loadSpec() : null;

switch (cmd) {
  case 'meta': {
    console.log(readFileSync(META_FILE, 'utf8'));
    break;
  }
  case 'info': {
    console.log(`${spec.info?.title} — info.version ${spec.info?.version} (openapi ${spec.openapi})`);
    console.log(`servers: ${(spec.servers ?? []).map((s) => s.url).join(', ')}`);
    console.log(`security: ${JSON.stringify(spec.security)}`);
    console.log(`securitySchemes: ${JSON.stringify(spec.components?.securitySchemes ?? {})}`);
    console.log(`\n${spec.info?.description ?? ''}`);
    break;
  }
  case 'tags': {
    const ops = operations(spec);
    for (const t of spec.tags ?? []) {
      const n = ops.filter((o) => o.op.tags?.includes(t.name)).length;
      console.log(`${String(n).padStart(3)}  ${t.name}`);
    }
    break;
  }
  case 'tag': {
    const name = args.join(' ');
    const tag = (spec.tags ?? []).find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (!tag) throw new Error(`no tag named "${name}" — run: node li-doc.mjs tags`);
    console.log(`# ${tag.name}\n\n${tag.description ?? ''}\n`);
    for (const o of operations(spec).filter((x) => x.op.tags?.includes(tag.name))) console.log(line(o));
    break;
  }
  case 'paths': {
    const re = args[0] ? new RegExp(args[0], 'i') : null;
    for (const o of operations(spec)) if (!re || re.test(line(o))) console.log(line(o));
    break;
  }
  case 'op': {
    const [method, path] = args;
    const o = operations(spec).find((x) => x.method === method?.toUpperCase() && x.path === path);
    if (!o) throw new Error(`no operation ${method} ${path} — run: node li-doc.mjs paths`);
    printOperation(o);
    break;
  }
  case 'search': {
    if (!args[0]) throw new Error('search needs a regex');
    const re = new RegExp(args[0], 'i');
    walkStrings(spec, '$', (path, value) => {
      if (re.test(value)) console.log(`${path}: ${value.replace(/\s+/g, ' ').slice(0, 300)}`);
    });
    break;
  }
  default:
    usage();
}
