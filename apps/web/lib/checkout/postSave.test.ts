import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pedido } from '@delfrance/schemas';

const { ensureNfeMock, printDanfeMock, emitirEtiquetaMock, getDocMock, derefMock } = vi.hoisted(
  () => ({
    ensureNfeMock: vi.fn(),
    printDanfeMock: vi.fn(),
    emitirEtiquetaMock: vi.fn(),
    getDocMock: vi.fn(),
    derefMock: vi.fn(),
  }),
);

vi.mock('./nfeFlow', () => ({
  ensureNfeAprovada: ensureNfeMock,
  printDanfeForCheckout: printDanfeMock,
}));
vi.mock('./etiqueta/registry', () => ({ emitirOuImprimirEtiqueta: emitirEtiquetaMock }));
vi.mock('firebase/firestore', () => ({ getDoc: getDocMock }));
vi.mock('../data/dereferenceOuterRef', () => ({ dereferenceOuterRef: derefMock }));
vi.mock('../print-agent/printJob', () => ({ printJob: vi.fn() }));

import { runCheckoutPostSave } from './postSave';

const db = {} as never;
const nfeClient = {} as never;
const mlClient = { __ml: true } as never;
const ui = {
  confirmRisk: vi.fn(),
  notify: vi.fn(),
  openUrl: vi.fn(),
  comprarEtiqueta: vi.fn(),
  escolherEnvio: vi.fn(),
  confirmarCiente: vi.fn(),
};
const pedidoWith = (frete: unknown) => ({ freteInicial: frete }) as unknown as Pedido;

beforeEach(() => {
  ensureNfeMock.mockReset();
  printDanfeMock.mockReset();
  emitirEtiquetaMock.mockReset();
  getDocMock.mockReset();
  derefMock.mockReset();
  ui.notify.mockReset();
});

describe('runCheckoutPostSave', () => {
  it('emits NF-e, prints the DANFE, and dispatches the etiqueta with the resolved integration', async () => {
    ensureNfeMock.mockResolvedValue({ ok: true, nfeId: 'n1', chave: 'CHV', reused: false });
    printDanfeMock.mockResolvedValue('printed');
    derefMock.mockReturnValue({});
    getDocMock.mockResolvedValue({
      exists: () => true,
      id: 'if-1',
      data: () => ({ tipo: 'melhorEnvios' }),
    });
    emitirEtiquetaMock.mockResolvedValue({ status: 'opened' });

    const r = await runCheckoutPostSave({
      db,
      nfeClient,
      freightClient: null,
      mercadoLivreClient: mlClient,
      shopeeClient: null,
      lojaIntegradaClient: null,
      pedido: pedidoWith({ integracaoFreteOuterRef: 'documents/int_frete/if-1', modalidade: '0' }),
      pedidoId: 'p1',
      formatoDanfe: 'simplificadoPdf',
      formatoEtiqueta: 'pdf',
      ui,
    });

    expect(r.nfe).toMatchObject({ ok: true });
    expect(r.danfe).toBe('printed');
    expect(r.etiqueta).toEqual({ status: 'opened' });
    expect(printDanfeMock).toHaveBeenCalledWith(
      nfeClient,
      'p1',
      'n1',
      'simplificadoPdf',
      undefined,
    );
    expect(emitirEtiquetaMock.mock.calls[0]![0].intFrete).toEqual({
      fonte: 'doc',
      id: 'if-1',
      tipo: 'melhorEnvios',
      data: { tipo: 'melhorEnvios' },
    });
    // The ML client threads through to the provider deps untouched.
    expect(emitirEtiquetaMock.mock.calls[0]![0].deps.mercadoLivreClient).toBe(mlClient);
  });

  it('notifies + returns no-integration when the frete has no transportadora', async () => {
    ensureNfeMock.mockResolvedValue({ ok: false, pending: true });
    derefMock.mockReturnValue(null);
    const r = await runCheckoutPostSave({
      db,
      nfeClient,
      freightClient: null,
      mercadoLivreClient: null,
      shopeeClient: null,
      lojaIntegradaClient: null,
      pedido: pedidoWith({ integracaoFreteOuterRef: null, modalidade: '0' }),
      pedidoId: 'p1',
      formatoDanfe: 'retrato',
      formatoEtiqueta: 'pdf',
      ui,
    });
    expect(r.danfe).toBeNull(); // NF-e pending → no DANFE
    expect(r.etiqueta).toEqual({ status: 'no-integration' });
    expect(ui.notify).toHaveBeenCalledOnce();
    expect(emitirEtiquetaMock).not.toHaveBeenCalled();
  });

  it('skips NF-e when no client is present and skips etiqueta when frete is null', async () => {
    const r = await runCheckoutPostSave({
      db,
      nfeClient: null,
      freightClient: null,
      mercadoLivreClient: null,
      shopeeClient: null,
      lojaIntegradaClient: null,
      pedido: pedidoWith(null),
      pedidoId: 'p1',
      formatoDanfe: 'retrato',
      formatoEtiqueta: 'pdf',
      ui,
    });
    expect(r.nfe).toMatchObject({ ok: false });
    expect(ensureNfeMock).not.toHaveBeenCalled();
    expect(r.danfe).toBeNull();
    expect(r.etiqueta).toBeNull();
  });

  it('a Shopee pedido with NO int_frete ref still dispatches, on the block (#1523)', async () => {
    // Before `resolverIntFrete` this was `no-integration` + a yellow toast: a
    // Shopee pedido never carries `integracaoFreteOuterRef`, so its label was
    // unreachable from the checkout.
    ensureNfeMock.mockResolvedValue({ ok: false, pending: true });
    derefMock.mockReturnValue(null);
    emitirEtiquetaMock.mockResolvedValue({ status: 'printed' });
    const shopeeClient = { __shopee: true } as never;
    const lojaIntegradaClient = { __lojaIntegrada: true } as never;

    const r = await runCheckoutPostSave({
      db,
      nfeClient,
      freightClient: null,
      mercadoLivreClient: null,
      shopeeClient,
      lojaIntegradaClient,
      pedido: pedidoWith({
        integracaoFreteOuterRef: null,
        externalOptionIntegracao: 'shopee',
        modalidade: '0',
      }),
      pedidoId: 'p1',
      formatoDanfe: 'retrato',
      formatoEtiqueta: 'zpl2',
      ui,
    });

    expect(r.etiqueta).toEqual({ status: 'printed' });
    expect(ui.notify).not.toHaveBeenCalled();
    expect(getDocMock).not.toHaveBeenCalled();
    const input = emitirEtiquetaMock.mock.calls[0]![0];
    expect(input.intFrete).toEqual({ fonte: 'bloco', id: null, tipo: 'shopee', data: null });
    // The Shopee client threads through to the provider deps untouched.
    expect(input.deps.shopeeClient).toBe(shopeeClient);
    // …and so does the Loja Integrada one, which the soft gates ask (step 15).
    expect(input.deps.lojaIntegradaClient).toBe(lojaIntegradaClient);
    expect(input.ui.confirmarCiente).toBe(ui.confirmarCiente);
  });

  it('a NON-marketplace block with no ref stays no-integration (the rule never widens it)', async () => {
    ensureNfeMock.mockResolvedValue({ ok: false, pending: true });
    derefMock.mockReturnValue(null);
    const r = await runCheckoutPostSave({
      db,
      nfeClient,
      freightClient: null,
      mercadoLivreClient: null,
      shopeeClient: null,
      lojaIntegradaClient: null,
      pedido: pedidoWith({
        integracaoFreteOuterRef: null,
        externalOptionIntegracao: 'melhorEnvios',
        modalidade: '0',
      }),
      pedidoId: 'p1',
      formatoDanfe: 'retrato',
      formatoEtiqueta: 'pdf',
      ui,
    });
    expect(r.etiqueta).toEqual({ status: 'no-integration' });
    expect(emitirEtiquetaMock).not.toHaveBeenCalled();
  });
});

describe('runCheckoutPostSave — the Loja Integrada paid re-check (step 15)', () => {
  const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
  const ID_LI = sha256('lojaIntegradaCONTA1-165');
  const pedidoLi = (frete: unknown) =>
    ({
      numero: '165',
      integracaoPedidoOuterRef: 'documents/integracao/CONTA1',
      freteInicial: frete,
    }) as unknown as Pedido;
  const CARREGADA = {
    tipo: 'resposta',
    pedidoId: ID_LI,
    resposta: {
      aplicavel: true,
      fonte: 'loja',
      veredito: 'pago',
      codigo: 'pedido_pago',
      motivoContestacao: null,
      conferidoEmMs: 1_790_000_000_000,
      correlationId: null,
    },
    recebidoEm: 10,
  } as const;
  const base = {
    db,
    nfeClient: null,
    freightClient: null,
    mercadoLivreClient: null,
    shopeeClient: null,
    lojaIntegradaClient: null,
    formatoDanfe: 'retrato',
    formatoEtiqueta: 'pdf',
    ui,
  } as const;
  const motoboy = () => {
    derefMock.mockReturnValue({});
    getDocMock.mockResolvedValue({
      exists: () => true,
      id: 'mot-1',
      data: () => ({ tipo: 'motoboy' }),
    });
    emitirEtiquetaMock.mockResolvedValue({ status: 'printed' });
  };

  it("the checkout's verdict rides the label input, so the label's own gate can reuse it", async () => {
    motoboy();
    await runCheckoutPostSave({
      ...base,
      pedido: pedidoLi({ integracaoFreteOuterRef: 'documents/int_frete/mot-1', modalidade: '0' }),
      pedidoId: ID_LI,
      conferenciaLi: CARREGADA,
    });

    expect(emitirEtiquetaMock.mock.calls[0]![0].conferenciaLi).toBe(CARREGADA);
  });

  it('⚠️ NEAR-MISS: with no verdict (a confirm, a non-imported order) the label input carries none', async () => {
    motoboy();
    await runCheckoutPostSave({
      ...base,
      pedido: pedidoLi({ integracaoFreteOuterRef: 'documents/int_frete/mot-1', modalidade: '0' }),
      pedidoId: ID_LI,
      conferenciaLi: null,
    });

    expect(emitirEtiquetaMock.mock.calls[0]![0]).not.toHaveProperty('conferenciaLi');
  });

  it('an imported order with no freight integration says WHY — no endereço, or no Loja Integrada freight', async () => {
    derefMock.mockReturnValue(null);
    await runCheckoutPostSave({
      ...base,
      pedido: pedidoLi({
        integracaoFreteOuterRef: null,
        enderecoFreteOuterReference: null,
        modalidade: '0',
      }),
      pedidoId: ID_LI,
    });
    expect(ui.notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: 'Pedido sem endereço de entrega: não há transportadora para gerar a etiqueta.',
      }),
    );

    await runCheckoutPostSave({
      ...base,
      pedido: pedidoLi({
        integracaoFreteOuterRef: null,
        enderecoFreteOuterReference: 'documents/clientes/c1/enderecos/e1',
        modalidade: '0',
      }),
      pedidoId: ID_LI,
    });
    expect(ui.notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message:
          'A conta Loja Integrada não tem integração de frete: não há transportadora para gerar a ' +
          'etiqueta.',
      }),
    );
  });

  it('⚠️ NEAR-MISS: the same block on a Mercado Livre order keeps today’s copy', async () => {
    derefMock.mockReturnValue(null);
    const r = await runCheckoutPostSave({
      ...base,
      pedido: pedidoLi({
        integracaoFreteOuterRef: null,
        enderecoFreteOuterReference: null,
        modalidade: '0',
      }),
      pedidoId: sha256('mercadoLivreCONTA1-165'),
    });
    expect(r.etiqueta).toEqual({ status: 'no-integration' });
    expect(ui.notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: 'Este frete não possui integração com transportadora.' }),
    );
  });
});
