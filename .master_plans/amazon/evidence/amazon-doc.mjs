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
//   node amazon-doc.mjs refresh                     # drop the cache
//
// `model` is a key from `models`; without it every registered model is searched.

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

async function load(path) {
  const file = join(CACHE, path.replace(/[\\/]/g, '__'));
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const res = await fetch(RAW + path, { redirect: 'error' });
  if (!res.ok) throw new Error(`GET ${RAW + path} → HTTP ${res.status}`);
  const text = await res.text();
  const json = JSON.parse(text);
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(file, text);
  return json;
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

const [cmd, a, b] = process.argv.slice(2);
try {
  if (cmd === 'models') for (const [k, p] of Object.entries(MODELS)) console.log(`${k.padEnd(14)} ${p}`);
  else if (cmd === 'op' && a) await cmdOp(a, b);
  else if (cmd === 'def' && a) await cmdDef(a, b);
  else if (cmd === 'sandbox' && a) await cmdSandbox(a, b);
  else if (cmd === 'notif' && a) await cmdNotif(a);
  else if (cmd === 'refresh') rmSync(CACHE, { recursive: true, force: true });
  else {
    console.error('usage: node amazon-doc.mjs models | op <operationId> [model] | def <Definition> [model] | sandbox <operationId> [model] | notif <SchemaName> | refresh');
    process.exitCode = 2;
  }
} catch (err) {
  if (err instanceof Error && /HTTP|not found|unknown model/.test(err.message)) {
    console.error(err.message);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
