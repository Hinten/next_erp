import { liPedidoSchema, type PedidoLi } from '@delfrance/integrations-loja-integrada';
import {
  ESTADO_FRETE,
  ESTADO_PEDIDO,
  INTEGRACAO_FRETE,
  MODALIDADE_FRETE,
  MOTIVO_FRETE_NAO_SUPORTADO_LI,
  TIPO_AVISO,
  chaveDeAviso,
  freteDoPedidoSchema,
} from '@delfrance/schemas';
import { describe, expect, it } from 'vitest';

import type { RegistroDoMapaLi } from '../frete/mapaFrete';
import { dataLiParaMicros } from './dataLi';
import {
  HORARIO_DE_CORTE_PADRAO_LI,
  codRastreioLi,
  decidirMapaLi,
  entidadeAvisoFreteLi,
  freteDeCriacaoLi,
  horarioDeCorteUtilizavelLi,
  mapearFreteLi,
  mesclarFreteLi,
  mesmoValorJsonLi,
  modalidadeFreteLi,
  prazoDespachoLiUs,
  rotearFreteLi,
  type AlvoLidoLi,
  type DecisaoMapaLi,
  type FreteMapeadoLi,
  type RoteamentoFreteLi,
} from './freteMapeamento';

const INT_FRETE_LI = 'lojaIntegrada-conta1';
const REF_LI = 'documents/int_frete/lojaIntegrada-conta1';
const PAC = { id: 141909, code: 'PAC', nome: 'Correios', tipo: 'PAC' };

/** A `mapa` row mapped (or not) to `uid`. */
function linha(idOriginal: string, uid: string | null, targetData: unknown = null) {
  return {
    nomeOriginal: 'Correios - PAC',
    idOriginal,
    observacao: 'Origem: Pedido 1',
    nomeTarget: null,
    targetData,
    integracaoUid: uid,
    targetTipoIntegracao: INTEGRACAO_FRETE.outros,
  };
}

const registro = (mapa: unknown[] | null): RegistroDoMapaLi => ({ resultado: 'ja-presente', mapa });

function decidir(mapa: unknown[] | null, formaEnvio: unknown = PAC): DecisaoMapaLi {
  return decidirMapaLi({ intFreteLiId: INT_FRETE_LI, registro: registro(mapa), formaEnvio });
}

const alvo = (dados: Record<string, unknown> | null): AlvoLidoLi =>
  dados === null ? { existe: false, dados: null } : { existe: true, dados };

function rotear(decisao: DecisaoMapaLi, dados: Record<string, unknown> | null = null) {
  return rotearFreteLi({
    intFreteLiId: INT_FRETE_LI,
    decisao,
    alvo: decisao.tipo === 'mapeado' ? alvo(dados) : null,
  });
}

describe('the modalidade: CIF whenever the order carries freight', () => {
  it('freight > 0 on a conta set to FOB ⇒ CIF, and the override is reported (one WARNING)', () => {
    expect(modalidadeFreteLi(11.6, MODALIDADE_FRETE.fob)).toEqual({
      modalidade: MODALIDADE_FRETE.cif,
      sobrescrita: true,
    });
  });

  it('⚠️ NEAR-MISS: freight 0 on the same conta ⇒ the conta’s own FOB', () => {
    expect(modalidadeFreteLi(0, MODALIDADE_FRETE.fob)).toEqual({
      modalidade: MODALIDADE_FRETE.fob,
      sobrescrita: false,
    });
  });

  it('no conta setting ⇒ CIF either way, never an override', () => {
    expect(modalidadeFreteLi(10, null)).toEqual({
      modalidade: MODALIDADE_FRETE.cif,
      sobrescrita: false,
    });
    expect(modalidadeFreteLi(0, null)).toEqual({
      modalidade: MODALIDADE_FRETE.cif,
      sobrescrita: false,
    });
    expect(modalidadeFreteLi(10, MODALIDADE_FRETE.cif).sobrescrita).toBe(false);
  });
});

describe('the routing decision from the mapa', () => {
  it('the full key ⇒ the mapped target', () => {
    expect(decidir([linha('141909---PAC', 'me-1', { id: 2 })])).toEqual({
      tipo: 'mapeado',
      chave: '141909---PAC',
      alvoId: 'me-1',
      nomeOriginal: 'Correios - PAC',
      idServico: '2',
    });
  });

  it('⚠️ NEAR-MISS: the same id under another code is UNMAPPED (the key is the FULL `<id>---<code>`)', () => {
    expect(decidir([linha('141909---SEDEX', 'me-1')])).toEqual({
      tipo: 'nao-mapeado',
      chave: '141909---PAC',
    });
    expect(decidir([linha('141909---pac', 'me-1')]).tipo).toBe('nao-mapeado');
    expect(decidir([linha('141909---PAC ', 'me-1')]).tipo).toBe('nao-mapeado');
  });

  it('EQUAL pair: a numeric forma_envio id and its decimal string route to the same target', () => {
    const mapa = [linha('141909---PAC', 'me-1', { id: 2 })];
    expect(decidir(mapa, { ...PAC, id: '141909' })).toEqual(decidir(mapa, PAC));
  });

  it('EQUAL pair: a path-form integracaoUid names the same target as its bare id', () => {
    const bare = decidir([linha('141909---PAC', 'me-1')]);
    expect(decidir([linha('141909---PAC', 'int_frete/me-1')])).toEqual(bare);
    expect(decidir([linha('141909---PAC', 'documents/int_frete/me-1')])).toEqual(bare);
  });

  it('⚠️ NEAR-MISS: a longer target id is another target', () => {
    const d = decidir([linha('141909---PAC', 'me-12')]);
    expect(d.tipo === 'mapeado' && d.alvoId).toBe('me-12');
  });

  it('"mapped" is the uid, never the tipo: null or "" under any tipo is unmapped', () => {
    for (const uid of [null, '']) {
      const row = {
        ...linha('141909---PAC', uid),
        targetTipoIntegracao: INTEGRACAO_FRETE.melhorEnvios,
      };
      expect(decidir([row]).tipo, String(uid)).toBe('nao-mapeado');
    }
  });

  it('a pickup method (tipo null) still has a key', () => {
    const pickup = { id: 9001, code: 'retirar_pessoalmente', nome: 'Retirar', tipo: null };
    expect(decidir([linha('9001---retirar_pessoalmente', 'loja-1')], pickup)).toMatchObject({
      tipo: 'mapeado',
      alvoId: 'loja-1',
    });
  });

  it('no LI int_frete, an unkeyable method, a mapa that is not a list', () => {
    expect(decidirMapaLi({ intFreteLiId: null, registro: null, formaEnvio: PAC })).toEqual({
      tipo: 'sem-int-frete',
      chave: '141909---PAC',
    });
    expect(
      decidirMapaLi({
        intFreteLiId: INT_FRETE_LI,
        registro: { resultado: 'sem-int-frete', mapa: null },
        formaEnvio: PAC,
      }).tipo,
    ).toBe('sem-int-frete');
    expect(
      decidirMapaLi({
        intFreteLiId: INT_FRETE_LI,
        registro: { resultado: 'chave-invalida', mapa: null },
        formaEnvio: { ...PAC, id: '0141909' },
      }),
    ).toEqual({ tipo: 'sem-chave' });
    expect(
      decidirMapaLi({
        intFreteLiId: INT_FRETE_LI,
        registro: { resultado: 'mapa-invalido', mapa: null },
        formaEnvio: PAC,
      }),
    ).toEqual({ tipo: 'mapa-invalido', chave: '141909---PAC' });
    expect(decidir(null).tipo).toBe('nao-mapeado');
  });
});

describe('the routing, after the target read', () => {
  const mapeadoMe = decidir([linha('141909---PAC', 'me-1', { id: 2, name: 'PAC' })]);
  const semServico = decidir([linha('141909---PAC', 'me-1', null)]);

  it('an active Melhor Envio target with a service ⇒ the target, externalOptionId = the service id', () => {
    expect(rotear(mapeadoMe, { tipo: INTEGRACAO_FRETE.melhorEnvios, ativo: true })).toEqual({
      integracaoFreteOuterRef: 'documents/int_frete/me-1',
      externalOptionId: '2',
      aviso: { tipo: 'resolver', chave: '141909---PAC' },
      deliberado: false,
    });
  });

  it('motoboy and retirada targets route without a service', () => {
    for (const tipo of [INTEGRACAO_FRETE.motoboy, INTEGRACAO_FRETE.retiradaNaLoja]) {
      expect(rotear(semServico, { tipo, ativo: true })).toMatchObject({
        integracaoFreteOuterRef: 'documents/int_frete/me-1',
        externalOptionId: null,
        aviso: { tipo: 'resolver' },
      });
    }
  });

  it('⚠️ a fob (or outros) target ⇒ the conta’s LI doc, NO aviso (deliberate)', () => {
    for (const tipo of [INTEGRACAO_FRETE.fob, INTEGRACAO_FRETE.outros]) {
      expect(rotear(semServico, { tipo, ativo: true })).toEqual({
        integracaoFreteOuterRef: REF_LI,
        externalOptionId: null,
        aviso: { tipo: 'resolver', chave: '141909---PAC' },
        deliberado: true,
      });
    }
  });

  it('⚠️ NEAR-MISS: an INACTIVE Melhor Envio target ⇒ the LI doc + the aviso (alvo-inativo)', () => {
    expect(rotear(mapeadoMe, { tipo: INTEGRACAO_FRETE.melhorEnvios, ativo: false })).toEqual({
      integracaoFreteOuterRef: REF_LI,
      externalOptionId: null,
      aviso: {
        tipo: 'levantar',
        chave: '141909---PAC',
        motivo: MOTIVO_FRETE_NAO_SUPORTADO_LI.alvoInativo,
        formaEnvio: 'Correios - PAC',
      },
      deliberado: false,
    });
  });

  it('a missing target, a Melhor Envio row with no service, another tipo ⇒ the LI doc + the aviso', () => {
    expect(rotear(mapeadoMe, null).aviso).toMatchObject({
      motivo: MOTIVO_FRETE_NAO_SUPORTADO_LI.alvoAusente,
    });
    expect(rotear(semServico, { tipo: INTEGRACAO_FRETE.melhorEnvios }).aviso).toMatchObject({
      motivo: MOTIVO_FRETE_NAO_SUPORTADO_LI.alvoSemServico,
    });
    for (const tipo of [
      INTEGRACAO_FRETE.mercadoLivre,
      INTEGRACAO_FRETE.lojaIntegrada,
      'xpto',
      undefined,
    ]) {
      const r = rotear(semServico, { tipo, ativo: true });
      expect(r.integracaoFreteOuterRef, String(tipo)).toBe(REF_LI);
      expect(r.aviso, String(tipo)).toMatchObject({
        motivo: MOTIVO_FRETE_NAO_SUPORTADO_LI.tipoNaoSuportado,
      });
    }
  });

  it('an absent `ativo` reads as active (the schema default)', () => {
    expect(rotear(mapeadoMe, { tipo: INTEGRACAO_FRETE.melhorEnvios }).integracaoFreteOuterRef).toBe(
      'documents/int_frete/me-1',
    );
  });

  it('unmapped / mapa-invalido ⇒ the LI doc, resolve; no key ⇒ the LI doc, nothing; no LI doc ⇒ null', () => {
    expect(rotear({ tipo: 'nao-mapeado', chave: 'k' })).toEqual({
      integracaoFreteOuterRef: REF_LI,
      externalOptionId: null,
      aviso: { tipo: 'resolver', chave: 'k' },
      deliberado: false,
    });
    expect(rotear({ tipo: 'mapa-invalido', chave: 'k' }).aviso).toEqual({
      tipo: 'resolver',
      chave: 'k',
    });
    expect(rotear({ tipo: 'sem-chave' })).toMatchObject({
      integracaoFreteOuterRef: REF_LI,
      aviso: null,
    });
    expect(
      rotearFreteLi({
        intFreteLiId: null,
        decisao: { tipo: 'sem-int-frete', chave: 'k' },
        alvo: null,
      }),
    ).toEqual({
      integracaoFreteOuterRef: null,
      externalOptionId: null,
      aviso: { tipo: 'resolver', chave: 'k' },
      deliberado: false,
    });
  });
});

describe('the aviso key is the digest of the full key', () => {
  const chave = (entidade: string) =>
    chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaFreteNaoSuportado, conta: 'conta1', entidade });

  it('⚠️ NEAR-MISS: `1---PAC.X` and `1---PAC_X` are TWO rows (the raw key would fold them)', () => {
    expect(chave('1---PAC.X')).toBe(chave('1---PAC_X'));
    expect(chave(entidadeAvisoFreteLi('1---PAC.X'))).not.toBe(
      chave(entidadeAvisoFreteLi('1---PAC_X')),
    );
  });

  it('EQUAL pair: a numeric id and its string are ONE row', () => {
    const a = decidir([], { id: 1, code: 'PAC' });
    const b = decidir([], { id: '1', code: 'PAC' });
    expect(a.tipo === 'nao-mapeado' && entidadeAvisoFreteLi(a.chave)).toBe(
      b.tipo === 'nao-mapeado' && entidadeAvisoFreteLi(b.chave),
    );
  });

  it('a very long code still fits a document id', () => {
    expect(() => chave(entidadeAvisoFreteLi(`1---${'x'.repeat(2000)}`))).not.toThrow();
  });
});

describe('the dispatch deadline: set on the pago rung only, from the approval', () => {
  /** A Tuesday, 2026-03-03 09:00 in São Paulo. */
  const terca9h = dataLiParaMicros('2026-03-03T09:00:00');
  /** The same Tuesday at 15:00. */
  const terca15h = dataLiParaMicros('2026-03-03T15:00:00');

  it('the noon rule: before noon ⇒ the same day; after ⇒ the next business day', () => {
    const cedo = prazoDespachoLiUs(null, terca9h);
    const tarde = prazoDespachoLiUs(null, terca15h);
    expect(cedo).not.toBeNull();
    expect(tarde).not.toBeNull();
    expect((tarde ?? 0) - (cedo ?? 0)).toBe(86_400 * 1_000_000);
  });

  it('the conta’s own cut-off wins over the noon rule', () => {
    const corte16h = [1, 2, 3, 4, 5].map((diaDaSemana) => ({
      diaDaSemana,
      horaDeCorte: 16,
      minutosDeCorte: 0,
    }));
    expect(prazoDespachoLiUs(corte16h, terca15h)).toBe(prazoDespachoLiUs(null, terca9h));
  });

  it('⚠️ a stored text-integer hour (`"16"`) is read by the SHARED rule: the conta’s same-day deadline, as every other surface reads it', () => {
    const corte16hTexto = [1, 2, 3, 4, 5].map((diaDaSemana) => ({
      diaDaSemana,
      horaDeCorte: '16',
      minutosDeCorte: 0,
    }));
    expect(prazoDespachoLiUs(corte16hTexto, terca15h)).toBe(prazoDespachoLiUs(null, terca9h));
    // NEAR-MISS: the noon rule would have put the same approval on the next day.
    expect(prazoDespachoLiUs(corte16hTexto, terca15h)).not.toBe(prazoDespachoLiUs(null, terca15h));
  });

  it('a row the shared rule cannot read (`"16h"`) is dropped there; none left ⇒ the noon rule', () => {
    const ilegivel = [1, 2, 3, 4, 5].map((diaDaSemana) => ({ diaDaSemana, horaDeCorte: '16h' }));
    expect(prazoDespachoLiUs(ilegivel, terca15h)).toBe(prazoDespachoLiUs(null, terca15h));
  });

  it('⚠️ rows without a cut-off hour are an unset schedule ⇒ the noon rule', () => {
    const vazios = [1, 2, 3, 4, 5, 6, 7].map((diaDaSemana) => ({ diaDaSemana, horaDeCorte: null }));
    expect(horarioDeCorteUtilizavelLi(vazios)).toBeNull();
    expect(prazoDespachoLiUs(vazios, terca15h)).toBe(prazoDespachoLiUs(null, terca15h));
    expect(horarioDeCorteUtilizavelLi('x')).toBeNull();
    expect(HORARIO_DE_CORTE_PADRAO_LI).toHaveLength(5);
  });

  it('no approval date ⇒ no deadline', () => {
    expect(prazoDespachoLiUs(null, null)).toBeNull();
  });
});

describe('the block', () => {
  function pedido(
    campos: Record<string, unknown> = {},
    envio: Record<string, unknown> = {},
  ): PedidoLi {
    return liPedidoSchema.parse({
      numero: 1,
      situacao: { codigo: 'pedido_pago' },
      data_modificacao: '2026-03-03T10:00:00',
      valor_envio: '11.60',
      envios: [
        {
          id: 555,
          objeto: null,
          prazo: 9,
          valor: '11.60',
          data_criacao: '2026-03-02T11:00:01.000001',
          forma_envio: PAC,
          ...envio,
        },
      ],
      ...campos,
    });
  }

  const ROTA: RoteamentoFreteLi = {
    integracaoFreteOuterRef: REF_LI,
    externalOptionId: null,
    aviso: null,
    deliberado: false,
  };

  function mapear(
    p: PedidoLi,
    aprovado: number | null = dataLiParaMicros('2026-03-03T09:00:00'),
  ): FreteMapeadoLi {
    const r = mapearFreteLi({
      pedido: p,
      modalidadeConta: MODALIDADE_FRETE.fob,
      roteamento: ROTA,
      horarioDeCorteConta: null,
      dataAprovacaoUs: aprovado,
      enderecoFiscalOuterRef: 'documents/clientes/c1/enderecos/e1',
    });
    if (r === null) throw new Error('expected a block');
    return r;
  }

  it('maps envios[0]: id, raw forma_envio, null integração, rounded value, dates, the fiscal endereço', () => {
    const m = mapear(pedido());
    const criado = dataLiParaMicros('2026-03-02T11:00:01.000001') ?? 0;
    expect(m.base).toMatchObject({
      externalId: '555',
      externalOptionData: PAC,
      externalOptionIntegracao: null,
      integracaoFreteOuterRef: REF_LI,
      modalidade: MODALIDADE_FRETE.cif,
      valorCobrado: 11.6,
      codRastreio: null,
      timestamp: criado,
      dataPrevisaoEntrega: criado + 9 * 86_400 * 1_000_000,
      enderecoFreteOuterReference: 'documents/clientes/c1/enderecos/e1',
      clienteRecebedorOuterReference: null,
    });
    expect(m.modalidadeSobrescrita).toBe(true);
    expect(m.multiEnvio).toBe(false);
    expect(freteDoPedidoSchema.safeParse(freteDeCriacaoLi(m, ESTADO_PEDIDO.pago)).success).toBe(
      true,
    );
  });

  it('EQUAL pair: valor_envio and the shipment’s valor agree ⇒ that value, no divergence', () => {
    const m = mapear(pedido());
    expect(m.base.valorCobrado).toBe(11.6);
    expect(m.valorDivergente).toBe(false);
  });

  it('⚠️ NEAR-MISS: valor_envio > 0 with no shipment valor ⇒ the block STILL carries the freight (CIF, NF-e vFrete)', () => {
    for (const valor of [null, '']) {
      const m = mapear(pedido({}, { valor }));
      expect(m.base.valorCobrado, String(valor)).toBe(11.6);
      expect(m.base.modalidade, String(valor)).toBe(MODALIDADE_FRETE.cif);
      expect(m.valorDivergente, String(valor)).toBe(false);
    }
  });

  it('⚠️ NEAR-MISS: free shipping (valor_envio 0) beside a shipment valor > 0 ⇒ the ORDER’s 0, and the divergence is reported', () => {
    const m = mapear(pedido({ valor_envio: '0.00' }, { valor: '11.60' }));
    expect(m.base.valorCobrado).toBe(0);
    expect(m.base.modalidade).toBe(MODALIDADE_FRETE.fob);
    expect(m.valorDivergente).toBe(true);
  });

  it('no valor_envio: the shipment’s valor decides both the value and the modalidade', () => {
    const m = mapear(pedido({ valor_envio: null }));
    expect(m.base.valorCobrado).toBe(11.6);
    expect(m.base.modalidade).toBe(MODALIDADE_FRETE.cif);
    expect(m.valorDivergente).toBe(false);
  });

  it("⚠️ objeto '' ⇒ no tracking code", () => {
    expect(mapear(pedido({}, { objeto: '' })).base.codRastreio).toBeNull();
    expect(codRastreioLi('AB123456789BR')).toBe('AB123456789BR');
    expect(codRastreioLi('x'.repeat(201))).toBeNull();
  });

  it('no shipment ⇒ no block; a second shipment ⇒ reported (multi-envio), the first drives', () => {
    expect(
      mapearFreteLi({
        pedido: pedido({ envios: [] }),
        modalidadeConta: null,
        roteamento: ROTA,
        horarioDeCorteConta: null,
        dataAprovacaoUs: null,
        enderecoFiscalOuterRef: null,
      }),
    ).toBeNull();
    const dois = pedido({
      envios: [
        { id: 1, valor: '1.00', forma_envio: PAC },
        { id: 2, valor: '2.00', forma_envio: PAC },
      ],
    });
    const m = mapear(dois);
    expect(m.multiEnvio).toBe(true);
    expect(m.base.externalId).toBe('1');
  });

  it('create estado: pago + code ⇒ aguardandoPostagem; pago without ⇒ despachoAutorizado; else iniciado', () => {
    const comCodigo = mapear(pedido({}, { objeto: 'AB123456789BR' }));
    expect(freteDeCriacaoLi(comCodigo, ESTADO_PEDIDO.pago).estado).toBe(
      ESTADO_FRETE.aguardandoPostagem,
    );
    expect(freteDeCriacaoLi(mapear(pedido()), ESTADO_PEDIDO.pago).estado).toBe(
      ESTADO_FRETE.despachoAutorizado,
    );
    expect(
      freteDeCriacaoLi(mapear(pedido()), ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento).estado,
    ).toBe(ESTADO_FRETE.iniciado);
  });

  it('⚠️ a dead-sale create WITH a code ⇒ iniciado (never aguardandoPostagem), no deadline', () => {
    const m = mapear(pedido({}, { objeto: 'AB123456789BR' }));
    for (const morto of [ESTADO_PEDIDO.cancelado, ESTADO_PEDIDO.estornadoIntegralmente]) {
      const b = freteDeCriacaoLi(m, morto);
      expect(b.estado).toBe(ESTADO_FRETE.iniciado);
      expect(b.prazoDespacho).toBeNull();
    }
  });

  it('the deadline is on the block only at pago', () => {
    const m = mapear(pedido());
    expect(m.prazoDespachoSePagoUs).not.toBeNull();
    expect(freteDeCriacaoLi(m, ESTADO_PEDIDO.pago).prazoDespacho).toBe(m.prazoDespachoSePagoUs);
    expect(
      freteDeCriacaoLi(m, ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento).prazoDespacho,
    ).toBeNull();
  });
});

describe('the update merge: tracking outside the freeze, money inside it', () => {
  const pedidoPago = liPedidoSchema.parse({
    numero: 1,
    situacao: { codigo: 'pedido_pago' },
    data_modificacao: '2026-03-03T10:00:00',
    valor_envio: '11.60',
    envios: [
      {
        id: 555,
        objeto: 'AB123456789BR',
        prazo: 9,
        valor: '11.60',
        data_criacao: '2026-03-02T11:00:01',
        forma_envio: PAC,
      },
    ],
  });
  const m = mapearFreteLi({
    pedido: pedidoPago,
    modalidadeConta: null,
    roteamento: {
      integracaoFreteOuterRef: 'documents/int_frete/me-1',
      externalOptionId: '2',
      aviso: null,
      deliberado: false,
    },
    horarioDeCorteConta: null,
    dataAprovacaoUs: dataLiParaMicros('2026-03-03T09:00:00'),
    enderecoFiscalOuterRef: 'documents/clientes/c1/enderecos/e1',
  })!;

  /** A stored block from an unpaid first import, then edited by an operator. */
  const armazenado = {
    ...freteDeCriacaoLi(
      {
        ...m,
        base: {
          ...m.base,
          codRastreio: null,
          integracaoFreteOuterRef: null,
          externalOptionId: null,
          enderecoFreteOuterReference: null,
        },
      },
      ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
    ),
    valorCobrado: 30,
    campoLegado: 'x',
  };

  it('⚠️ FROZEN: the operator’s valorCobrado is kept', () => {
    const r = mesclarFreteLi(armazenado, m, { congelado: true, estadoPedido: ESTADO_PEDIDO.pago });
    expect(r?.bloco.valorCobrado).toBe(30);
  });

  it('⚠️ a FROZEN unpaid pedido still gets despachoAutorizado, prazoDespacho, codRastreio and the endereço when paid', () => {
    const r = mesclarFreteLi(armazenado, m, { congelado: true, estadoPedido: ESTADO_PEDIDO.pago });
    expect(r?.bloco).toMatchObject({
      estado: ESTADO_FRETE.despachoAutorizado,
      prazoDespacho: m.prazoDespachoSePagoUs,
      codRastreio: 'AB123456789BR',
      enderecoFreteOuterReference: 'documents/clientes/c1/enderecos/e1',
      integracaoFreteOuterRef: 'documents/int_frete/me-1',
      externalOptionId: '2',
      campoLegado: 'x',
    });
    expect(r?.campos).not.toContain('valorCobrado');
  });

  it('NOT frozen: the money is refreshed from Loja Integrada', () => {
    const r = mesclarFreteLi(armazenado, m, { congelado: false, estadoPedido: ESTADO_PEDIDO.pago });
    expect(r?.bloco.valorCobrado).toBe(11.6);
    expect(r?.campos).toContain('valorCobrado');
  });

  it('fill-once: a stored tracking code, deadline or ref is never overwritten', () => {
    const preenchido = {
      ...armazenado,
      codRastreio: 'ERP0000',
      prazoDespacho: 1,
      integracaoFreteOuterRef: 'documents/int_frete/x',
    };
    const r = mesclarFreteLi(preenchido, m, { congelado: true, estadoPedido: ESTADO_PEDIDO.pago });
    expect(r?.bloco).toMatchObject({
      codRastreio: 'ERP0000',
      prazoDespacho: 1,
      integracaoFreteOuterRef: 'documents/int_frete/x',
    });
    // ⚠️ …and the routed target's OPTION never lands beside another target's ref.
    expect(r?.bloco.externalOptionId).toBeNull();
    expect(r?.campos).not.toContain('externalOptionId');
  });

  it('⚠️ NEAR-MISS: a stored ref to the conta’s LI doc (an order first imported unmapped) keeps a null option', () => {
    const naConta = { ...armazenado, integracaoFreteOuterRef: REF_LI };
    const r = mesclarFreteLi(naConta, m, { congelado: false, estadoPedido: ESTADO_PEDIDO.pago });
    expect(r?.bloco.integracaoFreteOuterRef).toBe(REF_LI);
    expect(r?.bloco.externalOptionId).toBeNull();
  });

  it('EQUAL pair: a stored ref naming the SAME target (any ref form) takes the option', () => {
    for (const ref of ['documents/int_frete/me-1', 'int_frete/me-1']) {
      const mesmo = { ...armazenado, integracaoFreteOuterRef: ref };
      const r = mesclarFreteLi(mesmo, m, { congelado: true, estadoPedido: ESTADO_PEDIDO.pago });
      expect(r?.bloco.externalOptionId, ref).toBe('2');
      expect(r?.bloco.integracaoFreteOuterRef, ref).toBe(ref);
    }
    // NEAR-MISS: a longer target id is another target.
    const outro = { ...armazenado, integracaoFreteOuterRef: 'documents/int_frete/me-12' };
    expect(
      mesclarFreteLi(outro, m, { congelado: true, estadoPedido: ESTADO_PEDIDO.pago })?.bloco
        .externalOptionId,
    ).toBeNull();
  });

  it('unpaid: no promotion and no deadline', () => {
    const r = mesclarFreteLi(armazenado, m, {
      congelado: true,
      estadoPedido: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
    });
    expect(r?.bloco.estado).toBe(ESTADO_FRETE.iniciado);
    expect(r?.bloco.prazoDespacho).toBeNull();
  });

  it('the step-7 loop: a postado block re-imported with the same code and money ⇒ no change at all', () => {
    const postado = {
      ...freteDeCriacaoLi(m, ESTADO_PEDIDO.pago),
      estado: ESTADO_FRETE.postado,
      // Firestore may return the map's keys in another order.
      externalOptionData: { tipo: 'PAC', nome: 'Correios', code: 'PAC', id: 141909 },
    };
    expect(
      mesclarFreteLi(postado, m, { congelado: false, estadoPedido: ESTADO_PEDIDO.pago }),
    ).toBeNull();
  });

  it('an absent block is seeded only while not frozen', () => {
    expect(
      mesclarFreteLi(null, m, { congelado: true, estadoPedido: ESTADO_PEDIDO.pago }),
    ).toBeNull();
    const r = mesclarFreteLi(undefined, m, { congelado: false, estadoPedido: ESTADO_PEDIDO.pago });
    expect(r?.campos).toEqual(['*']);
    expect(r?.bloco.estado).toBe(ESTADO_FRETE.aguardandoPostagem);
  });
});

describe('mesmoValorJsonLi: strict structural equality', () => {
  it('EQUAL pair: the same keys in another order', () => {
    expect(mesmoValorJsonLi({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
  });

  it('⚠️ NEAR-MISS: no coercion, null is not absent, arrays keep their order', () => {
    expect(mesmoValorJsonLi({ id: 1 }, { id: '1' })).toBe(false);
    expect(mesmoValorJsonLi({ a: null }, {})).toBe(false);
    expect(mesmoValorJsonLi({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(mesmoValorJsonLi([1, 2], [2, 1])).toBe(false);
    expect(mesmoValorJsonLi([], {})).toBe(false);
    expect(mesmoValorJsonLi(null, {})).toBe(false);
  });
});
