import { describe, expect, it } from 'vitest';
import { CODIGO_ERRO_AMAZON, erroContaAmazonSchema } from '@delfrance/schemas';

import {
  ChamadasAmazonDesligadasError,
  ConfigAmazonAusenteError,
  ContaAmazonNaoEncontradaError,
  ContaAmazonParadaError,
  CredencialAmazonInvalidaError,
} from './erros';
import {
  CABECALHOS_DE_RESPOSTA_AMAZON,
  comCabecalhosAmazon,
  ehErroAppAmazon,
  redirecionarParaWeb,
  respostaDeErroAmazon,
  respostaErro,
  respostaIdInvalido,
  respostaJson,
  respostaSemWebAppUrl,
  respostaVazia,
} from './respond';

function cabecalhosOk(res: Response): void {
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
}

describe('the headers', () => {
  it('are exactly no-store and no-referrer', () => {
    expect(CABECALHOS_DE_RESPOSTA_AMAZON).toEqual({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
  });

  it('ride every builder', () => {
    cabecalhosOk(respostaJson(200, { a: 1 }));
    cabecalhosOk(respostaErro(400, 'X', 'y'));
    cabecalhosOk(respostaIdInvalido());
    cabecalhosOk(respostaSemWebAppUrl());
    cabecalhosOk(
      redirecionarParaWeb('https://app.example', '/canais/amazon', { amazon: 'connected' }),
    );
    cabecalhosOk(comCabecalhosAmazon(new Response(null, { status: 401 })));
    cabecalhosOk(respostaVazia(200));
  });
});

describe('respostaVazia (the push receiver’s every answer)', () => {
  it.each([200, 401, 500, 503])('%i: that status, an EMPTY body, both headers', async (status) => {
    const res = respostaVazia(status);
    expect(res.status).toBe(status);
    cabecalhosOk(res);
    expect(await res.text()).toBe('');
  });
});

describe('the error envelope', () => {
  it('parses as erroContaAmazonSchema, with a CODIGO_ERRO_AMAZON code', async () => {
    const res = respostaIdInvalido();
    expect(res.status).toBe(400);
    const corpo = erroContaAmazonSchema.parse(await res.json());
    expect(corpo.code).toBe(CODIGO_ERRO_AMAZON.ID_INVALIDO);
  });

  it.each([
    [new ContaAmazonNaoEncontradaError('c1'), 404, CODIGO_ERRO_AMAZON.CONTA_NAO_ENCONTRADA],
    [new ChamadasAmazonDesligadasError('c1'), 503, CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS],
    [
      new ConfigAmazonAusenteError(['AMAZON_APPLICATION_ID']),
      500,
      CODIGO_ERRO_AMAZON.CONFIG_AUSENTE,
    ],
  ] as const)('maps %s', async (err, status, code) => {
    expect(ehErroAppAmazon(err)).toBe(true);
    const res = respostaDeErroAmazon(err);
    expect(res.status).toBe(status);
    expect(erroContaAmazonSchema.parse(await res.json()).code).toBe(code);
    cabecalhosOk(res);
  });

  it('the config answer names the variables, never a value', async () => {
    const res = respostaDeErroAmazon(new ConfigAmazonAusenteError(['AMAZON_OAUTH_STATE_SECRET']));
    expect((await res.json()) as unknown).toMatchObject({
      error: expect.stringContaining('AMAZON_OAUTH_STATE_SECRET') as unknown,
    });
  });

  it('throws on an app error no step-2 route can meet (a caller bug, not a 4xx)', () => {
    expect(() => respostaDeErroAmazon(new ContaAmazonParadaError('c1', 400, 1))).toThrow(TypeError);
    expect(() => respostaDeErroAmazon(new CredencialAmazonInvalidaError('c1', ['x']))).toThrow(
      TypeError,
    );
  });

  it('ehErroAppAmazon refuses a plain Error', () => {
    expect(ehErroAppAmazon(new Error('x'))).toBe(false);
  });
});

describe('redirecionarParaWeb', () => {
  it('connected → exactly {amazon}', () => {
    const res = redirecionarParaWeb('https://app.example/', '/canais/amazon/c1', {
      amazon: 'connected',
    });
    expect(res.status).toBe(307);
    const url = new URL(res.headers.get('location') ?? '');
    expect(`${url.origin}${url.pathname}`).toBe('https://app.example/canais/amazon/c1');
    expect([...url.searchParams.keys()]).toEqual(['amazon']);
    expect(url.searchParams.get('amazon')).toBe('connected');
  });

  it('error → exactly {amazon, reason}, even when the object carries more', () => {
    const contrabando = {
      amazon: 'error',
      reason: 'bad_state',
      codigo: 'NAO-DEVE-SAIR',
    } as const;
    const res = redirecionarParaWeb('https://app.example', '/canais/amazon', contrabando);
    const url = new URL(res.headers.get('location') ?? '');
    expect([...url.searchParams.keys()]).toEqual(['amazon', 'reason']);
    expect(url.searchParams.get('reason')).toBe('bad_state');
    expect(url.href).not.toContain('NAO-DEVE-SAIR');
  });
});

describe('respostaSemWebAppUrl', () => {
  it('is a plain-text 500 naming the variable', async () => {
    const res = respostaSemWebAppUrl();
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toContain('WEB_APP_URL');
  });
});
