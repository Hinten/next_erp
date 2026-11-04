#!/usr/bin/env node
// amazon-doc.mjs — prints parts of Amazon's official SP-API OpenAPI models
// (github.com/amzn/selling-partner-api-models) as plain text, for Phase-3 step
// planning. Read-only: it fetches public JSON from raw.githubusercontent.com and
// caches it under ./cache/ (gitignored). It never calls the SP-API itself.
//
// Usage (Node >= 22, no dependencies):
//   node amazon-doc.mjs models                      # list the registered model files
//   node amazon-doc.mjs op <operationId> [model]    # method, path, params, rate limit, responses
//   node amazon-doc.mjs def <Definition> [model]    # one definition (schema) as JSON
//   node amazon-doc.mjs sandbox <operationId> [model] # the x-amzn-api-sandbox cases
//   node amazon-doc.mjs notif <SchemaName>          # schemas/notifications/<SchemaName>.json
//   node amazon-doc.mjs folhas [--saida <file>]     # the step-2b leaf inventory (paths + types only)
//   node amazon-doc.mjs exemplo <operationId> <model> <n> --saida <abs> --nome <nome>
//                                                   # ONE sandbox case as a capture pair (2b-b)
//   node amazon-doc.mjs notif-exemplo <SchemaName> <n> --saida <abs> --nome <nome>
//                                                   # ONE notification example as a capture pair
//   node amazon-doc.mjs refresh                     # drop the cache
//
// `model` is a key from `models`; without it every registered model is searched.
//
// `folhas` writes the leaf inventory `apps/amazon/lib/amazon/testing/especificacaoFolhas.json`
// reads (step-2b plan, PR 2b-a): run from the repo root,
//   node .master_plans/amazon/evidence/amazon-doc.mjs folhas --saida apps/amazon/lib/amazon/testing/especificacaoFolhas.json
// It holds leaf PATHS and JSON TYPES, plus Amazon's literal error codes, and never a value
// of an example. It reads the cache (or raw.githubusercontent.com), never the SP-API.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAW = 'https://raw.githubusercontent.com/amzn/selling-partner-api-models/main/';
const CACHE = join(dirname(fileURLToPath(import.meta.url)), 'cache');

/** The model files the Amazon master plan relies on. */
const MODELS = {
  orders: 'models/orders-api-model/orders_2026-01-01.json',
  ordersV0: 'models/orders-api-model/ordersV0.json',
  notifications: 'models/notifications-api-model/notifications.json',
  listings: 'models/listings-items-api-model/listingsItems_2021-08-01.json',
  feeds: 'models/feeds-api-model/feeds_2021-06-30.json',
  reports: 'models/reports-api-model/reports_2021-06-30.json',
  easyShip: 'models/easy-ship-model/easyShip_2022-03-23.json',
  delivery: 'models/delivery-by-amazon/deliveryShipmentInvoiceV2022-07-01.json',
  tokens: 'models/tokens-api-model/tokens_2021-03-01.json',
  sellers: 'models/sellers-api-model/sellers.json',
  catalog: 'models/catalog-items-api-model/catalogItems_2022-04-01.json',
  productTypes: 'models/product-type-definitions-api-model/definitionsProductTypes_2020-09-01.json',
  application: 'models/application-management-api-model/application_2023-11-30.json',
  finances: 'models/finances-api-model/finances_2024-06-19.json',
  efShipments: 'models/external-fulfillment/externalFulfillmentShipments_2024-09-11.json',
  efReturns: 'models/external-fulfillment/externalFulfillmentReturns_2024-09-11.json',
};

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** The raw bytes of one model file: the cache first, else raw.githubusercontent.com (cached). */
async function loadText(path) {
  const file = join(CACHE, path.replace(/[\\/]/g, '__'));
  if (existsSync(file)) return readFileSync(file, 'utf8');
  const res = await fetch(RAW + path, { redirect: 'error' });
  if (!res.ok) throw new Error(`GET ${RAW + path} → HTTP ${res.status}`);
  const text = await res.text();
  JSON.parse(text);
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(file, text);
  return text;
}

async function load(path) {
  return JSON.parse(await loadText(path));
}

function keysFor(modelKey) {
  if (!modelKey) return Object.keys(MODELS);
  if (!MODELS[modelKey]) throw new Error(`unknown model "${modelKey}"; run: node amazon-doc.mjs models`);
  return [modelKey];
}

async function findOperation(operationId, modelKey) {
  for (const key of keysFor(modelKey)) {
    const spec = await load(MODELS[key]);
    for (const [path, item] of Object.entries(spec.paths ?? {})) {
      for (const method of METHODS) {
        const op = item[method];
        if (op && op.operationId === operationId) return { key, spec, path, method, op, item };
      }
    }
  }
  throw new Error(`operationId "${operationId}" not found in ${keysFor(modelKey).join(', ')}`);
}

function oneLine(text, max = 400) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

async function cmdOp(operationId, modelKey) {
  const { key, spec, path, method, op, item } = await findOperation(operationId, modelKey);
  console.log(`${method.toUpperCase()} ${path}   [${key}: ${MODELS[key]}]`);
  console.log(`host: ${spec.host ?? '(servers)'}   version: ${spec.info?.version}`);
  if (op.deprecated) console.log('⚠️ deprecated: true');
  console.log(`\n${oneLine(op.description, 1200)}\n`);
  const params = [...(item.parameters ?? []), ...(op.parameters ?? [])];
  for (const p of params) {
    const ref = p.$ref ? ` ${p.$ref}` : '';
    const type = p.type ?? (p.schema ? (p.schema.$ref ?? p.schema.type) : '');
    const en = p.items?.enum ?? p.enum;
    console.log(`  ${p.in ?? '?'} ${p.name ?? ''}${p.required ? '*' : ''} ${type ?? ''}${ref}${en ? ` enum=${en.join('|')}` : ''}`);
  }
  console.log('\nresponses:');
  for (const [code, r] of Object.entries(op.responses ?? {})) {
    console.log(`  ${code}: ${r.schema?.$ref ?? r.schema?.type ?? ''} ${oneLine(r.description, 120)}`);
  }
}

async function cmdDef(name, modelKey) {
  for (const key of keysFor(modelKey)) {
    const spec = await load(MODELS[key]);
    const def = spec.definitions?.[name] ?? spec.components?.schemas?.[name];
    if (def) {
      console.log(`[${key}: ${MODELS[key]}] definitions.${name}`);
      console.log(JSON.stringify(def, null, 2));
      return;
    }
  }
  throw new Error(`definition "${name}" not found in ${keysFor(modelKey).join(', ')}`);
}

async function cmdSandbox(operationId, modelKey) {
  const { key, path, method, op } = await findOperation(operationId, modelKey);
  console.log(`${method.toUpperCase()} ${path}   [${key}]`);
  for (const [code, r] of Object.entries(op.responses ?? {})) {
    const sb = r['x-amzn-api-sandbox'];
    if (!sb) continue;
    for (const kind of ['static', 'dynamic']) {
      for (const [i, c] of (sb[kind] ?? []).entries()) {
        console.log(`\n--- ${code} ${kind}[${i}] request:`);
        console.log(JSON.stringify(c.request ?? {}, null, 2));
        console.log(`--- response:`);
        console.log(JSON.stringify(c.response ?? {}, null, 2));
      }
    }
  }
}

async function cmdNotif(schemaName) {
  const json = await load(`schemas/notifications/${schemaName}.json`);
  console.log(`[schemas/notifications/${schemaName}.json]`);
  console.log(JSON.stringify(json, null, 2));
}

// ---------------------------------------------------------------------------
// folhas: the leaf inventory of the step-2b redaction tables. Paths and JSON
// types only, never a value; plus the literal `errors[].code` values the
// in-scope models' examples carry (Amazon's own error codes, not data).
// ---------------------------------------------------------------------------

/** The operations whose 2xx and error bodies the step-2b tables classify. `erro` = every non-2xx schema, merged. */
const OPERACOES_FOLHAS = [
  { modelo: 'orders', operationId: 'searchOrders', status: ['200', 'erro'] },
  { modelo: 'orders', operationId: 'getOrder', status: ['200', 'erro'] },
  { modelo: 'delivery', operationId: 'getInvoiceStatus', status: ['200', 'erro'] },
  { modelo: 'delivery', operationId: 'submitInvoice', status: ['200', 'erro'] },
  { modelo: 'easyShip', operationId: 'createScheduledPackageBulk', status: ['200', 'erro'] },
  { modelo: 'easyShip', operationId: 'getScheduledPackage', status: ['200', 'erro'] },
  { modelo: 'tokens', operationId: 'createRestrictedDataToken', status: ['200'] },
];

/** Notification schemas (`schemas/notifications/<name>.json`), inventoried as status `notificacao`. */
const NOTIFICACOES_FOLHAS = [{ modelo: 'orderChange', schema: 'OrderChangeNotification' }];

/** The operations whose BR sandbox cases `apps/amazon/lib/amazon/testing/sandboxBr.ts` transcribes. */
const EXEMPLOS_BR = ['searchOrders', 'getOrder'];

/** Amazon's public marketplace id of the BR store: how a BR sandbox case is recognised. */
const MARKETPLACE_BR = 'A2Q3Y263D00KWC';

/** One path segment per object key; `*` stands for an array index or an open map's key. */
const juntarFolha = (caminho, segmento) => (caminho === '' ? segmento : `${caminho}.${segmento}`);

function segmentoDeFolha(chave) {
  // A key holding `.` or `*`, or an empty one, would make two leaves share one path.
  if (chave === '' || chave.includes('.') || chave === '*') {
    throw new Error(`a key the inventory cannot spell unambiguously, under a ${chave.length}-char name`);
  }
  return chave;
}

/** `#/definitions/X` → `X`; anything else, or a missing definition, refuses the run. */
function nomeDaRef(spec, ref) {
  const prefixo = '#/definitions/';
  const nome = typeof ref === 'string' && ref.startsWith(prefixo) ? ref.slice(prefixo.length) : null;
  if (nome === null || !spec.definitions || !Object.hasOwn(spec.definitions, nome)) {
    throw new Error(`folhas: unresolvable $ref ${JSON.stringify(ref)}`);
  }
  return nome;
}

function tipoDoSchema(schema) {
  if (Array.isArray(schema.type)) return [...schema.type].sort().join('|');
  return typeof schema.type === 'string' ? schema.type : 'desconhecido';
}

/**
 * `allOf` as ONE schema: each branch resolved (one `$ref` level; deeper refs are
 * resolved by the walk), its `properties` unioned, the first `items`,
 * `additionalProperties` or `type` kept. The branch names join the cycle stack.
 */
function mesclarAllOf(spec, schema, pilha) {
  const nomes = [];
  const mesclado = { properties: {} };
  const ramos = [...schema.allOf, { ...schema, allOf: undefined }];
  for (let ramo of ramos) {
    if (ramo && typeof ramo.$ref === 'string') {
      const nome = nomeDaRef(spec, ramo.$ref);
      nomes.push(nome);
      ramo = spec.definitions[nome];
    }
    if (!ramo || typeof ramo !== 'object') continue;
    if (ramo.allOf) throw new Error('folhas: nested allOf; extend the generator first');
    Object.assign(mesclado.properties, ramo.properties ?? {});
    for (const k of ['items', 'additionalProperties', 'type', 'oneOf', 'anyOf']) {
      if (mesclado[k] === undefined && ramo[k] !== undefined) mesclado[k] = ramo[k];
    }
  }
  return { schema: mesclado, pilha: [...pilha, ...nomes] };
}

/**
 * Walks a response SCHEMA: `$ref` (a cycle is cut with a `ciclo` leaf), `allOf`
 * (merged), `oneOf`/`anyOf` (the union of the branches), `properties`, `items`
 * and `additionalProperties` (an open map, one `*` leaf of type `aberto`).
 */
function folhasDoSchemaAmazon(spec, schema, caminho, anotar, pilha) {
  if (schema === null || typeof schema !== 'object') {
    anotar(caminho, 'desconhecido');
    return;
  }
  if (typeof schema.$ref === 'string') {
    const nome = nomeDaRef(spec, schema.$ref);
    if (pilha.includes(nome)) {
      anotar(caminho, 'ciclo');
      return;
    }
    folhasDoSchemaAmazon(spec, spec.definitions[nome], caminho, anotar, [...pilha, nome]);
    return;
  }
  if (Array.isArray(schema.allOf)) {
    const m = mesclarAllOf(spec, schema, pilha);
    folhasDoSchemaAmazon(spec, m.schema, caminho, anotar, m.pilha);
    return;
  }
  const ramos = [...(schema.oneOf ?? []), ...(schema.anyOf ?? [])];
  if (ramos.length > 0) {
    for (const ramo of ramos) folhasDoSchemaAmazon(spec, ramo, caminho, anotar, pilha);
    return;
  }
  const propriedades = schema.properties;
  const temPropriedades =
    propriedades && typeof propriedades === 'object' && Object.keys(propriedades).length > 0;
  const aberto =
    schema.additionalProperties === true ||
    (schema.additionalProperties !== null && typeof schema.additionalProperties === 'object');
  if (temPropriedades) {
    for (const [chave, filho] of Object.entries(propriedades)) {
      folhasDoSchemaAmazon(spec, filho, juntarFolha(caminho, segmentoDeFolha(chave)), anotar, pilha);
    }
  }
  if (aberto) anotar(juntarFolha(caminho, '*'), 'aberto');
  if (temPropriedades || aberto) return;
  if (schema.items && typeof schema.items === 'object') {
    folhasDoSchemaAmazon(spec, schema.items, juntarFolha(caminho, '*'), anotar, pilha);
    return;
  }
  anotar(caminho, tipoDoSchema(schema));
}

/** The leaf PATHS of an example value — the value itself is dropped. */
function caminhosDoExemplo(valor, caminho, saida) {
  if (Array.isArray(valor)) {
    if (valor.length === 0) saida.add(caminho);
    for (const item of valor) caminhosDoExemplo(item, juntarFolha(caminho, '*'), saida);
  } else if (valor !== null && typeof valor === 'object') {
    const chaves = Object.keys(valor);
    if (chaves.length === 0) saida.add(caminho);
    for (const chave of chaves) {
      caminhosDoExemplo(valor[chave], juntarFolha(caminho, segmentoDeFolha(chave)), saida);
    }
  } else saida.add(caminho);
}

/** Whether a value holds the BR marketplace id anywhere. */
function contemMarketplaceBr(valor) {
  if (valor === MARKETPLACE_BR) return true;
  if (Array.isArray(valor)) return valor.some(contemMarketplaceBr);
  if (valor !== null && typeof valor === 'object') return Object.values(valor).some(contemMarketplaceBr);
  return false;
}

/** Every `errors[].code` string inside an example value. */
function codigosDeErro(valor, saida) {
  if (Array.isArray(valor)) {
    for (const item of valor) codigosDeErro(item, saida);
  } else if (valor !== null && typeof valor === 'object') {
    for (const [chave, filho] of Object.entries(valor)) {
      if (chave === 'errors' && Array.isArray(filho)) {
        for (const e of filho) if (e && typeof e.code === 'string') saida.add(e.code);
      }
      codigosDeErro(filho, saida);
    }
  }
}

/** The sandbox cases (static and dynamic) and the `examples` of one response, as example values. */
function exemplosDaResposta(resposta) {
  const saida = [];
  const sb = resposta?.['x-amzn-api-sandbox'];
  for (const tipo of ['static', 'dynamic']) {
    for (const caso of sb?.[tipo] ?? []) saida.push({ caso, valor: caso?.response });
  }
  for (const valor of Object.values(resposta?.examples ?? {})) saida.push({ caso: null, valor });
  return saida;
}

const ehStatus2xx = (s) => /^2\d\d$/.test(s);

/** Leaves of one operation's responses of one status class, sorted. */
function folhasDaResposta(spec, op, classe) {
  const folhas = new Map();
  const anotar = (caminho, tipo) => {
    const tipos = folhas.get(caminho) ?? new Set();
    tipos.add(tipo);
    folhas.set(caminho, tipos);
  };
  let respostas = 0;
  for (const [status, resposta] of Object.entries(op.responses ?? {})) {
    if ((classe === '200') !== ehStatus2xx(status)) continue;
    if (!resposta?.schema) continue;
    respostas += 1;
    folhasDoSchemaAmazon(spec, resposta.schema, '', anotar, []);
  }
  if (respostas === 0) throw new Error(`folhas: ${op.operationId} documents no ${classe} schema`);
  return [...folhas.entries()]
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([caminho, tipos]) => ({ caminho, tipo: [...tipos].sort().join('|') }));
}

const sha256 = (texto) => createHash('sha256').update(Buffer.from(texto, 'utf8')).digest('hex');
const ordenado = (xs) => [...xs].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));

/** One leaf per line, LF, a trailing newline: a regeneration diffs leaf by leaf. */
function serializarFolhas(inv) {
  const l = ['{'];
  l.push(`  "geradoPor": ${JSON.stringify(inv.geradoPor)},`);
  l.push('  "modelos": {');
  const modelos = Object.keys(inv.modelos).sort();
  modelos.forEach((k, i) => {
    const virgula = i < modelos.length - 1 ? ',' : '';
    l.push(`    ${JSON.stringify(k)}: ${JSON.stringify(inv.modelos[k])}${virgula}`);
  });
  l.push('  },');
  l.push('  "operacoes": [');
  inv.operacoes.forEach((op, i) => {
    l.push('    {');
    l.push(`      "modelo": ${JSON.stringify(op.modelo)},`);
    l.push(`      "operationId": ${JSON.stringify(op.operationId)},`);
    l.push(`      "status": ${JSON.stringify(op.status)},`);
    l.push('      "folhas": [');
    op.folhas.forEach((f, j) => {
      l.push(`        ${JSON.stringify(f)}${j < op.folhas.length - 1 ? ',' : ''}`);
    });
    l.push('      ]');
    l.push(`    }${i < inv.operacoes.length - 1 ? ',' : ''}`);
  });
  l.push('  ],');
  l.push('  "exemplosBr": {');
  const ops = Object.keys(inv.exemplosBr).sort();
  ops.forEach((k, i) => {
    l.push(`    ${JSON.stringify(k)}: [`);
    const caminhos = inv.exemplosBr[k];
    caminhos.forEach((c, j) => l.push(`      ${JSON.stringify(c)}${j < caminhos.length - 1 ? ',' : ''}`));
    l.push(`    ]${i < ops.length - 1 ? ',' : ''}`);
  });
  l.push('  },');
  l.push('  "codigosDeErroDosExemplos": [');
  inv.codigosDeErroDosExemplos.forEach((c, j, xs) => {
    l.push(`    ${JSON.stringify(c)}${j < xs.length - 1 ? ',' : ''}`);
  });
  l.push('  ]');
  l.push('}');
  return `${l.join('\n')}\n`;
}

async function cmdFolhas(args) {
  let saida = null;
  const i = args.indexOf('--saida');
  if (i !== -1) {
    saida = args[i + 1];
    if (!saida) throw new Error('usage: folhas --saida <file>');
  }
  const modelos = {};
  const operacoes = [];
  const exemplosBr = {};
  const codigos = new Set();
  for (const { modelo, operationId, status } of OPERACOES_FOLHAS) {
    const texto = await loadText(MODELS[modelo]);
    modelos[modelo] = { arquivo: MODELS[modelo], sha256: sha256(texto) };
    const spec = JSON.parse(texto);
    const { op } = await findOperation(operationId, modelo);
    for (const classe of status) {
      operacoes.push({ modelo, operationId, status: classe, folhas: folhasDaResposta(spec, op, classe) });
    }
    const br = new Set();
    for (const [codigo, resposta] of Object.entries(op.responses ?? {})) {
      for (const { caso, valor } of exemplosDaResposta(resposta)) {
        codigosDeErro(valor, codigos);
        if (EXEMPLOS_BR.includes(operationId) && ehStatus2xx(codigo) && caso !== null) {
          if (contemMarketplaceBr(caso.response)) caminhosDoExemplo(caso.response, '', br);
        }
      }
    }
    if (EXEMPLOS_BR.includes(operationId)) {
      if (br.size === 0) throw new Error(`folhas: ${operationId} has no BR sandbox case`);
      exemplosBr[operationId] = ordenado(br);
    }
  }
  for (const { modelo, schema } of NOTIFICACOES_FOLHAS) {
    const arquivo = `schemas/notifications/${schema}.json`;
    const texto = await loadText(arquivo);
    modelos[modelo] = { arquivo, sha256: sha256(texto) };
    const json = JSON.parse(texto);
    const folhas = new Map();
    const anotar = (caminho, tipo) => {
      const tipos = folhas.get(caminho) ?? new Set();
      tipos.add(tipo);
      folhas.set(caminho, tipos);
    };
    folhasDoSchemaAmazon(json, json, '', anotar, []);
    for (const exemplo of json.examples ?? []) codigosDeErro(exemplo, codigos);
    operacoes.push({
      modelo,
      operationId: schema,
      status: 'notificacao',
      folhas: [...folhas.entries()]
        .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
        .map(([caminho, tipos]) => ({ caminho, tipo: [...tipos].sort().join('|') })),
    });
  }
  const texto = serializarFolhas({
    geradoPor: 'amazon-doc.mjs folhas',
    modelos,
    operacoes,
    exemplosBr,
    codigosDeErroDosExemplos: ordenado(codigos),
  });
  if (saida) writeFileSync(saida, texto);
  else process.stdout.write(texto);
}

// ---------------------------------------------------------------------------
// exemplo / notif-exemplo: ONE model example as a capture pair (step-2b plan,
// PR 2b-b) — `<nome>.json` (the example body) + `<nome>.txt` (the sidecar,
// `credencial: modelo-sandbox`, `papeis: nao-se-aplica`) — for the capture
// sanitizer's starting corpus. A model example is public documentation, never
// production data; the sanitizer still fakes its ids on the way in. The pair is
// written OUTSIDE every git checkout (refused otherwise), like an owner capture.
// ---------------------------------------------------------------------------

const NOME_DE_CAPTURA = /^[a-z0-9-]{1,40}$/;

/** `--saida <abs folder>` and `--nome <capture name>`, both required. */
function destinoDoExemplo(args, comando) {
  const valor = (flag) => {
    const i = args.indexOf(flag);
    const v = i === -1 ? undefined : args[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`${comando}: ${flag} is required`);
    return v;
  };
  const saida = valor('--saida');
  const nome = valor('--nome');
  if (!isAbsolute(saida)) throw new Error(`${comando}: --saida must be an absolute folder`);
  if (!NOME_DE_CAPTURA.test(nome)) throw new Error(`${comando}: --nome is a-z, 0-9 and -, at most 40`);
  let pasta = resolve(saida);
  for (;;) {
    if (existsSync(join(pasta, '.git'))) {
      throw new Error(`${comando}: --saida is inside a git checkout; write the pair outside every checkout`);
    }
    const acima = dirname(pasta);
    if (acima === pasta) break;
    pasta = acima;
  }
  mkdirSync(saida, { recursive: true });
  return { saida, nome };
}

function escreverPar({ saida, nome }, corpo, linha1) {
  const data = new Date().toISOString().slice(0, 10);
  writeFileSync(join(saida, `${nome}.json`), JSON.stringify(corpo));
  writeFileSync(
    join(saida, `${nome}.txt`),
    `${linha1}\ncredencial: modelo-sandbox\npapeis: nao-se-aplica\ndata: ${data}\n`,
  );
  console.log(`${nome}: ${linha1}`);
}

/** A parameter definition, through `#/parameters/X` when it is a reference. */
function parametro(spec, p) {
  const prefixo = '#/parameters/';
  if (typeof p?.$ref === 'string' && p.$ref.startsWith(prefixo)) {
    return spec.parameters?.[p.$ref.slice(prefixo.length)] ?? null;
  }
  return p;
}

/** Every sandbox case of an operation, in response-code order, static then dynamic. */
function casosDoSandbox(op) {
  const casos = [];
  for (const [codigo, r] of Object.entries(op.responses ?? {})) {
    const sb = r?.['x-amzn-api-sandbox'];
    for (const tipo of ['static', 'dynamic']) {
      for (const caso of sb?.[tipo] ?? []) casos.push({ codigo, caso });
    }
  }
  return casos;
}

/** exemplo <operationId> <model> <n> --saida <abs> --nome <nome>: the n-th sandbox case (0-based). */
async function cmdExemplo(operationId, modelKey, n, args) {
  if (!operationId || !modelKey || !/^\d+$/.test(n ?? '')) {
    throw new Error('exemplo: usage: exemplo <operationId> <model> <n> --saida <abs> --nome <nome>');
  }
  const destino = destinoDoExemplo(args, 'exemplo');
  const { spec, path, method, op, item } = await findOperation(operationId, modelKey);
  const casos = casosDoSandbox(op);
  const escolhido = casos[Number(n)];
  if (!escolhido) throw new Error(`exemplo: ${operationId} has ${casos.length} sandbox case(s)`);
  const valores = escolhido.caso?.request?.parameters ?? {};
  const definicoes = [...(item.parameters ?? []), ...(op.parameters ?? [])]
    .map((p) => parametro(spec, p))
    .filter((p) => p && typeof p.name === 'string');
  const emLista = (v) => (Array.isArray(v) ? v.map((x) => encodeURIComponent(String(x))).join(',') : encodeURIComponent(String(v)));
  let caminho = path;
  const query = [];
  for (const def of definicoes) {
    if (!Object.hasOwn(valores, def.name)) continue;
    const v = valores[def.name]?.value;
    if (def.in === 'path') caminho = caminho.replace(`{${def.name}}`, encodeURIComponent(String(v)));
    else if (def.in === 'query') query.push(`${encodeURIComponent(def.name)}=${emLista(v)}`);
  }
  if (/\{[^}]+\}/.test(caminho)) throw new Error('exemplo: a path parameter has no value in that case');
  const url = query.length === 0 ? caminho : `${caminho}?${query.join('&')}`;
  escreverPar(destino, escolhido.caso?.response ?? {}, `${method.toUpperCase()} ${url} ${escolhido.codigo}`);
}

/** Notification schemas the sanitizer accepts, by their pseudo-line's type. */
const NOTIFICACOES_EXEMPLO = { OrderChangeNotification: 'ORDER_CHANGE' };

/** notif-exemplo <SchemaName> <n> --saida <abs> --nome <nome>: the schema's n-th example, as an SQS message body. */
async function cmdNotifExemplo(schema, n, args) {
  const tipo = NOTIFICACOES_EXEMPLO[schema];
  if (!tipo || !/^\d+$/.test(n ?? '')) {
    throw new Error(`notif-exemplo: usage: notif-exemplo <${Object.keys(NOTIFICACOES_EXEMPLO).join('|')}> <n> --saida <abs> --nome <nome>`);
  }
  const destino = destinoDoExemplo(args, 'notif-exemplo');
  const json = await load(`schemas/notifications/${schema}.json`);
  const exemplo = (json.examples ?? [])[Number(n)];
  if (exemplo === undefined) throw new Error(`notif-exemplo: ${schema} has ${(json.examples ?? []).length} example(s)`);
  escreverPar(destino, exemplo, `NOTIFICACAO ${tipo} sqs`);
}

const [cmd, a, b] = process.argv.slice(2);
try {
  if (cmd === 'models') for (const [k, p] of Object.entries(MODELS)) console.log(`${k.padEnd(14)} ${p}`);
  else if (cmd === 'folhas') await cmdFolhas(process.argv.slice(3));
  else if (cmd === 'exemplo') await cmdExemplo(a, b, process.argv[5], process.argv.slice(6));
  else if (cmd === 'notif-exemplo') await cmdNotifExemplo(a, b, process.argv.slice(5));
  else if (cmd === 'op' && a) await cmdOp(a, b);
  else if (cmd === 'def' && a) await cmdDef(a, b);
  else if (cmd === 'sandbox' && a) await cmdSandbox(a, b);
  else if (cmd === 'notif' && a) await cmdNotif(a);
  else if (cmd === 'refresh') rmSync(CACHE, { recursive: true, force: true });
  else {
    console.error('usage: node amazon-doc.mjs models | op <operationId> [model] | def <Definition> [model] | sandbox <operationId> [model] | notif <SchemaName> | folhas [--saida <file>] | exemplo <operationId> <model> <n> --saida <abs> --nome <nome> | notif-exemplo <SchemaName> <n> --saida <abs> --nome <nome> | refresh');
    process.exitCode = 2;
  }
} catch (err) {
  if (err instanceof Error && /HTTP|not found|unknown model|^folhas:|^exemplo:|^notif-exemplo:|usage:|cannot spell/.test(err.message)) {
    console.error(err.message);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
