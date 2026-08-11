'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import type { Firestore } from 'firebase/firestore';
import { Group, Loader, Skeleton, Stack } from '@mantine/core';

export interface MercadoLivreTabProps {
  produtoId: string;
  db: Firestore;
  disabled?: boolean;
  /** True while any listing holds unsaved edits — feeds ObjectView's `extraDirty`. */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * Receives the closure that commits pending listing edits. Stays `null` until
   * the tab is opened, which is exactly the "never visited ⇒ nothing to flush"
   * case the page's optional call relies on.
   */
  flushRef?: React.MutableRefObject<(() => Promise<void>) | null>;
}

/**
 * Activation gate for the produto editor's **Mercado Livre** tab.
 *
 * The editor behind this boundary grows into the full listing form — a category
 * cascade, a per-category attribute grid, per-variation blocks — and it fetches
 * ML metadata to render any of it. None of that should cost anything for the
 * operator who only came to edit a price.
 *
 * ## Why an effect and not `next/dynamic` alone
 *
 * `SectionTabs` renders `<Tabs.Panel>` without `keepMounted`, so Mantine's
 * defaults apply: `keepMounted: true` + `keepMountedMode: 'activity'`
 * (verified in `@mantine/core@9.2.0`). `TabsPanel` therefore wraps an inactive
 * panel in React's `<Activity mode="hidden">`, which **renders the subtree but
 * never mounts its effects**.
 *
 * That is the whole mechanism, and it cuts both ways:
 *
 *  - a bare `next/dynamic` boundary would still be *rendered* while hidden, so
 *    the chunk download would start on page load — exactly what we are avoiding;
 *  - an effect, by contrast, fires only when the panel becomes visible. So this
 *    `useEffect` **is** the "tab opened for the first time" signal, and gating
 *    the dynamic import on it means the chunk is not even requested until then.
 *
 * ## Why not `keepMounted={false}`
 *
 * Because DOM and state surviving a tab switch is a feature here. An operator
 * who fills thirty attribute fields, flips to Fotos to check an image and flips
 * back must find their work intact; unmounting would discard the whole form.
 *
 * ⚠️ Under `MantineProvider env="test"` Mantine disables `Activity` entirely
 * (`TabsPanel.mjs:19`), so component tests mount immediately — assert the
 * placeholder→editor transition, never "not loaded yet".
 */
const MercadoLivreEditor = dynamic(
  () => import('./MercadoLivreEditor').then((m) => m.MercadoLivreEditor),
  {
    ssr: false,
    loading: () => (
      <Group justify="center" py="md">
        <Loader size="sm" />
      </Group>
    ),
  },
);

export function MercadoLivreTab(props: MercadoLivreTabProps) {
  const [activated, setActivated] = useState(false);
  useEffect(() => {
    // `react-hooks/set-state-in-effect` is right in general and wrong here: the
    // set IS the signal. React deliberately withholds effects from a hidden
    // <Activity> subtree, so this line firing is the only notification we get
    // that the panel became visible — and deferring the import is the entire
    // point of this component. Rewriting it to "avoid setState in an effect"
    // means rendering the editor eagerly, which restores the cost this file
    // exists to remove. Runs exactly once (empty deps).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActivated(true);
  }, []);

  if (!activated) return <MercadoLivreTabPlaceholder />;
  return <MercadoLivreEditor {...props} />;
}

/** What the panel holds while hidden — never seen unless the tab is opened. */
function MercadoLivreTabPlaceholder() {
  return (
    <Stack gap="xs" data-testid="ml-tab-placeholder">
      <Skeleton height={28} width="40%" radius="sm" />
      <Skeleton height={96} radius="sm" />
    </Stack>
  );
}
