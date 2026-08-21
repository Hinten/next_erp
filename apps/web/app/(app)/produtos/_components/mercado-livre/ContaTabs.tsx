'use client';

import { useState, type ReactNode } from 'react';
import { Group, ScrollArea, Skeleton, Stack, Tabs, Text } from '@mantine/core';

/**
 * One Mercado Livre account's tab.
 *
 * `id` and `label` are separate on purpose: the tab's VALUE has to be the
 * integração doc id, which is unique and stable, while its LABEL is
 * `conta.nome`, which is neither — two accounts may share a name, and renaming
 * one must not look like switching tabs.
 */
export interface ContaTabItem {
  id: string;
  label: string;
  /** Right of the label — the listing count, or "Não publicado". */
  badge?: ReactNode;
  /** This account holds unsaved listing edits, and may be off screen. */
  dirty?: boolean;
}

export interface ContaTabsProps {
  items: readonly ContaTabItem[];
  /** Called ONLY for a tab that has been opened, and from then on always. */
  renderPanel: (contaId: string) => ReactNode;
  /** Which tab opens first; falls back to the first item. */
  defaultId?: string | null;
}

/**
 * Account tabs inside the produto editor's **Mercado Livre** tab.
 *
 * ## Lazy to open, then permanently mounted
 *
 * A panel renders nothing but a placeholder until its tab is first clicked, and
 * from that moment stays mounted for the life of the editor. That is the whole
 * contract, and both halves are load-bearing.
 *
 * **Lazy** because a `ListingForm` is expensive: it fetches this listing's
 * category metadata and its per-category attribute grid. Before these tabs every
 * account's form mounted at once, so a produto on four accounts paid four times
 * over on open. Now it pays for the accounts the operator actually visits.
 *
 * **Permanently mounted** because an opened account's listings own state that
 * only exists while their effects are alive:
 *
 *  - each `ListingForm` registers its save closure into the editor's
 *    `flushesRef`, and the produto's "Salvar alterações" enumerates that map at
 *    click time — an account whose effects were torn down is simply absent, so
 *    its edits are skipped in silence;
 *  - each one reports into `dirtyIds`, which the page turns into `extraDirty`
 *    and its leave-guard. Losing the entry disarms the guard while the edit is
 *    still on screen.
 *
 * ⚠️ **`keepMountedMode="display-none"` is what buys the second half.** Mantine
 * 9's default is `'activity'`, which wraps an inactive panel in React's
 * `<Activity mode="hidden">`: the subtree keeps its state but **every effect in
 * it unmounts**. Both cleanups above would fire on each tab switch, and — this
 * is the quiet part — the form's typed values would survive, so the screen would
 * look right while the save did half the job. `SectionTabs` documents the same
 * failure one level up; this is it one level down.
 *
 * ## Why not `SectionTabs`
 *
 * `@delfrance/ui`'s `SectionTabs` keys a tab by its section NAME, used as both
 * value and label — see above for why that does not work here. More
 * fundamentally, its reason to exist is making `<Activity>` suspension opt-in
 * per section; this component must never suspend and must mount lazily, which
 * is a third mode it does not have. Nothing here touches `<Activity>`, so unlike
 * `SectionTabs` its behaviour is identical under `MantineProvider env="test"`
 * and its tests need no bare-provider carve-out.
 */
export function ContaTabs({ items, renderPanel, defaultId }: ContaTabsProps) {
  const first = defaultId ?? items[0]?.id ?? null;
  const [active, setActive] = useState<string | null>(first);
  const [opened, setOpened] = useState<ReadonlySet<string>>(
    () => new Set(first != null ? [first] : []),
  );

  // Derived during render rather than repaired from an effect: an account
  // deleted while the tab is open would otherwise leave `value` pointing at a
  // panel that no longer exists, and Mantine would render no panel at all.
  const activeId = items.some((i) => i.id === active) ? active : (items[0]?.id ?? null);

  function handleChange(next: string | null): void {
    setActive(next);
    // ⚠️ The latch, and unlike `MercadoLivreTab`'s it needs no
    // `react-hooks/set-state-in-effect` disable: there the signal is a context
    // value from an ancestor, so only an effect can observe it. Here the click
    // IS the signal.
    if (next != null) {
      setOpened((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
    }
  }

  if (items.length === 0) return null;

  return (
    <Tabs
      // See the docblock. Mantine's default would unmount the effects of every
      // account not currently on screen.
      keepMountedMode="display-none"
      value={activeId}
      onChange={handleChange}
    >
      <ScrollArea type="auto" offsetScrollbars="x">
        <Tabs.List style={{ flexWrap: 'nowrap' }}>
          {items.map((item) => (
            <Tabs.Tab
              key={item.id}
              value={item.id}
              // `c` (text colour), not `color` — `color` only re-tints the
              // ACTIVE tab's indicator, which would leave an inactive account's
              // unsaved edits unmarked, the one case the mark exists for.
              c={item.dirty ? 'red' : undefined}
              data-dirty={item.dirty || undefined}
              rightSection={
                <Group gap={6} wrap="nowrap">
                  {item.badge}
                  {item.dirty && (
                    <Text component="span" size="xs" c="red" aria-label="alterações não salvas">
                      •
                    </Text>
                  )}
                </Group>
              }
            >
              {item.label}
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </ScrollArea>
      {items.map((item) => (
        <Tabs.Panel key={item.id} value={item.id} pt="md">
          {opened.has(item.id) ? renderPanel(item.id) : <ContaTabPlaceholder contaId={item.id} />}
        </Tabs.Panel>
      ))}
    </Tabs>
  );
}

/** What an unopened account's panel holds — never seen unless its tab is clicked. */
function ContaTabPlaceholder({ contaId }: { contaId: string }) {
  return (
    <Stack gap="xs" data-testid={`ml-conta-placeholder-${contaId}`}>
      <Skeleton height={28} width="40%" radius="sm" />
      <Skeleton height={96} radius="sm" />
    </Stack>
  );
}
