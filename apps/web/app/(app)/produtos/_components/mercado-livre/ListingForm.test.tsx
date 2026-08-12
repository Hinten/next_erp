import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Firestore } from 'firebase/firestore';
import type { ProdutoMercadoLivreLink } from '@delfrance/schemas';

import { linkFixture } from '@/lib/mercado-livre/linkFixture';

const h = vi.hoisted(() => ({
  /** Every patch a save handed to the port, in order. */
  writes: [] as Array<Record<string, unknown>>,
  /** What the transaction re-read sees; swap per test to simulate a racer. */
  remote: null as ProdutoMercadoLivreLink | null,
}));

vi.mock('@/lib/mercado-livre/listingPort', () => ({
  createClientListingPort: () => ({
    now: () => 1_800_000_000_000,
    update: async (patchFor: (c: ProdutoMercadoLivreLink | null) => Record<string, unknown>) => {
      const patch = patchFor(h.remote);
      if (Object.keys(patch).length > 0) h.writes.push(patch);
    },
  }),
}));

const { ListingForm } = await import('./ListingForm');

function renderForm(
  over: Partial<ProdutoMercadoLivreLink> = {},
  props: Record<string, unknown> = {},
) {
  const onDirtyChange = vi.fn();
  const registerFlush = vi.fn();
  const link = linkFixture(over);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MantineProvider env="test">
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MantineProvider>
  );
  render(
    <ListingForm
      produtoId="prod-1"
      linkDocId="ML-DOC-1"
      integracaoId="conta-1"
      produtoNome="Camiseta Básica"
      link={link}
      db={{} as Firestore}
      canWrite
      onDirtyChange={onDirtyChange}
      registerFlush={registerFlush}
      {...props}
    />,
    { wrapper },
  );
  return { onDirtyChange, registerFlush, link };
}

function type(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  h.writes = [];
  h.remote = linkFixture();
});

describe('ListingForm', () => {
  it('seeds every input from the stored doc', () => {
    renderForm({ title: 'Camiseta Básica' });
    expect(screen.getByLabelText('Título do anúncio')).toHaveProperty('value', 'Camiseta Básica');
  });

  it('NEVER renders a labelled "Tipo de anúncio" control on a published listing', () => {
    // `produto-mercado-livre.vendas.e2e.spec.ts` proves the first-publish Select
    // is gone by asserting that label has count 0 on a published card. ML only
    // changes a listing type through its own upgrade endpoint anyway.
    renderForm({ id: 'MLB777' });
    expect(screen.queryByLabelText('Tipo de anúncio')).toBeNull();
    expect(screen.getByText('Clássico')).toBeDefined();
  });

  it('DOES offer the listing type on a draft that was never published', () => {
    // By role, not by label: a Mantine Select's label names BOTH the combobox
    // input and its listbox, so `getByLabelText` matches two elements. That is
    // also why the e2e assertion is `toHaveCount(0)` — counting to zero is
    // unambiguous, asserting on "the" labelled element is not.
    renderForm({ id: null, listing_type_id: null });
    expect(screen.getByRole('combobox', { name: 'Tipo de anúncio' })).toBeDefined();
  });

  it('disables the title once the listing has sales', () => {
    renderForm({ soldQuantity: 2 } as never);
    expect(screen.getByLabelText('Título do anúncio')).toHaveProperty('disabled', true);
  });

  it('leaves the title editable when the sold quantity is unknown', () => {
    renderForm();
    expect(screen.getByLabelText('Título do anúncio')).toHaveProperty('disabled', false);
  });

  it('keeps "Salvar anúncio" disabled until something is edited', () => {
    renderForm();
    expect(screen.getByRole('button', { name: 'Salvar anúncio' })).toHaveProperty('disabled', true);
  });

  it('reports dirtiness upward instead of guarding navigation itself', async () => {
    // ObjectView owns the only unsaved-changes guard; a second one would mean
    // two confirm() prompts and two sentinel history entries.
    const { onDirtyChange } = renderForm();
    type('Título do anúncio', 'Outro título');
    await waitFor(() => {
      expect(onDirtyChange).toHaveBeenCalledWith('ML-DOC-1', true);
    });
  });

  it('writes only the edited key', async () => {
    renderForm({ title: 'Camiseta Básica' });
    type('Título do anúncio', 'Camiseta Premium');
    fireEvent.click(screen.getByRole('button', { name: 'Salvar anúncio' }));

    await waitFor(() => {
      expect(h.writes).toHaveLength(1);
    });
    expect(h.writes[0]).toEqual({
      title: 'Camiseta Premium',
      ultimaModificacao: expect.any(Number),
    });
  });

  it('never writes a server-owned key', async () => {
    renderForm();
    type('Título do anúncio', 'Novo');
    fireEvent.click(screen.getByRole('button', { name: 'Salvar anúncio' }));

    await waitFor(() => {
      expect(h.writes).toHaveLength(1);
    });
    for (const key of ['estado', 'status', 'precoPublicado', 'comissao', 'isUserProductModel']) {
      expect(h.writes[0]).not.toHaveProperty(key);
    }
  });

  it('refuses to save a blank title', async () => {
    renderForm();
    type('Título do anúncio', '   ');
    fireEvent.click(screen.getByRole('button', { name: 'Salvar anúncio' }));

    await waitFor(() => {
      expect(screen.getByText('Informe o título do anúncio.')).toBeDefined();
    });
    expect(h.writes).toHaveLength(0);
  });

  it('raises the conflict for a human instead of overwriting silently', async () => {
    // Tier 3 of the lost-update ladder: the browser SDK has no lastUpdateTime
    // precondition, so an interactive edit that loses a race must be shown.
    const link = linkFixture({ title: 'Original' });
    h.remote = linkFixture({
      title: 'Alterado por outra pessoa',
      ultimaModificacao: (link.ultimaModificacao ?? 0) + 5_000,
    });
    renderForm({ title: 'Original' });
    type('Título do anúncio', 'Meu texto');
    fireEvent.click(screen.getByRole('button', { name: 'Salvar anúncio' }));

    await waitFor(() => {
      expect(screen.getByText('Anúncio alterado')).toBeDefined();
    });
    expect(screen.getByText('Alterado por outra pessoa')).toBeDefined();
    expect(h.writes).toHaveLength(0);
  });

  it('hands the editor a flush closure so the produto save commits ML edits too', () => {
    const { registerFlush } = renderForm();
    expect(registerFlush).toHaveBeenCalledWith('ML-DOC-1', expect.any(Function));
  });

  it('disables every input for an operator without write permission', () => {
    renderForm({}, { canWrite: false });
    expect(screen.getByLabelText('Título do anúncio')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Descrição')).toHaveProperty('disabled', true);
  });
});
