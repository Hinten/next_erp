'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Skeleton, Stack } from '@mantine/core';
import { useSectionActive } from '@delfrance/ui';

export interface AbaDeCanalProps {
  /** `null` in create mode — publishing needs a produto that exists. */
  produtoId: string | null;
  /** The unopened panel's testid — `ml-tab-placeholder`, `shopee-tab-placeholder`. */
  placeholderTestId: string;
  /** The channel's editor, built only once the tab has been opened on a saved produto. */
  children: (produtoId: string) => ReactNode;
}

/**
 * Activation gate for a produto editor's marketplace tab — the body that
 * `MercadoLivreTab` and `ShopeeTab` share. They differ only in the editor they
 * defer and in the placeholder's testid; each keeps its own `next/dynamic`
 * import, because `dynamic()` needs a literal path.
 *
 * A channel's editor fetches that channel's metadata to render any of it. None
 * of that should cost anything for the operator who only came to edit a price,
 * so the chunk is not even requested until the tab is opened for the first
 * time.
 *
 * ## Lazy to open, then permanent
 *
 * `useSectionActive()` is the signal: `false` while another tab is showing,
 * `true` once this one is, and `undefined` with no `SectionTabs` ancestor (a
 * standalone render, which is always visible). The latch is one-way — once
 * opened, the editor stays.
 *
 * ⚠️ The gate must NOT be re-derived from an effect firing. Under `<Activity>`
 * an effect fires only when the panel becomes visible, which is what
 * `MercadoLivreTab` used to rely on; in a section kept out of `<Activity>`
 * (`ObjectView`'s `persistentSections`, where Mercado Livre lives) effects run
 * from page load, and a bare `useEffect(..., [])` would open the tab nobody
 * clicked. The context value holds in both kinds of section.
 */
export function AbaDeCanal({ produtoId, placeholderTestId, children }: AbaDeCanalProps) {
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

  if (!opened) return <AbaDeCanalPlaceholder testId={placeholderTestId} />;
  return children(produtoId);
}

/** What the panel holds while unopened — never seen unless the tab is clicked. */
function AbaDeCanalPlaceholder({ testId }: { testId: string }) {
  return (
    <Stack gap="xs" data-testid={testId}>
      <Skeleton height={28} width="40%" radius="sm" />
      <Skeleton height={96} radius="sm" />
    </Stack>
  );
}
