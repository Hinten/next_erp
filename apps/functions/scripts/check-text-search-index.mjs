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
//   Q3 LANGUAGE — is the deployed index actually speaking pt-BR?
//      `firestore.indexes.json` now DECLARES searchIndexOptions.textLanguage
//      'pt-BR', but ⚠️ `firebase deploy` does NOT send it: firebase-tools builds
//      the create body from a whitelist (fields, queryScope, apiScope, density,
//      multikey, unique) and drops everything else with NO error. So the
//      declaration is INTENT; the live index has whatever it was created with —
//      autodetect, unless the language was set via gcloud/console. Q3 tells the
//      two apart empirically. Measured under AUTODETECT (`und`): case folding
//      YES, pt plural stemming YES, diacritic folding NO.
//      ⚠️ Measured again under pt-BR (set via set-text-index-language.mjs, since
//      `firebase deploy` drops the option): stemming YES — "cerâmicas" matches
//      "Cerâmica" though no document contains the plural — and diacritic folding
//      INCONSISTENT: "Estatua"→Estátua and "Leao"→Leão match, "Ceramica",
//      "Luminaria" and "lapis" do not. 2 of the catalogue's 4 accented words, one
//      index, one run. So pt-BR did reach the index and did change behaviour; it
//      did NOT make accent-insensitive search reliable.
//
// ⚠️⚠️ THE INDEX THIS SCRIPT MEASURES IS PROVISIONAL, AND NOT STAGING-SCOPED.
// `firestore.indexes.json` is the `indexes` path in BOTH firebase.json
// (production) and firebase.staging.json, so there is no way to declare a text
// index for staging alone. The next production index deploy — migration-window
// work, root CLAUDE.md rule 8 — replays this file exactly as it stands, and a
// TOKENIZED index over produtos.nome is then built and maintained on every
// produto write with nothing in apps/web reading it.
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
 * Is this term free of characters the search DSL would read as OPERATORS?
 *
 * ⚠️ Module scope on purpose. This used to be a local const inside discovery,
 * so {@link probarTermo} could not consult it — and its disagreement branch
 * ASSERTED "the raw term contains a DSL operator character" without ever
 * testing the claim. That assertion is FALSE exactly where it matters most:
 * Q3 picks its accent word THROUGH this predicate, so that word never carries
 * an operator, and the branch still blamed one.
 */
const semOperadorDsl = (w) => !/["()+:~^*?\-]/.test(w);

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
  // ⚠️ Ordered by NOME, not by `ultimaModificacao desc`, and that is the whole
  // point. Recency ordering looks like the obvious choice and is useless here:
  // the e2e lanes write constantly, so the most-recently-touched rows are ALL
  // `e2e-<runId>-…` fixtures — measured, 50 of 50 — and merely sorting them
  // last (below) has nothing left to promote. Alphabetical ordering spreads the
  // sample across the real catalogue instead, and the fixtures cluster harmlessly
  // under `e`. Rides the deployed produtos(paiId ASC, nome ASC) composite, so it
  // is a seek either way.
  const snap = await db
    .collection('produtos')
    .where('paiId', '==', null)
    .orderBy('nome', 'asc')
    .limit(50)
    .get();

  const todas = snap.docs
    .map((d) => ({ id: d.id, nome: d.get('nome'), sku: d.get('sku') }))
    .filter((r) => typeof r.nome === 'string' && r.nome.trim() !== '');

  // Belt-and-braces on top of the `nome` ordering above: sort any e2e fixture
  // that still made the window behind the real rows. `e2e-<runId>-…` names are
  // synthetic and all-hyphen — the pathological case for the search DSL, and
  // representative of nothing — so measuring Q1 cost on one answers the wrong
  // question. ⚠️ This sort alone is NOT sufficient, which is why the query above
  // stopped ordering by recency: once the recent window is saturated with
  // fixtures (measured: 50 of 50) there is nothing left to promote.
  const ehE2e = (r) => /^e2e[-_]/i.test(r.nome.trim());
  const linhas = [...todas.filter((r) => !ehE2e(r)), ...todas.filter(ehE2e)];

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
  // ⚠️ The word must be accented AND free of DSL operator characters. The first
  // version probed "Porta-lapis", which varies TWO things at once — a dropped
  // accent and a hyphen, which the DSL reads as negation — so its zero could
  // not distinguish "no accent folding" from "the term never parsed".
  let palavraAcentuada = null;
  for (const r of linhas) {
    const achada = r.nome
      .trim()
      .split(/\s+/)
      .find((w) => semAcentos(w) !== w && semOperadorDsl(w) && w.length >= 4);
    if (achada) {
      palavraAcentuada = { palavra: achada, nome: r.nome };
      break;
    }
  }

  // Q4b wants the OPPOSITE of the word above: one that DOES carry a DSL
  // operator. A hyphen is the common one in this catalogue ("Porta-lápis"), and
  // the DSL reads it as negation — so the raw term asks for "Porta, but NOT
  // lápis". That is the hazard a search BOX walks into on ordinary input, and
  // Q4b measures whether replacing the operator with a space recovers the match.
  let palavraComOperador = null;
  for (const r of linhas) {
    const achada = r.nome
      .trim()
      .split(/\s+/)
      .find((w) => /[-"():+~^*?]/.test(w) && w.length >= 5);
    if (achada) {
      // ⚠️ The id travels with it. Q4b asks whether sanitising reaches THIS
      // document, and a bare count cannot answer that — a hyphen-free term is
      // free to match some other produto and report a cheerful non-zero.
      palavraComOperador = { id: r.id, palavra: achada, nome: r.nome };
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
    palavraComOperador,
  };
}

// ---------------------------------------------------------------------------
// The measurement primitives.
// ---------------------------------------------------------------------------

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

/** `executionTime` is a Timestamp-like object; String() on it prints [object Object]. */
function formatarInstante(v) {
  if (v == null) return '(none)';
  if (typeof v.toDate === 'function') return v.toDate().toISOString();
  return JSON.stringify(v);
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
  console.log('  executionTime   :', formatarInstante(snap.executionTime));
  if (n === 0) {
    // ⚠️ Two DIFFERENT claims, and the first version of this warning blurred
    // them: a zero-result execution emits no explainStats, so there is no COST
    // or INDEX data — but "nothing matched" is still a perfectly good MATCH
    // result, and Q3's verdicts rest on exactly that. Saying "cannot conclude
    // anything" and then printing a verdict two lines later is a contradiction
    // the reader has to resolve for us.
    console.warn('  ⚠️  ZERO results ⇒ no explainStats, so no cost/index data here.');
    console.warn('     The MATCH result (nothing matched) is still meaningful.');
  } else {
    console.log('  explainStats    :\n', snap.explainStats?.text ?? '(none)');
  }
  return n;
}

/**
 * Execute a probe and return the DOCUMENT IDS it matched, not a count.
 *
 * ⚠️⚠️ WHY Q4 CANNOT USE {@link explicarPipeline}. Q1-Q3 ask "how many, and at
 * what cost", and a count answers them. Q4 asks "did the term reach THIS
 * document", and a count cannot: a truncated word is free to match some OTHER
 * produto, and the non-zero it returns reads exactly like prefix matching
 * working. Every Q4 verdict is therefore `ids.includes(<target>)`, never
 * `n > 0`.
 *
 * No `explainOptions`, deliberately: Q4 is a capability question, and an
 * `analyze` run costs more and prints a plan nobody reads here.
 */
async function idsDaBusca(rotulo, pipeline) {
  try {
    const snap = await pipeline.execute();
    const ids = snap.results.map((r) => r.ref?.id ?? r.id ?? '(no id)');
    console.log(`  ${rotulo} -> ${ids.length} result(s)`);
    return ids;
    // Diagnostic boundary, same contract as explicarPipeline: report and keep
    // going, so one failing probe does not take the rest of Q4 with it.
    // eslint-disable-next-line no-restricted-syntax -- see the note above
  } catch (err) {
    console.error(`  ${rotulo} -> ❌ execute failed:`, mensagemDoErro(err));
    return null;
  }
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
 *
 * ⚠️⚠️ WHICH COUNT IS AUTHORITATIVE DEPENDS ON THE QUESTION, so the caller says.
 * This used to always return the QUOTED count, on the reasoning that quoting
 * neutralises DSL operators. True, but it neutralises more than that: MEASURED
 * live on staging, quoting also suppresses the ANALYZER.
 *
 *   term          unquoted  quoted
 *   artesanal            4       4   ← known-GOOD control: quoting is not broken
 *   cerâmicas            3       0   ← plural NO document contains; stemming only
 *   estátuas             2       0   ← same
 *   Estatua              2       0   ← unaccented form of "Estátua"
 *
 * A quoted phrase is matched LITERALLY. So for Q3 — whose entire subject is
 * what the analyzer does — the quoted count measures the one path that has no
 * analyzer in it, and reading a verdict off it reports the opposite of the
 * truth. It did: Q3 printed "the default analyzer does not fold accents" for a
 * word whose unaccented form matched 2 documents.
 *
 * So: 'literal' for terms carrying DSL operators (SKUs, hyphens), where parsing
 * is the confound worth removing; 'analisado' for the language questions, which
 * is also what an operator actually types into the search box.
 */
async function probarTermo(rotulo, termo, fabrica, preferir = 'literal') {
  const bruto = termo;
  const frase = comoFrase(termo);
  const nBruto = await explicarPipeline(`${rotulo} — DSL as typed: ${bruto}`, fabrica(bruto));
  const nFrase = await explicarPipeline(`${rotulo} — DSL quoted: ${frase}`, fabrica(frase));

  if (nBruto !== nFrase) {
    console.warn(`  ⚠️  the two DSL forms DISAGREE (raw ${nBruto} vs quoted ${nFrase}).`);
    // ⚠️ TEST the explanation, never assert it. The old code stated flatly that
    // the raw term "contains a DSL operator character" — a claim it never
    // checked, and one that is false for every Q3 term by construction.
    if (!semOperadorDsl(bruto)) {
      console.warn(`     "${bruto}" DOES carry a DSL operator character, so the raw`);
      console.warn('     result is a PARSE effect. The quoted form is the honest one.');
    } else {
      console.warn(`     "${bruto}" carries NO DSL operator, so parsing does not`);
      console.warn('     explain this. The difference is the ANALYZER: an unquoted');
      console.warn('     term is stemmed and folded, a quoted phrase is matched');
      console.warn('     literally. For a language question the UNQUOTED count is');
      console.warn('     the meaningful one — and it is what an operator types.');
    }
  }
  return preferir === 'analisado' ? nBruto : nFrase;
}

/**
 * The text-search pipeline every probe here runs.
 *
 * ⚠️ `documentMatches` is the ONLY option, not a preference. The field-scoped
 * form the docs show — `field('nome').matches(dsl)` — is **commented out** in
 * both SDKs this repo installs (`@google-cloud/firestore` 8.6.0 declares
 * `// matches(rquery…)`, and `@firebase/firestore` 4.14.1 exports no `matches`
 * at all). So a text search here is document-wide by construction: it hits
 * EVERY indexed search field.
 *
 * That is harmless only because `produtos` has exactly one, `nome` — and it
 * stays harmless only because `firestore-text-index.test.js` asserts the
 * produtos text indexes are exactly one on exactly `nome`. Declaring a second
 * one would silently widen every query in this file and every query the search
 * box issues, with nothing to catch it but that test.
 */
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

/**
 * {@link buscaTexto} with an explicit `retrievalDepth`, for Q4c.
 *
 * ⚠️ `retrievalDepth` caps how many documents the SEARCH STAGE pulls out of the
 * index BEFORE anything downstream runs — and downstream here is
 * `paiId == null`, a post-filter, because `search` must be first. So the depth
 * is spent on parents and variation CHILDREN alike, and a page of 50 parents can
 * be starved by children that never survive the filter. That failure is silent:
 * a short page looks exactly like a small catalogue.
 *
 * `undefined` leaves the option off entirely, which is what the other probes
 * send and what the backend default (whatever it is) then applies.
 */
function buscaTextoComProfundidade(dsl, profundidade) {
  return db
    .pipeline()
    .collection('produtos')
    .search({
      query: pipelines.documentMatches(dsl),
      ...(profundidade === undefined ? {} : { retrievalDepth: profundidade }),
    })
    .where(pipelines.field('paiId').equal(null))
    .limit(50);
}

/**
 * The CURRENT nome search, expressed as a PIPELINE rather than a classic query.
 *
 * ⚠️⚠️ Not a stylistic choice. Firestore Enterprise REFUSES explain on the
 * classic path outright:
 *
 *   3 INVALID_ARGUMENT: Explain options are not supported in RunQuery API for
 *   Enterprise edition. Please use the ExecutePipeline API instead.
 *
 * so `query.explain({ analyze: true })` — the shape every sibling check-*.mjs
 * script uses, and the one this file used first — cannot measure anything here.
 * It is also the RIGHT comparison: TableView runs the Pipelines path in
 * production and only falls back to a classic Query when the SDK lacks
 * pipelines, so measuring the prefix range as a pipeline is closer to what
 * /produtos actually issues, and puts both sides of Q1 on the same API with
 * the same explainStats.
 */
function prefixoNomePipeline(termo) {
  return db
    .pipeline()
    .collection('produtos')
    .where(
      pipelines.and(
        pipelines.field('paiId').equal(null),
        pipelines.field('nome').greaterThanOrEqual(termo),
        pipelines.field('nome').lessThanOrEqual(`${termo}${PREFIX_SENTINEL}`),
      ),
    )
    .sort(pipelines.ascending(pipelines.field('nome')))
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

  // ⚠️⚠️ The precondition that decides how to read everything below. Without the
  // text index deployed AND built, `search(documentMatches)` still RETURNS rows
  // — it just scans to get them (measured: 165 read units vs the prefix range's
  // 25 for the same 2 rows, and `index row scanned` equal to the collection
  // size). So the COST numbers describe the UNINDEXED path and must be re-read
  // after a deploy; the CAPABILITY result (a mid-name word matching) is
  // structural and holds either way.
  console.log('');
  console.log('⚠️  If the text index is not yet deployed AND finished building,');
  console.log('    every text-search number below is the UNINDEXED path. Compare');
  console.log('    `index row scanned` against the collection size to tell.');

  // === Q1 — cost, same term through both paths ============================
  const nome = amostra.primeiro.nome.trim();
  const primeiraPalavra = nome.split(/\s+/)[0];
  console.log(
    `\n${'='.repeat(70)}\nQ1 COST — term "${primeiraPalavra}" (a real prefix)\n${'='.repeat(70)}`,
  );
  await explicarPipeline(`prefix range on nome`, prefixoNomePipeline(primeiraPalavra));
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
    await explicarPipeline(`prefix range on nome`, prefixoNomePipeline(meio));
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
  console.log('');
  console.log('  ⚠️  AND firestore.indexes.json now DECLARES `nome` ONLY — sku was');
  console.log('     dropped. Until the index is recreated from that declaration the');
  console.log('     LIVE index may still carry sku, so this probe can pass today and');
  console.log('     start missing later. Either way a miss is about FIELD COVERAGE,');
  console.log('     not about what text search can do.');

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
      console.warn('  ⚠️  no match — expected once the index is rebuilt without sku.');
      console.warn('     A field-coverage result, not a capability one. See above.');
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
  console.log('  firestore.indexes.json DECLARES pt-BR, but `firebase deploy`');
  console.log('  silently DROPS searchIndexOptions — so the live index may still');
  console.log('  be on autodetect. These probes are the evidence for whether the');
  console.log('  declared pt-BR actually reached the deployed index.');

  if (amostra.plural) {
    const pluralWord = amostra.plural.nome.trim().split(/\s+/)[0];
    const singular = pluralWord.slice(0, -1);
    console.log(`\n  stemming: searching "${singular}" should find "${amostra.plural.nome}"`);
    // Stemming is an analyzer property, so read the ANALYZED form — a quoted
    // phrase is literal and would report "no stemming" for every word.
    const n = await probarTermo(`search("${singular}")`, singular, buscaTexto, 'analisado');
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

    // ⚠️⚠️ CONTROL FIRST. A zero on the unaccented form only means "no accent
    // folding" if the index can find that document by its accented word at all.
    // Without this the probe cannot tell folding from a term that never matched
    // for some unrelated reason — a checker needs a known-GOOD case as well as
    // a known-BAD one.
    console.log(
      `\n  control: "${palavra}" must match "${nomeAcentuado}" for the next probe to mean anything`,
    );
    const controle = await probarTermo(
      `control search("${palavra}")`,
      palavra,
      buscaTexto,
      'analisado',
    );

    // ⚠️⚠️ THREE outcomes, not two. `probarTermo` returns null when the
    // pipeline EXECUTION failed — a missing or still-building text index, which
    // this script calls its most informative result. `null === 0` is false, so
    // testing only for 0 let that failure fall through to the `else` and print
    // the green verdict: the one run that proves nothing announcing the exact
    // positive answer this PR exists to obtain. Check null FIRST, everywhere.
    if (controle === null) {
      console.warn('  ⚠️  CONTROL DID NOT RUN: the pipeline execution failed (missing');
      console.warn('     or still-building index?). Skipping the accent probe — it');
      console.warn('     could not tell folding from a query that never ran.');
    } else if (controle === 0) {
      console.warn('  ⚠️  CONTROL FAILED: the accented word does not match its own');
      console.warn('     document, so the accent probe below is INCONCLUSIVE — the');
      console.warn('     miss would not be evidence about folding.');
    } else {
      console.log(`\n  accents: searching "${semAcento}" should find "${nomeAcentuado}"`);
      const n = await probarTermo(`search("${semAcento}")`, semAcento, buscaTexto, 'analisado');
      if (n === null) {
        console.warn('  ⚠️  the accent probe did not run (pipeline failed) — NO verdict.');
      } else if (n === 0) {
        console.warn(`  ⚠️  "${semAcento}" did NOT match "${palavra}" while the control DID.`);
        console.warn('     Evidence that this WORD does not fold — see the caveat below.');
      } else {
        console.log(`  ✅ "${semAcento}" matched "${palavra}" — this word folds.`);
      }
      // ⚠️⚠️ ONE WORD IS NOT THE ANALYZER. Measured on staging, folding under
      // pt-BR is INCONSISTENT across words: "Estatua"→Estátua and "Leao"→Leão
      // both matched, while "Ceramica"→Cerâmica, "Luminaria"→Luminária and
      // "lapis"→lápis all missed — same index, same run, 2 of 4 accented words
      // in the catalogue. So this probe reports the word it happened to sample
      // and nothing more; which word discovery picks decides the verdict, and
      // a single ✅ here must not be read as "accent search works".
      console.log('  ⚠️  ONE word. Folding measured INCONSISTENT across words under');
      console.log('     pt-BR (2 of 4 in the staging catalogue), so do not read this');
      console.log('     line as a property of the analyzer — sample more words first.');
    }
  } else {
    console.log('\n  accent probe skipped: no accented word free of DSL operator');
    console.log('  characters in any sampled nome (a hyphen would confound it).');
  }

  // === Q4a — can a PARTIALLY TYPED word match? ============================
  //
  // ⚠️⚠️ THE question for putting this behind the /produtos search box, and the
  // one no CI lane can answer: pipelines do not run in the emulator.
  //
  // Today the box is a prefix RANGE, so "Cami" narrows to "Camiseta…" from the
  // first letter. A TOKENIZED index matches whole tokens, and the documented DSL
  // grammar has no wildcard — space is AND, `-` negates, quotes make a literal
  // phrase, `field:term` scopes. Google's own text-search page does not mention
  // prefix or wildcard matching at all, and Firebase's as-you-type article sends
  // the raw term without addressing partial words. So this is measured, not
  // assumed: if nothing below reaches the target, swapping REMOVES as-you-type
  // narrowing and the box gets worse, not better.
  const alvo = amostra.primeiro;
  console.log(
    `\n${'='.repeat(70)}\nQ4a PREFIX — does a PARTIALLY TYPED word match?\n${'='.repeat(70)}`,
  );
  console.log(`  target: "${alvo.nome}" (${alvo.id}), truncating "${primeiraPalavra}"`);

  const controleQ4 = await idsDaBusca(`control  "${primeiraPalavra}"`, buscaTexto(primeiraPalavra));
  if (controleQ4 === null) {
    console.warn('  ⚠️  CONTROL DID NOT RUN (missing or still-building index?).');
    console.warn('     Skipping Q4a — a miss could not be told from a query that failed.');
  } else if (!controleQ4.includes(alvo.id)) {
    console.warn(`  ⚠️  CONTROL FAILED: the FULL word "${primeiraPalavra}" does not return`);
    console.warn('     its own document, so no truncation of it could mean anything.');
    console.warn('     Skipping Q4a.');
  } else {
    // Both forms of every truncation: bare, and with a trailing `*`. The star is
    // in the DSL's operator set (see semOperadorDsl), which is evidence it means
    // SOMETHING — not evidence that it means "prefix". That is what this asks.
    const cortes = [1, 2, 3]
      .map((n) => primeiraPalavra.slice(0, primeiraPalavra.length - n))
      .filter((t) => t.length >= 3);
    if (cortes.length === 0) {
      console.log(`  skipped: "${primeiraPalavra}" is too short to truncate to >= 3 letters.`);
    }
    let algumAlcancou = false;
    for (const corte of cortes) {
      for (const dsl of [corte, `${corte}*`]) {
        const ids = await idsDaBusca(`  "${dsl}"`, buscaTexto(dsl));
        if (ids === null) continue;
        if (ids.includes(alvo.id)) {
          algumAlcancou = true;
          console.log(`    ✅ reached the target`);
        } else if (ids.length > 0) {
          // ⚠️ The reading that a count would have got wrong.
          console.log(`    ✗ matched ${ids.length} OTHER document(s), not the target`);
        } else {
          console.log(`    ✗ no match`);
        }
      }
    }
    if (algumAlcancou) {
      console.log('\n  ✅ at least one partial form reached the target. The forms that');
      console.log('     worked are listed above — the box can keep narrowing as you type,');
      console.log('     and the DSL builder must emit exactly that form.');
    } else {
      console.warn('\n  ⚠️  NO partial form reached the target, while the full word DID.');
      console.warn('     Read as: this index does not do prefix matching. A straight swap');
      console.warn('     would leave the box blank until a whole word is typed — worse');
      console.warn('     than today. Keep the prefix range, or run both and merge; do not');
      console.warn('     adopt on this result.');
    }
  }

  // === Q4b — does SANITISING recover a term carrying a DSL operator? ======
  console.log(
    `\n${'='.repeat(70)}\nQ4b SANITISING — a term the DSL would misread\n${'='.repeat(70)}`,
  );
  if (amostra.palavraComOperador) {
    const { id: alvoOpId, palavra: comOperador, nome: nomeOperador } = amostra.palavraComOperador;
    // What the search box would send instead: operators become spaces. NOT
    // quotes — measured in comoFrase, quoting also suppresses the ANALYZER, so
    // it trades one silent failure for another.
    const higienizado = comOperador
      .replace(/["()+:~^*?\-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    console.log(`  target: "${nomeOperador}" (${alvoOpId})`);
    console.log(`  raw "${comOperador}" vs sanitised "${higienizado}"`);
    const idsRaw = await idsDaBusca(`  raw        "${comOperador}"`, buscaTexto(comOperador));
    const idsLimpo = await idsDaBusca(`  sanitised  "${higienizado}"`, buscaTexto(higienizado));
    const achouRaw = idsRaw?.includes(alvoOpId) ?? null;
    const achouLimpo = idsLimpo?.includes(alvoOpId) ?? null;
    if (achouRaw === null || achouLimpo === null) {
      console.warn('  ⚠️  one of the two probes did not run — NO verdict.');
    } else if (!achouLimpo) {
      console.warn('  ⚠️  the SANITISED form did not reach the target either. Sanitising is');
      console.warn('     then not the fix, and the DSL is not the whole story — investigate');
      console.warn('     before shipping a sanitiser that assumes it is.');
    } else if (achouRaw) {
      console.log('  ✅ both reached it. This word is not a discriminating case: the raw');
      console.log('     form was not misparsed, so it proves nothing about the hazard.');
    } else {
      console.log('  ✅ sanitising RECOVERED the match the raw term lost. That is the');
      console.log('     hazard reproduced and the fix confirmed, on real catalogue data.');
    }
  } else {
    console.log('  skipped: no sampled nome carries a DSL operator character.');
    console.log('  ⚠️ Not evidence that the hazard is absent — only that this sample');
    console.log('     cannot exercise it. Widen discovery before reading it as safe.');
  }

  // === Q4c — can retrievalDepth starve the page? ==========================
  //
  // `search` is first, so `paiId == null` post-filters. The depth is spent on
  // parents and variation CHILDREN alike, and a short page then looks exactly
  // like a small catalogue. TableView grows its LIMIT to paginate, so if depth
  // is what binds, growing the limit fetches nothing more.
  console.log(
    `\n${'='.repeat(70)}\nQ4c RETRIEVAL DEPTH — what actually binds the page\n${'='.repeat(70)}`,
  );
  const contagens = [];
  for (const profundidade of [undefined, 200, 1000]) {
    const rotulo = `  retrievalDepth=${profundidade ?? '(unset)'}`;
    const ids = await idsDaBusca(rotulo, buscaTextoComProfundidade(primeiraPalavra, profundidade));
    contagens.push({ profundidade, n: ids?.length ?? null });
  }
  const validas = contagens.filter((c) => c.n !== null);
  if (validas.length < 2) {
    console.warn('  ⚠️  fewer than two probes ran — NO verdict on retrieval depth.');
  } else if (new Set(validas.map((c) => c.n)).size === 1) {
    console.log(`  all runs returned ${validas[0].n} — depth is not what binds at this`);
    console.log("  catalogue size. ⚠️ That is a fact about TODAY'S data, not a property");
    console.log('  of the stage: re-run it against a catalogue with more variation');
    console.log('  children before relying on the default.');
  } else {
    console.warn('  ⚠️  the counts DIFFER, so retrievalDepth IS binding. Set it explicitly');
    console.warn('     and scale it with the page limit, or "load more" silently stops');
    console.warn('     returning rows that exist.');
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log('Read Q1 for cost, Q2/Q2b for what the prefix range cannot do,');
  console.log('Q3 for whether the default analyzer speaks Portuguese, and Q4 for');
  console.log('whether the /produtos search BOX can be moved onto this at all.');
  console.log('⚠️ Q4a is the gate. A search box that only answers complete words is');
  console.log('   a REGRESSION against the prefix range it would replace, whatever');
  console.log('   Q1-Q3 say — read it before writing any UI.');
  console.log('⚠️ If Q1/Q2 do not justify adopting text search, REVERT the index');
  console.log('   entry — it is not staging-scoped and would otherwise be built');
  console.log('   and maintained in production with no reader.');
  console.log('This script is a measurement, not a gate — it always exits 0.');
}

// A measurement, not a gate: a probe that throws must still print WHY and let
// the process end cleanly, rather than dying as an uncaught exception and
// taking the remaining questions with it. That is exactly how the Enterprise
// "explain not supported in RunQuery" refusal first surfaced.
try {
  await main();
  // eslint-disable-next-line no-restricted-syntax -- top-level diagnostic boundary; see above
} catch (err) {
  console.error('\n❌ the run stopped early:', mensagemDoErro(err));
  console.error('   Everything printed above still stands.');
}
