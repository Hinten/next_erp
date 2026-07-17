import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import type { ConversaGroup } from '@/lib/chat/globalSearch';
import type { GlobalSearch } from '../../_hooks/useGlobalSearch';

// Render next/link as a plain anchor (no App Router context in the test).
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

// Resolve conversa names synchronously so the group headers render.
vi.mock('../../_hooks/useConversaNome', () => ({
  useConversaNome: (id: string) => `Conversa ${id}`,
}));

import { GlobalSearchResults } from './GlobalSearchResults';

const regex = /orçamento/iu;

const groups: ConversaGroup[] = [
  {
    conversaId: 'c1',
    newestTimestamp: 30,
    matches: [
      { conversaId: 'c1', mensagemId: 'm1', timestamp: 30, text: 'preciso do orçamento hoje' },
    ],
  },
  {
    conversaId: 'c2',
    newestTimestamp: 10,
    matches: [
      { conversaId: 'c2', mensagemId: 'm2', timestamp: 10, text: 'segue o orçamento gravado' },
    ],
  },
];

function makeSearch(over: Partial<GlobalSearch> = {}): GlobalSearch {
  return {
    active: true,
    isLiteral: false,
    groups,
    regex,
    checkedCount: 300,
    matchCount: 2,
    loading: false,
    loadingMore: false,
    error: undefined,
    exhausted: false,
    hasFetched: true,
    loadMore: vi.fn(),
    ...over,
  };
}

function renderResults(search: GlobalSearch) {
  return render(
    <MantineProvider>
      <GlobalSearchResults search={search} term="orçamento" />
    </MantineProvider>,
  );
}

describe('GlobalSearchResults', () => {
  it('renders a header per conversa group', () => {
    renderResults(makeSearch());
    expect(screen.getByText('Conversa c1')).toBeTruthy();
    expect(screen.getByText('Conversa c2')).toBeTruthy();
  });

  it('marks the matched substring in each snippet', () => {
    const { container } = renderResults(makeSearch());
    const marks = container.querySelectorAll('mark');
    // One <mark> per matched message (2 groups, 1 match each).
    expect(marks.length).toBe(2);
    expect([...marks].every((m) => m.textContent?.toLowerCase() === 'orçamento')).toBe(true);
  });

  it('shows the progress note with checked + match counts', () => {
    renderResults(makeSearch({ checkedCount: 150, matchCount: 4 }));
    expect(screen.getByText(/150 mensagens verificadas · 4 correspondências/)).toBeTruthy();
  });

  it('offers "Buscar mais antigas" until exhausted', () => {
    renderResults(makeSearch());
    expect(screen.getByRole('button', { name: 'Buscar mais antigas' })).toBeTruthy();
  });

  it('replaces the pager with an end note when exhausted', () => {
    renderResults(makeSearch({ exhausted: true }));
    expect(screen.queryByRole('button', { name: 'Buscar mais antigas' })).toBeNull();
    expect(screen.getByText('Fim das mensagens')).toBeTruthy();
  });

  it('shows an empty state when the search found nothing', () => {
    renderResults(makeSearch({ groups: [], matchCount: 0 }));
    expect(screen.getByText('Nenhuma mensagem encontrada.')).toBeTruthy();
  });
});
