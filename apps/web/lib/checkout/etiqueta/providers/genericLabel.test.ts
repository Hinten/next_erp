import { beforeEach, describe, expect, it, vi } from 'vitest';

// The provider builds the model then renders it through the generic-label
// module; mock the whole barrel so the test never touches Firestore or jsPDF.
const { buildModelMock, renderPdfMock, renderZplMock } = vi.hoisted(() => ({
  buildModelMock: vi.fn(),
  renderPdfMock: vi.fn(),
  renderZplMock: vi.fn(),
}));
vi.mock('@/lib/etiqueta-generica', () => ({
  buildEtiquetaGenericaModel: buildModelMock,
  renderEtiquetaGenericaPdf: renderPdfMock,
  renderEtiquetaGenericaZpl: renderZplMock,
}));

import { createHash } from 'node:crypto';
import {
  CODIGO_SITUACAO_LI,
  INTEGRACAO_FRETE,
  type RespostaConferenciaPagamentoLi,
} from '@delfrance/schemas';

import { printJob as realPrintJob, type PrintAgentRequest } from '@/lib/print-agent/printJob';
import { lojaIntegradaClientFalso } from '@/lib/testing/lojaIntegradaClientFalso';

import { genericLabelProvider } from './genericLabel';
import type { EtiquetaProviderInput } from '../types';

function makeInput(over: {
  formato?: 'pdf' | 'zpl2';
  printJob?: EtiquetaProviderInput['deps']['printJob'];
  notify?: EtiquetaProviderInput['ui']['notify'];
  intFrete?: EtiquetaProviderInput['intFrete'];
  pedido?: EtiquetaProviderInput['pedido'];
  pedidoId?: string;
  lojaIntegradaClient?: EtiquetaProviderInput['deps']['lojaIntegradaClient'];
  confirmRisk?: EtiquetaProviderInput['ui']['confirmRisk'];
  confirmarCiente?: EtiquetaProviderInput['ui']['confirmarCiente'];
  conferenciaLi?: EtiquetaProviderInput['conferenciaLi'];
}): EtiquetaProviderInput {
  return {
    db: {} as never,
    pedido: over.pedido ?? ({ numero: '1234' } as never),
    pedidoId: over.pedidoId ?? 'p1',
    frete: {} as never,
    intFrete: over.intFrete ?? {
      fonte: 'doc',
      id: 'if1',
      tipo: INTEGRACAO_FRETE.motoboy,
      data: {} as never,
    },
    formato: over.formato ?? 'pdf',
    deps: {
      freightClient: null,
      nfeClient: null,
      mercadoLivreClient: null,
      shopeeClient: null,
      lojaIntegradaClient: over.lojaIntegradaClient ?? lojaIntegradaClientFalso(),
      printJob: over.printJob ?? (vi.fn(async () => 'printed') as never),
    },
    ui: {
      confirmRisk: over.confirmRisk ?? vi.fn(async () => true),
      notify: over.notify ?? vi.fn(),
      openUrl: vi.fn(),
      comprarEtiqueta: vi.fn(),
      escolherEnvio: vi.fn(),
      confirmarCiente: over.confirmarCiente ?? vi.fn(async () => true),
    },
    ...(over.conferenciaLi === undefined ? {} : { conferenciaLi: over.conferenciaLi }),
  };
}

describe('genericLabelProvider', () => {
  beforeEach(() => {
    buildModelMock.mockReset().mockResolvedValue({ title: 'Pedido 1234' });
    renderPdfMock.mockReset().mockResolvedValue(new Blob(['%PDF-1.3']));
    renderZplMock.mockReset().mockReturnValue('^XA^CI28^XZ');
  });

  it('builds the model, renders the PDF and prints it → printed', async () => {
    const printJob = vi.fn(async () => 'printed' as const);
    const input = makeInput({ printJob });

    const out = await genericLabelProvider.emitirOuImprimir(input);
    expect(out).toEqual({ status: 'printed' });
    expect(buildModelMock).toHaveBeenCalledTimes(1);
    expect(renderPdfMock).toHaveBeenCalledTimes(1);
    expect(renderZplMock).not.toHaveBeenCalled();
    expect(printJob).toHaveBeenCalledWith(
      expect.any(Blob),
      expect.objectContaining({
        tamanho: 'etq',
        contentType: 'application/pdf',
        fileName: 'etiqueta-1234.pdf',
      }),
    );
  });

  it('still reports printed when the agent is down, but SAYS the label was downloaded', async () => {
    // The row action is silent on a successful print, so without the toast an
    // agent that is down is indistinguishable from a print that worked — the
    // click appears to do nothing and the label is sitting in Downloads.
    const printJob = vi.fn(async () => 'downloaded' as const);
    const notify = vi.fn();
    const out = await genericLabelProvider.emitirOuImprimir(makeInput({ printJob, notify }));
    expect(out).toEqual({ status: 'printed' });
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        color: 'yellow',
        message: expect.stringContaining('etiqueta-1234.pdf'),
      }),
    );
  });

  it('tells the operator a downloaded ZPL is not a file they can just open', async () => {
    // The two formats fail differently: a downloaded PDF is double-clickable, a
    // `.zpl2` is a text file Notepad will happily print as `^XA^CI28…` source.
    const notify = vi.fn();
    await genericLabelProvider.emitirOuImprimir(
      makeInput({
        formato: 'zpl2',
        printJob: vi.fn(async () => 'downloaded' as const),
        notify,
      }),
    );
    const message = String(notify.mock.calls[0]![0].message);
    expect(message).toContain('etiqueta-1234.zpl2');
    expect(message).toContain('Zebra');
    expect(message).toContain('Bloco de Notas');
  });

  it('stays silent when the agent actually printed it', async () => {
    const notify = vi.fn();
    await genericLabelProvider.emitirOuImprimir(
      makeInput({ printJob: vi.fn(async () => 'printed' as const), notify }),
    );
    expect(notify).not.toHaveBeenCalled();
  });

  it('renders real ZPL for zpl2 and sends it down the agent’s plain-text channel', async () => {
    // Legacy toasted "ainda não implementado" here and printed the PDF instead —
    // on the format that was the operator's default.
    const printJob = vi.fn(async () => 'printed' as const);
    const notify = vi.fn();
    const out = await genericLabelProvider.emitirOuImprimir(
      makeInput({ formato: 'zpl2', printJob, notify }),
    );

    expect(out).toEqual({ status: 'printed' });
    expect(renderZplMock).toHaveBeenCalledTimes(1);
    expect(renderPdfMock).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(printJob).toHaveBeenCalledWith(
      expect.any(Blob),
      expect.objectContaining({
        tamanho: 'etq',
        contentType: 'text/plain',
        fileName: 'etiqueta-1234.zpl2',
      }),
    );
  });

  it('hands the agent the BARE `text/plain` its exact-match router accepts, UTF-8 bytes intact', async () => {
    // `printJob.dart` routes with `==`, so `text/plain;charset=utf-8` matches no
    // branch and fails INSIDE the agent — which still answers 200, so neither
    // `printJob`'s download fallback nor the toast ever fires and the label just
    // does not print. Drive the REAL client and read the body the agent parses:
    // nothing downstream of this assertion can see the mistake.
    renderZplMock.mockReturnValue('^XA^CI28^FDSão Paulo^FS^XZ');
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response('OK', { status: 200 }),
    );
    const saveBlob = vi.fn();
    const notify = vi.fn();

    const out = await genericLabelProvider.emitirOuImprimir(
      makeInput({
        formato: 'zpl2',
        printJob: (blob, opts) =>
          realPrintJob(blob, opts, { fetch: fetchMock as unknown as typeof fetch, saveBlob }),
        notify,
      }),
    );

    expect(out).toEqual({ status: 'printed' });
    expect(saveBlob).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as PrintAgentRequest;
    expect(body.contentType).toBe('text/plain');
    expect(body.tamanhoFolhaImpressao).toBe('etq');
    // …while the bytes stay UTF-8: `^CI28` needs the two-byte `ã`, not Latin-1.
    const bytes = Uint8Array.from(atob(body.docDataBase64), (c) => c.charCodeAt(0));
    expect(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toBe(
      '^XA^CI28^FDSão Paulo^FS^XZ',
    );
  });

  it('carries the ZPL bytes themselves, not a rasterised label', async () => {
    renderZplMock.mockReturnValue('^XA^CI28^FDSão Paulo^FS^XZ');
    let sent: Blob | null = null;
    const printJob: EtiquetaProviderInput['deps']['printJob'] = async (blob) => {
      sent = blob;
      return 'printed';
    };
    await genericLabelProvider.emitirOuImprimir(makeInput({ formato: 'zpl2', printJob }));

    expect(sent).not.toBeNull();
    expect(await (sent as unknown as Blob).text()).toBe('^XA^CI28^FDSão Paulo^FS^XZ');
  });

  it('returns an error outcome + red toast when rendering fails (best-effort)', async () => {
    renderPdfMock.mockRejectedValue(new Error('canvas boom'));
    const notify = vi.fn();
    const out = await genericLabelProvider.emitirOuImprimir(makeInput({ notify }));
    expect(out).toEqual({ status: 'error', message: 'canvas boom' });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ color: 'red' }));
  });

  it('W6 — refuses a `bloco` integration (no int_frete document): no model, no render, no print', async () => {
    // The subtitle names the int_frete ACCOUNT, so the label needs the document.
    // The registry never routes a bloco here (its tipo is always
    // marketplace-owned); this pins the provider's own refusal.
    const printJob = vi.fn(async () => 'printed' as const);
    const notify = vi.fn();
    for (const formato of ['pdf', 'zpl2'] as const) {
      const out = await genericLabelProvider.emitirOuImprimir(
        makeInput({
          formato,
          printJob,
          notify,
          intFrete: { fonte: 'bloco', id: null, tipo: INTEGRACAO_FRETE.motoboy, data: null },
        }),
      );
      expect(out).toEqual({ status: 'error', message: 'Integração de frete não encontrada.' });
    }
    expect(buildModelMock).not.toHaveBeenCalled();
    expect(renderPdfMock).not.toHaveBeenCalled();
    expect(renderZplMock).not.toHaveBeenCalled();
    expect(printJob).not.toHaveBeenCalled();
  });

  it('near-miss of W6 — the same tipo as a `doc` integration still prints', async () => {
    const printJob = vi.fn(async () => 'printed' as const);
    const out = await genericLabelProvider.emitirOuImprimir(
      makeInput({
        printJob,
        intFrete: {
          fonte: 'doc',
          id: 'int-1',
          tipo: INTEGRACAO_FRETE.motoboy,
          data: { tipo: INTEGRACAO_FRETE.motoboy } as never,
        },
      }),
    );
    expect(out).toEqual({ status: 'printed' });
    expect(buildModelMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'p1',
      expect.anything(),
      expect.objectContaining({ fonte: 'doc', id: 'int-1' }),
    );
    expect(printJob).toHaveBeenCalledOnce();
  });
});

/* -------------------------------------------------------------------------- */
/*            The Loja Integrada paid re-check's soft gate (step 15)          */
/* -------------------------------------------------------------------------- */

describe('genericLabelProvider — the Loja Integrada soft gate (A2)', () => {
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
      veredito === 'pago' ? CODIGO_SITUACAO_LI.pedidoPago : CODIGO_SITUACAO_LI.aguardandoPagamento,
    motivoContestacao: null,
    conferidoEmMs: 0,
    correlationId: null,
  });

  function cenario(veredito: 'pago' | 'nao-pago', ciente: boolean) {
    const conferirPagamento = vi.fn(async () => resposta(veredito));
    const confirmarCiente = vi.fn(async () => ciente);
    const confirmRisk = vi.fn(async () => true);
    const printJob = vi.fn(async () => 'printed' as const);
    const input = makeInput({
      pedido: PEDIDO_LI,
      pedidoId: ID_LI,
      lojaIntegradaClient: lojaIntegradaClientFalso({ conferirPagamento }),
      confirmarCiente,
      confirmRisk,
      printJob,
    });
    return { input, conferirPagamento, confirmarCiente, confirmRisk, printJob };
  }

  beforeEach(() => {
    buildModelMock.mockReset().mockResolvedValue({ title: 'Pedido 165' });
    renderPdfMock.mockReset().mockResolvedValue(new Blob(['%PDF-1.3']));
  });

  it('`nao-pago` + Cancelar ⇒ skipped, and NOTHING is built or printed', async () => {
    const s = cenario('nao-pago', false);

    await expect(genericLabelProvider.emitirOuImprimir(s.input)).resolves.toEqual({
      status: 'skipped',
    });

    expect(s.confirmarCiente).toHaveBeenCalledTimes(1);
    expect(buildModelMock).not.toHaveBeenCalled();
    expect(s.printJob).not.toHaveBeenCalled();
  });

  it('`nao-pago` + "Estou ciente do risco" ⇒ printed', async () => {
    const s = cenario('nao-pago', true);

    await expect(genericLabelProvider.emitirOuImprimir(s.input)).resolves.toEqual({
      status: 'printed',
    });

    expect(s.confirmRisk).not.toHaveBeenCalled();
    expect(s.printJob).toHaveBeenCalledOnce();
  });

  it('`pago` ⇒ no dialog, printed', async () => {
    const s = cenario('pago', false);

    await expect(genericLabelProvider.emitirOuImprimir(s.input)).resolves.toEqual({
      status: 'printed',
    });

    expect(s.conferirPagamento).toHaveBeenCalledOnce();
    expect(s.conferirPagamento).toHaveBeenCalledWith(ID_LI, undefined);
    expect(s.confirmarCiente).not.toHaveBeenCalled();
  });

  it('⚠️ NEAR-MISS: a carried `pago` under 120 s spares the call', async () => {
    const s = cenario('nao-pago', false);
    const input = {
      ...s.input,
      conferenciaLi: {
        tipo: 'resposta' as const,
        resposta: resposta('pago'),
        recebidoEm: performance.now(),
      },
    };

    await expect(genericLabelProvider.emitirOuImprimir(input)).resolves.toEqual({
      status: 'printed',
    });

    expect(s.conferirPagamento).not.toHaveBeenCalled();
  });

  it('a pedido that is not an imported order never calls (the default pedido of this suite)', async () => {
    const conferirPagamento = vi.fn();
    const out = await genericLabelProvider.emitirOuImprimir(
      makeInput({ lojaIntegradaClient: lojaIntegradaClientFalso({ conferirPagamento }) }),
    );

    expect(out).toEqual({ status: 'printed' });
    expect(conferirPagamento).not.toHaveBeenCalled();
  });
});
