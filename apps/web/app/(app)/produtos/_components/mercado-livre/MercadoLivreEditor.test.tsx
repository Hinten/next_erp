import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
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
  /** Lets a test hold one listing's attribute metadata in flight. */
  markLoading: null as null | ((linkDocId: string, loading: boolean) => void),
  /** The produto doc snapshot's `loading` — it resolves AFTER the buttons render. */
  produtoLoading: false,
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
    // Unlike the two `useSnapshot` queries above, this one does NOT hold back the
    // render — the editor paints its buttons and resolves this afterwards, which
    // is the window a publish could be fired in.
    loading: h.produtoLoading,
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
    onLoadingChange,
    registerFlush,
  }: {
    linkDocId: string;
    onDirtyChange: (id: string, dirty: boolean) => void;
    onLoadingChange: (id: string, loading: boolean) => void;
    registerFlush: (id: string, save: ListingSaveFn | null) => void;
  }) => {
    h.markDirty = onDirtyChange;
    h.markLoading = onLoadingChange;
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
    <MantineTestProvider>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MantineTestProvider>
  );
  render(<MercadoLivreEditor produtoId="prod-1" db={{} as Firestore} />, { wrapper });
}

beforeEach(() => {
  h.contas = [conta('conta-1', 'Loja Principal')];
  h.links = [];
  h.saves = new Map();
  h.outcomes = new Map();
  h.markDirty = null;
  h.markLoading = null;
  h.produtoLoading = false;
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
    // and the migrated corpus really does carry links stored that way — the
    // value comes from the DATA, not from a second live writer (rule 8: no dual
    // run) — so the dead button survived at one specific value.
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
 * The write actions were live while the page was still loading.
 *
 * The editor already withholds its whole render until the contas and links
 * snapshots resolve, which made the remaining gap easy to miss: the produto doc,
 * its extraData, the tenant claims and each listing's category attributes all
 * land AFTER the buttons are on screen. A publish fired in that window is built
 * from data nobody saw — and the attribute grid is the worst of them, because it
 * renders EMPTY rather than absent, so a half-loaded form looks complete.
 */
describe('write actions wait for the data they act on', () => {
  // ⚠️ Anchored regexes so neither locator can claim the sibling button, and
  // `.disabled` rather than `toBeEnabled` — this suite loads no jest-dom, so the
  // DOM matchers silently do not exist (`Invalid Chai property`).
  const btn = (name: RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;
  const publicar = () => btn(/^Republicar$/);
  const comPrecos = () => btn(/^Republicar e atualizar preços$/);

  beforeEach(() => {
    h.links = [link('ML-DOC-1', { id: 'MLB1', estado: ESTADO_PUBLICACAO_ML.publicado })];
  });

  it('disables BOTH publish buttons while the produto doc is still loading', async () => {
    h.produtoLoading = true;
    renderEditor();
    await waitFor(() => expect(publicar().disabled).toBe(true));
    expect(comPrecos().disabled).toBe(true);
  });

  it('enables them once everything has settled', async () => {
    renderEditor();
    await waitFor(() => expect(publicar().disabled).toBe(false));
    expect(comPrecos().disabled).toBe(false);
  });

  it('disables them while a listing reports its attributes in flight', async () => {
    renderEditor();
    await waitFor(() => expect(publicar().disabled).toBe(false));

    act(() => h.markLoading!('ML-DOC-1', true));
    await waitFor(() => expect(publicar().disabled).toBe(true));
    expect(comPrecos().disabled).toBe(true);

    // ...and RELEASES. A gate that never opens is worse than the race it fixes.
    act(() => h.markLoading!('ML-DOC-1', false));
    await waitFor(() => expect(publicar().disabled).toBe(false));
  });

  it('holds the sibling write actions too, not just publish', async () => {
    // They act on the same half-arrived data; gating only publish would leave
    // the same bug one button over. (`Reverificar anúncio` is not asserted here
    // — it renders only for a stock-latched listing, which a published one is
    // not; it takes the same `contaLoading` through `ListingStatusStrip`.)
    h.produtoLoading = true;
    renderEditor();
    await waitFor(() => expect(btn(/^Enviar estoque$/).disabled).toBe(true));
  });

  it('holds Reverificar too, on the latched listing that offers it', async () => {
    h.links = [link('ML-DOC-1', { id: 'MLB1', estado: ESTADO_PUBLICACAO_ML.erro })];
    h.produtoLoading = true;
    renderEditor();
    await waitFor(() => expect(btn(/^Reverificar anúncio$/).disabled).toBe(true));
  });
});

/**
 * #798 — publish and price are two calls, and this button is the only thing that
 * makes that split invisible to the operator.
 *
 * A publish deliberately omits `price` from the PUT it sends per listing, so a
 * republish (to fix a photo, a title, an attribute) cannot silently bypass the
 * price flow's "Permitir baixar preços" guard nor 400 on an item with an active
 * ML price automation. The price half rides the SHARED marketplace price rail
 * (#804's `POST /enviar-precos`), not the account-wide job — synchronous, so it
 * reports a per-listing outcome and cannot collide with a running bulk job.
 */
describe('Republicar e atualizar preços', () => {
  const PUBLISHED = { itemId: 'MLB1', estado: 'p', permalink: null, itemIds: ['MLB1'] };
  const PRICED = {
    canal: 'mercado-livre',
    integracaoId: 'conta-1',
    contaNome: null,
    solicitados: 1,
    familias: 1,
    resumo: { enviados: 1, pulados: 0, falhas: 0, naoTentados: 0 },
    listings: [],
    produtosSemEnvio: [],
    pausadoAte: null,
  };

  function wireClient(over: Record<string, unknown> = {}) {
    const publicar = vi.fn(async () => PUBLISHED);
    const enviarPrecos = vi.fn(async () => PRICED);
    h.client = { publicar, enviarPrecos, ...over };
    return { publicar, enviarPrecos };
  }

  it('publishes and THEN prices, through the shared rail, scoped to this produto', async () => {
    h.links = [link('link-1', { id: 'MLB1', estado: ESTADO_PUBLICACAO_ML.publicado })];
    const { publicar, enviarPrecos } = wireClient();
    renderEditor();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Republicar e atualizar preços' }));
    });

    await waitFor(() => expect(enviarPrecos).toHaveBeenCalled());
    expect(publicar).toHaveBeenCalledOnce();
    // `baixarPreco: true` matches the rail's own default for a hand-picked
    // selection — naming the produto IS the explicit intent.
    expect(enviarPrecos).toHaveBeenCalledWith({
      integracaoId: 'conta-1',
      produtoIds: ['prod-1'],
      baixarPreco: true,
    });
  });

  it('does NOT price when the publish failed', async () => {
    // Pricing a listing that failed to publish either 404s or updates the stale
    // version — neither is what the operator asked for.
    h.links = [link('link-1', { id: 'MLB1', estado: ESTADO_PUBLICACAO_ML.publicado })];
    const { enviarPrecos } = wireClient({
      publicar: vi.fn(async () => {
        throw new MercadoLivreClientHttpError('falha no Mercado Livre', 500, null);
      }),
    });
    renderEditor();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Republicar e atualizar preços' }));
    });

    await waitFor(() => expect(h.notify).toHaveBeenCalled());
    expect(enviarPrecos).not.toHaveBeenCalled();
  });

  it('a 200 carrying only failures is reported as a failure, not a success', async () => {
    // ⚠️ Per-listing failure is DATA on this rail. Treating "no throw" as success
    // would tell the operator the price went out when nothing did.
    h.links = [link('link-1', { id: 'MLB1', estado: ESTADO_PUBLICACAO_ML.publicado })];
    wireClient({
      enviarPrecos: vi.fn(async () => ({
        ...PRICED,
        resumo: { enviados: 0, pulados: 0, falhas: 1, naoTentados: 0 },
      })),
    });
    renderEditor();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Republicar e atualizar preços' }));
    });

    await waitFor(() =>
      expect(h.notify).toHaveBeenCalledWith(
        expect.objectContaining({ color: 'yellow', title: 'Nenhum preço enviado' }),
      ),
    );
  });

  it('plain Republicar never touches prices', async () => {
    h.links = [link('link-1', { id: 'MLB1', estado: ESTADO_PUBLICACAO_ML.publicado })];
    const { publicar, enviarPrecos } = wireClient();
    renderEditor();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Republicar' }));
    });

    await waitFor(() => expect(publicar).toHaveBeenCalled());
    expect(enviarPrecos).not.toHaveBeenCalled();
  });

  it('spins ONLY the button that was clicked', async () => {
    // Both actions share one handler, so a bare conta id in the loading state lit
    // up both and the operator could not tell which was running.
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
    // With NO link doc there is no `category_id`, so publish 422s before writing
    // anything and there would be nothing to price. A rascunho (a link doc with
    // `id == null`) DOES get it — see the next case.
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

describe('"ver no Mercado Livre" for a User-Products listing', () => {
  /** A published UP family: `id` is the family id, which addresses no page. */
  const FAMILIA = { id: '6264141844942250', isUserProductModel: true };

  /**
   * `window.open` is what a real click grants and jsdom does not implement.
   * Returning a handle lets the assertions cover the whole point of the flow:
   * the tab is claimed BEFORE the await, then navigated.
   */
  function stubWindowOpen() {
    const aba = { opener: {} as unknown, location: { replace: vi.fn() }, close: vi.fn() };
    const open = vi.fn(() => aba as unknown as Window);
    vi.stubGlobal('open', open);
    return { aba, open };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves the URL from the backend and sends the tab there', async () => {
    h.links = [link('link-1', FAMILIA)];
    const linkAnuncio = vi.fn(async () => ({ url: 'https://www.mercadolivre.com.br/up/MLBU1' }));
    h.client = { linkAnuncio };
    const { aba, open } = stubWindowOpen();
    renderEditor();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'ver no Mercado Livre' }));
    });

    expect(linkAnuncio).toHaveBeenCalledWith({
      integracaoId: 'conta-1',
      produtoId: 'prod-1',
      linkDocId: 'link-1',
    });
    // ⚠️ The tab is claimed with a blank URL at click time — a `window.open`
    // issued after the await has lost the user activation and is popup-blocked.
    // The ORDER is the assertion: opening with the right args proves nothing if
    // it happens once the resolution has already come back.
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(open.mock.invocationCallOrder[0]!).toBeLessThan(
      linkAnuncio.mock.invocationCallOrder[0]!,
    );
    expect(aba.location.replace).toHaveBeenCalledWith('https://www.mercadolivre.com.br/up/MLBU1');
    // Severed by hand: the blank-target form cannot carry `noopener` (that flag
    // makes it return null, and the handle is what navigates the tab).
    expect(aba.opener).toBeNull();
  });

  it('turns into a plain anchor afterwards, so a second click costs nothing', async () => {
    h.links = [link('link-1', FAMILIA)];
    const linkAnuncio = vi.fn(async () => ({ url: 'https://www.mercadolivre.com.br/up/MLBU1' }));
    h.client = { linkAnuncio };
    stubWindowOpen();
    renderEditor();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'ver no Mercado Livre' }));
    });

    const anchor = await screen.findByRole('link', { name: 'ver no Mercado Livre' });
    expect(anchor.getAttribute('href')).toBe('https://www.mercadolivre.com.br/up/MLBU1');
    expect(linkAnuncio).toHaveBeenCalledOnce();
  });

  it('closes the tab and reports the failure instead of leaving it blank', async () => {
    h.links = [link('link-1', FAMILIA)];
    h.client = {
      linkAnuncio: vi.fn(async () => {
        throw new MercadoLivreClientHttpError('O anúncio não existe mais.', 404, null);
      }),
    };
    const { aba } = stubWindowOpen();
    renderEditor();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'ver no Mercado Livre' }));
    });

    expect(aba.close).toHaveBeenCalledOnce();
    expect(aba.location.replace).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledWith({ color: 'red', message: 'O anúncio não existe mais.' });
  });

  it('still resolves when the browser refused the tab, leaving an anchor to click', async () => {
    h.links = [link('link-1', FAMILIA)];
    h.client = {
      linkAnuncio: vi.fn(async () => ({ url: 'https://www.mercadolivre.com.br/up/MLBU1' })),
    };
    vi.stubGlobal(
      'open',
      vi.fn(() => null),
    );
    renderEditor();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'ver no Mercado Livre' }));
    });

    expect(await screen.findByRole('link', { name: 'ver no Mercado Livre' })).toBeDefined();
  });

  it('a legacy listing needs no round trip at all', async () => {
    h.links = [link('link-1', { id: 'MLB777', isUserProductModel: false })];
    const linkAnuncio = vi.fn();
    h.client = { linkAnuncio };
    renderEditor();

    const anchor = await screen.findByRole('link', { name: 'ver no Mercado Livre' });
    expect(anchor.getAttribute('href')).toBe('https://produto.mercadolivre.com.br/MLB-777');
    expect(linkAnuncio).not.toHaveBeenCalled();
  });
});
