import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Firestore } from 'firebase/firestore';
import { ESTADO_PUBLICACAO_ML, type ProdutoMercadoLivreLink } from '@delfrance/schemas';

import { linkFixture } from '@/lib/mercado-livre/linkFixture';
import { MercadoLivreClientHttpError } from '@/lib/mercado-livre/client';

type ListingSaveOutcome = 'saved' | 'invalid' | 'conflict' | 'failed';
type ListingSaveFn = (mode: 'button' | 'flush') => Promise<ListingSaveOutcome>;

const h = vi.hoisted(() => ({
  contas: [] as Array<{ id: string; data: Record<string, unknown> }>,
  links: [] as Array<{ id: string; data: unknown }>,
  /** Every ListingForm stub's registered save, keyed by link doc id. */
  saves: new Map<string, ReturnType<typeof vi.fn>>(),
  /** What each stubbed save reports back, so a test can force a shortfall. */
  outcomes: new Map<string, string>(),
  /** Lets a test mark one listing dirty, the way a real edit would. */
  markDirty: null as null | ((linkDocId: string, dirty: boolean) => void),
  notify: vi.fn(),
  /**
   * What `useMercadoLivreClient()` answers. Empty by default — most tests here
   * assert on rendering and gating, not on calls — and populated per test by
   * the ones that drive an action.
   */
  client: {} as Record<string, unknown>,
}));

vi.mock('@mantine/notifications', () => ({ notifications: { show: h.notify } }));

vi.mock('@delfrance/data', () => ({
  buildQuery: () => ({}),
  limit: () => ({}),
  whereEqual: () => ({}),
}));

vi.mock('@delfrance/data/hooks', () => ({
  // The editor calls `useSnapshot` twice per render, always contas-then-links
  // (`MercadoLivreEditor.tsx`, the two `useMemo` queries). Hooks are order-stable
  // by definition, so a per-render counter discriminates them safely — the mocked
  // `buildQuery` returns an opaque object that could carry no tag.
  useSnapshot: (() => {
    let call = 0;
    return () => {
      const isContas = call % 2 === 0;
      call += 1;
      return { data: isContas ? h.contas : h.links, loading: false, error: null };
    };
  })(),
  useDocSnapshot: () => ({
    data: { id: 'prod-1', data: { nome: 'Camiseta Básica', fotos: ['a'], ehUsado: false } },
    loading: false,
    error: null,
  }),
}));

vi.mock('@/lib/auth', () => ({ usePermission: () => ({ allowed: true }) }));
vi.mock('@/lib/mercado-livre/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/mercado-livre/client')>();
  return { ...actual, useMercadoLivreClient: () => h.client };
});
vi.mock('@/lib/data/integracaoCollection', () => ({ integracaoCollection: { ref: () => ({}) } }));
vi.mock('@/lib/data/produtoCollection', () => ({ produtoCollection: { docRef: () => ({}) } }));
// The editor reads `extraData.condicao` (the second input `resolveCondicaoAnuncio`
// uses). Stubbed like its siblings so the real module's `defineCollection` call
// never runs against the `@delfrance/data` mock above.
vi.mock('@/lib/data/produtoExtraDataCollection', () => ({
  produtoExtraDataCollection: { docRef: () => ({}) },
}));
vi.mock('@/lib/data/produtoMercadoLivreLinkCollection', () => ({
  produtoMercadoLivreLinkCollection: { ref: () => ({}) },
}));

/**
 * Stub the listing form: it registers a save and exposes the dirty reporter, so
 * a test can drive the two things the editor's action group depends on without
 * rendering a whole RHF form.
 */
vi.mock('./ListingForm', () => ({
  ListingForm: ({
    linkDocId,
    onDirtyChange,
    registerFlush,
  }: {
    linkDocId: string;
    onDirtyChange: (id: string, dirty: boolean) => void;
    registerFlush: (id: string, save: ListingSaveFn | null) => void;
  }) => {
    h.markDirty = onDirtyChange;
    if (!h.saves.has(linkDocId))
      h.saves.set(
        linkDocId,
        vi.fn(async () => h.outcomes.get(linkDocId) ?? 'saved'),
      );
    registerFlush(linkDocId, h.saves.get(linkDocId)! as unknown as ListingSaveFn);
    return <div data-testid={`listing-form-${linkDocId}`} />;
  },
}));

const { MercadoLivreEditor } = await import('./MercadoLivreEditor');

function conta(id: string, nome: string) {
  return { id, data: { nome, tipo: 1, ativo: true } };
}

function link(id: string, over: Partial<ProdutoMercadoLivreLink> = {}) {
  return { id, data: linkFixture({ contaOuterRef: 'documents/integracao/conta-1', ...over }) };
}

function renderEditor() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MantineProvider env="test">
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MantineProvider>
  );
  render(<MercadoLivreEditor produtoId="prod-1" db={{} as Firestore} />, { wrapper });
}

beforeEach(() => {
  h.contas = [conta('conta-1', 'Loja Principal')];
  h.links = [];
  h.saves = new Map();
  h.outcomes = new Map();
  h.markDirty = null;
  h.notify.mockClear();
  h.client = {};
});

describe('Enviar estoque is offered only for a PUBLISHED listing', () => {
  it('is absent when the conta holds only an unpublished draft', async () => {
    // ⚠️ The bug this pins. A draft from "Preparar anúncio" is a link doc with
    // `id == null`, and the old gate was `contaLinks.length > 0` — so the button
    // rendered and was enabled on a listing the push can do nothing with. The
    // backend answers `sem-id-externo`; offering the action at all was a
    // guaranteed no-op dressed up as a control.
    h.links = [link('L-DRAFT', { id: null, estado: ESTADO_PUBLICACAO_ML.rascunho })];
    renderEditor();
    await waitFor(() => {
      expect(screen.getByTestId('listing-form-L-DRAFT')).toBeDefined();
    });
    expect(screen.queryByRole('button', { name: 'Enviar estoque' })).toBeNull();
  });

  it('is present when the conta holds a published listing', async () => {
    h.links = [link('L-PUB', { id: 'MLB777' })];
    renderEditor();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Enviar estoque' })).toBeDefined();
    });
  });

  it('treats an EMPTY id as unpublished, exactly like the backend does', async () => {
    // ⚠️ `id != null` was one value looser than `bulkEstoquePlan`, which takes
    // `link.id !== ''` as its test and answers `sem-item-id` otherwise. The
    // schema permits `''` (`z.string().nullable().default(null)`, no `.min(1)`)
    // and the Flutter app writes these same docs concurrently, so the dead
    // button survived at one specific value.
    h.links = [link('L-EMPTY', { id: '' })];
    renderEditor();
    await waitFor(() => {
      expect(screen.getByTestId('listing-form-L-EMPTY')).toBeDefined();
    });
    expect(screen.queryByRole('button', { name: 'Enviar estoque' })).toBeNull();
  });

  it('is present when only SOME of the conta listings are published', async () => {
    // `some`, not `every` — a conta holding one live listing and one draft must
    // keep the action for the live one (#781: a conta can hold several).
    h.links = [link('L-DRAFT', { id: null }), link('L-PUB', { id: 'MLB777' })];
    renderEditor();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Enviar estoque' })).toBeDefined();
    });
  });
});

describe('Salvar anúncio sits with the publish action', () => {
  it('is hidden until a listing reports itself dirty', async () => {
    h.links = [link('L-PUB', { id: 'MLB777' })];
    renderEditor();
    await waitFor(() => {
      expect(screen.getByTestId('listing-form-L-PUB')).toBeDefined();
    });
    expect(screen.queryByRole('button', { name: /Salvar an/ })).toBeNull();
  });

  it('appears on ANY reported edit, including an attribute-only one', async () => {
    // ⚠️ The regression this fixes. The old button read RHF's `isDirty`, which
    // does not move for an attribute edit (attributes are held beside the form,
    // not as an RHF field) — so editing only attributes left the sole save
    // button greyed out. The editor's `dirtyIds` is fed by
    // `onDirtyChange(id, isDirty || attrDirty)`, which does move.
    h.links = [link('L-PUB', { id: 'MLB777' })];
    renderEditor();
    await waitFor(() => expect(h.markDirty).not.toBeNull());

    act(() => {
      h.markDirty!('L-PUB', true);
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Salvar anúncio' })).toBeDefined();
    });
  });

  it('drives the listing save in BUTTON mode, not flush mode', async () => {
    // Flush mode throws AfterSaveBlockedError for ObjectView; a button click has
    // no outer save to block and must report its own failure instead.
    h.links = [link('L-PUB', { id: 'MLB777' })];
    renderEditor();
    await waitFor(() => expect(h.markDirty).not.toBeNull());
    act(() => {
      h.markDirty!('L-PUB', true);
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Salvar anúncio' }));
    await waitFor(() => {
      expect(h.saves.get('L-PUB')).toHaveBeenCalledWith('button');
    });
  });

  it('saves EVERY dirty listing in the card, not just the first', async () => {
    // The button is conta-level, beside a conta-level Publicar, and a conta can
    // hold several listings — saving only the first would silently drop the rest.
    h.links = [link('L-A', { id: 'MLB1' }), link('L-B', { id: 'MLB2' })];
    renderEditor();
    await waitFor(() => expect(h.markDirty).not.toBeNull());
    act(() => {
      h.markDirty!('L-A', true);
      h.markDirty!('L-B', true);
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Salvar anúncios' }));
    await waitFor(() => {
      expect(h.saves.get('L-A')).toHaveBeenCalledWith('button');
    });
    expect(h.saves.get('L-B')).toHaveBeenCalledWith('button');
  });

  it('says so when one listing was silently skipped', async () => {
    // ⚠️ The partial-failure case a per-listing button could not produce. An
    // invalid listing returns SILENTLY (its errors render inline, above this
    // button) while the sibling fires an unqualified green "Anúncio salvo." —
    // so one click that saved half the work reported unqualified success.
    h.links = [link('L-A', { id: 'MLB1' }), link('L-B', { id: 'MLB2' })];
    h.outcomes.set('L-A', 'invalid');
    renderEditor();
    await waitFor(() => expect(h.markDirty).not.toBeNull());
    act(() => {
      h.markDirty!('L-A', true);
      h.markDirty!('L-B', true);
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Salvar anúncios' }));
    await waitFor(() => {
      expect(h.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          message: '1 de 2 anúncios salvos. Corrija os campos destacados.',
        }),
      );
    });
  });

  it('stays quiet when every listing landed', async () => {
    h.links = [link('L-A', { id: 'MLB1' }), link('L-B', { id: 'MLB2' })];
    renderEditor();
    await waitFor(() => expect(h.markDirty).not.toBeNull());
    act(() => {
      h.markDirty!('L-A', true);
      h.markDirty!('L-B', true);
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Salvar anúncios' }));
    await waitFor(() => {
      expect(h.saves.get('L-B')).toHaveBeenCalled();
    });
    // Each save showed its own green notification; a summary would be noise.
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('leaves a clean sibling listing alone', async () => {
    h.links = [link('L-A', { id: 'MLB1' }), link('L-B', { id: 'MLB2' })];
    renderEditor();
    await waitFor(() => expect(h.markDirty).not.toBeNull());
    act(() => {
      h.markDirty!('L-A', true);
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Salvar anúncio' }));
    await waitFor(() => {
      expect(h.saves.get('L-A')).toHaveBeenCalledWith('button');
    });
    expect(h.saves.get('L-B')).not.toHaveBeenCalled();
  });
});

describe('the publication facts come before the editable form', () => {
  it('renders the Publicação block above the listing form', async () => {
    // What the operator opens the tab to check — is it live, at what price, what
    // did ML reject — was previously buried under a long form.
    h.links = [link('L-PUB', { id: 'MLB777' })];
    renderEditor();
    const form = await screen.findByTestId('listing-form-L-PUB');
    const publicacao = screen.getByText('Publicação');
    // 4 = DOCUMENT_POSITION_FOLLOWING: the form follows the Publicação legend.
    expect(publicacao.compareDocumentPosition(form) & 4).toBeTruthy();
  });
});

/**
 * #798 / #804 S6 — publishing and pricing are two calls, and the button that
 * does both is the only thing that makes that split invisible to the operator.
 *
 * A publish deliberately omits prices from the PUT it sends per listing, so a
 * republish (to fix a photo, a title, an attribute) cannot silently bypass the
 * price flow's "Permitir baixar preços" guard, nor 400 on an item with an
 * active ML price automation.
 */
describe('Republicar e atualizar preços', () => {
  const PUBLISHED = { itemId: 'MLB1', estado: 'p', permalink: null, itemIds: ['MLB1'] };

  function wireClient(over: Record<string, unknown> = {}) {
    const publicar = vi.fn(async () => PUBLISHED);
    const startPriceSync = vi.fn(async () => ({ jobId: 'job-1' }));
    h.client = { publicar, startPriceSync, ...over };
    return { publicar, startPriceSync };
  }

  it('publishes and THEN pushes the price, scoped to this produto', async () => {
    h.links = [link('link-1', { id: 'MLB1', estado: ESTADO_PUBLICACAO_ML.publicado })];
    const { publicar, startPriceSync } = wireClient();
    renderEditor();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Republicar e atualizar preços' }));
    });

    await waitFor(() => expect(startPriceSync).toHaveBeenCalled());
    expect(publicar).toHaveBeenCalledOnce();
    // No `baixarPreco`: the server flips its default to true for a
    // produto-scoped run, and hardcoding it here would freeze that rule in two
    // places at once.
    expect(startPriceSync).toHaveBeenCalledWith({ integracaoId: 'conta-1', produtoId: 'prod-1' });
  });

  it('does NOT push a price when the publish failed', async () => {
    // Pricing a listing that failed to publish either 404s or updates the stale
    // version — neither is what the operator asked for.
    h.links = [link('link-1', { id: 'MLB1', estado: ESTADO_PUBLICACAO_ML.publicado })];
    const { startPriceSync } = wireClient({
      publicar: vi.fn(async () => {
        throw new MercadoLivreClientHttpError('falha no Mercado Livre', 500, null);
      }),
    });
    renderEditor();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Republicar e atualizar preços' }));
    });

    await waitFor(() => expect(h.notify).toHaveBeenCalled());
    expect(startPriceSync).not.toHaveBeenCalled();
  });

  it('plain Republicar never touches prices', async () => {
    h.links = [link('link-1', { id: 'MLB1', estado: ESTADO_PUBLICACAO_ML.publicado })];
    const { publicar, startPriceSync } = wireClient();
    renderEditor();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Republicar' }));
    });

    await waitFor(() => expect(publicar).toHaveBeenCalled());
    expect(startPriceSync).not.toHaveBeenCalled();
  });

  it('spins ONLY the button that was clicked', async () => {
    // Both actions share one handler, so a bare conta id in the loading state
    // lit up both and the operator could not tell which one was running.
    // Mantine renders a loading Button as `data-loading` + `disabled`.
    h.links = [link('link-1', { id: 'MLB1', estado: ESTADO_PUBLICACAO_ML.publicado })];
    let release!: () => void;
    wireClient({
      publicar: vi.fn(async () => {
        await new Promise<void>((r) => (release = r));
        return PUBLISHED;
      }),
    });
    renderEditor();

    const paired = screen.getByRole('button', { name: 'Republicar e atualizar preços' });
    const plain = screen.getByRole('button', { name: 'Republicar' });
    fireEvent.click(paired);

    await waitFor(() => expect(paired.getAttribute('data-loading')).toBe('true'));
    expect(plain.getAttribute('data-loading')).not.toBe('true');

    await act(async () => {
      release();
    });
  });

  it('is absent until the conta has a link doc at all', async () => {
    // With NO link doc there is no `category_id`, so publish 422s before
    // writing anything and there would be nothing to price — "Preparar anúncio"
    // is the only action. A rascunho (a link doc with `id: null`) DOES get the
    // button: a first publish is a legitimate thing to pair with a price push.
    h.links = [];
    wireClient();
    renderEditor();

    expect(screen.queryByRole('button', { name: /atualizar preços/i })).toBeNull();
  });

  it('a rascunho offers the paired action as a FIRST publish', async () => {
    h.links = [link('link-1', { id: null, estado: ESTADO_PUBLICACAO_ML.rascunho })];
    wireClient();
    renderEditor();

    expect(screen.getByRole('button', { name: 'Publicar e atualizar preços' })).toBeInstanceOf(
      HTMLButtonElement,
    );
  });
});
