import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
  type MercadoLivreClient,
} from '@/lib/mercado-livre/client';
import { SizeChartEditorModal } from './SizeChartEditorModal';

/**
 * The incident this file exists for: a network blip while the editor loaded the
 * Mercado Livre domain list left a red alert and no way forward. The domain
 * Select had no options, so `domainId` stayed null, so both downstream spec
 * queries stayed disabled — closing and re-opening the modal was the only
 * recovery, and it only worked because the parent remounts on a fresh `key`.
 */

const DOMAINS = { domains: [{ domain_id: 'MLB-T_SHIRTS', name: 'Camisetas' }] };

const networkError = () =>
  new MercadoLivreClientNetworkError('failed to fetch', new TypeError('fetch failed'));

/**
 * The smallest domain `?section=grids` response that renders ONE free-text
 * chart-level question: BRAND is a `grid_template_required` string, so
 * `attributeKind` types it `text` and the modal draws an `Autocomplete` rather
 * than a closed `Select`.
 */
const BRAND_TEMPLATE_SPEC = {
  input: {
    groups: [
      {
        id: 'SIZE_CHART',
        components: [
          {
            component: 'COMBO',
            label: 'Marca',
            attributes: [
              {
                id: 'BRAND',
                name: 'Marca',
                value_type: 'string',
                tags: ['grid_template_required'],
                values: [{ id: '14671', name: 'Nike' }],
              },
            ],
          },
        ],
      },
    ],
  },
};

function show(client: Partial<MercadoLivreClient>) {
  const qc = new QueryClient({
    // ⚠️ NOT `retry: false` — the queries set their own `retry` predicate, which
    // a client default cannot override. `retryDelay: 0` is the knob that IS
    // still ours, and it collapses the automatic backoff so the error path is
    // reached in one tick instead of three real seconds.
    defaultOptions: { queries: { retryDelay: 0 } },
  });
  render(
    // `MantineTestProvider` renders this fullScreen `Modal` inline instead of
    // through a portal. The leaked transition timer is neutralised in
    // `vitest.setup.ts`, not here — see #1150.
    <MantineTestProvider>
      <QueryClientProvider client={qc}>
        <SizeChartEditorModal
          opened
          onClose={vi.fn()}
          client={client as MercadoLivreClient}
          integracaoId="conta-1"
          tabMediId="tab-1"
          getFatos={() => ({}) as never}
          chart={null}
          chartIndex={null}
          grupos={[]}
          canWrite
          onSaveDraft={vi.fn()}
          onSend={vi.fn()}
          onDuplicate={vi.fn()}
        />
      </QueryClientProvider>
    </MantineTestProvider>,
  );
}

describe('SizeChartEditorModal — failed domain load', () => {
  it('heals a one-off blip without ever showing the operator an error', async () => {
    const sizeChartDomains = vi
      .fn()
      .mockRejectedValueOnce(networkError())
      .mockResolvedValue(DOMAINS);
    show({ sizeChartDomains, sizeChartSpecs: vi.fn() });

    await waitFor(() => {
      expect(sizeChartDomains).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByText(/Não foi possível contatar o Mercado Livre/)).toBeNull();
  });

  it('recovers in place when the operator retries a persistent failure', async () => {
    const sizeChartDomains = vi
      .fn()
      // The reported failure, verbatim — and it has to outlast the automatic
      // retries (1 initial attempt + ML_QUERY_MAX_RETRIES) to reach the alert.
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockResolvedValue(DOMAINS);
    show({ sizeChartDomains, sizeChartSpecs: vi.fn() });

    await waitFor(() => {
      expect(screen.getByText(/Não foi possível contatar o Mercado Livre/)).toBeTruthy();
    });
    expect(sizeChartDomains).toHaveBeenCalledTimes(3);

    fireEvent.click(screen.getByRole('button', { name: /Tentar novamente/ }));

    // The dead end is gone: the load recovers without the modal being closed.
    await waitFor(() => {
      expect(screen.queryByText(/Não foi possível contatar o Mercado Livre/)).toBeNull();
    });
    expect(sizeChartDomains).toHaveBeenCalledTimes(4);
    expect(screen.getByPlaceholderText('Selecione o domínio')).toBeTruthy();
  });

  // The old mapper keyed the "reconnect your account" copy on `status === 409`,
  // which is not one meaning: this route family answers 409 for AI states too.
  it('keeps a non-reauth 409 message instead of blaming the connection', async () => {
    const sizeChartDomains = vi
      .fn()
      .mockRejectedValue(
        new MercadoLivreClientHttpError(
          'Já existe uma sugestão em andamento.',
          409,
          'AI_JA_EM_ANDAMENTO',
        ),
      );
    show({ sizeChartDomains, sizeChartSpecs: vi.fn() });

    await waitFor(() => {
      expect(screen.getByText('Já existe uma sugestão em andamento.')).toBeTruthy();
    });
    expect(screen.queryByText(/reconecte em Canais de venda/)).toBeNull();
    // A 4xx is not worth re-attempting, so it was never retried either.
    expect(sizeChartDomains).toHaveBeenCalledTimes(1);
  });

  it('offers no retry for a disconnected account, which retrying cannot fix', async () => {
    const sizeChartDomains = vi
      .fn()
      .mockRejectedValue(
        new MercadoLivreClientHttpError('unauthorized', 409, 'ML_REAUTH_REQUIRED'),
      );
    show({ sizeChartDomains, sizeChartSpecs: vi.fn() });

    await waitFor(() => {
      expect(screen.getByText(/reconecte em Canais de venda/)).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: /Tentar novamente/ })).toBeNull();
  });
});

describe('SizeChartEditorModal — chart-level free-text attributes', () => {
  /** Answer the domain question so the BRAND template renders. */
  async function openWithBrandTemplate() {
    show({
      sizeChartDomains: vi.fn().mockResolvedValue(DOMAINS),
      sizeChartSpecs: vi.fn().mockResolvedValue(BRAND_TEMPLATE_SPEC),
    });

    // By ROLE: a Mantine combobox labels its input AND its listbox, so
    // `getByLabelText` matches two elements and throws.
    const domain = await screen.findByRole('combobox', { name: /Domínio/ });
    fireEvent.click(domain);
    fireEvent.click(await screen.findByText('Camisetas (MLB-T_SHIRTS)'));

    return (await screen.findByRole('combobox', { name: /Marca/ })) as HTMLInputElement;
  }

  it('KEEPS a trailing space while the operator types', async () => {
    // The reported bug: resolving on the change path trimmed the text the input
    // renders back, so the space was gone before the caret moved.
    const marca = await openWithBrandTemplate();
    fireEvent.change(marca, { target: { value: 'Nike ' } });
    expect(marca.value).toBe('Nike ');
  });

  it('lets a value be typed PAST a known option of the same name', async () => {
    // The second stripper, which a trim alone does not fix: "Nike " matched ML's
    // own "Nike" and snapped back to it, eating the space again — so "Nike Air"
    // was unreachable however slowly you typed it.
    const marca = await openWithBrandTemplate();
    fireEvent.change(marca, { target: { value: 'Nike' } });
    // ⚠️ The load-bearing assertion is THIS one, not the last. `fireEvent.change`
    // replaces the whole value, so jumping straight to "Nike Air" passes even
    // against the snapping version — the defect only shows in the keystroke the
    // operator has to pass THROUGH.
    fireEvent.change(marca, { target: { value: 'Nike ' } });
    expect(marca.value).toBe('Nike ');
    fireEvent.change(marca, { target: { value: 'Nike Air' } });
    expect(marca.value).toBe('Nike Air');
  });

  it('resolves what the INPUT holds, not the render snapshot', async () => {
    // Same hazard as the produto field: reading `templateValues` at blur is only
    // correct once React has re-rendered the last keystroke. Here state holds no
    // answer at all while the box says "nike".
    const marca = await openWithBrandTemplate();
    fireEvent.blur(marca, { target: { value: 'nike' } });
    await waitFor(() => {
      expect(marca.value).toBe('Nike');
    });
  });

  it('snaps to ML’s own value on blur, so the id still goes up', async () => {
    const marca = await openWithBrandTemplate();
    fireEvent.change(marca, { target: { value: '  nike  ' } });
    fireEvent.blur(marca);
    await waitFor(() => {
      expect(marca.value).toBe('Nike');
    });
  });
});
