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
});
