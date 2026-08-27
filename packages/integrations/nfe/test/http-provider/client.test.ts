/**
 * NFeHttpClient tests — mock the fetch transport, assert request
 * shape + response parsing + error-mapping by HTTP status.
 */
import { describe, expect, it, vi } from 'vitest';

import { ESTADO_NFE } from '@delfrance/schemas';

import {
  createNFeHttpClient,
  NFeAuthError,
  NFeBadRequestError,
  NFeBlockedError,
  NFeCertificateError,
  NFeDanfeUnavailableError,
  NFeInutilizacaoAbortedError,
  NFeNetworkError,
  NFePedidoNotFoundError,
  NFeRejectedError,
  NFeHttpError,
  NFeRuntimeNotReadyError,
  NFeSchemaError,
  NFeServerError,
  type NFeEmitResult,
  type NFeVerificarResult,
} from '../../src/http-provider';

const TOKEN = 'fake-firebase-id-token';

/**
 * Build a mocked fetch that returns a FRESH Response on every call.
 * Response bodies can only be read once; reusing the same instance
 * across calls trips "Body has already been read".
 */
function mockFetch(res: { status: number; body?: unknown; text?: string }) {
  const text = res.text ?? (res.body !== undefined ? JSON.stringify(res.body) : '');
  return vi.fn().mockImplementation(() =>
    Promise.resolve(
      new Response(text, {
        status: res.status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
}

function makeClient(fetch: typeof globalThis.fetch) {
  return createNFeHttpClient({
    baseUrl: 'http://localhost:3004',
    getAuthToken: async () => TOKEN,
    fetch,
  });
}

describe('createNFeHttpClient — emitir', () => {
  it('POSTs to /api/nfe/emitir with Bearer token + pedidoId body', async () => {
    const result: NFeEmitResult = {
      nfeId: 'nfev4-001',
      pedidoId: 'PED-001',
      estado: ESTADO_NFE.aprovada,
      chave: '35260514200166000187550010000000071000000018',
      nRec: '12345',
      cStat: '100',
      xMotivo: 'Autorizado o uso da NF-e',
    };
    const fetch = mockFetch({ status: 200, body: result });
    const client = makeClient(fetch);

    const got = await client.emitir('PED-001');

    expect(got).toEqual(result);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3004/api/nfe/emitir');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ pedidoId: 'PED-001' });
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('maps 401 → NFeAuthError', async () => {
    const fetch = mockFetch({ status: 401, body: { error: 'no token' } });
    await expect(makeClient(fetch).emitir('PED-001')).rejects.toBeInstanceOf(NFeAuthError);
  });

  it('maps 403 → NFeAuthError', async () => {
    const fetch = mockFetch({ status: 403, body: { error: 'insufficient perm' } });
    await expect(makeClient(fetch).emitir('PED-001')).rejects.toBeInstanceOf(NFeAuthError);
  });

  it('maps 404 → NFePedidoNotFoundError carrying the pedidoId', async () => {
    const fetch = mockFetch({ status: 404, body: { error: 'Pedido not found' } });
    try {
      await makeClient(fetch).emitir('PED-MISSING');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NFePedidoNotFoundError);
      expect((err as NFePedidoNotFoundError).pedidoId).toBe('PED-MISSING');
    }
  });

  it('maps 409 → NFeBlockedError carrying the pedidoId', async () => {
    const fetch = mockFetch({ status: 409, body: { error: 'bloqueada' } });
    try {
      await makeClient(fetch).emitir('PED-001');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NFeBlockedError);
      expect((err as NFeBlockedError).pedidoId).toBe('PED-001');
    }
  });

  it('maps 422 → NFeRejectedError carrying cStat + xMotivo', async () => {
    const fetch = mockFetch({
      status: 422,
      body: {
        nfeId: 'nfev4-002',
        pedidoId: 'PED-002',
        estado: ESTADO_NFE.rejeitada,
        chave: '35260514200166000187550010000000081000000019',
        nRec: null,
        cStat: '226',
        xMotivo: 'Rejeicao: Codigo da UF do Emitente diverge da UF',
      },
    });
    try {
      await makeClient(fetch).emitir('PED-002');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NFeRejectedError);
      expect((err as NFeRejectedError).cStat).toBe('226');
      expect((err as NFeRejectedError).xMotivo).toContain('UF');
    }
  });

  it('maps a cert-coded 422 → NFeCertificateError, NOT NFeRejectedError (no SEFAZ contact)', async () => {
    // resolveFilialRuntime threw before any SEFAZ call (filial has no stored
    // cert). The route tags it `code: 'NFeCertError'` so the client must show
    // the pt-BR message, never "SEFAZ rejected: cStat=(unknown) …".
    const fetch = mockFetch({
      status: 422,
      body: {
        error:
          "Filial 'dev-filial-01' não possui certificado digital cadastrado. " +
          'Faça o upload do certificado A1 na aba "Certificado Digital" da filial.',
        code: 'NFeCertError',
      },
    });
    const err = await makeClient(fetch)
      .emitir('PED-001')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NFeCertificateError);
    expect(err).not.toBeInstanceOf(NFeRejectedError);
    expect((err as NFeCertificateError).message).toMatch(/não possui certificado digital/);
    expect((err as NFeCertificateError).message).not.toMatch(/SEFAZ/i);
    expect((err as NFeCertificateError).code).toBe('NFeCertError');
  });

  it('maps 503 → NFeRuntimeNotReadyError', async () => {
    const fetch = mockFetch({
      status: 503,
      body: { error: 'cert expired' },
    });
    await expect(makeClient(fetch).emitir('PED-001')).rejects.toBeInstanceOf(
      NFeRuntimeNotReadyError,
    );
  });

  it('maps 500 → NFeServerError', async () => {
    const fetch = mockFetch({ status: 500, body: { error: 'transport failed' } });
    await expect(makeClient(fetch).emitir('PED-001')).rejects.toBeInstanceOf(NFeServerError);
  });

  it('maps 400 → NFeBadRequestError', async () => {
    const fetch = mockFetch({ status: 400, body: { error: 'bad body' } });
    await expect(makeClient(fetch).emitir('')).rejects.toBeInstanceOf(NFeBadRequestError);
  });

  it('maps fetch failure → NFeNetworkError (with cause)', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    try {
      await makeClient(fetch).emitir('PED-001');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NFeNetworkError);
      expect((err as NFeNetworkError).cause).toBeInstanceOf(TypeError);
    }
  });

  it('tolerates non-JSON error body (e.g. plain-text 503 from a proxy)', async () => {
    const fetch = mockFetch({ status: 503, text: 'Service Unavailable' });
    try {
      await makeClient(fetch).emitir('PED-001');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NFeRuntimeNotReadyError);
    }
  });
});

describe('createNFeHttpClient — consultar', () => {
  it('GETs /api/nfe/consultar?chave=<…> with Bearer token', async () => {
    const fetch = mockFetch({
      status: 200,
      body: {
        chave: '35260514200166000187550010000000071000000018',
        cStat: '100',
        xMotivo: 'Autorizado',
        nProt: '12345',
        raw: { dummy: true },
      },
    });
    const got = await makeClient(fetch).consultar('35260514200166000187550010000000071000000018');

    expect(got.cStat).toBe('100');
    expect(got.nProt).toBe('12345');
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'http://localhost:3004/api/nfe/consultar?chave=35260514200166000187550010000000071000000018',
    );
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });
});

describe('createNFeHttpClient — verificar', () => {
  const RESULT: NFeVerificarResult = {
    filialId: 'F-1',
    results: [
      {
        chave: '35260514200166000187550010000000071000000018',
        status: 'atualizada',
        estadoAnterior: ESTADO_NFE.error,
        estadoNovo: ESTADO_NFE.aprovada,
        cStat: '100',
        xMotivo: 'Autorizado o uso da NF-e',
        error: null,
      },
      {
        chave: '35260514200166000187550010000000081000000019',
        status: 'skipped-final',
        estadoAnterior: ESTADO_NFE.cancelada,
        estadoNovo: ESTADO_NFE.cancelada,
        cStat: '101',
        xMotivo: 'Cancelamento de NF-e homologado',
        error: null,
      },
    ],
    msgsNaoEncontradas: ['msg-missing'],
  };

  it('POSTs to /api/nfe/verificar with Bearer token + {filialId, enviNfeMsgIds} body and parses the result', async () => {
    const fetch = mockFetch({ status: 200, body: RESULT });
    const got = await makeClient(fetch).verificar('F-1', ['msg-1', 'msg-2']);

    expect(got).toEqual(RESULT);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3004/api/nfe/verificar');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      filialId: 'F-1',
      enviNfeMsgIds: ['msg-1', 'msg-2'],
    });
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('maps 401 → NFeAuthError', async () => {
    const fetch = mockFetch({ status: 401, body: { error: 'no token' } });
    await expect(makeClient(fetch).verificar('F-1', ['msg-1'])).rejects.toBeInstanceOf(
      NFeAuthError,
    );
  });

  it('maps a cert-coded 422 → NFeCertificateError (no SEFAZ contact happened)', async () => {
    const fetch = mockFetch({
      status: 422,
      body: {
        error: "Filial 'F-1' não possui certificado digital cadastrado.",
        code: 'NFeCertError',
      },
    });
    const err = await makeClient(fetch)
      .verificar('F-1', ['msg-1'])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NFeCertificateError);
    expect(err).not.toBeInstanceOf(NFeRejectedError);
  });
});

describe('createNFeHttpClient — processarPendentes', () => {
  it('POSTs to /api/nfe/processar-pendentes with empty body', async () => {
    const fetch = mockFetch({
      status: 200,
      body: { scanned: 5, recovered: 3, stillPending: 1, errors: 1 },
    });
    const got = await makeClient(fetch).processarPendentes();

    expect(got.recovered).toBe(3);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3004/api/nfe/processar-pendentes');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({});
  });
});

describe('createNFeHttpClient — cancelar', () => {
  const cancelled: NFeEmitResult = {
    nfeId: 'nfev4-001',
    pedidoId: 'PED-001',
    estado: ESTADO_NFE.cancelada,
    chave: '35260514200166000187550010000000071000000018',
    nRec: null,
    cStat: '135',
    xMotivo: 'Evento registrado e vinculado a NF-e',
  };

  it('POSTs to /api/nfe/cancelar with { pedidoId, nfeId, xJust } + Bearer token', async () => {
    const fetch = mockFetch({ status: 200, body: cancelled });
    const got = await makeClient(fetch).cancelar(
      'PED-001',
      'nfev4-001',
      'Cancelamento por erro de digitacao',
    );

    expect(got).toEqual(cancelled);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3004/api/nfe/cancelar');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      pedidoId: 'PED-001',
      nfeId: 'nfev4-001',
      xJust: 'Cancelamento por erro de digitacao',
    });
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('maps 404 → NFePedidoNotFoundError carrying the pedidoId', async () => {
    const fetch = mockFetch({ status: 404, body: { error: 'no nfev4 doc' } });
    try {
      await makeClient(fetch).cancelar(
        'PED-MISSING',
        'nfev4-001',
        'Cancelamento de teste invalido',
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NFePedidoNotFoundError);
      expect((err as NFePedidoNotFoundError).pedidoId).toBe('PED-MISSING');
    }
  });

  it('maps 422 → NFeRejectedError (SEFAZ rejected the cancelamento)', async () => {
    const fetch = mockFetch({
      status: 422,
      body: { error: 'cancelamento rejeitado por SEFAZ — cStat=573 fora do prazo' },
    });
    await expect(
      makeClient(fetch).cancelar('PED-001', 'nfev4-001', 'Cancelamento apos prazo legal'),
    ).rejects.toBeInstanceOf(NFeRejectedError);
  });

  it('maps 400 → NFeBadRequestError (xJust too short)', async () => {
    const fetch = mockFetch({ status: 400, body: { error: 'Bad body' } });
    await expect(
      makeClient(fetch).cancelar('PED-001', 'nfev4-001', 'curto'),
    ).rejects.toBeInstanceOf(NFeBadRequestError);
  });
});

describe('createNFeHttpClient — inutilizar', () => {
  const result = {
    filialId: 'F-1',
    serie: 9,
    nNFIni: 5,
    nNFFin: 12,
    cStat: '102',
    xMotivo: 'Inutilizacao de numero homologada',
    nProt: '135200000088888',
    aprovada: true,
    reconciled: 2,
  };

  it('POSTs to /api/nfe/inutilizar with the range body + Bearer token', async () => {
    const fetch = mockFetch({ status: 200, body: result });
    const got = await makeClient(fetch).inutilizar({
      filialId: 'F-1',
      serie: 9,
      nNFIni: 5,
      nNFFin: 12,
      xJust: 'Inutilizacao de faixa nao utilizada teste',
    });

    expect(got).toEqual(result);
    expect(got.aprovada).toBe(true);
    expect(got.reconciled).toBe(2);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3004/api/nfe/inutilizar');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      filialId: 'F-1',
      serie: 9,
      nNFIni: 5,
      nNFFin: 12,
      xJust: 'Inutilizacao de faixa nao utilizada teste',
    });
  });

  it('maps 409 + code=INUTILIZACAO_ABORTED → NFeInutilizacaoAbortedError', async () => {
    const fetch = mockFetch({
      status: 409,
      body: {
        error: 'inutilização abortada: número(s) 7 da série 9 pertence(m) a NF-e já autorizada(s)',
        code: 'INUTILIZACAO_ABORTED',
      },
    });
    await expect(
      makeClient(fetch).inutilizar({
        filialId: 'F-1',
        serie: 9,
        nNFIni: 5,
        nNFFin: 12,
        xJust: 'Inutilizacao de faixa nao utilizada teste',
      }),
    ).rejects.toBeInstanceOf(NFeInutilizacaoAbortedError);
  });

  it('maps 422 → NFeRejectedError (SEFAZ rejected the inutilização)', async () => {
    const fetch = mockFetch({
      status: 422,
      body: { error: 'inutilização rejeitada por SEFAZ — cStat=563 numero ja utilizado' },
    });
    await expect(
      makeClient(fetch).inutilizar({
        filialId: 'F-1',
        serie: 9,
        nNFIni: 5,
        nNFFin: 12,
        xJust: 'Inutilizacao de faixa nao utilizada teste',
      }),
    ).rejects.toBeInstanceOf(NFeRejectedError);
  });

  it('maps 400 → NFeBadRequestError (inverted range)', async () => {
    const fetch = mockFetch({ status: 400, body: { error: 'nNFIni deve ser ≤ nNFFin' } });
    await expect(
      makeClient(fetch).inutilizar({
        filialId: 'F-1',
        serie: 9,
        nNFIni: 20,
        nNFFin: 10,
        xJust: 'Inutilizacao de faixa nao utilizada teste',
      }),
    ).rejects.toBeInstanceOf(NFeBadRequestError);
  });
});

describe('createNFeHttpClient — danfe', () => {
  it('returns the Blob + filename (from Content-Disposition) + contentType', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response('%PDF-1.7 …', {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'attachment; filename="danfe-7.pdf"',
        },
      }),
    );
    const art = await makeClient(fetch as never).danfe('PED-1', 's1', 'simplificado');
    expect(art.filename).toBe('danfe-7.pdf');
    expect(art.contentType).toBe('application/pdf');
    expect(await art.blob.text()).toContain('%PDF-');
    const [url] = fetch.mock.calls[0] as [string];
    expect(url).toContain('/api/nfe/danfe?');
    expect(url).toContain('pedidoId=PED-1');
    expect(url).toContain('format=simplificado');
  });

  it('passes dpi for zpl2 and falls back to a default filename', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response('^XA^XZ', {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      }),
    );
    const art = await makeClient(fetch as never).danfe('PED-1', 's1', 'zpl2', 300);
    expect(art.filename).toBe('danfe.txt'); // no Content-Disposition → fallback
    const [url] = fetch.mock.calls[0] as [string];
    expect(url).toContain('format=zpl2');
    expect(url).toContain('dpi=300');
  });

  it('maps a 422 to NFeDanfeUnavailableError, NOT NFeRejectedError', async () => {
    const fetch = mockFetch({ status: 422, body: { error: 'estado não renderável' } });
    const err = await makeClient(fetch)
      .danfe('PED-1', 's1', 'simplificado')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NFeDanfeUnavailableError);
    expect(err).not.toBeInstanceOf(NFeRejectedError);
    expect((err as NFeDanfeUnavailableError).message).toBe('estado não renderável');
  });

  it('maps a 404 to NFePedidoNotFoundError carrying the known pedidoId', async () => {
    const fetch = mockFetch({ status: 404, body: { error: 'not found' } });
    const err = await makeClient(fetch)
      .danfe('PED-X', 's1', 'simplificado')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NFePedidoNotFoundError);
    expect((err as NFePedidoNotFoundError).pedidoId).toBe('PED-X');
  });

  it('wraps a transport failure in NFeNetworkError', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(
      makeClient(fetch as never).danfe('PED-1', 's1', 'simplificado'),
    ).rejects.toBeInstanceOf(NFeNetworkError);
  });
});

describe('createNFeHttpClient — cartaCorrecaoDanfe', () => {
  it('GETs /api/nfe/carta-correcao/danfe with pedidoId/nfeId/cceId + returns the Blob', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response('%PDF-1.7 …', {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'attachment; filename="carta-correcao-7-seq2.pdf"',
        },
      }),
    );
    const art = await makeClient(fetch as never).cartaCorrecaoDanfe('PED-1', 's1', 'cce-9');
    expect(art.filename).toBe('carta-correcao-7-seq2.pdf');
    expect(art.contentType).toBe('application/pdf');
    expect(await art.blob.text()).toContain('%PDF-');
    const [url] = fetch.mock.calls[0] as [string];
    expect(url).toContain('/api/nfe/carta-correcao/danfe?');
    expect(url).toContain('pedidoId=PED-1');
    expect(url).toContain('nfeId=s1');
    expect(url).toContain('cceId=cce-9');
  });

  it('maps a 422 to NFeDanfeUnavailableError (CC-e not registrada)', async () => {
    const fetch = mockFetch({ status: 422, body: { error: 'carta de correção não registrada' } });
    const err = await makeClient(fetch)
      .cartaCorrecaoDanfe('PED-1', 's1', 'cce-9')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NFeDanfeUnavailableError);
    expect(err).not.toBeInstanceOf(NFeRejectedError);
  });

  it('maps a 404 to NFePedidoNotFoundError carrying the known pedidoId', async () => {
    const fetch = mockFetch({ status: 404, body: { error: 'not found' } });
    const err = await makeClient(fetch)
      .cartaCorrecaoDanfe('PED-X', 's1', 'cce-9')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NFePedidoNotFoundError);
    expect((err as NFePedidoNotFoundError).pedidoId).toBe('PED-X');
  });
});

describe('createNFeHttpClient — statusServico', () => {
  const STATUS_OK = {
    target: 'normal',
    authorizer: 'sefaz',
    cStat: '107',
    xMotivo: 'Serviço em Operação',
    dhRecbto: '2026-06-10T10:00:00-03:00',
    tMed: '1',
    category: 'servico-em-operacao',
  };

  it('GETs /api/nfe/status-servico with the target + filialId + Bearer token', async () => {
    const fetch = mockFetch({ status: 200, body: STATUS_OK });
    const out = await makeClient(fetch).statusServico('normal', 'F-1');
    expect(out.cStat).toBe('107');
    expect(out.category).toBe('servico-em-operacao');
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3004/api/nfe/status-servico?target=normal&filialId=F-1');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('passes target=svc + filialId through', async () => {
    const fetch = mockFetch({
      status: 200,
      body: { ...STATUS_OK, target: 'svc', authorizer: 'svc-an' },
    });
    const out = await makeClient(fetch).statusServico('svc', 'F-1');
    expect(out.authorizer).toBe('svc-an');
    const [url] = fetch.mock.calls[0] as [string];
    expect(url).toContain('target=svc');
    expect(url).toContain('filialId=F-1');
  });

  it('maps a 502 (SEFAZ unreachable) to NFeServerError', async () => {
    const fetch = mockFetch({
      status: 502,
      body: { error: 'SEFAZ inacessível: connect ETIMEDOUT', code: 'NFeTransportError' },
    });
    const err = await makeClient(fetch)
      .statusServico('normal', 'F-1')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NFeServerError);
    expect((err as NFeServerError).message).toContain('inacessível');
  });
});

describe('createNFeHttpClient — baseUrl normalisation', () => {
  it('strips a single trailing slash off baseUrl', async () => {
    const fetch = mockFetch({
      status: 200,
      body: { scanned: 0, recovered: 0, stillPending: 0, errors: 0 },
    });
    const client = createNFeHttpClient({
      baseUrl: 'http://localhost:3004/',
      getAuthToken: async () => TOKEN,
      fetch,
    });
    await client.processarPendentes();
    const [url] = fetch.mock.calls[0] as [string];
    expect(url).toBe('http://localhost:3004/api/nfe/processar-pendentes');
  });

  it('calls getAuthToken on every request (token refresh)', async () => {
    const fetch = mockFetch({
      status: 200,
      body: { scanned: 0, recovered: 0, stillPending: 0, errors: 0 },
    });
    const getAuthToken = vi.fn().mockResolvedValue(TOKEN);
    const client = createNFeHttpClient({
      baseUrl: 'http://localhost:3004',
      getAuthToken,
      fetch,
    });
    await client.processarPendentes();
    await client.processarPendentes();
    expect(getAuthToken).toHaveBeenCalledTimes(2);
  });
});

describe('createNFeHttpClient — certificado', () => {
  it('uploadCertificado POSTs the cert + password and returns the metadata', async () => {
    const meta = {
      subjectCommonName: 'ACME:99999999000191',
      cnpj: '99999999000191',
      notAfter: Date.UTC(2027, 0, 1), // ms since epoch
      filename: 'cert.pfx',
      uploadedAt: Date.UTC(2026, 5, 16),
    };
    const fetch = mockFetch({ status: 200, body: meta });
    const got = await makeClient(fetch).uploadCertificado('F-1', 'cGZ4', 'senha', 'cert.pfx');
    expect(got).toEqual(meta);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3004/api/nfe/certificado');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      filialId: 'F-1',
      pfxBase64: 'cGZ4',
      password: 'senha',
      filename: 'cert.pfx',
    });
  });

  it('maps a cert 422 → NFeCertificateError with the pt-BR message, NOT NFeRejectedError', async () => {
    // The upload never contacts SEFAZ — a 422 must NOT become a "SEFAZ rejected" error.
    const fetch = mockFetch({
      status: 422,
      body: {
        error: 'Senha incorreta ou arquivo de certificado (.pfx/.p12) inválido.',
        code: 'CERT_INVALIDO',
      },
    });
    const err = await makeClient(fetch)
      .uploadCertificado('F-1', 'cGZ4', 'wrong', 'cert.pfx')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NFeCertificateError);
    expect(err).not.toBeInstanceOf(NFeRejectedError);
    expect((err as NFeCertificateError).message).toBe(
      'Senha incorreta ou arquivo de certificado (.pfx/.p12) inválido.',
    );
    expect((err as NFeCertificateError).message).not.toMatch(/SEFAZ/i);
    expect((err as NFeCertificateError).code).toBe('CERT_INVALIDO');
  });

  it('maps a cert 401/403 → NFeAuthError', async () => {
    const fetch = mockFetch({ status: 403, body: { error: 'Sem permissão para esta operação.' } });
    const err = await makeClient(fetch)
      .uploadCertificado('F-1', 'cGZ4', 'senha', 'cert.pfx')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NFeAuthError);
  });

  it('deleteCertificado DELETEs with the filialId query + maps errors to NFeCertificateError', async () => {
    const ok = mockFetch({ status: 200, body: { ok: true } });
    await makeClient(ok).deleteCertificado('F-1');
    const [url, init] = ok.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3004/api/nfe/certificado?filialId=F-1');
    expect(init.method).toBe('DELETE');

    const fail = mockFetch({ status: 422, body: { error: 'falha', code: 'X' } });
    const err = await makeClient(fail)
      .deleteCertificado('F-1')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NFeCertificateError);
  });
});

/**
 * The highest-consequence of the six clients that ended in `return parsed as T`.
 *
 * ⭐ An EMPTY 200 on `/api/nfe/emitir` produced `null as NFeEmitResult` — "the
 * nota was authorized" asserted with no `chave`, no `nRec` and no `cStat`, in a
 * fiscal state machine that then read `undefined` off it.
 *
 * ⚠️ Note what this suite already proved about itself: two fixtures in this file
 * carried `estado: 'aprovada'` / `'rejeitada'`, which are the enum KEYS — the
 * wire values are `'a'` and `'n'`. Nothing caught it, because `test/**` is
 * outside this package's tsconfig `include` and the cast validated nothing. The
 * fixture claimed a shape no route could ever send, and the test passed.
 */
describe('createNFeHttpClient — a 2xx that is not the shape we claimed', () => {
  it('⭐ refuses an EMPTY 200 instead of asserting an authorized nota', async () => {
    const client = makeClient(mockFetch({ status: 200, text: '' }));

    await expect(client.emitir('PED-001')).rejects.toBeInstanceOf(NFeSchemaError);
  });

  it('⭐ refuses a 200 missing the chave', async () => {
    // The half-shape is the dangerous one: enough fields to look like a result,
    // and the one field the whole fiscal record is keyed on is absent.
    const client = makeClient(
      mockFetch({
        status: 200,
        body: {
          nfeId: 'nfev4-001',
          pedidoId: 'PED-001',
          estado: ESTADO_NFE.aprovada,
          nRec: '1',
          cStat: '100',
          xMotivo: 'ok',
        },
      }),
    );

    const err = (await client.emitir('PED-001').catch((e: unknown) => e)) as NFeSchemaError;

    expect(err).toBeInstanceOf(NFeSchemaError);
    expect(err.campos).toEqual(['chave']);
  });

  it('⭐ refuses an estado SEFAZ could never send', async () => {
    // Exactly the fixture bug above, now caught: `'aprovada'` is the enum key.
    const client = makeClient(
      mockFetch({
        status: 200,
        body: {
          nfeId: 'n1',
          pedidoId: 'PED-001',
          estado: 'aprovada',
          chave: '35260514200166000187550010000000071000000018',
          nRec: null,
          cStat: '100',
          xMotivo: 'ok',
        },
      }),
    );

    await expect(client.emitir('PED-001')).rejects.toBeInstanceOf(NFeSchemaError);
  });

  it('refuses a 200 that is not JSON at all', async () => {
    const client = makeClient(mockFetch({ status: 200, text: '<!DOCTYPE html><html></html>' }));

    const err = (await client.emitir('PED-001').catch((e: unknown) => e)) as NFeSchemaError;

    expect(err).toBeInstanceOf(NFeSchemaError);
    expect(err.message).toContain('sem um corpo JSON');
  });

  it('is caught by callers narrowing to NFeHttpError', async () => {
    // ⚠️ Why it is a subclass rather than a sibling: the fiscal call sites
    // narrow to this family and rethrow anything else.
    const client = makeClient(mockFetch({ status: 200, text: '' }));

    await expect(client.emitir('PED-001')).rejects.toBeInstanceOf(NFeHttpError);
  });

  it('⚠️ names the field but never the value', async () => {
    // A fiscal 200 carries the taxpayer's data. `NFeSchemaError` also carries no
    // `body`, for the same reason `MelhorEnvioSchemaError` does not.
    const client = makeClient(
      mockFetch({
        status: 200,
        body: { supported: true, uf: 'SP', cStat: null, xMotivo: null, infCad: 'nao-e-array' },
      }),
    );

    const err = (await client
      .consultaCadastro('12345678000199', 'SP', 'f1')
      .catch((e: unknown) => e)) as NFeSchemaError;

    expect(err.campos).toEqual(['infCad']);
    expect(err.message).not.toContain('12345678000199');
    expect(err.body).toBeNull();
  });

  it('keeps `reused` optional — older route revisions omit it', async () => {
    // The doc block on the field says so in as many words. That is a statement
    // about the wire, so the schema has to honour it or every emission through
    // an older deployment fails.
    const client = makeClient(
      mockFetch({
        status: 200,
        body: {
          nfeId: 'n1',
          pedidoId: 'PED-001',
          estado: ESTADO_NFE.aprovada,
          chave: '35260514200166000187550010000000071000000018',
          nRec: null,
          cStat: '100',
          xMotivo: 'ok',
        },
      }),
    );

    await expect(client.emitir('PED-001')).resolves.toMatchObject({ chave: expect.any(String) });
  });

  it('still leaves the error path alone', async () => {
    // ⚠️ The control that matters most. The non-2xx branch keeps its raw-text
    // fallback and its injectable `mapError` — a 422 must still arrive as the
    // typed rejection the fiscal UI reads, not as a schema complaint.
    const client = makeClient(mockFetch({ status: 500, text: 'nginx: upstream timed out' }));

    const err = await client.emitir('PED-001').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NFeServerError);
    expect(err).not.toBeInstanceOf(NFeSchemaError);
  });
});
