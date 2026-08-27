import type { Firestore } from 'firebase/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { MantineTestProvider } from '@/lib/testing/mantine';

/**
 * What this pins is the WIRE KEY, and that is the whole point.
 *
 * The import route's `sanitizeOptions` accepts an allow-list and silently drops
 * every other key, so a misspelling here is not a crash and not a type error —
 * it is a checkbox that appears to work, reports success, and changes nothing.
 * Rendering the real modal and reading the body the client was called with is
 * the only place that spelling is checked end to end.
 */
const h = vi.hoisted(() => ({
  importar: vi.fn(),
  notify: vi.fn(),
  push: vi.fn(),
}));

vi.mock('@/lib/mercado-livre/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/mercado-livre/client')>();
  return { ...actual, useMercadoLivreClient: () => ({ importar: h.importar }) };
});
vi.mock('@mantine/notifications', () => ({ notifications: { show: h.notify } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock('@/lib/auth', () => ({ usePermission: () => ({ allowed: true }) }));
vi.mock('@delfrance/data/hooks', () => ({
  useSnapshot: () => ({
    data: [{ id: 'int-1', data: { nome: 'Loja A' } }],
    loading: false,
    error: null,
  }),
}));
// The account list is stubbed at the hook above, so the query it would have
// built is never executed — these two only keep the real Firestore builders from
// rejecting the empty `db` stand-in during render.
vi.mock('@/lib/data/integracaoCollection', () => ({ integracaoCollection: { ref: () => ({}) } }));
vi.mock('@delfrance/data', () => ({
  buildQuery: () => ({}),
  limit: () => ({}),
  whereEqual: () => ({}),
}));

const { ImportarMercadoLivreModal } = await import('./ImportarMercadoLivreModal');

const CAIXA = /Sobrescrever dados do produto/i;

function campoCodigo(): HTMLInputElement {
  return screen.getByLabelText(/Código do anúncio/i) as HTMLInputElement;
}

/**
 * Render the modal, pick the account and type an MLB id — the two required inputs.
 * The default value is typed with the hyphen ML itself renders, so every case
 * below also exercises the mask on the way in.
 */
async function abrirEPreencher(codigo = 'MLB-5146021467'): Promise<void> {
  render(
    <MantineTestProvider>
      <ImportarMercadoLivreModal db={{} as Firestore} opened onClose={() => {}} />
    </MantineTestProvider>,
  );
  // By PLACEHOLDER: the Select's label text 'Conta' also matches its wrapper,
  // so getByLabelText finds multiple elements.
  fireEvent.click(screen.getByPlaceholderText(/Selecione a conta/i));
  fireEvent.click(await screen.findByText('Loja A'));
  fireEvent.change(campoCodigo(), { target: { value: codigo } });
}

/** The checkbox INPUT — by role, so the click lands on the control itself. */
function caixa(): HTMLInputElement {
  return screen.getByRole('checkbox', { name: CAIXA }) as HTMLInputElement;
}

function botaoImportar(): HTMLButtonElement {
  return screen.getByRole('button', { name: /^Importar$/ }) as HTMLButtonElement;
}

function importar(): void {
  fireEvent.click(botaoImportar());
}

describe('ImportarMercadoLivreModal — máscara do código do anúncio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normalises the pasted hyphenated code and sends it without the hyphen', async () => {
    h.importar.mockResolvedValue({ produtoId: 'p1', estado: 'a', nome: 'X', created: true });
    await abrirEPreencher('MLB-5146021467');
    expect(campoCodigo().value).toBe('MLB5146021467');
    importar();

    await waitFor(() => expect(h.importar).toHaveBeenCalled());
    expect(h.importar.mock.calls[0]?.[0].itemId).toBe('MLB5146021467');
  });

  it('accepts a pasted permalink', async () => {
    await abrirEPreencher('https://produto.mercadolivre.com.br/MLB-5146021467');
    expect(campoCodigo().value).toBe('MLB5146021467');
    expect(botaoImportar().disabled).toBe(false);
  });

  // ⚠️ Another site's id must not reach the importer: this backend serves MLB only,
  // and an MLU listing would half-import with a link doc stamped `MLB`.
  it('blocks a non-MLB site code and never calls the client', async () => {
    await abrirEPreencher('MLU-5146021467');
    expect(botaoImportar().disabled).toBe(true);
    importar();
    expect(h.importar).not.toHaveBeenCalled();
    expect(screen.getByText(/formato MLB1234567890/i)).toBeTruthy();
  });

  it('keeps the button disabled while the code is still being typed', async () => {
    await abrirEPreencher('ML');
    expect(campoCodigo().value).toBe('ML');
    expect(botaoImportar().disabled).toBe(true);
  });
});

describe('ImportarMercadoLivreModal — sobrescreverDadosProduto', () => {
  // ⚠️ Without this, `mock.calls[0]` is the call the PREVIOUS test made, so the
  // ticked-checkbox assertion below reads the UNTICKED run's payload. It failed
  // loudly here; the same shape passes vacuously just as easily.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers the checkbox UNTICKED, so a re-import cannot overwrite typed work by default', async () => {
    await abrirEPreencher();
    expect(caixa().checked).toBe(false);
  });

  it('sends sobrescreverDadosProduto: false when it is left alone', async () => {
    h.importar.mockResolvedValue({ produtoId: 'p1', estado: 'a', nome: 'X', created: true });
    await abrirEPreencher();
    importar();

    await waitFor(() => expect(h.importar).toHaveBeenCalled());
    expect(h.importar.mock.calls[0]?.[0].options).toMatchObject({
      sobrescreverDadosProduto: false,
    });
  });

  it('sends sobrescreverDadosProduto: true once it is ticked', async () => {
    h.importar.mockResolvedValue({ produtoId: 'p1', estado: 'a', nome: 'X', created: false });
    await abrirEPreencher();
    fireEvent.click(caixa());
    importar();

    await waitFor(() => expect(h.importar).toHaveBeenCalled());
    expect(h.importar.mock.calls[0]?.[0].options).toMatchObject({
      sobrescreverDadosProduto: true,
    });
  });
});
