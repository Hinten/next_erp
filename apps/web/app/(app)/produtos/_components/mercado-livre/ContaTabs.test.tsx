import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';

import { ContaTabs, type ContaTabItem } from './ContaTabs';

const h = { rendered: vi.fn<(contaId: string) => void>() };

beforeEach(() => {
  h.rendered.mockClear();
});

/**
 * A panel body that reports when it is BUILT.
 *
 * ⚠️ Whether an already-opened panel stays MOUNTED — effects and all — is not
 * observable here: `MantineTestProvider` sets `env="test"`, under which Mantine
 * skips `<Activity>` whatever `keepMountedMode` says, so both modes look
 * identical. That invariant is pinned in `ContaTabs.persistence.test.tsx`, which
 * renders through a bare provider for exactly that reason.
 */
function Probe({ contaId }: { contaId: string }) {
  h.rendered(contaId);
  return <div data-testid={`painel-${contaId}`}>painel {contaId}</div>;
}

function renderTabs(items: readonly ContaTabItem[], defaultId?: string | null) {
  return render(
    <MantineTestProvider>
      <ContaTabs
        items={items}
        defaultId={defaultId}
        renderPanel={(contaId) => <Probe contaId={contaId} />}
      />
    </MantineTestProvider>,
  );
}

const TRES: ContaTabItem[] = [
  { id: 'conta-a', label: 'Loja A' },
  { id: 'conta-b', label: 'Loja B' },
  { id: 'conta-c', label: 'Loja C' },
];

describe('ContaTabs', () => {
  it('renders one tab per account, named by the account', () => {
    renderTabs(TRES);
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    for (const item of TRES) {
      expect(screen.getByRole('tab', { name: new RegExp(item.label) })).toBeTruthy();
    }
  });

  it('keys tabs by account id, so two accounts sharing a name stay distinct', () => {
    // The reason `id` and `label` are separate props. Keyed by name — which is
    // what `SectionTabs` does — both tabs would carry the same value and
    // clicking either would open one arbitrary panel.
    renderTabs([
      { id: 'conta-a', label: 'Loja' },
      { id: 'conta-b', label: 'Loja' },
    ]);

    expect(screen.getAllByRole('tab')).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('tab')[1]!);
    expect(screen.getByTestId('painel-conta-b')).toBeTruthy();
    expect(screen.getByTestId('painel-conta-a')).toBeTruthy();
  });

  it('never builds an account panel before its tab is opened', () => {
    // The point of the laziness: a ListingForm fetches this listing's category
    // metadata and its attribute grid, so an account nobody opened must cost
    // nothing at all.
    renderTabs(TRES);

    expect(h.rendered.mock.calls.map(([id]) => id)).toEqual(['conta-a']);
    expect(screen.getByTestId('ml-conta-placeholder-conta-b')).toBeTruthy();
    expect(screen.getByTestId('ml-conta-placeholder-conta-c')).toBeTruthy();
    expect(screen.queryByTestId('painel-conta-b')).toBeNull();
  });

  it('opens on the account named by defaultId', () => {
    renderTabs(TRES, 'conta-c');
    expect(h.rendered.mock.calls.map(([id]) => id)).toEqual(['conta-c']);
    expect(screen.getByRole('tab', { name: /Loja C/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('falls back to the first account when the active one disappears', () => {
    // An account deleted while the tab is open. Repaired during render rather
    // than from an effect, so Mantine never sees a `value` naming a panel that
    // no longer exists — which renders no panel at all.
    const { rerender } = renderTabs(TRES, 'conta-c');
    expect(screen.getByRole('tab', { name: /Loja C/ }).getAttribute('aria-selected')).toBe('true');

    rerender(
      <MantineTestProvider>
        <ContaTabs
          items={TRES.filter((i) => i.id !== 'conta-c')}
          defaultId="conta-c"
          renderPanel={(contaId) => <Probe contaId={contaId} />}
        />
      </MantineTestProvider>,
    );

    expect(screen.getByRole('tab', { name: /Loja A/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('marks an account holding unsaved edits, so an off-screen one is findable', () => {
    renderTabs([TRES[0]!, { ...TRES[1]!, dirty: true }]);

    const marcada = screen.getByRole('tab', { name: /Loja B/ });
    expect(marcada.getAttribute('data-dirty')).toBe('true');
    expect(screen.getByRole('tab', { name: /Loja A/ }).getAttribute('data-dirty')).toBeNull();
  });

  it('renders a badge beside the account name', () => {
    renderTabs([{ id: 'conta-a', label: 'Loja A', badge: <span>Não publicado</span> }]);
    expect(screen.getByRole('tab', { name: /Não publicado/ })).toBeTruthy();
  });

  it('renders nothing at all with no accounts', () => {
    const { container } = renderTabs([]);
    expect(container.querySelector('[role="tab"]')).toBeNull();
  });
});
