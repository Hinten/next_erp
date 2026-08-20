'use client';

import { Activity, createContext, useContext, useState, type ReactNode } from 'react';
import { Tabs, useMantineEnv } from '@mantine/core';
import { IconExclamationCircle } from '@tabler/icons-react';

/**
 * Whether the section this subtree sits in is the ACTIVE tab.
 *
 * `undefined` means "no `SectionTabs` ancestor" — a component rendered
 * standalone (or in its own unit test) is always visible, and must not be left
 * waiting for a tab that will never activate.
 */
const SectionActiveContext = createContext<boolean | undefined>(undefined);

/** @see SectionActiveContext */
export function useSectionActive(): boolean | undefined {
  return useContext(SectionActiveContext);
}

export interface SectionTabsProps {
  sections: string[];
  /** Map from section name → React content. */
  contents: Record<string, ReactNode>;
  /** Default active section; falls back to the first entry. */
  defaultSection?: string;
  /**
   * Controlled active section. When set (non-`undefined`), the component is
   * controlled and `onChange` must update it; omit for uncontrolled mode.
   */
  value?: string | null;
  onChange?: (value: string | null) => void;
  /**
   * Sections containing invalid fields — their tabs render in red with an
   * error icon so a validation failure on a non-active tab stays visible.
   */
  errorSections?: ReadonlySet<string>;
  /**
   * Sections whose content must stay FULLY mounted — effects included — while
   * another tab is active. See the `<Activity>` note on the component below;
   * opt in only where it is needed, because it is not free.
   */
  persistentSections?: readonly string[];
}

/**
 * Tabbed grouping for ObjectView sections. Section names come from the
 * caller's `sections` prop (caller controls ordering); per-field section
 * assignment lives on `FieldConfig.section`.
 *
 * ## Why this re-implements Mantine's `keepMountedMode`
 *
 * Mantine's default is `keepMounted: true` + `keepMountedMode: 'activity'`, so
 * `TabsPanel` wraps an inactive panel in React's `<Activity mode="hidden">`.
 * That **renders the subtree but unmounts every effect in it**, and re-mounts
 * them when the panel becomes visible again. It is the right default: a tab
 * nobody opened costs no Firestore listener and no fetch.
 *
 * It is the wrong behaviour for a tab holding unsaved work. On the re-mount,
 * every subscription re-runs from scratch — `useSnapshot` flips back to
 * `loading: true`, an in-flight fetch restarts, a registered flush closure is
 * torn down — and a panel that early-returns a spinner while loading unmounts
 * its own form subtree, discarding whatever the operator had typed.
 *
 * `keepMountedMode` is a **tabs-level** prop read from context
 * (`TabsPanel.mjs:18`); there is no per-panel knob. So we set it to
 * `'display-none'` and do the `<Activity>` wrapping here, per section, which
 * makes the choice opt-in through `persistentSections`. Mantine still applies
 * `display: none` to every inactive panel `Box` regardless of mode
 * (`TabsPanel.mjs:28`), so nothing about the layout changes.
 *
 * ⚠️ The `env === 'test'` branch mirrors `TabsPanel.mjs:19`: under
 * `MantineProvider env="test"` Mantine skips `Activity` entirely, and so must
 * we, or every existing component test would silently lose the effects of its
 * hidden panels.
 */
export function SectionTabs({
  sections,
  contents,
  defaultSection,
  value,
  onChange,
  errorSections,
  persistentSections,
}: SectionTabsProps) {
  const env = useMantineEnv();
  // Mirror of the active section so the per-panel wrapper below also works in
  // uncontrolled mode — where Mantine, not this component, owns the value.
  const [uncontrolled, setUncontrolled] = useState<string | null>(
    () => defaultSection ?? sections[0] ?? null,
  );
  if (sections.length === 0) return null;
  const activeSection = value !== undefined ? value : uncontrolled;
  return (
    <Tabs
      // See the docblock: the panels are wrapped here, not by Mantine.
      keepMountedMode="display-none"
      // Mantine warns when both `value` and `defaultValue` are passed —
      // spread exactly one depending on controlled vs uncontrolled mode.
      {...(value !== undefined
        ? { value, onChange }
        : {
            defaultValue: defaultSection ?? sections[0],
            onChange: (next: string | null) => {
              setUncontrolled(next);
              onChange?.(next);
            },
          })}
    >
      <Tabs.List>
        {sections.map((s) => {
          const hasError = errorSections?.has(s) ?? false;
          return (
            <Tabs.Tab
              key={s}
              value={s}
              // `c` (text color), not `color` — `color` only re-tints the
              // active-tab indicator, leaving inactive erroring tabs unmarked.
              c={hasError ? 'red' : undefined}
              data-error={hasError || undefined}
              rightSection={
                hasError ? (
                  <IconExclamationCircle
                    size={14}
                    role="img"
                    aria-label="contém campos inválidos"
                  />
                ) : undefined
              }
            >
              {s}
            </Tabs.Tab>
          );
        })}
      </Tabs.List>
      {sections.map((s) => {
        const active = activeSection === s;
        const persistent = persistentSections?.includes(s) ?? false;
        return (
          <Tabs.Panel key={s} value={s} pt="md">
            <SectionActiveContext.Provider value={active}>
              {persistent || env === 'test' ? (
                contents[s]
              ) : (
                <Activity mode={active ? 'visible' : 'hidden'}>{contents[s]}</Activity>
              )}
            </SectionActiveContext.Provider>
          </Tabs.Panel>
        );
      })}
    </Tabs>
  );
}
