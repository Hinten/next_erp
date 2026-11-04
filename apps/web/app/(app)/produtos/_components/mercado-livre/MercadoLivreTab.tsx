'use client';

import dynamic from 'next/dynamic';
import type { Firestore } from 'firebase/firestore';
import { Group, Loader } from '@mantine/core';

import { AbaDeCanal } from '../marketplace/AbaDeCanal';

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
 * Activation gate for the produto editor's **Mercado Livre** tab — the shared
 * `AbaDeCanal` gate around this channel's editor.
 *
 * The editor behind this boundary grows into the full listing form — a category
 * cascade, a per-category attribute grid, per-variation blocks — and it fetches
 * ML metadata to render any of it. None of that should cost anything for the
 * operator who only came to edit a price, so the chunk is not even requested
 * until the tab is opened for the first time.
 *
 * ## Lazy to open, then permanent
 *
 * `AbaDeCanal`'s one-way latch is only meaningful here because the produto page
 * opts this section into `ObjectView`'s `persistentSections`, which keeps the
 * panel out of Mantine's `<Activity mode="hidden">` wrapper. Without it, every
 * tab switch would unmount the subtree's EFFECTS and re-run them on return:
 * `useSnapshot` flips back to `loading: true`, `MercadoLivreEditor`
 * early-returns its spinner, and the whole `ListingForm` tree — thirty typed
 * attribute fields, the concurrency baseline, the AI staging — is discarded.
 * Worse and quieter: `flushRef.current` and the per-listing flush registrations
 * are torn down too, so a "Salvar alterações" clicked from another tab would
 * skip the Mercado Livre edits entirely and the leave-guard would report
 * nothing pending.
 *
 * ⚠️ The gate must therefore NOT be re-derived from an effect firing — see
 * `AbaDeCanal`, which reads `useSectionActive()` for exactly that reason.
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
  return (
    <AbaDeCanal produtoId={produtoId} placeholderTestId="ml-tab-placeholder">
      {(id) => <MercadoLivreEditor produtoId={id} {...rest} />}
    </AbaDeCanal>
  );
}
