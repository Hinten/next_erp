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
 * would all read as green. 32 bodies were promoted from the #1087 run; the floor
 * sits just under that so removing one is deliberate and removing the set is a
 * failure.
 */
const MINIMO_DE_FIXTURES = 30;

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
