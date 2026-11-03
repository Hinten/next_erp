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
  /**
   * True while a listing DRAFT of this tab holds unsaved work — feeds the
   * page's `extraDirty` (its leave-guard) and the post-save block in
   * `onAfterSave`. Mercado Livre's own prop name. Reported with NO reset on
   * hide: see `ShopeeEditor`.
   */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * The page holds unsaved produto edits OUTSIDE the produto form that a
   * draft's «Publicar» would not see (staged variation prices / children —
   * #1911 P11 review, KNOWN #9): handed to the editor, which ORs it into the
   * Publicar gate's `produtoSujo` beside the form's `isDirty`. The editor's
   * `ShopeeEditorProps.produtoSujoForaDoFormulario`.
   */
  produtoSujoForaDoFormulario?: boolean;
}

/**
 * Activation gate for the produto editor's **Shopee** tab (step 21, #1529) —
 * the shared `AbaDeCanal` gate around this channel's editor, the sibling of
 * `MercadoLivreTab`. The editor chunk is not even requested until the tab is
 * opened for the first time.
 *
 * ## NOT a persistent section, on purpose — drafts and all
 *
 * The tab edits listing DRAFTS (#1911 P10), but it registers no flush and
 * stages nothing in the produto form: a draft is written by apps/shopee's draft
 * route when the operator clicks «Salvar rascunho» on its block, never by the
 * produto's "Salvar alterações" (a draft save can answer 409, which is the
 * draft's own UI — D7). So the page does not list it in
 * `PRODUTO_PERSISTENT_SECTIONS`, and while another tab shows,
 * `<Activity mode="hidden">` unmounts its effects and re-runs them on return.
 * Three rules in `ShopeeEditor` make that invisible to the operator:
 *
 *  - the spinner gates on `data === undefined`, never on `loading` (a re-listen
 *    keeps the last snapshot);
 *  - every piece of UI state — the drafts being edited included — lives at the
 *    editor's top level, which React keeps across the hide;
 *  - the unsaved-draft flag (`onDirtyChange`) is reported with NO effect
 *    cleanup: a cleanup reporting `false` would disarm the page's leave-guard
 *    on every tab switch while the typed draft is still there.
 *
 * The editor is keyed by the produto id, so a produto change remounts it and
 * no draft of one produto survives into another's tab.
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
      {(id) => <ShopeeEditor key={id} produtoId={id} {...rest} />}
    </AbaDeCanal>
  );
}
