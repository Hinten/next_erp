/**
 * NFeHttpClient tests — mock the fetch transport, assert request
 * shape + response parsing + error-mapping by HTTP status.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createNFeHttpClient,
  NFeAuthError,
  NFeBadRequestError,
  NFeBlockedError,
  NFeDanfeUnavailableError,
  NFeInutilizacaoAbortedError,
  NFeNetworkError,
  NFePedidoNotFoundError,
  NFeRejectedError,
  NFeRuntimeNotReadyError,
  NFeServerError,
  type NFeEmitResult,
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
      estado: 'aprovada',
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
        estado: 'rejeitada',
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
    estado: 'c',
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
