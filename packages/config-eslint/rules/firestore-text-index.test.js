import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './lib/repo-scan.js';

/**
 * Repo invariants for Firestore Enterprise TEXT SEARCH indexes in
 * `firestore.indexes.json`.
 *
 * ⚠️⚠️ THE FACT THAT MAKES THIS FILE NECESSARY: `firebase deploy` does NOT send
 * `searchIndexOptions`. firebase-tools builds the index-create body from an
 * explicit whitelist (`lib/firestore/api.js`, `createIndex`):
 *
 *   return this.apiClient.post(url, {
 *     fields, queryScope, apiScope, density, multikey, unique,
 *   });
 *
 * `searchIndexOptions` is not in it, and `validateIndex` does not reject unknown
 * keys — so a `textLanguage` declared here deploys **successfully, silently
 * dropped**. There is no error to notice. The index is created with the ANY_API
 * default, which the Admin API discovery doc documents as **autodetect**.
 *
 * So the declaration below is the INTENT, and the language must additionally be
 * set out of band, once, per index:
 *
 *   gcloud firestore indexes composite create \
 *     --database='default' --collection-group=produtos \
 *     --query-scope=collection --api-scope=any-api \
 *     --field-config=field-path=nome,search-config=TEXT_TOKENIZED_MATCH_GLOBALLY \
 *     --search-index-options=text-language=pt-BR
 *
 * ⚠️ An existing index's language cannot be patched — it has to be deleted and
 * recreated. `firebase firestore:indexes` exports the shape the backend actually
 * accepted, which is the only way to confirm what is live.
 *
 * These tests cannot verify the deployed state (no credentials in CI). They pin
 * the three things that ARE checkable in the file, each of which is a mistake
 * that fails silently rather than loudly.
 */

function lerIndexes() {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, 'firestore.indexes.json'), 'utf8'));
}

const temSearchConfig = (campo) => Object.hasOwn(campo, 'searchConfig');
const ehTextIndex = (idx) => idx.fields.some(temSearchConfig);

describe('firestore text-search indexes', () => {
  it('never mixes search fields with ordered/array fields in one index', () => {
    // The API refuses an index that carries BOTH a `searchConfig` field and an
    // `order`/`arrayConfig` one — a text index is not a composite index with a
    // text column bolted on. The tempting shape is "nome TEXT + paiId ASC" so
    // that the parents-only filter rides the index; it does not exist. The
    // filter has to be a separate pipeline stage AFTER `search`.
    for (const idx of lerIndexes().indexes) {
      const comBusca = idx.fields.filter(temSearchConfig);
      if (comBusca.length === 0) continue;
      expect(
        comBusca.length,
        `${idx.collectionGroup}: an index may contain ONLY searchConfig fields or ` +
          `NONE — mixing them is refused by the API`,
      ).toBe(idx.fields.length);
    }
  });

  it('declares an explicit textLanguage on every text index', () => {
    // Omitting it is not neutral: under ANY_API the backend autodetects per
    // document, so the analyzer becomes a property of the DATA rather than a
    // decision. Measured on staging with autodetect: case folding and pt plural
    // stemming both work, diacritic folding does NOT.
    for (const idx of lerIndexes().indexes.filter(ehTextIndex)) {
      expect(
        idx.searchIndexOptions?.textLanguage,
        `${idx.collectionGroup}: text index must declare searchIndexOptions.textLanguage`,
      ).toBeTruthy();
    }
  });

  it('uses a REGIONAL language tag, because the backend rejects a bare one', () => {
    // Measured, not assumed: `languageCode: 'pt'` comes back
    //   3 INVALID_ARGUMENT: search(...): Language code 'pt' is not supported.
    // while 'pt-BR' is accepted. A bare tag here would deploy (the CLI drops the
    // whole option anyway) and then fail whenever it IS applied by hand.
    for (const idx of lerIndexes().indexes.filter(ehTextIndex)) {
      expect(
        idx.searchIndexOptions.textLanguage,
        `${idx.collectionGroup}: use a regional BCP-47 tag such as pt-BR, not a bare one`,
      ).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
    }
  });

  it('keeps the produtos text index on `nome`, tokenized and globally matched', () => {
    const produtos = lerIndexes().indexes.filter(
      (i) => i.collectionGroup === 'produtos' && ehTextIndex(i),
    );
    expect(produtos).toHaveLength(1);
    const [idx] = produtos;
    expect(idx.apiScope).toBe('ANY_API');
    expect(idx.queryScope).toBe('COLLECTION');
    expect(idx.fields.map((f) => f.fieldPath)).toEqual(['nome']);
    expect(idx.fields[0].searchConfig.textSpec.indexSpecs).toEqual([
      { indexType: 'TOKENIZED', matchType: 'MATCH_GLOBALLY' },
    ]);
    expect(idx.searchIndexOptions.textLanguage).toBe('pt-BR');
  });

  it('declares SPARSE_ANY density on every text index, because an absent one is not neutral', () => {
    // ⚠️⚠️ THE ONE THAT HAS ALREADY REGRESSED, TWICE UNNOTICED.
    //
    // The backend builds a search index `SPARSE_ANY`. firebase-tools compares
    // density as part of index IDENTITY and resolves an absent one to a default
    // that is `DENSE` on Enterprise (`optionalDensityMatches`, its
    // `firestore/api.js`; SPARSE_ALL is the STANDARD-edition default). So an
    // entry with no density describes an index the database does not have, and
    // the same physical index is then classified twice: as a live index missing
    // from this file, and as a file index missing from the server.
    //
    // The visible symptom is a delete prompt on every `firebase deploy --only
    // firestore:indexes`. The invisible one is worse: the deploy's delete loop
    // runs AFTER its create loop, so accepting that prompt drops the live index
    // and leaves the replacement on `textLanguage: und` — silently undoing the
    // out-of-band `set-text-index-language.mjs` step, because `firebase deploy`
    // cannot send `searchIndexOptions` at all (see the file header).
    //
    // History, which is why this is a test and not a comment: `b5f8a898` added
    // this key for exactly that 409-plus-delete-prompt symptom, and `02009f5e`
    // dropped it two hours later while rewriting the entry for pt-BR. Nothing
    // failed. The three tests above all still passed — they pin the language and
    // the field shape, and density is neither.
    for (const idx of lerIndexes().indexes.filter(ehTextIndex)) {
      expect(
        idx.density,
        `${idx.collectionGroup}: a text index must declare "density": "SPARSE_ANY" — ` +
          `an absent one reads as DENSE on Enterprise and makes the deploy offer to ` +
          `DELETE the live index`,
      ).toBe('SPARSE_ANY');
    }
  });
});
