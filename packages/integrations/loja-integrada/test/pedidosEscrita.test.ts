import { afterEach, describe, expect, it } from 'vitest';

import { criarClienteLeituraLi, URL_BASE_LI } from '../src/client';
import { criarClienteEscritaLi, type LiEscritaClient } from '../src/escrita';
import { LiConfigError, LiHttpError } from '../src/errors';
import { liEcoPedidoEnvioSchema, liEcoSituacaoPedidoSchema } from '../src/pedidoTipos';
import {
  alterarSituacaoPedidoLi,
  atualizarObjetoEnvioLi,
  CODIGOS_SITUACAO_ESCRITA_LI,
  type CodigoSituacaoEscritaLi,
  MAX_OBJETO_ENVIO_LI,
  objetoDeEnvioValidoLi,
} from '../src/pedidosEscrita';
import { json, mockFetch, requisicao, TOKEN, texto, verificarMetodos } from './_helpers/mockFetch';

/**
 * The two write-back operations of master-plan step 7. Every id, code and echo
 * here is the public document's own example (envio `69291055`, objeto
 * `PJ258408772BR`, numero `165`, the two `PUT` echoes) — no captured value.
 */

afterEach(verificarMetodos(['GET', 'PUT']));

const ENVIO = 69291055;
const NUMERO = 165;
const OBJETO = 'PJ258408772BR';

/** The spec's `PUT /v1/pedido_envio/{pedido_envio_id}` 200 example. */
const ECO_ENVIO = {
  data_criacao: '2022-10-31T12:28:05.722569',
  data_modificacao: '2023-02-10T10:48:36.747270',
  id: 69291055,
  objeto: OBJETO,
  prazo: 7,
  valor: '21.38',
};

/** The spec's `PUT /v1/situacao/pedido/{pedido_id}` 200 example. */
const ECO_SITUACAO = {
  aprovado: true,
  cancelado: false,
  codigo: 'pedido_enviado',
  final: true,
  id: 11,
  nome: 'Pedido Enviado',
  notificar_comprador: true,
  padrao: false,
  pedido: '/api/v1/pedido/164',
  resource_uri: '/api/v1/situacao/11',
};

function cliente(fetch: typeof globalThis.fetch): {
  c: LiEscritaClient;
  credenciais: () => number;
} {
  let pedidas = 0;
  const c = criarClienteEscritaLi({
    obterCredencial: () => {
      pedidas += 1;
      return { token: TOKEN, ref: 'ref-A' };
    },
    fetch,
    gerarCorrelationId: () => 'corr-1',
    agora: () => 0,
  });
  return { c, credenciais: () => pedidas };
}

async function falha(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('esperava uma rejeição');
    },
    (e: unknown) => e,
  );
}

const IDS_INVALIDOS: readonly (number | string)[] = [
  0,
  -1,
  1.5,
  Number.NaN,
  2 ** 53,
  '',
  '0',
  '-1',
  '+165',
  '0165',
  ' 165',
  '165 ',
  '1/2',
  '1e3',
  '165.0',
  '0x10',
  '../165',
];

describe('atualizarObjetoEnvioLi — PUT /v1/pedido_envio/{envio id} {objeto}', () => {
  it('sends exactly the tracking code to the envio path, with NO trailing slash', async () => {
    const f = mockFetch(() => json(ECO_ENVIO));
    const r = await atualizarObjetoEnvioLi(cliente(f).c, ENVIO, OBJETO);
    const { url, init } = requisicao(f);
    expect(init.method).toBe('PUT');
    expect(url.href).toBe(`${URL_BASE_LI}/v1/pedido_envio/69291055`);
    expect(url.pathname.endsWith('/')).toBe(false);
    expect(init.body).toBe('{"objeto":"PJ258408772BR"}');
    expect(r).toMatchObject({ status: 200, aplicada: 'sim', leituraEco: 'ok' });
    expect(r.eco).toMatchObject({ id: ENVIO, objeto: OBJETO });
  });

  it('a number and its canonical decimal text name the same envio', async () => {
    const f = mockFetch(() => texto('', 204));
    const { c } = cliente(f);
    await atualizarObjetoEnvioLi(c, ENVIO, OBJETO);
    await atualizarObjetoEnvioLi(c, '69291055', OBJETO);
    expect(requisicao(f, 0).url.pathname).toBe('/v1/pedido_envio/69291055');
    expect(requisicao(f, 1).url.pathname).toBe('/v1/pedido_envio/69291055');
  });

  it.each(IDS_INVALIDOS)(
    'an envio id of %j → LiConfigError("caminho"), nothing fetched',
    async (id) => {
      const f = mockFetch(() => json(ECO_ENVIO));
      const { c, credenciais } = cliente(f);
      const err = await falha(atualizarObjetoEnvioLi(c, id, OBJETO));
      expect(err).toBeInstanceOf(LiConfigError);
      expect((err as LiConfigError).motivo).toBe('caminho');
      expect(f).not.toHaveBeenCalled();
      expect(credenciais()).toBe(0);
    },
  );

  it('a wrong path form fails VISIBLY: a 3xx is a LiHttpError, never followed', async () => {
    const f = mockFetch(() =>
      texto('', 301, { location: 'https://api.awsli.com.br/v1/pedido_envio/69291055/' }),
    );
    const err = await falha(atualizarObjetoEnvioLi(cliente(f).c, ENVIO, OBJETO));
    expect(err).toBeInstanceOf(LiHttpError);
    expect((err as LiHttpError).status).toBe(301);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('a 202 is reported pending, never applied', async () => {
    const r = await atualizarObjetoEnvioLi(
      cliente(mockFetch(() => texto('', 202))).c,
      ENVIO,
      OBJETO,
    );
    expect(r).toMatchObject({ status: 202, aplicada: 'pendente', eco: null, leituraEco: 'vazio' });
  });

  it('forwards the caller signal: already aborted ⇒ nothing sent, its reason comes back', async () => {
    const controller = new AbortController();
    controller.abort(new RangeError('motivo do chamador'));
    const f = mockFetch(() => json(ECO_ENVIO));
    await expect(
      atualizarObjetoEnvioLi(cliente(f).c, ENVIO, OBJETO, { sinal: controller.signal }),
    ).rejects.toBe(controller.signal.reason);
    expect(f).not.toHaveBeenCalled();
  });

  it('takes the WRITE client only (compile-time)', () => {
    const leitura = criarClienteLeituraLi({ obterCredencial: () => ({ token: TOKEN, ref: 'r' }) });
    // Never invoked: the point is that it does not compile.
    const naoCompila = () =>
      // @ts-expect-error — a read client cannot write
      atualizarObjetoEnvioLi(leitura, ENVIO, OBJETO);
    expect(typeof naoCompila).toBe('function');
  });
});

describe('the objeto predicate — no method can CLEAR a code or send one LI would refuse', () => {
  const VALIDOS = [OBJETO, '!', '~', 'A'.repeat(MAX_OBJETO_ENVIO_LI), 'AB-123/45_x.y'];
  const INVALIDOS: readonly unknown[] = [
    '',
    ' ',
    '\t',
    `${OBJETO} `,
    ` ${OBJETO}`,
    'PJ 258408772BR',
    `${OBJETO}\n`,
    'A'.repeat(MAX_OBJETO_ENVIO_LI + 1),
    `${OBJETO}é`,
    'PJ\u0000BR',
    'PJ BR',
    123,
    null,
    undefined,
  ];

  it('pins the length cap', () => {
    expect(MAX_OBJETO_ENVIO_LI).toBe(200);
  });

  it.each(VALIDOS)('EQUAL side: %j is sendable', (valor) => {
    expect(objetoDeEnvioValidoLi(valor)).toBe(true);
  });

  it.each(INVALIDOS)('NEAR-MISS side: %j is NOT sendable', (valor) => {
    expect(objetoDeEnvioValidoLi(valor)).toBe(false);
  });

  it.each(VALIDOS)('a valid code %j is sent as given — no trim, no case change', async (valor) => {
    const f = mockFetch(() => texto('', 204));
    await atualizarObjetoEnvioLi(cliente(f).c, ENVIO, valor);
    expect(requisicao(f).init.body).toBe(JSON.stringify({ objeto: valor }));
  });

  it.each(INVALIDOS)(
    'the operation refuses %j with LiConfigError("corpo"); nothing fetched, no credential read',
    async (valor) => {
      const f = mockFetch(() => json(ECO_ENVIO));
      const { c, credenciais } = cliente(f);
      const err = await falha(atualizarObjetoEnvioLi(c, ENVIO, valor as string));
      expect(err).toBeInstanceOf(LiConfigError);
      expect((err as LiConfigError).motivo).toBe('corpo');
      expect(f).not.toHaveBeenCalled();
      expect(credenciais()).toBe(0);
    },
  );
});

describe('alterarSituacaoPedidoLi — PUT /v1/situacao/pedido/{numero} {codigo}', () => {
  it('pins the closed set: exactly the three write-back codigos', () => {
    expect([...CODIGOS_SITUACAO_ESCRITA_LI]).toEqual([
      'pedido_enviado',
      'pedido_entregue',
      'pronto_para_retirada',
    ]);
  });

  it.each(CODIGOS_SITUACAO_ESCRITA_LI)(
    'sends %s to the order NUMBER path, with NO trailing slash',
    async (codigo) => {
      const f = mockFetch(() => json({ ...ECO_SITUACAO, codigo }));
      const r = await alterarSituacaoPedidoLi(cliente(f).c, NUMERO, codigo);
      const { url, init } = requisicao(f);
      expect(init.method).toBe('PUT');
      expect(url.href).toBe(`${URL_BASE_LI}/v1/situacao/pedido/165`);
      expect(url.pathname.endsWith('/')).toBe(false);
      expect(init.body).toBe(JSON.stringify({ codigo }));
      expect(r).toMatchObject({ status: 200, aplicada: 'sim', leituraEco: 'ok' });
      expect(r.eco).toMatchObject({ codigo });
    },
  );

  it.each([
    'pedido_pago',
    'faturado',
    'em_producao',
    'pedido_em_separacao',
    'pedido_cancelado',
    'cancelamento_solicitado',
    'pagamento_devolvido',
    'pedido_chargeback',
    'pagamento_em_disputa',
    'aguardando_pagamento',
    'pedido_em_transporte',
    'Pedido_Enviado',
    'pedido_enviado ',
    ' pedido_enviado',
    'PEDIDO_ENTREGUE',
    'toString',
    '__proto__',
    '',
  ])('NEAR-MISS: %j → LiConfigError("codigo-nao-permitido"), nothing fetched', async (codigo) => {
    const f = mockFetch(() => json(ECO_SITUACAO));
    const { c, credenciais } = cliente(f);
    const err = await falha(alterarSituacaoPedidoLi(c, NUMERO, codigo as CodigoSituacaoEscritaLi));
    expect(err).toBeInstanceOf(LiConfigError);
    expect((err as LiConfigError).motivo).toBe('codigo-nao-permitido');
    expect(f).not.toHaveBeenCalled();
    expect(credenciais()).toBe(0);
  });

  it('the refusal never echoes the codigo it was given', async () => {
    const marcador = 'MARCADOR-CODIGO-RECUSADO';
    const err = await falha(
      alterarSituacaoPedidoLi(
        cliente(mockFetch(() => json(ECO_SITUACAO))).c,
        NUMERO,
        marcador as CodigoSituacaoEscritaLi,
      ),
    );
    expect((err as Error).message).not.toContain(marcador);
    expect(JSON.stringify(err)).not.toContain(marcador);
  });

  it('a non-string codigo is refused the same way', async () => {
    const f = mockFetch(() => json(ECO_SITUACAO));
    for (const codigo of [11, null, undefined, { codigo: 'pedido_enviado' }]) {
      const err = await falha(
        alterarSituacaoPedidoLi(cliente(f).c, NUMERO, codigo as unknown as CodigoSituacaoEscritaLi),
      );
      expect((err as LiConfigError).motivo).toBe('codigo-nao-permitido');
    }
    expect(f).not.toHaveBeenCalled();
  });

  it.each(IDS_INVALIDOS)(
    'a numero of %j → LiConfigError("caminho"), nothing fetched',
    async (n) => {
      const f = mockFetch(() => json(ECO_SITUACAO));
      const err = await falha(alterarSituacaoPedidoLi(cliente(f).c, n, 'pedido_enviado'));
      expect(err).toBeInstanceOf(LiConfigError);
      expect((err as LiConfigError).motivo).toBe('caminho');
      expect(f).not.toHaveBeenCalled();
    },
  );

  it('a codigo outside the set does not compile', () => {
    const f = mockFetch(() => json(ECO_SITUACAO));
    // Never invoked: the point is that it does not compile.
    const naoCompila = () =>
      // @ts-expect-error — `pedido_pago` is not a write-back codigo
      alterarSituacaoPedidoLi(cliente(f).c, NUMERO, 'pedido_pago');
    expect(typeof naoCompila).toBe('function');
  });
});

describe('the echo schemas — every field optional, numbers tolerant, passthrough', () => {
  it('the envio echo parses the spec example', () => {
    expect(liEcoPedidoEnvioSchema.parse(ECO_ENVIO)).toMatchObject({ id: ENVIO, objeto: OBJETO });
  });

  it('the envio echo reads a quoted id, keeps `""` as the provider\'s nothing, keeps unknown keys', () => {
    const r = liEcoPedidoEnvioSchema.parse({ id: '69291055', objeto: '', novo: { x: 1 } });
    expect(r).toMatchObject({ id: ENVIO, objeto: '', novo: { x: 1 } });
    expect(liEcoPedidoEnvioSchema.parse({ id: '' }).id).toBeNull();
    expect(liEcoPedidoEnvioSchema.parse({ objeto: null }).objeto).toBeNull();
  });

  it('every field is optional: `{}` parses', () => {
    expect(liEcoPedidoEnvioSchema.parse({})).toEqual({});
    expect(liEcoSituacaoPedidoSchema.parse({})).toEqual({});
  });

  it('the situação echo parses the spec example, typing only codigo and id', () => {
    const r = liEcoSituacaoPedidoSchema.parse(ECO_SITUACAO);
    expect(r).toMatchObject({ codigo: 'pedido_enviado', id: 11, final: true });
    expect(liEcoSituacaoPedidoSchema.parse({ id: '11' }).id).toBe(11);
  });

  it('near-miss: a non-numeric id or a non-string codigo still fails its own leaf', () => {
    expect(liEcoPedidoEnvioSchema.safeParse({ id: 'abc' }).success).toBe(false);
    expect(liEcoSituacaoPedidoSchema.safeParse({ codigo: 11 }).success).toBe(false);
  });
});
