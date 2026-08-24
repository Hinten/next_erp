import { describe, expect, it } from 'vitest';
import {
  PRODUTO_PERSISTENT_SECTIONS,
  PRODUTO_SECTIONS,
  PRODUTO_SECTIONS_BASE,
  PRODUTO_SECTIONS_EDITAR,
  SECTION_MERCADO_LIVRE,
  SECTION_MODIFICACOES,
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
