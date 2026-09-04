'use client';

import { createContext, useContext } from 'react';

/**
 * Imperative access to the tab (`sections`) layout an `ObjectView` renders.
 *
 * `ObjectView` owns the active tab privately so an invalid submit can jump to
 * the first erroring one, and it already builds the `field key → section` map
 * that routes those errors. This context publishes both, so a custom
 * `renderInput` widget can move the operator to the tab holding a field it just
 * wrote — the `ModificacoesManager`'s "Restaurar", which stages a value into a
 * sibling tab and would otherwise be invisible.
 *
 * It sits next to the `FormProvider` deliberately: writing a sibling field
 * (`useFormContext().setValue`) and showing the operator where it landed are
 * two halves of the same gesture.
 */
export interface ObjectViewSections {
  /** The tab currently rendered, or `null` when the view has no `sections`. */
  activeSection: string | null;
  /**
   * Switch tabs, COMMITTED before it returns. A section the view does not
   * render is ignored.
   *
   * ⚠️ Order matters when you are also writing a field in that tab: go to the
   * section FIRST, then `setValue`. An inactive panel is hidden with
   * `<Activity mode="hidden">`, whose subtree has every effect unmounted — so a
   * `setValue` into it never reaches that field's `Controller`, and the input
   * re-renders from stale state when the panel comes back. This call returning
   * only once the switch has committed is what lets the write land on a mounted,
   * subscribed input.
   */
  goToSection: (section: string) => void;
  /**
   * The tab a TOP-LEVEL field key is rendered in, or `null` when the key has no
   * rendered input (excluded/hidden) or the view is untabbed. Sub-fields resolve
   * through their top-level key, matching how RHF nests errors.
   */
  sectionOfField: (fieldKey: string) => string | null;
}

const ObjectViewSectionsContext = createContext<ObjectViewSections | null>(null);

export const ObjectViewSectionsProvider = ObjectViewSectionsContext.Provider;

/**
 * `null` outside an `ObjectView` — a widget rendered standalone (or in its own
 * unit test) has no tabs to move between and must keep working. Optional-chain
 * it, the same way `useFormContext()` is guarded across this repo.
 */
export function useObjectViewSections(): ObjectViewSections | null {
  return useContext(ObjectViewSectionsContext);
}
