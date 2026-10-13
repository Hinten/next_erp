/* eslint-disable no-console -- CLI script: stdout is the interface */
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cert, initializeApp } from 'firebase-admin/app';
import { FieldPath, Filter, getFirestore } from 'firebase-admin/firestore';

// The Enterprise plan-text readers live in ONE module, shared with the Mercado
// Livre stock gate and its staging suite (the #1369 rule — two copies of a parser
// drift toward plausible while disagreeing). Plain `.mjs`, so bare node imports it.
import {
  RECUSA_EXPLAIN_ENTERPRISE_RE,
  contadoresDoCabecalho,
  parseAccessNodes,
  scansSemIdentificador,
  sortsQueCortam,
} from '../../mercado-livre/lib/firebase/explainPlan.mjs';

// Live diagnostic: prove every query `reconcileArquivoOrphans` runs is
// index-backed, NOT a collection scan. This Firestore Enterprise edition creates
// NO index automatically — not even one on the document key — and an unindexed
// query does not fail: it scans, and Enterprise bills the data scanned. Checked:
//
//  1. the phantom sweep          → `arquivos(uploadState, criadoEm)`
//  2. the marked sweep           → `arquivos(markedForDeletionAt)`
//  3. the canonical mensagem refcount (an OR over six fields) → the six
//     single-field `mensagem` collection-group indexes
//  4. the pending-contact refcount → collection group `mensagens(arquivoId)`
//  5. the ROUND-ROBIN PAGE of `sweepUnreferencedArquivos` (#234), page 1 and a
//     cursor page → `arquivos(__name__ ASC)`.
//
// ⚠️ 5 used to be skipped here as "document-key ordering is native, no index
// needed". That is Firestore STANDARD. On Enterprise there is no key index unless
// one is declared, and #1874 measured what a key-ordered query does without one:
// it walks some other index end to end, cuts the range in a residual Filter and
// sorts in memory — every page reads the whole collection to return 100 rows.
//
// ---- Why a PROXY. Enterprise refuses classic `explain()` (`3 INVALID_ARGUMENT:
// Explain options are not supported in RunQuery API for Enterprise edition`), so
// each section tries it and, on that refusal, explains the SDK's own pipeline
// translation of the same query — `db.pipeline().createFrom(<query>)` — instead.
// ⚠️ Always the query WITHOUT its `select()`: `createFrom` emits the projection
// before the `exists(__name__)`/`sort(__name__)` stages it derives, the key is
// gone, and the proxy returns zero rows and no plan (#1200, 2026-10-08).
// Projection does not change the access path. ⚠️ A proxy that returns ZERO rows
// carries no plan at all (`@google-cloud/firestore` 8.6.0), so each section with
// a predicate that may match nothing retries a WIDENED form that rides the SAME
// index — that still proves the index is READY and serves the shape. A section
// left with no plan is UNVERIFIED, never a pass. What a proxy PASS proves: the
// index is READY and serves the predicate — not the classic query's own plan,
// which only Query Insights confirms after a real run.
//
// Run against the real project (the emulator is Standard edition and refuses
// pipelines). Credentials as the Mercado Livre staging suite takes them:
//
//   FIREBASE_PROJECT_ID=<project> \
//   FIREBASE_SERVICE_ACCOUNT_PATH=<sa.json, relative to the repo root or absolute> \
//   node apps/functions/scripts/check-sweep-indexes.mjs
//
// (`FIREBASE_SERVICE_ACCOUNT` takes the JSON inline; with neither, Application
// Default Credentials — e.g. `GOOGLE_APPLICATION_CREDENTIALS`.) Targets the named
// `default` database (deploy gotcha #8), overridable via FIREBASE_DATABASE_ID.
// `analyze` EXECUTES each query (billed as a normal read).
//
// Exit code: 1 when any section FAILS, 2 when none fails but some are
// UNVERIFIED (no rows to plan), 0 only when every section is proven.

if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.error(
    `FIRESTORE_EMULATOR_HOST=${process.env.FIRESTORE_EMULATOR_HOST} would reroute every call to ` +
      'the Standard-edition emulator, which has no Enterprise plans — unset it.',
  );
  process.exit(1);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const projectId = process.env.FIREBASE_PROJECT_ID ?? 'veste-france-debug';
const databaseId = process.env.FIREBASE_DATABASE_ID ?? 'default';
// Mirror the production sweep's guard: non-numeric/negative falls back to 48h
// (else NaN would poison the cutoff and fail the query).
const graceRaw = Number(process.env.ARQUIVO_ORPHAN_GRACE_HOURS ?? '48');
const graceHours = Number.isFinite(graceRaw) && graceRaw >= 0 ? graceRaw : 48;
// Mirrors BATCH_LIMIT in src/arquivos/arquivoOrphanSweep.ts.
const BATCH_LIMIT = 100;

function credencial() {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (inline) return cert(JSON.parse(inline));
  const caminho = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (caminho) return cert(isAbsolute(caminho) ? caminho : resolve(repoRoot, caminho));
  return undefined;
}

const credential = credencial();
const app = initializeApp({ projectId, ...(credential ? { credential } : {}) });
const db = getFirestore(app, databaseId);

// Matches the sweeps: cutoff = now - grace, in microseconds.
const nowMicros = Date.now() * 1000;
const cutoff = nowMicros - graceHours * 3_600_000 * 1000;

const falhas = [];
const naoVerificadas = [];
function fail(msg) {
  falhas.push(msg);
  console.error(`FAIL  ${msg}`);
}

// A server-side rejection carries a numeric gRPC status (1-16); anything else is
// a bug in this script and rethrows.
function isGrpcCodedError(err) {
  if (!(err instanceof Error)) return false;
  const code = /** @type {{ code?: unknown }} */ (err).code;
  return typeof code === 'number' && Number.isInteger(code) && code >= 1 && code <= 16;
}

/**
 * Classic explain-analyze, or `null` when Enterprise refuses it — the refusal
 * says something about the API, nothing about the index. Any other gRPC error
 * rethrows: on a Standard database a missing composite is `9 FAILED_PRECONDITION`.
 */
async function explainClassico(query) {
  try {
    const { metrics } = await query.explain({ analyze: true });
    return metrics;
  } catch (err) {
    if (!isGrpcCodedError(err)) throw err;
    if (err.code === 3 && RECUSA_EXPLAIN_ENTERPRISE_RE.test(err.message)) return null;
    throw err;
  }
}

/**
 * One PROXY explain-analyze: the plan text (`null` when the execution returned
 * none — a 0-row proxy carries none), the rows, and the wall-clock time.
 */
async function explainProxy(label, query) {
  const t0 = Date.now();
  const snap = await db
    .pipeline()
    .createFrom(query)
    .execute({ explainOptions: { mode: 'analyze', outputFormat: 'text' } });
  const ms = Date.now() - t0;
  const plano = snap.explainStats?.text ?? '';
  console.log(`rows returned: ${snap.results.length} in ${ms} ms (${label})`);
  if (plano.trim() !== '') {
    console.log(`\n----- FULL PLAN (PROXY — pipeline translation, ${label}) -----\n`);
    console.log(plano);
  }
  return { plano: plano.trim() === '' ? null : plano, linhas: snap.results, ms };
}

function imprimirContadores(plano) {
  const c = contadoresDoCabecalho(plano);
  console.log(
    `  results returned: ${c['results returned'] ?? '?'}  index rows scanned: ${
      c['index row scanned'] ?? '?'
    }  entity rows scanned: ${c['entity row scanned'] ?? '?'}  read units: ${
      c['read units'] ?? '?'
    }`,
  );
  return c;
}

/**
 * How an index prints in the plan: `/<coll> (f ASC, …)` for COLLECTION scope,
 * `**\/<coll> (…)` for COLLECTION_GROUP, optionally followed by the key field the
 * dialect may append (`__name__` prints as `__key__`).
 */
function indiceRe(escopo, colecao, campos) {
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const prefixo = escopo === 'COLLECTION_GROUP' ? '\\*\\*\\/' : '\\/';
  return new RegExp(
    `^${prefixo}${esc(colecao)} \\(${campos.map(esc).join(', ')}(?:, __(?:key|name)__ ASC)?\\)`,
  );
}

/** Distinct `index:` identifiers the plan's access nodes ride, `@[id = …]` stripped. */
function indicesUsados(nos) {
  return [...new Set(nos.map((n) => n.identifier?.replace(/@\[.*$/, '').trim()).filter(Boolean))];
}

/**
 * Explain one sweep query and judge it rides `esperados` (one RegExp per index
 * that must appear among the plan's access nodes) with no identifier-less scan
 * of the root partition. `alternativas` are WIDENED forms over the same index,
 * tried in order only while the previous one returned no plan.
 */
async function verificar(label, { consulta, alternativas = [], esperados, minIndexesClassico }) {
  console.log(`\n=== ${label} ===`);
  const metrics = await explainClassico(consulta);
  if (metrics != null) {
    const usados = metrics.planSummary?.indexesUsed ?? [];
    const stats = metrics.executionStats ?? {};
    console.log('indexesUsed:', JSON.stringify(usados, null, 2));
    console.log(
      `resultsReturned: ${stats.resultsReturned}  readOperations: ${stats.readOperations}`,
    );
    if (usados.length < minIndexesClassico) {
      fail(
        `${label}: expected ≥ ${minIndexesClassico} index(es), the classic plan used ${usados.length}`,
      );
    } else console.log(`PASS  ${label} (classic plan)`);
    return;
  }
  console.log('NOTE  classic explain refused by Enterprise — explaining the PROXY');
  for (const { rotulo, query } of [
    { rotulo: 'shipped predicate', query: consulta },
    ...alternativas,
  ]) {
    const { plano } = await explainProxy(rotulo, query);
    if (plano == null) {
      console.log(`  (no plan: 0 rows for the ${rotulo})`);
      continue;
    }
    imprimirContadores(plano);
    const nos = parseAccessNodes(plano);
    const usados = indicesUsados(nos);
    console.log(`  indexes ridden: ${usados.length === 0 ? '(none)' : usados.join(' | ')}`);
    let ok = true;
    for (const n of scansSemIdentificador(nos).cheios) {
      ok = false;
      fail(`${label}: an identifier-less ${n.type} (plan line ${n.line}) — a full scan`);
    }
    for (const re of esperados) {
      if (usados.some((u) => re.test(u))) continue;
      ok = false;
      fail(`${label}: no access node rides ${re} — not READY, or the planner chose another path`);
    }
    if (ok) console.log(`PASS  ${label} (proxy, ${rotulo})`);
    return;
  }
  naoVerificadas.push(label);
  console.warn(`UNVERIFIED  ${label}: every form returned 0 rows, so no plan to judge`);
}

/* ------------------------------ 1. phantom sweep ----------------------------- */

const phantom = (estado) =>
  db
    .collection('arquivos')
    .where('uploadState', '==', estado)
    .where('criadoEm', '<', cutoff)
    .orderBy('criadoEm', 'asc')
    .limit(BATCH_LIMIT);
await verificar(
  'phantom sweep — arquivos where uploadState=="pending" AND criadoEm<cutoff orderBy criadoEm limit 100',
  {
    consulta: phantom('pending'),
    alternativas: [{ rotulo: 'widened: uploadState=="finalized"', query: phantom('finalized') }],
    esperados: [indiceRe('COLLECTION', 'arquivos', ['uploadState ASC', 'criadoEm ASC'])],
    minIndexesClassico: 1,
  },
);

/* ------------------------------ 2. marked sweep ------------------------------ */

await verificar(
  'marked sweep — arquivos where markedForDeletionAt<cutoff orderBy markedForDeletionAt limit 100',
  {
    consulta: db
      .collection('arquivos')
      .where('markedForDeletionAt', '<', cutoff)
      .orderBy('markedForDeletionAt', 'asc')
      .limit(BATCH_LIMIT),
    alternativas: [
      {
        rotulo: 'widened: markedForDeletionAt==null',
        query: db
          .collection('arquivos')
          .where('markedForDeletionAt', '==', null)
          .limit(BATCH_LIMIT),
      },
    ],
    esperados: [indiceRe('COLLECTION', 'arquivos', ['markedForDeletionAt ASC'])],
    minIndexesClassico: 1,
  },
);

/* ------------------------- 3 + 4. mensagem refcounts ------------------------- */

// Mirrors MENSAGEM_ARQUIVO_REF_FIELDS / mensagemArquivoRefValues (packages/schemas)
// and buildMensagemArquivoReferenceQuery / buildWhatsappVinculoArquivoReferenceQuery
// (src/arquivos/arquivoOrphanSweep.ts) — WITHOUT their `select()` (see header).
const mensagemArquivoRefFields = [
  'anexoStorage',
  'audio.audio',
  'image.image',
  'video.video',
  'sticker.sticker',
  'genericDocument.genericDocument',
];
const refcountMensagem = (arquivoId) =>
  db
    .collectionGroup('mensagem')
    .where(
      Filter.or(
        ...mensagemArquivoRefFields.map((field) =>
          Filter.where(field, 'in', [`arquivos/${arquivoId}`, `documents/arquivos/${arquivoId}`]),
        ),
      ),
    )
    .limit(1);
const refcountVinculo = (arquivoId) =>
  db.collectionGroup('mensagens').where('arquivoId', '==', arquivoId).limit(1);

// The shipped probe id matches nothing, and a 0-row proxy has no plan — so the
// widened form asks with an arquivo id that IS referenced, found through the
// same indexes (each a one-row read).
async function idReferenciadoPorMensagem() {
  for (const field of mensagemArquivoRefFields) {
    const snap = await db
      .collectionGroup('mensagem')
      .where(field, '>', '')
      .orderBy(field)
      .limit(1)
      .select(field)
      .get();
    const valor = snap.docs[0]?.get(field);
    if (typeof valor === 'string' && valor) return valor.split('/').pop() ?? null;
  }
  return null;
}
async function idReferenciadoPorVinculo() {
  const snap = await db
    .collectionGroup('mensagens')
    .where('arquivoId', '>', '')
    .orderBy('arquivoId')
    .limit(1)
    .select('arquivoId')
    .get();
  const valor = snap.docs[0]?.get('arquivoId');
  return typeof valor === 'string' && valor ? valor : null;
}

const probeArquivoId = process.env.ARQUIVO_SWEEP_PROBE_ID ?? '__arquivo_index_probe__';
const idMensagem = await idReferenciadoPorMensagem();
await verificar('mensagem media refcount — collectionGroup(mensagem) OR six ref fields limit 1', {
  consulta: refcountMensagem(probeArquivoId),
  alternativas:
    idMensagem == null
      ? []
      : [
          {
            rotulo: 'widened: an arquivo id a mensagem references',
            query: refcountMensagem(idMensagem),
          },
        ],
  esperados: mensagemArquivoRefFields.map((field) =>
    indiceRe('COLLECTION_GROUP', 'mensagem', [`${field} ASC`]),
  ),
  minIndexesClassico: mensagemArquivoRefFields.length,
});
const idVinculo = await idReferenciadoPorVinculo();
await verificar('pending-contact media refcount — collectionGroup(mensagens) arquivoId limit 1', {
  consulta: refcountVinculo(probeArquivoId),
  alternativas:
    idVinculo == null
      ? []
      : [
          {
            rotulo: 'widened: an arquivo id a vínculo references',
            query: refcountVinculo(idVinculo),
          },
        ],
  esperados: [indiceRe('COLLECTION_GROUP', 'mensagens', ['arquivoId ASC'])],
  minIndexesClassico: 1,
});

/* ------------------- 5. the round-robin page (#234, #1874) ------------------- */

// fetchArquivoPage verbatim (src/arquivos/arquivoOrphanSweep.ts).
const pagina = (lastKey) => {
  let query = db.collection('arquivos').orderBy(FieldPath.documentId()).limit(BATCH_LIMIT);
  if (lastKey !== null) query = query.startAfter(lastKey);
  return query;
};
/** The access path the page must ride — the dialect prints `__name__` as `__key__`. */
const INDICE_DE_CHAVE_RE = /^\/arquivos \(__(?:key|name)__ ASC\)/;

/**
 * KEY-BOUNDED iff the plan rides a key-leading arquivos index, no sort consumes
 * more rows than it returns, and the whole query read at most the page (+1, the
 * row that tells the scan to stop). A sweep page that reads more pays a scan of
 * the collection on every 48h tick for 100 rows.
 */
function julgarPagina(label, plano) {
  const c = imprimirContadores(plano);
  const nos = parseAccessNodes(plano);
  const usados = indicesUsados(nos);
  console.log(
    `  indexes ridden: ${usados.length === 0 ? '(none — identifier-less scan)' : usados.join(' | ')}`,
  );
  const motivos = [];
  for (const n of scansSemIdentificador(nos).cheios) {
    motivos.push(`an identifier-less ${n.type} (plan line ${n.line}) reads the whole collection`);
  }
  if (!usados.some((u) => INDICE_DE_CHAVE_RE.test(u))) {
    motivos.push(
      'no access node rides arquivos(__name__ ASC) — Enterprise has no implicit key index, so ' +
        'key order is produced by a sort over everything the scan read',
    );
  }
  for (const n of sortsQueCortam(plano)) {
    motivos.push(
      `${n.nome} (plan line ${n.linha}) consumed more rows than it returned (or printed no ` +
        'count) — a TopN over everything the scan read',
    );
  }
  const lidas = c['index row scanned'];
  if (lidas == null || lidas > BATCH_LIMIT + 1) {
    motivos.push(
      `read ${lidas ?? 'an unprinted number of'} index rows for a page of ${BATCH_LIMIT} — the page ` +
        'is not confined to its own rows',
    );
  }
  for (const m of motivos) fail(`${label}: ${m}`);
  if (motivos.length === 0) console.log(`PASS  ${label}: a key seek reading ${lidas} index rows`);
}

console.log(
  '\n=== round-robin page — arquivos orderBy(__name__) limit 100 [startAfter(lastKey)] ===',
);
{
  const metrics = await explainClassico(pagina(null));
  if (metrics != null) {
    console.log('indexesUsed:', JSON.stringify(metrics.planSummary?.indexesUsed ?? [], null, 2));
    console.log('(classic plan — a Standard database serves key order natively)');
  } else {
    console.log('NOTE  classic explain refused by Enterprise — explaining the PROXY');
    const total = (await db.collection('arquivos').count().get()).data().count;
    console.log(`arquivos in this database: ${total}`);
    const p1 = await explainProxy('page 1 (no cursor)', pagina(null));
    if (p1.plano == null) {
      naoVerificadas.push('round-robin page');
      console.warn('UNVERIFIED  round-robin page: arquivos is empty, so no plan to judge');
    } else {
      julgarPagina('round-robin page 1', p1.plano);
      const ultimo = p1.linhas[p1.linhas.length - 1]?.ref?.id ?? null;
      if (p1.linhas.length === BATCH_LIMIT && ultimo != null) {
        const p2 = await explainProxy('page 2 (startAfter page 1’s last key)', pagina(ultimo));
        if (p2.plano == null) console.log('  (no plan: page 2 is empty — the cursor would wrap)');
        else julgarPagina('round-robin page 2 (cursor)', p2.plano);
      } else {
        console.log('  (page 1 was the whole collection — no cursor page to probe)');
      }
    }
  }
}

/* ---------------------------------- verdict ---------------------------------- */

if (falhas.length > 0) {
  console.error(`\n❌ ${falhas.length} finding(s) — read the plans above`);
  process.exit(1);
}
if (naoVerificadas.length > 0) {
  console.warn(
    `\n⚠️  no finding, but ${naoVerificadas.length} section(s) UNVERIFIED: ${naoVerificadas.join('; ')}`,
  );
  process.exit(2);
}
console.log('\n✅ every sweep query index-backed');
process.exit(0);
