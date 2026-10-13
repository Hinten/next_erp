import { afterEach, describe, expect, it, vi } from 'vitest';

import { CAMINHO_VALIDACAO, URL_BASE_LI, validarPersonalToken } from '../src/api';
import * as barril from '../src/index';
import { PRAZO_LI_MS } from '../src/prazos';
import {
  categoriaPagina1,
  corpo401Json,
  corpo403Html,
  corpo409Bruto,
  corpo429Loja,
  corpo500Html,
} from './_fixtures/especificacao';
import {
  fetchQueNuncaResponde,
  json,
  mockFetch,
  observar,
  requisicao,
  texto,
  TOKEN,
  verificarSoGet,
} from './_helpers/mockFetch';

afterEach(verificarSoGet);

const CORRELACAO = 'corr-validacao';

function validar(fetch: typeof globalThis.fetch, token = TOKEN, sinal?: AbortSignal) {
  return validarPersonalToken({ token, fetch, sinal, gerarCorrelationId: () => CORRELACAO });
}

describe('the constants', () => {
  it('pins the origin and the slash form of the validating path', () => {
    expect(URL_BASE_LI).toBe('https://api.awsli.com.br');
    expect(CAMINHO_VALIDACAO).toBe('/v1/categoria/');
  });

  it('exports the public surface from the barrel', () => {
    for (const nome of [
      'validarPersonalToken',
      'criarClienteLeituraLi',
      'paginarLi',
      'extrairEscopoLimite',
      'lerRetryAfter',
      'liEnvelopeSchema',
    ] as const) {
      expect(typeof barril[nome], nome).toBe('function');
    }
    expect(barril.URL_BASE_LI).toBe(URL_BASE_LI);
    expect(barril.PRAZO_LI_MS).toBe(PRAZO_LI_MS);
    expect(barril.MAX_PAGINAS_PADRAO).toBe(200);
  });
});

describe('aceito', () => {
  it('200 with an envelope → aceito, after exactly ONE GET to /v1/categoria/?limit=1', async () => {
    const f = mockFetch(() => json(categoriaPagina1));
    const v = await validar(f);
    expect(v).toEqual({
      veredito: 'aceito',
      status: 200,
      motivo: expect.any(String) as unknown,
      correlationId: CORRELACAO,
    });
    expect(f).toHaveBeenCalledTimes(1);
    const { url, init, headers } = requisicao(f);
    expect(url.href).toBe('https://api.awsli.com.br/v1/categoria/?limit=1');
    expect(init.method).toBe('GET');
    expect(headers.get('authorization')).toBe(`Basic ${TOKEN}`);
  });

  it('sends NO x-correlation-id header', async () => {
    const f = mockFetch(() => json(categoriaPagina1));
    await validar(f);
    expect(requisicao(f).headers.has('x-correlation-id')).toBe(false);
  });

  it('an empty store (objects: []) is still aceito — the rows do not matter', async () => {
    const f = mockFetch(() =>
      json({ meta: { ...categoriaPagina1.meta, next: null }, objects: [] }),
    );
    expect((await validar(f)).veredito).toBe('aceito');
  });

  it('rows that are not categorias are still aceito — any valid envelope is', async () => {
    const f = mockFetch(() => json({ meta: categoriaPagina1.meta, objects: [{ outra: 'coisa' }] }));
    expect((await validar(f)).veredito).toBe('aceito');
  });
});

describe('recusado — 401 and 403 only', () => {
  it.each([
    [401, corpo401Json],
    [403, corpo403Html],
  ])('HTTP %i → recusado', async (status, corpo) => {
    const v = await validar(mockFetch(() => texto(corpo, status)));
    expect(v.veredito).toBe('recusado');
    expect(v.status).toBe(status);
    expect(v.correlationId).toBe(CORRELACAO);
  });

  it('near-miss: a 400 is NEVER recusado — how a bad token answers beyond 401/403 is unknown', async () => {
    const v = await validar(mockFetch(() => texto('{"erro": "token"}', 400)));
    expect(v.veredito).toBe('inconclusivo');
    expect(v.status).toBe(400);
  });
});

describe('invalido — nothing is sent', () => {
  it.each([
    ['a trailing \\n', `${TOKEN}\n`],
    ['an inner space', 'tok en-sintetico'],
    ['a NUL', `${TOKEN}\u0000`],
    ['é', `${TOKEN}é`],
    ['empty', ''],
  ])('a token with %s → invalido, told it has a bad character', async (_caso, token) => {
    const f = mockFetch(() => json(categoriaPagina1));
    const v = await validar(f, token);
    expect(v).toEqual({
      veredito: 'invalido',
      status: null,
      motivo: expect.stringContaining('caractere inválido') as unknown,
      correlationId: CORRELACAO,
    });
    expect(f).not.toHaveBeenCalled();
  });

  // The label and the URL of this call are fixed, so a "token" short enough to
  // fit inside one of them is refused by the client as `'ref'` or
  // `'token-na-url'` — the candidate's fault, never a programming error. Its
  // motivo must not blame a character it does not have.
  it.each([
    ['inside the fixed candidate ref', 'cand'],
    ['inside the validating path', 'categoria'],
    ['inside the origin', 'awsli'],
  ])('a token that fits %s → invalido, told it is not a Personal Token', async (_caso, token) => {
    const f = mockFetch(() => json(categoriaPagina1));
    const v = await validar(f, token);
    expect(v).toEqual({
      veredito: 'invalido',
      status: null,
      motivo: expect.stringContaining('não parece um Personal Token') as unknown,
      correlationId: CORRELACAO,
    });
    expect(v.motivo).not.toContain('caractere');
    expect(f).not.toHaveBeenCalled();
  });

  it('near-miss: the same 40-character token without the stray byte is sent', async () => {
    const f = mockFetch(() => json(categoriaPagina1));
    expect((await validar(f, TOKEN)).veredito).toBe('aceito');
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('inconclusivo — nothing can be concluded about the token', () => {
  it.each([
    [301, ''],
    [400, ''],
    [404, ''],
    [409, corpo409Bruto],
    [429, corpo429Loja],
    [500, corpo500Html],
    [503, 'Service Unavailable'],
    [520, ''],
  ])('HTTP %i → inconclusivo, with the status', async (status, corpo) => {
    const v = await validar(mockFetch(() => texto(corpo, status)));
    expect(v.veredito).toBe('inconclusivo');
    expect(v.status).toBe(status);
  });

  it.each([
    ['HTML', '<html><body>Loja</body></html>'],
    ['a non-envelope object', '{"objects": []}'],
    ['a JSON array', '[]'],
    ['a bare JSON string', corpo409Bruto],
    ['an empty body', ''],
  ])('200 with %s → inconclusivo', async (_caso, corpo) => {
    const v = await validar(mockFetch(() => texto(corpo, 200)));
    expect(v.veredito).toBe('inconclusivo');
    expect(v.status).toBe(200);
  });

  it('a network failure → inconclusivo, no status', async () => {
    const v = await validar(
      mockFetch(() => {
        throw new TypeError('fetch failed');
      }),
    );
    expect(v).toMatchObject({ veredito: 'inconclusivo', status: null });
  });

  it('a timeout → inconclusivo, no status', async () => {
    vi.useFakeTimers();
    try {
      const { estado, pronto } = observar(validar(fetchQueNuncaResponde()));
      await vi.advanceTimersByTimeAsync(PRAZO_LI_MS.leitura);
      await pronto;
      expect(estado.valor).toMatchObject({ veredito: 'inconclusivo', status: null });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('what is rethrown', () => {
  it('a caller abort is rethrown as-is', async () => {
    const controller = new AbortController();
    const p = validar(fetchQueNuncaResponde(), TOKEN, controller.signal);
    controller.abort();
    await expect(p).rejects.toBe(controller.signal.reason);
  });

  it('an unexpected transport rejection is rethrown as itself', async () => {
    const propria = new RangeError('init inválido');
    await expect(
      validar(
        mockFetch(() => {
          throw propria;
        }),
      ),
    ).rejects.toBe(propria);
  });
});

describe('the verdict never carries the token', () => {
  it.each([
    ['aceito', () => json({ ...categoriaPagina1, eco: TOKEN })],
    ['recusado', () => texto(`{"detail": "token ${TOKEN} recusado"}`, 401)],
    ['inconclusivo (http)', () => texto(`erro com ${TOKEN}`, 500)],
    ['inconclusivo (schema)', () => texto(`<html>${TOKEN}</html>`, 200)],
  ])('%s', async (veredito, resposta) => {
    const v = await validar(mockFetch(resposta));
    expect(v.veredito).toBe(veredito.split(' ')[0]);
    expect(v.motivo.length).toBeGreaterThan(0);
    expect(JSON.stringify(v)).not.toContain(TOKEN);
  });

  it('invalido', async () => {
    const token = `${TOKEN}\n`;
    const v = await validar(
      mockFetch(() => json(categoriaPagina1)),
      token,
    );
    expect(v.veredito).toBe('invalido');
    expect(JSON.stringify(v)).not.toContain(TOKEN);
  });
});
