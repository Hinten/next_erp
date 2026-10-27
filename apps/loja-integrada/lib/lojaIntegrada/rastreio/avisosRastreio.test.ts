/**
 * The write-back aviso (`avisosRastreio.ts`) through the REAL `escreverAviso` /
 * `resolverAviso` against `testing/fakeDb.ts`: its key, its params, its
 * severity, and its EVENT clock — an older event can neither reopen nor close a
 * row a newer one wrote.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CANAL_AVISO,
  CODIGO_SITUACAO_LI,
  ESTADO_RASTREIO_LI,
  MOTIVO_RASTREIO_DIVERGENTE_LI,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  chaveDeAviso,
} from '@delfrance/schemas';

import { TIPOS_AVISO_LI, TIPOS_AVISO_PEDIDO_LI } from '../avisos/avisos';
import { FakeDb, asDb, increment } from '../testing/fakeDb';
import { AGORA_MS } from '../testing/fixtures';
import {
  MOTIVO_RESOLUCAO_RASTREIO_LI,
  type PedidoDoAvisoRastreioLi,
  avisarRastreioDivergenteLi,
  chaveDoAvisoRastreioLi,
  resolverRastreioDivergenteLi,
} from './avisosRastreio';

// D17, per file: nothing here may reach the global `fetch` (no client is built at all).
beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('avisosRastreio.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const CONTA = 'conta-li-1';
const PEDIDO_ID = '0123456789abcdef'.repeat(4);
const M = MOTIVO_RASTREIO_DIVERGENTE_LI;
const deps = { increment, nowMs: AGORA_MS };

function pedido(eventoEmMs: number): PedidoDoAvisoRastreioLi {
  return {
    integracaoId: CONTA,
    lojaNome: 'Loja X',
    pedidoId: PEDIDO_ID,
    numero: '165',
    eventoEmMs,
  };
}

const caminho = () => `avisos/${chaveDoAvisoRastreioLi(CONTA, PEDIDO_ID)}`;

describe('the key and the tipo lists', () => {
  it('one row per pedido of the conta', () => {
    expect(chaveDoAvisoRastreioLi(CONTA, PEDIDO_ID)).toBe(
      chaveDeAviso({
        tipo: TIPO_AVISO.lojaIntegradaRastreioDivergente,
        conta: CONTA,
        entidade: PEDIDO_ID,
      }),
    );
    expect(chaveDoAvisoRastreioLi(CONTA, PEDIDO_ID)).not.toBe(
      chaveDoAvisoRastreioLi(CONTA, 'f'.repeat(64)),
    );
  });

  it('it is a per-pedido tipo of this channel, so the orphan pass closes a gone conta’s rows', () => {
    expect(TIPOS_AVISO_PEDIDO_LI.has(TIPO_AVISO.lojaIntegradaRastreioDivergente)).toBe(true);
    expect(TIPOS_AVISO_LI.has(TIPO_AVISO.lojaIntegradaRastreioDivergente)).toBe(true);
  });
});

describe('the raise', () => {
  it('atencao, the pedido page, the params the wording reads, clocked by the EVENT in µs', async () => {
    const db = new FakeDb();
    await avisarRastreioDivergenteLi(
      asDb(db),
      pedido(1_789_000_000_123),
      {
        motivo: M.transicaoLateral,
        situacao: CODIGO_SITUACAO_LI.pedidoEntregue,
        estado: ESTADO_RASTREIO_LI.postado,
      },
      deps,
    );
    expect(db.ler(caminho())).toMatchObject({
      tipo: TIPO_AVISO.lojaIntegradaRastreioDivergente,
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.lojaIntegrada,
      params: {
        loja: 'Loja X',
        pedido: '165',
        motivo: 'transicao-lateral',
        situacao: 'pedido_entregue',
        estado: 'postado',
      },
      motivo: 'transicao-lateral',
      urlInterna: { rota: ROTAS_AVISO.pedido.build(PEDIDO_ID), campo: null },
      relogioEvento: 1_789_000_000_123_000,
      resolvidoEm: null,
    });
  });

  it('`escrita-recusada` carries the HTTP status as a number; no other param is written when absent', async () => {
    const db = new FakeDb();
    await avisarRastreioDivergenteLi(
      asDb(db),
      pedido(1_000),
      { motivo: M.escritaRecusada, status: 403 },
      deps,
    );
    expect(db.ler(caminho())?.params).toEqual({
      loja: 'Loja X',
      pedido: '165',
      motivo: 'escrita-recusada',
      status: 403,
    });
  });

  it('critico ONLY for a situacao-sobrescrita flagged critico (a never-write codigo was overwritten)', async () => {
    const db1 = new FakeDb();
    await avisarRastreioDivergenteLi(
      asDb(db1),
      pedido(1_000),
      {
        motivo: M.situacaoSobrescrita,
        situacao: CODIGO_SITUACAO_LI.cancelamentoSolicitado,
        critico: true,
      },
      deps,
    );
    expect(db1.ler(caminho())?.severidade).toBe(SEVERIDADE_AVISO.critico);

    const db2 = new FakeDb();
    await avisarRastreioDivergenteLi(
      asDb(db2),
      pedido(1_000),
      { motivo: M.situacaoSobrescrita, situacao: CODIGO_SITUACAO_LI.aguardandoPagamento },
      deps,
    );
    expect(db2.ler(caminho())?.severidade).toBe(SEVERIDADE_AVISO.atencao);

    // NEAR-MISS: a `critico` flag on any other motivo is ignored.
    const db3 = new FakeDb();
    await avisarRastreioDivergenteLi(
      asDb(db3),
      pedido(1_000),
      {
        motivo: M.situacaoBloqueada,
        situacao: CODIGO_SITUACAO_LI.cancelamentoSolicitado,
        critico: true,
      },
      deps,
    );
    expect(db3.ler(caminho())?.severidade).toBe(SEVERIDADE_AVISO.atencao);
  });
});

describe('the event clock', () => {
  it('a later clean event resolves; a LATE older raise cannot reopen it', async () => {
    const db = new FakeDb();
    await avisarRastreioDivergenteLi(asDb(db), pedido(1_000), { motivo: M.objetoDivergente }, deps);
    expect(await resolverRastreioDivergenteLi(asDb(db), pedido(2_000), deps)).toBe(true);
    expect(db.ler(caminho())).toMatchObject({
      resolucaoMotivo: MOTIVO_RESOLUCAO_RASTREIO_LI.refletido,
      relogioEvento: 2_000_000,
    });
    await avisarRastreioDivergenteLi(asDb(db), pedido(1_500), { motivo: M.deriva }, deps);
    expect(db.ler(caminho())?.resolvidoEm).not.toBeNull();
  });

  it('an OLDER clean event cannot close a newer raise', async () => {
    const db = new FakeDb();
    await avisarRastreioDivergenteLi(asDb(db), pedido(2_000), { motivo: M.deriva }, deps);
    expect(await resolverRastreioDivergenteLi(asDb(db), pedido(1_000), deps)).toBe(false);
    expect(db.ler(caminho())?.resolvidoEm).toBeNull();
  });

  it('a clean event with no row SEEDS a resolved one carrying its clock', async () => {
    const db = new FakeDb();
    expect(await resolverRastreioDivergenteLi(asDb(db), pedido(3_000), deps)).toBe(false);
    expect(db.ler(caminho())).toMatchObject({
      tipo: TIPO_AVISO.lojaIntegradaRastreioDivergente,
      relogioEvento: 3_000_000,
      params: { loja: 'Loja X', pedido: '165' },
    });
    expect(db.ler(caminho())?.resolvidoEm).not.toBeNull();
  });
});
