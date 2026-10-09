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
//   node li-doc.mjs folhas [--saida <arquivo>] <METHOD> <path>…
//                                              # the 2xx response LEAF inventory of each operation:
//                                              #   leaf path, JSON types, source (schema/exemplo);
//                                              #   with --saida and no pairs, redoes the file's own list
//
// Add --refresh to any command to re-download the document. In Git Bash on Windows, prefix
// `op` and `folhas` with MSYS_NO_PATHCONV=1, or the shell rewrites "/v1/..." into a Windows path.
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
//
// `folhas` makes no request at all: it reads the cached copy only, refuses --refresh, and
// stops when the cache is missing. It prints leaf paths, JSON types and source tags, NEVER a
// value, so its output may be committed. It generates the spec-coverage inventory of
// apps/loja-integrada (lib/lojaIntegrada/testing/especificacaoFolhas.json); that file's
// header names the exact command that regenerated it, and the app's CLAUDE.md says when.
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
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 18).join('\n'));
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// folhas: the leaf inventory. Paths and JSON types only, never a value.
// ---------------------------------------------------------------------------

/** One path segment per object key; `*` stands for an array index, nothing else. */
const juntar = (caminho, segmento) => (caminho === '' ? segmento : `${caminho}.${segmento}`);

function segmentoValido(chave) {
  // A key holding `.` or `*`, or an empty one, would make two leaves share one path.
  if (chave === '' || chave.includes('.') || chave === '*') {
    throw new Error(`a key the inventory cannot spell unambiguously, under a ${chave.length}-char name`);
  }
  return chave;
}

function tiposDoSchema(schema) {
  if (Array.isArray(schema.type)) return schema.type;
  return [typeof schema.type === 'string' ? schema.type : 'desconhecido'];
}

/** Walks a response SCHEMA: `properties` and `items` only (the document uses no `$ref`/`allOf`). */
function folhasDoSchema(schema, caminho, anotar) {
  if (schema === null || typeof schema !== 'object') {
    anotar(caminho, 'desconhecido', 'schema');
    return;
  }
  for (const proibida of ['$ref', 'allOf', 'oneOf', 'anyOf', 'additionalProperties']) {
    if (proibida in schema) throw new Error(`folhas does not walk ${proibida}; extend it first`);
  }
  const propriedades = schema.properties;
  if (propriedades && typeof propriedades === 'object' && Object.keys(propriedades).length > 0) {
    for (const [chave, filho] of Object.entries(propriedades)) {
      folhasDoSchema(filho, juntar(caminho, segmentoValido(chave)), anotar);
    }
    return;
  }
  if (schema.items && typeof schema.items === 'object' && Object.keys(schema.items).length > 0) {
    folhasDoSchema(schema.items, juntar(caminho, '*'), anotar);
    return;
  }
  for (const tipo of tiposDoSchema(schema)) anotar(caminho, tipo, 'schema');
}

/** Walks an EXAMPLE value, recording its JSON type at each leaf — the value itself is dropped. */
function folhasDoExemplo(valor, caminho, anotar) {
  if (valor === null) anotar(caminho, 'null', 'exemplo');
  else if (Array.isArray(valor)) {
    if (valor.length === 0) anotar(caminho, 'array', 'exemplo');
    for (const item of valor) folhasDoExemplo(item, juntar(caminho, '*'), anotar);
  } else if (typeof valor === 'object') {
    const chaves = Object.keys(valor);
    if (chaves.length === 0) anotar(caminho, 'object', 'exemplo');
    for (const chave of chaves) folhasDoExemplo(valor[chave], juntar(caminho, segmentoValido(chave)), anotar);
  } else if (typeof valor === 'number') {
    anotar(caminho, Number.isInteger(valor) ? 'integer' : 'number', 'exemplo');
  } else anotar(caminho, typeof valor, 'exemplo');
}

/** Every 2xx `application/json` response of one operation: its schema and its examples. */
function folhasDaOperacao(spec, metodo, caminhoHttp) {
  const op = spec.paths?.[caminhoHttp]?.[metodo.toLowerCase()];
  if (!op) throw new Error(`no operation ${metodo} ${caminhoHttp} — run: node li-doc.mjs paths`);
  const folhas = new Map();
  const anotar = (caminho, tipo, fonte) => {
    const f = folhas.get(caminho) ?? { tipos: new Set(), fontes: new Set() };
    f.tipos.add(tipo);
    f.fontes.add(fonte);
    folhas.set(caminho, f);
  };
  let respostas = 0;
  for (const [status, resposta] of Object.entries(op.responses ?? {})) {
    if (!/^2\d\d$/.test(status)) continue;
    const midia = resposta?.content?.['application/json'];
    if (!midia) continue;
    respostas += 1;
    if (midia.schema) folhasDoSchema(midia.schema, '', anotar);
    if ('example' in midia) folhasDoExemplo(midia.example, '', anotar);
    for (const exemplo of Object.values(midia.examples ?? {})) {
      if (exemplo && typeof exemplo === 'object' && 'value' in exemplo) {
        folhasDoExemplo(exemplo.value, '', anotar);
      }
    }
  }
  if (respostas === 0) throw new Error(`${metodo} ${caminhoHttp} documents no 2xx JSON response`);
  const ordenar = (s) => [...s].sort();
  return [...folhas.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([caminho, f]) => [caminho, ordenar(f.tipos), ordenar(f.fontes)]);
}

/**
 * One leaf per line, so a regenerated inventory diffs leaf by leaf. Written with LF and a
 * trailing newline; `.prettierignore` and `.gitattributes` leave those bytes to this generator.
 */
function serializarInventario(inventario) {
  const linhas = ['{'];
  linhas.push(`  "gerador": ${JSON.stringify(inventario.gerador)},`);
  linhas.push(`  "especificacao": ${JSON.stringify(inventario.especificacao)},`);
  linhas.push('  "operacoes": [');
  inventario.operacoes.forEach((op, i) => {
    linhas.push('    {');
    linhas.push(`      "metodo": ${JSON.stringify(op.metodo)},`);
    linhas.push(`      "caminho": ${JSON.stringify(op.caminho)},`);
    linhas.push('      "folhas": [');
    op.folhas.forEach((folha, j) => {
      linhas.push(`        ${JSON.stringify(folha)}${j < op.folhas.length - 1 ? ',' : ''}`);
    });
    linhas.push('      ]');
    linhas.push(`    }${i < inventario.operacoes.length - 1 ? ',' : ''}`);
  });
  linhas.push('  ]');
  linhas.push('}');
  return `${linhas.join('\n')}\n`;
}

function comandoFolhas(args) {
  if (refresh) throw new Error('folhas reads the cached copy only; run --refresh with another command first');
  if (!existsSync(SPEC_FILE) || !existsSync(META_FILE)) {
    throw new Error('no cached document: run `node li-doc.mjs meta` first (that command may download it)');
  }
  const resto = [...args];
  let saida = null;
  const i = resto.indexOf('--saida');
  if (i !== -1) {
    saida = resto[i + 1];
    if (!saida) throw new Error('--saida needs a file');
    resto.splice(i, 2);
  }
  // No pairs: regenerate the operations the existing inventory already lists.
  if (resto.length === 0 && saida && existsSync(saida)) {
    for (const op of JSON.parse(readFileSync(saida, 'utf8')).operacoes ?? []) {
      resto.push(op.metodo, op.caminho);
    }
  }
  if (resto.length === 0 || resto.length % 2 !== 0) {
    throw new Error('folhas needs <METHOD> <path> pairs, e.g. folhas GET /v1/pedido/search');
  }
  const bytes = readFileSync(SPEC_FILE);
  const spec = JSON.parse(bytes.toString('utf8'));
  const meta = JSON.parse(readFileSync(META_FILE, 'utf8'));
  const operacoes = [];
  for (let k = 0; k < resto.length; k += 2) {
    const metodo = resto[k].toUpperCase();
    const caminho = resto[k + 1];
    operacoes.push({ metodo, caminho, folhas: folhasDaOperacao(spec, metodo, caminho) });
  }
  const texto = serializarInventario({
    gerador: 'li-doc.mjs folhas',
    especificacao: {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      ultimaModificacao: meta.lastModified ?? null,
    },
    operacoes,
  });
  if (saida) writeFileSync(saida, texto);
  else process.stdout.write(texto);
}

if (cmd === 'folhas') {
  comandoFolhas(args);
  process.exit(process.exitCode ?? 0);
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
