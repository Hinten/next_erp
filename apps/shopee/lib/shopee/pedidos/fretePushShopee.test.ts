import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  shopeePackageDetailRowSchema,
  type ShopeeOrderDetailRow,
  type ShopeePackageDetailRow,
} from '@delfrance/integrations-shopee';

import {
  FIXTURE_ORDER_DETAIL_DOC_MASKED_VN,
  FIXTURE_ORDER_DETAIL_QTY2_SG,
  FIXTURE_ORDER_DETAIL_QTY2_SG_PROCESSED,
  lerPedidoDetalhe,
} from '../fixtures/wireCorpus';
import {
  alvoDoPushDeFrete,
  observadoDoPacoteDetalhe,
  observadosDoDetalheDoPedido,
} from './fretePushShopee';
import { PISO_SEGUNDOS_SHOPEE, segundosShopeeUtilizaveis } from './orderMapping';

/* -------------------------------------------------------------------------- */
/*                     fixture ids and the inline vectors                      */
/* -------------------------------------------------------------------------- */

/** The SG sandbox package, the one `__wire__` already carries. */
const PACOTE = 'OFG242672552205937';
/** The doc page's SECOND package number — a sibling that is not the first. */
const PACOTE_2 = 'OFG199593509207187';
const ORDER_SN = '260910KJBHUJDM';

/** A synthetic carrier code. No real tracking number appears in this repo. */
const RASTREIO = 'BR000000001BR';

/**
 * Values that must never leave a reader. They are markers, not data: the row
 * that carries them parses (the package schema leaves every one of them
 * undeclared and lets `.passthrough()` carry it), and the record the producer
 * builds must contain none of them.
 */
const MARCA_PII = 'NAO-DEVE-VAZAR';

/** V1 — the pre-ship state, with the `-` sentinel where a tracking number goes. */
const V1_READY = {
  order_sn: ORDER_SN,
  package_number: PACOTE,
  fulfillment_status: 'LOGISTICS_READY',
  tracking_number: '-',
  update_time: 1_789_042_568,
  ship_by_date: 1_789_405_354,
  logistics_channel_id: 90021,
};

/** V2 — the same package one step later: a real code and an advanced clock. */
const V2_REQUEST_CREATED = {
  ...V1_READY,
  fulfillment_status: 'LOGISTICS_REQUEST_CREATED',
  tracking_number: RASTREIO,
  update_time: 1_789_045_000,
};

/** V7 — Shopee's zero-fill on all three numerics, plus the empty string. */
const V7_ZERO_FILL = {
  ...V1_READY,
  tracking_number: '',
  update_time: 0,
  ship_by_date: 0,
  logistics_channel_id: 0,
};

/** V10 — a row carrying the undeclared PII keys. It must PARSE and leak nothing. */
const V10_PII = {
  ...V2_REQUEST_CREATED,
  recipient_address: { full_address: MARCA_PII, name: MARCA_PII },
  driver_info: { driver_name: MARCA_PII, license_plate: MARCA_PII },
  virtual_contact_number: MARCA_PII,
};

function linhaDePacote(patch: Record<string, unknown> = {}): ShopeePackageDetailRow {
  return shopeePackageDetailRowSchema.parse({ ...V1_READY, ...patch });
}

/* -------------------------------------------------------------------------- */
/*                   alvoDoPushDeFrete — code 4 (`push 2`)                     */
/* -------------------------------------------------------------------------- */

describe('alvoDoPushDeFrete — code 4 (push 2, order_trackingno_push)', () => {
  it('1. lê a grafia DOCUMENTADA desta página (`ordersn`)', () => {
    const alvo = alvoDoPushDeFrete(4, {
      ordersn: ORDER_SN,
      package_number: PACOTE,
      tracking_no: RASTREIO,
    });
    expect(alvo.ok).toBe(true);
    if (!alvo.ok) return;
    expect(alvo.code).toBe(4);
    expect(alvo.orderSn).toBe(ORDER_SN);
    expect(alvo.packageNumber).toBe(PACOTE);
    expect(alvo.diagnostico.grafiaDoPedido).toBe('ordersn');
    expect(alvo.diagnostico.trackingNoDoPush).toBe(RASTREIO);
  });

  it('2. tolera a OUTRA grafia (`order_sn`) e diz qual usou', () => {
    const alvo = alvoDoPushDeFrete(4, { order_sn: ORDER_SN, package_number: PACOTE });
    expect(alvo.ok).toBe(true);
    if (!alvo.ok) return;
    expect(alvo.orderSn).toBe(ORDER_SN);
    expect(alvo.diagnostico.grafiaDoPedido).toBe('order_sn');
  });

  it('3. ⚠️ NEAR-MISS: com as DUAS grafias divergentes, a DOCUMENTADA vence', () => {
    const alvo = alvoDoPushDeFrete(4, {
      ordersn: ORDER_SN,
      order_sn: '260910OUTROSN0',
      package_number: PACOTE,
    });
    expect(alvo.ok).toBe(true);
    if (!alvo.ok) return;
    expect(alvo.orderSn).toBe(ORDER_SN);
    expect(alvo.orderSn).not.toBe('260910OUTROSN0');
    expect(alvo.diagnostico.grafiaDoPedido).toBe('ordersn');
  });

  it('4. um `package_number` `-` é AUSÊNCIA, nunca uma chave', () => {
    const alvo = alvoDoPushDeFrete(4, { ordersn: ORDER_SN, package_number: '-' });
    expect(alvo.ok).toBe(false);
    if (alvo.ok) return;
    expect(alvo.motivo).toBe('sem package_number');
    // ANCHOR: o mesmo corpo com um número de verdade passa.
    const bom = alvoDoPushDeFrete(4, { ordersn: ORDER_SN, package_number: PACOTE });
    expect(bom.ok).toBe(true);
  });

  it('5. uma chave de pedido `-` é AUSÊNCIA — e a outra grafia não a salva', () => {
    const alvo = alvoDoPushDeFrete(4, {
      ordersn: '-',
      order_sn: ' - ',
      package_number: PACOTE,
    });
    expect(alvo.ok).toBe(false);
    if (alvo.ok) return;
    expect(alvo.motivo).toBe('sem ordersn/order_sn');
    // ANCHOR: trocando só a sentinela por um sn real, o mesmo corpo passa.
    expect(
      alvoDoPushDeFrete(4, { ordersn: '-', order_sn: ORDER_SN, package_number: PACOTE }).ok,
    ).toBe(true);
  });

  it('6. uma falha de schema nomeia o CAMINHO, nunca o valor', () => {
    const alvo = alvoDoPushDeFrete(4, { ordersn: ORDER_SN, package_number: 42 });
    expect(alvo.ok).toBe(false);
    if (alvo.ok) return;
    // ⚠️ Igualdade EXATA, não `toContain`. Um `motivo` que apenas CONTÉM o
    // caminho passa mesmo quando carrega mais coisa junto — e foi assim que um
    // mutante que anexava `issue.message` e outro que anexava `issue.input`
    // sobreviveram aos `not.toContain` abaixo. O que se está afirmando é que a
    // linha parqueada é SÓ o caminho.
    expect(alvo.motivo).toBe('data inválido no push 4: package_number');
    expect(alvo.motivo).not.toContain('42');
    expect(alvo.motivo).not.toContain(ORDER_SN);

    // …e com um valor RECONHECÍVEL no campo que falha, ele não aparece.
    const comMarca = alvoDoPushDeFrete(4, { ordersn: ORDER_SN, package_number: [MARCA_PII] });
    expect(comMarca.ok).toBe(false);
    if (comMarca.ok) return;
    expect(comMarca.motivo).toBe('data inválido no push 4: package_number');
    expect(comMarca.motivo).not.toContain(MARCA_PII);
  });

  it('7. ⚠️ code 4 NÃO tem relógio — nem quando o corpo traz um `update_time`', () => {
    const alvo = alvoDoPushDeFrete(4, {
      ordersn: ORDER_SN,
      package_number: PACOTE,
      update_time: 1_789_042_568,
    });
    expect(alvo.ok).toBe(true);
    if (!alvo.ok) return;
    expect(alvo.diagnostico.relogioDoPushS).toBeNull();
    // ANCHOR: o MESMO carimbo num code 30 é lido normalmente.
    const trinta = alvoDoPushDeFrete(30, {
      ordersn: ORDER_SN,
      package_number: PACOTE,
      update_time: 1_789_042_568,
    });
    expect(trinta.ok && trinta.diagnostico.relogioDoPushS).toBe(1_789_042_568);
  });

  it('8. o `tracking_no` do push é DIAGNÓSTICO — a sentinela vira null', () => {
    const alvo = alvoDoPushDeFrete(4, {
      ordersn: ORDER_SN,
      package_number: PACOTE,
      tracking_no: '-',
    });
    expect(alvo.ok).toBe(true);
    if (!alvo.ok) return;
    expect(alvo.diagnostico.trackingNoDoPush).toBeNull();
    expect(alvo.diagnostico.statusDoPush).toBeNull();
    expect(alvo.diagnostico.camposMudados).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                  alvoDoPushDeFrete — code 30 (`push 33`)                    */
/* -------------------------------------------------------------------------- */

describe('alvoDoPushDeFrete — code 30 (push 33, package_fulfillment_status_push)', () => {
  it('9. lê a grafia DOCUMENTADA (`ordersn`) e o token do push', () => {
    const alvo = alvoDoPushDeFrete(30, {
      ordersn: ORDER_SN,
      package_number: PACOTE,
      fulfillment_status: 'LOGISTICS_REQUEST_CREATED',
      update_time: 1_789_045_000,
    });
    expect(alvo.ok).toBe(true);
    if (!alvo.ok) return;
    expect(alvo.code).toBe(30);
    expect(alvo.orderSn).toBe(ORDER_SN);
    expect(alvo.packageNumber).toBe(PACOTE);
    expect(alvo.diagnostico.grafiaDoPedido).toBe('ordersn');
    expect(alvo.diagnostico.statusDoPush).toBe('LOGISTICS_REQUEST_CREATED');
    expect(alvo.diagnostico.relogioDoPushS).toBe(1_789_045_000);
  });

  it('10. tolera `order_sn`', () => {
    const alvo = alvoDoPushDeFrete(30, { order_sn: ORDER_SN, package_number: PACOTE });
    expect(alvo.ok && alvo.orderSn).toBe(ORDER_SN);
    expect(alvo.ok && alvo.diagnostico.grafiaDoPedido).toBe('order_sn');
  });

  it('11. ⚠️ NEAR-MISS: as duas grafias divergentes ⇒ a DOCUMENTADA vence', () => {
    const alvo = alvoDoPushDeFrete(30, {
      ordersn: ORDER_SN,
      order_sn: '260910OUTROSN0',
      package_number: PACOTE,
    });
    expect(alvo.ok && alvo.orderSn).toBe(ORDER_SN);
    expect(alvo.ok && alvo.diagnostico.grafiaDoPedido).toBe('ordersn');
  });

  it('12. `-` em qualquer identidade ⇒ ok:false', () => {
    expect(alvoDoPushDeFrete(30, { ordersn: ORDER_SN, package_number: '-' })).toEqual({
      ok: false,
      motivo: 'sem package_number',
    });
    expect(alvoDoPushDeFrete(30, { ordersn: '-', package_number: PACOTE })).toEqual({
      ok: false,
      motivo: 'sem ordersn/order_sn',
    });
    // ANCHOR: sem sentinela nenhuma, o mesmo corpo resolve.
    expect(alvoDoPushDeFrete(30, { ordersn: ORDER_SN, package_number: PACOTE }).ok).toBe(true);
  });

  it('13. uma falha de schema nomeia o CAMINHO, nunca o valor', () => {
    const alvo = alvoDoPushDeFrete(30, { ordersn: ORDER_SN, package_number: 42 });
    expect(alvo.ok).toBe(false);
    if (alvo.ok) return;
    expect(alvo.motivo).toBe('data inválido no push 30: package_number');
    expect(alvo.motivo).not.toContain('42');
  });

  it('14. um `update_time` zero-fill é AUSÊNCIA, não 1970', () => {
    const alvo = alvoDoPushDeFrete(30, {
      ordersn: ORDER_SN,
      package_number: PACOTE,
      update_time: 0,
    });
    expect(alvo.ok && alvo.diagnostico.relogioDoPushS).toBeNull();
    // ANCHOR/NEAR-MISS: o piso é `>=`, então o próprio piso passa.
    const noPiso = alvoDoPushDeFrete(30, {
      ordersn: ORDER_SN,
      package_number: PACOTE,
      update_time: PISO_SEGUNDOS_SHOPEE,
    });
    expect(noPiso.ok && noPiso.diagnostico.relogioDoPushS).toBe(PISO_SEGUNDOS_SHOPEE);
  });

  it('15. ⚠️ o token do push é DIAGNÓSTICO: dois pushes que discordam apontam o MESMO alvo', () => {
    // The fold-equal pair. What the two bodies disagree about (their own status)
    // is exactly what never reaches a write; the identity is what does.
    const a = alvoDoPushDeFrete(30, {
      ordersn: ORDER_SN,
      package_number: PACOTE,
      fulfillment_status: 'LOGISTICS_READY',
      update_time: 1_789_042_568,
    });
    const b = alvoDoPushDeFrete(30, {
      ordersn: ORDER_SN,
      package_number: PACOTE,
      fulfillment_status: 'LOGISTICS_PICKUP_DONE',
      update_time: 1_789_049_999,
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect({ code: a.code, orderSn: a.orderSn, packageNumber: a.packageNumber }).toEqual({
      code: b.code,
      orderSn: b.orderSn,
      packageNumber: b.packageNumber,
    });
    // ⚠️ NEAR-MISS: e os diagnósticos NÃO são iguais — a divergência fica visível.
    expect(a.diagnostico.statusDoPush).not.toBe(b.diagnostico.statusDoPush);
  });
});

/* -------------------------------------------------------------------------- */
/*                  alvoDoPushDeFrete — code 47 (`push 44`)                    */
/* -------------------------------------------------------------------------- */

describe('alvoDoPushDeFrete — code 47 (push 44, package_info_push)', () => {
  it('16. lê a grafia DOCUMENTADA desta página — `order_sn`, com underscore', () => {
    const alvo = alvoDoPushDeFrete(47, {
      order_sn: ORDER_SN,
      package_number: PACOTE,
      changed_fields: ['ship_by_date'],
      old: { ship_by_date: 1_789_405_354, logistics_channel_id: 90021 },
      new: { ship_by_date: 1_789_491_754, logistics_channel_id: 90021 },
      update_time: 1_789_045_000,
    });
    expect(alvo.ok).toBe(true);
    if (!alvo.ok) return;
    expect(alvo.code).toBe(47);
    expect(alvo.diagnostico.grafiaDoPedido).toBe('order_sn');
    expect(alvo.diagnostico.camposMudados).toEqual(['ship_by_date']);
    expect(alvo.diagnostico.shipByDateAntigaS).toBe(1_789_405_354);
    expect(alvo.diagnostico.shipByDateNovaS).toBe(1_789_491_754);
    expect(alvo.diagnostico.canalAntigo).toBe(90021);
    expect(alvo.diagnostico.canalNovo).toBe(90021);
    expect(alvo.diagnostico.relogioDoPushS).toBe(1_789_045_000);
  });

  it('17. tolera `ordersn` — a grafia das outras duas páginas', () => {
    const alvo = alvoDoPushDeFrete(47, { ordersn: ORDER_SN, package_number: PACOTE });
    expect(alvo.ok && alvo.orderSn).toBe(ORDER_SN);
    expect(alvo.ok && alvo.diagnostico.grafiaDoPedido).toBe('ordersn');
  });

  it('18. ⚠️ NEAR-MISS: aqui a documentada é `order_sn`, e é ELA que vence', () => {
    const alvo = alvoDoPushDeFrete(47, {
      order_sn: ORDER_SN,
      ordersn: '260910OUTROSN0',
      package_number: PACOTE,
    });
    expect(alvo.ok && alvo.orderSn).toBe(ORDER_SN);
    expect(alvo.ok && alvo.diagnostico.grafiaDoPedido).toBe('order_sn');
  });

  it('19. `old`/`new` ESPARSOS (sem `return_code`) fazem parse, e `changed_fields` viaja', () => {
    const alvo = alvoDoPushDeFrete(47, {
      order_sn: ORDER_SN,
      package_number: PACOTE,
      changed_fields: ['logistics_channel_id'],
      old: { logistics_channel_id: 90021 },
      new: { logistics_channel_id: 90025 },
      update_time: 1_789_045_000,
    });
    expect(alvo.ok).toBe(true);
    if (!alvo.ok) return;
    expect(alvo.diagnostico.camposMudados).toEqual(['logistics_channel_id']);
    expect(alvo.diagnostico.canalAntigo).toBe(90021);
    expect(alvo.diagnostico.canalNovo).toBe(90025);
    // ⚠️ Os campos que o push NÃO mandou são ausência, não zero.
    expect(alvo.diagnostico.shipByDateAntigaS).toBeNull();
    expect(alvo.diagnostico.shipByDateNovaS).toBeNull();
  });

  it('20. `old`/`new` ausentes por completo não derrubam o push', () => {
    const alvo = alvoDoPushDeFrete(47, { order_sn: ORDER_SN, package_number: PACOTE });
    expect(alvo.ok).toBe(true);
    if (!alvo.ok) return;
    expect(alvo.diagnostico.camposMudados).toBeNull();
    expect(alvo.diagnostico.canalAntigo).toBeNull();
    expect(alvo.diagnostico.canalNovo).toBeNull();
    expect(alvo.diagnostico.relogioDoPushS).toBeNull();
  });

  it('21. um `changed_fields` ilegível é tolerado — só a identidade é estrita', () => {
    const alvo = alvoDoPushDeFrete(47, {
      order_sn: ORDER_SN,
      package_number: PACOTE,
      changed_fields: 'ship_by_date',
      old: 7,
      new: null,
    });
    expect(alvo.ok).toBe(true);
    if (!alvo.ok) return;
    expect(alvo.diagnostico.camposMudados).toBeNull();
    expect(alvo.diagnostico.canalAntigo).toBeNull();
    // ANCHOR: e a identidade estrita continua derrubando o push.
    expect(alvoDoPushDeFrete(47, { order_sn: ORDER_SN, package_number: 42 }).ok).toBe(false);
  });

  it('22. `-` em qualquer identidade ⇒ ok:false, e a falha nomeia o caminho', () => {
    expect(alvoDoPushDeFrete(47, { order_sn: ORDER_SN, package_number: '-' })).toEqual({
      ok: false,
      motivo: 'sem package_number',
    });
    expect(alvoDoPushDeFrete(47, { order_sn: '-', package_number: PACOTE })).toEqual({
      ok: false,
      motivo: 'sem ordersn/order_sn',
    });
    const ruim = alvoDoPushDeFrete(47, { order_sn: ORDER_SN, package_number: 42 });
    expect(ruim.ok).toBe(false);
    if (ruim.ok) return;
    expect(ruim.motivo).toBe('data inválido no push 47: package_number');
    expect(ruim.motivo).not.toContain('42');
  });
});

/* -------------------------------------------------------------------------- */
/*                        the codes this arm does NOT own                      */
/* -------------------------------------------------------------------------- */

describe('alvoDoPushDeFrete — fora do conjunto {4, 30, 47}', () => {
  it('23. um code fora do conjunto ⇒ ok:false, sem ler o corpo', () => {
    for (const code of [3, 15, 24, 0, -1, 4.5]) {
      const alvo = alvoDoPushDeFrete(code, { ordersn: ORDER_SN, package_number: PACOTE });
      expect(alvo.ok).toBe(false);
      if (alvo.ok) continue;
      expect(alvo.motivo).toBe('push_code inesperado no braço de frete');
    }
    // ANCHOR: os três codes do passo 7 resolvem o MESMO corpo.
    for (const code of [4, 30, 47]) {
      expect(alvoDoPushDeFrete(code, { ordersn: ORDER_SN, package_number: PACOTE }).ok).toBe(true);
    }
  });

  it('24. um `data` nulo é um corpo vazio, não um crash', () => {
    const alvo = alvoDoPushDeFrete(4, null);
    expect(alvo.ok).toBe(false);
    if (alvo.ok) return;
    expect(alvo.motivo).toBe('data inválido no push 4: package_number');
  });

  it('24b. um `data` que nem objeto é ainda produz um caminho legível', () => {
    // Defesa em profundidade: a assinatura promete um objeto, mas a falha na
    // RAIZ não pode virar um motivo com um caminho vazio — `package_number: `
    // seria uma linha parqueada que não diz nada.
    const alvo = alvoDoPushDeFrete(30, 'nem é objeto' as unknown as Record<string, unknown>);
    expect(alvo.ok).toBe(false);
    if (alvo.ok) return;
    expect(alvo.motivo).toBe('data inválido no push 30: (raiz)');
    expect(alvo.motivo).not.toContain('nem é objeto');
  });
});

/* -------------------------------------------------------------------------- */
/*             produtor A — observadoDoPacoteDetalhe (o pull)                  */
/* -------------------------------------------------------------------------- */

describe('observadoDoPacoteDetalhe — uma linha de get_package_detail', () => {
  it('25. um `tracking_number` `-` é AUSÊNCIA', () => {
    const obs = observadoDoPacoteDetalhe(linhaDePacote());
    expect(obs?.trackingNumber).toBeNull();
    expect(obs?.fulfillmentStatus).toBe('LOGISTICS_READY');
    expect(obs?.fonte).toBe('get_package_detail');
  });

  it('26. um `tracking_number` vazio (ou só espaços) é AUSÊNCIA', () => {
    expect(
      observadoDoPacoteDetalhe(linhaDePacote({ tracking_number: '' }))?.trackingNumber,
    ).toBeNull();
    expect(
      observadoDoPacoteDetalhe(linhaDePacote({ tracking_number: '   ' }))?.trackingNumber,
    ).toBeNull();
  });

  it('27. ⚠️ NEAR-MISS: um código de verdade sobrevive, com ou sem hífen dentro', () => {
    expect(
      observadoDoPacoteDetalhe(linhaDePacote({ tracking_number: RASTREIO }))?.trackingNumber,
    ).toBe(RASTREIO);
    expect(
      observadoDoPacoteDetalhe(linhaDePacote({ tracking_number: 'BR-123' }))?.trackingNumber,
    ).toBe('BR-123');
    expect(observadoDoPacoteDetalhe(linhaDePacote({ tracking_number: '--' }))?.trackingNumber).toBe(
      '--',
    );
    // …e o espaço em volta some, o valor não.
    expect(
      observadoDoPacoteDetalhe(linhaDePacote({ tracking_number: `  ${RASTREIO}  ` }))
        ?.trackingNumber,
    ).toBe(RASTREIO);
  });

  it('28. `update_time: 0` é AUSÊNCIA (zero-fill), nunca 1970', () => {
    expect(
      observadoDoPacoteDetalhe(shopeePackageDetailRowSchema.parse(V7_ZERO_FILL))?.updateTimeS,
    ).toBeNull();
    // ANCHOR: o carimbo real da mesma linha é lido.
    expect(observadoDoPacoteDetalhe(linhaDePacote())?.updateTimeS).toBe(1_789_042_568);
  });

  it('29. ⚠️ NEAR-MISS: o piso de 2020 é `>=` — um segundo abaixo some, o piso fica', () => {
    expect(
      observadoDoPacoteDetalhe(linhaDePacote({ ship_by_date: PISO_SEGUNDOS_SHOPEE - 1 }))
        ?.shipByDateS,
    ).toBeNull();
    expect(
      observadoDoPacoteDetalhe(linhaDePacote({ ship_by_date: PISO_SEGUNDOS_SHOPEE }))?.shipByDateS,
    ).toBe(PISO_SEGUNDOS_SHOPEE);
    expect(
      observadoDoPacoteDetalhe(linhaDePacote({ ship_by_date: PISO_SEGUNDOS_SHOPEE + 1 }))
        ?.shipByDateS,
    ).toBe(PISO_SEGUNDOS_SHOPEE + 1);
    // …e o prazo real da linha, em SEGUNDOS, sem conversão nenhuma.
    expect(observadoDoPacoteDetalhe(linhaDePacote())?.shipByDateS).toBe(1_789_405_354);
  });

  it('30. `logistics_channel_id: 0` é AUSÊNCIA; um canal de verdade sobrevive', () => {
    expect(
      observadoDoPacoteDetalhe(shopeePackageDetailRowSchema.parse(V7_ZERO_FILL))
        ?.logisticsChannelId,
    ).toBeNull();
    expect(observadoDoPacoteDetalhe(linhaDePacote())?.logisticsChannelId).toBe(90021);
  });

  it('31. uma linha sem identidade utilizável NÃO vira registro', () => {
    expect(observadoDoPacoteDetalhe(linhaDePacote({ package_number: '-' }))).toBeNull();
    // `''` nem chega a fazer parse (a linha é `.min(1)`), então a defesa em
    // profundidade é exercitada por um cast — é o que um `.catch` de terceiros
    // ou um mock poderia entregar.
    const vazia = { ...linhaDePacote(), package_number: '' } as ShopeePackageDetailRow;
    expect(observadoDoPacoteDetalhe(vazia)).toBeNull();
    expect(
      shopeePackageDetailRowSchema.safeParse({ ...V1_READY, package_number: '' }).success,
    ).toBe(false);
    // ANCHOR: a mesma linha com identidade passa.
    expect(observadoDoPacoteDetalhe(linhaDePacote())?.packageNumber).toBe(PACOTE);
  });

  it('32. o registro tem EXATAMENTE os sete campos declarados — nada de PII viaja', () => {
    const linha = shopeePackageDetailRowSchema.parse(V10_PII);
    const obs = observadoDoPacoteDetalhe(linha);
    expect(obs).not.toBeNull();
    if (obs === null) return;
    expect(Object.keys(obs).sort()).toEqual([
      'fonte',
      'fulfillmentStatus',
      'logisticsChannelId',
      'packageNumber',
      'shipByDateS',
      'trackingNumber',
      'updateTimeS',
    ]);
    expect(JSON.stringify(obs)).not.toContain(MARCA_PII);
    // ANCHOR: a linha REALMENTE carregava os três blocos (o `.passthrough()` os
    // mantém), então a ausência acima é do produtor e não da fixture.
    expect(JSON.stringify(linha)).toContain(MARCA_PII);
  });

  it('33. a linha avançada (V2) lê código, token e relógio novos', () => {
    const obs = observadoDoPacoteDetalhe(shopeePackageDetailRowSchema.parse(V2_REQUEST_CREATED));
    expect(obs).toEqual({
      packageNumber: PACOTE,
      fulfillmentStatus: 'LOGISTICS_REQUEST_CREATED',
      trackingNumber: RASTREIO,
      shipByDateS: 1_789_405_354,
      logisticsChannelId: 90021,
      updateTimeS: 1_789_045_000,
      fonte: 'get_package_detail',
    });
  });
});

/* -------------------------------------------------------------------------- */
/*        produtor B — observadosDoDetalheDoPedido (o backstop do code 3)      */
/* -------------------------------------------------------------------------- */

function linhaDoPedido(fixture: string): ShopeeOrderDetailRow {
  return lerPedidoDetalhe(fixture).response.order_list[0]!;
}

describe('observadosDoDetalheDoPedido — os três corpos __wire__ de get_order_detail', () => {
  const casos = [
    { fixture: FIXTURE_ORDER_DETAIL_QTY2_SG, token: 'LOGISTICS_READY' },
    { fixture: FIXTURE_ORDER_DETAIL_QTY2_SG_PROCESSED, token: 'LOGISTICS_REQUEST_CREATED' },
    { fixture: FIXTURE_ORDER_DETAIL_DOC_MASKED_VN, token: 'LOGISTICS_DELIVERY_DONE' },
  ] as const;

  it.each(casos)('34. $fixture dobra $token com fonte get_order_detail', ({ fixture, token }) => {
    const linha = linhaDoPedido(fixture);
    const relogioDoPedidoS = segundosShopeeUtilizaveis(linha.update_time);
    const { observados, ignorados } = observadosDoDetalheDoPedido(linha, { relogioDoPedidoS });

    expect(ignorados).toBe(0);
    expect(observados).toHaveLength(1);
    const obs = observados[0]!;
    expect(obs.fonte).toBe('get_order_detail');
    expect(obs.fulfillmentStatus).toBe(token);
    // ⚠️ O detalhe do pedido NÃO traz código de rastreio — nunca.
    expect(obs.trackingNumber).toBeNull();
    expect(obs.packageNumber).toBe(linha.package_list?.[0]?.package_number);
    expect(obs.logisticsChannelId).toBe(linha.package_list?.[0]?.logistics_channel_id);
  });

  it.each(casos)('35. $fixture carimba o relógio da ORDEM em SEGUNDOS', ({ fixture }) => {
    const linha = linhaDoPedido(fixture);
    const relogioDoPedidoS = segundosShopeeUtilizaveis(linha.update_time);
    const { observados } = observadosDoDetalheDoPedido(linha, { relogioDoPedidoS });

    expect(observados[0]!.updateTimeS).toBe(linha.update_time);
    // ⚠️ NEAR-MISS de UNIDADE: segundos, não µs. Um watermark convertido teria
    // quinze dígitos; qualquer coisa acima de 1e10 aqui é um erro de unidade.
    expect(observados[0]!.updateTimeS!).toBeLessThan(1e10);
    expect(observados[0]!.updateTimeS!).toBeGreaterThan(PISO_SEGUNDOS_SHOPEE);
    expect(relogioDoPedidoS! * 1_000_000).toBeGreaterThan(1e15);
  });

  it.each(casos)(
    '36. R2 — um pacote só herda o `ship_by_date` da ORDEM ($fixture)',
    ({ fixture }) => {
      const linha = linhaDoPedido(fixture);
      const { observados } = observadosDoDetalheDoPedido(linha, {
        relogioDoPedidoS: segundosShopeeUtilizaveis(linha.update_time),
      });
      expect(linha.package_list).toHaveLength(1);
      expect(observados[0]!.shipByDateS).toBe(linha.ship_by_date);
    },
  );

  it('37. ⚠️ R2 NEAR-MISS: com DOIS pacotes o prazo da ordem não é de ninguém', () => {
    const base = linhaDoPedido(FIXTURE_ORDER_DETAIL_QTY2_SG);
    const primeiro = base.package_list![0]!;
    const linha = {
      ...base,
      package_list: [primeiro, { ...primeiro, package_number: PACOTE_2 }],
    } as ShopeeOrderDetailRow;

    const { observados, ignorados } = observadosDoDetalheDoPedido(linha, {
      relogioDoPedidoS: segundosShopeeUtilizaveis(linha.update_time),
    });
    expect(ignorados).toBe(0);
    expect(observados.map((o) => o.packageNumber)).toEqual([PACOTE, PACOTE_2]);
    expect(observados.map((o) => o.shipByDateS)).toEqual([null, null]);
    // ANCHOR: o resto do registro continua sendo lido nos dois.
    expect(observados.map((o) => o.fulfillmentStatus)).toEqual([
      'LOGISTICS_READY',
      'LOGISTICS_READY',
    ]);
  });

  it('38. uma linha sem identidade é CONTADA e some — e derruba a herança do prazo', () => {
    const base = linhaDoPedido(FIXTURE_ORDER_DETAIL_QTY2_SG);
    const primeiro = base.package_list![0]!;
    const linha = {
      ...base,
      package_list: [primeiro, { ...primeiro, package_number: '-' }],
    } as ShopeeOrderDetailRow;

    const { observados, ignorados } = observadosDoDetalheDoPedido(linha, {
      relogioDoPedidoS: segundosShopeeUtilizaveis(linha.update_time),
    });
    expect(ignorados).toBe(1);
    expect(observados).toHaveLength(1);
    // ⚠️ DOIS pacotes, um ilegível: a ordem não é "um pacote só", então o prazo
    // de ordem não pertence ao que sobrou.
    expect(observados[0]!.shipByDateS).toBeNull();
    expect(observados[0]!.packageNumber).toBe(PACOTE);
  });

  it('39. `package_list` ausente ou vazia ⇒ nada observado, nada ignorado', () => {
    const base = linhaDoPedido(FIXTURE_ORDER_DETAIL_QTY2_SG);
    for (const lista of [null, []]) {
      const linha = { ...base, package_list: lista } as ShopeeOrderDetailRow;
      expect(observadosDoDetalheDoPedido(linha, { relogioDoPedidoS: 1_789_042_568 })).toEqual({
        observados: [],
        ignorados: 0,
      });
    }
    // ANCHOR: a MESMA linha com a lista original observa um pacote.
    expect(
      observadosDoDetalheDoPedido(base, { relogioDoPedidoS: 1_789_042_568 }).observados,
    ).toHaveLength(1);
  });

  it('40. um relógio de ordem ausente viaja como ausente — nunca como zero', () => {
    const base = linhaDoPedido(FIXTURE_ORDER_DETAIL_QTY2_SG);
    const { observados } = observadosDoDetalheDoPedido(base, { relogioDoPedidoS: null });
    expect(observados[0]!.updateTimeS).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                     nada neste módulo escreve uma linha de log              */
/* -------------------------------------------------------------------------- */

describe('o módulo é PURO — nenhuma linha de log, nenhum dado de comprador', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('41. nenhum leitor nem produtor chama o console, nem com uma linha cheia de PII', () => {
    const espioes = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      info: vi.spyOn(console, 'info').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
      debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
    };

    alvoDoPushDeFrete(4, { ordersn: ORDER_SN, package_number: PACOTE, tracking_no: RASTREIO });
    alvoDoPushDeFrete(30, { ordersn: '-', package_number: 42 });
    alvoDoPushDeFrete(47, { order_sn: ORDER_SN, package_number: PACOTE, old: 7 });
    alvoDoPushDeFrete(99, null);
    observadoDoPacoteDetalhe(shopeePackageDetailRowSchema.parse(V10_PII));
    observadosDoDetalheDoPedido(linhaDoPedido(FIXTURE_ORDER_DETAIL_QTY2_SG), {
      relogioDoPedidoS: 1_789_042_568,
    });

    for (const espiao of Object.values(espioes)) expect(espiao).not.toHaveBeenCalled();

    // ANCHOR: os espiões FUNCIONAM — sem isto o teste passaria com o console
    // desligado por outro arquivo da suíte. (`warn` porque é um dos dois
    // métodos que o `no-console` deste repo permite.)
    console.warn(MARCA_PII);
    expect(espioes.warn).toHaveBeenCalledTimes(1);
    expect(espioes.warn).toHaveBeenCalledWith(MARCA_PII);
  });
});
