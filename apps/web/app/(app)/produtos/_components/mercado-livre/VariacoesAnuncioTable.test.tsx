import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Firestore } from 'firebase/firestore';
import type { VariacaoMercadoLivreLink } from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';

const h = vi.hoisted(() => ({
  membros: [] as Array<{ id: string; data: VariacaoMercadoLivreLink }>,
  /** Every query handed to `useSnapshot`, so a test can assert none was built. */
  queries: [] as unknown[],
  /** A failed read, for the case that must not look like an empty família. */
  erro: null as { message: string } | null,
}));

vi.mock('@delfrance/data', () => ({
  buildQuery: (base: unknown) => base ?? {},
  groupQuery: () => ({ __grupo: 'variacaoMercadoLivre' }),
  limit: () => ({}),
  whereEqual: () => ({}),
}));

vi.mock('@delfrance/data/hooks', () => ({
  useSnapshot: (q: unknown) => {
    h.queries.push(q);
    return {
      data: q == null || h.erro ? undefined : h.membros,
      loading: false,
      error: h.erro,
    };
  },
}));

// Stubbed so the real module's `defineCollection` never runs against the
// `@delfrance/data` mock above.
vi.mock('@/lib/data/variacaoMercadoLivreLinkCollection', () => ({
  variacaoMercadoLivreLinkCollection: { converter: {} },
}));

const { VariacoesAnuncioTable } = await import('./VariacoesAnuncioTable');

/* --------------------------------- fixtures -------------------------------- */

function membro(over: Partial<VariacaoMercadoLivreLink> = {}): VariacaoMercadoLivreLink {
  return {
    id: null,
    itemId: 'MLB111',
    userProductId: null,
    contaOuterRef: null,
    produtoVariacaoOuterRef: 'documents/produtos/child-1',
    produtoMercadoLivreOuterRef: 'documents/produtos/prod-1/produtoMercadoLivre/link-1',
    sku: 'CAM-AZ-M',
    attributes: [{ id: 'COLOR', name: 'Cor', value_name: 'Azul' }],
    status: 'active',
    sub_status: [],
    moderacoes: null,
    ...over,
  } as VariacaoMercadoLivreLink;
}

function renderTable(
  membros: Array<{ id: string; data: VariacaoMercadoLivreLink }>,
  over: {
    isUserProducts?: boolean;
    linkStatus?: string | null;
    linkSubStatus?: string[] | null;
  } = {},
) {
  h.membros = membros;
  render(
    <MantineTestProvider>
      <VariacoesAnuncioTable
        produtoId="prod-1"
        linkDocId="link-1"
        db={{} as Firestore}
        isUserProducts={over.isUserProducts ?? true}
        linkStatus={over.linkStatus ?? null}
        linkSubStatus={over.linkSubStatus ?? null}
      />
    </MantineTestProvider>,
  );
}

beforeEach(() => {
  cleanup();
  h.membros = [];
  h.queries = [];
  h.erro = null;
});

/* ---------------------------------- tests ---------------------------------- */

describe('VariacoesAnuncioTable', () => {
  it('gives each variation its own row, labelled by its ML attributes', () => {
    renderTable([
      { id: 'v1', data: membro({ itemId: 'MLB-A', sku: 'CAM-AZ-M' }) },
      {
        id: 'v2',
        data: membro({
          itemId: 'MLB-B',
          sku: 'CAM-VD-G',
          attributes: [
            { id: 'COLOR', name: 'Cor', value_name: 'Verde' },
            { id: 'SIZE', name: 'Tamanho', value_name: 'G' },
          ],
          status: 'paused',
        }),
      },
    ]);

    expect(screen.getByText('Cor: Azul')).toBeDefined();
    expect(screen.getByText('Cor: Verde · Tamanho: G')).toBeDefined();
    // Each member is its own listing, so each carries its own item id.
    expect(screen.getByText('MLB-A')).toBeDefined();
    expect(screen.getByText('MLB-B')).toBeDefined();
    expect(screen.getByText('Ativo')).toBeDefined();
    expect(screen.getByText('Pausado')).toBeDefined();
  });

  it('⚠️ a never-observed member reads as NOT CONSULTED, never as encerrado', () => {
    // `status: null` means the ERP has no reading, which is the resting state of
    // every member link written before #1142 and of any listing ML has never
    // fired a notification for. Painting it as closed would tell an operator a
    // live variation is dead — the same conflation the server-side fold refuses.
    renderTable([{ id: 'v1', data: membro({ status: null, sub_status: null }) }]);

    expect(screen.getByText('Nunca consultado')).toBeDefined();
    expect(screen.queryByText('Encerrado')).toBeNull();
  });

  it("shows the member's own sub_status beside its status", () => {
    renderTable([{ id: 'v1', data: membro({ status: 'paused', sub_status: ['out_of_stock'] }) }]);

    expect(screen.getByText('Pausado')).toBeDefined();
    expect(screen.getByText('out_of_stock')).toBeDefined();
  });

  it("renders the member's own moderation reason", () => {
    renderTable([
      {
        id: 'v1',
        data: membro({
          status: 'paused',
          sub_status: ['poor_quality_thumbnail'],
          moderacoes: [
            {
              nome: 'POOR_QUALITY_THUMBNAIL',
              dataCriacao: null,
              motivo: 'A foto principal tem baixa qualidade.',
              remedio: 'Envie uma foto com fundo branco.',
              secoes: ['pictures'],
              evidencias: [],
            },
          ],
        }),
      },
    ]);

    expect(screen.getByText(/A foto principal tem baixa qualidade\./)).toBeDefined();
    expect(screen.getByText(/Fotos/)).toBeDefined();
  });

  it('⚠️ distinguishes "ML says there is a reason, nobody fetched it" from "no reason"', () => {
    // `moderacoes == null` is the THIRD state (#1239) — not the same as `[]`,
    // which is ML answering "none". Collapsing them hides a real moderação
    // behind a bare "pausado".
    renderTable([
      {
        id: 'v1',
        data: membro({
          status: 'paused',
          sub_status: ['poor_quality_thumbnail'],
          moderacoes: null,
        }),
      },
    ]);

    expect(screen.getByText(/use Reverificar anúncio para ver o motivo/)).toBeDefined();
  });

  it('⚠️ stays silent when ML WAS asked and reported none, even under a moderation sub_status', () => {
    // The mirror of the case above, and the one that makes the pair mean
    // something. `[]` is ML's answer "no moderation"; `null` is "nobody asked".
    // ⚠️ The sub_status must be one `precisaConsultarModeracao` fires on —
    // otherwise that predicate short-circuits and the assertion holds whether or
    // not the two values are told apart, which is a vacuous test.
    renderTable([
      {
        id: 'v1',
        data: membro({ status: 'paused', sub_status: ['poor_quality_thumbnail'], moderacoes: [] }),
      },
    ]);

    expect(screen.queryByText(/use Reverificar anúncio para ver o motivo/)).toBeNull();
  });

  it('marks the reading the family is reporting, and only that one', () => {
    renderTable(
      [
        { id: 'v1', data: membro({ itemId: 'MLB-A', status: 'active', sub_status: [] }) },
        {
          id: 'v2',
          data: membro({
            itemId: 'MLB-B',
            attributes: [{ id: 'COLOR', name: 'Cor', value_name: 'Verde' }],
            status: 'paused',
            sub_status: ['out_of_stock'],
          }),
        },
      ],
      { linkStatus: 'paused', linkSubStatus: ['out_of_stock'] },
    );

    // The family reports `paused` + `out_of_stock`, which is member B's reading.
    expect(screen.getAllByText('No resumo')).toHaveLength(1);
  });

  it('⚠️ a member with no itemId is not a listing, so it is not a row', () => {
    // The legacy `variations[]` shape leaves `itemId` null: those are rows inside
    // ONE ML item, not listings of their own, and they have no status to show.
    renderTable([
      { id: 'v1', data: membro({ itemId: 'MLB-A' }) },
      { id: 'v2', data: membro({ itemId: null, sku: 'LEGADO' }) },
    ]);

    expect(screen.getByText('MLB-A')).toBeDefined();
    expect(screen.queryByText('LEGADO')).toBeNull();
    expect(screen.getByText(/1 anúncio/)).toBeDefined();
  });

  it('⚠️ a LEGACY listing renders nothing AND builds no query', () => {
    // Rule 1: a collection-group read costs scanned data on Enterprise whether or
    // not anything is rendered from it, so the gate has to sit on the QUERY.
    renderTable([{ id: 'v1', data: membro() }], { isUserProducts: false });

    expect(screen.queryByText('Variações no Mercado Livre')).toBeNull();
    expect(h.queries).toEqual([null]);
  });

  it('renders nothing when the family has no member links yet', () => {
    renderTable([]);

    expect(screen.queryByText('Variações no Mercado Livre')).toBeNull();
  });

  it('⚠️ says so when the member cap is reached, instead of implying completeness', () => {
    // A truncated list that looks complete is worse than no list: an operator
    // would read "every variation is fine" off a page that never showed them all.
    renderTable(
      Array.from({ length: 60 }, (_, i) => ({
        id: `v${String(i)}`,
        data: membro({ itemId: `MLB-${String(i)}`, sku: `SKU-${String(i)}` }),
      })),
    );

    expect(screen.getByText(/Pode haver outras que não aparecem aqui/)).toBeDefined();
  });

  it('⚠️ …and still says so when a FILTERED row drops the visible count below the cap', () => {
    // The state where both hazards compound, and the one the cap test above
    // cannot see: `limit()` bounds the RAW page, the `itemId` filter runs after
    // it. A full page holding one legacy member renders 59 rows — measuring the
    // cap against those 59 goes quiet exactly when the tail was dropped AND
    // something else was dropped too.
    renderTable([
      ...Array.from({ length: 59 }, (_, i) => ({
        id: `v${String(i)}`,
        data: membro({ itemId: `MLB-${String(i)}`, sku: `SKU-${String(i)}` }),
      })),
      { id: 'v-legado', data: membro({ itemId: null, sku: 'LEGADO' }) },
    ]);

    expect(screen.getByText(/Pode haver outras que não aparecem aqui/)).toBeDefined();
  });

  it('⚠️ a FAILED read says so, instead of looking like a família with no variations', () => {
    // Rendering nothing would make a permissions or network failure
    // indistinguishable from the page as it was before this component existed —
    // the exact conflation the rest of this table argues against.
    h.erro = { message: 'Missing or insufficient permissions.' };
    renderTable([{ id: 'v1', data: membro() }]);

    expect(screen.getByText(/Erro ao carregar as variações deste anúncio/)).toBeDefined();
    expect(screen.queryByText('Variações no Mercado Livre')).toBeNull();
  });
});
