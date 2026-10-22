'use client';

import dynamic from 'next/dynamic';
import type { Firestore } from 'firebase/firestore';
import { Group, Loader } from '@mantine/core';

import { AbaDeCanal } from '../marketplace/AbaDeCanal';

export interface ShopeeTabProps {
  /** `null` in create mode — every Shopee link is keyed on a produto that exists. */
  produtoId: string | null;
  db: Firestore;
  disabled?: boolean;
}

/**
 * Activation gate for the produto editor's **Shopee** tab (step 21, #1529) —
 * the shared `AbaDeCanal` gate around this channel's editor, the sibling of
 * `MercadoLivreTab`. The editor chunk is not even requested until the tab is
 * opened for the first time.
 *
 * ## NOT a persistent section, on purpose
 *
 * Unlike Mercado Livre, this tab holds no drafts and registers no flush: it
 * READS the listing links (every write comes from apps/shopee), so the page
 * does not list it in `PRODUTO_PERSISTENT_SECTIONS`. While another tab shows,
 * `<Activity mode="hidden">` unmounts its effects and re-runs them on return.
 * Two rules in `ShopeeEditor` make that invisible to the operator: the spinner
 * gates on `data === undefined`, never on `loading` (a re-listen keeps the last
 * snapshot), and every piece of UI state lives at the editor's top level, which
 * React keeps across the hide.
 *
 * The latch still holds in a non-persistent section: `AbaDeCanal` reads
 * `useSectionActive()`, and the hidden panel's effects simply wait for the
 * section to show.
 */
const ShopeeEditor = dynamic(() => import('./ShopeeEditor').then((m) => m.ShopeeEditor), {
  ssr: false,
  loading: () => (
    <Group justify="center" py="md">
      <Loader size="sm" />
    </Group>
  ),
});

export function ShopeeTab({ produtoId, ...rest }: ShopeeTabProps) {
  return (
    <AbaDeCanal produtoId={produtoId} placeholderTestId="shopee-tab-placeholder">
      {(id) => <ShopeeEditor produtoId={id} {...rest} />}
    </AbaDeCanal>
  );
}
