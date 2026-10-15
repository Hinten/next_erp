import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { produtoSchema } from '@delfrance/schemas';
import { REVERTIBLE_PRODUTO_FIELDS } from '@/lib/produtos/revert';
import {
  PRODUTO_EXCLUDED_FIELDS,
  PRODUTO_PERSISTENT_SECTIONS,
  PRODUTO_SECTIONS,
  PRODUTO_SECTIONS_BASE,
  PRODUTO_SECTIONS_EDITAR,
  PRODUTO_TRANSIENT_FIELDS,
  SECTION_KIT,
  SECTION_MERCADO_LIVRE,
  SECTION_MODIFICACOES,
  SECTION_VARIACOES,
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

  it('persists every tab that registers a flush the edit page calls (#1374)', () => {
    // A non-persistent tab loses its effects to `<Activity mode="hidden">`, and
    // the flush registration goes with them: the Kit tab's ref was nulled and
    // `flushKitVariacoesRef.current?.(id)` silently skipped the writes, while
    // Variações kept a closure over an already-unsubscribed snapshot.
    expect([...PRODUTO_PERSISTENT_SECTIONS].sort()).toEqual(
      [SECTION_MERCADO_LIVRE, SECTION_KIT, SECTION_VARIACOES].sort(),
    );
  });

  it('has no flush registration beyond those three sections (#1374)', () => {
    // A tripwire, not a proof: it cannot tell WHICH section renders a given
    // `flushRef`, only that a fourth registration appeared. That is the moment
    // to decide whether its tab must be persistent too — the failure mode is
    // silent, so it has to fail here instead.
    // `path.join`, not `new URL` — the route segments `(app)` and `[id]` do not
    // survive URL resolution intact.
    const here = dirname(fileURLToPath(import.meta.url));
    const page = readFileSync(join(here, '..', '[id]', 'editar', 'page.tsx'), 'utf8');
    expect(page.match(/flushRef=\{/g) ?? []).toHaveLength(3);
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

/**
 * A revert is STAGED into the produto form (#660), not written directly — so
 * every field the Modificações tab offers "Restaurar" for must have an input the
 * operator can actually look at before saving.
 *
 * `ordem` broke this: it was whitelisted for revert AND excluded from the form,
 * so staging one told the operator a value was waiting to be reviewed with
 * nothing on screen to review and no tab to jump to. The write still landed on
 * save, which is what kept it invisible.
 *
 * The two lists live in different files and neither one knows about the other,
 * so this is the only thing that would notice a field leaving the form while
 * staying revertible.
 */
describe('every revertible produto field is rendered on the form', () => {
  it('has no field that is both revertible and excluded from the form', () => {
    const excluded = new Set(PRODUTO_EXCLUDED_FIELDS);
    const invisiveis = [...REVERTIBLE_PRODUTO_FIELDS].filter((f) => excluded.has(f));
    expect(
      invisiveis,
      [
        'These fields can be restored from the Modificações tab but have no input',
        'on the produto form, so a staged revert of one is announced and then',
        'invisible. Either drop it from REVERTIBLE_PRODUTO_FIELDS (apps/web/lib/',
        'produtos/revert.ts) or give it a rendered input:',
        ...invisiveis.map((f) => `  - ${f}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('cannot pass vacuously — both sets are populated', () => {
    // Two empty sets are trivially disjoint; a renamed export would do that.
    expect(REVERTIBLE_PRODUTO_FIELDS.size).toBeGreaterThan(0);
    expect(PRODUTO_EXCLUDED_FIELDS.length).toBeGreaterThan(0);
    // And the check must be able to FAIL: a field that IS excluded reads as
    // excluded, so the intersection above is a real question.
    expect(new Set(PRODUTO_EXCLUDED_FIELDS).has('ordem')).toBe(true);
  });
});
