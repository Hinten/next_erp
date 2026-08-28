import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Firestore } from 'firebase/firestore';
import {
  ESTADO_PUBLICACAO_ML,
  ML_CAUSA_TIPO,
  type ProdutoMercadoLivreLink,
} from '@delfrance/schemas';

import { PERM } from '@delfrance/auth';

import { linkFixture } from '@/lib/mercado-livre/linkFixture';
import { MercadoLivreClientHttpError } from '@/lib/mercado-livre/client';

type ListingSaveOutcome = 'saved' | 'invalid' | 'conflict' | 'failed';
type ListingSaveFn = (mode: 'button' | 'flush') => Promise<ListingSaveOutcome>;

const h = vi.hoisted(() => ({
  contas: [] as Array<{ id: string; data: Record<string, unknown> }>,
  links: [] as Array<{ id: string; data: unknown }>,
  /** What the per-variation table's group query answers (#1142). */
  membros: [] as Array<{ id: string; data: Record<string, unknown> }>,
  /** Every ListingForm stub's registered save, keyed by link doc id. */
  saves: new Map<string, ReturnType<typeof vi.fn>>(),
  /** The control→messages map each ListingForm stub received, keyed by link doc id. */
  serverErrors: new Map<string, Record<string, string[]>>(),
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
  createListingDraft: vi.fn(async () => ({ docId: 'novo', outcome: 'created' as const })),
  removeListingDraft: vi.fn(async () => 'removed' as const),
  /**
   * Which permission bits `usePermission` grants.
   *
   * ⚠️ A single boolean here made the delete-permission test VACUOUS: it turned
   * off `integracao.write` and `produto.delete` together, so "absent without the
   * produto's delete permission" stayed green even if the control were gated on
   * the publish bit — which is the one thing that test's name claims to check.
   */
  permitidos: new Set<bigint>(),
}));

vi.mock('@mantine/notifications', () => ({ notifications: { show: h.notify } }));

vi.mock('@delfrance/data', () => ({
  // ⚠️ `buildQuery` PASSES THE BASE THROUGH so a query can be told apart by what
  // it was built on — see the `useSnapshot` mock below for why that matters now.
  buildQuery: (base: unknown) => base ?? {},
  groupQuery: () => ({ __grupo: 'variacaoMercadoLivre' }),
  limit: () => ({}),
  whereEqual: () => ({}),
}));

vi.mock('@delfrance/data/hooks', () => ({
  // ⚠️ Discriminated by WHAT THE QUERY WAS BUILT ON, never by call order. This
  // used to be a per-render counter keyed on "the editor calls `useSnapshot`
  // twice, contas-then-links" — true when written, and silently wrong the moment
  // a third caller appeared: `VariacoesAnuncioTable` subscribes once per anúncio
  // (#1142) and, for a legacy listing, with a `null` query. Either way it
  // consumed a slot and shifted every later call by one, swapping contas and
  // links. Tagging is order-free, so a fourth caller cannot break it either.
  useSnapshot: (q: { __col?: string; __grupo?: string } | null) => {
    if (q?.__col === 'integracao') return { data: h.contas, loading: false, error: null };
    if (q?.__col === 'produtoMercadoLivre') return { data: h.links, loading: false, error: null };
    // The per-variation table: its group query, or `null` on a legacy listing.
    return { data: h.membros, loading: false, error: null };
  },
  useDocSnapshot: () => ({
    data: { id: 'prod-1', data: { nome: 'Camiseta Básica', fotos: ['a'], ehUsado: false } },
    // Unlike the two `useSnapshot` queries above, this one does NOT hold back the
    // render — the editor paints its buttons and resolves this afterwards, which
    // is the window a publish could be fired in.
    loading: h.produtoLoading,
    error: null,
  }),
}));

vi.mock('@/lib/auth', () => ({
  usePermission: (bit: bigint) => ({ allowed: h.permitidos.has(bit) }),
}));
vi.mock('@/lib/mercado-livre/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/mercado-livre/client')>();
  return { ...actual, useMercadoLivreClient: () => h.client };
});
// ⚠️ Each `ref()` returns a TAGGED base so `useSnapshot` can tell the queries
// apart by what they were built on — see its mock above.
vi.mock('@/lib/data/integracaoCollection', () => ({
  integracaoCollection: { ref: () => ({ __col: 'integracao' }) },
}));
vi.mock('@/lib/data/produtoCollection', () => ({ produtoCollection: { docRef: () => ({}) } }));
// Stubbed like its siblings so the real module's `defineCollection` call never
// runs against the `@delfrance/data` mock above.
vi.mock('@/lib/data/variacaoMercadoLivreLinkCollection', () => ({
  variacaoMercadoLivreLinkCollection: { converter: {} },
}));
// The editor reads `extraData.condicao` (the second input `resolveCondicaoAnuncio`
// uses). Stubbed like its siblings so the real module's `defineCollection` call
// never runs against the `@delfrance/data` mock above.
vi.mock('@/lib/data/produtoExtraDataCollection', () => ({
  produtoExtraDataCollection: { docRef: () => ({}) },
}));
vi.mock('@/lib/data/produtoMercadoLivreLinkCollection', () => ({
  produtoMercadoLivreLinkCollection: { ref: () => ({ __col: 'produtoMercadoLivre' }) },
}));
// The editor reads the produto's tabela de medidas so `TabelaMedidasResumo` can
// compare its guias against the anúncio's category (#1087). Stubbed like its
// siblings so the real module's `defineCollection` call never runs against the
// `@delfrance/data` mock above.
vi.mock('@/lib/data/tabelaDeMedidasCollection', () => ({
  tabelaDeMedidasCollection: { docRef: () => ({ __col: 'tabMedi' }) },
}));
vi.mock('@/lib/mercado-livre/listingDraft', () => ({
  createListingDraft: h.createListingDraft,
  removeListingDraft: h.removeListingDraft,
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
    serverErrors,
  }: {
    linkDocId: string;
    onDirtyChange: (id: string, dirty: boolean) => void;
    onLoadingChange: (id: string, loading: boolean) => void;
    registerFlush: (id: string, save: ListingSaveFn | null) => void;
    serverErrors?: Record<string, string[]>;
  }) => {
    h.markDirty = onDirtyChange;
    h.markLoading = onLoadingChange;
    // Captured the same way the two reporters above are: the editor merges THREE
    // sources into this prop and a test needs to see the result (#1087).
    h.serverErrors.set(linkDocId, serverErrors ?? {});
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
  h.membros = [];
  h.saves = new Map();
  h.serverErrors = new Map();
  h.outcomes = new Map();
  h.markDirty = null;
  h.markLoading = null;
  h.produtoLoading = false;
  h.notify.mockClear();
  h.client = {};
  h.createListingDraft.mockClear();
  h.removeListingDraft.mockClear();
  h.permitidos = new Set([PERM.integracao.write, PERM.produto.delete]);
});

/** Open one account's tab — the panels are lazy, so nothing renders until then. */
async function abrirConta(nome: string) {
  fireEvent.click(await screen.findByRole('tab', { name: new RegExp(nome) }));
}

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

/**
 * #1087. ML's policy moderation names a content SECTION (`title`, `category`,
 * `pictures`), and two of those are form controls — so a moderação joins the
 * causa map and the pre-flight refusal on the same inputs instead of growing a
 * fourth channel.
 */
describe('a moderação reaches the control it names', () => {
  const moderacao = (over: Record<string, unknown> = {}) => ({
    nome: 'POOR_QUALITY_THUMBNAIL',
    dataCriacao: null,
    motivo: 'O título infringe nossas políticas.',
    remedio: 'Ajuste o título.',
    secoes: ['title'],
    evidencias: [],
    ...over,
  });

  it('pins a title moderation to the título control', async () => {
    h.links = [
      link('L-MOD', {
        id: 'MLB777',
        moderacoes: [moderacao()],
      } as Partial<ProdutoMercadoLivreLink>),
    ];
    renderEditor();
    await waitFor(() => {
      expect(screen.getByTestId('listing-form-L-MOD')).toBeDefined();
    });

    expect(h.serverErrors.get('L-MOD')?.title).toEqual(['O título infringe nossas políticas.']);
  });

  /**
   * ⚠️ THE ADDITIVE RULE. `listingCausas.ts` records this repo shipping a banner
   * that depended on the control mapping, and a rejection pinned to a control the
   * form did not render then displayed NOWHERE. Resolving to a control is not the
   * same as being visible on one, so the strip lists the moderation whether or
   * not a control also shows it.
   */
  it('still lists it in the strip, even though a control also shows it', async () => {
    h.links = [
      link('L-MOD', {
        id: 'MLB777',
        moderacoes: [moderacao()],
      } as Partial<ProdutoMercadoLivreLink>),
    ];
    renderEditor();
    await waitFor(() => {
      expect(screen.getByTestId('listing-form-L-MOD')).toBeDefined();
    });

    expect(h.serverErrors.get('L-MOD')?.title).toBeDefined();
    expect(screen.getByTestId('ml-moderacoes').textContent).toContain('infringe nossas políticas');
  });

  /**
   * `pictures` has no form control — the photos are managed outside this form —
   * which is precisely why the strip cannot depend on the mapping.
   */
  it('leaves the controls untouched for a moderation on the photos', async () => {
    h.links = [
      link('L-FOTO', {
        id: 'MLB777',
        moderacoes: [moderacao({ secoes: ['pictures'] })],
      } as Partial<ProdutoMercadoLivreLink>),
    ];
    renderEditor();
    await waitFor(() => {
      expect(screen.getByTestId('listing-form-L-FOTO')).toBeDefined();
    });

    expect(h.serverErrors.get('L-FOTO')).toEqual({});
    // …and yet the operator still learns about it.
    expect(screen.getByTestId('ml-moderacoes').textContent).toContain('infringe nossas políticas');
  });

  it('merges a moderation and a causa onto the same control', async () => {
    // They answer different questions — "ML moderated the listing" vs "ML refused
    // this write" — and a listing can legitimately carry both at once.
    h.links = [
      link('L-BOTH', {
        id: 'MLB777',
        moderacoes: [moderacao()],
        causas: [
          {
            code: null,
            causaId: null,
            tipo: ML_CAUSA_TIPO.erro,
            departamento: null,
            mensagem: 'Título muito curto',
            referencias: [],
            campos: ['title'],
          },
        ],
      } as Partial<ProdutoMercadoLivreLink>),
    ];
    renderEditor();
    await waitFor(() => {
      expect(screen.getByTestId('listing-form-L-BOTH')).toBeDefined();
    });

    expect(h.serverErrors.get('L-BOTH')?.title).toEqual([
      'Título muito curto',
      'O título infringe nossas políticas.',
    ]);
  });

  it('sends no control errors at all for a listing with no moderation', async () => {
    h.links = [link('L-LIMPO', { id: 'MLB777' })];
    renderEditor();
    await waitFor(() => {
      expect(screen.getByTestId('listing-form-L-LIMPO')).toBeDefined();
    });

    expect(h.serverErrors.get('L-LIMPO')).toEqual({});
    expect(screen.queryByTestId('ml-moderacoes')).toBeNull();
  });
});

describe('publishing names the listing it means', () => {
  const PUBLISHED = { itemId: 'MLB777', estado: 'p', permalink: null, itemIds: ['MLB777'] };

  it('sends the link doc id of the anúncio whose button was clicked', async () => {
    // Without it the backend resolves the account's FIRST link doc, so
    // publishing the second would silently re-publish the first.
    h.links = [link('L-UM', { id: 'MLB111' }), link('L-DOIS', { id: 'MLB222' })];
    const publicar = vi.fn(async () => PUBLISHED);
    h.client = { publicar };
    renderEditor();
    await waitFor(() => expect(screen.getByTestId('ml-anuncio-L-DOIS')).toBeDefined());

    const segundo = screen.getByTestId('ml-anuncio-L-DOIS');
    await act(async () => {
      fireEvent.click(
        [...segundo.querySelectorAll('button')].find((b) => b.textContent === 'Republicar')!,
      );
    });

    expect(publicar).toHaveBeenCalledWith({
      integracaoId: 'conta-1',
      produtoId: 'prod-1',
      linkDocId: 'L-DOIS',
    });
  });

  it('marks only the listing a blocked publish came from', async () => {
    // A 422 describes ONE publish. Keyed by conta, it painted every sibling
    // listing's fields red for a rejection that was never about them.
    h.links = [link('L-UM', { id: 'MLB111' }), link('L-DOIS', { id: 'MLB222' })];
    h.client = {
      publicar: vi.fn(async () => {
        throw new MercadoLivreClientHttpError('bloqueado', 422, 'ML_PUBLISH_BLOCKED', [
          'produto sem título',
        ]);
      }),
    };
    renderEditor();
    await waitFor(() => expect(screen.getByTestId('ml-anuncio-L-DOIS')).toBeDefined());

    const segundo = screen.getByTestId('ml-anuncio-L-DOIS');
    await act(async () => {
      fireEvent.click(
        [...segundo.querySelectorAll('button')].find((b) => b.textContent === 'Republicar')!,
      );
    });

    await waitFor(() => expect(segundo.textContent).toContain('produto sem título'));
    expect(screen.getByTestId('ml-anuncio-L-UM').textContent).not.toContain('produto sem título');
  });

  it("spins only the clicked listing's button", async () => {
    // The two publish actions share one handler, and both listings share the
    // account — so the in-flight marker has to name the listing AND the variant.
    h.links = [link('L-UM', { id: 'MLB111' }), link('L-DOIS', { id: 'MLB222' })];
    let solta: (() => void) | null = null;
    h.client = {
      publicar: vi.fn(
        () =>
          new Promise((resolve) => {
            solta = () => resolve(PUBLISHED);
          }),
      ),
    };
    renderEditor();
    await waitFor(() => expect(screen.getByTestId('ml-anuncio-L-DOIS')).toBeDefined());

    const segundo = screen.getByTestId('ml-anuncio-L-DOIS');
    fireEvent.click(
      [...segundo.querySelectorAll('button')].find((b) => b.textContent === 'Republicar')!,
    );

    await waitFor(() => {
      expect(segundo.querySelector('button[data-loading]')).not.toBeNull();
    });
    // The sibling listing is untouched — same account, different anúncio.
    expect(screen.getByTestId('ml-anuncio-L-UM').querySelector('button[data-loading]')).toBeNull();

    await act(async () => {
      solta?.();
    });
  });
});

describe('Novo anúncio', () => {
  it('creates the FIRST draft on an account that has none', async () => {
    renderEditor();
    fireEvent.click(await screen.findByTestId('ml-novo-anuncio-conta-1'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Criar anúncio' }));
    });

    expect(h.createListingDraft).toHaveBeenCalledWith(
      expect.anything(),
      'prod-1',
      expect.objectContaining({ integracaoId: 'conta-1', modo: 'primeiro' }),
    );
  });

  it('creates an ADDITIONAL draft on an account that already has one', async () => {
    // The mode is decided from what the account holds, not from which button was
    // pressed — there is only one button.
    h.links = [link('L-UM', { id: 'MLB111' })];
    renderEditor();
    fireEvent.click(await screen.findByTestId('ml-novo-anuncio-conta-1'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Criar anúncio' }));
    });

    expect(h.createListingDraft).toHaveBeenCalledWith(
      expect.anything(),
      'prod-1',
      expect.objectContaining({ modo: 'adicional' }),
    );
  });

  it('is offered whether or not the account already has an anúncio', async () => {
    // The old "Preparar anúncio" was gated on `contaLinks.length === 0`, which
    // is exactly what made a second listing impossible to create.
    h.links = [link('L-UM', { id: 'MLB111' })];
    renderEditor();
    expect(await screen.findByTestId('ml-novo-anuncio-conta-1')).toBeDefined();
  });
});

describe('one account at a time', () => {
  it('builds only the account whose tab is open', async () => {
    // Each ListingForm fetches its category metadata and attribute grid, so an
    // account nobody opened must cost nothing.
    h.contas = [conta('conta-1', 'Loja A'), conta('conta-2', 'Loja B')];
    h.links = [
      link('L-UM', { id: 'MLB111' }),
      { id: 'L-DOIS', data: linkFixture({ contaOuterRef: 'documents/integracao/conta-2' }) },
    ];
    renderEditor();

    await waitFor(() => expect(screen.getByTestId('listing-form-L-UM')).toBeDefined());
    expect(screen.queryByTestId('listing-form-L-DOIS')).toBeNull();

    await abrirConta('Loja B');
    await waitFor(() => expect(screen.getByTestId('listing-form-L-DOIS')).toBeDefined());
  });

  it('keeps a hidden account registered for the produto save', async () => {
    // The invariant the whole tab strip rests on: an off-screen account's
    // listings stay mounted, so their save closures stay in the flush registry
    // and the produto's "Salvar alterações" still reaches them.
    h.contas = [conta('conta-1', 'Loja A'), conta('conta-2', 'Loja B')];
    h.links = [
      link('L-UM', { id: 'MLB111' }),
      { id: 'L-DOIS', data: linkFixture({ contaOuterRef: 'documents/integracao/conta-2' }) },
    ];
    const flushRef: { current: (() => Promise<void>) | null } = { current: null };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MantineTestProvider>
        <QueryClientProvider client={qc}>
          <MercadoLivreEditor produtoId="prod-1" db={{} as Firestore} flushRef={flushRef} />
        </QueryClientProvider>
      </MantineTestProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('listing-form-L-UM')).toBeDefined());
    await abrirConta('Loja B');
    await waitFor(() => expect(screen.getByTestId('listing-form-L-DOIS')).toBeDefined());
    // Back to the first account: its listing is now the hidden one.
    await abrirConta('Loja A');

    await act(async () => {
      await flushRef.current?.();
    });

    // BOTH saves ran — the wiring reaches an account that is not on screen.
    //
    // ⚠️ This does NOT guard `keepMountedMode`: under `env="test"` Mantine skips
    // `<Activity>` whatever the mode says, so it would pass with the prop
    // deleted. `ContaTabs.persistence.test.tsx` is what pins that, through a
    // bare provider. This pins the other half — that the registry is keyed and
    // enumerated so a hidden account's listings are actually in it.
    expect(h.saves.get('L-UM')).toHaveBeenCalledWith('flush');
    expect(h.saves.get('L-DOIS')).toHaveBeenCalledWith('flush');
  });
});

describe('Excluir anúncio', () => {
  function botaoExcluir(linkDocId: string) {
    return [...screen.getByTestId(`ml-anuncio-${linkDocId}`).querySelectorAll('button')].find(
      (b) => b.textContent === 'Excluir anúncio',
    );
  }

  it('is offered on a listing that never reached Mercado Livre', async () => {
    h.links = [link('L-DRAFT', { id: null, estado: ESTADO_PUBLICACAO_ML.rascunho })];
    renderEditor();
    await waitFor(() => expect(screen.getByTestId('ml-anuncio-L-DRAFT')).toBeDefined());

    expect(botaoExcluir('L-DRAFT')).toBeDefined();
  });

  it('is absent on a PUBLISHED listing', async () => {
    // Removing one would orphan a live anúncio: the status sync would stop
    // resolving it, both sweeps would stop reaching it, and its child
    // variação link docs would dangle. Delisting remotely first is #476.
    h.links = [link('L-PUB', { id: 'MLB777' })];
    renderEditor();
    await waitFor(() => expect(screen.getByTestId('ml-anuncio-L-PUB')).toBeDefined());

    expect(botaoExcluir('L-PUB')).toBeUndefined();
  });

  it("is absent without the produto's delete permission, WITH publish still granted", async () => {
    // ⚠️ The discriminating case, and the only one that proves the claim.
    // Firestore gates a `produtoMercadoLivre` doc by the PARENT produto's
    // permissions, so the control follows the rule that would actually reject
    // the write — a different bit from the one gating publish. Revoking both at
    // once would leave this green even if the control were gated on
    // `integracao.write`, so publish is deliberately left granted: Republicar is
    // asserted enabled, and Excluir absent, in the same render.
    h.permitidos = new Set([PERM.integracao.write]);
    h.links = [link('L-DRAFT', { id: null, estado: ESTADO_PUBLICACAO_ML.rascunho })];
    renderEditor();
    await waitFor(() => expect(screen.getByTestId('ml-anuncio-L-DRAFT')).toBeDefined());

    const bloco = screen.getByTestId('ml-anuncio-L-DRAFT');
    const publicar = [...bloco.querySelectorAll('button')].find(
      (b) => b.textContent === 'Publicar no Mercado Livre',
    );
    expect(publicar).toBeDefined();
    expect(publicar!.disabled).toBe(false);
    expect(botaoExcluir('L-DRAFT')).toBeUndefined();
  });

  it('asks before removing, then removes the listing it was opened for', async () => {
    h.links = [
      link('L-A', { id: null, estado: ESTADO_PUBLICACAO_ML.rascunho }),
      link('L-B', { id: null, estado: ESTADO_PUBLICACAO_ML.rascunho }),
    ];
    renderEditor();
    await waitFor(() => expect(screen.getByTestId('ml-anuncio-L-B')).toBeDefined());

    fireEvent.click(botaoExcluir('L-B')!);
    expect(h.removeListingDraft).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    });
    expect(h.removeListingDraft).toHaveBeenCalledWith(expect.anything(), 'prod-1', 'L-B');
  });

  it("drops the listing's blocked-publish issues with the listing", async () => {
    // ⚠️ The FIRST draft on an account takes the integração id as its doc id, so
    // a recreated draft lands on the same `blockedIssues` key. Without the clear,
    // publicar → 422 → excluir → novo anúncio greets the operator with a red
    // alert from a publish that was never attempted on the new draft.
    h.links = [link('L-DRAFT', { id: null, estado: ESTADO_PUBLICACAO_ML.rascunho })];
    h.client = {
      publicar: vi.fn(async () => {
        throw new MercadoLivreClientHttpError('bloqueado', 422, 'ML_PUBLISH_BLOCKED', [
          'produto sem título',
        ]);
      }),
    };
    renderEditor();
    await waitFor(() => expect(screen.getByTestId('ml-anuncio-L-DRAFT')).toBeDefined());

    const bloco = screen.getByTestId('ml-anuncio-L-DRAFT');
    await act(async () => {
      fireEvent.click(
        [...bloco.querySelectorAll('button')].find(
          (b) => b.textContent === 'Publicar no Mercado Livre',
        )!,
      );
    });
    await waitFor(() => expect(bloco.textContent).toContain('produto sem título'));

    fireEvent.click(botaoExcluir('L-DRAFT')!);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    });

    // The live snapshot has not dropped the doc in this harness, so the block is
    // still on screen — which is what lets us see that the ISSUES went even
    // though the listing's key did not change.
    await waitFor(() =>
      expect(screen.getByTestId('ml-anuncio-L-DRAFT').textContent).not.toContain(
        'produto sem título',
      ),
    );
  });

  it('says so when the listing was published while the confirm was open', async () => {
    // The race the transaction catches. It is reported, not retried: the doc is
    // a live anúncio now and deleting it is no longer the right action.
    h.links = [link('L-DRAFT', { id: null, estado: ESTADO_PUBLICACAO_ML.rascunho })];
    h.removeListingDraft.mockResolvedValueOnce('published' as never);
    renderEditor();
    await waitFor(() => expect(screen.getByTestId('ml-anuncio-L-DRAFT')).toBeDefined());

    fireEvent.click(botaoExcluir('L-DRAFT')!);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    });

    expect(h.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        color: 'yellow',
        message: expect.stringContaining('publicado enquanto você confirmava'),
      }),
    );
  });
});

/**
 * The two entry points into `handleReverificar` want different feedback (#1239).
 * Nothing covered this flow before — the older tests only assert the latch
 * button's GATING — so both branches are pinned here.
 */
describe('reverificar — the reason decides what the operator is told', () => {
  const RESULT = {
    estado: ESTADO_PUBLICACAO_ML.pausado,
    status: 'paused',
    subStatus: [],
    enviavel: false,
  };

  function wireReverificar() {
    const reverificarAnuncio = vi.fn(async () => RESULT);
    h.client = { reverificarAnuncio };
    return reverificarAnuncio;
  }

  it('"Consultar motivo" re-checks the listing and does NOT talk about stock', async () => {
    h.links = [
      link('L-MOD', {
        id: 'MLB1',
        estado: ESTADO_PUBLICACAO_ML.pausado,
        status: 'paused',
        sub_status: ['moderation_penalty'],
        moderacoes: null,
      }),
    ];
    const reverificarAnuncio = wireReverificar();
    renderEditor();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Consultar motivo' }));
    });

    expect(reverificarAnuncio).toHaveBeenCalledWith({
      integracaoId: 'conta-1',
      produtoId: 'prod-1',
      linkDocId: 'L-MOD',
    });
    const shown = h.notify.mock.calls.at(-1)?.[0] as { message: string } | undefined;
    expect(shown?.message).not.toContain('estoque');
  });

  /**
   * ⚠️ The stock wording must survive untouched on its own button. It is correct
   * there and only there — the latch IS about stock.
   */
  it('the latch button keeps its stock wording', async () => {
    h.links = [link('L-LATCH', { id: 'MLB1', estado: ESTADO_PUBLICACAO_ML.erro })];
    wireReverificar();
    renderEditor();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reverificar anúncio' }));
    });

    const shown = h.notify.mock.calls.at(-1)?.[0] as { message: string } | undefined;
    expect(shown?.message).toContain('estoque');
  });
});

/**
 * The per-variation table is rendered by `AnuncioBlock`, so only a test that
 * drives the whole tab proves it is actually WIRED — its own spec renders the
 * component directly and would stay green if nothing ever mounted it.
 */
describe('variações de uma família User-Products (#1142)', () => {
  const membro = (over: Record<string, unknown> = {}) => ({
    itemId: 'MLB-A',
    produtoVariacaoOuterRef: 'documents/produtos/child-1',
    produtoMercadoLivreOuterRef: 'documents/produtos/prod-1/produtoMercadoLivre/L-FAM',
    sku: 'CAM-AZ-M',
    attributes: [{ id: 'COLOR', name: 'Cor', value_name: 'Azul' }],
    status: 'active',
    sub_status: [],
    moderacoes: null,
    ...over,
  });

  it('lists each member under the anúncio it belongs to', async () => {
    h.links = [link('L-FAM', { id: '6264141844942250', isUserProductModel: true })];
    h.membros = [
      { id: 'v1', data: membro() },
      {
        id: 'v2',
        data: membro({
          itemId: 'MLB-B',
          sku: 'CAM-VD-G',
          attributes: [{ id: 'COLOR', name: 'Cor', value_name: 'Verde' }],
          status: 'paused',
        }),
      },
    ];
    renderEditor();

    expect(await screen.findByText('Variações no Mercado Livre')).toBeDefined();
    expect(screen.getByText('Cor: Azul')).toBeDefined();
    expect(screen.getByText('Cor: Verde')).toBeDefined();
  });

  it('shows nothing for a LEGACY listing, whose variations are not listings', async () => {
    h.links = [link('L-LEG', { id: 'MLB1', isUserProductModel: false })];
    h.membros = [{ id: 'v1', data: membro() }];
    renderEditor();

    await waitFor(() => {
      expect(screen.getByTestId('listing-form-L-LEG')).toBeDefined();
    });
    expect(screen.queryByText('Variações no Mercado Livre')).toBeNull();
  });

  it('a família re-check reports HOW MANY variations were re-read', async () => {
    // The title only ever shows the FOLD, so without this the operator cannot
    // tell a família from a simple anúncio — nor that the status above is a
    // summary of several listings.
    h.links = [
      link('L-FAM', {
        id: '6264141844942250',
        isUserProductModel: true,
        estado: ESTADO_PUBLICACAO_ML.erro,
      }),
    ];
    h.client = {
      reverificarAnuncio: vi.fn(async () => ({
        estado: ESTADO_PUBLICACAO_ML.publicado,
        status: 'active',
        subStatus: [],
        enviavel: true,
        membros: [
          {
            itemId: 'MLB-A',
            memberDocId: 'v1',
            lido: true,
            status: 'active',
            subStatus: [],
            enviavel: true,
          },
          {
            itemId: 'MLB-B',
            memberDocId: 'v2',
            lido: false,
            status: null,
            subStatus: null,
            enviavel: false,
          },
        ],
      })),
    };
    renderEditor();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reverificar anúncio' }));
    });

    const shown = h.notify.mock.calls.at(-1)?.[0] as { message: string } | undefined;
    expect(shown?.message).toContain('2 variações reverificadas');
    // ⚠️ A member ML could not answer for keeps its stored status, so a silent
    // partial refresh would read as a complete one.
    expect(shown?.message).toContain('1 não respondeu');
  });

  it('a SIMPLE listing gets no variation preamble', async () => {
    h.links = [link('L-SIMPLES', { id: 'MLB1', estado: ESTADO_PUBLICACAO_ML.erro })];
    h.client = {
      reverificarAnuncio: vi.fn(async () => ({
        estado: ESTADO_PUBLICACAO_ML.publicado,
        status: 'active',
        subStatus: [],
        enviavel: true,
      })),
    };
    renderEditor();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reverificar anúncio' }));
    });

    const shown = h.notify.mock.calls.at(-1)?.[0] as { message: string } | undefined;
    expect(shown?.message).not.toContain('variaç');
  });
});
