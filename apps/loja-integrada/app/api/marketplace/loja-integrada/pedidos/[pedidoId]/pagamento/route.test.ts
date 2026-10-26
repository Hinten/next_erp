/**
 * `GET …/pedidos/[pedidoId]/pagamento` — the paid re-check route (master plan step 15, #1825),
 * end to end through the REAL core (`lib/lojaIntegrada/pedidos/conferenciaPagamento.ts`), the
 * REAL context loader and package client, and the REAL park, against the fake.
 *
 * Mocked: the Admin singleton (`verifyIdToken` and the fake as Firestore), `FieldValue.increment`
 * (the fake's sentinel) and the pacer's sleep (recorded, never slept). The global `fetch` is
 * stubbed for the WHOLE file with a default that THROWS: a case that needs Loja Integrada scripts
 * it, and every case asserts the exact number of calls (D17: nothing here reaches the network,
 * and with the read switch off nothing even tries).
 */
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PERM } from '@delfrance/auth';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { LiHttpError } from '@delfrance/integrations-loja-integrada';
import {
  CODIGO_ERRO_LI,
  FONTE_CONFERENCIA_PAGAMENTO_LI,
  MOTIVO_CONFERENCIA_NAO_APLICAVEL_LI,
  MOTIVO_PEDIDO_CONTESTADO_LI,
  VEREDITO_PAGAMENTO_LI,
  erroContaLojaIntegradaSchema,
  respostaConferenciaPagamentoLiSchema,
} from '@delfrance/schemas';

import { CHAMADAS_ENV_LI } from '@/lib/lojaIntegrada/core/valvulas';
import { sincronizarAvisosDoPedidoLi } from '@/lib/lojaIntegrada/pedidos/avisosPedidoLi';
import { FLUXO_CONFERENCIA_PAGAMENTO_LI } from '@/lib/lojaIntegrada/pedidos/conferenciaPagamento';
import { idPedidoLi } from '@/lib/lojaIntegrada/pedidos/orderIdsLi';
import { type DocData, FakeDb, asDb, grpc, increment } from '@/lib/lojaIntegrada/testing/fakeDb';
import {
  caminhoCredencial,
  espiarStdout,
  seedConta,
  seedCredencial,
} from '@/lib/lojaIntegrada/testing/fixtures';
import { ID_ENVIO_LI, NUMERO_LI, pedidoLiBruto } from '@/lib/lojaIntegrada/testing/pedidosLi';
import { espiarConsole, respostaJson, textoDe } from '@/lib/lojaIntegrada/testing/rotas';

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  db: undefined as unknown,
  esperas: [] as number[],
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db,
}));
// The fake's increment sentinel (`testing/fakeDb.ts`), spelled inline: the factory is hoisted.
vi.mock('firebase-admin/firestore', async (original) => ({
  ...(await original<typeof import('firebase-admin/firestore')>()),
  FieldValue: { increment: (by: number) => ({ __increment: by }) },
}));
// The pacer's 2 s sleep, recorded instead of slept: the interval itself is the real one.
vi.mock('@/lib/lojaIntegrada/core/ritmo', async (original) => {
  const real = await original<typeof import('@/lib/lojaIntegrada/core/ritmo')>();
  return {
    ...real,
    ritmoDeLeituraLi: () => ({
      intervaloMs: real.RITMO_LEITURA_LI_MS,
      esperar: (ms: number) => {
        h.esperas.push(ms);
        return Promise.resolve();
      },
    }),
  };
});

const { GET } = await import('./route');

const URL_PEDIDOS = 'http://localhost:3010/api/marketplace/loja-integrada/pedidos';
/** The route's own log line, by its prefix. */
const LINHA_DA_ROTA = /^\[loja-integrada\/conferencia-pagamento\] /;
const CONTA = 'conta-li-pagamento-http';
const CONTA_REF = `documents/integracao/${CONTA}`;
const PEDIDO = idPedidoLi(CONTA, NUMERO_LI);
const CAMINHO = `pedidos/${PEDIDO}`;

/** May read pedidos — what the check needs, and all it needs. */
const LEITOR_PEDIDO = { uid: 'u-leitor-pedido', permissions: PERM.pedido.read.toString() };
/** May buy labels, but not read pedidos. */
const SO_FRETE = {
  uid: 'u-so-frete',
  permissions: (PERM.frete.read | PERM.frete.write).toString(),
};

/** Personal data the scripted order carries: none of it may reach an answer or a log line. */
const DADOS_PESSOAIS = [
  'Comprador de Teste',
  'comprador@example.com',
  '11999990000',
  'Recebedor de Teste',
  'Rua de Teste',
  '01310-100',
];

function semear(db: FakeDb, over: DocData = {}): void {
  seedConta(db, CONTA, { nome: 'Loja HTTP' });
  seedCredencial(db, CONTA);
  db.seed(CAMINHO, {
    estado: 'pago',
    integracaoPedidoOuterRef: CONTA_REF,
    numero: String(NUMERO_LI),
    freteInicial: { externalId: String(ID_ENVIO_LI), modalidade: '0' },
    ...over,
  });
}

async function abrirEspelho(db: FakeDb): Promise<void> {
  await sincronizarAvisosDoPedidoLi(
    asDb(db),
    {
      integracaoId: CONTA,
      lojaNome: 'Loja HTTP',
      pedidoId: PEDIDO,
      numero: String(NUMERO_LI),
      relogioUs: 1_000,
    },
    {
      situacaoDesconhecida: null,
      contestacao: MOTIVO_PEDIDO_CONTESTADO_LI.disputa,
      reversaoComEtiqueta: null,
      pagoSegueSemEndereco: false,
    },
    { increment, nowMs: Date.UTC(2027, 0, 15) },
  );
}

interface OpcoesGet {
  readonly semAuth?: boolean;
  readonly sinal?: AbortSignal;
}

function get(pedidoId: string, opts: OpcoesGet = {}) {
  const headers: Record<string, string> = {};
  if (opts.semAuth !== true) headers.authorization = 'Bearer id-token-de-teste';
  const req = new Request(`${URL_PEDIDOS}/${encodeURIComponent(pedidoId)}/pagamento`, {
    method: 'GET',
    headers,
    signal: opts.sinal,
  });
  return GET(req, { params: Promise.resolve({ pedidoId }) });
}

async function corpoDe(res: Response): Promise<unknown> {
  return (await res.json()) as unknown;
}

/** Answer every Loja Integrada call with `responder`; count them in `chamadasEsperadas`. */
function scriptarLoja(responder: () => Response | Promise<Response>): void {
  fetchFalso.mockImplementation(() => Promise.resolve(responder()));
}

/** The logger's lines on stdout, parsed: one JSON object per line. */
function linhasDeLog(): Record<string, unknown>[] {
  return stdout
    .escritas()
    .join('')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => z.record(z.string(), z.unknown()).parse(JSON.parse(l)));
}

let db: FakeDb;
let fetchFalso: Mock<typeof globalThis.fetch>;
let chamadasEsperadas: number;
let console_: ReturnType<typeof espiarConsole>;
let stdout: ReturnType<typeof espiarStdout>;

beforeEach(() => {
  vi.clearAllMocks();
  __resetAllReadCaches();
  h.esperas.length = 0;
  db = new FakeDb();
  h.db = asDb(db);
  h.verifyIdToken.mockResolvedValue(LEITOR_PEDIDO);
  fetchFalso = vi.fn<typeof globalThis.fetch>(() => {
    throw new Error('a conferência só chama a Loja Integrada quando o teste roteiriza');
  });
  vi.stubGlobal('fetch', fetchFalso);
  chamadasEsperadas = 0;
  console_ = espiarConsole();
  stdout = espiarStdout();
  // Every case starts with the switch as every environment has it until the window: unset.
  vi.stubEnv(CHAMADAS_ENV_LI, undefined);
});

afterEach(() => {
  console_.restaurar();
  stdout.restaurar();
  expect(fetchFalso).toHaveBeenCalledTimes(chamadasEsperadas);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  __resetAllReadCaches();
});

/* -------------------------------------------------------------------------- */
/*                         The caller and the id: no read                       */
/* -------------------------------------------------------------------------- */

describe('GET …/pedidos/[pedidoId]/pagamento — the caller and the id', () => {
  it('401 without a bearer token; 403 without pedido.read (frete.write is not it) — none of them reads anything', async () => {
    semear(db);

    expect((await get(PEDIDO, { semAuth: true })).status).toBe(401);
    h.verifyIdToken.mockResolvedValue(SO_FRETE);
    expect((await get(PEDIDO)).status).toBe(403);
    expect(db.leituras).toEqual([]);

    // The near-miss: pedido.read is exactly what checks — it reaches the pedido (and, with the
    // switch unset, the switch's 503).
    h.verifyIdToken.mockResolvedValue(LEITOR_PEDIDO);
    expect((await get(PEDIDO)).status).toBe(503);
    expect(db.leituras).toContain(CAMINHO);
  });

  it.each(['..', '.', 'a/b'])('400 LI_ID_INVALIDO for the id %j, before any read', async (id) => {
    const res = await get(id);

    expect(res.status).toBe(400);
    expect(erroContaLojaIntegradaSchema.parse(await corpoDe(res))).toMatchObject({
      code: CODIGO_ERRO_LI.idInvalido,
    });
    expect(db.leituras).toEqual([]);
  });

  it('404 LI_PEDIDO_NAO_ENCONTRADO for a pedido that does not exist', async () => {
    const res = await get(PEDIDO);

    expect(res.status).toBe(404);
    expect(erroContaLojaIntegradaSchema.parse(await corpoDe(res))).toMatchObject({
      code: CODIGO_ERRO_LI.pedidoNaoEncontrado,
    });
    expect(db.leituras).toEqual([CAMINHO]);
  });

  it('a pedido that is not an imported order ⇒ 200 `aplicavel: false` — with the switch ON, still zero calls', async () => {
    vi.stubEnv(CHAMADAS_ENV_LI, 'on');
    semear(db, { numero: null });

    const res = await get(PEDIDO);

    expect(res.status).toBe(200);
    expect(respostaConferenciaPagamentoLiSchema.parse(await corpoDe(res))).toEqual({
      aplicavel: false,
      motivo: MOTIVO_CONFERENCIA_NAO_APLICAVEL_LI.naoImportado,
    });
    expect(h.esperas).toEqual([]);
    expect(linhasDeLog()).toEqual([]);
    // Not a check at all: no warn line either.
    expect(console_.argumentos()).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                         The read switch OFF (D17)                           */
/* -------------------------------------------------------------------------- */

describe('GET …/pagamento — the read switch OFF: zero calls, the mirror, else 503', () => {
  it.each([
    ['unset', undefined],
    ['off', 'off'],
    ['ON', 'ON'],
    ['" on"', ' on'],
  ])(
    '%s, no open aviso ⇒ 503 LI_CHAMADAS_DESLIGADAS; fetch untouched; one `chamada-bloqueada` line under this flow',
    async (_caso, valor) => {
      vi.stubEnv(CHAMADAS_ENV_LI, valor);
      semear(db);

      const res = await get(PEDIDO);

      expect(res.status).toBe(503);
      expect(erroContaLojaIntegradaSchema.parse(await corpoDe(res))).toMatchObject({
        code: CODIGO_ERRO_LI.chamadasDesligadas,
      });
      expect(h.esperas).toEqual([]);
      expect(db.leituras).not.toContain(`integracao/${CONTA}`);
      expect(db.leituras).not.toContain(caminhoCredencial(CONTA));
      expect(db.escritas).toEqual([]);
      expect(linhasDeLog()).toEqual([
        expect.objectContaining({
          evento: 'chamada-bloqueada',
          conta: CONTA,
          fluxo: FLUXO_CONFERENCIA_PAGAMENTO_LI,
        }),
      ]);
    },
  );

  it('an OPEN contested aviso ⇒ 200 `contestado` from the ERP mirror, still zero calls', async () => {
    semear(db);
    await abrirEspelho(db);

    const res = await get(PEDIDO);

    expect(res.status).toBe(200);
    expect(respostaConferenciaPagamentoLiSchema.parse(await corpoDe(res))).toEqual({
      aplicavel: true,
      fonte: FONTE_CONFERENCIA_PAGAMENTO_LI.erp,
      veredito: VEREDITO_PAGAMENTO_LI.contestado,
      codigo: null,
      motivoContestacao: MOTIVO_PEDIDO_CONTESTADO_LI.disputa,
      conferidoEmMs: null,
      correlationId: null,
    });
  });

  it('each unverifiable answer logs ONE line with the caller and the cause — ids only', async () => {
    semear(db);
    await abrirEspelho(db);

    await get(PEDIDO);

    const linhas = console_.argumentos().filter((a) => textoDe(a).includes('conferencia'));
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.[1]).toEqual({
      pedidoId: PEDIDO,
      conta: CONTA,
      uid: LEITOR_PEDIDO.uid,
      causa: 'LiChamadasDesligadasError',
      espelho: 'contestado',
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                         The read switch ON: the live read                    */
/* -------------------------------------------------------------------------- */

describe('GET …/pagamento — the switch ON: one paced call, the verdict only', () => {
  beforeEach(() => {
    vi.stubEnv(CHAMADAS_ENV_LI, 'on');
  });

  it('a paid order ⇒ 200 `pago` from the store: ONE call after ONE 2 s wait, exactly the contract’s keys', async () => {
    semear(db);
    chamadasEsperadas = 1;
    scriptarLoja(() => respostaJson(200, pedidoLiBruto()));

    const res = await get(PEDIDO);

    expect(res.status).toBe(200);
    const texto = await res.text();
    const corpo = z.record(z.string(), z.unknown()).parse(JSON.parse(texto));
    expect(respostaConferenciaPagamentoLiSchema.parse(corpo)).toMatchObject({
      aplicavel: true,
      fonte: FONTE_CONFERENCIA_PAGAMENTO_LI.loja,
      veredito: VEREDITO_PAGAMENTO_LI.pago,
      codigo: 'pedido_pago',
      motivoContestacao: null,
    });
    expect(Object.keys(corpo).sort()).toEqual(
      [
        'aplicavel',
        'codigo',
        'conferidoEmMs',
        'correlationId',
        'fonte',
        'motivoContestacao',
        'veredito',
      ].sort(),
    );
    for (const dado of DADOS_PESSOAIS) expect(texto).not.toContain(dado);
    expect(h.esperas).toEqual([2_000]);
    const url = String(fetchFalso.mock.calls[0]?.[0]);
    expect(new URL(url).pathname).toMatch(new RegExp(`/v1/pedido/${String(NUMERO_LI)}/$`));
  });

  it('⚠️ the live answer WINS: a live `pago` with an open contested aviso is `pago`', async () => {
    semear(db);
    await abrirEspelho(db);
    chamadasEsperadas = 1;
    scriptarLoja(() => respostaJson(200, pedidoLiBruto()));

    const res = await get(PEDIDO);

    expect(respostaConferenciaPagamentoLiSchema.parse(await corpoDe(res))).toMatchObject({
      fonte: FONTE_CONFERENCIA_PAGAMENTO_LI.loja,
      veredito: VEREDITO_PAGAMENTO_LI.pago,
    });
  });

  it('a dispute live ⇒ 200 `nao-pago` with its motivo', async () => {
    semear(db);
    chamadasEsperadas = 1;
    scriptarLoja(() =>
      respostaJson(
        200,
        pedidoLiBruto({ situacao: { codigo: 'pagamento_em_disputa', id: 6, aprovado: true } }),
      ),
    );

    const res = await get(PEDIDO);

    expect(respostaConferenciaPagamentoLiSchema.parse(await corpoDe(res))).toMatchObject({
      veredito: VEREDITO_PAGAMENTO_LI.naoPago,
      codigo: 'pagamento_em_disputa',
      motivoContestacao: MOTIVO_PEDIDO_CONTESTADO_LI.disputa,
    });
  });

  it.each<[string, () => Response, number, string]>([
    ['429', () => respostaJson(429, { erro: 'limite' }), 503, CODIGO_ERRO_LI.limiteDeChamadas],
    ['500', () => respostaJson(500, { erro: 'falha' }), 502, CODIGO_ERRO_LI.lojaIndisponivel],
    ['404', () => respostaJson(404, { erro: 'x' }), 409, CODIGO_ERRO_LI.pedidoAusenteNaLoja],
    [
      'another numero',
      () => respostaJson(200, pedidoLiBruto({ numero: NUMERO_LI + 1 })),
      502,
      CODIGO_ERRO_LI.pedidoDivergente,
    ],
  ])(
    'Loja Integrada answers %s ⇒ %s %s, in the envelope, one call',
    async (_caso, responder, status, code) => {
      semear(db);
      chamadasEsperadas = 1;
      scriptarLoja(responder);

      const res = await get(PEDIDO);

      expect(res.status).toBe(status);
      const texto = await res.text();
      expect(erroContaLojaIntegradaSchema.parse(JSON.parse(texto))).toMatchObject({ code });
      for (const dado of DADOS_PESSOAIS) expect(texto).not.toContain(dado);
      for (const dado of DADOS_PESSOAIS) expect(textoDe(console_.argumentos())).not.toContain(dado);
    },
  );

  it('a 401 ⇒ the conta is PARKED and the answer is 409 LI_RECONEXAO_PENDENTE', async () => {
    semear(db);
    chamadasEsperadas = 1;
    scriptarLoja(() => respostaJson(401, { erro: 'token' }));

    const res = await get(PEDIDO);

    expect(res.status).toBe(409);
    expect(erroContaLojaIntegradaSchema.parse(await corpoDe(res))).toMatchObject({
      code: CODIGO_ERRO_LI.reconexaoPendente,
    });
    expect(db.ler(caminhoCredencial(CONTA))?.reconexaoPendente).toMatchObject({ status: 401 });
  });

  it('the caller going away during the call ⇒ 499 with an empty body', async () => {
    semear(db);
    const controller = new AbortController();
    chamadasEsperadas = 1;
    fetchFalso.mockImplementation((_url: unknown, init?: RequestInit) => {
      controller.abort(new Error('o navegador desistiu'));
      return Promise.reject(init?.signal?.reason);
    });

    const res = await get(PEDIDO, { sinal: controller.signal });

    expect(res.status).toBe(499);
    expect(await res.text()).toBe('');
  });

  it('⚠️ NEAR-MISS: a DIFFERENT error thrown after the abort is rethrown (500), never a 499', async () => {
    semear(db);
    const controller = new AbortController();
    const outro = new RangeError('outra falha');
    chamadasEsperadas = 1;
    fetchFalso.mockImplementation(() => {
      controller.abort(new Error('o navegador desistiu'));
      return Promise.reject(outro);
    });

    await expect(get(PEDIDO, { sinal: controller.signal })).rejects.toBe(outro);
  });

  it('a Firestore failure is rethrown (a 500), never answered as a verdict', async () => {
    semear(db);
    const falha = grpc(14, 'UNAVAILABLE');
    db.falharLeitura(CAMINHO, falha);

    await expect(get(PEDIDO)).rejects.toBe(falha);
  });

  it.each([400, 301])(
    'Loja Integrada answers %i (not this route’s to map) with an OPEN contested aviso ⇒ 200 `contestado` from the mirror, never a 500 the gates would confirm past',
    async (status) => {
      semear(db);
      await abrirEspelho(db);
      chamadasEsperadas = 1;
      scriptarLoja(() => respostaJson(status, { erro: 'x' }));

      const res = await get(PEDIDO);

      expect(res.status).toBe(200);
      expect(respostaConferenciaPagamentoLiSchema.parse(await corpoDe(res))).toMatchObject({
        fonte: FONTE_CONFERENCIA_PAGAMENTO_LI.erp,
        veredito: VEREDITO_PAGAMENTO_LI.contestado,
        motivoContestacao: MOTIVO_PEDIDO_CONTESTADO_LI.disputa,
      });
      expect(console_.argumentos()).toEqual([
        [
          expect.stringMatching(LINHA_DA_ROTA),
          {
            pedidoId: PEDIDO,
            conta: CONTA,
            uid: LEITOR_PEDIDO.uid,
            causa: 'LiHttpError',
            espelho: 'contestado',
          },
        ],
      ]);
    },
  );

  it.each([400, 301])(
    '⚠️ NEAR-MISS: Loja Integrada answers %i with NO open aviso ⇒ the LiHttpError itself is rethrown (a 500)',
    async (status) => {
      semear(db);
      chamadasEsperadas = 1;
      scriptarLoja(() => respostaJson(status, { erro: 'x' }));

      const erro: unknown = await get(PEDIDO).then(
        () => null,
        (err: unknown) => err,
      );

      expect(erro).toBeInstanceOf(LiHttpError);
      expect(erro).toMatchObject({ status });
    },
  );
});

/* -------------------------------------------------------------------------- */
/*            The log line: every check without a live verdict                 */
/* -------------------------------------------------------------------------- */

describe('GET …/pagamento — ONE warn line for every check that ends without a live verdict, none otherwise', () => {
  const campos = (causa: string, espelho: string | null) => ({
    pedidoId: PEDIDO,
    conta: CONTA,
    uid: LEITOR_PEDIDO.uid,
    causa,
    espelho,
  });

  it('the switch off, no open aviso ⇒ one warn: the switch as the cause, the mirror read and empty', async () => {
    semear(db);

    expect((await get(PEDIDO)).status).toBe(503);

    expect(console_.argumentos()).toEqual([
      [
        expect.stringMatching(LINHA_DA_ROTA),
        campos('LiChamadasDesligadasError', 'sem-contestacao'),
      ],
    ]);
    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(1);
  });

  it('Loja Integrada answers 429 ⇒ one warn: the route’s code as the cause, the mirror read and empty', async () => {
    vi.stubEnv(CHAMADAS_ENV_LI, 'on');
    semear(db);
    chamadasEsperadas = 1;
    scriptarLoja(() => respostaJson(429, { erro: 'limite' }));

    expect((await get(PEDIDO)).status).toBe(503);

    expect(console_.argumentos()).toEqual([
      [
        expect.stringMatching(LINHA_DA_ROTA),
        campos(CODIGO_ERRO_LI.limiteDeChamadas, 'sem-contestacao'),
      ],
    ]);
    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(1);
  });

  it('⚠️ NEAR-MISS: Loja Integrada answers 404 (not authorised) ⇒ one warn whose mirror is `null` — never read', async () => {
    vi.stubEnv(CHAMADAS_ENV_LI, 'on');
    semear(db);
    chamadasEsperadas = 1;
    scriptarLoja(() => respostaJson(404, { erro: 'x' }));

    expect((await get(PEDIDO)).status).toBe(409);

    expect(console_.argumentos()).toEqual([
      [expect.stringMatching(LINHA_DA_ROTA), campos(CODIGO_ERRO_LI.pedidoAusenteNaLoja, null)],
    ]);
    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(1);
  });

  it('⚠️ NEAR-MISS: a live verdict ⇒ no console line at all', async () => {
    vi.stubEnv(CHAMADAS_ENV_LI, 'on');
    semear(db);
    chamadasEsperadas = 1;
    scriptarLoja(() => respostaJson(200, pedidoLiBruto()));

    expect((await get(PEDIDO)).status).toBe(200);

    expect(console_.argumentos()).toEqual([]);
  });
});
