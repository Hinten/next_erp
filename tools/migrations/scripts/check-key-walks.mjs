/* eslint-disable no-console -- CLI script: stdout is the interface */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cert, initializeApp } from 'firebase-admin/app';
import { FieldPath, getFirestore } from 'firebase-admin/firestore';

// The Enterprise plan reader and the key-page verdict live in ONE module, shared
// with the arquivo sweep's and the Mercado Livre stock gates (the #1369 rule).
// Plain `.mjs`, so bare node imports it by relative path.
import {
  contadoresDoCabecalho,
  indicesUsados,
  julgarPaginaPorChave,
  parseAccessNodes,
} from '../../../apps/mercado-livre/lib/firebase/explainPlan.mjs';

// Live check that every migration walk by document key rides its declared key
// index (#1895) — run it after an index deploy and BEFORE the migrations, on the
// project they will run against (staging rehearsal; the NEW project inside the
// cutover window, right after #1208's "Deploy indexes" step).
//
// Why: Firestore Enterprise creates NO index by itself, not even on the document
// key. The migrations page whole collections with `orderBy(documentId())`, and
// without a `__name__ ASC` index each page walks some other index end to end and
// sorts in memory — #1874 measured 313 index rows read per page of 100. That is
// a walk of N²/page instead of N, inside the window. `key-walks.json` lists every
// walk; `src/keyWalks.indexes.test.ts` pins it against the source and
// `firestore.indexes.json` offline; this proves the planner actually uses them.
//
// For each (collection, scope) in key-walks.json it explains page 1 and — when
// page 1 is full — a cursor page, through the SDK's pipeline translation
// (`createFrom`; Enterprise refuses classic `explain()`), and judges each with
// `julgarPaginaPorChave`: on the key index, no sort cutting its input, at most the
// page read. `analyze` EXECUTES each page (billed as a normal read: ≤ 2 pages per
// collection).
//
//   node --env-file=../../.env.local scripts/check-key-walks.mjs --project <id> [--page 300] [--only <collection>] [--plans]
//
// Credentials as every migration takes them (src/admin.ts): FIREBASE_SERVICE_ACCOUNT_PATH
// (relative to the cwd or the repo root) or FIREBASE_SERVICE_ACCOUNT (inline JSON).
// `--project` is REQUIRED and must match the service account — never inferred.
// Database: FIREBASE_DATABASE_ID ?? 'default'.
//
// Exit code: 1 when any walk FAILS, 2 when none fails but some collection is
// empty (no rows ⇒ no plan ⇒ unverified), 0 only when every walk is proven.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function arg(nome) {
  const i = process.argv.indexOf(`--${nome}`);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}
const projectId = arg('project');
if (!projectId) {
  console.error('--project <id> is required (never inferred from the environment).');
  process.exit(1);
}
const PAGE = Number(arg('page') ?? '300');
if (!Number.isInteger(PAGE) || PAGE < 1) {
  console.error(`--page must be a positive integer, got ${arg('page')}`);
  process.exit(1);
}
const only = arg('only');
const imprimirPlanos = process.argv.includes('--plans');
if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST is set — the Standard emulator has no Enterprise plans.');
  process.exit(1);
}

function contaDeServico() {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  const caminho = process.env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim();
  if (caminho) {
    const candidatos = isAbsolute(caminho)
      ? [caminho]
      : [resolve(caminho), resolve(repoRoot, caminho)];
    const achado = candidatos.find((c) => existsSync(c));
    if (achado == null)
      throw new Error(`Service account not found. Tried: ${candidatos.join(', ')}`);
    return JSON.parse(readFileSync(achado, 'utf8'));
  }
  if (inline) return JSON.parse(inline);
  throw new Error('Provide FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_SERVICE_ACCOUNT.');
}

const sa = contaDeServico();
if (sa.project_id && sa.project_id !== projectId) {
  console.error(
    `Service account project "${sa.project_id}" does not match --project "${projectId}" — refusing.`,
  );
  process.exit(1);
}
const app = initializeApp({ credential: cert(sa), projectId }, 'check-key-walks');
const db = getFirestore(app, process.env.FIREBASE_DATABASE_ID?.trim() || 'default');

const { walks } = JSON.parse(readFileSync(new URL('../key-walks.json', import.meta.url), 'utf8'));
/** Distinct (collection, scope), with the scripts that walk it. */
const alvos = new Map();
for (const w of walks) {
  if (only != null && w.collection !== only) continue;
  const k = `${w.scope} ${w.collection}`;
  const alvo = alvos.get(k) ?? { collection: w.collection, scope: w.scope, scripts: [] };
  alvo.scripts.push(w.script);
  alvos.set(k, alvo);
}

/** A server-side rejection carries a numeric gRPC status; anything else is a bug here. */
function isGrpcCodedError(err) {
  if (!(err instanceof Error)) return false;
  const code = /** @type {{ code?: unknown }} */ (err).code;
  return typeof code === 'number' && Number.isInteger(code) && code >= 1 && code <= 16;
}

/** The walk's page, as every migration builds it — minus any `select()` (createFrom quirk). */
function pagina({ collection, scope }, cursor) {
  const base =
    scope === 'COLLECTION_GROUP' ? db.collectionGroup(collection) : db.collection(collection);
  let q = base.orderBy(FieldPath.documentId()).limit(PAGE);
  if (cursor != null) q = q.startAfter(cursor);
  return q;
}

async function explicar(query) {
  try {
    const snap = await db
      .pipeline()
      .createFrom(query)
      .execute({ explainOptions: { mode: 'analyze', outputFormat: 'text' } });
    const plano = snap.explainStats?.text ?? '';
    return { plano: plano.trim() === '' ? null : plano, linhas: snap.results, erro: null };
  } catch (err) {
    if (!isGrpcCodedError(err)) throw err;
    return { plano: null, linhas: [], erro: err.message };
  }
}

const falhas = [];
const vazias = [];

for (const alvo of alvos.values()) {
  const rotulo = `${alvo.scope === 'COLLECTION_GROUP' ? 'collectionGroup' : 'collection'}(${alvo.collection})`;
  const paginas = [{ nome: 'page 1', cursor: null }];
  for (let i = 0; i < paginas.length; i += 1) {
    const { nome, cursor } = paginas[i];
    const { plano, linhas, erro } = await explicar(pagina(alvo, cursor));
    if (erro != null) {
      falhas.push(`${rotulo} ${nome}`);
      console.error(`FAIL  ${rotulo} ${nome}: the proxy was refused — ${erro}`);
      continue;
    }
    if (plano == null) {
      if (i === 0) {
        vazias.push(rotulo);
        console.warn(
          `EMPTY ${rotulo}: no rows, so no plan — unverified (walked by ${alvo.scripts.join(', ')})`,
        );
      }
      continue;
    }
    const c = contadoresDoCabecalho(plano);
    const v = julgarPaginaPorChave(plano, {
      escopo: alvo.scope,
      colecao: alvo.collection,
      pagina: PAGE,
    });
    // Entity rows too: a TableScan (no index at all) prints no index counter, and
    // its cost is whole DOCUMENTS read — the worst shape this can find.
    const resumo =
      `returned ${c['results returned'] ?? '?'}, index rows scanned ${c['index row scanned'] ?? '-'}, ` +
      `entity rows scanned ${c['entity row scanned'] ?? '-'}, read units ${c['read units'] ?? '?'} — ` +
      `rides ${indicesUsados(parseAccessNodes(plano)).join(' | ') || '(no index: a table scan)'}`;
    if (v.motivos.length === 0) {
      console.log(`PASS  ${rotulo} ${nome}: ${resumo}`);
      if (imprimirPlanos) console.log(plano);
    } else {
      falhas.push(`${rotulo} ${nome}`);
      console.error(`FAIL  ${rotulo} ${nome}: ${resumo}`);
      for (const m of v.motivos) console.error(`      [${m.codigo}] ${m.mensagem}`);
      console.error(plano);
    }
    // A full first page means a second one exists: probe the CURSOR too — a
    // cursor tested per entry instead of seeked is the quadratic walk in disguise.
    const ultima = linhas[linhas.length - 1]?.ref ?? null;
    if (i === 0 && linhas.length === PAGE && ultima != null) {
      paginas.push({ nome: 'page 2 (cursor)', cursor: ultima });
    }
  }
}

console.log(
  `\n${alvos.size} walked collection(s); ${falhas.length} failing page(s); ${vazias.length} empty.`,
);
if (falhas.length > 0) {
  console.error(`❌ ${falhas.join('; ')}`);
  process.exit(1);
}
if (vazias.length > 0) {
  console.warn(`⚠️  no failure, but unverified (empty): ${vazias.join('; ')}`);
  process.exit(2);
}
console.log('✅ every migration key walk rides its key index');
process.exit(0);
