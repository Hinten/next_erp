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
  type AvisoRastreioLi,
  MOTIVO_RESOLUCAO_RASTREIO_LI,
  type PedidoDoAvisoRastreioLi,
  avisarRastreioDivergenteLi,
  chaveDoAvisoRastreioLi,
  resolverRastreioDivergenteLi,
  severidadeDoAvisoRastreioLi,
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
});

describe('the severity', () => {
  const C = CODIGO_SITUACAO_LI;
  /** The never-write codigos other than the cancellation request. */
  const OUTROS_NUNCA_ESCREVER = [
    C.pagamentoEmDisputa,
    C.pedidoCancelado,
    C.pagamentoDevolvido,
    C.pedidoChargeback,
    C.pagamentoDevolvidoSemRetorno,
  ];

  /** The severity the raise stored, through the REAL `escreverAviso`. */
  async function severidadeGravada(aviso: AvisoRastreioLi): Promise<unknown> {
    const db = new FakeDb();
    await avisarRastreioDivergenteLi(asDb(db), pedido(1_000), aviso, deps);
    return db.ler(caminho())?.severidade;
  }

  it('a situacao-sobrescrita flagged critico (a never-write codigo was overwritten) ⇒ critico; unflagged ⇒ atencao', async () => {
    expect(
      await severidadeGravada({
        motivo: M.situacaoSobrescrita,
        situacao: C.cancelamentoSolicitado,
        critico: true,
      }),
    ).toBe(SEVERIDADE_AVISO.critico);
    expect(
      await severidadeGravada({ motivo: M.situacaoSobrescrita, situacao: C.aguardandoPagamento }),
    ).toBe(SEVERIDADE_AVISO.atencao);
  });

  it('EQUAL: a write blocked because LI shows cancelamento_solicitado (1019, the buyer asked to cancel) ⇒ critico, with no flag', async () => {
    expect(
      await severidadeGravada({ motivo: M.situacaoBloqueada, situacao: C.cancelamentoSolicitado }),
    ).toBe(SEVERIDADE_AVISO.critico);
  });

  it.each(OUTROS_NUNCA_ESCREVER)(
    'NEAR-MISS: a write blocked at %s (another never-write codigo) ⇒ atencao — a critico flag on it is ignored',
    async (situacao) => {
      expect(await severidadeGravada({ motivo: M.situacaoBloqueada, situacao })).toBe(
        SEVERIDADE_AVISO.atencao,
      );
      expect(
        await severidadeGravada({ motivo: M.situacaoBloqueada, situacao, critico: true }),
      ).toBe(SEVERIDADE_AVISO.atencao);
    },
  );

  it.each([C.pedidoEfetuado, C.aguardandoPagamento, C.pagamentoEmAnalise])(
    'NEAR-MISS: a write refused because LI shows %s unpaid (situacao-nao-paga) ⇒ atencao',
    async (situacao) => {
      expect(
        await severidadeGravada({
          motivo: M.situacaoNaoPaga,
          situacao,
          estado: ESTADO_RASTREIO_LI.postado,
        }),
      ).toBe(SEVERIDADE_AVISO.atencao);
    },
  );

  it.each(['Cancelamento_Solicitado', 'cancelamento_solicitado ', ' cancelamento_solicitado'])(
    'NEAR-MISS: the codigo is compared EXACTLY — blocked at %j is not 1019 ⇒ atencao',
    async (situacao) => {
      expect(await severidadeGravada({ motivo: M.situacaoBloqueada, situacao })).toBe(
        SEVERIDADE_AVISO.atencao,
      );
    },
  );

  it.each([M.situacaoNaoPaga, M.situacaoDesconhecida, M.transicaoLateral, M.situacaoSobrescrita])(
    'NEAR-MISS: 1019 under %s (no flag) ⇒ atencao — only the BLOCKED write is decided by the codigo',
    async (motivo) => {
      expect(await severidadeGravada({ motivo, situacao: C.cancelamentoSolicitado })).toBe(
        SEVERIDADE_AVISO.atencao,
      );
    },
  );

  it('NEAR-MISS: a critico flag on any motivo but situacao-sobrescrita is ignored', async () => {
    expect(await severidadeGravada({ motivo: M.deriva, critico: true })).toBe(
      SEVERIDADE_AVISO.atencao,
    );
    expect(
      await severidadeGravada({
        motivo: M.situacaoNaoPaga,
        situacao: C.aguardandoPagamento,
        critico: true,
      }),
    ).toBe(SEVERIDADE_AVISO.atencao);
  });

  it('GRID: over every motivo × every codigo (and none) × the flag, critico ONLY at those two rules; atencao everywhere else', () => {
    const situacoes: readonly (string | null)[] = [...Object.values(C), null];
    const criticos = new Set<string>();
    for (const motivo of Object.values(M)) {
      for (const situacao of situacoes) {
        for (const critico of [false, true]) {
          const severidade = severidadeDoAvisoRastreioLi({ motivo, situacao, critico });
          if (severidade === SEVERIDADE_AVISO.critico) {
            criticos.add(`${motivo}|${String(situacao)}|${String(critico)}`);
          } else {
            expect(severidade).toBe(SEVERIDADE_AVISO.atencao);
          }
        }
      }
    }
    expect(criticos).toEqual(
      new Set([
        `${M.situacaoBloqueada}|${C.cancelamentoSolicitado}|false`,
        `${M.situacaoBloqueada}|${C.cancelamentoSolicitado}|true`,
        ...situacoes.map((s) => `${M.situacaoSobrescrita}|${String(s)}|true`),
      ]),
    );
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
