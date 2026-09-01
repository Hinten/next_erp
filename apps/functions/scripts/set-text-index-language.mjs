/* eslint-disable no-console -- CLI script: stdout is the interface */
import { initializeApp, applicationDefault } from 'firebase-admin/app';

// Set the ANALYZER LANGUAGE on the `produtos` text-search index.
//
// ⚠️⚠️ WHY THIS SCRIPT EXISTS, AND WHY IT WILL BE NEEDED MORE THAN ONCE.
//
// `firebase deploy --only firestore:indexes` CANNOT set it. firebase-tools
// builds the index-create body from a whitelist (lib/firestore/api.js,
// createIndex):
//
//   this.apiClient.post(url, { fields, queryScope, apiScope, density,
//                              multikey, unique });
//
// `searchIndexOptions` is not in it, and `validateIndex` does not reject
// unknown keys — so the `textLanguage` declared in firestore.indexes.json is
// dropped with NO error and the index is built with `textLanguage: "und"`
// (BCP-47 for UNDETERMINED — no language-specific processing). Confirmed live
// on staging: the file said pt-BR, the deploy said success, the index said und.
//
// ⚠️ And an index's language CANNOT be patched. Fixing it means DELETE +
// CREATE — which is also why every later `firebase deploy --only
// firestore:indexes` silently reverts it: the CLI deletes and re-creates the
// index under a NEW id, back on `und`. So run this AFTER the last index deploy,
// and again after any subsequent one. Any runbook that hard-codes an index id
// goes stale the first time that happens; this script always re-reads.
//
// gcloud can do it too — `gcloud beta firestore indexes composite create
// --field-config=...,search-config=... --search-index-options=text-language=pt-BR`
// — but only on a recent SDK: older installs reject `search-config` with
// "valid keys are [array-config, field-path, order, vector-config]". This
// script talks to the REST API directly, so it does not depend on the local
// gcloud version.
//
// SAFE BY DEFAULT: prints the plan and changes nothing. Pass --apply to act.
//
//   node apps/functions/scripts/set-text-index-language.mjs
//   node apps/functions/scripts/set-text-index-language.mjs --apply
//
// Auth is Application Default Credentials, the same ones the check-*.mjs
// scripts use. Targets the named `default` database (deploy gotcha #8).
// Override with FIREBASE_PROJECT_ID / FIREBASE_DATABASE_ID / TEXT_LANGUAGE.

const projectId = process.env.FIREBASE_PROJECT_ID ?? 'veste-france-debug';
const databaseId = process.env.FIREBASE_DATABASE_ID ?? 'default';
const COLLECTION = 'produtos';
const CAMPO = 'nome';

// ⚠️ pt-BR, never pt. Measured: the backend answers
// `3 INVALID_ARGUMENT: Language code 'pt' is not supported` for a bare tag.
const IDIOMA = process.env.TEXT_LANGUAGE ?? 'pt-BR';

const aplicar = process.argv.includes('--apply');

const BASE =
  `https://firestore.googleapis.com/v1/projects/${projectId}` +
  `/databases/${databaseId}/collectionGroups/${COLLECTION}/indexes`;

/** The index this repo wants, mirroring firestore.indexes.json + the language. */
const DESEJADO = {
  queryScope: 'COLLECTION',
  apiScope: 'ANY_API',
  fields: [
    {
      fieldPath: CAMPO,
      searchConfig: {
        textSpec: { indexSpecs: [{ indexType: 'TOKENIZED', matchType: 'MATCH_GLOBALLY' }] },
      },
    },
  ],
  searchIndexOptions: { textLanguage: IDIOMA },
};

function mensagemDoErro(err) {
  if (typeof err === 'object' && err !== null && 'message' in err) return String(err.message);
  return String(err);
}

async function chamar(token, url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const corpo = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${JSON.stringify(corpo).slice(0, 400)}`);
  }
  return corpo;
}

const ehTexto = (i) => (i.fields ?? []).some((f) => f.searchConfig);
const camposDe = (i) => (i.fields ?? []).map((f) => f.fieldPath).join(',');

async function main() {
  const app = initializeApp({ credential: applicationDefault(), projectId });
  const { access_token: token } = await app.options.credential.getAccessToken();

  console.log(`project=${projectId} database=${databaseId} language=${IDIOMA}`);
  console.log(aplicar ? 'MODE: --apply (will DELETE and CREATE)' : 'MODE: dry run (no changes)');

  const { indexes = [] } = await chamar(token, BASE);
  const texto = indexes.filter(ehTexto);

  console.log(`\n${COLLECTION}: ${indexes.length} indexes, ${texto.length} text index(es)`);
  for (const i of texto) {
    console.log(`  - ${i.name.split('/').pop()}  state=${i.state}  fields=${camposDe(i)}`);
    console.log(`    searchIndexOptions: ${JSON.stringify(i.searchIndexOptions ?? null)}`);
  }

  const jaCerto = texto.find(
    (i) => camposDe(i) === CAMPO && i.searchIndexOptions?.textLanguage === IDIOMA,
  );
  if (jaCerto && texto.length === 1) {
    console.log(`\n✅ Already correct — ${CAMPO} on ${IDIOMA}. Nothing to do.`);
    return;
  }

  // Anything that is a text index but not exactly what we want has to GO: the
  // language cannot be patched, and a second text index on the same field would
  // conflict on create.
  const aRemover = texto.filter((i) => i !== jaCerto);

  console.log('\nPLAN');
  for (const i of aRemover) {
    console.log(
      `  DELETE ${i.name.split('/').pop()} (fields=${camposDe(i)}, ` +
        `lang=${i.searchIndexOptions?.textLanguage ?? 'none'})`,
    );
  }
  if (!jaCerto) {
    console.log(`  CREATE ${CAMPO} TOKENIZED/MATCH_GLOBALLY, textLanguage=${IDIOMA}`);
  }

  if (!aplicar) {
    console.log('\nDry run — nothing changed. Re-run with --apply to execute.');
    console.log('⚠️ Deleting a text index makes `documentMatches` return nothing until');
    console.log('   the replacement finishes building. Nothing in apps/web reads it today.');
    return;
  }

  for (const i of aRemover) {
    const id = i.name.split('/').pop();
    console.log(`\ndeleting ${id} …`);
    await chamar(token, `https://firestore.googleapis.com/v1/${i.name}`, { method: 'DELETE' });
    console.log('  deleted.');
  }

  if (!jaCerto) {
    console.log(`\ncreating ${CAMPO} with textLanguage=${IDIOMA} …`);
    const criado = await chamar(token, BASE, {
      method: 'POST',
      body: JSON.stringify(DESEJADO),
    });
    console.log('  create operation:', criado.name ?? JSON.stringify(criado).slice(0, 200));
  }

  console.log('\n⚠️ The index builds asynchronously. Until it is READY, a text search');
  console.log('   returns NO RESULTS rather than an error — do not read that as a');
  console.log('   verdict. Re-run this script (no flag) to watch `state`, then:');
  console.log('     node apps/functions/scripts/check-text-search-index.mjs');
}

try {
  await main();
  // eslint-disable-next-line no-restricted-syntax -- top-level CLI boundary: report and exit non-zero
} catch (err) {
  console.error('\n❌ failed:', mensagemDoErro(err));
  process.exitCode = 1;
}
