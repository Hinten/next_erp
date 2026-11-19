import {
  INTEGRACAO_TIPO,
  integracaoSchema,
  type RespostaBuscaAnunciosShopee,
} from '@delfrance/schemas';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ShopeeClientNetworkError } from '@/lib/shopee/client';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { shopeeClientFalso } from '@/lib/testing/shopeeClientFalso';

import { ImportarShopeeModal } from './ImportarShopeeModal';

const h = vi.hoisted(() => ({
  buscar: vi.fn(),
  importar: vi.fn(),
  push: vi.fn(),
  fechar: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: h.toast } }));
vi.mock('@/lib/shopee/client', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/shopee/client')>()),
  useShopeeClient: () =>
    shopeeClientFalso({ buscarAnuncios: h.buscar, importarAnuncio: h.importar }),
}));

const integracoes = [
  { id: 'a', data: integracaoSchema.parse({ nome: 'Loja A', tipo: INTEGRACAO_TIPO.shopee }) },
  { id: 'b', data: integracaoSchema.parse({ nome: 'Loja B', tipo: INTEGRACAO_TIPO.shopee }) },
  {
    id: 'm',
    data: integracaoSchema.parse({ nome: 'Mercado Livre', tipo: INTEGRACAO_TIPO.mercadoLivre }),
  },
  {
    id: 'i',
    data: integracaoSchema.parse({
      nome: 'Loja inativa',
      tipo: INTEGRACAO_TIPO.shopee,
      ativo: false,
    }),
  },
];

const VESTIDO = { itemId: 42, nome: 'Vestido floral', sku: 'V-1' };
const SAIA = { itemId: 43, nome: 'Saia floral', sku: null };

function abrir() {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <MantineTestProvider>
        <ImportarShopeeModal integracoes={integracoes} status="success" onClose={h.fechar} />
      </MantineTestProvider>
    </QueryClientProvider>,
  );
}

function abrirContas() {
  fireEvent.click(screen.getByRole('combobox', { name: 'Conta' }));
}

async function selecionarConta(nome: string) {
  abrirContas();
  fireEvent.click(await screen.findByRole('option', { name: nome }));
}

function buscar(campo: string, value: string) {
  fireEvent.change(screen.getByRole('textbox', { name: campo }), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
}

function botaoImportar() {
  return screen.getByRole<HTMLButtonElement>('button', { name: 'Importar anúncio' });
}

function respostaPendente<T>() {
  let resolve!: (valor: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe('Importar da Shopee', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    h.buscar.mockResolvedValue({ resultados: [VESTIDO], proximoCursor: null });
  });

  it('imports only the explicitly selected listing and navigates to the product editor', async () => {
    const resposta = respostaPendente<{ produtoId: string; criado: boolean; nome: string }>();
    h.importar.mockReturnValue(resposta.promise);
    abrir();
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'ID do anúncio' }).checked).toBe(
      true,
    );
    abrirContas();
    expect(screen.queryByRole('option', { name: 'Mercado Livre' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Loja inativa' })).toBeNull();
    fireEvent.click(await screen.findByRole('option', { name: 'Loja A' }));

    buscar('ID do anúncio', '42');
    const resultado = await screen.findByRole('radio', { name: /Vestido floral.*ID 42.*SKU V-1/ });
    expect(h.buscar).toHaveBeenCalledWith(
      expect.objectContaining({ integracaoId: 'a', modo: 'id', termo: '42' }),
    );
    expect(botaoImportar().disabled).toBe(true);
    expect(h.importar).not.toHaveBeenCalled();
    fireEvent.click(resultado);
    act(() => {
      fireEvent.click(botaoImportar());
      fireEvent.click(botaoImportar());
    });
    await waitFor(() => expect(botaoImportar().disabled).toBe(true));
    fireEvent.click(botaoImportar());
    expect(h.importar).toHaveBeenCalledExactlyOnceWith({
      integracaoId: 'a',
      itemId: 42,
      options: { sobrescreverPreco: false },
    });

    await act(async () => {
      resposta.resolve({ produtoId: 'produto-42', criado: false, nome: 'Vestido floral' });
    });
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Produto atualizado' }));
    expect(h.fechar).toHaveBeenCalledOnce();
    expect(h.push).toHaveBeenCalledExactlyOnceWith('/produtos/produto-42/editar');
  });

  it('clears the selected result when the mode changes and loads more results by cursor', async () => {
    h.buscar.mockResolvedValueOnce({ resultados: [VESTIDO], proximoCursor: null });
    h.buscar.mockResolvedValueOnce({ resultados: [VESTIDO], proximoCursor: 'opaque+=/?' });
    h.buscar.mockResolvedValueOnce({ resultados: [SAIA], proximoCursor: null });
    abrir();
    await selecionarConta('Loja A');
    fireEvent.click(screen.getByRole('radio', { name: 'SKU do anúncio' }));
    buscar('SKU do anúncio', 'V-1');
    fireEvent.click(await screen.findByRole('radio', { name: /Vestido floral/ }));
    expect(h.buscar).toHaveBeenCalledWith(expect.objectContaining({ modo: 'sku', termo: 'V-1' }));
    expect(botaoImportar().disabled).toBe(false);

    fireEvent.click(screen.getByRole('radio', { name: 'Nome' }));
    expect(botaoImportar().disabled).toBe(true);
    expect(screen.queryByRole('radio', { name: /Vestido floral/ })).toBeNull();
    buscar('Nome', 'floral');
    fireEvent.click(await screen.findByRole('button', { name: 'Carregar mais' }));
    expect(await screen.findByRole('radio', { name: /Saia floral/ })).toBeTruthy();
    expect(h.buscar).toHaveBeenLastCalledWith(
      expect.objectContaining({ modo: 'nome', termo: 'floral', cursor: 'opaque+=/?' }),
    );
    expect(screen.getByRole('radio', { name: /Vestido floral/ })).toBeTruthy();
    expect(botaoImportar().disabled).toBe(true);

    h.buscar.mockResolvedValueOnce({ resultados: [], proximoCursor: null });
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    expect((await screen.findByRole('status')).textContent).toContain('Nenhum anúncio encontrado');
    expect(h.buscar).toHaveBeenCalledTimes(4);
    expect(h.buscar).toHaveBeenLastCalledWith(
      expect.objectContaining({ termo: 'floral', cursor: undefined }),
    );
    expect(screen.queryByRole('radio', { name: /Saia floral/ })).toBeNull();
  });

  it('ignores a superseded search and keeps import disabled after a failed search on another account', async () => {
    const resposta = respostaPendente<RespostaBuscaAnunciosShopee>();
    h.buscar
      .mockReturnValueOnce(resposta.promise)
      .mockRejectedValueOnce(new ShopeeClientNetworkError('sem rede'));
    abrir();
    await selecionarConta('Loja A');
    buscar('ID do anúncio', '42');
    await waitFor(() => expect(h.buscar).toHaveBeenCalledOnce());

    await selecionarConta('Loja B');
    buscar('ID do anúncio', '43');
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Não foi possível contatar a integração com a Shopee',
    );
    await act(async () => {
      resposta.resolve({ resultados: [VESTIDO], proximoCursor: null });
    });
    expect(screen.queryByRole('radio', { name: /Vestido floral/ })).toBeNull();
    expect(botaoImportar().disabled).toBe(true);
    expect(h.importar).not.toHaveBeenCalled();
  });
});
