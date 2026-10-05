import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { getDraft, setDraft } from '@/lib/chat/draft';
import { ConversaAliasRedirect } from './ConversaContinuity';

const { api, navigation, search } = vi.hoisted(() => ({
  api: { conversaAlias: vi.fn() },
  navigation: { replace: vi.fn() },
  search: { value: 'msg=old-message&ts=55' },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => navigation,
  useSearchParams: () => new URLSearchParams(search.value),
}));
vi.mock('@/lib/whatsapp/client', () => ({ useWhatsappClient: () => api }));
let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  search.value = 'msg=old-message&ts=55';
  api.conversaAlias.mockResolvedValue({ conversaId: 'canonical', mensagemId: 'mapped-message' });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  window.localStorage.clear();
});
function show() {
  render(
    <QueryClientProvider client={client}>
      <MantineTestProvider>
        <ConversaAliasRedirect conversaId="old" />
      </MantineTestProvider>
    </QueryClientProvider>,
  );
}

describe('old WhatsApp conversation links', () => {
  it('maps a message deep link and moves a draft into an empty canonical conversation', async () => {
    setDraft('old', 'Texto ainda não enviado');
    show();
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith('/chat/canonical?msg=mapped-message&ts=55'),
    );
    expect(api.conversaAlias).toHaveBeenCalledWith('old', 'old-message');
    expect(getDraft('canonical')).toBe('Texto ainda não enviado');
    expect(getDraft('old')).toBe('');
  });
  it('retains both different drafts and exposes the previous one after redirecting', async () => {
    setDraft('old', 'Texto anterior');
    setDraft('canonical', 'Texto atual');
    show();
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith(
        '/chat/canonical?msg=mapped-message&ts=55&rascunhoOrigem=old',
      ),
    );
    expect(getDraft('old')).toBe('Texto anterior');
    expect(getDraft('canonical')).toBe('Texto atual');
  });
  it.each([null, 'old'])(
    'does not loop on an absent or unchanged alias (%s)',
    async (conversaId) => {
      api.conversaAlias.mockResolvedValue({ conversaId, mensagemId: null });
      show();
      await screen.findByText('Conversa não encontrada.');
      expect(navigation.replace).not.toHaveBeenCalled();
    },
  );
});
