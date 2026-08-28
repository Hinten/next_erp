/* eslint-disable no-console -- CLI script: stdout is the interface */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as pipelines from '@google-cloud/firestore/pipelines';

// SPIKE — is a Firestore Enterprise TEXT INDEX worth adopting for the /produtos
// search box? Sibling of check-estoque-indexes.mjs, but a MEASUREMENT, not a
// gate: it answers its questions with numbers instead of assumptions, and
// deliberately exits 0 whatever it finds.
//
//   Q1 COST — the premise to disprove. The current nome search is a prefix
//      RANGE (nome >= term && nome <= term+\uf8ff) riding produtos(paiId, nome),
//      which is ALREADY an index seek. Text search is therefore unlikely to be
//      cheaper; it adds its own index plus a scored stage. Q1 measures both and
//      prints them side by side.
//   Q2 CAPABILITY — the reason to adopt anyway. A prefix range structurally
//      cannot match a word in the MIDDLE of a name ("preta" in "Camiseta Polo
//      Preta"). Q2 runs exactly that term through both paths.
//   Q2b SKU — can it replace SKU lookup #1 (produtos) only? See the block.
//   Q3 LANGUAGE — the open design question. The analyzer language lives in
//      Index.searchIndexOptions.textLanguage, which the Firebase CLI cannot
//      express (0 references repo-wide in firebase-tools 15.28.2), so the
//      deployed index gets the BACKEND DEFAULT. If that default stems
//      Portuguese, a singular term matches a plural name and an unaccented term
//      matches an accented one. Q3 probes both; a miss is the evidence for
//      spending a console-managed setting on `pt`.
//
// ⚠️⚠️ THE INDEX THIS SCRIPT MEASURES IS PROVISIONAL, AND NOT STAGING-SCOPED.
// `firestore.indexes.json` is the `indexes` path in BOTH firebase.json
// (production) and firebase.staging.json, so there is no way to declare a text
// index for staging alone. The next production index deploy — migration-window
// work, root CLAUDE.md rule 8 — replays this file exactly as it stands, and a
// TOKENIZED index over produtos.nome AND produtos.sku is then built and
// maintained on every produto write with nothing in apps/web reading it.
// EXIT CONDITION: if Q1/Q2 below do not justify adopting text search, the
// index entry is REVERTED, not left behind. An index nobody remembers ordering
// is exactly the drift this repo keeps writing lint backstops against.
//
// ⚠️ REQUIREMENTS, both easy to get wrong:
//   * firebase-tools >= 15.17.0 to DEPLOY the index at all. `searchConfig`
//     landed there (binary-searched across published tarballs; 15.16.0 does not
//     have it). An older CLI does not understand the key.
//   * Pipelines never run in the emulator — live project only, same as
//     `explain`. This script cannot be exercised by any CI lane.
//
// Run AFTER `firebase deploy --only firestore:indexes` and after the index has
// finished building (a text index over the whole produtos collection is not
// instant — a query against a still-building index reports no results rather
// than an error):
//
//   GOOGLE_APPLICATION_CREDENTIALS=<sa.json> \
//   FIREBASE_PROJECT_ID=<project-id> \
//   node apps/functions/scripts/check-text-search-index.mjs
//
// `analyze` EXECUTES every probe (billed as normal reads), and every term is
// probed TWICE — see comoFrase. Targets the named `default` database (deploy
// gotcha #8), overridable via FIREBASE_DATABASE_ID.

const projectId = process.env.FIREBASE_PROJECT_ID ?? 'veste-france-debug';
const databaseId = process.env.FIREBASE_DATABASE_ID ?? 'default';

const app = initializeApp({ projectId });
const db = getFirestore(app, databaseId);

/** U+F8FF — the sentinel /produtos appends to bound a nome prefix range. */
const PREFIX_SENTINEL = '\uf8ff';

/** Strip diacritics, for the accent probe and the -s stoplist below. */
function semAcentos(palavra) {
  return palavra.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Portuguese SINGULARS that already end in `s`.
 *
 * ⚠️ Without this, the stemming probe manufactures a nonword and then reports a
 * definitive negative about it: `Lápis 2B` becomes the term `Lápi`, which no
 * analyzer in any language should match, and the old code printed that as "no
 * Portuguese stemming" — a verdict on the one design question this script
 * exists to settle. Compared accent-folded and lowercased.
 */
const SINGULARES_EM_S = new Set([
  'lapis',
  'onibus',
  'pais',
  'iris',
  'atlas',
  'virus',
  'gas',
  'mes',
  'cais',
  'pires',
  'ananas',
  'bonus',
  'campus',
  'lotus',
  'status',
]);

// ---------------------------------------------------------------------------
// Probe discovery. Every measurement below is worthless against zero rows, and
// one of them is worse than worthless: a pipeline execution that returns NO
// results carries NO explainStats at all (verified on staging, admin v8.6.0) —
// the plan is simply absent, which reads exactly like "no index was used".
// So discover real terms from real documents first, and say so when we can't.
// ---------------------------------------------------------------------------
async function descobrirAmostra() {
  const snap = await db
    .collection('produtos')
    .where('paiId', '==', null)
    .orderBy('ultimaModificacao', 'desc')
    .limit(50)
    .get();

  const linhas = snap.docs
    .map((d) => ({ id: d.id, nome: d.get('nome'), sku: d.get('sku') }))
    .filter((r) => typeof r.nome === 'string' && r.nome.trim() !== '');

  // A name with at least two words is what makes Q2 meaningful: we need a term
  // that is genuinely NOT a prefix of the name it should match.
  const multi = linhas.find((r) => r.nome.trim().split(/\s+/).length >= 2);

  // Q3 stemming: a first word that plausibly IS a plural. The stoplist and the
  // length floor are what keep this from inventing a term — see SINGULARES_EM_S.
  const plural = linhas.find((r) => {
    const w = r.nome.trim().split(/\s+/)[0];
    if (!/^[\p{L}]+s$/u.test(w)) return false;
    const stem = w.slice(0, -1);
    return stem.length >= 3 && !SINGULARES_EM_S.has(semAcentos(w).toLowerCase());
  });

  // Q3 accents: keep the WORD, not just the row. Selecting on "an accent
  // anywhere in the nome" and then probing the FIRST word made the probe
  // silently produce no output whenever the accent sat in a later word
  // ("Camiseta Polo Básica").
  let palavraAcentuada = null;
  for (const r of linhas) {
    const achada = r.nome
      .trim()
      .split(/\s+/)
      .find((w) => semAcentos(w) !== w);
    if (achada) {
      palavraAcentuada = { palavra: achada, nome: r.nome };
      break;
    }
  }

  // ⚠️ Q2b needs a VARIATION CHILD's sku, not a parent's. The query it models
  // matches children on purpose, so probing with a parent's SKU exercises the
  // one shape where including or excluding `paiId` makes no difference — a
  // probe that cannot fail the way the real thing would.
  //
  // Found by asking sampled parents for their children rather than by an
  // inequality on `paiId`: `where paiId == <id>` rides the existing
  // `produtos(paiId ASC, nome ASC)` composite by index-prefix equality, whereas
  // `paiId != null` has no index at all and this edition full-scans silently.
  let filhoComSku = null;
  for (const pai of linhas.slice(0, 10)) {
    const filhos = await db.collection('produtos').where('paiId', '==', pai.id).limit(5).get();
    const achado = filhos.docs
      .map((d) => ({ id: d.id, nome: d.get('nome'), sku: d.get('sku') }))
      .find((r) => typeof r.sku === 'string' && r.sku.trim() !== '');
    if (achado) {
      filhoComSku = achado;
      break;
    }
  }

  return {
    total: linhas.length,
    primeiro: linhas[0],
    multi,
    filhoComSku,
    plural,
    palavraAcentuada,
  };
}

// ---------------------------------------------------------------------------
// The measurement primitives.
// ---------------------------------------------------------------------------
async function explicarClassica(rotulo, query) {
  const { metrics } = await query.explain({ analyze: true });
  const indexesUsed = metrics.planSummary?.indexesUsed ?? [];
  const stats = metrics.executionStats ?? {};
  console.log(`\n--- [classic] ${rotulo}`);
  console.log('  indexesUsed     :', JSON.stringify(indexesUsed));
  console.log('  resultsReturned :', stats.resultsReturned);
  console.log('  readOperations  :', stats.readOperations);
  console.log('  duration        :', stats.executionDuration);
  if (indexesUsed.length === 0) {
    console.warn('  ⚠️  no index reported — this query is SCANNING');
  }
  return Number(stats.resultsReturned ?? 0);
}

/**
 * Read a message off an unknown throw WITHOUT pretending to narrow it.
 *
 * ⚠️ This catch reports and continues on purpose — one probe failing (a missing
 * or still-building index, which is the most informative outcome here) must not
 * stop the remaining probes. It does not HANDLE the error, so narrowing on a
 * class would be theatre; `delfrance/no-error-as-sole-instanceof` is right that
 * `instanceof Error` proves nothing.
 */
function mensagemDoErro(err) {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String(err.message);
  }
  return String(err);
}

async function explicarPipeline(rotulo, pipeline) {
  let snap;
  try {
    snap = await pipeline.execute({ explainOptions: { mode: 'analyze' } });
    // Diagnostic boundary: a probe failing (a missing or still-building text
    // index) is this script's most informative outcome, and rethrowing would
    // abort every probe after it. This reports and continues rather than
    // handling, so there is no class to narrow on -- see mensagemDoErro.
    // eslint-disable-next-line no-restricted-syntax -- see the note above
  } catch (err) {
    // A missing/still-building text index is the expected failure here, and it
    // is the single most useful thing this script can report. Surface the raw
    // message rather than a verdict — the wording is what tells them apart.
    console.log(`\n--- [pipeline] ${rotulo}`);
    console.error('  ❌ execute failed:', mensagemDoErro(err));
    return null;
  }
  const n = snap.results.length;
  console.log(`\n--- [pipeline] ${rotulo}`);
  console.log('  resultsReturned :', n);
  console.log('  executionTime   :', String(snap.executionTime ?? '(none)'));
  if (n === 0) {
    // ⚠️ Not a plan we can read. Say so explicitly: a silent "no stats" here
    // would otherwise be mistaken for "the index was not used".
    console.warn('  ⚠️  ZERO results ⇒ NO explainStats is emitted at all.');
    console.warn('     Cannot conclude anything about the index from this probe.');
  } else {
    console.log('  explainStats    :\n', snap.explainStats?.text ?? '(none)');
  }
  return n;
}

/**
 * Quote a term as a DSL phrase.
 *
 * ⚠️⚠️ `documentMatches(rquery)` takes a search DOMAIN-SPECIFIC LANGUAGE string,
 * not a literal term — the installed typings say so outright and give
 * `documentMatches('waffles OR pancakes')` as the example. So the argument is
 * PARSED: `OR` is an operator, and a leading `-` negates.
 *
 * That is not academic here. SKUs in this repo are overwhelmingly hyphenated
 * (`DEV-FRETE-01`), so feeding one in raw asks the engine for "DEV, but NOT
 * FRETE, but NOT 01" — and the empty result set that follows is a parse
 * artifact INDISTINGUISHABLE from "text search cannot match SKUs". A nome
 * containing `-`, `"`, `(`, `:` or `+` has the same exposure, and every term
 * here comes straight off production-shaped data.
 *
 * Hence {@link probarTermo}: run BOTH forms and print the exact DSL sent. A
 * disagreement between them is not noise — it is a finding about the DSL, and
 * the quoted form is the one to trust.
 */
function comoFrase(termo) {
  return `"${termo.replace(/"/g, '\\"')}"`;
}

/**
 * Probe one term twice — as typed, and quoted as a phrase — and report both.
 * Returns the QUOTED form's count, which is the one that measures capability
 * rather than DSL parsing.
 */
async function probarTermo(rotulo, termo, fabrica) {
  const bruto = termo;
  const frase = comoFrase(termo);
  const nBruto = await explicarPipeline(`${rotulo} — DSL as typed: ${bruto}`, fabrica(bruto));
  const nFrase = await explicarPipeline(`${rotulo} — DSL quoted: ${frase}`, fabrica(frase));
  if (nBruto !== nFrase) {
    console.warn(`  ⚠️  the two DSL forms DISAGREE (raw ${nBruto} vs quoted ${nFrase}).`);
    console.warn('     The raw term contains a DSL operator character, so its result');
    console.warn('     is a PARSE effect, not a capability result. Trust the quoted one.');
  }
  return nFrase;
}

function buscaTexto(dsl) {
  return (
    db
      .pipeline()
      .collection('produtos')
      // ⚠️ `search` MUST be the first stage — every other constraint (the
      // parents-only filter, the page limit) has to come after it.
      .search({ query: pipelines.documentMatches(dsl) })
      .where(pipelines.field('paiId').equal(null))
      .limit(50)
  );
}

/**
 * The SKU probe's pipeline — deliberately WITHOUT the `paiId == null` filter.
 *
 * ⚠️ Not an oversight, and not interchangeable with {@link buscaTexto}. The
 * query this probe stands in for (`buscaProduto.ts`, SKU lookup #1) omits that
 * filter ON PURPOSE: a variation CHILD carries its own SKU and is what an
 * operator scans off a label. Applying the filter here — and then sampling only
 * parents — is how the first version of this probe passed while testing the one
 * case where the difference cannot show up.
 */
function buscaTextoSku(dsl) {
  return db
    .pipeline()
    .collection('produtos')
    .search({ query: pipelines.documentMatches(dsl) })
    .limit(50);
}

function prefixoNome(termo) {
  return db
    .collection('produtos')
    .where('paiId', '==', null)
    .where('nome', '>=', termo)
    .where('nome', '<=', `${termo}${PREFIX_SENTINEL}`)
    .orderBy('nome', 'asc')
    .limit(50);
}

// ---------------------------------------------------------------------------
async function main() {
  console.log(`project=${projectId} database=${databaseId}`);
  const amostra = await descobrirAmostra();
  if (!amostra.primeiro) {
    console.error('No produtos found to probe. Seed the project or widen discovery.');
    process.exit(0);
  }
  console.log(`discovered ${amostra.total} produto(s) to build probes from.`);

  // === Q1 — cost, same term through both paths ============================
  const nome = amostra.primeiro.nome.trim();
  const primeiraPalavra = nome.split(/\s+/)[0];
  console.log(
    `\n${'='.repeat(70)}\nQ1 COST — term "${primeiraPalavra}" (a real prefix)\n${'='.repeat(70)}`,
  );
  await explicarClassica(`prefix range on nome`, prefixoNome(primeiraPalavra));
  await probarTermo(`search(documentMatches)`, primeiraPalavra, buscaTexto);

  // === Q2 — capability, a NON-prefix word =================================
  if (amostra.multi) {
    const palavras = amostra.multi.nome.trim().split(/\s+/);
    const meio = palavras[palavras.length - 1];
    console.log(
      `\n${'='.repeat(70)}\nQ2 CAPABILITY — term "${meio}", a word INSIDE "${amostra.multi.nome}"` +
        `\n${'='.repeat(70)}`,
    );
    console.log('  Expect: the prefix range returns 0 (it cannot match mid-name);');
    console.log('          text search returns >= 1. That gap IS the feature.');
    await explicarClassica(`prefix range on nome`, prefixoNome(meio));
    await probarTermo(`search(documentMatches)`, meio, buscaTexto);
  } else {
    console.log('\nQ2 skipped: no multi-word produto nome in the sample.');
  }

  // === Q2b — can text search replace SKU lookup #1 ONLY? ==================
  //
  // ⚠️ Scope, because the earlier wording of this probe over-claimed by 3x.
  // The smart box fires THREE always-on SKU queries (`buscaProduto.ts`), and
  // they read THREE DIFFERENT collections:
  //
  //   #1 produtos                               <- the only one this index covers
  //   #2 collectionGroup('produtoMercadoLivre')
  //   #3 collectionGroup('variacaoMercadoLivre')
  //
  // The index declared in this PR is `produtos` / queryScope COLLECTION, so NO
  // outcome here can retire #2 or #3 — and they are not duplicates of #1: the
  // ML link SKU is whatever was sent as `seller_custom_field` and routinely
  // differs from the ERP's, which is the entire reason those queries exist.
  // Retiring them would need their own text indexes on those collection groups;
  // this spike deliberately does not declare those, because their cost is only
  // worth paying if Q1/Q2 first show the mechanism is worth adopting at all.
  console.log(`\n${'='.repeat(70)}\nQ2b SKU — covers lookup #1 (produtos) ONLY\n${'='.repeat(70)}`);
  console.log('  #2 and #3 read produtoMercadoLivre / variacaoMercadoLivre as');
  console.log('  COLLECTION GROUPS. This produtos-scoped index cannot serve them,');
  console.log('  whatever the result below says. Their SKUs differ from the ERP.');

  if (amostra.filhoComSku) {
    // ⚠️ A VARIATION CHILD's sku, probed WITHOUT the paiId filter — because
    // that is exactly what lookup #1 does. A parent SKU cannot tell the two
    // shapes apart, so testing with one proves nothing about the real query.
    //
    // ⚠️ And probed BOTH ways: a hyphenated SKU is where the DSL hazard bites
    // hardest, so the raw form's result here is the least trustworthy number
    // this script produces. See comoFrase.
    const sku = amostra.filhoComSku.sku.trim();
    console.log(`\n  child SKU "${sku}" (paiId != null, no filter applied)`);
    const n = await probarTermo(`search(documentMatches) [no paiId filter]`, sku, buscaTextoSku);
    if (n === 0) {
      console.warn('  ⚠️  a variation child SKU did NOT match even QUOTED — text search');
      console.warn('     cannot replace lookup #1 either, since #1 exists to find children.');
    }
  } else {
    console.log('\n  ⚠️  SKIPPED: no variation child with a sku in the sample.');
    console.log('     Probing a PARENT sku instead would exercise the one shape');
    console.log('     where the paiId filter makes no difference — it would pass');
    console.log('     without testing what this question is actually about.');
  }

  // === Q3 — is the default analyzer good enough for Portuguese? ===========
  console.log(
    `\n${'='.repeat(70)}\nQ3 LANGUAGE — does the default analyzer stem pt-BR?\n${'='.repeat(70)}`,
  );
  console.log('  The CLI cannot declare textLanguage, so this index gets the');
  console.log('  backend default. These probes are the evidence for whether');
  console.log('  that is acceptable or worth a console-managed `pt` setting.');

  if (amostra.plural) {
    const pluralWord = amostra.plural.nome.trim().split(/\s+/)[0];
    const singular = pluralWord.slice(0, -1);
    console.log(`\n  stemming: searching "${singular}" should find "${amostra.plural.nome}"`);
    const n = await probarTermo(`search("${singular}")`, singular, buscaTexto);
    if (n === 0) {
      // ⚠️ Deliberately NOT phrased as "no Portuguese stemming". The pair is a
      // HEURISTIC — "${pluralWord}" was guessed to be a plural by its final -s,
      // and a wrong guess produces a nonword no analyzer could match. Name the
      // pair and let the reader judge, rather than issuing a verdict on the
      // one design question this script exists to inform.
      console.warn(`  ⚠️  "${singular}" did not match "${pluralWord}".`);
      console.warn('     INCONCLUSIVE unless that pair really is singular/plural —');
      console.warn('     check it by eye before reading this as "no pt stemming".');
    }
  } else {
    console.log('\n  stemming probe skipped: no plural-looking nome in the sample');
    console.log('  (a first word ending in -s, at least 4 letters, not a known');
    console.log('  singular such as lápis / ônibus / país).');
  }

  if (amostra.palavraAcentuada) {
    const { palavra, nome: nomeAcentuado } = amostra.palavraAcentuada;
    const semAcento = semAcentos(palavra);
    console.log(`\n  accents: searching "${semAcento}" should find "${nomeAcentuado}"`);
    const n = await probarTermo(`search("${semAcento}")`, semAcento, buscaTexto);
    if (n === 0) {
      console.warn(`  ⚠️  "${semAcento}" did NOT match "${palavra}" — no accent folding.`);
    }
  } else {
    console.log('\n  accent probe skipped: no accented WORD in any sampled nome.');
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log('Read Q1 for cost, Q2/Q2b for what the prefix range cannot do,');
  console.log('and Q3 for whether the default analyzer speaks Portuguese.');
  console.log('⚠️ If Q1/Q2 do not justify adopting text search, REVERT the index');
  console.log('   entry — it is not staging-scoped and would otherwise be built');
  console.log('   and maintained in production with no reader.');
  console.log('This script is a measurement, not a gate — it always exits 0.');
}

await main();
