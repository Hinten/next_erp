import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { WireValue } from './redact';
import { WIRE_DIR, listWireFixtures } from './wireCorpus';
import { SHAPES_FILE, renderShapesDocument, renderShapesFromCorpus } from './wireShapes';

/**
 * ⚠️ Line endings are normalised before comparing, and that is not laziness.
 * The primary fix is the `text eol=lf` pin in `.gitattributes` — without it,
 * `core.autocrlf=true` smudges this generated file to CRLF on checkout, the
 * byte comparison fails on Windows and passes on the Linux runner, and the red
 * looks like someone else's broken file. This is the second line of defence for
 * a working tree that predates that attribute. Nothing about the shape document
 * is carried by its line endings.
 */
const committed = (): string =>
  readFileSync(join(WIRE_DIR, SHAPES_FILE), 'utf8').replace(/\r\n/g, '\n');

describe('SHAPES.txt', () => {
  it('matches the committed corpus exactly', () => {
    // ⚠️ When this fails, READ THE DIFF before regenerating. It is the shape of
    // the corpus changing, which is the single signal this whole directory
    // exists to produce. Regenerate with:
    //   pnpm --filter @delfrance/mercado-livre-app promote:fixtures
    expect(renderShapesFromCorpus()).toBe(committed());
  });

  it('has a section per fixture — no body silently missing from the document', () => {
    const texto = committed();
    for (const file of listWireFixtures()) {
      expect(texto, `${file} não tem seção em ${SHAPES_FILE}`).toContain(`## ${file}`);
    }
  });

  it('carries the facts a reader would come here for', () => {
    // A spot check that the document is real content and not an empty scaffold:
    // findings from the #1087 run that should be legible straight off it.
    const texto = committed();
    expect(texto).toContain('variations: []');
    expect(texto).toContain('payments[].date_last_modified: string');

    // ⚠️ NOT `not.toContain('date_last_updated')`. That assertion was written
    // here first and failed, which is how the endpoint disagreement below was
    // found: `/orders/search` really does send `date_last_updated`. A blanket
    // absence check over the whole document conflates two endpoints.
    expect(texto).toContain('[].payments[].date_last_updated: null');
  });

  it('is deterministic — regenerating twice yields identical bytes', () => {
    expect(renderShapesFromCorpus()).toBe(renderShapesFromCorpus());
  });
});

describe('renderShapesDocument', () => {
  it('CONTROL — a changed body changes the document', () => {
    // Without this, a renderer that ignored its input would satisfy every
    // assertion above for as long as the committed file stayed put.
    const antes = renderShapesDocument(new Map([['a.json', { id: 1 }]]));
    const depois = renderShapesDocument(new Map([['a.json', { id: '1' }]]));
    expect(depois).not.toBe(antes);
  });

  it('CONTROL — a renamed FILE changes the document', () => {
    expect(renderShapesDocument(new Map([['a.json', { id: 1 }]]))).not.toBe(
      renderShapesDocument(new Map([['b.json', { id: 1 }]])),
    );
  });

  it('sorts sections by filename, so section order never causes a spurious diff', () => {
    const um = renderShapesDocument(
      new Map<string, WireValue>([
        ['b.json', { x: 1 }],
        ['a.json', { y: 2 }],
      ]),
    );
    const dois = renderShapesDocument(
      new Map<string, WireValue>([
        ['a.json', { y: 2 }],
        ['b.json', { x: 1 }],
      ]),
    );
    expect(um).toBe(dois);
    expect(um.indexOf('## a.json')).toBeLessThan(um.indexOf('## b.json'));
  });
});
