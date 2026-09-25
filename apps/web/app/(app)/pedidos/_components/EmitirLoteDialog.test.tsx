/**
 * `EmitirLoteDialog` — the cStat 805 guidance under a lote row (#852).
 *
 * The modal is where a sync single-member chunk's 805 lands, with the NF
 * column's HoverCard unreachable behind it, so the row itself must explain the
 * rejection. Offline: the NF-e client, Firebase and the rejection-context loader
 * are mocked; the loader's own reads are proved in `lib/nfe/contextoRejeicao.test.ts`.
 *
 * ⚠️ The QueryClient carries the APP's defaults (`QUERY_DEFAULT_OPTIONS`:
 * staleTime 30 s, retry 1), never test-friendly ones — the row's own
 * `staleTime: 0` / `gcTime: 0` / `retry: false` are only proved load-bearing
 * against the defaults they override.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { NFeBatchEmitResult } from '@delfrance/integrations-nfe/http-provider';
import { ESTADO_NFE, IE_SENTINELA, TIPO_CLIENTE } from '@delfrance/schemas';

import type { ContextoRejeicaoNFe } from '@/lib/nfe/errors';
import { QUERY_DEFAULT_OPTIONS } from '@/lib/query/QueryProvider';
import { MantineTestProvider } from '@/lib/testing/mantine';

const h = vi.hoisted(() => {
  const emitirLote = vi.fn();
  return {
    // ONE client object: the dialog's effect depends on the client's identity,
    // so a fresh object per render would re-fire the lote forever.
    client: { emitirLote },
    emitirLote,
    carregador: vi.fn(),
    loader: vi.fn(),
    db: { __db: true },
  };
});

vi.mock('@/lib/nfe/client', () => ({ useNFeClient: () => h.client }));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => h.db }));
vi.mock('@/lib/nfe/contextoRejeicao', () => ({
  carregadorContextoRejeicao: (db: unknown) => {
    h.carregador(db);
    return h.loader;
  },
}));

import { EmitirLoteDialog } from './EmitirLoteDialog';

const XMOTIVO_805 =
  'Rejeição: A SEFAZ do destinatário não permite Contribuinte Isento de Inscrição Estadual';
const XMOTIVO_226 = 'Rejeição: Código da UF do Emitente diverge da UF autorizadora';
const CHAVE = '35260911222333000181550010000000011000000010';
const PEDIDO_IDS: ReadonlyArray<string> = ['p1', 'p2', 'p3'];

const REJEITADA_805 = {
  nfeId: 'n1',
  pedidoId: 'p1',
  estado: ESTADO_NFE.rejeitada,
  chave: CHAVE,
  nRec: null,
  cStat: '805',
  xMotivo: XMOTIVO_805,
} satisfies NFeBatchEmitResult['results'][number];

const RESULTADO: NFeBatchEmitResult = {
  results: [
    REJEITADA_805,
    {
      nfeId: 'n2',
      pedidoId: 'p2',
      estado: ESTADO_NFE.rejeitada,
      chave: CHAVE,
      nRec: null,
      cStat: '226',
      xMotivo: XMOTIVO_226,
    },
    { pedidoId: 'p3', errorCode: 'EMIT_FAILED', errorMessage: 'Falha ao montar o XML' },
  ],
};

/** What the loader finds: the XML sent the cliente as Isento; the cadastro still says so. */
const CONTEXTO: ContextoRejeicaoNFe = {
  destinatario: { idDest: '1', indIEDest: '2', uf: 'SP' },
  cliente: {
    id: 'cli-1',
    cadastro: { nome: 'ACME LTDA', tipo: TIPO_CLIENTE.pessoaJuridica, ie: IE_SENTINELA.isento },
  },
};

/** The same rejection, after the operator fixed the cadastro (a real IE). */
const CONTEXTO_ALTERADO: ContextoRejeicaoNFe = {
  destinatario: CONTEXTO.destinatario,
  cliente: {
    id: 'cli-1',
    cadastro: { nome: 'ACME LTDA', tipo: TIPO_CLIENTE.pessoaJuridica, ie: '123456789' },
  },
};

const GUIDANCE = /foi enviada com o cliente ACME LTDA/;
/** The `corrigirCadastro` text — the cadastro still declares ISENTO. */
const CORRIGIR = /Corrija o cadastro/;
/** The `reemitir` text ("Cadastro do cliente já alterado") — the row renders the texto, not the título. */
const REEMITIR = /já não está como Isento: emita a NF-e novamente/;
const CONTEXTO_KEY = ['nfeContextoRejeicao', 'p1', 'n1'];

let queryClient: QueryClient;

interface DialogProps {
  readonly opened?: boolean;
  readonly pedidoIds?: ReadonlyArray<string>;
}

function dialog({ opened = true, pedidoIds = PEDIDO_IDS }: DialogProps = {}) {
  return (
    <QueryClientProvider client={queryClient}>
      <MantineTestProvider>
        <EmitirLoteDialog opened={opened} pedidoIds={pedidoIds} onClose={() => {}} />
      </MantineTestProvider>
    </QueryClientProvider>
  );
}

function renderDialog(props?: DialogProps) {
  return render(dialog(props));
}

/** `b` comes after `a` in document order. */
function following(a: Node, b: Node): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: QUERY_DEFAULT_OPTIONS });
  h.emitirLote.mockReset();
  h.emitirLote.mockResolvedValue(RESULTADO);
  h.carregador.mockReset();
  h.loader.mockReset();
  h.loader.mockResolvedValue(CONTEXTO);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe('EmitirLoteDialog — cStat 805 guidance per row (#852)', () => {
  it('explains the 805 row with the cadastro link; the 226 and EmitError rows stay raw', async () => {
    renderDialog();

    const guidance = await screen.findByText(GUIDANCE);
    expect(guidance.textContent).toContain('SEFAZ-SP');
    const link = screen.getByRole('link', { name: 'Abrir cadastro de ACME LTDA' });
    expect(link.getAttribute('href')).toBe('/clientes/cli-1');

    // The loader ran ONCE, for the 805 row only, with that row's own ids.
    expect(h.loader).toHaveBeenCalledTimes(1);
    expect(h.loader).toHaveBeenCalledWith({ pedidoId: 'p1', nfeId: 'n1' });
    expect(h.carregador).toHaveBeenCalledWith(h.db);

    // The guidance sits under row p1 — after it, before row p2.
    expect(following(screen.getByText('p1'), guidance)).toBe(true);
    expect(following(guidance, screen.getByText('p2'))).toBe(true);

    // Every raw row is intact, the 805 one included.
    for (const raw of ['805', XMOTIVO_805, '226', XMOTIVO_226, 'EMIT_FAILED']) {
      expect(screen.getByText(raw)).toBeTruthy();
    }
    expect(screen.getByText('Falha ao montar o XML')).toBeTruthy();
    // No other row got guidance or a link.
    expect(screen.getAllByText(GUIDANCE)).toHaveLength(1);
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('a loader failure leaves the 805 row raw — no guidance, nothing thrown, and NO retry', async () => {
    h.loader.mockRejectedValue(new TypeError('boom'));
    renderDialog();

    // Wait for the query to REACH its error state, so the absence below is
    // not just "still loading".
    await waitFor(() => expect(queryClient.getQueryState(CONTEXTO_KEY)?.status).toBe('error'));
    expect(screen.getByText('805')).toBeTruthy();
    expect(screen.getByText(XMOTIVO_805)).toBeTruthy();
    expect(screen.queryByText(GUIDANCE)).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    // Exactly once, under the app's `retry: 1` default: the row's `retry: false`
    // is what stops a defect from being re-run.
    expect(h.loader).toHaveBeenCalledTimes(1);
  });

  it('a re-run re-reads the context: close, fix the cadastro, reopen → "já alterado" (the nfeId is reused)', async () => {
    const view = renderDialog();
    expect(await screen.findByText(CORRIGIR)).toBeTruthy();
    expect(h.loader).toHaveBeenCalledTimes(1);

    // The operator fixes the cadastro and closes the modal…
    h.loader.mockResolvedValue(CONTEXTO_ALTERADO);
    view.rerender(dialog({ opened: false }));
    expect(screen.queryByText('p1')).toBeNull();
    // …and with the row unmounted, `gcTime: 0` DROPS the previous run's context
    // — under the app's 5-minute default it would survive to describe the next run.
    await waitFor(() => expect(queryClient.getQueryState(CONTEXTO_KEY)).toBeUndefined());

    // …then re-emits the same selection: the rejeitada nota reuses nfeId n1.
    view.rerender(dialog({ opened: true }));
    expect(await screen.findByText(REEMITIR)).toBeTruthy();
    expect(screen.queryByText(CORRIGIR)).toBeNull();
    expect(h.emitirLote).toHaveBeenCalledTimes(2);
    expect(h.loader).toHaveBeenCalledTimes(2);
  });

  it('a re-emission without closing (a new pedidoIds identity) re-reads the still-cached context', async () => {
    const view = renderDialog();
    expect(await screen.findByText(CORRIGIR)).toBeTruthy();

    h.loader.mockResolvedValue(CONTEXTO_ALTERADO);
    // The lote re-fires on a new array identity; its reply lands before
    // TanStack's gc timer runs, so the row remounts onto the CACHED previous
    // context — only `staleTime: 0` (vs the app's 30 s) makes it re-read.
    await act(async () => {
      view.rerender(dialog({ pedidoIds: [...PEDIDO_IDS] }));
    });
    expect(await screen.findByText(REEMITIR)).toBeTruthy();
    expect(h.emitirLote).toHaveBeenCalledTimes(2);
    expect(h.loader).toHaveBeenCalledTimes(2);
  });

  it('an 805 on a NON-rejeitada estado gets no guidance and costs no read', async () => {
    h.emitirLote.mockResolvedValue({
      results: [
        {
          nfeId: 'n4',
          pedidoId: 'p4',
          estado: ESTADO_NFE.error,
          chave: CHAVE,
          nRec: null,
          cStat: '805',
          xMotivo: XMOTIVO_805,
        },
        REJEITADA_805,
      ],
    } satisfies NFeBatchEmitResult);
    renderDialog({ pedidoIds: ['p4', 'p1'] });

    const guidance = await screen.findByText(GUIDANCE);
    // One guidance, from the rejeitada row's read only — p4's ids were never loaded.
    expect(screen.getAllByText(GUIDANCE)).toHaveLength(1);
    expect(h.loader).toHaveBeenCalledTimes(1);
    expect(h.loader).toHaveBeenCalledWith({ pedidoId: 'p1', nfeId: 'n1' });
    expect(h.loader).not.toHaveBeenCalledWith(expect.objectContaining({ pedidoId: 'p4' }));
    // …and it sits under p1 (the LAST row), so nothing sits under p4.
    expect(following(screen.getByText('p1'), guidance)).toBe(true);
    expect(following(screen.getByText('p4'), screen.getByText('p1'))).toBe(true);
  });

  it('an 805 whose context has no guidance (indIEDest 9) renders the raw row only', async () => {
    h.loader.mockResolvedValue({
      ...CONTEXTO,
      destinatario: { idDest: '1', indIEDest: '9', uf: 'SP' },
    } satisfies ContextoRejeicaoNFe);
    renderDialog();

    await waitFor(() => expect(queryClient.getQueryState(CONTEXTO_KEY)?.status).toBe('success'));
    expect(screen.getByText(XMOTIVO_805)).toBeTruthy();
    expect(screen.queryByText(GUIDANCE)).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
