import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { MercadoLivreCategorias } from '@/lib/mercado-livre/client';

const h = vi.hoisted(() => ({
  categorias: vi.fn(),
  sugerirCategorias: vi.fn(),
}));

vi.mock('@/lib/mercado-livre/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mercado-livre/client')>();
  return {
    ...actual,
    useMercadoLivreClient: () => ({
      categorias: h.categorias,
      sugerirCategorias: h.sugerirCategorias,
    }),
  };
});

const { CategoriaField } = await import('./CategoriaField');

const CAMISETAS: MercadoLivreCategorias = {
  roots: null,
  node: {
    id: 'MLB31447',
    name: 'Camisetas',
    pathFromRoot: [
      { id: 'MLB1430', name: 'Roupas' },
      { id: 'MLB31447', name: 'Camisetas' },
    ],
    children: [],
    isLeaf: true,
    settings: null,
  },
};

const ROOTS: MercadoLivreCategorias = {
  roots: [{ id: 'MLB1430', name: 'Roupas' }],
  node: null,
};

const ROUPAS: MercadoLivreCategorias = {
  roots: null,
  node: {
    id: 'MLB1430',
    name: 'Roupas',
    pathFromRoot: [{ id: 'MLB1430', name: 'Roupas' }],
    children: [{ id: 'MLB31447', name: 'Camisetas' }],
    isLeaf: false,
    settings: null,
  },
};

function renderField(value: string | null, onChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MantineProvider env="test">
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MantineProvider>
  );
  render(
    <CategoriaField
      integracaoId="conta-1"
      value={value}
      onChange={onChange}
      produtoNome="Camiseta Básica"
    />,
    { wrapper },
  );
  return onChange;
}

beforeEach(() => {
  h.categorias.mockReset();
  h.sugerirCategorias.mockReset();
  h.categorias.mockResolvedValue(ROOTS);
  h.sugerirCategorias.mockResolvedValue({ sugestoes: [] });
});

describe('CategoriaField', () => {
  it('says the category is missing on a fresh draft', () => {
    renderField(null);
    expect(screen.getByText('Não definida')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Escolher categoria' })).toBeDefined();
  });

  it('resolves the id into a path a human can verify', async () => {
    // "MLB31447" tells an operator nothing; the path is the whole point of
    // spending a request here.
    h.categorias.mockResolvedValue(CAMISETAS);
    renderField('MLB31447');
    await waitFor(() => {
      expect(screen.getByText('Roupas › Camisetas')).toBeDefined();
    });
    expect(screen.getByText('MLB31447')).toBeDefined();
  });

  it('falls back to the raw id when the metadata call fails', async () => {
    // The ML backend is a separate deployable; a listing must stay readable
    // when it is unreachable.
    h.categorias.mockRejectedValue(new Error('offline'));
    renderField('MLB31447');
    await waitFor(() => {
      expect(screen.getByText('MLB31447')).toBeDefined();
    });
  });

  it('walks the cascade one level at a time', async () => {
    renderField(null);
    fireEvent.click(screen.getByRole('button', { name: 'Escolher categoria' }));
    await waitFor(() => {
      expect(screen.getByText('Roupas')).toBeDefined();
    });

    h.categorias.mockResolvedValue(ROUPAS);
    fireEvent.click(screen.getByText('Roupas'));
    await waitFor(() => {
      expect(screen.getByText('Camisetas')).toBeDefined();
    });
  });

  it('refuses a mid-tree category', async () => {
    // ML exposes attributes and listing types on leaves only.
    h.categorias.mockResolvedValue(ROUPAS);
    renderField(null);
    fireEvent.click(screen.getByRole('button', { name: 'Escolher categoria' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Usar esta categoria' })).toHaveProperty(
        'disabled',
        true,
      );
    });
  });

  it('accepts a leaf', async () => {
    h.categorias.mockResolvedValue(CAMISETAS);
    const onChange = renderField('MLB31447');
    fireEvent.click(screen.getByRole('button', { name: 'Alterar' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Usar esta categoria' })).toHaveProperty(
        'disabled',
        false,
      );
    });
    fireEvent.click(screen.getByRole('button', { name: 'Usar esta categoria' }));
    expect(onChange).toHaveBeenCalledWith('MLB31447');
  });

  it('OFFERS suggestions and never applies one by itself', async () => {
    // #799's acceptance criterion: publish used to apply
    // `suggestCategories(nome, 1)[0]` silently. Nothing here fetches or applies
    // a suggestion until the operator asks.
    const onChange = renderField(null);
    fireEvent.click(screen.getByRole('button', { name: 'Escolher categoria' }));
    await waitFor(() => {
      expect(screen.getByText('Roupas')).toBeDefined();
    });
    expect(h.sugerirCategorias).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();

    h.sugerirCategorias.mockResolvedValue({
      sugestoes: [
        {
          categoryId: 'MLB31447',
          categoryName: 'Camisetas',
          domainId: 'MLB-T_SHIRTS',
          domainName: 'Camisetas',
          pathFromRoot: [
            { id: 'MLB1430', name: 'Calçados, Roupas e Bolsas' },
            { id: 'MLB31447', name: 'Camisetas' },
          ],
        },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: /Sugerir categoria/ }));
    await waitFor(() => {
      expect(h.sugerirCategorias).toHaveBeenCalledOnce();
    });
    fireEvent.click(await screen.findByText('MLB31447'));
    expect(onChange).toHaveBeenCalledWith('MLB31447');
  });

  it('shows each suggestion with its full path, not just the leaf name', async () => {
    // ⚠️ ML files the same leaf name under several different parents, and
    // `domain_discovery/search` returns only that leaf — so a leaf-only label
    // rendered the SAME text on every row and the list read as one category
    // suggested five times, distinguishable only by an opaque MLB id.
    renderField(null);
    fireEvent.click(screen.getByRole('button', { name: 'Escolher categoria' }));
    await waitFor(() => {
      expect(screen.getByText('Roupas')).toBeDefined();
    });

    h.sugerirCategorias.mockResolvedValue({
      sugestoes: [
        {
          categoryId: 'MLB31447',
          categoryName: 'Camisetas e Regatas',
          domainId: 'MLB-T_SHIRTS',
          domainName: 'Camisetas',
          pathFromRoot: [
            { id: 'MLB1430', name: 'Calçados, Roupas e Bolsas' },
            { id: 'MLB108704', name: 'Roupas Masculinas' },
            { id: 'MLB31447', name: 'Camisetas e Regatas' },
          ],
        },
        {
          categoryId: 'MLB439327',
          categoryName: 'Camisetas e Regatas',
          domainId: 'MLB-T_SHIRTS',
          domainName: 'Camisetas',
          pathFromRoot: [
            { id: 'MLB1430', name: 'Calçados, Roupas e Bolsas' },
            { id: 'MLB108705', name: 'Roupas Femininas' },
            { id: 'MLB439327', name: 'Camisetas e Regatas' },
          ],
        },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: /Sugerir categoria/ }));

    // The two rows are now told apart by their trail, which is the point.
    await waitFor(() => {
      expect(screen.getByText(/Roupas Masculinas/)).toBeDefined();
    });
    expect(screen.getByText(/Roupas Femininas/)).toBeDefined();
  });

  it('still renders a suggestion whose path could not be resolved', async () => {
    // The route sends `pathFromRoot: null` rather than failing the whole list
    // over one unresolvable category read; the row must stay selectable.
    const onChange = renderField(null);
    fireEvent.click(screen.getByRole('button', { name: 'Escolher categoria' }));
    await waitFor(() => {
      expect(screen.getByText('Roupas')).toBeDefined();
    });

    h.sugerirCategorias.mockResolvedValue({
      sugestoes: [
        {
          categoryId: 'MLB31447',
          categoryName: 'Camisetas e Regatas',
          domainId: null,
          domainName: null,
          pathFromRoot: null,
        },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: /Sugerir categoria/ }));

    fireEvent.click(await screen.findByText('MLB31447'));
    expect(onChange).toHaveBeenCalledWith('MLB31447');
  });
});
