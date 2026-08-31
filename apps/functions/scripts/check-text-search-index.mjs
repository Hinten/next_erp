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
//      two apart empirically. Measured under AUTODETECT: case folding YES, pt
//      plural stemming YES, diacritic folding NO — so a miss on the accent probe
//      means pt-BR never reached the index (or does not fix diacritics).
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
  const semOperadorDsl = (w) => !/["()+:~^*?\-]/.test(w);
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

    // ⚠️⚠️ CONTROL FIRST. A zero on the unaccented form only means "no accent
    // folding" if the index can find that document by its accented word at all.
    // Without this the probe cannot tell folding from a term that never matched
    // for some unrelated reason — a checker needs a known-GOOD case as well as
    // a known-BAD one.
    console.log(
      `\n  control: "${palavra}" must match "${nomeAcentuado}" for the next probe to mean anything`,
    );
    const controle = await probarTermo(`control search("${palavra}")`, palavra, buscaTexto);

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
      const n = await probarTermo(`search("${semAcento}")`, semAcento, buscaTexto);
      if (n === null) {
        console.warn('  ⚠️  the accent probe did not run (pipeline failed) — NO verdict.');
      } else if (n === 0) {
        console.warn(`  ⚠️  "${semAcento}" did NOT match "${palavra}" while the control DID.`);
        console.warn('     That IS evidence: the default analyzer does not fold accents.');
      } else {
        console.log(`  ✅ "${semAcento}" matched "${palavra}" — the analyzer folds accents.`);
      }
    }
  } else {
    console.log('\n  accent probe skipped: no accented word free of DSL operator');
    console.log('  characters in any sampled nome (a hyphen would confound it).');
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log('Read Q1 for cost, Q2/Q2b for what the prefix range cannot do,');
  console.log('and Q3 for whether the default analyzer speaks Portuguese.');
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
