/**
 * The paid re-check's core (`conferenciaPagamento.ts`), against `testing/fakeDb.ts`, the REAL
 * context loader, the REAL package client and the REAL aviso writer (`avisosPedidoLi.ts`), so the
 * mirror is read under exactly the key the import writes.
 *
 * Nothing reaches the network (D17): every case stubs the GLOBAL `fetch` to throw for the whole
 * file, and a case that needs Loja Integrada hands the context a scripted `deps.fetch` (the
 * `plataformaLi` double) — the call counts below are exact, both of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  LiAuthError,
  LiConfigError,
  LiError,
  LiHttpError,
  LiNetworkError,
  LiNotFoundError,
  LiPaginacaoError,
  LiSchemaError,
  LiThrottleError,
  LiTimeoutError,
  PRAZO_LI_MS,
  type ContextoRequisicaoLi,
} from '@delfrance/integrations-loja-integrada';
import {
  CODIGO_ERRO_LI,
  FONTE_CONFERENCIA_PAGAMENTO_LI,
  MOTIVO_CONFERENCIA_NAO_APLICAVEL_LI,
  MOTIVO_PEDIDO_CONTESTADO_LI,
  TIPO_AVISO,
  VEREDITO_PAGAMENTO_LI,
  respostaConferenciaPagamentoLiSchema,
  type MotivoPedidoContestadoLi,
} from '@delfrance/schemas';

import { chaveReconexao } from '../avisos/avisos';
import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import {
  LiChamadasDesligadasError,
  LiContaInativaError,
  LiContaNaoEncontradaError,
  LiContaParadaError,
  LiCredencialAlteradaError,
  LiCredencialAusenteError,
  LiCredencialInvalidaError,
  LiEstacionamentoEmConflitoError,
} from '../core/erros';
import { RITMO_LEITURA_LI_MS } from '../core/ritmo';
import { CHAMADAS_ENV_LI } from '../core/valvulas';
import { FakeDb, asDb, grpc, increment, type DocData } from '../testing/fakeDb';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  TOKEN_B,
  caminhoAviso,
  caminhoCredencial,
  gravadorDeLog,
  loggerEspiao,
  ritmoFalso,
  seedConta,
  seedCredencial,
} from '../testing/fixtures';
import {
  ID_ENVIO_LI,
  NUMERO_LI,
  pedidoLiBruto,
  plataformaLi,
  type RespostaRoteirizadaLi,
} from '../testing/pedidosLi';
import { chaveDoAvisoDoPedidoLi, sincronizarAvisosDoPedidoLi } from './avisosPedidoLi';
import {
  FLUXO_CONFERENCIA_PAGAMENTO_LI,
  conferirPagamentoLi,
  falhaDaLeituraLi,
  type ConferenciaPagamentoDeps,
  type ResultadoConferenciaPagamentoLi,
} from './conferenciaPagamento';
import { idPedidoLi } from './orderIdsLi';

const CONTA = 'conta-li-pagamento';
const CONTA_REF = `documents/integracao/${CONTA}`;
const PEDIDO_ID = idPedidoLi(CONTA, NUMERO_LI);
const CAMINHO_PEDIDO = `pedidos/${PEDIDO_ID}`;
const CAMINHO_ESPELHO = caminhoAviso(
  chaveDoAvisoDoPedidoLi(TIPO_AVISO.lojaIntegradaPedidoContestado, CONTA, PEDIDO_ID),
);
const URL_DETALHE = `/v1/pedido/${String(NUMERO_LI)}/`;

/** Personal data the scripted order carries: none of it may leave the core. */
const DADOS_PESSOAIS = [
  'Comprador de Teste',
  'comprador@example.com',
  '11999990000',
  'Recebedor de Teste',
  'Rua de Teste',
  '01310-100',
];

/** The pedido as the import writes it: `numero` as a string, the shipment id in `externalId`. */
function semearPedido(db: FakeDb, over: DocData = {}, freteOver: DocData = {}): void {
  db.seed(CAMINHO_PEDIDO, {
    estado: 'pago',
    integracaoPedidoOuterRef: CONTA_REF,
    numero: String(NUMERO_LI),
    freteInicial: { externalId: String(ID_ENVIO_LI), modalidade: '0', ...freteOver },
    ...over,
  });
}

let db: FakeDb;
let globalFetch: ReturnType<typeof vi.fn>;
let pacer: ReturnType<typeof ritmoFalso>;
let gravador: ReturnType<typeof gravadorDeLog>;
let logger: ReturnType<typeof loggerEspiao>;

/** A platform answering the order detail with `detalhe` (a body, or a status and a body). */
function plataforma(detalhe: () => RespostaRoteirizadaLi | DocData = () => pedidoLiBruto()) {
  return plataformaLi({ pedidos: new Map([[NUMERO_LI, detalhe]]), historicos: new Map() });
}

function deps(over: Partial<ConferenciaPagamentoDeps> = {}): ConferenciaPagamentoDeps {
  return {
    db: asDb(db),
    ambiente: AMBIENTE_LIGADO,
    ritmo: pacer.ritmo,
    agoraMs: () => AGORA_MS,
    increment,
    logger: logger.logger,
    escrever: gravador.escrever,
    ...over,
  };
}

/** Open (or, with `null`, resolve) the contested mirror through the import's own writer. */
async function espelhar(motivo: MotivoPedidoContestadoLi | null, relogioUs: number): Promise<void> {
  await sincronizarAvisosDoPedidoLi(
    asDb(db),
    {
      integracaoId: CONTA,
      lojaNome: 'Loja Pagamento',
      pedidoId: PEDIDO_ID,
      numero: String(NUMERO_LI),
      relogioUs,
    },
    {
      situacaoDesconhecida: null,
      contestacao: motivo,
      reversaoComEtiqueta: null,
      pagoSegueSemEndereco: false,
    },
    { increment, nowMs: AGORA_MS },
  );
}

/** The mirror's reads since `desde` (a `db.leituras.length` taken before the check). */
function leiturasDoEspelho(desde = 0): string[] {
  return db.leituras.slice(desde).filter((c) => c === CAMINHO_ESPELHO);
}

/** The outcome's wire answer — parsed through the contract, as the route sends it. */
function resposta(r: ResultadoConferenciaPagamentoLi) {
  if (r.tipo !== 'resposta') throw new TypeError(`esperava uma resposta, veio ${r.tipo}`);
  return respostaConferenciaPagamentoLiSchema.parse(r.resposta);
}

/** The outcome's failure, by what the route will answer with. */
function falhaDe(r: ResultadoConferenciaPagamentoLi) {
  if (r.tipo !== 'falha') throw new TypeError(`esperava uma falha, veio ${r.tipo}`);
  return r.falha;
}

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  db = new FakeDb();
  pacer = ritmoFalso();
  gravador = gravadorDeLog();
  logger = loggerEspiao();
  // The file-level guard: the global `fetch` throws unless nothing calls it.
  globalFetch = vi.fn(() => {
    throw new Error('a conferência não chama a Loja Integrada fora do fetch roteirizado');
  });
  vi.stubGlobal('fetch', globalFetch);
  seedConta(db, CONTA, { nome: 'Loja Pagamento' });
  seedCredencial(db, CONTA);
});

afterEach(() => {
  expect(globalFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
});

/* -------------------------------------------------------------------------- */
/*                  ERP reads first: the pedido and its identity               */
/* -------------------------------------------------------------------------- */

describe('the pedido and its identity — ERP reads only, before the read switch', () => {
  it('no pedido with this id ⇒ `pedido-nao-encontrado`: one read, no context, no call', async () => {
    const p = plataforma();

    const r = await conferirPagamentoLi(deps({ fetch: p.fetch }), PEDIDO_ID);

    expect(r).toEqual({ tipo: 'pedido-nao-encontrado' });
    expect(db.leituras).toEqual([CAMINHO_PEDIDO]);
    expect(p.urls).toEqual([]);
    expect(pacer.esperas).toEqual([]);
    expect(gravador.linhas).toEqual([]);
  });

  it.each<[string, DocData]>([
    ['no conta ref', { integracaoPedidoOuterRef: null }],
    ['a conta ref to another collection', { integracaoPedidoOuterRef: `int_frete/${CONTA}` }],
    ["a duplicate's null numero", { numero: null }],
    ['a padded numero', { numero: `0${String(NUMERO_LI)}` }],
    ['a fractional numero', { numero: `${String(NUMERO_LI)}.0` }],
  ])(
    '%s ⇒ `aplicavel: false` with the switch ON — zero calls, no context, no waits, no line',
    async (_caso, over) => {
      semearPedido(db, over);
      const p = plataforma();

      const r = await conferirPagamentoLi(deps({ fetch: p.fetch }), PEDIDO_ID);

      expect(resposta(r)).toEqual({
        aplicavel: false,
        motivo: MOTIVO_CONFERENCIA_NAO_APLICAVEL_LI.naoImportado,
      });
      expect(db.leituras).toEqual([CAMINHO_PEDIDO]);
      expect(p.urls).toEqual([]);
      expect(pacer.esperas).toEqual([]);
      expect(gravador.linhas).toEqual([]);
    },
  );

  it('⚠️ NEAR-MISS: an id that is not the digest of its conta and numero (a duplicate, a devolução) ⇒ `aplicavel: false`, zero calls', async () => {
    const outroId = idPedidoLi(CONTA, NUMERO_LI + 1);
    db.seed(`pedidos/${outroId}`, {
      estado: 'pago',
      integracaoPedidoOuterRef: CONTA_REF,
      numero: String(NUMERO_LI),
      freteInicial: null,
    });
    const p = plataforma();

    const r = await conferirPagamentoLi(deps({ fetch: p.fetch }), outroId);

    expect(resposta(r)).toMatchObject({ aplicavel: false });
    expect(p.urls).toEqual([]);
    expect(db.leituras).toEqual([`pedidos/${outroId}`]);
  });

  it('⚠️ NEAR-MISS: the same numero under ANOTHER conta is another order ⇒ `aplicavel: false`', async () => {
    semearPedido(db, { integracaoPedidoOuterRef: 'documents/integracao/outra-conta' });
    const p = plataforma();

    const r = await conferirPagamentoLi(deps({ fetch: p.fetch }), PEDIDO_ID);

    expect(resposta(r)).toMatchObject({ aplicavel: false });
    expect(p.urls).toEqual([]);
  });

  it.each<[string, DocData]>([
    ['the numero stored as a NUMBER (a migrated pedido)', { numero: NUMERO_LI }],
    ['the conta ref in its bare form', { integracaoPedidoOuterRef: `integracao/${CONTA}` }],
  ])('EQUAL pair: %s is the same imported order — the live read runs', async (_caso, over) => {
    semearPedido(db, over);
    const p = plataforma();

    const r = await conferirPagamentoLi(deps({ fetch: p.fetch }), PEDIDO_ID);

    expect(resposta(r)).toMatchObject({ aplicavel: true, veredito: VEREDITO_PAGAMENTO_LI.pago });
    expect(p.urls).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                         The read switch, and the mirror                     */
/* -------------------------------------------------------------------------- */

describe('the read switch OFF (D17): no call, no client — the mirror, else 503', () => {
  it.each<[string, Record<string, string>]>([
    ['unset', {}],
    ['off', { [CHAMADAS_ENV_LI]: 'off' }],
    ['ON', { [CHAMADAS_ENV_LI]: 'ON' }],
  ])(
    '%s, no open aviso ⇒ the switch refusal; the mirror read; zero calls, zero waits, no conta read',
    async (_caso, ambiente) => {
      semearPedido(db);
      const p = plataforma();

      const r = await conferirPagamentoLi(deps({ ambiente, fetch: p.fetch }), PEDIDO_ID);

      const falha = falhaDe(r);
      expect(falha).toMatchObject({ tipo: 'conta', classe: 'configuracao' });
      expect(falha.tipo === 'conta' && falha.erro).toBeInstanceOf(LiChamadasDesligadasError);
      expect(p.urls).toEqual([]);
      expect(pacer.esperas).toEqual([]);
      // ERP reads only: the pedido, then the mirror — never the conta nor its credential.
      expect(db.leituras).toEqual([CAMINHO_PEDIDO, CAMINHO_ESPELHO]);
      expect(db.escritas).toEqual([]);
      // The switch's one `chamada-bloqueada` line, under this flow and this conta.
      expect(gravador.linhas).toHaveLength(1);
      expect(gravador.linhas[0]?.campos).toMatchObject({
        evento: 'chamada-bloqueada',
        conta: CONTA,
        fluxo: FLUXO_CONFERENCIA_PAGAMENTO_LI,
      });
    },
  );

  it('an OPEN contested aviso ⇒ 200 `contestado` from the ERP mirror, its motivo, nothing live', async () => {
    semearPedido(db);
    await espelhar(MOTIVO_PEDIDO_CONTESTADO_LI.chargeback, 1_000);
    const p = plataforma();

    const r = await conferirPagamentoLi(deps({ ambiente: {}, fetch: p.fetch }), PEDIDO_ID);

    expect(resposta(r)).toEqual({
      aplicavel: true,
      fonte: FONTE_CONFERENCIA_PAGAMENTO_LI.erp,
      veredito: VEREDITO_PAGAMENTO_LI.contestado,
      codigo: null,
      motivoContestacao: MOTIVO_PEDIDO_CONTESTADO_LI.chargeback,
      conferidoEmMs: null,
      correlationId: null,
    });
    // What made the live read impossible rides along for the route's log line.
    expect(r).toMatchObject({ tipo: 'resposta', contaId: CONTA });
    expect(r.tipo === 'resposta' && r.naoVerificavel?.tipo === 'conta').toBe(true);
    expect(p.urls).toEqual([]);
  });

  it('⚠️ NEAR-MISS: a RESOLVED contested aviso is no hold ⇒ the switch refusal', async () => {
    semearPedido(db);
    await espelhar(MOTIVO_PEDIDO_CONTESTADO_LI.disputa, 1_000);
    await espelhar(null, 2_000);
    const marca = db.leituras.length;

    const r = await conferirPagamentoLi(deps({ ambiente: {} }), PEDIDO_ID);

    expect(falhaDe(r)).toMatchObject({ tipo: 'conta' });
    expect(r).toMatchObject({ espelhoLido: true });
    expect(leiturasDoEspelho(marca)).toHaveLength(1);
  });

  it("⚠️ NEAR-MISS: another pedido's open aviso is not this pedido's hold", async () => {
    semearPedido(db);
    await sincronizarAvisosDoPedidoLi(
      asDb(db),
      {
        integracaoId: CONTA,
        lojaNome: 'Loja Pagamento',
        pedidoId: idPedidoLi(CONTA, NUMERO_LI + 1),
        numero: String(NUMERO_LI + 1),
        relogioUs: 1_000,
      },
      {
        situacaoDesconhecida: null,
        contestacao: MOTIVO_PEDIDO_CONTESTADO_LI.disputa,
        reversaoComEtiqueta: null,
        pagoSegueSemEndereco: false,
      },
      { increment, nowMs: AGORA_MS },
    );

    expect(falhaDe(await conferirPagamentoLi(deps({ ambiente: {} }), PEDIDO_ID))).toMatchObject({
      tipo: 'conta',
    });
  });

  it('a motivo this build does not know reads as `null`, never as a parse failure', async () => {
    semearPedido(db);
    db.seed(CAMINHO_ESPELHO, {
      tipo: TIPO_AVISO.lojaIntegradaPedidoContestado,
      motivo: 'motivo-de-um-backend-mais-novo',
      resolvidoEm: null,
    });

    const r = await conferirPagamentoLi(deps({ ambiente: {} }), PEDIDO_ID);

    expect(resposta(r)).toMatchObject({
      veredito: VEREDITO_PAGAMENTO_LI.contestado,
      motivoContestacao: null,
    });
  });

  it('a mirror read that fails is rethrown (a 500), never read as "no hold"', async () => {
    semearPedido(db);
    const falha = grpc(14, 'UNAVAILABLE');
    db.falharLeitura(CAMINHO_ESPELHO, falha);

    await expect(conferirPagamentoLi(deps({ ambiente: {} }), PEDIDO_ID)).rejects.toBe(falha);
  });
});

/* -------------------------------------------------------------------------- */
/*                               The live read                                 */
/* -------------------------------------------------------------------------- */

describe('the live read (switch ON): one paced call, its verdict, nothing else', () => {
  it('`pedido_pago` ⇒ 200 `pago` from the store: one call, ONE 2 s wait before it, no mirror read', async () => {
    semearPedido(db);
    const p = plataforma();

    const r = await conferirPagamentoLi(deps({ fetch: p.fetch }), PEDIDO_ID);

    const corpo = resposta(r);
    expect(corpo).toEqual({
      aplicavel: true,
      fonte: FONTE_CONFERENCIA_PAGAMENTO_LI.loja,
      veredito: VEREDITO_PAGAMENTO_LI.pago,
      codigo: 'pedido_pago',
      motivoContestacao: null,
      conferidoEmMs: AGORA_MS,
      correlationId: expect.any(String) as string,
    });
    expect(p.urls).toHaveLength(1);
    expect(new URL(p.urls[0] ?? '').pathname.endsWith(URL_DETALHE)).toBe(true);
    expect(pacer.esperas).toEqual([RITMO_LEITURA_LI_MS]);
    expect(leiturasDoEspelho()).toEqual([]);
    expect(db.escritas).toEqual([]);
    // The call's own line, under this flow.
    expect(gravador.linhas.map((l) => l.campos)).toEqual([
      expect.objectContaining({
        evento: 'chamada',
        conta: CONTA,
        fluxo: FLUXO_CONFERENCIA_PAGAMENTO_LI,
        operacao: 'buscarPedido',
      }),
    ]);
  });

  it("personal data from the order body never leaves the core — only the verdict, the codigo and the call's id", async () => {
    semearPedido(db);

    const r = await conferirPagamentoLi(deps({ fetch: plataforma().fetch }), PEDIDO_ID);

    const texto = JSON.stringify(r);
    for (const dado of DADOS_PESSOAIS) expect(texto).not.toContain(dado);
    expect(Object.keys(r.tipo === 'resposta' ? r.resposta : {}).sort()).toEqual(
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
  });

  it.each<[string, string, string, MotivoPedidoContestadoLi | null]>([
    ['awaiting payment', 'aguardando_pagamento', 'nao-pago', null],
    ['a dispute (still "aprovado" by the flags)', 'pagamento_em_disputa', 'nao-pago', 'disputa'],
    ['a chargeback', 'pedido_chargeback', 'nao-pago', 'chargeback'],
    ['a cancellation request', 'cancelamento_solicitado', 'nao-pago', null],
    ['an unknown codigo', 'codigo_que_ninguem_conhece', 'desconhecido', null],
    ['another case of a paid codigo', 'Pedido_Pago', 'desconhecido', null],
  ])('%s (%s) ⇒ %s, by the codigo alone', async (_caso, codigo, veredito, motivo) => {
    semearPedido(db);
    const p = plataforma(() =>
      pedidoLiBruto({
        situacao: { codigo, id: 99, aprovado: true, cancelado: false, final: false },
      }),
    );

    const r = await conferirPagamentoLi(deps({ fetch: p.fetch }), PEDIDO_ID);

    expect(resposta(r)).toMatchObject({
      fonte: FONTE_CONFERENCIA_PAGAMENTO_LI.loja,
      veredito,
      codigo,
      motivoContestacao: motivo,
    });
    expect(leiturasDoEspelho()).toEqual([]);
  });

  it('⚠️ the live answer WINS over the mirror: a live `pago` with an open contested aviso is `pago`, and the aviso is never read', async () => {
    semearPedido(db);
    await espelhar(MOTIVO_PEDIDO_CONTESTADO_LI.disputa, 1_000);
    const p = plataforma();

    const r = await conferirPagamentoLi(deps({ fetch: p.fetch }), PEDIDO_ID);

    expect(resposta(r)).toMatchObject({
      fonte: FONTE_CONFERENCIA_PAGAMENTO_LI.loja,
      veredito: VEREDITO_PAGAMENTO_LI.pago,
    });
    expect(leiturasDoEspelho()).toEqual([]);
    expect(p.urls).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                 The answer is about THIS order: numero and shipment         */
/* -------------------------------------------------------------------------- */

describe('the answer names this order — else 502 `pedidoDivergente`, and no mirror', () => {
  const divergente = {
    tipo: 'loja',
    classe: 'nao-autorizado',
    status: 502,
    code: CODIGO_ERRO_LI.pedidoDivergente,
  };

  it('⚠️ NEAR-MISS: another `numero` in the body ⇒ divergent, even with an open aviso (never read)', async () => {
    semearPedido(db);
    await espelhar(MOTIVO_PEDIDO_CONTESTADO_LI.disputa, 1_000);
    const p = plataforma(() => pedidoLiBruto({ numero: NUMERO_LI + 1 }));

    const r = await conferirPagamentoLi(deps({ fetch: p.fetch }), PEDIDO_ID);

    expect(falhaDe(r)).toMatchObject(divergente);
    expect(p.urls).toHaveLength(1);
    expect(leiturasDoEspelho()).toEqual([]);
  });

  it("⚠️ NEAR-MISS: another shipment id ⇒ divergent (another store's order under the same numero)", async () => {
    semearPedido(db, {}, { externalId: String(ID_ENVIO_LI + 1) });

    const r = await conferirPagamentoLi(deps({ fetch: plataforma().fetch }), PEDIDO_ID);

    expect(falhaDe(r)).toMatchObject(divergente);
  });

  it.each<[string, unknown]>([
    ['as the import stores it (a string)', String(ID_ENVIO_LI)],
    ['as a migrated NUMBER', ID_ENVIO_LI],
  ])(
    'EQUAL pair: the stored shipment id %s ≡ the live one ⇒ the verdict',
    async (_caso, externalId) => {
      semearPedido(db, {}, { externalId });

      const r = await conferirPagamentoLi(deps({ fetch: plataforma().fetch }), PEDIDO_ID);

      expect(resposta(r)).toMatchObject({ veredito: VEREDITO_PAGAMENTO_LI.pago });
    },
  );

  it.each<[string, DocData, () => DocData]>([
    ['no stored shipment id', { externalId: null }, () => pedidoLiBruto()],
    ['no freight block at all', {}, () => pedidoLiBruto()],
    ['no live shipment', {}, () => pedidoLiBruto({ envios: [] })],
    ['an unreadable stored shipment id', { externalId: '0801' }, () => pedidoLiBruto()],
  ])(
    'nothing to compare (%s) ⇒ only the numero check, then the verdict',
    async (caso, freteOver, corpo) => {
      if (caso === 'no freight block at all') semearPedido(db, { freteInicial: null });
      else semearPedido(db, {}, freteOver);

      const r = await conferirPagamentoLi(deps({ fetch: plataforma(corpo).fetch }), PEDIDO_ID);

      expect(resposta(r)).toMatchObject({ veredito: VEREDITO_PAGAMENTO_LI.pago });
    },
  );
});

/* -------------------------------------------------------------------------- */
/*                   When the read cannot run: the classes, end to end          */
/* -------------------------------------------------------------------------- */

describe('when the live read cannot run, the mirror is read; when it says "not authorised", it is not', () => {
  it.each<[string, RespostaRoteirizadaLi, number, string]>([
    ['429', { status: 429, corpo: { erro: 'limite' } }, 503, CODIGO_ERRO_LI.limiteDeChamadas],
    ['500', { status: 500, corpo: { erro: 'falha' } }, 502, CODIGO_ERRO_LI.lojaIndisponivel],
    ['521', { status: 521, corpo: 'origem fora' }, 502, CODIGO_ERRO_LI.lojaIndisponivel],
    [
      'a 200 off the schema',
      { status: 200, corpo: { numero: 'x' } },
      502,
      CODIGO_ERRO_LI.lojaIndisponivel,
    ],
  ])(
    'Loja Integrada answers %s ⇒ %s, after the mirror read; one call',
    async (_caso, roteiro, status, code) => {
      semearPedido(db);
      const p = plataforma(() => roteiro);

      const r = await conferirPagamentoLi(deps({ fetch: p.fetch }), PEDIDO_ID);

      expect(falhaDe(r)).toMatchObject({ tipo: 'loja', classe: 'transitorio', status, code });
      expect(p.urls).toHaveLength(1);
      expect(leiturasDoEspelho()).toHaveLength(1);
    },
  );

  it('a 5xx with an OPEN contested aviso ⇒ `contestado` from the mirror', async () => {
    semearPedido(db);
    await espelhar(MOTIVO_PEDIDO_CONTESTADO_LI.disputa, 1_000);
    const p = plataforma(() => ({ status: 503, corpo: { erro: 'fora' } }));

    const r = await conferirPagamentoLi(deps({ fetch: p.fetch }), PEDIDO_ID);

    expect(resposta(r)).toMatchObject({
      fonte: FONTE_CONFERENCIA_PAGAMENTO_LI.erp,
      veredito: VEREDITO_PAGAMENTO_LI.contestado,
      motivoContestacao: MOTIVO_PEDIDO_CONTESTADO_LI.disputa,
    });
    expect(r.tipo === 'resposta' && r.naoVerificavel).toMatchObject({
      code: CODIGO_ERRO_LI.lojaIndisponivel,
    });
  });

  it('a network failure ⇒ 502 `lojaIndisponivel`, after the mirror read', async () => {
    semearPedido(db);
    const fetch = vi.fn(() => Promise.reject(new TypeError('fetch failed')));

    const r = await conferirPagamentoLi(deps({ fetch }), PEDIDO_ID);

    expect(falhaDe(r)).toMatchObject({ status: 502, code: CODIGO_ERRO_LI.lojaIndisponivel });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(leiturasDoEspelho()).toHaveLength(1);
  });

  it('⚠️ NEAR-MISS: the deadline passing ⇒ 504 `tempoEsgotadoLoja`, never the network 502 (a timeout IS a network error)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    semearPedido(db);
    let chamou: () => void = () => undefined;
    const chamada = new Promise<void>((resolve) => {
      chamou = resolve;
    });
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      chamou();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason);
        });
      });
    });

    const pendente = conferirPagamentoLi(deps({ fetch }), PEDIDO_ID);
    await chamada;
    await vi.advanceTimersByTimeAsync(PRAZO_LI_MS.leitura);
    const r = await pendente;

    expect(falhaDe(r)).toMatchObject({
      tipo: 'loja',
      classe: 'transitorio',
      status: 504,
      code: CODIGO_ERRO_LI.tempoEsgotadoLoja,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(leiturasDoEspelho()).toHaveLength(1);
  });

  it('Loja Integrada answers 404 ⇒ 409 `pedidoAusenteNaLoja` (not authorised): the mirror is NOT read, even when open', async () => {
    semearPedido(db);
    await espelhar(MOTIVO_PEDIDO_CONTESTADO_LI.disputa, 1_000);
    const p = plataforma(() => ({ status: 404, corpo: { erro: 'nao encontrado' } }));

    const r = await conferirPagamentoLi(deps({ fetch: p.fetch }), PEDIDO_ID);

    expect(falhaDe(r)).toMatchObject({
      tipo: 'loja',
      classe: 'nao-autorizado',
      status: 409,
      code: CODIGO_ERRO_LI.pedidoAusenteNaLoja,
    });
    expect(leiturasDoEspelho()).toEqual([]);
  });

  it.each<[string, () => void, abstract new (...a: never[]) => Error]>([
    [
      'no conta',
      () => {
        db = new FakeDb();
        seedCredencial(db, CONTA);
      },
      LiContaNaoEncontradaError,
    ],
    ['an inactive conta', () => seedConta(db, CONTA, { ativo: false }), LiContaInativaError],
    [
      'no credential stored',
      () => {
        db = new FakeDb();
        seedConta(db, CONTA);
      },
      LiCredencialAusenteError,
    ],
    [
      'a corrupt credential',
      () => db.seed(caminhoCredencial(CONTA), { personalToken: 42 }),
      LiCredencialInvalidaError,
    ],
    [
      'a parked conta',
      () =>
        seedCredencial(db, CONTA, {
          reconexaoPendente: { desdeMs: AGORA_MS, status: 401, refCredencial: 'a.1' },
        }),
      LiContaParadaError,
    ],
  ])(
    'the context refuses (%s) ⇒ that app error, zero calls, zero waits, after the mirror read',
    async (_caso, preparar, classe) => {
      preparar();
      semearPedido(db);
      const p = plataforma();

      const r = await conferirPagamentoLi(deps({ fetch: p.fetch }), PEDIDO_ID);

      const falha = falhaDe(r);
      expect(falha).toMatchObject({ tipo: 'conta', classe: 'configuracao' });
      expect(falha.tipo === 'conta' && falha.erro).toBeInstanceOf(classe);
      expect(p.urls).toEqual([]);
      expect(pacer.esperas).toEqual([]);
      expect(leiturasDoEspelho()).toHaveLength(1);
    },
  );
});

describe('a 401/403: park the conta, then answer as the park found it', () => {
  it('a 401 for the stored token ⇒ the conta is PARKED, the reconexão aviso raised, 409 `reconexaoPendente`', async () => {
    semearPedido(db);
    const p = plataforma(() => ({ status: 401, corpo: { erro: 'token' } }));

    const r = await conferirPagamentoLi(deps({ fetch: p.fetch }), PEDIDO_ID);

    const falha = falhaDe(r);
    expect(falha).toMatchObject({ tipo: 'conta', classe: 'configuracao' });
    expect(falha.tipo === 'conta' && falha.erro).toBeInstanceOf(LiContaParadaError);
    expect(db.ler(caminhoCredencial(CONTA))?.reconexaoPendente).toMatchObject({
      status: 401,
      desdeMs: AGORA_MS,
    });
    expect(db.ler(caminhoAviso(chaveReconexao(CONTA)))).toMatchObject({ resolvidoEm: null });
    expect(p.urls).toHaveLength(1);
    expect(leiturasDoEspelho()).toHaveLength(1);
  });

  it('⚠️ NEAR-MISS: a 401 for a token REPLACED meanwhile ⇒ no park, 409 `credencialAlterada`', async () => {
    semearPedido(db);
    const p = plataforma(() => {
      // Another operator saves a new token while the call is in flight.
      seedCredencial(db, CONTA, { personalToken: TOKEN_B, tokenAtualizadoEmMs: AGORA_MS });
      return { status: 401, corpo: { erro: 'token' } };
    });

    const r = await conferirPagamentoLi(deps({ fetch: p.fetch }), PEDIDO_ID);

    const falha = falhaDe(r);
    expect(falha.tipo === 'conta' && falha.erro).toBeInstanceOf(LiCredencialAlteradaError);
    expect(db.ler(caminhoCredencial(CONTA))?.reconexaoPendente).toBeNull();
    expect(db.escritas).toEqual([]);
  });

  it('a 401 on a credential found corrupt while parking ⇒ `LiCredencialInvalidaError`, the mirror still read', async () => {
    semearPedido(db);
    const p = plataforma(() => {
      db.seed(caminhoCredencial(CONTA), { personalToken: 42 });
      return { status: 403, corpo: { erro: 'token' } };
    });

    const r = await conferirPagamentoLi(deps({ fetch: p.fetch }), PEDIDO_ID);

    const falha = falhaDe(r);
    expect(falha.tipo === 'conta' && falha.erro).toBeInstanceOf(LiCredencialInvalidaError);
    expect(leiturasDoEspelho()).toHaveLength(1);
  });

  it('the park losing its precondition every time ⇒ `LiEstacionamentoEmConflitoError`, transient', async () => {
    semearPedido(db);
    db.falharEscrita(caminhoCredencial(CONTA), grpc(9, 'FAILED_PRECONDITION'));
    const p = plataforma(() => ({ status: 401, corpo: { erro: 'token' } }));

    const r = await conferirPagamentoLi(deps({ fetch: p.fetch }), PEDIDO_ID);

    const falha = falhaDe(r);
    expect(falha).toMatchObject({ tipo: 'conta', classe: 'transitorio' });
    expect(falha.tipo === 'conta' && falha.erro).toBeInstanceOf(LiEstacionamentoEmConflitoError);
  });
});

/* -------------------------------------------------------------------------- */
/*                              The caller going away                          */
/* -------------------------------------------------------------------------- */

describe('the caller going away', () => {
  it('an abort during the call ⇒ `cancelado`: no mirror read, nothing written', async () => {
    semearPedido(db);
    const controller = new AbortController();
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      controller.abort(new Error('o navegador desistiu'));
      return Promise.reject(init?.signal?.reason);
    });

    const r = await conferirPagamentoLi(deps({ fetch, sinal: controller.signal }), PEDIDO_ID);

    expect(r).toEqual({ tipo: 'cancelado', contaId: CONTA });
    expect(leiturasDoEspelho()).toEqual([]);
    expect(db.escritas).toEqual([]);
  });

  it('a caller that already gave up is never called for: the abort lands after the wait, before the send', async () => {
    semearPedido(db);
    const controller = new AbortController();
    controller.abort(new Error('o navegador desistiu'));
    const p = plataforma();

    const r = await conferirPagamentoLi(
      deps({ fetch: p.fetch, sinal: controller.signal }),
      PEDIDO_ID,
    );

    expect(r).toMatchObject({ tipo: 'cancelado' });
    expect(p.urls).toEqual([]);
  });

  it('⚠️ NEAR-MISS: a DIFFERENT error thrown after the abort is rethrown, never `cancelado`', async () => {
    semearPedido(db);
    const controller = new AbortController();
    const outro = new RangeError('outra falha');
    const fetch = vi.fn(() => {
      controller.abort(new Error('o navegador desistiu'));
      return Promise.reject(outro);
    });

    await expect(
      conferirPagamentoLi(deps({ fetch, sinal: controller.signal }), PEDIDO_ID),
    ).rejects.toBe(outro);
  });

  it('a pedido read that fails is rethrown before anything else runs', async () => {
    const falha = grpc(14, 'UNAVAILABLE');
    db.falharLeitura(CAMINHO_PEDIDO, falha);

    await expect(conferirPagamentoLi(deps(), PEDIDO_ID)).rejects.toBe(falha);
    expect(pacer.esperas).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*            The route-local mapper: each class narrowed, the rest rethrown   */
/* -------------------------------------------------------------------------- */

describe('falhaDaLeituraLi — each class to its code; anything else is `null` (rethrown)', () => {
  const ctx: ContextoRequisicaoLi = {
    operacao: 'buscarPedido',
    caminho: URL_DETALHE,
    correlationId: 'corr-1',
    refCredencial: 'ref.1',
  };

  it.each<[string, unknown, Record<string, unknown>]>([
    [
      'LiThrottleError',
      new LiThrottleError({
        ...ctx,
        status: 429,
        escopo: 'desconhecido',
        codigosEncontrados: [],
        retryAfterS: null,
      }),
      { tipo: 'loja', classe: 'transitorio', status: 503, code: CODIGO_ERRO_LI.limiteDeChamadas },
    ],
    [
      'LiTimeoutError (before its parent)',
      new LiTimeoutError({ ...ctx, prazoMs: 20_000 }, null),
      { tipo: 'loja', classe: 'transitorio', status: 504, code: CODIGO_ERRO_LI.tempoEsgotadoLoja },
    ],
    [
      'LiNetworkError',
      new LiNetworkError(ctx, new TypeError('x')),
      { tipo: 'loja', classe: 'transitorio', status: 502, code: CODIGO_ERRO_LI.lojaIndisponivel },
    ],
    [
      'LiHttpError 503',
      new LiHttpError({ ...ctx, status: 503 }),
      { tipo: 'loja', classe: 'transitorio', status: 502, code: CODIGO_ERRO_LI.lojaIndisponivel },
    ],
    [
      'LiSchemaError',
      new LiSchemaError({ ...ctx, status: 200, motivo: 'formato', campos: ['numero'] }),
      { tipo: 'loja', classe: 'transitorio', status: 502, code: CODIGO_ERRO_LI.lojaIndisponivel },
    ],
    [
      'LiNotFoundError',
      new LiNotFoundError({ ...ctx, status: 404 }),
      {
        tipo: 'loja',
        classe: 'nao-autorizado',
        status: 409,
        code: CODIGO_ERRO_LI.pedidoAusenteNaLoja,
      },
    ],
    [
      'LiChamadasDesligadasError (an app error)',
      new LiChamadasDesligadasError(CONTA),
      { tipo: 'conta', classe: 'configuracao' },
    ],
    [
      'LiEstacionamentoEmConflitoError (an app error)',
      new LiEstacionamentoEmConflitoError(CONTA, 3),
      { tipo: 'conta', classe: 'transitorio' },
    ],
  ])('%s', (_nome, err, esperado) => {
    expect(falhaDaLeituraLi(err)).toMatchObject(esperado);
  });

  it.each<[string, unknown]>([
    ['the LiError base (never caught wholesale)', new LiError('x', { refCredencial: null })],
    [
      'LiConfigError (our own misconfiguration)',
      new LiConfigError('caminho', { operacao: 'x', refCredencial: null }),
    ],
    ['LiPaginacaoError', new LiPaginacaoError({ ...ctx, motivo: 'limite-de-paginas', paginas: 1 })],
    ['a non-transient LiHttpError (400)', new LiHttpError({ ...ctx, status: 400 })],
    [
      'LiAuthError (the park is the caller’s, before this mapper)',
      new LiAuthError({ ...ctx, status: 401 }),
    ],
    ['a gRPC failure', grpc(14, 'UNAVAILABLE')],
    ['a plain Error', new Error('x')],
    ['a TypeError', new TypeError('x')],
  ])('%s ⇒ null', (_nome, err) => {
    expect(falhaDaLeituraLi(err)).toBeNull();
  });

  it('no route-local message carries the call path, the numero or a correlation id', () => {
    const erros = [
      new LiThrottleError({
        ...ctx,
        status: 429,
        escopo: 'desconhecido',
        codigosEncontrados: [],
        retryAfterS: 3,
      }),
      new LiTimeoutError({ ...ctx, prazoMs: 20_000 }, null),
      new LiNetworkError(ctx, null),
      new LiSchemaError({ ...ctx, status: 200, motivo: 'formato', campos: ['numero'] }),
      new LiNotFoundError({ ...ctx, status: 404 }),
    ];
    for (const err of erros) {
      const falha = falhaDaLeituraLi(err);
      const mensagem = falha?.tipo === 'loja' ? falha.mensagem : '';
      expect(mensagem.length).toBeGreaterThan(0);
      expect(mensagem).not.toContain(URL_DETALHE);
      expect(mensagem).not.toContain(String(NUMERO_LI));
      expect(mensagem).not.toContain('corr-1');
    }
  });
});
