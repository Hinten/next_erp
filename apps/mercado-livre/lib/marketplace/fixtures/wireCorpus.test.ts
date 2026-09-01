import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { formatFindings, scanForPii } from './piiScan';
import { type WireValue } from './redact';
import { WIRE_DIR, listWireFixtures, readWireFixture } from './wireCorpus';

/**
 * The floor that keeps every assertion below non-vacuous.
 *
 * ⚠️ Without it this whole file passes on an EMPTY directory: "no fixture
 * contains PII" and "every fixture parses" are both trivially true of nothing.
 * A deleted `__wire__/`, a bad glob or a `.gitignore` that swallows the folder
 * would all read as green. 30 bodies were promoted from the #1087 run; the floor
 * sits just under that so removing one is deliberate and removing the set is a
 * failure.
 */
const MINIMO_DE_FIXTURES = 28;

describe('__wire__ corpus', () => {
  const arquivos = listWireFixtures();

  it('is present and populated — the guard that makes the rest of this file mean something', () => {
    expect(
      arquivos.length,
      `esperava >= ${MINIMO_DE_FIXTURES} fixtures em ${WIRE_DIR}, achei ${arquivos.length}`,
    ).toBeGreaterThanOrEqual(MINIMO_DE_FIXTURES);
  });

  it('covers every endpoint family the run captured', () => {
    // Named families rather than a count: a fixture set that lost all its
    // shipments but gained five orders would still clear the floor above.
    const familias = [
      'item',
      'items-',
      'orders-',
      'packs-',
      'shipments-',
      'collections-',
      'post-purchase',
    ];
    for (const familia of familias) {
      expect(
        arquivos.some((f) => f.startsWith(familia)),
        `nenhuma fixture da família "${familia}"`,
      ).toBe(true);
    }
  });

  it('carries the non-200 captures, which are data and not failures', () => {
    // A 404 body is a recorded ML behaviour (a pack id that is an order id, a
    // shipment with no SLA). Losing them would quietly narrow the corpus to the
    // happy path.
    expect(arquivos.some((f) => f.endsWith('.404.json'))).toBe(true);
  });

  it('is valid JSON, every file', () => {
    for (const file of arquivos) {
      expect(() => readWireFixture(file), `${file} não é JSON`).not.toThrow();
    }
  });

  it('contains NO personal data — both scanner layers, every file', () => {
    const problemas: string[] = [];
    for (const file of arquivos) {
      const findings = scanForPii(readWireFixture(file));
      if (findings.length > 0) problemas.push(formatFindings(file, findings));
    }

    // The message carries paths and kinds only — never the offending value.
    expect(problemas.join('\n')).toBe('');
  });

  it('is a redaction FIXPOINT, so a newly denylisted path cannot be left behind', () => {
    // Widening REDACTED_PATH_SUFFIXES without re-running promote:fixtures would
    // leave the committed corpus stale. This is the assertion that catches it,
    // and its fix is `pnpm --filter @delfrance/mercado-livre-app promote:fixtures`.
    const desatualizadas = arquivos.filter((file) => {
      const corpo = readWireFixture(file);
      return scanForPii(corpo).some((f) => f.kind === 'unredacted-path');
    });

    expect(desatualizadas).toEqual([]);
  });
});

describe('every body is really from the WIRE', () => {
  // ⚠️ This is the corpus's ONE load-bearing claim, and it shipped broken:
  // `order-single.json` and `order-pack.json` were `buildOrderMLWire` output —
  // the `orderML` Firestore mirror — dumped during an earlier debugging session
  // and promoted along with the real captures. They carried an ERP field ML
  // never sends, ms-epoch dates where ML sends ISO strings, and all three of
  // `buildPaymentWire`'s hardcodes. So the corpus shipped two files enshrining
  // exactly the bug its own README cites as the reason it exists.
  //
  // Removing them fixed that day. These assertions are what makes it not recur.

  it('carries no ERP-only field — the tell that a body came from Firestore', () => {
    const infratores: string[] = [];
    for (const file of listWireFixtures()) {
      const texto = JSON.stringify(readWireFixture(file));
      // A Firestore document path, and the outerRef convention around it.
      if (/"[a-zA-Z]*[Oo]uterRef"|documents\/integracao\//.test(texto)) infratores.push(file);
    }
    expect(infratores).toEqual([]);
  });

  it('carries no `buildPaymentWire` signature — its three hardcodes together', () => {
    // `collector_id: null` + `payer: null` + `date_last_updated` present while
    // `date_last_modified` is absent. ML sends `collector: {id}`, a flat
    // `payer_id`, and `date_last_modified`; only our own builder emits this trio.
    const infratores: string[] = [];
    for (const file of listWireFixtures()) {
      const texto = JSON.stringify(readWireFixture(file));
      if (texto.includes('"date_last_updated"') && !texto.includes('"date_last_modified"')) {
        infratores.push(file);
      }
    }
    expect(infratores).toEqual([]);
  });

  it('has a filename `capture:fixtures` could actually have produced', () => {
    // `slugForPath` turns a request path into `<segment>-<segment>…`, so every
    // real capture is named after its endpoint. `order-single` / `order-pack`
    // match no ML path at all — the name alone said they were hand-made.
    const familias = /^(items?|orders|packs|shipments|collections|post-purchase)-/;
    const infratores = listWireFixtures().filter((f) => !familias.test(f));
    expect(infratores).toEqual([]);
  });
});

describe('provenance', () => {
  it('does not ship the capture manifest, which names the project and integração', () => {
    expect(readdirSync(WIRE_DIR)).not.toContain('_manifest.json');
  });

  it('ships a README explaining where these bodies came from', () => {
    const readme = readFileSync(join(WIRE_DIR, 'README.md'), 'utf8');
    expect(readme).toContain('promote:fixtures');
    expect(readme.length).toBeGreaterThan(200);
  });
});

describe('wire values are plain JSON', () => {
  it('has no undefined-producing constructs after the round trip', () => {
    // `JSON.parse` never yields `undefined` inside a structure, so this asserts
    // the reader rather than the data — it fails if `readWireFixture` ever grows
    // a transform that materialises keys.
    const visitar = (v: WireValue): void => {
      if (v === null) return;
      if (Array.isArray(v)) return v.forEach(visitar);
      if (typeof v === 'object') {
        for (const [, entry] of Object.entries(v)) {
          expect(entry).not.toBeUndefined();
          visitar(entry);
        }
      }
    };
    for (const file of listWireFixtures()) visitar(readWireFixture(file));
  });
});
