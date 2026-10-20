import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  FreightNetworkError,
  FreightReauthRequiredError,
} from '@delfrance/integrations-freight-br/http-client';

import {
  CODIGO_SITUACAO_LI,
  INTEGRACAO_FRETE,
  type RespostaConferenciaPagamentoLi,
} from '@delfrance/schemas';

import { lojaIntegradaClientFalso } from '@/lib/testing/lojaIntegradaClientFalso';

import { melhorEnviosProvider } from './melhorEnvios';
import type { ComprarEtiquetaInput, ComprarEtiquetaOutcome, EtiquetaProviderInput } from '../types';

/* -------------------------------- fixtures -------------------------------- */

function makeUi(over: Partial<EtiquetaProviderInput['ui']> = {}): EtiquetaProviderInput['ui'] {
  return {
    confirmRisk: vi.fn(async () => true),
    notify: vi.fn(),
    openUrl: vi.fn(),
    comprarEtiqueta: vi.fn(async (): Promise<ComprarEtiquetaOutcome> => ({ status: 'cancelled' })),
    escolherEnvio: vi.fn(),
    confirmarCiente: vi.fn(async () => true),
    ...over,
  };
}

function makeInput(over: {
  frete?: Partial<{ printLabelId: string | null; externalOptionId: string | null }>;
  formato?: 'pdf' | 'zpl2';
  freightClient?: unknown;
  ui?: EtiquetaProviderInput['ui'];
  intFrete?: EtiquetaProviderInput['intFrete'];
  pedido?: EtiquetaProviderInput['pedido'];
  pedidoId?: string;
  lojaIntegradaClient?: EtiquetaProviderInput['deps']['lojaIntegradaClient'];
}): EtiquetaProviderInput {
  const frete = { printLabelId: null, externalOptionId: null, ...over.frete };
  return {
    db: {} as never,
    pedido: over.pedido ?? ({} as never),
    pedidoId: over.pedidoId ?? 'p1',
    frete: frete as never,
    intFrete: over.intFrete ?? {
      fonte: 'doc',
      id: 'if1',
      tipo: INTEGRACAO_FRETE.melhorEnvios,
      data: {} as never,
    },
    formato: over.formato ?? 'pdf',
    deps: {
      freightClient: (over.freightClient ?? null) as never,
      nfeClient: null,
      mercadoLivreClient: null,
      shopeeClient: null,
      lojaIntegradaClient: over.lojaIntegradaClient ?? lojaIntegradaClientFalso(),
      printJob: vi.fn(),
    },
    ui: over.ui ?? makeUi(),
  };
}

const BLOCO_ME: EtiquetaProviderInput['intFrete'] = {
  fonte: 'bloco',
  id: null,
  tipo: INTEGRACAO_FRETE.melhorEnvios,
  data: null,
};

/* --------------------------------- tests ---------------------------------- */

describe('melhorEnviosProvider', () => {
  it('prints an already-bought label: imprimir → openUrl → opened', async () => {
    const imprimir = vi.fn(async () => ({ url: 'https://me/label.pdf' }));
    const ui = makeUi();
    const input = makeInput({ frete: { printLabelId: 'lbl-1' }, freightClient: { imprimir }, ui });

    const out = await melhorEnviosProvider.emitirOuImprimir(input);
    expect(out).toEqual({ status: 'opened' });
    expect(imprimir).toHaveBeenCalledWith('if1', 'lbl-1');
    expect(ui.openUrl).toHaveBeenCalledWith('https://me/label.pdf');
  });

  it('buys via the modal when a service is selected: bought+printUrl → opened', async () => {
    const comprarEtiqueta = vi.fn(
      async (): Promise<ComprarEtiquetaOutcome> => ({
        status: 'bought',
        printUrl: 'https://me/bought.pdf',
      }),
    );
    const ui = makeUi({ comprarEtiqueta });
    const input = makeInput({
      frete: { externalOptionId: 'opt-9' },
      freightClient: { imprimir: vi.fn() },
      ui,
    });

    const out = await melhorEnviosProvider.emitirOuImprimir(input);
    expect(out).toEqual({ status: 'opened' });
    expect(comprarEtiqueta).toHaveBeenCalledWith(
      expect.objectContaining({ intFreteId: 'if1', pedidoId: 'p1' }),
    );
    expect(ui.openUrl).toHaveBeenCalledWith('https://me/bought.pdf');
  });

  it('returns skipped when the buy modal is cancelled', async () => {
    const ui = makeUi({ comprarEtiqueta: vi.fn(async () => ({ status: 'cancelled' as const })) });
    const input = makeInput({
      frete: { externalOptionId: 'opt-9' },
      freightClient: { imprimir: vi.fn() },
      ui,
    });

    expect(await melhorEnviosProvider.emitirOuImprimir(input)).toEqual({ status: 'skipped' });
    expect(ui.openUrl).not.toHaveBeenCalled();
  });

  it('needs a quote when there is no label and no selected option', async () => {
    const input = makeInput({ freightClient: { imprimir: vi.fn() } });
    expect(await melhorEnviosProvider.emitirOuImprimir(input)).toEqual({
      status: 'needs-quote',
      editorHref: '/pedidos/p1/editar',
    });
  });

  it('errors when the freight client is null', async () => {
    const input = makeInput({ frete: { printLabelId: 'lbl-1' }, freightClient: null });
    const out = await melhorEnviosProvider.emitirOuImprimir(input);
    expect(out.status).toBe('error');
  });

  it('warns (notify) but proceeds to PDF when zpl2 is requested', async () => {
    const imprimir = vi.fn(async () => ({ url: 'https://me/label.pdf' }));
    const ui = makeUi();
    const input = makeInput({
      frete: { printLabelId: 'lbl-1' },
      formato: 'zpl2',
      freightClient: { imprimir },
      ui,
    });

    const out = await melhorEnviosProvider.emitirOuImprimir(input);
    expect(out).toEqual({ status: 'opened' });
    expect(ui.notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Melhor Envios' }));
  });

  it('maps a recognized freight error to an error outcome', async () => {
    const imprimir = vi.fn(async () => {
      throw new FreightReauthRequiredError('reauth', {});
    });
    const input = makeInput({ frete: { printLabelId: 'lbl-1' }, freightClient: { imprimir } });
    const out = await melhorEnviosProvider.emitirOuImprimir(input);
    expect(out.status).toBe('error');
  });

  it('rethrows an unrecognized error', async () => {
    const boom = new RangeError('boom');
    const imprimir = vi.fn(async () => {
      throw boom;
    });
    const input = makeInput({ frete: { printLabelId: 'lbl-1' }, freightClient: { imprimir } });
    await expect(melhorEnviosProvider.emitirOuImprimir(input)).rejects.toBe(boom);
  });

  it('recognizes a network error as an error outcome (not a rethrow)', async () => {
    const imprimir = vi.fn(async () => {
      throw new FreightNetworkError('down');
    });
    const input = makeInput({ frete: { printLabelId: 'lbl-1' }, freightClient: { imprimir } });
    const out = await melhorEnviosProvider.emitirOuImprimir(input);
    expect(out.status).toBe('error');
  });

  it('W6 — refuses a `bloco` integration before any I/O: no imprimir with a null account', async () => {
    // ME routes on the int_frete ACCOUNT id; a bloco has none. Both arms that
    // would use it (the reprint and the buy modal) must stay untouched.
    const imprimir = vi.fn(async () => ({ url: 'https://me/label.pdf' }));
    const comprarEtiqueta = vi.fn(
      async (): Promise<ComprarEtiquetaOutcome> => ({ status: 'cancelled' }),
    );
    for (const frete of [{ printLabelId: 'lbl-1' }, { externalOptionId: 'opt-9' }]) {
      const ui = makeUi({ comprarEtiqueta });
      const out = await melhorEnviosProvider.emitirOuImprimir(
        makeInput({ frete, freightClient: { imprimir }, ui, intFrete: BLOCO_ME }),
      );
      expect(out).toEqual({ status: 'error', message: 'Integração de frete não encontrada.' });
      expect(ui.openUrl).not.toHaveBeenCalled();
    }
    expect(imprimir).not.toHaveBeenCalled();
    expect(comprarEtiqueta).not.toHaveBeenCalled();
  });

  it('W6 — the bloco refusal comes first: no zpl2 warning, no client check', async () => {
    const ui = makeUi();
    const out = await melhorEnviosProvider.emitirOuImprimir(
      makeInput({ formato: 'zpl2', freightClient: null, ui, intFrete: BLOCO_ME }),
    );
    expect(out).toEqual({ status: 'error', message: 'Integração de frete não encontrada.' });
    expect(ui.notify).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*            The Loja Integrada paid re-check's soft gate (step 15)          */
/* -------------------------------------------------------------------------- */

describe('melhorEnviosProvider — the Loja Integrada soft gate (A2)', () => {
  const ID_LI = createHash('sha256').update('lojaIntegradaCONTA1-165').digest('hex');
  const PEDIDO_LI = {
    numero: '165',
    integracaoPedidoOuterRef: 'documents/integracao/CONTA1',
  } as never;
  const resposta = (veredito: 'pago' | 'nao-pago'): RespostaConferenciaPagamentoLi => ({
    aplicavel: true,
    fonte: 'loja',
    veredito,
    codigo:
      veredito === 'pago' ? CODIGO_SITUACAO_LI.pedidoPago : CODIGO_SITUACAO_LI.pedidoCancelado,
    motivoContestacao: null,
    conferidoEmMs: 0,
    correlationId: null,
  });

  function cenario(
    frete: Partial<{ printLabelId: string | null; externalOptionId: string | null }>,
    veredito: 'pago' | 'nao-pago',
    ciente: boolean,
  ) {
    const conferirPagamento = vi.fn(async () => resposta(veredito));
    const confirmarCiente = vi.fn(async (_p: { titulo: string; mensagem: string }) => ciente);
    const imprimir = vi.fn(async () => ({ url: 'https://me/label.pdf' }));
    const comprarEtiqueta = vi.fn(
      async (_i: ComprarEtiquetaInput): Promise<ComprarEtiquetaOutcome> => ({
        status: 'cancelled',
      }),
    );
    const ui = makeUi({ confirmarCiente, comprarEtiqueta });
    const input = makeInput({
      frete,
      freightClient: { imprimir },
      ui,
      pedido: PEDIDO_LI,
      pedidoId: ID_LI,
      lojaIntegradaClient: lojaIntegradaClientFalso({ conferirPagamento }),
    });
    return { input, ui, conferirPagamento, confirmarCiente, imprimir, comprarEtiqueta };
  }

  it('a REPRINT with `nao-pago` + Cancelar ⇒ skipped, and the label URL is never fetched', async () => {
    const s = cenario({ printLabelId: 'lbl-1' }, 'nao-pago', false);

    await expect(melhorEnviosProvider.emitirOuImprimir(s.input)).resolves.toEqual({
      status: 'skipped',
    });

    expect(s.confirmarCiente).toHaveBeenCalledTimes(1);
    expect(s.confirmarCiente.mock.calls[0]?.[0].mensagem).toContain(
      'Reimprimir a etiqueta deste pedido',
    );
    expect(s.imprimir).not.toHaveBeenCalled();
    expect(s.ui.openUrl).not.toHaveBeenCalled();
  });

  it('a REPRINT with `nao-pago` + "Estou ciente do risco" ⇒ opened', async () => {
    const s = cenario({ printLabelId: 'lbl-1' }, 'nao-pago', true);

    await expect(melhorEnviosProvider.emitirOuImprimir(s.input)).resolves.toEqual({
      status: 'opened',
    });

    expect(s.imprimir).toHaveBeenCalledOnce();
  });

  it('a REPRINT with `pago` ⇒ no dialog, opened', async () => {
    const s = cenario({ printLabelId: 'lbl-1' }, 'pago', false);

    await expect(melhorEnviosProvider.emitirOuImprimir(s.input)).resolves.toEqual({
      status: 'opened',
    });

    expect(s.conferirPagamento).toHaveBeenCalledOnce();
    expect(s.confirmarCiente).not.toHaveBeenCalled();
  });

  it('⭐ the BUY branch never runs the soft gate — the modal owns its own check', async () => {
    const s = cenario({ externalOptionId: '1' }, 'nao-pago', false);

    await melhorEnviosProvider.emitirOuImprimir(s.input);

    expect(s.conferirPagamento).not.toHaveBeenCalled();
    expect(s.confirmarCiente).not.toHaveBeenCalled();
    expect(s.comprarEtiqueta).toHaveBeenCalledOnce();
  });

  it("the BUY branch forwards the chain's carried verdict to the modal", async () => {
    const s = cenario({ externalOptionId: '1' }, 'pago', false);
    const conferenciaLi = { tipo: 'resposta' as const, resposta: resposta('pago'), recebidoEm: 7 };

    await melhorEnviosProvider.emitirOuImprimir({ ...s.input, conferenciaLi });

    expect(s.comprarEtiqueta).toHaveBeenCalledWith(expect.objectContaining({ conferenciaLi }));
  });

  it('⚠️ NEAR-MISS: with nothing carried, the buy input carries no verdict at all', async () => {
    const s = cenario({ externalOptionId: '1' }, 'pago', false);

    await melhorEnviosProvider.emitirOuImprimir(s.input);

    expect(s.comprarEtiqueta.mock.calls[0]?.[0]).not.toHaveProperty('conferenciaLi');
  });
});
