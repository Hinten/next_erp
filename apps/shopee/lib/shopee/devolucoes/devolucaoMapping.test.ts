import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { coerceToMicros } from '@delfrance/core/datetime';
import {
  ORIGEM_INCIDENTE,
  PENDENCIA_RECLAMACAO,
  STATUS_CLAIM,
  TIPO_INCIDENTE,
  type StatusClaim,
} from '@delfrance/schemas';
import {
  SHOPEE_RETURN_SOLUTION,
  createShopeeClient,
  resolveShopeeHosts,
  shopeeReturnDetailBodySchema,
  shopeeReturnListRowSchema,
  type ShopeeReturnDetail,
  type ShopeeReturnListRow,
} from '@delfrance/integrations-shopee';

import {
  FIXTURE_RETURN_DETAIL_DOC,
  FIXTURE_RETURN_LIST_DOC,
  WIRE_DIR,
  lerDevolucaoDetalhe,
  lerListaDeDevolucoes,
} from '../fixtures/wireCorpus';
import { PISO_SEGUNDOS_SHOPEE, microsDeSegundosShopee } from '../pedidos/orderMapping';
import {
  STATUS_DEVOLUCAO_CONHECIDOS,
  STATUS_DEVOLUCAO_SHOPEE,
  STATUS_DEVOLUCAO_TERMINAIS,
  TETO_REVISAO_NO_RELOGIO_DO_AVISO,
  devolucaoShopeeArmazenadaSchema,
  mapearDevolucaoShopee,
  mesmoConteudoDevolucao,
  motivoDeReimportacao,
  pendenciaDoVendedor,
  relogioDoAvisoDeDevolucao,
  statusClaimDaDevolucao,
  type ConteudoDevolucao,
  type DevolucaoMapeada,
  type DevolucaoShopeeArmazenada,
} from './devolucaoMapping';

/* -------------------------------------------------------------------------- */
/*  Identidades de teste — nenhuma delas é real.                               */
/* -------------------------------------------------------------------------- */

const ORDER_SN = '260910KJBHUJDM';
const RETURN_SN = '2609100000000001';
/** The ALPHANUMERIC fixture the corpus detail carries. */
const RETURN_SN_ALFA = '260910ABCDE0001';

/** 2026-09-10 — SECONDS, like every Shopee clock. */
const UPDATE_S = 1_789_042_568;
const CREATE_S = 1_788_900_000;
const PRAZO_S = 1_789_400_000;

/** A detail through the PACKAGE schema — the only shape the importer ever sees. */
function detalhe(campos: Record<string, unknown> = {}): ShopeeReturnDetail {
  return shopeeReturnDetailBodySchema.parse({
    return_sn: RETURN_SN,
    order_sn: ORDER_SN,
    status: STATUS_DEVOLUCAO_SHOPEE.requested,
    update_time: UPDATE_S,
    ...campos,
  });
}

/** A list row through the PACKAGE schema. */
function linha(campos: Record<string, unknown> = {}): ShopeeReturnListRow {
  return shopeeReturnListRowSchema.parse({
    return_sn: RETURN_SN,
    order_sn: ORDER_SN,
    status: STATUS_DEVOLUCAO_SHOPEE.requested,
    update_time: UPDATE_S,
    ...campos,
  });
}

/** The content of a mapped return, as the transaction compares it. */
function conteudo(m: DevolucaoMapeada): ConteudoDevolucao {
  return {
    origem: m.origem,
    tipo: m.tipo,
    externalId: m.externalId,
    claimStatus: m.claimStatus,
    claimStage: m.claimStage,
    entregue: m.entregue,
    bloco: m.bloco,
  };
}

/** A content whose bloco has ONE field overridden (typed loosely on purpose: a stored doc can hold anything). */
function comBloco(base: ConteudoDevolucao, campos: Record<string, unknown>): ConteudoDevolucao {
  return { ...base, bloco: { ...base.bloco, ...campos } as ConteudoDevolucao['bloco'] };
}

function comPrazos(base: ConteudoDevolucao, campos: Record<string, unknown>): ConteudoDevolucao {
  return comBloco(base, { prazos: { ...base.bloco.prazos, ...campos } });
}

/**
 * Buyer keys that must NEVER appear in anything this module produces — the
 * key-walk half of RT-5 (R-11).
 */
const CHAVES_DO_COMPRADOR = [
  'user',
  'username',
  'email',
  'portrait',
  'image',
  'images',
  'buyer_videos',
  'video_url',
  'thumbnail_url',
  'text_reason',
  'dispute_text_reason',
  'tracking_number',
  'latest_offer_creator',
  'return_pickup_address',
  'address',
  'phone',
  'name',
  'zipcode',
  'virtual_contact_number',
  'package_query_number',
  'item',
  'activity',
];

function chavesEmProfundidade(v: unknown, acc: string[] = []): string[] {
  if (Array.isArray(v)) {
    for (const x of v) chavesEmProfundidade(x, acc);
  } else if (typeof v === 'object' && v !== null) {
    for (const [k, x] of Object.entries(v)) {
      acc.push(k);
      chavesEmProfundidade(x, acc);
    }
  }
  return acc;
}

/* -------------------------------------------------------------------------- */
/*                                 the status sets                             */
/* -------------------------------------------------------------------------- */

describe('statusClaimDaDevolucao — terminal = {CLOSED, CANCELLED}, o resto ABERTO', () => {
  it('os sete status documentados, um a um (tabela explícita)', () => {
    const esperado: Record<string, StatusClaim> = {
      REQUESTED: STATUS_CLAIM.aberta,
      ACCEPTED: STATUS_CLAIM.aberta,
      CANCELLED: STATUS_CLAIM.fechada,
      JUDGING: STATUS_CLAIM.aberta,
      CLOSED: STATUS_CLAIM.fechada,
      PROCESSING: STATUS_CLAIM.aberta,
      SELLER_DISPUTE: STATUS_CLAIM.aberta,
    };
    // Anchor: the table covers exactly the documented vocabulary.
    expect(Object.keys(esperado).sort()).toEqual(Object.values(STATUS_DEVOLUCAO_SHOPEE).sort());
    for (const [status, claim] of Object.entries(esperado)) {
      expect(statusClaimDaDevolucao(status), status).toBe(claim);
    }
    expect([...STATUS_DEVOLUCAO_TERMINAIS].sort()).toEqual(['CANCELLED', 'CLOSED']);
  });

  it('⚠️ ACCEPTED é ABERTO — disputa, compensação e evidência acontecem nele', () => {
    expect(statusClaimDaDevolucao(STATUS_DEVOLUCAO_SHOPEE.accepted)).toBe(STATUS_CLAIM.aberta);
  });

  it.each(['REFUNDED', 'RETURN_CLOSED', 'Closed', 'closed', ' CLOSED', 'CLOSED ', 'CANCELED', ''])(
    'um token desconhecido ou quase-igual (%j) é ABERTO — falha FECHADA',
    (status) => {
      expect(statusClaimDaDevolucao(status)).toBe(STATUS_CLAIM.aberta);
    },
  );
});

describe('STATUS_DEVOLUCAO_CONHECIDOS — o conjunto ÚNICO dos sete (R3 NIT 6)', () => {
  it('é EXATAMENTE os sete documentados, e contém os dois terminais', () => {
    expect([...STATUS_DEVOLUCAO_CONHECIDOS].sort()).toEqual(
      [
        'ACCEPTED',
        'CANCELLED',
        'CLOSED',
        'JUDGING',
        'PROCESSING',
        'REQUESTED',
        'SELLER_DISPUTE',
      ].sort(),
    );
    for (const terminal of STATUS_DEVOLUCAO_TERMINAIS) {
      expect(STATUS_DEVOLUCAO_CONHECIDOS.has(terminal), terminal).toBe(true);
    }
  });

  it.each(['Accepted', 'accepted', ' ACCEPTED', 'ACCEPTED ', 'REFUNDED', 'CANCELED', ''])(
    'QUASE-IGUAL: %j NÃO é conhecido — pertença exata, sem aparar nem dobrar caixa',
    (status) => {
      expect(STATUS_DEVOLUCAO_CONHECIDOS.has(status)).toBe(false);
    },
  );

  it('conhecer não é fechar: um conhecido não-terminal continua ABERTO', () => {
    expect(STATUS_DEVOLUCAO_CONHECIDOS.has(STATUS_DEVOLUCAO_SHOPEE.accepted)).toBe(true);
    expect(statusClaimDaDevolucao(STATUS_DEVOLUCAO_SHOPEE.accepted)).toBe(STATUS_CLAIM.aberta);
  });

  it('UMA cópia: o importador e o gate de ações leem ESTE conjunto, nenhum o rederiva', () => {
    for (const f of ['importarDevolucao.ts', 'estadoDevolucao.ts']) {
      const fonte = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
      // The membership test itself reads the shared set — an import kept beside
      // a private literal set would otherwise pass.
      expect(fonte, f).toContain('STATUS_DEVOLUCAO_CONHECIDOS.has(');
      expect(fonte, f).not.toContain('Object.values(STATUS_DEVOLUCAO_SHOPEE)');
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                                 the mapping                                 */
/* -------------------------------------------------------------------------- */

describe('mapearDevolucaoShopee — o corpo da doc (corpus), campo a campo', () => {
  const doc = lerDevolucaoDetalhe(FIXTURE_RETURN_DETAIL_DOC);

  it('mapeia o detalhe inteiro — cada campo do incidente e do bloco fixado', () => {
    const us = (s: number) => s * 1_000_000;
    expect(mapearDevolucaoShopee(doc.response)).toEqual({
      origem: ORIGEM_INCIDENTE.pedidoShopee,
      tipo: TIPO_INCIDENTE.devolucao,
      externalId: RETURN_SN_ALFA,
      claimStatus: STATUS_CLAIM.aberta,
      claimStage: null,
      entregue: null,
      timestampUs: us(1_655_205_084),
      motivoInicial: 'Devolução Shopee — NOT_RECEIPT',
      relogioProvedorUs: us(1_655_219_544),
      bloco: {
        returnSn: RETURN_SN_ALFA,
        orderSn: ORDER_SN,
        status: 'ACCEPTED',
        solucao: SHOPEE_RETURN_SOLUTION.devolucaoEReembolso,
        motivo: 'NOT_RECEIPT',
        motivoReavaliado: null,
        tipoRequisicao: 0,
        tipoValidacao: 'seller_validation',
        tipoReembolso: 'RRAOC',
        statusLogistica: 'LOGISTICS_REQUEST_CREATED',
        // The doc spells it WITHOUT the `s`; the package copies it over.
        statusLogisticaReversa: 'LOGISTICS_REQUEST_CREATED',
        statusNegociacao: 'PENDING_RESPOND',
        statusProva: 'PENDING',
        statusCompensacao: 'PENDING_REQUEST',
        solucaoOfertada: SHOPEE_RETURN_SOLUTION.devolucaoEReembolso,
        valorOfertado: 12.34,
        contrapropostasRestantes: 0,
        valorReembolso: 13.97,
        valorAntesDesconto: 13.99,
        valorCompensacao: 100,
        moeda: 'SGD',
        vendedorProvidenciaColeta: true,
        prazos: {
          vendedorUs: us(1_655_377_883),
          envioCompradorUs: us(1_655_438_205),
          respostaVendedorUs: us(1_655_438_205),
          provaUs: us(1_655_438_336),
          compensacaoUs: us(1_655_438_336),
          ofertaUs: us(1_655_438_336),
        },
        criadaEmUs: us(1_655_205_084),
      },
    });
  });

  it('nenhuma chave de comprador e nenhum `REDACTED` sobrevive — o key walk (R-11)', () => {
    const mapeada = mapearDevolucaoShopee(doc.response);
    const chaves = chavesEmProfundidade(mapeada);
    // Anti-vacuity: the walk does reach the nested block.
    expect(chaves).toContain('respostaVendedorUs');
    for (const proibida of CHAVES_DO_COMPRADOR) expect(chaves, proibida).not.toContain(proibida);
    expect(JSON.stringify(mapeada)).not.toContain('REDACTED');
  });

  it('o bloco gravado também passa pelo schema armazenado sem perder nem ganhar uma chave', () => {
    const mapeada = mapearDevolucaoShopee(doc.response);
    const gravado = { ...mapeada.bloco, revisao: 1 };
    expect(devolucaoShopeeArmazenadaSchema.parse(gravado)).toEqual(gravado);
    const chaves = Object.keys(devolucaoShopeeArmazenadaSchema.parse(gravado)).sort();
    expect(chaves).toEqual(Object.keys(gravado).sort());
  });
});

describe('RT-5 — corpo commitado → cliente REAL (fetch falso) → mapeamento → schema armazenado → conteúdo', () => {
  it('o mesmo detalhe que o cliente devolve mapeia, regrava e se compara igual a si mesmo', async () => {
    const texto = readFileSync(join(WIRE_DIR, FIXTURE_RETURN_DETAIL_DOC), 'utf8');
    const transporte = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(texto, { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    );
    const client = createShopeeClient({
      partnerId: 1000001,
      partnerKey: 'chave-de-teste-nao-e-credencial',
      hosts: resolveShopeeHosts({ sandbox: true }),
      fetch: transporte,
      shopId: 987654,
      getAccessToken: () => Promise.resolve('access-inventado'),
    });

    const env = await client.getReturnDetail({ returnSn: RETURN_SN_ALFA });
    expect(transporte).toHaveBeenCalledTimes(1);
    const mapeada = mapearDevolucaoShopee(env.response);

    // Stored and read back exactly as the transaction does.
    const relido = devolucaoShopeeArmazenadaSchema.parse(
      JSON.parse(JSON.stringify({ ...mapeada.bloco, revisao: 1 })) as unknown,
    );
    const { revisao, ...blocoRelido } = relido;
    expect(revisao).toBe(1);
    expect(
      mesmoConteudoDevolucao(conteudo(mapeada), { ...conteudo(mapeada), bloco: blocoRelido }),
    ).toBe(true);
    expect(mesmoConteudoDevolucao(conteudo(mapeada), conteudo(mapeada))).toBe(true);

    for (const proibida of CHAVES_DO_COMPRADOR) {
      expect(chavesEmProfundidade(relido), proibida).not.toContain(proibida);
    }
  });
});

describe('mapearDevolucaoShopee — as regras', () => {
  it('relogioProvedorUs = update_time SEGUNDOS → µs por microsDeSegundosShopee (o par)', () => {
    const m = mapearDevolucaoShopee(detalhe());
    expect(m.relogioProvedorUs).toBe(1_789_042_568_000_000);
    expect(m.relogioProvedorUs).toBe(microsDeSegundosShopee(UPDATE_S));
  });

  it('⚠️ NEAR-MISS: coerceToMicros leria os SEGUNDOS como ms — 1970, e toda comparação perderia', () => {
    const m = mapearDevolucaoShopee(detalhe());
    expect(coerceToMicros(UPDATE_S)).toBe(1_789_042_568_000);
    expect(m.relogioProvedorUs).not.toBe(coerceToMicros(UPDATE_S));
    expect(m.relogioProvedorUs).toBeGreaterThan(coerceToMicros(UPDATE_S)!);
  });

  it.each([
    STATUS_DEVOLUCAO_SHOPEE.sellerDispute,
    STATUS_DEVOLUCAO_SHOPEE.judging,
    STATUS_DEVOLUCAO_SHOPEE.closed,
    'UM_STATUS_NOVO',
  ])(
    'tipo `returns` PARA SEMPRE, origem 5, claimStage/entregue null — mesmo em %s (R-1)',
    (status) => {
      const m = mapearDevolucaoShopee(detalhe({ status }));
      expect(m.tipo).toBe(TIPO_INCIDENTE.devolucao);
      expect(m.origem).toBe(ORIGEM_INCIDENTE.pedidoShopee);
      expect(m.claimStage).toBeNull();
      expect(m.entregue).toBeNull();
      expect(m.bloco.status).toBe(status);
    },
  );

  it('o status é gravado VERBATIM e o claim sai dele — um token acolchoado fica ABERTO', () => {
    const m = mapearDevolucaoShopee(detalhe({ status: ' CLOSED' }));
    expect(m.bloco.status).toBe(' CLOSED');
    expect(m.claimStatus).toBe(STATUS_CLAIM.aberta);
    expect(mapearDevolucaoShopee(detalhe({ status: 'CLOSED' })).claimStatus).toBe(
      STATUS_CLAIM.fechada,
    );
  });

  it("motivoReavaliado: o literal 'NONE' é null; os quase-iguais ficam", () => {
    expect(
      mapearDevolucaoShopee(detalhe({ reassessed_request_reason: 'NONE' })).bloco.motivoReavaliado,
    ).toBeNull();
    expect(
      mapearDevolucaoShopee(detalhe({ reassessed_request_reason: 'WRONG_ITEM' })).bloco
        .motivoReavaliado,
    ).toBe('WRONG_ITEM');
    for (const quase of ['None', 'none', 'NONE_GIVEN', 'NO_REASON']) {
      expect(
        mapearDevolucaoShopee(detalhe({ reassessed_request_reason: quase })).bloco.motivoReavaliado,
      ).toBe(quase);
    }
  });

  it("⚠️ motivo `'NONE'` é um VALOR da lista de razões (guide 227) e é mantido", () => {
    const m = mapearDevolucaoShopee(detalhe({ reason: 'NONE' }));
    expect(m.bloco.motivo).toBe('NONE');
    expect(m.motivoInicial).toBe('Devolução Shopee — NONE');
  });

  it('motivoInicial: sem razão é só o rótulo; uma razão enorme é cortada em 2000', () => {
    expect(mapearDevolucaoShopee(detalhe()).motivoInicial).toBe('Devolução Shopee');
    expect(mapearDevolucaoShopee(detalhe({ reason: '' })).motivoInicial).toBe('Devolução Shopee');
    expect(mapearDevolucaoShopee(detalhe({ reason: '-' })).motivoInicial).toBe('Devolução Shopee');
    const longa = mapearDevolucaoShopee(detalhe({ reason: 'X'.repeat(5000) })).motivoInicial;
    expect(longa).toHaveLength(2000);
    expect(longa.startsWith('Devolução Shopee — XXX')).toBe(true);
  });

  it('um prazo ZERADO (ou antes de 2020) é null, nunca 0 — e o piso exato é um prazo', () => {
    const zerado = mapearDevolucaoShopee(
      detalhe({
        due_date: 0,
        return_ship_due_date: PISO_SEGUNDOS_SHOPEE - 1,
        return_seller_due_date: PISO_SEGUNDOS_SHOPEE,
        create_time: 0,
        seller_proof: { seller_proof_status: 'PENDING', seller_evidence_deadline: 0 },
        negotiation: { negotiation_status: 'PENDING_RESPOND', offer_due_date: 0 },
        seller_compensation: { seller_compensation_status: 'X', seller_compensation_due_date: 0 },
      }),
    );
    expect(zerado.bloco.prazos).toEqual({
      vendedorUs: null,
      envioCompradorUs: null,
      respostaVendedorUs: PISO_SEGUNDOS_SHOPEE * 1_000_000,
      provaUs: null,
      compensacaoUs: null,
      ofertaUs: null,
    });
    expect(zerado.bloco.criadaEmUs).toBeNull();
  });

  it('timestampUs = criadaEmUs; sem create_time, cai no relógio do provedor (nunca num relógio de parede)', () => {
    expect(mapearDevolucaoShopee(detalhe({ create_time: CREATE_S })).timestampUs).toBe(
      CREATE_S * 1_000_000,
    );
    expect(mapearDevolucaoShopee(detalhe()).timestampUs).toBe(UPDATE_S * 1_000_000);
  });

  it('⚠️ zeros que SÃO valores ficam: tipoRequisicao 0, contrapropostas 0, reembolso 0', () => {
    const m = mapearDevolucaoShopee(
      detalhe({
        return_refund_request_type: 0,
        refund_amount: 0,
        negotiation: { counter_limit: 0 },
      }),
    );
    expect(m.bloco.tipoRequisicao).toBe(0);
    expect(m.bloco.contrapropostasRestantes).toBe(0);
    expect(m.bloco.valorReembolso).toBe(0);
  });

  it('tokens: vazio e a sentinela `-` são ausência; o valor é aparado e nunca reescrito', () => {
    const m = mapearDevolucaoShopee(
      detalhe({
        currency: '',
        validation_type: '-',
        return_refund_type: ' RRBOC ',
        logistics_status: 'Delivery Failed',
      }),
    );
    expect(m.bloco.moeda).toBeNull();
    expect(m.bloco.tipoValidacao).toBeNull();
    expect(m.bloco.tipoReembolso).toBe('RRBOC');
    // In-transit RR tokens are mixed-case with spaces — kept, never upper-cased.
    expect(m.bloco.statusLogistica).toBe('Delivery Failed');
  });

  it('solução: 0/1 e as grafias de texto pelo normalizador do pacote; o resto é null', () => {
    expect(mapearDevolucaoShopee(detalhe({ return_solution: 1 })).bloco.solucao).toBe(
      SHOPEE_RETURN_SOLUTION.soReembolso,
    );
    expect(mapearDevolucaoShopee(detalhe({ return_solution: 2 })).bloco.solucao).toBeNull();
    expect(
      mapearDevolucaoShopee(detalhe({ negotiation: { latest_solution: 'REFUND' } })).bloco
        .solucaoOfertada,
    ).toBe(SHOPEE_RETURN_SOLUTION.soReembolso);
    expect(
      mapearDevolucaoShopee(detalhe({ negotiation: { latest_solution: 'refund' } })).bloco
        .solucaoOfertada,
    ).toBeNull();
  });

  it('sub-objetos ausentes dão nulls, nunca um throw', () => {
    const m = mapearDevolucaoShopee(detalhe());
    expect(m.bloco.statusNegociacao).toBeNull();
    expect(m.bloco.statusProva).toBeNull();
    expect(m.bloco.statusCompensacao).toBeNull();
    expect(m.bloco.valorOfertado).toBeNull();
    expect(m.bloco.prazos.ofertaUs).toBeNull();
  });

  it('cada prazo, valor e status vem do SEU campo — o corpo da doc repete valores e não separa', () => {
    // The doc body prints the same second on three deadlines and the same token
    // on both logistics fields, so a swap there passes the corpus test. Six
    // distinct seconds, two distinct tokens, three distinct amounts.
    const m = mapearDevolucaoShopee(
      detalhe({
        due_date: PRAZO_S + 1,
        return_ship_due_date: PRAZO_S + 2,
        return_seller_due_date: PRAZO_S + 3,
        seller_proof: { seller_proof_status: 'PENDING', seller_evidence_deadline: PRAZO_S + 4 },
        seller_compensation: {
          seller_compensation_status: 'PENDING_REQUEST',
          seller_compensation_due_date: PRAZO_S + 5,
          compensation_amount: 7.5,
        },
        negotiation: {
          negotiation_status: 'PENDING_RESPOND',
          latest_offer_amount: 8.25,
          offer_due_date: PRAZO_S + 6,
        },
        refund_amount: 9.75,
        amount_before_discount: 9.99,
        logistics_status: 'LOGISTICS_REQUEST_CREATED',
        reverse_logistics_status: 'LOGISTICS_PICKUP_DONE',
      }),
    );
    const us = (s: number) => s * 1_000_000;
    expect(m.bloco.prazos).toEqual({
      vendedorUs: us(PRAZO_S + 1),
      envioCompradorUs: us(PRAZO_S + 2),
      respostaVendedorUs: us(PRAZO_S + 3),
      provaUs: us(PRAZO_S + 4),
      compensacaoUs: us(PRAZO_S + 5),
      ofertaUs: us(PRAZO_S + 6),
    });
    expect(m.bloco.valorCompensacao).toBe(7.5);
    expect(m.bloco.valorOfertado).toBe(8.25);
    expect(m.bloco.valorReembolso).toBe(9.75);
    expect(m.bloco.valorAntesDesconto).toBe(9.99);
    expect(m.bloco.statusLogistica).toBe('LOGISTICS_REQUEST_CREATED');
    expect(m.bloco.statusLogisticaReversa).toBe('LOGISTICS_PICKUP_DONE');
    expect(m.bloco.statusNegociacao).toBe('PENDING_RESPOND');
    expect(m.bloco.statusProva).toBe('PENDING');
    expect(m.bloco.statusCompensacao).toBe('PENDING_REQUEST');
  });
});

/* -------------------------------------------------------------------------- */
/*                              the stored schema                              */
/* -------------------------------------------------------------------------- */

describe('devolucaoShopeeArmazenadaSchema', () => {
  const minimo = { revisao: 1, returnSn: RETURN_SN, orderSn: ORDER_SN, status: 'REQUESTED' };

  it('o mínimo lê com TODO campo opcional em null (prazos inclusive) — null ≡ ausente', () => {
    const lido = devolucaoShopeeArmazenadaSchema.parse(minimo);
    const { revisao, returnSn, orderSn, status, prazos, ...resto } = lido;
    expect({ revisao, returnSn, orderSn, status }).toEqual(minimo);
    expect(Object.values(prazos).every((v) => v === null)).toBe(true);
    expect(Object.values(resto).every((v) => v === null)).toBe(true);
    // Anchor: the shape this file compares has 25 keys (+ 6 prazos).
    expect(Object.keys(lido)).toHaveLength(25);
    expect(Object.keys(prazos)).toHaveLength(6);
  });

  it('REMOVE uma chave que ele não nomeia (um campo de comprador nunca sobrevive a uma releitura)', () => {
    const lido = devolucaoShopeeArmazenadaSchema.parse({
      ...minimo,
      user: { email: 'x' },
      text_reason: 'y',
    });
    expect(lido).not.toHaveProperty('user');
    expect(lido).not.toHaveProperty('text_reason');
  });

  it.each([
    ['sem revisao', { ...minimo, revisao: undefined }],
    ['revisao 0', { ...minimo, revisao: 0 }],
    ['revisao fracionária', { ...minimo, revisao: 1.5 }],
    ['sem returnSn', { ...minimo, returnSn: undefined }],
    ['status vazio', { ...minimo, status: '' }],
    ['valor como texto', { ...minimo, valorReembolso: '10.5' }],
    ['prazo fracionário', { ...minimo, prazos: { vendedorUs: 1.5 } }],
    ['prazos null', { ...minimo, prazos: null }],
    ['solução fora do enum', { ...minimo, solucao: 'RETURN_AND_REFUND' }],
  ])('RECUSA um bloco ilegível (%s) — quem chama trata como ilegível e regrava', (_r, bruto) => {
    expect(devolucaoShopeeArmazenadaSchema.safeParse(bruto).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                               content equality                              */
/* -------------------------------------------------------------------------- */

describe('mesmoConteudoDevolucao — campo a campo, estrito (R-9)', () => {
  const base = conteudo(
    mapearDevolucaoShopee(
      detalhe({
        status: 'ACCEPTED',
        refund_amount: 10.5,
        due_date: PRAZO_S,
        create_time: CREATE_S,
        reason: 'WRONG_ITEM',
        is_seller_arrange: false,
        return_refund_request_type: 0,
      }),
    ),
  );

  it('IGUAL: o mesmo conteúdo, e um clone dele', () => {
    expect(mesmoConteudoDevolucao(base, base)).toBe(true);
    expect(mesmoConteudoDevolucao(base, structuredClone(base))).toBe(true);
  });

  it('IGUAL: null ≡ chave ausente — no topo, no bloco e no objeto de prazos inteiro', () => {
    const semChaves = structuredClone(base) as unknown as Record<string, unknown>;
    delete semChaves.claimStage;
    delete semChaves.entregue;
    const bloco = semChaves.bloco as Record<string, unknown>;
    delete bloco.moeda;
    delete bloco.motivoReavaliado;
    expect(mesmoConteudoDevolucao(base, semChaves as unknown as ConteudoDevolucao)).toBe(true);

    const todosPrazosNulos = comPrazos(base, {
      vendedorUs: null,
      envioCompradorUs: null,
      respostaVendedorUs: null,
      provaUs: null,
      compensacaoUs: null,
      ofertaUs: null,
    });
    const semPrazos = comBloco(todosPrazosNulos, { prazos: undefined });
    expect(mesmoConteudoDevolucao(todosPrazosNulos, semPrazos)).toBe(true);
  });

  it('DISTINTO (near-miss): um prazo que andou 1 µs', () => {
    const vendedorUs = base.bloco.prazos.vendedorUs!;
    expect(mesmoConteudoDevolucao(base, comPrazos(base, { vendedorUs: vendedorUs + 1 }))).toBe(
      false,
    );
  });

  it("DISTINTO (near-miss): 'ACCEPTED' vs 'Accepted' — nenhuma dobra de caixa", () => {
    expect(mesmoConteudoDevolucao(base, comBloco(base, { status: 'Accepted' }))).toBe(false);
  });

  it('DISTINTO (near-miss): 10.5 vs 10.51 — e vs 10.50 é o MESMO número', () => {
    expect(mesmoConteudoDevolucao(base, comBloco(base, { valorReembolso: 10.51 }))).toBe(false);
    expect(mesmoConteudoDevolucao(base, comBloco(base, { valorReembolso: 10.5 }))).toBe(true);
  });

  it('DISTINTO (near-miss): 0 vs null, false vs null, "" vs null — só undefined dobra para null', () => {
    expect(base.bloco.tipoRequisicao).toBe(0);
    expect(mesmoConteudoDevolucao(base, comBloco(base, { tipoRequisicao: null }))).toBe(false);
    expect(base.bloco.vendedorProvidenciaColeta).toBe(false);
    expect(mesmoConteudoDevolucao(base, comBloco(base, { vendedorProvidenciaColeta: null }))).toBe(
      false,
    );
    expect(
      mesmoConteudoDevolucao(comBloco(base, { moeda: '' }), comBloco(base, { moeda: null })),
    ).toBe(false);
  });

  it('DISTINTO: um operador que redigitou origem/tipo — o próximo import re-afirma (R-16)', () => {
    const redigitado = { ...base, origem: ORIGEM_INCIDENTE.outros } as unknown as ConteudoDevolucao;
    expect(mesmoConteudoDevolucao(base, redigitado)).toBe(false);
    const retipado = {
      ...base,
      tipo: TIPO_INCIDENTE.mediacaoDoMarketplace,
    } as unknown as ConteudoDevolucao;
    expect(mesmoConteudoDevolucao(base, retipado)).toBe(false);
    const origemML = {
      ...base,
      origem: ORIGEM_INCIDENTE.pedidoMercadoLivre,
    } as unknown as ConteudoDevolucao;
    expect(mesmoConteudoDevolucao(base, origemML)).toBe(false);
  });

  it('DISTINTO: cada campo do topo, um de cada vez', () => {
    const variantes: readonly Partial<Record<keyof ConteudoDevolucao, unknown>>[] = [
      { externalId: '2609100000000002' },
      { claimStatus: STATUS_CLAIM.fechada },
      { claimStage: 'dispute' },
      { entregue: true },
    ];
    for (const v of variantes) {
      expect(
        mesmoConteudoDevolucao(base, { ...base, ...v } as ConteudoDevolucao),
        JSON.stringify(v),
      ).toBe(false);
    }
  });

  it('DISTINTO: CADA campo do schema armazenado, um de cada vez — um campo esquecido aqui fica vermelho', () => {
    // Derived from the SCHEMA, not from a list in this test: a field added to
    // `devolucaoShopeeArmazenadaSchema` and forgotten in `mesmoBloco` fails here.
    const molde = devolucaoShopeeArmazenadaSchema.parse({
      revisao: 1,
      returnSn: RETURN_SN,
      orderSn: ORDER_SN,
      status: 'REQUESTED',
    });
    const campos = Object.keys(molde).filter((k) => k !== 'revisao' && k !== 'prazos');
    const prazos = Object.keys(molde.prazos);
    expect(campos).toHaveLength(23);
    expect(prazos).toHaveLength(6);

    /** A value no real field holds, of a type the strict compare cannot fold away. */
    const outro = (atual: unknown): unknown =>
      typeof atual === 'number'
        ? atual + 1
        : typeof atual === 'boolean'
          ? !atual
          : `${String(atual)}-x`;

    for (const campo of campos) {
      const atual = (base.bloco as unknown as Record<string, unknown>)[campo];
      expect(mesmoConteudoDevolucao(base, comBloco(base, { [campo]: outro(atual) })), campo).toBe(
        false,
      );
    }
    for (const prazo of prazos) {
      const atual = (base.bloco.prazos as Record<string, unknown>)[prazo] ?? PRAZO_S * 1_000_000;
      expect(mesmoConteudoDevolucao(base, comPrazos(base, { [prazo]: outro(atual) })), prazo).toBe(
        false,
      );
    }
  });

  it('`revisao` NÃO é conteúdo — é derivada desta resposta', () => {
    const comRevisao = comBloco(base, { revisao: 7 });
    expect(mesmoConteudoDevolucao(base, comRevisao)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*                               the seller's pendência                        */
/* -------------------------------------------------------------------------- */

describe('pendenciaDoVendedor', () => {
  const us = (s: number) => s * 1_000_000;
  const bloco = (campos: Record<string, unknown> = {}) =>
    mapearDevolucaoShopee(detalhe(campos)).bloco;

  it('só numa devolução ABERTA — fechada ou sem claim, nada', () => {
    const b = bloco({
      seller_proof: { seller_proof_status: 'PENDING', seller_evidence_deadline: PRAZO_S },
    });
    expect(pendenciaDoVendedor(STATUS_CLAIM.fechada, b)).toBeNull();
    expect(pendenciaDoVendedor(null, b)).toBeNull();
    expect(pendenciaDoVendedor(STATUS_CLAIM.aberta, b)).not.toBeNull();
  });

  it.each([STATUS_DEVOLUCAO_SHOPEE.requested, STATUS_DEVOLUCAO_SHOPEE.processing])(
    '%s → responder-solicitacao, prazo = o MAIS PRÓXIMO entre resposta e due_date',
    (status) => {
      const b = bloco({ status, return_seller_due_date: PRAZO_S, due_date: PRAZO_S - 60 });
      expect(pendenciaDoVendedor(STATUS_CLAIM.aberta, b)).toEqual({
        pendencia: PENDENCIA_RECLAMACAO.responderSolicitacao,
        prazoUs: us(PRAZO_S - 60),
      });
      const soResposta = bloco({ status, return_seller_due_date: PRAZO_S });
      expect(pendenciaDoVendedor(STATUS_CLAIM.aberta, soResposta)?.prazoUs).toBe(us(PRAZO_S));
      const soDue = bloco({ status, due_date: PRAZO_S });
      expect(pendenciaDoVendedor(STATUS_CLAIM.aberta, soDue)?.prazoUs).toBe(us(PRAZO_S));
      expect(pendenciaDoVendedor(STATUS_CLAIM.aberta, bloco({ status }))?.prazoUs).toBeNull();
    },
  );

  it.each([
    STATUS_DEVOLUCAO_SHOPEE.accepted,
    STATUS_DEVOLUCAO_SHOPEE.judging,
    STATUS_DEVOLUCAO_SHOPEE.sellerDispute,
    'Requested',
  ])('%s sozinho não é pendência (nada a responder)', (status) => {
    expect(pendenciaDoVendedor(STATUS_CLAIM.aberta, bloco({ status }))).toBeNull();
  });

  it('PENDING_RESPOND → responder-proposta (prazo da oferta); PENDING_BUYER_RESPOND não é', () => {
    const minha = bloco({
      status: 'ACCEPTED',
      negotiation: { negotiation_status: 'PENDING_RESPOND', offer_due_date: PRAZO_S },
    });
    expect(pendenciaDoVendedor(STATUS_CLAIM.aberta, minha)).toEqual({
      pendencia: PENDENCIA_RECLAMACAO.responderProposta,
      prazoUs: us(PRAZO_S),
    });
    const doComprador = bloco({
      status: 'ACCEPTED',
      negotiation: { negotiation_status: 'PENDING_BUYER_RESPOND', offer_due_date: PRAZO_S },
    });
    expect(pendenciaDoVendedor(STATUS_CLAIM.aberta, doComprador)).toBeNull();
  });

  it('prova PENDING → enviar-evidencias; UPLOADED/OVERDUE/NOT_NEEDED e a compensação não são', () => {
    const pendente = bloco({
      status: 'ACCEPTED',
      seller_proof: { seller_proof_status: 'PENDING', seller_evidence_deadline: PRAZO_S },
    });
    expect(pendenciaDoVendedor(STATUS_CLAIM.aberta, pendente)).toEqual({
      pendencia: PENDENCIA_RECLAMACAO.enviarEvidencias,
      prazoUs: us(PRAZO_S),
    });
    for (const outro of ['UPLOADED', 'OVERDUE', 'NOT_NEEDED', 'pending']) {
      const b = bloco({ status: 'ACCEPTED', seller_proof: { seller_proof_status: outro } });
      expect(pendenciaDoVendedor(STATUS_CLAIM.aberta, b), outro).toBeNull();
    }
    const compensacao = bloco({
      status: 'ACCEPTED',
      seller_compensation: {
        seller_compensation_status: 'PENDING_REQUEST',
        seller_compensation_due_date: PRAZO_S,
      },
    });
    expect(pendenciaDoVendedor(STATUS_CLAIM.aberta, compensacao)).toBeNull();
  });

  it('⚠️ escolhe o prazo MAIS PRÓXIMO, não a ordem fixa — a evidência vence a solicitação mais distante', () => {
    const b = bloco({
      status: 'REQUESTED',
      return_seller_due_date: PRAZO_S + 3600,
      seller_proof: { seller_proof_status: 'PENDING', seller_evidence_deadline: PRAZO_S },
    });
    expect(pendenciaDoVendedor(STATUS_CLAIM.aberta, b)).toEqual({
      pendencia: PENDENCIA_RECLAMACAO.enviarEvidencias,
      prazoUs: us(PRAZO_S),
    });
  });

  it('empate → a ordem fixa (solicitação, proposta, evidências)', () => {
    const tres = bloco({
      status: 'PROCESSING',
      return_seller_due_date: PRAZO_S,
      negotiation: { negotiation_status: 'PENDING_RESPOND', offer_due_date: PRAZO_S },
      seller_proof: { seller_proof_status: 'PENDING', seller_evidence_deadline: PRAZO_S },
    });
    expect(pendenciaDoVendedor(STATUS_CLAIM.aberta, tres)?.pendencia).toBe(
      PENDENCIA_RECLAMACAO.responderSolicitacao,
    );
    const duas = bloco({
      status: 'ACCEPTED',
      negotiation: { negotiation_status: 'PENDING_RESPOND', offer_due_date: PRAZO_S },
      seller_proof: { seller_proof_status: 'PENDING', seller_evidence_deadline: PRAZO_S },
    });
    expect(pendenciaDoVendedor(STATUS_CLAIM.aberta, duas)?.pendencia).toBe(
      PENDENCIA_RECLAMACAO.responderProposta,
    );
  });

  it('sem prazo vai por ÚLTIMO; todas sem prazo → a primeira da ordem', () => {
    const b = bloco({
      status: 'REQUESTED',
      negotiation: { negotiation_status: 'PENDING_RESPOND', offer_due_date: PRAZO_S + 7200 },
    });
    expect(pendenciaDoVendedor(STATUS_CLAIM.aberta, b)).toEqual({
      pendencia: PENDENCIA_RECLAMACAO.responderProposta,
      prazoUs: us(PRAZO_S + 7200),
    });
    const semNenhum = bloco({
      status: 'REQUESTED',
      seller_proof: { seller_proof_status: 'PENDING' },
    });
    expect(pendenciaDoVendedor(STATUS_CLAIM.aberta, semNenhum)).toEqual({
      pendencia: PENDENCIA_RECLAMACAO.responderSolicitacao,
      prazoUs: null,
    });
  });

  it('do corpo da doc (ACCEPTED, proposta e prova no mesmo segundo) → responder-proposta', () => {
    const m = mapearDevolucaoShopee(lerDevolucaoDetalhe(FIXTURE_RETURN_DETAIL_DOC).response);
    expect(pendenciaDoVendedor(m.claimStatus, m.bloco)).toEqual({
      pendencia: PENDENCIA_RECLAMACAO.responderProposta,
      prazoUs: us(1_655_438_336),
    });
  });

  it('aceita o bloco ARMAZENADO (com revisao) tal como a transação o confirma', () => {
    const armazenado: DevolucaoShopeeArmazenada = {
      ...bloco({ status: 'REQUESTED', due_date: PRAZO_S }),
      revisao: 3,
    };
    expect(pendenciaDoVendedor(STATUS_CLAIM.aberta, armazenado)?.pendencia).toBe(
      PENDENCIA_RECLAMACAO.responderSolicitacao,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                         the poller's re-import predicate                    */
/* -------------------------------------------------------------------------- */

describe('motivoDeReimportacao (R-7)', () => {
  /**
   * The detail the importer WOULD have pulled for a list row with the same
   * values — the sub-statuses nest on the detail and sit flat on the list.
   */
  function detalheDaLinha(l: ShopeeReturnListRow): ShopeeReturnDetail {
    return detalhe({
      ...l,
      negotiation: { negotiation_status: l.negotiation_status },
      seller_proof: { seller_proof_status: l.seller_proof_status },
      seller_compensation: { seller_compensation_status: l.seller_compensation_status },
    });
  }

  /** The raw incidente the importer writes for that row. */
  function armazenadoDe(l: ShopeeReturnListRow, revisao = 1): Record<string, unknown> {
    const m = mapearDevolucaoShopee(detalheDaLinha(l));
    return JSON.parse(
      JSON.stringify({
        origem: m.origem,
        tipo: m.tipo,
        externalId: m.externalId,
        claimStatus: m.claimStatus,
        claimStage: m.claimStage,
        entregue: m.entregue,
        timestamp: m.timestampUs,
        motivoDoIncidente: m.motivoInicial,
        ultimaModificacao: m.relogioProvedorUs,
        relogioProvedorUs: m.relogioProvedorUs,
        devolucaoShopee: { ...m.bloco, revisao },
      }),
    ) as Record<string, unknown>;
  }

  const base = linha({
    status: 'REQUESTED',
    negotiation_status: 'PENDING_RESPOND',
    seller_proof_status: 'PENDING',
    seller_compensation_status: 'PENDING_REQUEST',
    due_date: PRAZO_S,
    return_seller_due_date: PRAZO_S + 60,
    return_ship_due_date: PRAZO_S + 120,
    refund_amount: 1409,
    reason: 'WRONG_ITEM',
    currency: 'BRL',
  });

  it('IGUAL: a linha que o importador já gravou → null (relógio igual, projeção igual)', () => {
    expect(motivoDeReimportacao(base, armazenadoDe(base))).toBeNull();
  });

  it('ausente → `ausente`', () => {
    expect(motivoDeReimportacao(base, undefined)).toBe('ausente');
  });

  it('relógio da linha 1 s mais NOVO → `relogio`; igual ou mais velho, não', () => {
    const gravado = armazenadoDe(base);
    expect(motivoDeReimportacao({ ...base, update_time: UPDATE_S + 1 }, gravado)).toBe('relogio');
    expect(motivoDeReimportacao({ ...base, update_time: UPDATE_S }, gravado)).toBeNull();
    expect(motivoDeReimportacao({ ...base, update_time: UPDATE_S - 1 }, gravado)).toBeNull();
  });

  it('µs contra µs: um armazenado 1 µs mais velho que a linha já é `relogio`', () => {
    const gravado = { ...armazenadoDe(base), relogioProvedorUs: UPDATE_S * 1_000_000 - 1 };
    expect(motivoDeReimportacao(base, gravado)).toBe('relogio');
  });

  it.each([
    ['ausente', undefined],
    ['null', null],
    ['texto', String(UPDATE_S * 1_000_000)],
    ['NaN', Number.NaN],
  ])('um relógio armazenado %s conta como MAIS VELHO (R-4) → `relogio`', (_r, relogio) => {
    const gravado = { ...armazenadoDe(base), relogioProvedorUs: relogio };
    expect(motivoDeReimportacao(base, gravado)).toBe('relogio');
  });

  it('G4: sem relógio armazenado é `relogio` MESMO contra uma linha de relógio ZERO — ausente nunca compara como 0', () => {
    // `n > null` is `n > 0` in JS, so a comparison that skipped the explicit
    // null check would answer this row (`update_time: 0`, never a Shopee clock)
    // with a later reason — or none — instead of "the stored doc has no clock".
    const { relogioProvedorUs: _semRelogio, ...gravado } = armazenadoDe(base);
    expect(motivoDeReimportacao({ ...base, update_time: 0 }, gravado)).toBe('relogio');
    expect(motivoDeReimportacao({ ...base, update_time: 0 }, { origem: 5 })).toBe('relogio');
  });

  it.each([
    ['status', { status: 'ACCEPTED' }],
    ['status (só caixa)', { status: 'Requested' }],
    ['negotiation_status', { negotiation_status: 'PENDING_BUYER_RESPOND' }],
    ['seller_proof_status', { seller_proof_status: 'UPLOADED' }],
    ['seller_compensation_status', { seller_compensation_status: 'REQUESTED' }],
    ['due_date', { due_date: PRAZO_S + 1 }],
    ['return_seller_due_date', { return_seller_due_date: PRAZO_S + 61 }],
    ['return_ship_due_date', { return_ship_due_date: PRAZO_S + 121 }],
    ['refund_amount', { refund_amount: 1409.01 }],
    ['um prazo que sumiu', { due_date: 0 }],
  ])(
    'um campo visível na lista que DIVERGE com o mesmo relógio (%s) → `divergente`',
    (_r, campos) => {
      expect(motivoDeReimportacao({ ...base, ...campos }, armazenadoDe(base))).toBe('divergente');
    },
  );

  it('DIVERGE com a linha mais VELHA também (qualquer um, R-7) — custa um detalhe, nunca uma escrita', () => {
    expect(
      motivoDeReimportacao(
        { ...base, update_time: UPDATE_S - 10, status: 'ACCEPTED' },
        armazenadoDe(base),
      ),
    ).toBe('divergente');
  });

  it('um campo que a lista NÃO compara (razão, moeda, solução) nunca reimporta', () => {
    const gravado = armazenadoDe(base);
    expect(motivoDeReimportacao({ ...base, reason: 'ITEM_DAMAGED' }, gravado)).toBeNull();
    expect(motivoDeReimportacao({ ...base, currency: 'SGD' }, gravado)).toBeNull();
    expect(motivoDeReimportacao({ ...base, return_solution: 1 }, gravado)).toBeNull();
  });

  it('a dobra da projeção é a MESMA do mapeamento: "" e `-` ≡ null, prazo 0 ≡ null', () => {
    const vazia = linha({ status: 'REQUESTED' });
    const gravado = armazenadoDe(vazia);
    expect(
      motivoDeReimportacao(
        {
          ...vazia,
          negotiation_status: '',
          seller_proof_status: '-',
          due_date: 0,
          return_ship_due_date: 1,
        },
        gravado,
      ),
    ).toBeNull();
  });

  it.each([
    ['origem redigitada para 99', { origem: ORIGEM_INCIDENTE.outros }],
    ['origem 2 (a do Mercado Livre)', { origem: ORIGEM_INCIDENTE.pedidoMercadoLivre }],
    ['sem origem', { origem: null }],
    ['tipo redigitado', { tipo: TIPO_INCIDENTE.outros }],
    ['tipo mediations', { tipo: TIPO_INCIDENTE.mediacaoDoMarketplace }],
    ['externalId de outra devolução', { externalId: '2609100000000002' }],
    ['claimStatus fechado num status aberto', { claimStatus: STATUS_CLAIM.fechada }],
    ['claimStatus ausente', { claimStatus: null }],
  ])('o armazenado quebra um invariante do importador (%s) → `invariante`', (_r, campos) => {
    expect(motivoDeReimportacao(base, { ...armazenadoDe(base), ...campos })).toBe('invariante');
  });

  it('um claimStatus derivado de um conjunto terminal CORRIGIDO cura a linha (R-3)', () => {
    // Stored with an "opened" claim for a CLOSED status — what a stored row
    // looks like after the terminal set gains a member.
    const fechada = linha({ status: 'CLOSED' });
    const gravado = { ...armazenadoDe(fechada), claimStatus: STATUS_CLAIM.aberta };
    expect(motivoDeReimportacao(fechada, gravado)).toBe('invariante');
    expect(motivoDeReimportacao(fechada, armazenadoDe(fechada))).toBeNull();
  });

  it.each([
    ['sem bloco', { devolucaoShopee: undefined }],
    ['bloco null', { devolucaoShopee: null }],
    [
      'bloco sem revisao',
      { devolucaoShopee: { returnSn: RETURN_SN, orderSn: ORDER_SN, status: 'REQUESTED' } },
    ],
    ['bloco com tipo errado', { devolucaoShopee: 'REQUESTED' }],
  ])('um bloco ilegível (%s) → `invariante`', (_r, campos) => {
    expect(motivoDeReimportacao(base, { ...armazenadoDe(base), ...campos })).toBe('invariante');
  });

  it('precedência: ausente > relógio > divergente > invariante', () => {
    const tudoErrado = { ...armazenadoDe(base), origem: ORIGEM_INCIDENTE.outros };
    const divergente = { ...base, status: 'ACCEPTED' };
    expect(motivoDeReimportacao({ ...divergente, update_time: UPDATE_S + 1 }, tudoErrado)).toBe(
      'relogio',
    );
    expect(motivoDeReimportacao(divergente, tudoErrado)).toBe('divergente');
    expect(motivoDeReimportacao(base, tudoErrado)).toBe('invariante');
  });

  it('do corpo da lista da doc: a linha que o importador gravou não reimporta', () => {
    const rows = lerListaDeDevolucoes(FIXTURE_RETURN_LIST_DOC).response.return;
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row == null) throw new Error('a linha da doc deveria ler');
    expect(motivoDeReimportacao(row, armazenadoDe(row))).toBeNull();
    expect(motivoDeReimportacao(row, undefined)).toBe('ausente');
    expect(
      motivoDeReimportacao({ ...row, update_time: row.update_time + 1 }, armazenadoDe(row)),
    ).toBe('relogio');
  });
});

/* -------------------------------------------------------------------------- */
/*                                the aviso's clock                            */
/* -------------------------------------------------------------------------- */

describe('relogioDoAvisoDeDevolucao', () => {
  const t = UPDATE_S * 1_000_000;

  it('= relogioProvedorUs + min(revisao, 999 999)', () => {
    expect(TETO_REVISAO_NO_RELOGIO_DO_AVISO).toBe(999_999);
    expect(relogioDoAvisoDeDevolucao(t, 1)).toBe(t + 1);
    expect(relogioDoAvisoDeDevolucao(t, 42)).toBe(t + 42);
    expect(relogioDoAvisoDeDevolucao(t, 999_999)).toBe(t + 999_999);
    expect(relogioDoAvisoDeDevolucao(t, 5_000_000)).toBe(t + 999_999);
  });

  it('estritamente crescente a cada mudança de conteúdo no mesmo segundo', () => {
    expect(relogioDoAvisoDeDevolucao(t, 2)).toBeGreaterThan(relogioDoAvisoDeDevolucao(t, 1));
  });

  it('⚠️ monótono ATRAVÉS de um apagar-e-recriar num segundo posterior (revisao volta a 1)', () => {
    // The bare `revisao` would answer 1 < 5 here, and `escreverAviso` would drop
    // every raise of the re-created incidente against the old row's clock.
    const antigo = relogioDoAvisoDeDevolucao(t, 5);
    const recriado = relogioDoAvisoDeDevolucao(t + 1_000_000, 1);
    expect(recriado).toBeGreaterThan(antigo);
    // Even against the cap: the last revision of one second stays below the
    // first of the next.
    expect(relogioDoAvisoDeDevolucao(t + 1_000_000, 1)).toBeGreaterThan(
      relogioDoAvisoDeDevolucao(t, 10_000_000),
    );
  });

  it.each([
    ['revisao 0', t, 0],
    ['revisao negativa', t, -1],
    ['revisao fracionária', t, 1.5],
    ['relógio fracionário', t + 0.5, 1],
    ['relógio negativo', -1, 1],
    ['relógio NaN', Number.NaN, 1],
  ])('RangeError num contrato violado (%s)', (_r, relogio, revisao) => {
    expect(() => relogioDoAvisoDeDevolucao(relogio, revisao)).toThrow(RangeError);
  });
});
