import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MantineTestProvider } from '@/lib/testing/mantine';

/**
 * The panel that makes a size-chart mismatch visible BEFORE the publish (#1087).
 *
 * ⚠️ What this file pins that `tabelaMedidasBinding.test.ts` cannot: that the
 * right verdict reached the right cell, and that the two ML metadata queries
 * are the ones the tab has already made. The pure test owns the decisions.
 */
const h = vi.hoisted(() => ({
  categorias: vi.fn(),
  categoriaAtributos: vi.fn(),
}));

vi.mock('@/lib/mercado-livre/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mercado-livre/client')>();
  return {
    ...actual,
    useMercadoLivreClient: () => ({
      categorias: h.categorias,
      categoriaAtributos: h.categoriaAtributos,
    }),
  };
});

const { TabelaMedidasResumo } = await import('./TabelaMedidasResumo');

const CONTA = 'conta-1';

/** A fashion category: ML reports SIZE_GRID_ID, withheld as `tabela-de-medidas`. */
const COM_GUIA = {
  leaf: true,
  atributos: [],
  omitidos: [{ id: 'SIZE_GRID_ID', motivo: 'tabela-de-medidas' }],
};
const SEM_GUIA = { leaf: true, atributos: [], omitidos: [] };

function categoria(catalogDomain: string | null) {
  return {
    roots: null,
    node: {
      id: 'MLB1398',
      name: 'Camisetas',
      pathFromRoot: [{ id: 'MLB1398', name: 'Camisetas' }],
      children: [],
      isLeaf: true,
      settings: catalogDomain == null ? null : { catalog_domain: catalogDomain },
    },
  };
}

const guia = (over: Record<string, unknown> = {}) => ({
  id: '7523235',
  nome: 'Grade infantil',
  domain_id: 'MLB-T_SHIRTS',
  attributes: [
    { id: 'BRAND', value_id: 'B1', value_name: 'Veste France' },
    { id: 'GENDER', value_id: '19159491', value_name: 'Infantil' },
  ],
  rows: [],
  ...over,
});

const ANUNCIO = [
  { id: 'BRAND', value_id: 'B1', value_name: 'Veste France' },
  { id: 'GENDER', value_id: '19159491', value_name: 'Infantil' },
];

function show(guias: unknown[], linkAttributes = ANUNCIO) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MantineTestProvider>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MantineTestProvider>
  );
  render(
    <TabelaMedidasResumo
      integracaoId={CONTA}
      categoryId="MLB1398"
      nomeDaTabela="Camiseta lisa infantil"
      chartsMap={{ [CONTA]: { tabelas: guias } }}
      linkAttributes={linkAttributes}
    />,
    { wrapper },
  );
}

/** The one guia row, so an assertion cannot pass on text elsewhere on the panel. */
const linha = () => within(screen.getByRole('table')).getAllByRole('row')[1]!;

/**
 * Wait until the category metadata has LANDED.
 *
 * ⚠️ The table renders on the guias alone, before either query resolves, so
 * every verdict is `null` on the first paint. Asserting there does not just
 * race — it passes VACUOUSLY for anything phrased as an absence (no aviso, no
 * ✗), because nothing has been decided yet.
 */
async function pronto(): Promise<void> {
  await waitFor(() =>
    expect(screen.getByTestId('ml-tabela-medidas-anuncio').textContent).toContain('MLB-'),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.categorias.mockResolvedValue(categoria('MLB-T_SHIRTS'));
  h.categoriaAtributos.mockResolvedValue(COM_GUIA);
});

describe('TabelaMedidasResumo', () => {
  it('shows each guia with its domínio, marca and gênero', async () => {
    show([guia()]);

    await pronto();
    const row = linha();
    expect(within(row).getByText('Grade infantil')).toBeDefined();
    expect(within(row).getByText('MLB-T_SHIRTS')).toBeDefined();
    expect(within(row).getByText('Veste France')).toBeDefined();
    expect(within(row).getByText('Infantil')).toBeDefined();
    expect(within(row).getByText('vincula')).toBeDefined();
  });

  it("prints the anúncio's own three values, so nothing has to be held in mind", async () => {
    show([guia()]);

    await pronto();
    const rodape = screen.getByTestId('ml-tabela-medidas-anuncio');
    expect(rodape.textContent).toContain('MLB-T_SHIRTS');
    expect(rodape.textContent).toContain('Veste France');
    expect(rodape.textContent).toContain('Infantil');
  });

  it('the live case: a DOMAIN mismatch warns, naming both domains', async () => {
    show([guia({ domain_id: 'MLB-SHIRTS' })]);

    await pronto();
    const aviso = await screen.findByTestId('ml-tabela-medidas-aviso');
    expect(aviso.textContent).toContain('MLB-SHIRTS');
    expect(aviso.textContent).toContain('MLB-T_SHIRTS');
    expect(within(linha()).getByText('não vincula')).toBeDefined();
  });

  it('a GÊNERO mismatch binds nothing either — and does not blame the domain', async () => {
    // ⚠️ The second silent failure. The domain column alone cannot explain it,
    // which is why every attribute gets its own cell.
    show([guia({ attributes: [{ id: 'GENDER', value_id: '339665', value_name: 'Feminino' }] })]);

    await pronto();
    const row = linha();
    expect(within(row).getByText('Feminino')).toBeDefined();
    expect(within(row).getByText('não vincula')).toBeDefined();
    // The domain is right, so the domain warning must stay quiet.
    expect(screen.queryByTestId('ml-tabela-medidas-aviso')).toBeNull();
  });

  it('a guia that never went to ML reads NUNCA ENVIADA, not as a mismatch', async () => {
    show([guia({ id: null })]);

    await pronto();
    expect(within(linha()).getByText('nunca enviada')).toBeDefined();
    expect(screen.queryByTestId('ml-tabela-medidas-aviso')).toBeNull();
  });

  it('a missing attribute renders — as a dash, with no verdict claimed', async () => {
    show([guia({ attributes: [{ id: 'GENDER', value_id: '19159491', value_name: 'Infantil' }] })]);

    await pronto();
    const row = linha();
    expect(within(row).getByText('—')).toBeDefined();
    // It still binds: an attribute nobody filled in cannot score.
    expect(within(row).getByText('vincula')).toBeDefined();
  });

  it('stays quiet about the domain in a category that uses no guia', async () => {
    h.categoriaAtributos.mockResolvedValue(SEM_GUIA);
    show([guia({ domain_id: 'MLB-SHIRTS' })]);

    await pronto();
    expect(screen.queryByTestId('ml-tabela-medidas-aviso')).toBeNull();
  });

  it('says so plainly when the tabela has no guia in THIS conta', async () => {
    show([]);

    const panel = await screen.findByTestId('ml-tabela-medidas-resumo');
    expect(panel.textContent).toContain('não tem nenhuma guia nesta');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('asks for each piece of ML metadata exactly once', async () => {
    // ⚠️ Both queries reuse the keys `CategoriaField` and `ListingForm` already
    // fetch under, so on a real listing they are cache hits. If someone changes
    // a key, this is the only thing that notices.
    show([guia()]);

    await pronto();
    expect(h.categorias).toHaveBeenCalledTimes(1);
    expect(h.categoriaAtributos).toHaveBeenCalledTimes(1);
  });
});
