/* eslint-disable no-console -- CLI script: stdout is the interface */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Live, READ-ONLY diagnostic for "some produtos show no thumbnail".
//
// The symptom is a produto whose photo renders inside the editor's Imagens tab
// but not in the /produtos list. That means the ORIGINAL `arquivos` doc is fine
// and the DERIVATIVE doc (`<produtoId>_<hash>_200`) is missing — the 200/400/
// jpeg documents `resizeProductImage` is supposed to create. This script answers
// which of the two possible causes is in play:
//
//   A. REGRESSION — derivatives used to be produced and stopped. Working
//      produtos have real derivative docs.
//   B. NEVER WORKED here — no derivative has ever been produced in this project,
//      and the produtos that look fine are only the LEGACY ones, whose
//      derivative refs are null so readers correctly use the original.
//
// The `derivativeRefResolves` count below separates them: non-zero ⇒ A, zero ⇒ B.
//
// It writes NOTHING. Run it against a live project (the emulator has neither the
// data nor Enterprise semantics):
//
//   GOOGLE_APPLICATION_CREDENTIALS=<sa.json> \
//   FIREBASE_PROJECT_ID=veste-france-debug \
//   node apps/functions/scripts/check-derivatives.mjs
//
// Targets the named `default` database (Firestore Enterprise; see deploy gotcha
// #8 in apps/functions/CLAUDE.md), overridable via FIREBASE_DATABASE_ID.
//
// ⚠️ COST. This Enterprise edition auto-creates NO index and bills DATA SCANNED,
// and `arquivos(resizeState)` is NOT declared in firestore.indexes.json — so the
// pending query below scans the collection. Every read here is therefore
// `limit()`-bounded, and PRODUTO_SAMPLE is a sample, not a census. Raise it
// deliberately.

const projectId = process.env.FIREBASE_PROJECT_ID ?? 'veste-france-debug';
const databaseId = process.env.FIREBASE_DATABASE_ID ?? 'default';
const PENDING_SAMPLE = Number(process.env.PENDING_SAMPLE ?? '200');
const PRODUTO_SAMPLE = Number(process.env.PRODUTO_SAMPLE ?? '200');

const app = initializeApp({ projectId });
const db = getFirestore(app, databaseId);

console.log(`project=${projectId} database=${databaseId}`);

/* ------------------------------------------------------------------------- */
/* 1. The resize backlog                                                      */
/* ------------------------------------------------------------------------- */

// `uploadProductImage` stamps every original `resizeState: 'pending'`;
// `processProductOriginal` flips it to 'done'. So a pending doc is an original
// whose derivatives were never finished — by the trigger OR by the 48h
// `reconcileProductImages` sweep, which reads exactly this query.
const pendentes = await db
  .collection('arquivos')
  .where('resizeState', '==', 'pending')
  .limit(PENDING_SAMPLE)
  .get();

let maisAntigo = null;
for (const doc of pendentes.docs) {
  const criadoEm = doc.get('criadoEm');
  if (typeof criadoEm === 'number' && (maisAntigo === null || criadoEm < maisAntigo)) {
    maisAntigo = criadoEm;
  }
}

console.log(`\n=== resize backlog (arquivos where resizeState == 'pending') ===`);
console.log(`pending (capped at ${PENDING_SAMPLE}):`, pendentes.size);
if (maisAntigo !== null) {
  // criadoEm is microseconds since epoch.
  const data = new Date(maisAntigo / 1000);
  const idadeHoras = (Date.now() - maisAntigo / 1000) / 3_600_000;
  console.log(`oldest pending: ${data.toISOString()} (${idadeHoras.toFixed(1)}h ago)`);
  console.log(
    idadeHoras > 48
      ? '  ⚠️  older than one sweep interval — the 48h reconcileProductImages is NOT healing these'
      : '  within the 48h sweep window — could still be normal lag',
  );
}
if (pendentes.size === PENDING_SAMPLE) {
  console.log('  ⚠️  hit the cap — the real backlog is larger than this number');
}

/* ------------------------------------------------------------------------- */
/* 2. What the /produtos list actually resolves                               */
/* ------------------------------------------------------------------------- */

const produtos = await db.collection('produtos').limit(PRODUTO_SAMPLE).get();

const contagem = {
  semFoto: 0,
  /** Legacy foto: derivative refs are null, so readers use the original. Renders. */
  legacyNullRef: 0,
  /** Optimistic derivative ref whose document EXISTS. Renders. Proves hypothesis A. */
  derivativeRefResolves: 0,
  /** Optimistic derivative ref pointing at a doc that does NOT exist. THE BUG. */
  derivativeRefDangling: 0,
  /** Dangling derivative AND the original is gone too — a genuinely lost photo. */
  originalAlsoMissing: 0,
};
const exemplos = [];

const idDaRef = (ref) => {
  if (typeof ref !== 'string' || ref === '') return null;
  const segs = ref.split('/').filter(Boolean);
  const last = segs[segs.length - 1];
  return last && last.length > 0 ? last : null;
};

for (const produtoDoc of produtos.docs) {
  const foto = produtoDoc.get('fotos')?.[0];
  if (!foto) {
    contagem.semFoto += 1;
    continue;
  }
  const derivadoId = idDaRef(foto.arquivo200pxOuterRef) ?? idDaRef(foto.arquivo400pxOuterRef);
  const originalId = idDaRef(foto.arquivoOuterRef);
  if (derivadoId === null) {
    contagem.legacyNullRef += 1;
    continue;
  }

  const derivadoSnap = await db.collection('arquivos').doc(derivadoId).get();
  if (derivadoSnap.exists && derivadoSnap.get('url')) {
    contagem.derivativeRefResolves += 1;
    continue;
  }

  contagem.derivativeRefDangling += 1;
  const originalSnap = originalId ? await db.collection('arquivos').doc(originalId).get() : null;
  const originalOk = originalSnap?.exists && originalSnap.get('url');
  if (!originalOk) contagem.originalAlsoMissing += 1;
  if (exemplos.length < 5) {
    exemplos.push({
      produtoId: produtoDoc.id,
      sku: produtoDoc.get('sku') ?? null,
      derivadoAusente: derivadoId,
      original: originalId,
      originalIntacto: Boolean(originalOk),
      resizeStateDoOriginal: originalSnap?.get('resizeState') ?? null,
      objeto: originalSnap?.get('filepath')
        ? `${originalSnap.get('filepath')}/${originalSnap.get('filename')}`
        : null,
    });
  }
}

console.log(`\n=== cover photos over ${produtos.size} produtos (sample) ===`);
console.log(contagem);

console.log(`\n=== verdict ===`);
if (contagem.derivativeRefDangling === 0) {
  console.log('No dangling derivative refs in this sample — look elsewhere, or widen the sample.');
} else if (contagem.derivativeRefResolves > 0) {
  console.log(
    'HYPOTHESIS A — REGRESSION. Some produtos DO have real derivative docs, so the resize ' +
      'function worked at some point and stopped. Compare the working and broken uploads by ' +
      'date, then check the function logs around the changeover.',
  );
} else {
  console.log(
    'HYPOTHESIS B — NEVER PRODUCED HERE. Not one derivative document resolved in this sample; ' +
      'every produto that looks fine is a LEGACY foto with null derivative refs. Treat this as ' +
      '"resizeProductImage has never successfully run against this project", and check the ' +
      'deploy/region/bucket before looking for a regression.',
  );
}
if (contagem.originalAlsoMissing > 0) {
  console.log(
    `⚠️  ${contagem.originalAlsoMissing} produto(s) have NO usable arquivo at all — the original ` +
      'is gone too. Those are real lost photos, not a resize gap, and the reader fallback ' +
      'cannot save them.',
  );
}
if (exemplos.length > 0) {
  console.log('\nsamples to spot-check in the console:');
  console.log(JSON.stringify(exemplos, null, 2));
}

console.log('\nNothing was written.');
