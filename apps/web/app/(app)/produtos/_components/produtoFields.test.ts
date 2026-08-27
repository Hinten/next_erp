import { describe, expect, it } from 'vitest';
import { produtoSchema } from '@delfrance/schemas';
import {
  PRODUTO_PERSISTENT_SECTIONS,
  PRODUTO_SECTIONS,
  PRODUTO_SECTIONS_BASE,
  PRODUTO_SECTIONS_EDITAR,
  PRODUTO_TRANSIENT_FIELDS,
  SECTION_MERCADO_LIVRE,
  SECTION_MODIFICACOES,
  produtoObjectViewSchema,
} from './produtoFields';

/**
 * Backstop for the produto tab-order invariant: **Mercado Livre is the last tab
 * on every produto screen.**
 *
 * The bug this replaces: the create screen rendered `PRODUTO_SECTIONS` (Mercado
 * Livre last) while the edit screen appended its edit-only Modificações tab
 * AFTER that list, so the Mercado Livre tab shifted one position left the moment
 * the produto was saved. Nothing failed — both screens rendered fine, the tab
 * just moved — which is precisely why it needs a test rather than a docblock.
 *
 * `ObjectView` forwards `sections` to `SectionTabs`, which renders `<Tabs.Tab>`
 * in array order, so asserting the array IS asserting the rendered order.
 */
describe('produto section (tab) order', () => {
  it('ends every screen with the Mercado Livre tab', () => {
    expect(PRODUTO_SECTIONS.at(-1)).toBe(SECTION_MERCADO_LIVRE);
    expect(PRODUTO_SECTIONS_EDITAR.at(-1)).toBe(SECTION_MERCADO_LIVRE);
  });

  it('keeps the shared tabs identical and Mercado-Livre-free', () => {
    // The base list is what a new screen-specific tab must be inserted into —
    // appending to it instead is how the tab drifts off the end again.
    expect(PRODUTO_SECTIONS_BASE).not.toContain(SECTION_MERCADO_LIVRE);
    expect(PRODUTO_SECTIONS.slice(0, PRODUTO_SECTIONS_BASE.length)).toEqual(PRODUTO_SECTIONS_BASE);
    expect(PRODUTO_SECTIONS_EDITAR.slice(0, PRODUTO_SECTIONS_BASE.length)).toEqual(
      PRODUTO_SECTIONS_BASE,
    );
  });

  it('puts Modificações immediately before Mercado Livre, on the edit screen only', () => {
    expect(PRODUTO_SECTIONS_EDITAR.slice(-2)).toEqual([
      SECTION_MODIFICACOES,
      SECTION_MERCADO_LIVRE,
    ]);
    expect(PRODUTO_SECTIONS).not.toContain(SECTION_MODIFICACOES);
  });

  it('starts both screens on the same first tab', () => {
    // `ObjectView` reads `sections[0]` twice — the fallback section for fields
    // with no override, and the initial/reset active tab — so index 0 moving is
    // a behaviour change, not a cosmetic one.
    expect(PRODUTO_SECTIONS[0]).toBe(PRODUTO_SECTIONS_BASE[0]);
    expect(PRODUTO_SECTIONS_EDITAR[0]).toBe(PRODUTO_SECTIONS_BASE[0]);
  });

  it('names a persistent section that both screens actually render', () => {
    // `SectionTabs` matches `persistentSections` by name; a section listed here
    // but absent from a screen's tab list silently persists nothing.
    for (const section of PRODUTO_PERSISTENT_SECTIONS) {
      expect(PRODUTO_SECTIONS).toContain(section);
      expect(PRODUTO_SECTIONS_EDITAR).toContain(section);
    }
  });
});

/**
 * Backstop for the invariant `.passthrough()`'s removal from `produtoSchema`
 * made load-bearing (#461): **every key of the produto page model is either a
 * modeled produto-document field or listed in `PRODUTO_TRANSIENT_FIELDS`.**
 *
 * `ObjectView` strips only `transientFields` before handing the form values to
 * `saveRecord`, whose CREATE arm writes the full object through the collection
 * converter — `parseForWrite` (`packages/data/src/zodParse.ts`), which since
 * #461 re-parses `.strict()` the moment the lenient parse drops a key. So a
 * page-model field that is neither modeled nor transient no longer rides
 * `.passthrough()` into the document: it throws a `ZodError` in the operator's
 * browser, on create, at save time. Before #461 it was persisted silently.
 *
 * The EDIT arm is deliberately out of scope: it writes `tx.update(ref, patch)`,
 * which bypasses `toFirestore` entirely, so a stray key there is dropped by
 * `pickDirty` rather than rejected. Create is the surface that breaks.
 */
describe('produto page model vs. the produto document write', () => {
  /**
   * The keys `ObjectView` would actually send to the produto doc write: page
   * model minus what `transientFields` strips, minus what the schema models.
   * Takes both sets as arguments so the test can feed it a known-BAD input —
   * a checker only proves something when it fails on one.
   */
  const keysReachingTheProdutoWrite = (
    pageKeys: readonly string[],
    transientFields: readonly string[],
  ): string[] => {
    const modeled = new Set(Object.keys(produtoSchema.shape));
    const stripped = new Set(transientFields);
    return pageKeys.filter((key) => !modeled.has(key) && !stripped.has(key));
  };

  const pageKeys = Object.keys(produtoObjectViewSchema.shape);

  it('leaves no page-model key unmodeled and unstripped', () => {
    expect(keysReachingTheProdutoWrite(pageKeys, PRODUTO_TRANSIENT_FIELDS)).toEqual([]);
  });

  it('cannot pass vacuously — both source sets are populated and overlap', () => {
    // An empty `pageKeys` (a renamed export resolving to `{}`) or an empty
    // modeled set would make the assertion above trivially true.
    expect(pageKeys.length).toBeGreaterThan(0);
    expect(Object.keys(produtoSchema.shape).length).toBeGreaterThan(0);
    expect(PRODUTO_TRANSIENT_FIELDS.length).toBeGreaterThan(0);
    // The transient list must describe keys that are really on the page model —
    // a typo'd entry strips nothing and the real key reaches the write.
    for (const field of PRODUTO_TRANSIENT_FIELDS) {
      expect(pageKeys).toContain(field);
    }
  });

  it('flags a page-model field whose transientFields entry was forgotten', () => {
    // The known-BAD control: a checker that never fails proves nothing. The
    // input is synthetic rather than `[...pageKeys, 'abaNova']` so this stays
    // independent of the assertion above — it must keep isolating the checker
    // even on the day the real page model regresses. `nome` exercises the
    // modeled arm, `extraData` the transient arm, and `abaNova` is what adding
    // a tab-only field and forgetting `PRODUTO_TRANSIENT_FIELDS` looks like.
    expect(
      keysReachingTheProdutoWrite(['nome', 'extraData', 'abaNova'], PRODUTO_TRANSIENT_FIELDS),
    ).toEqual(['abaNova']);
  });
});
