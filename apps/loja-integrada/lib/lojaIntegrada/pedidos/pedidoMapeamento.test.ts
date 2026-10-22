import { microsDeDataHoraNoFuso } from '@delfrance/core/datetime';
import { liPedidoSchema, type PedidoLi } from '@delfrance/integrations-loja-integrada';
import {
  ESTADO_FRETE,
  ESTADO_PEDIDO,
  MODALIDADE_FRETE,
  MOTIVO_PEDIDO_CONTESTADO_LI,
  pedidoSchema,
} from '@delfrance/schemas';
import { describe, expect, it } from 'vitest';

import { dataLiParaMicros } from './dataLi';
import { MOTIVO_ESTADO_LI, PREFIXO_ERRO_LI } from './estadoPedidoLi';
import { mapearFreteLi } from './freteMapeamento';
import { mapearItensLi, type ResolucaoLinhaLi } from './itensMapeamento';
import { idPedidoLi } from './orderIdsLi';
import {
  mapearPedidoLi,
  mesclarItensLi,
  montarEscritaPedidoLi,
  type EscritaPedidoLi,
  type PedidoMapeadoLi,
} from './pedidoMapeamento';

const CONTA = 'CONTA1';
const AGORA_US = 1_900_000_000_000_000;
const STAMP = '2026-03-10T15:20:10.123456';
const WATERMARK_US = dataLiParaMicros(STAMP)!;
const ENDERECO = 'documents/clientes/c1/enderecos/e1';

function wire(campos: Record<string, unknown> = {}): PedidoLi {
  return liPedidoSchema.parse({
    id: 0,
    numero: 165,
    situacao: { codigo: 'pedido_pago' },
    data_criacao: '2026-03-09T11:00:00.654321',
    data_modificacao: STAMP,
    valor_total: '161.50',
    valor_subtotal: '149.90',
    valor_envio: '11.60',
    valor_desconto: '0.00',
    itens: [
      {
        id: 1,
        linha: 1,
        sku: '123456789012345',
        quantidade: '1.000',
        preco_venda: '39.9000',
        preco_subtotal: '39.9000',
        produto: '/api/v1/produto/10',
      },
      {
        id: 2,
        linha: 2,
        sku: '12345678901234',
        quantidade: '1.000',
        preco_venda: '110.0000',
        preco_subtotal: '110.0000',
        produto: '/api/v1/produto/11',
      },
    ],
    envios: [
      {
        id: 555,
        objeto: null,
        prazo: 9,
        valor: '11.60',
        data_criacao: '2026-03-09T11:00:01.000001',
        forma_envio: { id: 141909, code: 'PAC', nome: 'Correios', tipo: 'PAC' },
      },
    ],
    pagamentos: [{ id: 9, valor: '161.50', pagamento_tipo: 'bankInvoice' }],
    ...campos,
  });
}

interface Opcoes {
  readonly capturado?: boolean;
  readonly watermarkUs?: number;
  readonly resolucoes?: ReadonlyMap<string, ResolucaoLinhaLi>;
  readonly clientePedidoOuterRef?: string | null;
  readonly enderecoFiscalOuterRef?: string | null;
}

function mapeado(p: PedidoLi = wire(), o: Opcoes = {}): PedidoMapeadoLi {
  const itens = mapearItensLi({
    itens: p.itens,
    valorSubtotal: p.valor_subtotal,
    resolucoes: o.resolucoes ?? new Map(),
    nowUs: AGORA_US,
  });
  if (!itens.ok) throw new Error('lines refused');
  const enderecoFiscalOuterRef =
    o.enderecoFiscalOuterRef === undefined ? ENDERECO : o.enderecoFiscalOuterRef;
  const frete = mapearFreteLi({
    pedido: p,
    modalidadeConta: null,
    roteamento: {
      integracaoFreteOuterRef: 'documents/int_frete/lojaIntegrada-CONTA1',
      externalOptionId: null,
      aviso: null,
      deliberado: false,
      dispensaEndereco: false,
    },
    horarioDeCorteConta: null,
    dataAprovacaoUs: dataLiParaMicros('2026-03-09T14:00:00'),
    enderecoFiscalOuterRef,
  });
  return mapearPedidoLi({
    contaId: CONTA,
    operacaoOuterRef: 'documents/operacoes/op1',
    pedido: p,
    watermarkUs: o.watermarkUs ?? WATERMARK_US,
    capturado: o.capturado ?? true,
    itens: itens.itens,
    descontoExtra: itens.descontoExtra,
    frete,
    clientePedidoOuterRef:
      o.clientePedidoOuterRef === undefined ? 'documents/clientes/c1' : o.clientePedidoOuterRef,
    enderecoFiscalOuterRef,
  });
}

function criado(m: PedidoMapeadoLi = mapeado()): Record<string, unknown> {
  const e = montarEscritaPedidoLi(null, m, AGORA_US - 10);
  if (e.tipo !== 'criar') throw new Error('expected a create');
  return { ...e.corpo };
}

function patch(e: EscritaPedidoLi): Readonly<Record<string, unknown>> {
  if (e.tipo !== 'atualizar') throw new Error(`expected an update, got ${e.tipo}`);
  return e.patch;
}

describe('the pedido fields', () => {
  it('the create body parses, keyed by numero, with the order’s money and stamps', () => {
    const m = mapeado();
    expect(m.pedidoId).toBe(idPedidoLi(CONTA, 165));
    const corpo = criado(m);
    const doc = pedidoSchema.parse(corpo);
    expect(doc).toMatchObject({
      ehSaida: true,
      estado: ESTADO_PEDIDO.pago,
      numero: '165',
      integracaoPedidoOuterRef: 'documents/integracao/CONTA1',
      operacaoPedidoOuterRef: 'documents/operacoes/op1',
      clientePedidoOuterRef: 'documents/clientes/c1',
      enderecoFiscalOuterRef: ENDERECO,
      valorCobrado: 161.5,
      descontoTotal: 0,
      error: null,
      timestamp: dataLiParaMicros('2026-03-09T11:00:00.654321'),
      lastMarketplaceUpdate: WATERMARK_US,
      ultimaModificacao: AGORA_US - 10,
      marketplace: null,
    });
    expect(doc.itensIds).toEqual(['NONE']);
    expect(doc.itens.NONE?.map((l) => l.ensureUniqueId)).toEqual(['1', '2']);
    expect(doc.freteInicial).toMatchObject({
      estado: ESTADO_FRETE.despachoAutorizado,
      modalidade: MODALIDADE_FRETE.cif,
      enderecoFreteOuterReference: ENDERECO,
    });
  });

  it('⚠️ two orders with the SAME top-level id and different numeros ⇒ two pedido ids', () => {
    expect(mapeado(wire({ id: 7, numero: 165 })).pedidoId).not.toBe(
      mapeado(wire({ id: 7, numero: 166 })).pedidoId,
    );
    expect(mapeado(wire({ id: 7 })).pedidoId).toBe(mapeado(wire({ id: 8 })).pedidoId);
  });

  it('descontoTotal = valor_desconto + the positive line residual', () => {
    const p = wire({
      valor_subtotal: '99.99',
      valor_desconto: '5.00',
      itens: [{ id: 1, quantidade: '3.000', preco_venda: '33.3333', preco_subtotal: '99.9999' }],
    });
    expect(mapeado(p).congelaveis.descontoTotal).toBe(5.01);
  });

  it('an unknown codigo creates the pedido at `error` with our text', () => {
    const corpo = criado(mapeado(wire({ situacao: { codigo: 'xyz_novo' } })));
    expect(corpo.estado).toBe(ESTADO_PEDIDO.error);
    expect(corpo.error).toBe(`${PREFIXO_ERRO_LI}situação desconhecida: "xyz_novo"`);
    expect(pedidoSchema.safeParse(corpo).success).toBe(true);
  });
});

describe('the watermark (tier 2, µs)', () => {
  const armazenado = () => criado();

  it('EQUAL stamp ⇒ sem-mudanca, zero writes', () => {
    expect(montarEscritaPedidoLi(armazenado(), mapeado(), AGORA_US).tipo).toBe('sem-mudanca');
  });

  it('EQUAL pair: `X` ≡ `X.000000` — the same stamp, no write', () => {
    const inteiro = dataLiParaMicros('2026-03-10T15:20:10')!;
    const s = { ...armazenado(), lastMarketplaceUpdate: inteiro };
    const m = mapeado(wire(), { watermarkUs: dataLiParaMicros('2026-03-10T15:20:10.000000')! });
    expect(montarEscritaPedidoLi(s, m, AGORA_US).tipo).toBe('sem-mudanca');
  });

  it('⚠️ +1 µs ⇒ applies: the accepted stamp is written, and ultimaModificacao', () => {
    const e = montarEscritaPedidoLi(
      armazenado(),
      mapeado(wire(), { watermarkUs: WATERMARK_US + 1 }),
      AGORA_US,
    );
    expect(e).toMatchObject({ tipo: 'atualizar', grupos: ['watermark'] });
    expect(patch(e)).toEqual({
      lastMarketplaceUpdate: WATERMARK_US + 1,
      ultimaModificacao: AGORA_US,
    });
  });

  it('⚠️ a stored stamp strictly newer ⇒ obsoleto (no decision, nothing written)', () => {
    const s = { ...armazenado(), lastMarketplaceUpdate: WATERMARK_US + 1 };
    expect(montarEscritaPedidoLi(s, mapeado(), AGORA_US)).toEqual({
      tipo: 'obsoleto',
      armazenadoUs: WATERMARK_US + 1,
    });
  });

  it('⚠️ a zone moved EAST after an import: a stamp an hour LATER reads older than the stored watermark ⇒ obsoleto, the change dropped', () => {
    // Stored under the zone of the first import; the change arrives an hour later.
    const s = {
      ...armazenado(),
      lastMarketplaceUpdate: microsDeDataHoraNoFuso(STAMP, 'America/Sao_Paulo'),
    };
    const umaHoraDepois = '2026-03-10T16:20:10.123456';
    const comoUtc = microsDeDataHoraNoFuso(umaHoraDepois, 'UTC')!;
    expect(montarEscritaPedidoLi(s, mapeado(wire(), { watermarkUs: comoUtc }), AGORA_US).tipo).toBe(
      'obsoleto',
    );
    // NEAR-MISS: the same stamp in the SAME zone applies; so does a WESTWARD move.
    expect(
      montarEscritaPedidoLi(
        s,
        mapeado(wire(), { watermarkUs: dataLiParaMicros(umaHoraDepois)! }),
        AGORA_US,
      ).tipo,
    ).toBe('atualizar');
    const comoManaus = microsDeDataHoraNoFuso(umaHoraDepois, 'America/Manaus')!;
    expect(
      montarEscritaPedidoLi(s, mapeado(wire(), { watermarkUs: comoManaus }), AGORA_US).tipo,
    ).toBe('atualizar');
  });

  it('a stored null ⇒ proceeds', () => {
    const s = { ...armazenado(), lastMarketplaceUpdate: null };
    expect(patch(montarEscritaPedidoLi(s, mapeado(), AGORA_US))).toMatchObject({
      lastMarketplaceUpdate: WATERMARK_US,
    });
  });

  it('⚠️ a stored ms int of the same second (another writer’s unit) ⇒ the incoming stamp is newer', () => {
    const s = {
      ...armazenado(),
      lastMarketplaceUpdate: Math.floor(WATERMARK_US / 1_000_000) * 1000,
    };
    expect(montarEscritaPedidoLi(s, mapeado(), AGORA_US).tipo).toBe('atualizar');
  });

  it('⚠️ an equal-stamp redelivery that binds a newly linked unmatched line STILL applies (>=, not >)', () => {
    const s = armazenado();
    const resolucoes = new Map<string, ResolucaoLinhaLi>([['2', { produtoUid: 'prod-2' }]]);
    const e = montarEscritaPedidoLi(s, mapeado(wire(), { resolucoes }), AGORA_US);
    expect(e).toMatchObject({ tipo: 'atualizar', grupos: ['itens'] });
    const itens = patch(e).itens as Record<
      string,
      { ensureUniqueId: string; produtoUid: string | null }[]
    >;
    expect(Object.keys(itens).sort()).toEqual(['NONE', 'prod-2']);
    expect(itens['prod-2']?.[0]).toMatchObject({ ensureUniqueId: '2', produtoUid: 'prod-2' });
    expect(patch(e).itensIds).toEqual(['NONE', 'prod-2']);
  });
});

describe('the update groups', () => {
  it('the estado through the decision: stored finalizado + a paid codigo ⇒ unchanged', () => {
    const s = { ...criado(), estado: ESTADO_PEDIDO.finalizado };
    const e = montarEscritaPedidoLi(s, mapeado(), AGORA_US);
    expect(e.tipo).toBe('sem-mudanca');
    expect(e.tipo === 'sem-mudanca' && e.decisao.motivo).toBe(MOTIVO_ESTADO_LI.foraDaEscada);
  });

  it('a refund after the applied removal: estado kept, the aviso motivo carried out', () => {
    const s = {
      ...criado(),
      estoqueAplicado: { depositoId: 'd', ehSaida: true, removido: { p: 1 } },
    };
    const m = mapeado(wire({ situacao: { codigo: 'pagamento_devolvido_sem_retorno' } }));
    const e = montarEscritaPedidoLi(s, { ...m, watermarkUs: WATERMARK_US + 1 }, AGORA_US);
    expect(patch(e)).not.toHaveProperty('estado');
    expect(e.tipo === 'atualizar' && e.decisao.contestacao).toBe(
      MOTIVO_PEDIDO_CONTESTADO_LI.devolvidoSemRetorno,
    );
  });

  it('⚠️ an unknown codigo on update: estado KEPT, our error set; a known one later clears ONLY ours', () => {
    const s = criado();
    const desconhecido = montarEscritaPedidoLi(
      s,
      mapeado(wire({ situacao: { codigo: 'xyz' } })),
      AGORA_US,
    );
    expect(patch(desconhecido)).toEqual({
      error: `${PREFIXO_ERRO_LI}situação desconhecida: "xyz"`,
      ultimaModificacao: AGORA_US,
    });
    const comNosso = { ...s, error: `${PREFIXO_ERRO_LI}situação desconhecida: "xyz"` };
    expect(patch(montarEscritaPedidoLi(comNosso, mapeado(), AGORA_US))).toEqual({
      error: null,
      ultimaModificacao: AGORA_US,
    });
    const deOutro = { ...s, error: 'NF-e rejeitada: 539' };
    expect(montarEscritaPedidoLi(deOutro, mapeado(), AGORA_US).tipo).toBe('sem-mudanca');
  });

  it('fill-once refs: a late cliente/endereço fills an empty ref, never an existing one', () => {
    const semRefs = criado(
      mapeado(wire(), { clientePedidoOuterRef: null, enderecoFiscalOuterRef: null }),
    );
    const e = montarEscritaPedidoLi(semRefs, mapeado(), AGORA_US);
    expect(patch(e)).toMatchObject({
      clientePedidoOuterRef: 'documents/clientes/c1',
      enderecoFiscalOuterRef: ENDERECO,
    });
    // …and the freight's destination fills with it.
    expect((patch(e).freteInicial as Record<string, unknown>).enderecoFreteOuterReference).toBe(
      ENDERECO,
    );
    const outro = { ...criado(), clientePedidoOuterRef: 'documents/clientes/operador' };
    expect(montarEscritaPedidoLi(outro, mapeado(), AGORA_US).tipo).toBe('sem-mudanca');
  });

  it('⚠️ FROZEN: the operator’s valorCobrado and descontoTotal are kept; the estado is still governed', () => {
    const s = {
      ...criado(
        mapeado(wire({ situacao: { codigo: 'aguardando_pagamento' } }), { capturado: false }),
      ),
      hasUserInteraction: true,
      valorCobrado: 200,
      descontoTotal: 66.63,
    };
    const e = montarEscritaPedidoLi(s, mapeado(), AGORA_US);
    const p = patch(e);
    expect(p).not.toHaveProperty('valorCobrado');
    expect(p).not.toHaveProperty('descontoTotal');
    expect(p).not.toHaveProperty('itens');
    expect(p.estado).toBe(ESTADO_PEDIDO.pago);
  });

  it('⚠️ a FROZEN unpaid pedido still gets the freight promotion and deadline when paid', () => {
    const s = {
      ...criado(
        mapeado(wire({ situacao: { codigo: 'aguardando_pagamento' } }), { capturado: false }),
      ),
      hasUserInteraction: true,
    };
    const frete = patch(montarEscritaPedidoLi(s, mapeado(), AGORA_US)).freteInicial as Record<
      string,
      unknown
    >;
    expect(frete.estado).toBe(ESTADO_FRETE.despachoAutorizado);
    expect(frete.prazoDespacho).not.toBeNull();
  });

  it('NOT frozen: LI’s money is re-taken', () => {
    const s = { ...criado(), valorCobrado: 200 };
    expect(patch(montarEscritaPedidoLi(s, mapeado(), AGORA_US))).toMatchObject({
      valorCobrado: 161.5,
    });
  });

  it('the step-7 loop: a postado pedido with an ERP code, re-imported newer ⇒ only the watermark moves', () => {
    const base = criado(
      mapeado(wire({ envios: [{ ...wire().envios[0], objeto: 'AB123456789BR' }] })),
    );
    const s = {
      ...base,
      freteInicial: {
        ...(base.freteInicial as Record<string, unknown>),
        estado: ESTADO_FRETE.postado,
      },
    };
    const m = mapeado(wire({ envios: [{ ...wire().envios[0], objeto: 'AB123456789BR' }] }), {
      watermarkUs: WATERMARK_US + 5_000_000,
    });
    const e = montarEscritaPedidoLi(s, m, AGORA_US);
    expect(e).toMatchObject({ tipo: 'atualizar', grupos: ['watermark'] });
  });

  it('⚠️ the totals check runs on what will be STORED: a re-priced line LI changed is kept (append-only), so the stored lines no longer add up to the new total', () => {
    const s = criado();
    const reprecificado = wire({
      valor_subtotal: '159.90',
      valor_total: '171.50',
      itens: [
        { ...wire().itens[0], preco_venda: '49.9000', preco_subtotal: '49.9000' },
        wire().itens[1],
      ],
    });
    const e = montarEscritaPedidoLi(
      s,
      mapeado(reprecificado, { watermarkUs: WATERMARK_US + 1 }),
      AGORA_US,
    );
    expect(e.tipo).toBe('atualizar');
    expect(e.tipo === 'atualizar' && e.totaisDivergentes).toBe(true);
  });

  it('NEAR-MISS: the unchanged order agrees (create and redelivery); a FROZEN pedido is the operator’s money, never checked', () => {
    const e = montarEscritaPedidoLi(null, mapeado(), AGORA_US);
    expect(e.tipo === 'criar' && e.totaisDivergentes).toBe(false);
    const igual = montarEscritaPedidoLi(criado(), mapeado(), AGORA_US);
    expect(igual.tipo === 'sem-mudanca' && igual.totaisDivergentes).toBe(false);
    const congelado = { ...criado(), hasUserInteraction: true, descontoTotal: 50 };
    const r = montarEscritaPedidoLi(congelado, mapeado(), AGORA_US);
    expect(r.tipo === 'sem-mudanca' && r.totaisDivergentes).toBe(false);
  });

  it('ultimaModificacao never goes backwards', () => {
    const s = { ...criado(), ultimaModificacao: AGORA_US + 99 };
    const e = montarEscritaPedidoLi(
      s,
      mapeado(wire(), { watermarkUs: WATERMARK_US + 1 }),
      AGORA_US,
    );
    expect(patch(e).ultimaModificacao).toBe(AGORA_US + 99);
  });
});

describe('mesclarItensLi: append-only', () => {
  const linha = (id: string, produtoUid: string | null) => ({
    ensureUniqueId: id,
    produtoUid,
    precoDeVenda: 1,
    quantidade: 1,
  });

  it('appends a new line; keeps a stored one untouched (an operator’s binding included)', () => {
    const r = mesclarItensLi({ op: [{ ...linha('1', 'op'), precoDeVenda: 9 }] }, [
      { ...linha('1', 'outro'), precoDeVenda: 1 } as never,
      linha('2', null) as never,
    ]);
    expect(r?.itens).toEqual({
      op: [{ ...linha('1', 'op'), precoDeVenda: 9 }],
      NONE: [linha('2', null)],
    });
  });

  it('nothing new ⇒ null; nothing is ever removed', () => {
    expect(
      mesclarItensLi({ NONE: [linha('1', null)], p: [linha('2', 'p')] }, [
        linha('1', null) as never,
      ]),
    ).toBeNull();
  });

  it('a stored `itens` that is not a map of lists is left alone', () => {
    expect(mesclarItensLi('x', [linha('1', null) as never])).toBeNull();
    expect(mesclarItensLi({ NONE: 'x' }, [linha('1', null) as never])).toBeNull();
    expect(mesclarItensLi(undefined, [linha('1', null) as never])?.itensIds).toEqual(['NONE']);
  });
});
