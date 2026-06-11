'use client';

import type { ReactNode } from 'react';
import { Tabs } from '@mantine/core';
import { IconExclamationCircle } from '@tabler/icons-react';

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
}

/**
 * Tabbed grouping for ObjectView sections. Section names come from the
 * caller's `sections` prop (caller controls ordering); per-field section
 * assignment lives on `FieldConfig.section`.
 */
export function SectionTabs({
  sections,
  contents,
  defaultSection,
  value,
  onChange,
  errorSections,
}: SectionTabsProps) {
  if (sections.length === 0) return null;
  return (
    <Tabs
      // Mantine warns when both `value` and `defaultValue` are passed —
      // spread exactly one depending on controlled vs uncontrolled mode.
      {...(value !== undefined
        ? { value, onChange }
        : { defaultValue: defaultSection ?? sections[0] })}
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
      {sections.map((s) => (
        <Tabs.Panel key={s} value={s} pt="md">
          {contents[s]}
        </Tabs.Panel>
      ))}
    </Tabs>
  );
}
