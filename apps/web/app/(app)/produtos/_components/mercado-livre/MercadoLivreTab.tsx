'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import type { Firestore } from 'firebase/firestore';
import { Alert, Group, Loader, Skeleton, Stack } from '@mantine/core';
import { useSectionActive } from '@delfrance/ui';

export interface MercadoLivreTabProps {
  /** `null` in create mode — publishing needs a produto that exists. */
  produtoId: string | null;
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
 * operator who only came to edit a price, so the chunk is not even requested
 * until the tab is opened for the first time.
 *
 * ## Lazy to open, then permanent
 *
 * `useSectionActive()` is the signal: `false` while another tab is showing,
 * `true` once this one is, and `undefined` with no `SectionTabs` ancestor (a
 * standalone render, which is always visible). The latch is one-way — once
 * opened, the editor stays.
 *
 * That is only meaningful because the produto page opts this section into
 * `ObjectView`'s `persistentSections`, which keeps the panel out of Mantine's
 * `<Activity mode="hidden">` wrapper. Without it, every tab switch would unmount
 * the subtree's EFFECTS and re-run them on return: `useSnapshot` flips back to
 * `loading: true`, `MercadoLivreEditor` early-returns its spinner, and the whole
 * `ListingForm` tree — thirty typed attribute fields, the concurrency baseline,
 * the AI staging — is discarded. Worse and quieter: `flushRef.current` and the
 * per-listing flush registrations are torn down too, so a "Salvar alterações"
 * clicked from another tab would skip the Mercado Livre edits entirely and the
 * leave-guard would report nothing pending.
 *
 * ⚠️ The gate must therefore NOT be re-derived from an effect firing. Under
 * `<Activity>` an effect fires only when the panel becomes visible, which is
 * what this file used to rely on; without `<Activity>` effects run from page
 * load, and a bare `useEffect(..., [])` would open the tab nobody clicked.
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

export function MercadoLivreTab({ produtoId, ...rest }: MercadoLivreTabProps) {
  const active = useSectionActive();
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    // `react-hooks/set-state-in-effect` is right in general and wrong here: the
    // set IS the latch. `active` is a context value, so this runs on the render
    // where the operator opened the tab and never again — deferring the import
    // until then is the entire point of this component.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (active !== false) setOpened(true);
  }, [active]);

  // Create mode. Every listing action — publishing, the stock push, the link
  // subcollection the editor reads — is keyed on a produto that exists, so the
  // tab shows and explains itself rather than disappearing (the same convention
  // as Fotos/Vídeos/Anexos/Variações/Estoque on the create page).
  if (produtoId == null) {
    return (
      <Alert color="blue" variant="light">
        Salve o produto para continuar.
      </Alert>
    );
  }

  if (!opened) return <MercadoLivreTabPlaceholder />;
  return <MercadoLivreEditor produtoId={produtoId} {...rest} />;
}

/** What the panel holds while unopened — never seen unless the tab is clicked. */
function MercadoLivreTabPlaceholder() {
  return (
    <Stack gap="xs" data-testid="ml-tab-placeholder">
      <Skeleton height={28} width="40%" radius="sm" />
      <Skeleton height={96} radius="sm" />
    </Stack>
  );
}
