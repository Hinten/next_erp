/**
 * The four order-import avisos (`avisosPedidoLi.ts`) through the REAL
 * `escreverAviso` / `resolverAviso` against `testing/fakeDb.ts`: the keys, the
 * params each tipo's wording reads, and the clocks — a late observation can
 * neither reopen nor close a row, and the freight tipo is never resolved
 * clockless.
 */
import { describe, expect, it } from 'vitest';
import {
  CANAL_AVISO,
  MOTIVO_FRETE_NAO_SUPORTADO_LI,
  MOTIVO_PEDIDO_CONTESTADO_LI,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  chaveDeAviso,
} from '@delfrance/schemas';
import { sha256Hex } from '@delfrance/data/admin';

import { FakeDb, asDb, increment } from '../testing/fakeDb';
import { AGORA_MS } from '../testing/fixtures';
import { CHAVE_FORMA_ENVIO_LI } from '../testing/pedidosLi';
import {
  MOTIVO_RESOLUCAO_PEDIDO_LI,
  avisarPedidoPagoSemEnderecoLi,
  chaveDoAvisoDeFreteLi,
  chaveDoAvisoDoPedidoLi,
  sincronizarAvisoDeFreteLi,
  sincronizarAvisoDeHubLi,
  sincronizarAvisosDoPedidoLi,
  type PedidoDoAvisoLi,
} from './avisosPedidoLi';

const CONTA = 'conta-li-avisos';
const deps = { increment, nowMs: AGORA_MS };

function pedido(relogioUs: number): PedidoDoAvisoLi {
  return {
    integracaoId: CONTA,
    lojaNome: 'Loja X',
    pedidoId: 'pedido-1',
    numero: '9001',
    relogioUs,
  };
}

const caminho = (
  tipo:
    | typeof TIPO_AVISO.lojaIntegradaSituacaoDesconhecida
    | typeof TIPO_AVISO.lojaIntegradaPedidoContestado
    | typeof TIPO_AVISO.lojaIntegradaPedidoHub,
) => `avisos/${chaveDoAvisoDoPedidoLi(tipo, CONTA, 'pedido-1')}`;

describe('the keys', () => {
  it('order-keyed: one row per pedido of the conta', () => {
    expect(chaveDoAvisoDoPedidoLi(TIPO_AVISO.lojaIntegradaPedidoContestado, CONTA, 'p')).toBe(
      chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaPedidoContestado, conta: CONTA, entidade: 'p' }),
    );
    expect(chaveDoAvisoDoPedidoLi(TIPO_AVISO.lojaIntegradaPedidoHub, CONTA, 'p')).not.toBe(
      chaveDoAvisoDoPedidoLi(TIPO_AVISO.lojaIntegradaPedidoHub, CONTA, 'q'),
    );
  });

  it('the freight key is the digest of the FULL method key: equal keys one row, a near-miss another', () => {
    const chave = CHAVE_FORMA_ENVIO_LI;
    expect(chaveDoAvisoDeFreteLi(CONTA, chave)).toBe(
      chaveDeAviso({
        tipo: TIPO_AVISO.lojaIntegradaFreteNaoSuportado,
        conta: CONTA,
        entidade: sha256Hex(chave),
      }),
    );
    expect(chaveDoAvisoDeFreteLi(CONTA, chave)).toBe(chaveDoAvisoDeFreteLi(CONTA, chave));
    // The aviso key fold would merge these two; the digest keeps them apart.
    expect(chaveDoAvisoDeFreteLi(CONTA, '1---PAC.X')).not.toBe(
      chaveDoAvisoDeFreteLi(CONTA, '1---PAC_X'),
    );
    expect(chaveDoAvisoDeFreteLi(CONTA, '1---PAC')).not.toBe(
      chaveDoAvisoDeFreteLi(CONTA, '2---PAC'),
    );
  });
});

describe('the three order-clocked tipos', () => {
  it('an unknown codigo and a contestation RAISE with exactly the params the wording reads; the hub row resolves', async () => {
    const db = new FakeDb();
    const r = await sincronizarAvisosDoPedidoLi(
      asDb(db),
      pedido(1_000),
      { situacaoDesconhecida: 'codigo_novo', contestacao: MOTIVO_PEDIDO_CONTESTADO_LI.disputa },
      deps,
    );
    expect(r.situacao).toEqual({ acao: 'levantado', resultado: 'criado' });
    expect(r.contestado).toEqual({ acao: 'levantado', resultado: 'criado' });
    expect(r.hub).toEqual({ acao: 'resolvido', fechou: false });
    expect(db.ler(caminho(TIPO_AVISO.lojaIntegradaSituacaoDesconhecida))).toMatchObject({
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.lojaIntegrada,
      params: { loja: 'Loja X', pedido: '9001', codigo: 'codigo_novo' },
      relogioEvento: 1_000,
      urlInterna: { rota: '/pedidos/pedido-1/editar', campo: null },
      resolvidoEm: null,
    });
    expect(db.ler(caminho(TIPO_AVISO.lojaIntegradaPedidoContestado))).toMatchObject({
      params: { loja: 'Loja X', pedido: '9001', motivo: 'disputa' },
      motivo: 'disputa',
      relogioEvento: 1_000,
    });
    // A clocked resolve with no row SEEDS a resolved one carrying the clock.
    expect(db.ler(caminho(TIPO_AVISO.lojaIntegradaPedidoHub))).toMatchObject({
      relogioEvento: 1_000,
      resolucaoMotivo: MOTIVO_RESOLUCAO_PEDIDO_LI.semMarcaDeHub,
      urlInterna: { rota: `/canais/loja-integrada/${CONTA}`, campo: null },
    });
  });

  it('a newer known observation resolves; a LATE older raise cannot reopen it; an older resolve cannot close a newer raise', async () => {
    const db = new FakeDb();
    const semNada = { situacaoDesconhecida: null, contestacao: null };
    const desconhecida = { situacaoDesconhecida: 'codigo_novo', contestacao: null };
    await sincronizarAvisosDoPedidoLi(asDb(db), pedido(1_000), desconhecida, deps);
    const fechou = await sincronizarAvisosDoPedidoLi(asDb(db), pedido(2_000), semNada, deps);
    expect(fechou.situacao).toEqual({ acao: 'resolvido', fechou: true });
    // Late, older raise: dropped.
    const tardio = await sincronizarAvisosDoPedidoLi(asDb(db), pedido(1_500), desconhecida, deps);
    expect(tardio.situacao).toEqual({ acao: 'levantado', resultado: 'ignorado' });
    expect(
      db.ler(caminho(TIPO_AVISO.lojaIntegradaSituacaoDesconhecida))?.resolvidoEm,
    ).not.toBeNull();
    // A newer raise reopens; an older resolve then changes nothing.
    await sincronizarAvisosDoPedidoLi(asDb(db), pedido(3_000), desconhecida, deps);
    const velho = await sincronizarAvisosDoPedidoLi(asDb(db), pedido(2_500), semNada, deps);
    expect(velho.situacao).toEqual({ acao: 'resolvido', fechou: false });
    expect(db.ler(caminho(TIPO_AVISO.lojaIntegradaSituacaoDesconhecida))?.resolvidoEm).toBeNull();
  });

  it('an EQUAL clock is a no-op once stored (the retry after a crash between the batch and the avisos)', async () => {
    const db = new FakeDb();
    const desconhecida = { situacaoDesconhecida: 'codigo_novo', contestacao: null };
    await sincronizarAvisosDoPedidoLi(asDb(db), pedido(1_000), desconhecida, deps);
    const escritas = db.escritas.length;
    const r = await sincronizarAvisosDoPedidoLi(asDb(db), pedido(1_000), desconhecida, deps);
    expect(r.situacao).toEqual({ acao: 'levantado', resultado: 'ignorado' });
    expect(db.escritas.length).toBe(escritas);
  });
});

describe('the hub tipo', () => {
  it('raised on a live sale, resolved on a dead one (clocked)', async () => {
    const db = new FakeDb();
    expect(await sincronizarAvisoDeHubLi(asDb(db), pedido(1_000), false, deps)).toEqual({
      acao: 'levantado',
      resultado: 'criado',
    });
    expect(db.ler(caminho(TIPO_AVISO.lojaIntegradaPedidoHub))?.params).toEqual({
      loja: 'Loja X',
      pedido: '9001',
    });
    expect(await sincronizarAvisoDeHubLi(asDb(db), pedido(2_000), true, deps)).toEqual({
      acao: 'resolvido',
      fechou: true,
    });
    expect(db.ler(caminho(TIPO_AVISO.lojaIntegradaPedidoHub))?.resolucaoMotivo).toBe(
      MOTIVO_RESOLUCAO_PEDIDO_LI.vendaEncerrada,
    );
  });
});

describe('the freight tipo', () => {
  const chave = CHAVE_FORMA_ENVIO_LI;
  const caminhoFrete = `avisos/${chaveDoAvisoDeFreteLi(CONTA, chave)}`;

  it('raised with the motivo code, the row’s name and the raw key; resolved later at a newer read', async () => {
    const db = new FakeDb();
    await sincronizarAvisoDeFreteLi(
      asDb(db),
      {
        integracaoId: CONTA,
        lojaNome: 'Loja X',
        aviso: {
          tipo: 'levantar',
          chave,
          motivo: MOTIVO_FRETE_NAO_SUPORTADO_LI.alvoInativo,
          formaEnvio: 'Gateway',
        },
        relogioUs: 5_000,
      },
      deps,
    );
    expect(db.ler(caminhoFrete)).toMatchObject({
      params: { loja: 'Loja X', formaEnvio: 'Gateway', chave, motivo: 'alvo-inativo' },
      motivo: 'alvo-inativo',
      relogioEvento: 5_000,
      urlInterna: { rota: `/canais/loja-integrada/${CONTA}`, campo: null },
      resolvidoEm: null,
    });
    // A resolve from an OLDER read cannot close it.
    const velho = await sincronizarAvisoDeFreteLi(
      asDb(db),
      {
        integracaoId: CONTA,
        lojaNome: 'Loja X',
        aviso: { tipo: 'resolver', chave },
        relogioUs: 4_000,
      },
      deps,
    );
    expect(velho).toEqual({ acao: 'resolvido', fechou: false });
    const novo = await sincronizarAvisoDeFreteLi(
      asDb(db),
      {
        integracaoId: CONTA,
        lojaNome: 'Loja X',
        aviso: { tipo: 'resolver', chave },
        relogioUs: 6_000,
      },
      deps,
    );
    expect(novo).toEqual({ acao: 'resolvido', fechou: true });
  });

  it('a raise with no row name names the key; NO clock ⇒ nothing written at all (never clockless)', async () => {
    const db = new FakeDb();
    await sincronizarAvisoDeFreteLi(
      asDb(db),
      {
        integracaoId: CONTA,
        lojaNome: 'Loja X',
        aviso: {
          tipo: 'levantar',
          chave,
          motivo: MOTIVO_FRETE_NAO_SUPORTADO_LI.alvoAusente,
          formaEnvio: null,
        },
        relogioUs: 1,
      },
      deps,
    );
    expect(db.ler(caminhoFrete)?.params).toMatchObject({ formaEnvio: chave });
    const escritas = db.escritas.length;
    expect(
      await sincronizarAvisoDeFreteLi(
        asDb(db),
        {
          integracaoId: CONTA,
          lojaNome: 'Loja X',
          aviso: { tipo: 'resolver', chave },
          relogioUs: null,
        },
        deps,
      ),
    ).toEqual({ acao: 'nenhum' });
    expect(db.escritas.length).toBe(escritas);
    expect(db.ler(caminhoFrete)?.resolvidoEm).toBeNull();
  });
});

describe('the paid-without-address tipo (owner decision, 2026-10-19)', () => {
  const caminhoPago = `avisos/${chaveDoAvisoDoPedidoLi(
    TIPO_AVISO.lojaIntegradaPedidoPagoSemEndereco,
    CONTA,
    'pedido-1',
  )}`;
  const semNada = { situacaoDesconhecida: null, contestacao: null };

  it('raised CRITICO at the conta page with exactly the params the wording reads, clocked by the order', async () => {
    const db = new FakeDb();
    expect(await avisarPedidoPagoSemEnderecoLi(asDb(db), pedido(1_000), deps)).toEqual({
      acao: 'levantado',
      resultado: 'criado',
    });
    expect(db.ler(caminhoPago)).toMatchObject({
      tipo: TIPO_AVISO.lojaIntegradaPedidoPagoSemEndereco,
      severidade: SEVERIDADE_AVISO.critico,
      canal: CANAL_AVISO.lojaIntegrada,
      relogioEvento: 1_000,
      urlInterna: { rota: `/canais/loja-integrada/${CONTA}`, campo: null },
      resolvidoEm: null,
    });
    expect(db.ler(caminhoPago)?.params).toEqual({ loja: 'Loja X', pedido: '9001' });
  });

  it('EVERY import that reaches the avisos resolves it — a newer one closes the row', async () => {
    const db = new FakeDb();
    await avisarPedidoPagoSemEnderecoLi(asDb(db), pedido(1_000), deps);
    const r = await sincronizarAvisosDoPedidoLi(asDb(db), pedido(2_000), semNada, deps);
    expect(r.pagoSemEndereco).toEqual({ acao: 'resolvido', fechou: true });
    expect(db.ler(caminhoPago)).toMatchObject({
      resolucaoMotivo: MOTIVO_RESOLUCAO_PEDIDO_LI.pedidoImportado,
      relogioEvento: 2_000,
    });
  });

  it('NEAR-MISS: a late OLDER import cannot close a raised row; a late OLDER exhaustion cannot reopen a resolved one', async () => {
    const db = new FakeDb();
    await avisarPedidoPagoSemEnderecoLi(asDb(db), pedido(2_000), deps);
    const velho = await sincronizarAvisosDoPedidoLi(asDb(db), pedido(1_500), semNada, deps);
    expect(velho.pagoSemEndereco).toEqual({ acao: 'resolvido', fechou: false });
    expect(db.ler(caminhoPago)?.resolvidoEm).toBeNull();

    // The other way round: the newer import resolved (seeding the row), then an
    // older run's exhaustion lands.
    const outro = new FakeDb();
    await sincronizarAvisosDoPedidoLi(asDb(outro), pedido(3_000), semNada, deps);
    expect(await avisarPedidoPagoSemEnderecoLi(asDb(outro), pedido(2_500), deps)).toEqual({
      acao: 'levantado',
      resultado: 'ignorado',
    });
    expect(outro.ler(caminhoPago)?.resolvidoEm).not.toBeNull();
  });
});
