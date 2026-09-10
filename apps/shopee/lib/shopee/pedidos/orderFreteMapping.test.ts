import { describe, expect, it } from 'vitest';
import { millisToMicros } from '@delfrance/core/datetime';
import {
  ESTADO_FRETE,
  INTEGRACAO_FRETE,
  MODALIDADE_FRETE,
  freteDoPedidoSchema,
  getPrazoDespachoNoFuso,
  type FreteDoPedido,
} from '@delfrance/schemas';
import type { ShopeeEscrowDetail, ShopeeOrderDetailRow } from '@delfrance/integrations-shopee';

import { FIXTURE_ORDER_DETAIL_QTY2_SG, lerPedidoDetalhe } from '../fixtures/wireCorpus';
import { microsDeSegundosShopee } from './orderMapping';
import {
  CAMPOS_FRETE_ATUALIZAVEIS_SHOPEE,
  FUSO_PRAZO_DESPACHO_SHOPEE,
  HORARIO_DE_CORTE_PADRAO_SHOPEE,
  mapearFreteInicialShopee,
  mesclarFreteInicialShopee,
  pesoKgDeGramas,
  positivoOuNull,
  prazoDespachoShopee,
  volumesDeShopee,
} from './orderFreteMapping';

const WATERMARK_US = 1_788_973_354_000_000;

/** The SG sandbox order: `READY_TO_SHIP`, one package, `actual_shipping_fee: 0`. */
function detalheSG(): ShopeeOrderDetailRow {
  return lerPedidoDetalhe(FIXTURE_ORDER_DETAIL_QTY2_SG).response.order_list[0]!;
}

/** A row with only the fields a test cares about; everything else parses to null. */
function linha(patch: Record<string, unknown>): ShopeeOrderDetailRow {
  const base = detalheSG();
  return { ...base, ...patch } as ShopeeOrderDetailRow;
}

function escrowCom(frete: number | null): ShopeeEscrowDetail {
  return {
    order_sn: '220810QSK8S7BX',
    buyer_user_name: null,
    return_order_sn_list: null,
    order_income: { buyer_paid_shipping_fee: frete },
    buyer_payment_info: null,
  } as unknown as ShopeeEscrowDetail;
}

describe('positivoOuNull — o zero-fill da Shopee', () => {
  it('aceita um número positivo e recusa 0, negativo, null e NaN', () => {
    expect(positivoOuNull(1.99)).toBe(1.99);
    expect(positivoOuNull(0)).toBeNull();
    expect(positivoOuNull(-1)).toBeNull();
    expect(positivoOuNull(null)).toBeNull();
    expect(positivoOuNull(undefined)).toBeNull();
    expect(positivoOuNull(Number.NaN)).toBeNull();
  });

  it('⚠️ NEAR-MISS: um `??` responderia 0 onde este responde null', () => {
    // The whole reason the reader exists. `actual_shipping_fee ?? estimated`
    // wrote `valorCobrado: 0` onto every unshipped order in the legacy importer.
    const zerado: number | null = 0;
    expect(zerado ?? 1.99).toBe(0);
    expect(positivoOuNull(zerado) ?? 1.99).toBe(1.99);
  });
});

describe('pesoKgDeGramas', () => {
  it('1200 g viram 1.2 kg', () => {
    expect(pesoKgDeGramas(1200)).toBe(1.2);
  });

  it('⚠️ NEAR-MISS: o valor NÃO convertido (1200) não é o que fica armazenado', () => {
    // `pesoBruto` reaches the NF-e `<vol><pesoB>`: 1200 there declares a
    // 1.2-tonne parcel. The legacy wrote `order_chargeable_weight_gram`
    // unconverted into this field.
    expect(pesoKgDeGramas(1200)).not.toBe(1200);
  });

  it('0 gramas é ausência, não um pacote sem peso', () => {
    expect(pesoKgDeGramas(0)).toBeNull();
  });
});

describe('volumesDeShopee', () => {
  it('um volume por pacote, com numero = package_number e especie "pacote"', () => {
    const { volumes } = volumesDeShopee(detalheSG());
    expect(volumes).toHaveLength(1);
    expect(volumes![0]).toMatchObject({
      numero: 'OFG242672552205937',
      quantidade: 1,
      especie: 'pacote',
    });
  });

  it('⚠️ pesoLiquido é SEMPRE null — um peso taxável não é o peso líquido', () => {
    const { volumes } = volumesDeShopee(
      linha({ package_list: [{ package_number: 'P1', parcel_chargeable_weight_gram: 1200 }] }),
    );
    expect(volumes![0]!.pesoBruto).toBe(1.2);
    expect(volumes![0]!.pesoLiquido).toBeNull();
  });

  it('⚠️ dimensoes é null — nunca 10×10×10', () => {
    const { volumes } = volumesDeShopee(detalheSG());
    expect(volumes![0]!.dimensoes).toBeNull();
  });

  it('tolera as DUAS grafias do peso, sem dobrar uma na outra', () => {
    const comGram = volumesDeShopee(
      linha({ package_list: [{ package_number: 'P1', parcel_chargeable_weight_gram: 500 }] }),
    );
    const semGram = volumesDeShopee(
      linha({ package_list: [{ package_number: 'P1', parcel_chargeable_weight: 500 }] }),
    );
    expect(comGram.volumes![0]!.pesoBruto).toBe(0.5);
    expect(semGram.volumes![0]!.pesoBruto).toBe(0.5);
  });

  it('order_chargeable_weight_gram só entra com EXATAMENTE um pacote', () => {
    const um = volumesDeShopee(
      linha({ package_list: [{ package_number: 'P1' }], order_chargeable_weight_gram: 900 }),
    );
    expect(um.volumes![0]!.pesoBruto).toBe(0.9);

    const dois = volumesDeShopee(
      linha({
        package_list: [{ package_number: 'P1' }, { package_number: 'P2' }],
        order_chargeable_weight_gram: 900,
      }),
    );
    // ⚠️ Spreading an ORDER weight across N parcels — or repeating it on each —
    // both state a false fiscal weight.
    expect(dois.volumes!.map((v) => v.pesoBruto)).toEqual([null, null]);
  });

  it('sem package_list, volumes é null (e não uma lista vazia)', () => {
    expect(volumesDeShopee(linha({ package_list: null })).volumes).toBeNull();
  });

  it('reporta o peso BRUTO observado em gramas ao lado dos quilos', () => {
    // The instrumentation the plan asks for: `parcel_chargeable_weight`'s unit is
    // undocumented, so the raw number is logged beside the converted one.
    const { pesosObservados } = volumesDeShopee(
      linha({ package_list: [{ package_number: 'P1', parcel_chargeable_weight_gram: 1200 }] }),
    );
    expect(pesosObservados).toEqual([{ numero: 'P1', gramas: 1200, quilos: 1.2 }]);
  });
});

describe('prazoDespachoShopee', () => {
  it('o ship_by_date da SG vem VERBATIM, convertido para µs', () => {
    const detalhe = detalheSG();
    expect(detalhe.ship_by_date).toBe(1789405354);
    expect(prazoDespachoShopee(detalhe)).toBe(microsDeSegundosShopee(1789405354));
  });

  it('⚠️ NEAR-MISS: o fallback NUNCA se aplica sobre um ship_by_date válido', () => {
    // A mutation that ran the 14:00 rule unconditionally — which is exactly what
    // the legacy did — answers what the FALLBACK computes for this fixture's own
    // `pay_time`, and the two must not be equal. That value is measured here,
    // not asserted from memory: `pay_time` 1788973353 is 2026-09-09T17:02:33Z =
    // Wednesday 14:02 in São Paulo, PAST the 14:00 cut-off, so the rule answers
    // THURSDAY 2026-09-10 at 00:00 São Paulo (03:00Z). A constant the fallback
    // cannot produce would make this line unfalsifiable.
    const detalhe = detalheSG();
    const pelaRegra = millisToMicros(Date.UTC(2026, 8, 10, 3, 0));
    expect(prazoDespachoShopee(linha({ ship_by_date: 0 }))).toBe(pelaRegra);
    expect(prazoDespachoShopee(detalhe)).not.toBe(pelaRegra);
    expect(prazoDespachoShopee(detalhe)).toBe(microsDeSegundosShopee(detalhe.ship_by_date!));
  });

  it('ship_by_date 0 + pay_time numa segunda 16:59Z ⇒ aquela segunda 00:00 São Paulo', () => {
    // 2021-01-04 16:59Z = 13:59 in São Paulo, before the 14:00 cut-off ⇒ the
    // same day; the result is that DAY at 00:00 São Paulo (03:00Z).
    const payTime = Math.floor(Date.UTC(2021, 0, 4, 16, 59) / 1000);
    const prazo = prazoDespachoShopee(linha({ ship_by_date: 0, pay_time: payTime }));
    expect(prazo).toBe(millisToMicros(Date.UTC(2021, 0, 4, 3, 0)));
  });

  it('⚠️ NEAR-MISS: 17:01Z (14:01 em São Paulo) cai no PRÓXIMO dia útil', () => {
    const payTime = Math.floor(Date.UTC(2021, 0, 4, 17, 1) / 1000);
    const prazo = prazoDespachoShopee(linha({ ship_by_date: 0, pay_time: payTime }));
    expect(prazo).toBe(millisToMicros(Date.UTC(2021, 0, 5, 3, 0)));
  });

  it('uma SEXTA depois do corte cai na SEGUNDA', () => {
    // 2021-01-08 is a Friday.
    const payTime = Math.floor(Date.UTC(2021, 0, 8, 17, 1) / 1000);
    const prazo = prazoDespachoShopee(linha({ ship_by_date: 0, pay_time: payTime }));
    expect(prazo).toBe(millisToMicros(Date.UTC(2021, 0, 11, 3, 0)));
  });

  it('⚠️ o fallback usa o FUSO EXPLÍCITO, não o do processo — e um fuso diferente responde outro dia', () => {
    // The mutation this kills is the ambient-zone binding: swapping
    // `getPrazoDespachoNoFuso(..., FUSO_PRAZO_DESPACHO_SHOPEE)` for
    // `getPrazoDespacho(...)` reads the PROCESS's zone, which agrees on a
    // developer machine set to America/Sao_Paulo and on `apps/nfe`
    // (`TZ=America/Sao_Paulo`) while disagreeing everywhere else — the exact
    // failure `delfrance/no-ambient-timezone` exists to name, and one the
    // runner's own zone can hide.
    //
    // Neither assertion depends on the runner: both recompute through the
    // shared helper with the zone NAMED, mirroring `intFrete.test.ts`'s "the
    // SAME instant under timeZone 'UTC' answers a DIFFERENT day".
    const payTimeMs = Date.UTC(2021, 0, 4, 17, 1);
    const detalhe = linha({ ship_by_date: 0, pay_time: Math.floor(payTimeMs / 1000) });

    const emSaoPaulo = getPrazoDespachoNoFuso(
      HORARIO_DE_CORTE_PADRAO_SHOPEE,
      payTimeMs,
      FUSO_PRAZO_DESPACHO_SHOPEE,
    );
    const emUtc = getPrazoDespachoNoFuso(HORARIO_DE_CORTE_PADRAO_SHOPEE, payTimeMs, 'UTC');

    expect(prazoDespachoShopee(detalhe)).toBe(millisToMicros(emSaoPaulo!));
    // The near-miss that gives the line above its teeth: at 17:01Z the two zones
    // land on different sides of the cut-off, so they answer different days.
    expect(emUtc).not.toBe(emSaoPaulo);
    expect(prazoDespachoShopee(detalhe)).not.toBe(millisToMicros(emUtc!));
  });

  it('sem ship_by_date e sem pay_time (pedido não pago) ⇒ null', () => {
    expect(prazoDespachoShopee(linha({ ship_by_date: 0, pay_time: null }))).toBeNull();
    expect(prazoDespachoShopee(linha({ ship_by_date: null, pay_time: 0 }))).toBeNull();
  });

  it('⚠️ NEAR-MISS: um ship_by_date de 1970 é ABSÊNCIA, não uma data', () => {
    // `0` is the zero-fill; `1` is below the 2020 floor. Both must fall through
    // to the rule rather than storing a deadline fifty years in the past.
    const payTime = Math.floor(Date.UTC(2021, 0, 4, 16, 59) / 1000);
    for (const shipBy of [0, 1, 1_500_000_000]) {
      expect(prazoDespachoShopee(linha({ ship_by_date: shipBy, pay_time: payTime }))).toBe(
        millisToMicros(Date.UTC(2021, 0, 4, 3, 0)),
      );
    }
  });

  it('a agenda padrão é seg–sex, corte 14:00, e o fuso é explícito', () => {
    expect(HORARIO_DE_CORTE_PADRAO_SHOPEE.map((h) => h.diaDaSemana)).toEqual([1, 2, 3, 4, 5]);
    for (const h of HORARIO_DE_CORTE_PADRAO_SHOPEE) {
      expect(h).toMatchObject({ horaDeCorte: 14, minutosDeCorte: 0, prazoDePostagem: 0 });
    }
    expect(FUSO_PRAZO_DESPACHO_SHOPEE).toBe('America/Sao_Paulo');
  });
});

describe('mapearFreteInicialShopee', () => {
  it('a fixture SG rende valorCobrado 1.99 — nunca o actual_shipping_fee 0', () => {
    // The zero-fill in the flesh: Shopee sent `actual_shipping_fee: 0` while the
    // buyer paid 1.99. A `??` here stores 0 and the operator sees free shipping.
    const { frete } = mapearFreteInicialShopee({
      detalhe: detalheSG(),
      escrow: null,
      watermarkUs: WATERMARK_US,
    });
    expect(frete.valorCobrado).toBe(1.99);
    expect(frete.custoCalculado).toBe(1.99);
  });

  it('o escrow manda no valorCobrado quando responde', () => {
    const { frete } = mapearFreteInicialShopee({
      detalhe: detalheSG(),
      escrow: escrowCom(2.5),
      watermarkUs: WATERMARK_US,
    });
    // What the BUYER was charged comes from the escrow…
    expect(frete.valorCobrado).toBe(2.5);
    // …while the COST still falls back to the estimate, because Shopee has not
    // billed the shipment yet. Two numbers, two sources, never folded.
    expect(frete.custoCalculado).toBe(1.99);
  });

  it('valorCobrado é null quando nenhuma das duas fontes respondeu — nunca 0', () => {
    const { frete } = mapearFreteInicialShopee({
      detalhe: linha({ estimated_shipping_fee: 0, actual_shipping_fee: 0 }),
      escrow: escrowCom(0),
      watermarkUs: WATERMARK_US,
    });
    expect(frete.valorCobrado).toBeNull();
    expect(frete.custoCalculado).toBeNull();
  });

  it('a modalidade semeada é FOB ("1") e NUNCA CIF ("0")', () => {
    // CIF is the only modalidade that charges freight INTO the nota (#1090).
    const { frete } = mapearFreteInicialShopee({
      detalhe: detalheSG(),
      escrow: null,
      watermarkUs: WATERMARK_US,
    });
    expect(frete.modalidade).toBe(MODALIDADE_FRETE.fob);
    expect(frete.modalidade).not.toBe(MODALIDADE_FRETE.cif);
  });

  it('⚠️ o estado semeado é "iniciado" — logistics_status NÃO é lido', () => {
    // `freteInicial.estado` feeds physical stock removal; step 7 owns it. The
    // SG fixture carries `logistics_status: 'LOGISTICS_READY'`, so a mapper that
    // read it would answer something else here.
    const { frete } = mapearFreteInicialShopee({
      detalhe: detalheSG(),
      escrow: null,
      watermarkUs: WATERMARK_US,
    });
    expect(frete.estado).toBe(ESTADO_FRETE.iniciado);
    expect(detalheSG().package_list![0]!.logistics_status).toBe('LOGISTICS_READY');
  });

  it('externalId/externalOptionId vêm do ÚNICO pacote', () => {
    const { frete } = mapearFreteInicialShopee({
      detalhe: detalheSG(),
      escrow: null,
      watermarkUs: WATERMARK_US,
    });
    expect(frete.externalId).toBe('OFG242672552205937');
    expect(frete.externalOptionId).toBe('11006');
    expect(frete.externalOptionIntegracao).toBe(INTEGRACAO_FRETE.shopee);
  });

  it('⚠️ com DOIS pacotes os dois ids ficam null — um slot não guarda N', () => {
    const { frete } = mapearFreteInicialShopee({
      detalhe: linha({
        package_list: [
          { package_number: 'P1', logistics_channel_id: 1 },
          { package_number: 'P2', logistics_channel_id: 2 },
        ],
      }),
      escrow: null,
      watermarkUs: WATERMARK_US,
    });
    expect(frete.externalId).toBeNull();
    expect(frete.externalOptionId).toBeNull();
    // Every package number still survives, on its own volume.
    expect(frete.volumes!.map((v) => v.numero)).toEqual(['P1', 'P2']);
  });

  it('dataPrevisaoEntrega vem de edt_to e NUNCA de edt_from', () => {
    const de = 1_789_000_000;
    const ate = 1_789_900_000;
    const { frete } = mapearFreteInicialShopee({
      detalhe: linha({ edt_from: de, edt_to: ate }),
      escrow: null,
      watermarkUs: WATERMARK_US,
    });
    expect(frete.dataPrevisaoEntrega).toBe(microsDeSegundosShopee(ate));
    expect(frete.dataPrevisaoEntrega).not.toBe(microsDeSegundosShopee(de));
  });

  it('edt_to 0 (o zero-fill da SG) vira null, não 1970', () => {
    const { frete } = mapearFreteInicialShopee({
      detalhe: detalheSG(),
      escrow: null,
      watermarkUs: WATERMARK_US,
    });
    expect(detalheSG().edt_to).toBe(0);
    expect(frete.dataPrevisaoEntrega).toBeNull();
  });

  it('codRastreio nunca é inventado e ultimaModificacao é o watermark', () => {
    const { frete } = mapearFreteInicialShopee({
      detalhe: detalheSG(),
      escrow: null,
      watermarkUs: WATERMARK_US,
    });
    expect(frete.codRastreio).toBeNull();
    expect(frete.ultimaModificacao).toBe(WATERMARK_US);
  });

  it('o bloco gerado é aceito por freteDoPedidoSchema', () => {
    const { frete } = mapearFreteInicialShopee({
      detalhe: detalheSG(),
      escrow: null,
      watermarkUs: WATERMARK_US,
    });
    expect(freteDoPedidoSchema.safeParse(frete).success).toBe(true);
  });
});

describe('mesclarFreteInicialShopee', () => {
  const armazenado: FreteDoPedido = {
    ...freteDoPedidoSchema.parse({
      estado: ESTADO_FRETE.postado,
      modalidade: MODALIDADE_FRETE.fob,
    }),
    externalId: 'ANTIGO',
    externalOptionId: '1',
    valorCobrado: 5,
    custoCalculado: 4,
    volumes: [
      {
        quantidade: 1,
        especie: 'pacote',
        numero: 'V-ANTIGO',
        marca: null,
        pesoBruto: null,
        pesoLiquido: null,
        dimensoes: null,
        lacres: null,
      },
    ],
    prazoDespacho: 1,
    dataPrevisaoEntrega: 2,
    ultimaModificacao: 3,
    codRastreio: 'BR123',
    printLabelId: 'ETQ-1',
  };

  it('atualiza EXATAMENTE os oito campos declarados — nada mais', () => {
    // Drift anchor: the mapped block below differs in every field, so any key
    // the merge touches shows up here. If a ninth field is ever refreshed, this
    // fails until it is added to `CAMPOS_FRETE_ATUALIZAVEIS_SHOPEE` too.
    const { frete: mapeado } = mapearFreteInicialShopee({
      // `edt_to` is patched in because the SG order zero-fills it, and a mapped
      // `null` cannot show whether the merge would have taken the field.
      detalhe: linha({ edt_to: 1_789_900_000 }),
      escrow: escrowCom(9.99),
      watermarkUs: WATERMARK_US,
    });
    const saida = mesclarFreteInicialShopee(armazenado, mapeado);
    const mudaram = Object.keys(saida).filter(
      (k) =>
        JSON.stringify((saida as Record<string, unknown>)[k]) !==
        JSON.stringify((armazenado as Record<string, unknown>)[k]),
    );
    expect(mudaram.sort()).toEqual([...CAMPOS_FRETE_ATUALIZAVEIS_SHOPEE].sort());
  });

  it('⚠️ NUNCA toca estado, codRastreio nem printLabelId', () => {
    const { frete: mapeado } = mapearFreteInicialShopee({
      detalhe: detalheSG(),
      escrow: null,
      watermarkUs: WATERMARK_US,
    });
    const saida = mesclarFreteInicialShopee(armazenado, mapeado);
    // `estado` moves PHYSICAL stock and belongs to step 7; the mapped block
    // always carries `iniciado`, so a merge that took it would walk a `postado`
    // shipment backwards.
    expect(saida.estado).toBe(ESTADO_FRETE.postado);
    expect(saida.codRastreio).toBe('BR123');
    expect(saida.printLabelId).toBe('ETQ-1');
  });

  it('um valor AUSENTE no mapeado nunca apaga o armazenado (#957)', () => {
    const mapeadoSemNada = mapearFreteInicialShopee({
      detalhe: linha({
        estimated_shipping_fee: 0,
        actual_shipping_fee: 0,
        ship_by_date: 0,
        pay_time: null,
        edt_to: 0,
        package_list: null,
      }),
      escrow: null,
      watermarkUs: WATERMARK_US,
    }).frete;
    const saida = mesclarFreteInicialShopee(armazenado, mapeadoSemNada);
    expect(saida.valorCobrado).toBe(5);
    expect(saida.custoCalculado).toBe(4);
    expect(saida.prazoDespacho).toBe(1);
    expect(saida.dataPrevisaoEntrega).toBe(2);
    expect(saida.volumes).toEqual(armazenado.volumes);
    // …but the watermark DOES move, because the mapper always supplies one.
    expect(saida.ultimaModificacao).toBe(WATERMARK_US);
  });

  it('sem bloco armazenado, o mapeado passa inteiro', () => {
    const { frete: mapeado } = mapearFreteInicialShopee({
      detalhe: detalheSG(),
      escrow: null,
      watermarkUs: WATERMARK_US,
    });
    expect(mesclarFreteInicialShopee(null, mapeado)).toBe(mapeado);
  });
});
