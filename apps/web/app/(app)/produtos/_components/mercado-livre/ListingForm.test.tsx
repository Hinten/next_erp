import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Firestore } from 'firebase/firestore';
import type { ProdutoMercadoLivreLink } from '@delfrance/schemas';

import { linkFixture } from '@/lib/mercado-livre/linkFixture';
import { MercadoLivreClientNetworkError } from '@/lib/mercado-livre/client';

const h = vi.hoisted(() => ({
  /** Every patch a save handed to the port, in order. */
  writes: [] as Array<Record<string, unknown>>,
  /** What the transaction re-read sees; swap per test to simulate a racer. */
  remote: null as ProdutoMercadoLivreLink | null,
  /**
   * The ML client. `null` by default so the existing tests keep running without
   * a backend (the attributes query is gated on it) — the test-data tests set it.
   */
  client: null as Record<string, unknown> | null,
}));

vi.mock('@/lib/mercado-livre/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/mercado-livre/client')>();
  return { ...actual, useMercadoLivreClient: () => h.client };
});

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

/** A produto with every dimension filled — the default, so a test that does not
 * care about the package block never has to think about it. Whole numbers, so
 * the rounding is not what any assertion here is measuring. */
const MEDIDAS = {
  alturaCm: 5,
  larguraCm: 10,
  profundidadeCm: 10,
  pesoBrutoKg: 1,
  pesoLiquidoKg: 0.9,
};

function renderForm(
  over: Partial<ProdutoMercadoLivreLink> = {},
  props: Record<string, unknown> = {},
) {
  const onDirtyChange = vi.fn();
  const onLoadingChange = vi.fn();
  const registerFlush = vi.fn();
  const link = linkFixture(over);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MantineTestProvider>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MantineTestProvider>
  );
  const node = (l: ProdutoMercadoLivreLink) => (
    <ListingForm
      produtoId="prod-1"
      linkDocId="ML-DOC-1"
      integracaoId="conta-1"
      produtoNome="Camiseta Básica"
      produtoEhUsado={false}
      produtoCondicao={null}
      produtoMedidas={MEDIDAS}
      link={l}
      db={{} as Firestore}
      canWrite
      onDirtyChange={onDirtyChange}
      onLoadingChange={onLoadingChange}
      registerFlush={registerFlush}
      {...props}
    />
  );
  const { rerender, unmount } = render(node(link), { wrapper });
  /** Re-render with a NEW link, the way a live snapshot update arrives. */
  const update = (next: Partial<ProdutoMercadoLivreLink>) =>
    rerender(node(linkFixture({ ...over, ...next })));
  return { onDirtyChange, onLoadingChange, registerFlush, link, update, unmount };
}

function type(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/**
 * Drive the save the way `MercadoLivreEditor` does now.
 *
 * "Salvar anúncio" moved out of this component into the editor's action group
 * (beside Publicar), so the save is reached through the closure this form
 * registers rather than through a button in its own subtree. The save LOGIC is
 * unchanged — only its trigger moved — so these tests invoke the closure.
 */
async function save(registerFlush: ReturnType<typeof vi.fn>, mode: 'button' | 'flush' = 'button') {
  const calls = registerFlush.mock.calls.filter((c) => typeof c[1] === 'function');
  const fn = calls.at(-1)![1] as (m: 'button' | 'flush') => Promise<void>;
  await act(async () => {
    await fn(mode);
  });
}

beforeEach(() => {
  h.client = null;
  h.writes = [];
  h.remote = linkFixture();
});

describe('ListingForm — server errors', () => {
  it('shows a Mercado Livre rejection ON the control it names', () => {
    // The whole point of #1109: `ML 400: Validation error` in a banner told the
    // operator nothing about WHICH field ML refused.
    renderForm(
      { id: null },
      { serverErrors: { title: ['You should include more main features in the title.'] } },
    );
    expect(screen.getByText('You should include more main features in the title.')).toBeDefined();
  });

  it('renders on the categoria and tipo controls too', () => {
    renderForm(
      { id: null },
      {
        serverErrors: {
          category_id: ['Is not allowed to post in category MLB1234.'],
          listing_type_id: ['Tipo indisponível.'],
        },
      },
    );
    expect(screen.getByText('Is not allowed to post in category MLB1234.')).toBeDefined();
    expect(screen.getByText('Tipo indisponível.')).toBeDefined();
  });

  it('leaves the controls clean when the server has nothing to say', () => {
    renderForm({ id: null });
    expect(screen.queryByText(/You should include/)).toBeNull();
  });

  it('is DISPLAYED, not pushed into form state — survives editing and re-render', () => {
    // Deliberately not `form.setError`: a manual RHF error is wiped by the next
    // resolver run, so it would vanish on an unrelated blur while ML still
    // rejects the listing. Typing here re-renders without touching the prop.
    const { update } = renderForm({ id: null }, { serverErrors: { title: ['ML recusou'] } });
    type('Título do anúncio', 'Outro título bem mais descritivo');
    expect(screen.getByText('ML recusou')).toBeDefined();
    // Nor does a re-render of the LINK drop it: `serverErrors` is its own prop,
    // derived from `causas`. What clears the message is the next publish
    // stamping fresh `causas` — which is a change to THIS prop, not to the link
    // fixture, and is covered by the `splitCausas` tests rather than here.
    update({ id: null });
    expect(screen.getByText('ML recusou')).toBeDefined();
  });
});

/**
 * The editor's write actions are held until every listing reports its category
 * attributes settled. The grid is EMPTY, not absent, while that query is in
 * flight, so a half-loaded form looks complete and a publish fired from it sends
 * attributes nobody saw.
 */
describe('ListingForm — reports its attribute loading upward', () => {
  const ATTR = { id: 'BRAND', name: 'Marca', required: false, valueType: 'string', values: [] };

  const lastReport = (spy: ReturnType<typeof vi.fn>): boolean | undefined =>
    spy.mock.calls.at(-1)?.[1] as boolean | undefined;

  it('reports true while the query is in flight, then false once it lands', async () => {
    let resolver: (v: unknown) => void = () => {};
    h.client = {
      categoriaAtributos: vi.fn(
        () =>
          new Promise((res) => {
            resolver = res;
          }),
      ),
    };
    const { onLoadingChange } = renderForm({ category_id: 'MLB31447' });

    await waitFor(() => expect(lastReport(onLoadingChange)).toBe(true));
    expect(onLoadingChange).toHaveBeenCalledWith('ML-DOC-1', true);

    // The gate must RELEASE — a signal that never clears is a dead button.
    await act(async () => {
      resolver({ leaf: true, atributos: [ATTR], omitidos: [] });
    });
    await waitFor(() => expect(lastReport(onLoadingChange)).toBe(false));
  });

  /**
   * ⚠️ The two states a naive `isPending` gets wrong. TanStack v5 parks a
   * DISABLED query at `isPending: true` forever, so reporting that would leave
   * every write action dead for the whole session.
   */
  it('reports false when no category is chosen — the query never runs', async () => {
    h.client = { categoriaAtributos: vi.fn() };
    const { onLoadingChange } = renderForm({ category_id: null });
    await waitFor(() => expect(onLoadingChange).toHaveBeenCalled());
    expect(lastReport(onLoadingChange)).toBe(false);
  });

  it('reports false with no client — an unauthenticated session is not loading', async () => {
    // `h.client` stays null (the harness default), which disables the query
    // exactly as an unresolved auth session does.
    const { onLoadingChange } = renderForm({ category_id: 'MLB31447' });
    await waitFor(() => expect(onLoadingChange).toHaveBeenCalled());
    expect(lastReport(onLoadingChange)).toBe(false);
  });

  it('reports false when the metadata call FAILS', async () => {
    // A failed lookup must not block publishing: AtributosSection's own copy
    // promises the stored attributes survive it.
    h.client = { categoriaAtributos: vi.fn(async () => Promise.reject(new Error('boom'))) };
    const { onLoadingChange } = renderForm({ category_id: 'MLB31447' });
    await waitFor(() => expect(lastReport(onLoadingChange)).toBe(false));
  });

  it('clears its id on unmount, so a removed listing cannot wedge the gate shut', async () => {
    h.client = {
      categoriaAtributos: vi.fn(
        () =>
          new Promise(() => {
            /* never settles */
          }),
      ),
    };
    const { onLoadingChange, unmount } = renderForm({ category_id: 'MLB31447' });
    await waitFor(() => expect(lastReport(onLoadingChange)).toBe(true));

    unmount();
    expect(onLoadingChange).toHaveBeenLastCalledWith('ML-DOC-1', false);
  });
});

describe('ListingForm — server errors on the attribute grid', () => {
  function setAttrClient(atributos: unknown[]) {
    h.client = {
      categoriaAtributos: vi.fn(async () => ({ leaf: true, atributos, omitidos: [] })),
    };
  }

  it('marks the attribute row ML named, reusing the existing per-row channel', async () => {
    setAttrClient([
      { id: 'BRAND', name: 'Marca', required: false, valueType: 'string', values: [] },
    ]);
    renderForm(
      { id: null, category_id: 'MLB31447' },
      { serverErrors: { 'attributes.BRAND': ['The attributes [BRAND] are required.'] } },
    );
    await waitFor(() => {
      expect(screen.getByText('The attributes [BRAND] are required.')).toBeDefined();
    });
  });

  it('lets local validation win over a stale server message on the same row', async () => {
    // A required row the operator has since emptied: what is wrong NOW beats
    // what ML said about the previous attempt.
    setAttrClient([
      { id: 'BRAND', name: 'Marca', required: true, valueType: 'string', values: [] },
    ]);
    renderForm(
      { id: null, category_id: 'MLB31447', attributes: [] },
      { serverErrors: { 'attributes.BRAND': ['mensagem antiga do ML'] } },
    );
    await waitFor(() => {
      expect(screen.getByText('Este campo é obrigatório')).toBeDefined();
    });
    expect(screen.queryByText('mensagem antiga do ML')).toBeNull();
  });
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

  it('renders NO save button of its own — the editor owns it', () => {
    // "Salvar anúncio" moved beside "Publicar no Mercado Livre" in
    // `MercadoLivreEditor`, which gates it on `dirtyIds` (attribute edits
    // included). A second button here would be a second, RHF-only gate.
    renderForm();
    expect(screen.queryByRole('button', { name: /Salvar anúncio/ })).toBeNull();
  });

  it('registers a save the editor can invoke in either mode', () => {
    const { registerFlush } = renderForm();
    expect(registerFlush).toHaveBeenCalledWith('ML-DOC-1', expect.any(Function));
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
    const { registerFlush } = renderForm({ title: 'Camiseta Básica' });
    type('Título do anúncio', 'Camiseta Premium');
    await save(registerFlush);

    await waitFor(() => {
      expect(h.writes).toHaveLength(1);
    });
    expect(h.writes[0]).toEqual({
      title: 'Camiseta Premium',
      ultimaModificacao: expect.any(Number),
    });
  });

  it('never writes a server-owned key', async () => {
    const { registerFlush } = renderForm();
    type('Título do anúncio', 'Novo');
    await save(registerFlush);

    await waitFor(() => {
      expect(h.writes).toHaveLength(1);
    });
    for (const key of ['estado', 'status', 'precoPublicado', 'comissao', 'isUserProductModel']) {
      expect(h.writes[0]).not.toHaveProperty(key);
    }
  });

  it('refuses to save a blank title', async () => {
    const { registerFlush } = renderForm();
    type('Título do anúncio', '   ');
    await save(registerFlush);

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
    const { registerFlush } = renderForm({ title: 'Original' });
    type('Título do anúncio', 'Meu texto');
    await save(registerFlush);

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

describe('Dimensões e peso come from the produto', () => {
  it('renders the package AND the net weight publish will send, read-only', () => {
    // Five attributes leave on every publish rebuilt from the produto — the four
    // SELLER_PACKAGE_* plus WEIGHT — which is why the category grid never offers
    // them as inputs. Showing them is what stops that filtering reading as five
    // missing fields.
    renderForm();
    expect(screen.getByText('5 × 10 × 10 cm · 1000 g')).toBeDefined();
    expect(screen.getByText('Peso líquido 0,9 kg')).toBeDefined();
    expect(screen.getByText(/Dimensões e peso do produto/)).toBeDefined();
  });

  // ⚠️ THE regression a reviewer caught on the first cut of this PR. `WEIGHT` is
  // withheld from the grid, pruned from the link doc and dropped from
  // `link.attributes` on every publish — but it is only re-derived from
  // `pesoLiquidoKg`, which the GROSS weight does not stand in for. With the
  // missing-field check keyed on `pesoBrutoKg ?? pesoLiquidoKg` this produto
  // looked complete: a reassuring package, no warning, and `WEIGHT` silently
  // gone from every publish with its stored copy already pruned.
  it('warns when only the GROSS weight is filled — WEIGHT has no fallback', () => {
    renderForm(
      {},
      {
        produtoMedidas: {
          alturaCm: 5,
          larguraCm: 10,
          profundidadeCm: 10,
          pesoBrutoKg: 1,
          pesoLiquidoKg: null,
        },
      },
    );
    // The package still resolves on the gross weight, and still shows.
    expect(screen.getByText('5 × 10 × 10 cm · 1000 g')).toBeDefined();
    // ...but the net weight does not, and the screen says so.
    expect(screen.getByText('Falta preencher: Peso líquido')).toBeDefined();
    expect(screen.getByText('Peso líquido —')).toBeDefined();
  });

  it('a net weight with no gross weight is complete — no warning', () => {
    renderForm(
      {},
      {
        produtoMedidas: {
          alturaCm: 5,
          larguraCm: 10,
          profundidadeCm: 10,
          pesoBrutoKg: null,
          pesoLiquidoKg: 2,
        },
      },
    );
    expect(screen.queryByText(/Falta preencher/)).toBeNull();
    expect(screen.getByText('Peso líquido 2 kg')).toBeDefined();
    // The package weighs the net value when there is no gross one.
    expect(screen.getByText('5 × 10 × 10 cm · 2000 g')).toBeDefined();
  });

  // ⚠️ THE display↔payload assertion. ML accepts only whole cm/g, so a produto
  // measured 5.5 publishes 6 — a screen printing "5,5" would describe a payload
  // that does not exist. Same trap `CondicaoField` documents.
  it('shows the ROUNDED values, not the raw produto fields', () => {
    renderForm(
      {},
      {
        produtoMedidas: {
          alturaCm: 5.5,
          larguraCm: 10.01,
          profundidadeCm: 30,
          pesoBrutoKg: 0.2504,
          pesoLiquidoKg: null,
        },
      },
    );
    expect(screen.getByText('6 × 11 × 30 cm · 250 g')).toBeDefined();
    expect(screen.queryByText(/5,5|5\.5/)).toBeNull();
  });

  // ML requires all four package attributes for ME2 cross docking and does NOT
  // tag them `required` in its per-category attributes, so nothing else on this
  // screen can warn — and publish omits all four when one is missing rather
  // than sending three.
  it('names every empty produto field instead of failing silently at ML', () => {
    renderForm(
      {},
      {
        produtoMedidas: {
          alturaCm: 5,
          larguraCm: null,
          profundidadeCm: null,
          pesoBrutoKg: 1,
          pesoLiquidoKg: null,
        },
      },
    );
    expect(screen.getByText('Falta preencher: Peso líquido, Largura e Profundidade')).toBeDefined();
    expect(screen.getByText(/Preencha na aba Dimensões e peso/)).toBeDefined();
  });

  // ⚠️ `null` is "the produto snapshot has not landed", not "the produto is
  // empty". Collapsing the two flashes the warning on every open — the bug
  // `produtoFotoCount` avoids by staying null while loading.
  it('stays quiet while the produto snapshot is still loading', () => {
    renderForm({}, { produtoMedidas: null });
    expect(screen.queryByText(/Falta preencher/)).toBeNull();
  });
});

describe('Condição comes from the produto', () => {
  it('renders the produto value read-only, with no editable control', () => {
    // Whether a product is used is a fact about the PRODUCT, not about one of
    // its listings — two editable copies could only disagree.
    renderForm({}, { produtoEhUsado: true });
    expect(screen.getByText('Usado')).toBeDefined();
    expect(screen.queryByRole('combobox', { name: 'Condição' })).toBeNull();
  });

  it('follows the produto flag', () => {
    renderForm({}, { produtoEhUsado: false });
    expect(screen.getByText('Novo')).toBeDefined();
  });

  it('warns on a PUBLISHED listing that ML fixes condition at creation', async () => {
    // ⚠️ The honest part. `condition` is create-only in `buildItemPayload`, so
    // flipping "Produto usado" now changes what a FUTURE publish would send and
    // nothing at Mercado Livre. Without this note the operator flips the switch,
    // watches this field change, and reasonably assumes it propagated.
    renderForm({ id: 'MLB777' }, { produtoEhUsado: true });
    expect(screen.getByText(/fixa a condição na criação/i)).toBeDefined();
  });

  it('says where to change it on a listing that is not published yet', () => {
    renderForm({ id: null }, { produtoEhUsado: false });
    expect(screen.getByText(/Produto usado/)).toBeDefined();
  });

  // ⚠️ THE display↔payload bug. `resolveCondicaoAnuncio` reads THREE inputs and
  // this field used to mirror only `ehUsado`, so a produto marked
  // **Recondicionado** in Dados extras rendered "Novo" here while the first
  // publish sent `used`. Same two-copies-that-disagree failure this field was
  // introduced to remove, just moved to where one side is a screen.
  it('shows Usado for a produto marked recondicionado in Dados extras', () => {
    renderForm({ id: null }, { produtoEhUsado: false, produtoCondicao: 3 });
    expect(screen.getByText('Usado')).toBeDefined();
  });

  it('names Dados extras when that is the field that decided', () => {
    // Pointing at "Produto usado" would send the operator to a switch that is
    // already off and cannot explain what they see.
    renderForm({ id: null }, { produtoEhUsado: false, produtoCondicao: 2 });
    expect(screen.getByText(/Dados extras/)).toBeDefined();
  });

  it('leaves novo to the next tier rather than deciding', () => {
    // 1 is the schema DEFAULT — treating it as an answer would make the stored
    // listing condition unreachable for every produto that never set it.
    renderForm({ id: null, condition: 'used' }, { produtoEhUsado: false, produtoCondicao: 1 });
    expect(screen.getByText('Usado')).toBeDefined();
  });

  it('never writes condition, even though the doc still holds one', async () => {
    const { registerFlush } = renderForm({ title: 'Antigo', condition: 'used' });
    type('Título do anúncio', 'Novo título');
    await save(registerFlush);

    await waitFor(() => {
      expect(h.writes).toHaveLength(1);
    });
    expect(h.writes[0]).not.toHaveProperty('condition');
  });
});

describe('Descrição is collapsed until it has something to show', () => {
  it('starts collapsed when the listing has no descrição', () => {
    renderForm({ descricao: null });
    expect(screen.getByTestId('ml-descricao-wrapper').dataset.open).toBe('false');
  });

  it('starts OPEN when the listing already has one', () => {
    // A hidden non-empty field is a field nobody remembers to check.
    renderForm({ descricao: 'Texto existente' });
    expect(screen.getByTestId('ml-descricao-wrapper').dataset.open).toBe('true');
  });

  it('opens on click', async () => {
    renderForm({ descricao: null });
    fireEvent.click(screen.getByRole('button', { name: /Descrição do anúncio/ }));
    await waitFor(() => {
      expect(screen.getByTestId('ml-descricao-wrapper').dataset.open).toBe('true');
    });
  });

  it('OPENS when a descrição arrives from the snapshot on a clean form', async () => {
    // ⚠️ The hole a once-only seed left. The reset effect re-seeds the whole
    // form from the live snapshot whenever nothing is pending, so a descrição
    // written by a second tab, a colleague, or an import filled a textarea that
    // stayed `display: none`. Nothing is lost (`buildListingPatch` writes only
    // dirty keys) but "a hidden non-empty field is one nobody remembers to
    // check" is the whole point of the disclosure — and this app is never the
    // only writer (root CLAUDE.md rule 7).
    const { update } = renderForm({ descricao: null });
    expect(screen.getByTestId('ml-descricao-wrapper').dataset.open).toBe('false');

    update({ descricao: 'Texto que chegou do servidor' });
    await waitFor(() => {
      expect(screen.getByTestId('ml-descricao-wrapper').dataset.open).toBe('true');
    });
  });

  it('does NOT re-open under someone who collapsed it mid-edit', async () => {
    // The re-open is gated on the same `isDirty` edge as the reset effect, so a
    // snapshot cannot yank the disclosure open while the operator is typing.
    const { update } = renderForm({ descricao: 'Texto existente' });
    fireEvent.click(screen.getByRole('button', { name: /Ocultar descrição/ }));
    type('Título do anúncio', 'Editando agora');
    await waitFor(() => {
      expect(screen.getByTestId('ml-descricao-wrapper').dataset.open).toBe('false');
    });

    update({ descricao: 'Outro texto remoto' });
    await waitFor(() => {
      expect(screen.getByTestId('ml-descricao-wrapper').dataset.open).toBe('false');
    });
  });

  it('stays open while the operator clears the text they are editing', async () => {
    // The open state is seeded ONCE. Deriving it from the current value would
    // collapse the field the instant it was emptied — mid-edit.
    renderForm({ descricao: 'Texto existente' });
    type('Descrição', '');
    await waitFor(() => {
      expect(screen.getByTestId('ml-descricao-wrapper').dataset.open).toBe('true');
    });
  });

  it('KEEPS the typed text when collapsed again, and still saves it', async () => {
    // ⚠️ The reason the field is hidden with CSS rather than unmounted: an
    // unmounted `Controller` is one RHF `shouldUnregister` default away from
    // silently discarding what the operator wrote.
    const { registerFlush } = renderForm({ descricao: null });
    fireEvent.click(screen.getByRole('button', { name: /Descrição do anúncio/ }));
    type('Descrição', 'Texto novo');
    fireEvent.click(screen.getByRole('button', { name: /Ocultar descrição/ }));
    await save(registerFlush);

    await waitFor(() => {
      expect(h.writes).toHaveLength(1);
    });
    expect(h.writes[0]).toMatchObject({ descricao: 'Texto novo' });
  });
});

describe('Preencher com dados de teste', () => {
  // ⚠️ The button ships in DEVELOPMENT builds only — publishing a test listing
  // creates a real listing on the real marketplace. Under vitest `NODE_ENV` is
  // `'test'`, so without this every assertion below would fail on a button that
  // is correctly absent. `vi.stubEnv` works only because the component reads
  // `process.env.NODE_ENV` inline rather than into a module-level const.
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function setClient(over: Partial<Record<string, unknown>> = {}) {
    h.client = {
      categoriaAtributos: vi.fn(async () => ({ leaf: true, atributos: [], omitidos: [] })),
      anuncioTeste: vi.fn(async () => ({
        title: 'Item de Teste – Por favor, NÃO OFERTAR!',
        descricao: 'Anúncio de teste.',
        categoryId: 'MLB5672',
        categoriaPath: ['Outros', 'Outros'],
        categoriaMotivo: null,
        listingTypeId: 'free',
        conta: { nickname: 'TEST0548', ehContaDeTeste: true },
      })),
      ...over,
    };
  }

  it('fills the form with ML’s documented test data without saving anything', async () => {
    // Pre-fill only. #799's rule is that things are OFFERED, not applied, and a
    // button that published straight to a live marketplace would be the sharpest
    // possible violation of it.
    setClient();
    renderForm({ id: null, title: 'Camiseta' });
    fireEvent.click(screen.getByRole('button', { name: /dados de teste/i }));

    await waitFor(() => {
      expect(screen.getByLabelText('Título do anúncio')).toHaveProperty(
        'value',
        'Item de Teste – Por favor, NÃO OFERTAR!',
      );
    });
    expect(h.writes).toHaveLength(0);
  });

  it('WARNS when the target is not a test account', async () => {
    // ⚠️ The point of the feature. ML has no sandbox, so this creates a real
    // listing on a real marketplace, and ML's docs forbid test listings on a
    // real seller account.
    setClient({
      anuncioTeste: vi.fn(async () => ({
        title: 'Item de Teste – Por favor, NÃO OFERTAR!',
        descricao: 'Anúncio de teste.',
        categoryId: 'MLB5672',
        listingTypeId: 'free',
        conta: { nickname: 'VESTEFRANCE', ehContaDeTeste: false },
      })),
    });
    renderForm({ id: null });
    fireEvent.click(screen.getByRole('button', { name: /dados de teste/i }));

    await waitFor(() => {
      expect(screen.getByText(/não é uma conta de teste/i)).toBeDefined();
    });
    expect(screen.getByText(/VESTEFRANCE/)).toBeDefined();
    expect(screen.getByText(/usuário de teste/i)).toBeDefined();
  });

  it('stays quiet about the account when it IS a test user', async () => {
    setClient();
    renderForm({ id: null });
    fireEvent.click(screen.getByRole('button', { name: /dados de teste/i }));

    await waitFor(() => {
      expect(screen.getByText('Dados de teste preenchidos')).toBeDefined();
    });
    expect(screen.queryByText(/não é uma conta de teste/i)).toBeNull();
  });

  it('says so when the category could not be resolved, instead of guessing one', async () => {
    // A hardcoded "Outros" id would file a test listing into a real category.
    setClient({
      anuncioTeste: vi.fn(async () => ({
        title: 'Item de Teste – Por favor, NÃO OFERTAR!',
        descricao: 'Anúncio de teste.',
        categoryId: null,
        categoriaPath: null,
        // ⚠️ The case that actually happened: MLB has no root named "Outros".
        categoriaMotivo: 'sem-raiz',
        listingTypeId: null,
        conta: { nickname: 'TEST1', ehContaDeTeste: true },
      })),
    });
    renderForm({ id: null });
    fireEvent.click(screen.getByRole('button', { name: /dados de teste/i }));

    await waitFor(() => {
      // ⚠️ Asserts it reads as ABNORMAL, not as a routine "pick one yourself".
      // The only way we learn ML renamed the tree is someone noticing this line
      // and the matching `console.error` — a neutral message gets shrugged at.
      expect(screen.getByText(/árvore de categorias mudou/i)).toBeDefined();
    });
    // ⚠️ And NOT the listing-type message. The route never queries types without
    // a category, so `listingTypeId` is null here for a reason that has nothing
    // to do with the types available — telling the operator "nenhum tipo nesta
    // categoria" about a category that was never resolved blames the wrong
    // field, right beside the message naming the real one.
    expect(screen.queryByText(/evite Premium/i)).toBeNull();
  });

  it('warns about the listing type only once a category DID resolve', async () => {
    setClient({
      anuncioTeste: vi.fn(async () => ({
        title: 'Item de Teste – Por favor, NÃO OFERTAR!',
        descricao: 'Anúncio de teste.',
        categoryId: 'MLB5672',
        listingTypeId: null,
        conta: { nickname: 'TEST1', ehContaDeTeste: true },
      })),
    });
    renderForm({ id: null });
    fireEvent.click(screen.getByRole('button', { name: /dados de teste/i }));

    await waitFor(() => {
      expect(screen.getByText(/evite Premium/i)).toBeDefined();
    });
    expect(screen.queryByText(/categoria “Outros” automaticamente/i)).toBeNull();
  });

  it('is not offered on a listing that is already published', async () => {
    // Nothing to pre-fill: the listing exists at ML, and title/condition are
    // already fixed there.
    setClient();
    renderForm({ id: 'MLB777' });
    expect(screen.queryByRole('button', { name: /dados de teste/i })).toBeNull();
  });

  it('is not offered without write permission', async () => {
    setClient();
    renderForm({ id: null }, { canWrite: false });
    expect(screen.queryByRole('button', { name: /dados de teste/i })).toBeNull();
  });

  it('does NOT ship in a production build', async () => {
    // ⚠️ The gate that matters. ML has no sandbox, so publishing a test listing
    // creates a REAL listing on the real marketplace — the affordance has no
    // business existing in a deployed app. `NODE_ENV` is a build-time constant,
    // so the branch is stripped rather than merely hidden.
    vi.stubEnv('NODE_ENV', 'production');
    setClient();
    renderForm({ id: null });
    expect(screen.queryByRole('button', { name: /dados de teste/i })).toBeNull();
  });

  it('MOVES the category and reloads the attributes on an existing draft', async () => {
    // ⚠️ Lucas's exact report: a produto with a draft listing that ALREADY has a
    // category. The whole point of the fix is that the field moves off it and
    // the attribute grid re-queries for the new one — and until now nothing
    // asserted either, so the client half of this path was untested.
    //
    // The attributes query key is `['ml','atributos',integracaoId,categoryId]`,
    // so a re-fetch with the new id IS the grid reloading.
    setClient();
    const atributos = h.client!.categoriaAtributos as ReturnType<typeof vi.fn>;
    // The fixture's category is MLB31447; the fill answers MLB5672.
    renderForm({ id: null, category_id: 'MLB31447' });

    await waitFor(() => {
      expect(atributos).toHaveBeenCalledWith(expect.objectContaining({ categoryId: 'MLB31447' }));
    });

    fireEvent.click(screen.getByRole('button', { name: /dados de teste/i }));

    await waitFor(() => {
      expect(atributos).toHaveBeenCalledWith(expect.objectContaining({ categoryId: 'MLB5672' }));
    });
  });

  it('names the category it actually chose', async () => {
    // The field shows a bare `MLB…` id until the path resolves, and which leaf
    // under "Outros" the route landed on is not guessable from it.
    setClient();
    renderForm({ id: null });
    fireEvent.click(screen.getByRole('button', { name: /dados de teste/i }));

    await waitFor(() => {
      expect(screen.getByText(/Categoria definida/)).toBeDefined();
    });
    expect(screen.getByText('Outros › Outros')).toBeDefined();
  });

  it('does not leave a stale success alert above a FAILED fill', async () => {
    // ⚠️ The half a close button cannot fix. `preencherTeste`'s catch reports its
    // failure as a toast and returns without touching `testeConta`, so the
    // previous run's "Dados de teste preenchidos" — naming a `Categoria definida`
    // that was never applied — survived on screen above a fill that did not
    // happen. Clearing at the START of every run makes the alert strictly a
    // report of the LATEST run.
    const anuncioTeste = vi
      .fn()
      .mockResolvedValueOnce({
        title: 'Item de Teste – Por favor, NÃO OFERTAR!',
        descricao: 'Anúncio de teste.',
        categoryId: 'MLB5672',
        categoriaPath: ['Outros', 'Outros'],
        listingTypeId: 'free',
        conta: { nickname: 'TEST0548', ehContaDeTeste: true },
      })
      .mockRejectedValueOnce(new MercadoLivreClientNetworkError('sem rede'));
    setClient({ anuncioTeste });
    renderForm({ id: null });

    fireEvent.click(screen.getByRole('button', { name: /dados de teste/i }));
    await waitFor(() => {
      expect(screen.getByText('Dados de teste preenchidos')).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: /dados de teste/i }));
    await waitFor(() => {
      expect(screen.queryByText('Dados de teste preenchidos')).toBeNull();
    });
    expect(screen.queryByText(/Categoria definida/)).toBeNull();
  });

  it('can be dismissed, and stays dismissed', async () => {
    // ⚠️ `setTesteConta` was only ever called on success and never reset, so the
    // alert outlived even a later FAILED click — leaving a stale "preenchidos"
    // banner above a fill that did not happen.
    setClient();
    renderForm({ id: null });
    fireEvent.click(screen.getByRole('button', { name: /dados de teste/i }));

    await waitFor(() => {
      expect(screen.getByText('Dados de teste preenchidos')).toBeDefined();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Fechar aviso' }));
    await waitFor(() => {
      expect(screen.queryByText('Dados de teste preenchidos')).toBeNull();
    });
  });
});
