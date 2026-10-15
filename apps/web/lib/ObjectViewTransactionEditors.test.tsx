import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import type { ImpostoProduto, ImpostoCategoria, ProdutoExtraData } from '@delfrance/schemas';
import {
  createTransactionDocuments,
  ObjectViewTransactionDocumentsProvider,
} from '@delfrance/ui/src/object/ObjectViewTransactionDocuments';

const h = vi.hoisted(() => ({
  operations: {
    current: {
      data: [{ id: 'venda', data: { nome: 'Venda', padrao: true, ativo: true } }],
      loading: false,
      fromCache: false,
      hasPendingWrites: false,
    },
  },
  taxes: {
    current: {
      data: [] as { id: string; data: Record<string, unknown> }[],
      loading: false,
      fromCache: false,
      hasPendingWrites: false,
    },
  },
  target: {
    current: {
      data: null as { id: string; data: Record<string, unknown> } | null,
      loading: false,
      fromCache: true,
      hasPendingWrites: false,
    },
  },
}));
vi.mock('@delfrance/data', async (original) => ({
  ...(await original<typeof import('@delfrance/data')>()),
  buildQuery: (base: unknown) => base,
  orderByField: () => null,
  limit: () => null,
}));
vi.mock('@delfrance/data/hooks', async (original) => ({
  ...(await original<typeof import('@delfrance/data/hooks')>()),
  useSnapshot: (ref: { kind?: string } | null) =>
    ref?.kind === 'operations' ? h.operations.current : h.taxes.current,
  useDocSnapshot: (ref: { path: string } | null) =>
    ref ? { ...h.target.current, documentPath: ref.path } : { data: undefined, loading: false },
}));
vi.mock('@/lib/data/operacaoCollection', () => ({
  operacaoCollection: { ref: () => ({ kind: 'operations' }) },
}));
vi.mock('@/lib/data/impostoProdutoCollection', () => ({
  impostoProdutoCollection: {
    ref: () => ({ kind: 'taxes' }),
    docRef: (_db: unknown, ctx: { produtoId: string }, id: string) => ({
      path: 'produtos/' + ctx.produtoId + '/imposto/' + id,
      id,
    }),
  },
}));
vi.mock('@/lib/data/impostoCategoriaCollection', () => ({
  impostoCategoriaCollection: {
    ref: () => ({ kind: 'taxes' }),
    docRef: (_db: unknown, ctx: { categoriaId: string }, id: string) => ({
      path: 'categorias/' + ctx.categoriaId + '/imposto/' + id,
      id,
    }),
  },
}));
vi.mock('@/lib/data/produtoExtraDataCollection', () => ({
  produtoExtraDataCollection: {
    docRef: () => ({ path: 'produtos/p1/extraData/singleton', id: 'singleton' }),
  },
}));
vi.mock('@/components/imposto', () => ({
  OperacoesComProblemas: () => null,
  ImpostoConfigEditor: ({
    value,
    onChange,
    disabled,
  }: {
    value: { cfop?: string | null };
    onChange: (next: unknown) => void;
    disabled?: boolean;
  }) => (
    <label>
      CFOP
      <input
        disabled={disabled}
        value={value.cfop ?? ''}
        onChange={(e) => onChange({ cfop: e.target.value })}
      />
    </label>
  ),
}));
import { ImpostoManager } from '@/app/(app)/produtos/_components/ImpostoManager';
import { CategoriaImpostoManager } from '@/app/(app)/categorias/_components/CategoriaImpostoManager';
import { ExtraDataManager } from '@/app/(app)/produtos/_components/ExtraDataManager';

beforeEach(() => {
  h.operations.current.fromCache = false;
  h.taxes.current = { data: [], loading: false, fromCache: false, hasPendingWrites: false };
  h.target.current = { data: null, loading: false, fromCache: true, hasPendingWrites: false };
});

for (const kind of ['product', 'category'] as const) {
  describe(kind + ' tax baseline seeding', () => {
    function Host() {
      const [product, setProduct] = useState<ImpostoProduto[] | null>(null);
      const [category, setCategory] = useState<ImpostoCategoria[] | null>(null);
      return kind === 'product' ? (
        <ImpostoManager produtoId="p1" db={{} as never} value={product} onChange={setProduct} />
      ) : (
        <CategoriaImpostoManager
          categoriaId="c1"
          db={{} as never}
          value={category}
          onChange={setCategory}
        />
      );
    }
    const path = kind === 'product' ? 'produtos/p1/imposto/venda' : 'categorias/c1/imposto/venda';
    function tree(documents: ReturnType<typeof createTransactionDocuments>) {
      return (
        <MantineTestProvider>
          <ObjectViewTransactionDocumentsProvider value={documents}>
            <Host />
          </ObjectViewTransactionDocumentsProvider>
        </MantineTestProvider>
      );
    }
    it('keeps an omitted row disabled until a direct server snapshot confirms absence', async () => {
      const documents = createTransactionDocuments();
      const view = render(tree(documents));
      expect((screen.getByLabelText('CFOP') as HTMLInputElement).disabled).toBe(true);
      expect(documents.getBaseline(path)).toBeUndefined();
      h.target.current.fromCache = false;
      await act(async () => {
        view.rerender(tree(documents));
      });
      expect(documents.getBaseline(path)).toBeNull();
      expect((screen.getByLabelText('CFOP') as HTMLInputElement).disabled).toBe(false);
      fireEvent.change(screen.getByLabelText('CFOP'), { target: { value: '5102' } });
      h.target.current.data = { id: 'venda', data: { cfop: '6102' } };
      await act(async () => {
        view.rerender(tree(documents));
      });
      expect((screen.getByLabelText('CFOP') as HTMLInputElement).value).toBe('5102');
      expect(documents.getBaseline(path)).toBeNull();
    });
    it('loads a real document omitted from the bounded query before enabling edits', async () => {
      const documents = createTransactionDocuments();
      const view = render(tree(documents));
      h.target.current = {
        data: { id: 'venda', data: { cfop: '6102' } },
        loading: false,
        fromCache: false,
        hasPendingWrites: false,
      };
      await act(async () => {
        view.rerender(tree(documents));
      });
      expect((screen.getByLabelText('CFOP') as HTMLInputElement).value).toBe('6102');
      expect(documents.getBaseline(path)).toEqual({ cfop: '6102' });
    });
  });
}

describe('extraData baseline seeding', () => {
  function Host() {
    const [value, setValue] = useState<ProdutoExtraData | null>(null);
    return <ExtraDataManager produtoId="p1" db={{} as never} value={value} onChange={setValue} />;
  }
  const path = 'produtos/p1/extraData/singleton';
  function tree(documents: ReturnType<typeof createTransactionDocuments>) {
    return (
      <MantineTestProvider>
        <ObjectViewTransactionDocumentsProvider value={documents}>
          <Host />
        </ObjectViewTransactionDocumentsProvider>
      </MantineTestProvider>
    );
  }
  it('does not seed from cache or pending writes, then freezes the displayed server version', async () => {
    const documents = createTransactionDocuments();
    h.target.current.data = { id: 'singleton', data: { descricao: 'Cached' } };
    const view = render(tree(documents));
    expect((screen.getByLabelText('Descrição') as HTMLTextAreaElement).disabled).toBe(true);
    expect(documents.getBaseline(path)).toBeUndefined();
    h.target.current = {
      data: { id: 'singleton', data: { descricao: 'Server' } },
      loading: false,
      fromCache: false,
      hasPendingWrites: true,
    };
    await act(async () => {
      view.rerender(tree(documents));
    });
    expect(documents.getBaseline(path)).toBeUndefined();
    h.target.current.hasPendingWrites = false;
    await act(async () => {
      view.rerender(tree(documents));
    });
    expect((screen.getByLabelText('Descrição') as HTMLTextAreaElement).value).toBe('Server');
    fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: 'Local' } });
    h.target.current.data = { id: 'singleton', data: { descricao: 'Remote' } };
    await act(async () => {
      view.rerender(tree(documents));
    });
    expect((screen.getByLabelText('Descrição') as HTMLTextAreaElement).value).toBe('Local');
    expect(documents.getBaseline(path)).toEqual({ descricao: 'Server' });
  });
});
