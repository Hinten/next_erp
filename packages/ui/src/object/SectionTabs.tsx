'use client';

import type { ReactNode } from 'react';
import { Tabs } from '@mantine/core';

export interface SectionTabsProps {
  sections: string[];
  /** Map from section name → React content. */
  contents: Record<string, ReactNode>;
  /** Default active section; falls back to the first entry. */
  defaultSection?: string;
}

/**
 * Tabbed grouping for ObjectView sections. Section names come from the
 * caller's `sections` prop (caller controls ordering); per-field section
 * assignment lives on `FieldConfig.section`.
 */
export function SectionTabs({ sections, contents, defaultSection }: SectionTabsProps) {
  if (sections.length === 0) return null;
  return (
    <Tabs defaultValue={defaultSection ?? sections[0]}>
      <Tabs.List>
        {sections.map((s) => (
          <Tabs.Tab key={s} value={s}>
            {s}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {sections.map((s) => (
        <Tabs.Panel key={s} value={s} pt="md">
          {contents[s]}
        </Tabs.Panel>
      ))}
    </Tabs>
  );
}
