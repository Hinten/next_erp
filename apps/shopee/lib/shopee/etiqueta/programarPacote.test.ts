import { describe, expect, it, vi } from 'vitest';

import {
  assertShipOrderParams,
  SHOPEE_SURFACE,
  ShopeeConfigError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeSchemaError,
  shopeeErrorFromEnvelope,
  shopeeShippingParameterPayloadSchema,
  type ShipOrderParams,
  type ShopeeApiError,
  type ShopeeClient,
} from '@delfrance/integrations-shopee';

import { proximaViradaDaCotaMs } from '../anuncios/pausarAnuncio';
import { TENTAR_EM_SHOPEE_MS } from './constantesEtiqueta';
import { ENVIO_AUTOMATICO, type EscolhaDeEnvio } from './modoDeEnvio';
import { MOTIVO_ETIQUETA_SHOPEE } from './motivosEtiqueta';
import { programarPacoteShopee, type AlvoDaProgramacao } from './programarPacote';

/* --------------------------------- fixtures --------------------------------- */

const ORDER_SN = '260910KJBHUJDM';
const PACOTE = 'OFG000000000001';
const OUTRO_PACOTE = 'OFG000000000002';
const AGORA = Date.UTC(2026, 8, 30, 12, 0, 0);

const ALVO: AlvoDaProgramacao = { orderSn: ORDER_SN, packageNumber: PACOTE, comPacote: false };
const ALVO_DIVIDIDO: AlvoDaProgramacao = { ...ALVO, comPacote: true };

function endereco(id: number, slots: unknown[] | null) {
  return {
    address_id: id,
    region: 'BR',
    state: 'SP',
    city: 'Cidade do Vendedor',
    district: 'Centro',
    town: '',
    address: 'Rua do Vendedor, 100',
    zipcode: '00000-000',
    address_flag: ['pickup_address'],
    time_slot_list: slots,
  };
}

function horario(id: string) {
  return { date: 1_790_000_000, time_text: '09:00-12:00', pickup_time_id: id, flags: null };
}

/** One pickup address with ONE slot: decided with no question. */
const UM_ENDERECO = {
  info_needed: { pickup: ['address_id', 'pickup_time_id'] },
  pickup: { address_list: [endereco(2001, [horario('slot-1')])] },
};

/** Two pickup addresses: a question. */
const DOIS_ENDERECOS = {
  info_needed: { pickup: ['address_id', 'pickup_time_id'] },
  pickup: {
    address_list: [endereco(2001, [horario('slot-1')]), endereco(2002, [horario('slot-2')])],
  },
};

function envelope(error: string, message: string | null): ShopeeApiError {
  return shopeeErrorFromEnvelope(
    { error, message, request_id: null, warning: null },
    { path: '/api/v2/logistics/ship_order', httpStatus: 200, surface: SHOPEE_SURFACE.business },
  );
}

function fakeClient(opts: {
  parametro?: unknown;
  parametroErro?: unknown;
  /** One entry per `shipOrder` call: `undefined` ⇒ success, else thrown. */
  ship?: unknown[];
}) {
  const getShippingParameter = vi.fn(async () => {
    if (opts.parametroErro !== undefined) throw opts.parametroErro;
    return shopeeShippingParameterPayloadSchema.parse(opts.parametro ?? UM_ENDERECO);
  });
  const respostas = [...(opts.ship ?? [])];
  const shipOrder = vi.fn(async (_p: ShipOrderParams) => {
    const erro = respostas.shift();
    if (erro !== undefined) throw erro;
    return { error: '', message: null, request_id: null, warning: null };
  });
  // R5-8: `satisfies` BEFORE the cast, so a renamed op or param is a type error.
  const client = { getShippingParameter, shipOrder } satisfies Pick<
    ShopeeClient,
    'getShippingParameter' | 'shipOrder'
  > as unknown as ShopeeClient;
  return { client, getShippingParameter, shipOrder };
}

function corpoDoShip(shipOrder: ReturnType<typeof fakeClient>['shipOrder'], i = 0) {
  const call = shipOrder.mock.calls[i];
  if (call === undefined) throw new Error(`shipOrder não foi chamado ${String(i + 1)}×`);
  return call[0];
}

/* ---------------------------------- tests ----------------------------------- */

describe('programarPacoteShopee — o caminho feliz', () => {
  it('lê o parâmetro NOMEANDO o pacote e envia o corpo decidido', async () => {
    const f = fakeClient({});
    await expect(programarPacoteShopee(f.client, ALVO, null, AGORA)).resolves.toStrictEqual({
      tipo: 'programado',
      semPacote: true,
    });
    expect(f.getShippingParameter).toHaveBeenCalledWith({
      orderSn: ORDER_SN,
      packageNumber: PACOTE,
    });
    expect(f.shipOrder).toHaveBeenCalledTimes(1);
  });

  it('S29: pedido NÃO dividido ⇒ package_number AUSENTE no ship (nunca "")', async () => {
    const f = fakeClient({});
    await programarPacoteShopee(f.client, ALVO, null, AGORA);
    const corpo = corpoDoShip(f.shipOrder);
    expect(corpo).toStrictEqual({
      orderSn: ORDER_SN,
      modo: 'pickup',
      pickup: { addressId: 2001, pickupTimeId: 'slot-1' },
    });
    expect('packageNumber' in corpo).toBe(false);
  });

  it('S29 (near-miss): pedido dividido ⇒ o ship leva o package_number', async () => {
    const f = fakeClient({});
    // Named package ⇒ only THIS package was arranged, not the order (R2-2).
    await expect(
      programarPacoteShopee(f.client, ALVO_DIVIDIDO, null, AGORA),
    ).resolves.toStrictEqual({ tipo: 'programado', semPacote: false });
    expect(corpoDoShip(f.shipOrder)).toStrictEqual({
      orderSn: ORDER_SN,
      packageNumber: PACOTE,
      modo: 'pickup',
      pickup: { addressId: 2001, pickupTimeId: 'slot-1' },
    });
  });

  it('dropoff sem nada a preencher ⇒ `dropoff: {}` enviado', async () => {
    const f = fakeClient({ parametro: { info_needed: { dropoff: [] } } });
    await programarPacoteShopee(f.client, ALVO, null, AGORA);
    expect(corpoDoShip(f.shipOrder)).toStrictEqual({
      orderSn: ORDER_SN,
      modo: 'dropoff',
      dropoff: {},
    });
  });
});

describe('programarPacoteShopee — a escolha do operador', () => {
  it('mais de um endereço e nenhuma escolha ⇒ pergunta, ZERO ship', async () => {
    const f = fakeClient({ parametro: DOIS_ENDERECOS });
    const r = await programarPacoteShopee(f.client, ALVO, null, AGORA);
    expect(r).toMatchObject({ tipo: 'pergunta', permiteDropoff: false, escolhaInvalida: false });
    expect(r.tipo === 'pergunta' ? r.enderecos.map((e) => e.id) : []).toStrictEqual([
      '2001',
      '2002',
    ]);
    expect(f.shipOrder).not.toHaveBeenCalled();
  });

  it('a escolha deste pacote ⇒ o id STRING volta como NÚMERO no ship (round-trip 1)', async () => {
    const f = fakeClient({ parametro: DOIS_ENDERECOS });
    const escolha: EscolhaDeEnvio = {
      pacote: PACOTE,
      modo: 'pickup',
      enderecoId: '2002',
      horarioId: 'slot-2',
    };
    await expect(programarPacoteShopee(f.client, ALVO, escolha, AGORA)).resolves.toStrictEqual({
      tipo: 'programado',
      semPacote: true,
    });
    expect(corpoDoShip(f.shipOrder)).toStrictEqual({
      orderSn: ORDER_SN,
      modo: 'pickup',
      pickup: { addressId: 2002, pickupTimeId: 'slot-2' },
    });
  });

  it('a escolha de OUTRO pacote não programa este — a pergunta deste é feita', async () => {
    const f = fakeClient({ parametro: DOIS_ENDERECOS });
    const escolha: EscolhaDeEnvio = {
      pacote: OUTRO_PACOTE,
      modo: 'pickup',
      enderecoId: '2002',
      horarioId: 'slot-2',
    };
    const r = await programarPacoteShopee(f.client, ALVO, escolha, AGORA);
    expect(r).toMatchObject({ tipo: 'pergunta', escolhaInvalida: false });
    expect(f.shipOrder).not.toHaveBeenCalled();
  });

  it('S42/S43: um enderecoId que não casa EXATAMENTE ("02002") ⇒ pergunta de novo, ZERO ship', async () => {
    const f = fakeClient({ parametro: DOIS_ENDERECOS });
    const escolha: EscolhaDeEnvio = {
      pacote: PACOTE,
      modo: 'pickup',
      enderecoId: '02002',
      horarioId: 'slot-2',
    };
    const r = await programarPacoteShopee(f.client, ALVO, escolha, AGORA);
    expect(r).toMatchObject({ tipo: 'pergunta', escolhaInvalida: true });
    expect(f.shipOrder).not.toHaveBeenCalled();
  });

  it('só non_integrated ⇒ recusa sem-etiqueta-shopee, ZERO ship', async () => {
    const f = fakeClient({ parametro: { info_needed: { non_integrated: [] } } });
    await expect(programarPacoteShopee(f.client, ALVO, null, AGORA)).resolves.toStrictEqual({
      tipo: 'recusa',
      motivo: MOTIVO_ETIQUETA_SHOPEE.semEtiquetaShopee,
    });
    expect(f.shipOrder).not.toHaveBeenCalled();
  });
});

describe('programarPacoteShopee — ⚠️ ship_order não é idempotente', () => {
  it('S30: erro de REDE no ship ⇒ verificar, UM ship só', async () => {
    const f = fakeClient({ ship: [new ShopeeNetworkError('queda')] });
    await expect(programarPacoteShopee(f.client, ALVO, null, AGORA)).resolves.toStrictEqual({
      tipo: 'verificar',
    });
    expect(f.shipOrder).toHaveBeenCalledTimes(1);
  });

  it('S30: HTTP sem envelope e error_timeout ⇒ verificar, UM ship só', async () => {
    for (const erro of [
      new ShopeeHttpError('borda', { httpStatus: 502, path: '/api/v2/logistics/ship_order' }),
      envelope('logistics.error_timeout', 'timeout'),
    ]) {
      const f = fakeClient({ ship: [erro] });
      await expect(programarPacoteShopee(f.client, ALVO, null, AGORA)).resolves.toStrictEqual({
        tipo: 'verificar',
      });
      expect(f.shipOrder).toHaveBeenCalledTimes(1);
    }
  });

  it('S31: " logistics.package_already_shipped" (com o espaço da página) ⇒ ja-programado', async () => {
    const f = fakeClient({ ship: [envelope(' logistics.package_already_shipped', 'shipped')] });
    await expect(programarPacoteShopee(f.client, ALVO, null, AGORA)).resolves.toStrictEqual({
      tipo: 'ja-programado',
    });
    expect(f.shipOrder).toHaveBeenCalledTimes(1);
  });

  it('R-l: not_need_pacakge_number ⇒ UM reenvio SEM o número', async () => {
    const f = fakeClient({
      ship: [envelope('logistics.ship_order_not_need_pacakge_number', null)],
    });
    await expect(
      programarPacoteShopee(f.client, ALVO_DIVIDIDO, null, AGORA),
    ).resolves.toStrictEqual({ tipo: 'programado', semPacote: true });
    expect(f.shipOrder).toHaveBeenCalledTimes(2);
    expect('packageNumber' in corpoDoShip(f.shipOrder, 0)).toBe(true);
    expect('packageNumber' in corpoDoShip(f.shipOrder, 1)).toBe(false);
  });

  it('R2-2: o PEDIDO já foi organizado sem número nesta chamada ⇒ o not_need do irmão é ja-programado, SEM reenvio', async () => {
    const naoPrecisa = () => envelope('logistics.ship_order_not_need_pacakge_number', null);
    const f = fakeClient({ ship: [naoPrecisa()] });
    await expect(
      programarPacoteShopee(
        f.client,
        { ...ALVO_DIVIDIDO, ordemProgramadaSemPacote: true },
        null,
        AGORA,
      ),
    ).resolves.toStrictEqual({ tipo: 'ja-programado' });
    expect(f.shipOrder).toHaveBeenCalledTimes(1);
    expect('packageNumber' in corpoDoShip(f.shipOrder, 0)).toBe(true);

    // Near-miss: the memory says nothing ⇒ the R-l re-send still goes out.
    const g = fakeClient({ ship: [naoPrecisa()] });
    await programarPacoteShopee(
      g.client,
      { ...ALVO_DIVIDIDO, ordemProgramadaSemPacote: false },
      null,
      AGORA,
    );
    expect(g.shipOrder).toHaveBeenCalledTimes(2);
  });

  it('R-l: o reenvio recusado de novo ⇒ pacotes-mudaram, nunca um terceiro ship', async () => {
    const naoPrecisa = () => envelope('logistics.ship_order_not_need_pacakge_number', null);
    const f = fakeClient({ ship: [naoPrecisa(), naoPrecisa(), naoPrecisa()] });
    await expect(
      programarPacoteShopee(f.client, ALVO_DIVIDIDO, null, AGORA),
    ).resolves.toStrictEqual({ tipo: 'recusa', motivo: MOTIVO_ETIQUETA_SHOPEE.pacotesMudaram });
    expect(f.shipOrder).toHaveBeenCalledTimes(2);
  });

  it('R-l: not_need sem número para tirar ⇒ pacotes-mudaram, UM ship', async () => {
    const f = fakeClient({
      ship: [envelope('logistics.ship_order_not_need_pacakge_number', null)],
    });
    await expect(programarPacoteShopee(f.client, ALVO, null, AGORA)).resolves.toStrictEqual({
      tipo: 'recusa',
      motivo: MOTIVO_ETIQUETA_SHOPEE.pacotesMudaram,
    });
    expect(f.shipOrder).toHaveBeenCalledTimes(1);
  });

  it('R4-3: need_pacakge_number num ship SEM o número ⇒ UM reenvio COM ele', async () => {
    const f = fakeClient({ ship: [envelope('logistics.ship_order_need_pacakge_number', null)] });
    await expect(programarPacoteShopee(f.client, ALVO, null, AGORA)).resolves.toStrictEqual({
      tipo: 'programado',
      semPacote: false,
    });
    expect(f.shipOrder).toHaveBeenCalledTimes(2);
    expect('packageNumber' in corpoDoShip(f.shipOrder, 0)).toBe(false);
    expect(corpoDoShip(f.shipOrder, 1)).toStrictEqual({
      orderSn: ORDER_SN,
      packageNumber: PACOTE,
      modo: 'pickup',
      pickup: { addressId: 2001, pickupTimeId: 'slot-1' },
    });
  });

  it('R4-3: need recusado de novo no reenvio ⇒ pacotes-mudaram, nunca um terceiro ship', async () => {
    const precisa = () => envelope(' logistics.ship_order_need_pacakge_number', null);
    const f = fakeClient({ ship: [precisa(), precisa(), precisa()] });
    await expect(programarPacoteShopee(f.client, ALVO, null, AGORA)).resolves.toStrictEqual({
      tipo: 'recusa',
      motivo: MOTIVO_ETIQUETA_SHOPEE.pacotesMudaram,
    });
    expect(f.shipOrder).toHaveBeenCalledTimes(2);
  });

  it('R4-3 (near-miss): need num ship que JÁ levava o número ⇒ pacotes-mudaram, SEM reenvio', async () => {
    const f = fakeClient({ ship: [envelope('logistics.ship_order_need_pacakge_number', null)] });
    await expect(
      programarPacoteShopee(f.client, ALVO_DIVIDIDO, null, AGORA),
    ).resolves.toStrictEqual({ tipo: 'recusa', motivo: MOTIVO_ETIQUETA_SHOPEE.pacotesMudaram });
    expect(f.shipOrder).toHaveBeenCalledTimes(1);
  });

  it('R4-3 (near-miss): "has been splitted" sem o número é lista VELHA ⇒ pacotes-mudaram, SEM reenvio', async () => {
    const f = fakeClient({
      ship: [envelope('logistics.error_param', 'The order has been splitted, please refresh.')],
    });
    await expect(programarPacoteShopee(f.client, ALVO, null, AGORA)).resolves.toStrictEqual({
      tipo: 'recusa',
      motivo: MOTIVO_ETIQUETA_SHOPEE.pacotesMudaram,
    });
    expect(f.shipOrder).toHaveBeenCalledTimes(1);
  });

  it('R2-3: um 2xx ILEGÍVEL do ship (ShopeeSchemaError) ⇒ verificar, UM ship — o ship pode ter acontecido', async () => {
    const ilegivel = new ShopeeSchemaError('sem envelope', {
      httpStatus: 200,
      path: '/api/v2/logistics/ship_order',
    });
    const f = fakeClient({ ship: [ilegivel] });
    await expect(programarPacoteShopee(f.client, ALVO, null, AGORA)).resolves.toStrictEqual({
      tipo: 'verificar',
    });
    expect(f.shipOrder).toHaveBeenCalledTimes(1);
  });

  it('R2-3 (near-miss): o mesmo erro fora de 2xx, ou na LEITURA do parâmetro, é relançado', async () => {
    const fora = new ShopeeSchemaError('x', {
      httpStatus: 400,
      path: '/api/v2/logistics/ship_order',
    });
    const f = fakeClient({ ship: [fora] });
    await expect(programarPacoteShopee(f.client, ALVO, null, AGORA)).rejects.toBe(fora);

    const naLeitura = new ShopeeSchemaError('x', {
      httpStatus: 200,
      path: '/api/v2/logistics/get_shipping_parameter',
    });
    const g = fakeClient({ parametroErro: naLeitura });
    await expect(programarPacoteShopee(g.client, ALVO, null, AGORA)).rejects.toBe(naLeitura);
    expect(g.shipOrder).not.toHaveBeenCalled();
  });

  it('o horário recusado no ship ⇒ pergunta marcada inválida, UM ship', async () => {
    const f = fakeClient({
      parametro: DOIS_ENDERECOS,
      ship: [envelope('logistics.ship_order_pickup_time_invalid', 'invalid')],
    });
    const escolha: EscolhaDeEnvio = {
      pacote: PACOTE,
      modo: 'pickup',
      enderecoId: '2001',
      horarioId: 'slot-1',
    };
    const r = await programarPacoteShopee(f.client, ALVO, escolha, AGORA);
    expect(r).toMatchObject({ tipo: 'pergunta', escolhaInvalida: true });
    expect(f.shipOrder).toHaveBeenCalledTimes(1);
  });

  it('o horário recusado quando era a ÚNICA opção ⇒ aguardar, nunca o mesmo ship de novo', async () => {
    const f = fakeClient({ ship: [envelope('logistics.ship_order_pickup_time_invalid', 'x')] });
    await expect(programarPacoteShopee(f.client, ALVO, null, AGORA)).resolves.toStrictEqual({
      tipo: 'aguardar',
      fase: 'programando',
      tentarEmMs: TENTAR_EM_SHOPEE_MS,
    });
    expect(f.shipOrder).toHaveBeenCalledTimes(1);
  });

  it('R3-F1: um código que a tabela não conhece ⇒ recusa-desconhecida com o código SEGURO e a operação', async () => {
    const f = fakeClient({ ship: [envelope('logistics.algum_codigo_novo\t', 'x')] });
    await expect(programarPacoteShopee(f.client, ALVO, null, AGORA)).resolves.toStrictEqual({
      tipo: 'recusa',
      motivo: MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida,
      shopeeCode: 'algum_codigo_novo',
      operacao: 'programar',
    });

    // The parameter read names ITS operation.
    const g = fakeClient({ parametroErro: envelope('logistics.outro_codigo', 'x') });
    await expect(programarPacoteShopee(g.client, ALVO, null, AGORA)).resolves.toStrictEqual({
      tipo: 'recusa',
      motivo: MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida,
      shopeeCode: 'outro_codigo',
      operacao: 'parametro-envio',
    });
  });

  it('R3-F1 (near-miss): um "código" com 7 dígitos não é código ⇒ sem shopeeCode; um motivo conhecido não leva nenhum dos dois', async () => {
    const f = fakeClient({ ship: [envelope('logistics.erro_1234567', 'x')] });
    await expect(programarPacoteShopee(f.client, ALVO, null, AGORA)).resolves.toStrictEqual({
      tipo: 'recusa',
      motivo: MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida,
      operacao: 'programar',
    });
    const g = fakeClient({ parametro: { info_needed: { non_integrated: [] } } });
    await expect(programarPacoteShopee(g.client, ALVO, null, AGORA)).resolves.toStrictEqual({
      tipo: 'recusa',
      motivo: MOTIVO_ETIQUETA_SHOPEE.semEtiquetaShopee,
    });
  });

  it('a cota diária no ship ⇒ recusa limite-diario com tentarApos', async () => {
    const f = fakeClient({ ship: [envelope('error_limit', 'reached the daily API call limit')] });
    await expect(programarPacoteShopee(f.client, ALVO, null, AGORA)).resolves.toStrictEqual({
      tipo: 'recusa',
      motivo: MOTIVO_ETIQUETA_SHOPEE.limiteDiario,
      tentarApos: proximaViradaDaCotaMs(AGORA),
    });
  });
});

describe('programarPacoteShopee — a leitura do parâmetro', () => {
  it('lack_of_invoice_data no parâmetro ⇒ nfe-pendente, ZERO ship', async () => {
    const f = fakeClient({
      parametroErro: envelope('logistics.lack_of_invoice_data', 'no invoice'),
    });
    await expect(programarPacoteShopee(f.client, ALVO, null, AGORA)).resolves.toStrictEqual({
      tipo: 'nfe-pendente',
    });
    expect(f.shipOrder).not.toHaveBeenCalled();
  });

  it('rede caída na LEITURA ⇒ aguardar (nada foi enviado), nunca verificar', async () => {
    const f = fakeClient({ parametroErro: new ShopeeNetworkError('queda') });
    await expect(programarPacoteShopee(f.client, ALVO, null, AGORA)).resolves.toStrictEqual({
      tipo: 'aguardar',
      fase: 'programando',
      tentarEmMs: TENTAR_EM_SHOPEE_MS,
    });
    expect(f.shipOrder).not.toHaveBeenCalled();
  });

  it('um erro que a tabela não possui é RELANÇADO intacto', async () => {
    const nosso = new ShopeeConfigError('configuração');
    const f = fakeClient({ parametroErro: nosso });
    await expect(programarPacoteShopee(f.client, ALVO, null, AGORA)).rejects.toBe(nosso);

    const estranho = new TypeError('não é da Shopee');
    const g = fakeClient({ ship: [estranho] });
    await expect(programarPacoteShopee(g.client, ALVO, null, AGORA)).rejects.toBe(estranho);
    expect(g.shipOrder).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------ ENVIO_AUTOMATICO (step 15b) ------------------------ */

function enderecoComFlags(id: number, flags: string[], slots: unknown[] | null) {
  return { ...endereco(id, slots), address_flag: flags };
}

/** One address, two slots, the SECOND recommended: the operator is asked, the automatic mode decides. */
const HORARIO_RECOMENDADO = {
  info_needed: { pickup: ['address_id', 'pickup_time_id'] },
  pickup: {
    address_list: [
      endereco(2001, [horario('slot-1'), { ...horario('slot-2'), flags: ['recommended'] }]),
    ],
  },
};

/** Two addresses, the SECOND the seller's principal: the automatic mode ships it. */
const DOIS_COM_PRINCIPAL = {
  info_needed: { pickup: ['address_id', 'pickup_time_id'] },
  pickup: {
    address_list: [
      endereco(2001, [horario('slot-1')]),
      enderecoComFlags(2002, ['pickup_address', 'default_address'], [horario('slot-2')]),
    ],
  },
};

/** RT3: the package's own guard accepts the body the fake received. */
function aceitoPeloPacote(shipOrder: ReturnType<typeof fakeClient>['shipOrder'], i = 0): void {
  expect(() => assertShipOrderParams(corpoDoShip(shipOrder, i))).not.toThrow();
}

describe('programarPacoteShopee — ENVIO_AUTOMATICO (step 15b, R-g)', () => {
  it('mutante 24: um recomendado entre DOIS horários — o operador sem resposta é PERGUNTADO, a sentinela envia o recomendado', async () => {
    const operador = fakeClient({ parametro: HORARIO_RECOMENDADO });
    const r = await programarPacoteShopee(operador.client, ALVO, null, AGORA);
    expect(r).toMatchObject({ tipo: 'pergunta', escolhaInvalida: false });
    expect(operador.shipOrder).not.toHaveBeenCalled();

    const auto = fakeClient({ parametro: HORARIO_RECOMENDADO });
    await expect(
      programarPacoteShopee(auto.client, ALVO, ENVIO_AUTOMATICO, AGORA),
    ).resolves.toStrictEqual({ tipo: 'programado', semPacote: true });
    expect(auto.getShippingParameter).toHaveBeenCalledWith({
      orderSn: ORDER_SN,
      packageNumber: PACOTE,
    });
    expect(auto.shipOrder).toHaveBeenCalledTimes(1);
    expect(corpoDoShip(auto.shipOrder)).toStrictEqual({
      orderSn: ORDER_SN,
      modo: 'pickup',
      pickup: { addressId: 2001, pickupTimeId: 'slot-2' },
    });
    aceitoPeloPacote(auto.shipOrder);
  });

  it('a sentinela não nomeia pacote: o filtro de escolha.pacote não a descarta, e o pedido dividido leva o número', async () => {
    const f = fakeClient({ parametro: DOIS_COM_PRINCIPAL });
    await expect(
      programarPacoteShopee(f.client, ALVO_DIVIDIDO, ENVIO_AUTOMATICO, AGORA),
    ).resolves.toStrictEqual({ tipo: 'programado', semPacote: false });
    expect(corpoDoShip(f.shipOrder)).toStrictEqual({
      orderSn: ORDER_SN,
      packageNumber: PACOTE,
      modo: 'pickup',
      pickup: { addressId: 2002, pickupTimeId: 'slot-2' },
    });
    aceitoPeloPacote(f.shipOrder);
  });

  it('sem horário nenhum ⇒ o ship não leva a chave pickupTimeId', async () => {
    const f = fakeClient({
      parametro: {
        info_needed: { pickup: ['address_id', 'pickup_time_id'] },
        pickup: { address_list: [endereco(2001, null)] },
      },
    });
    await programarPacoteShopee(f.client, ALVO, ENVIO_AUTOMATICO, AGORA);
    const corpo = corpoDoShip(f.shipOrder);
    expect(corpo).toStrictEqual({ orderSn: ORDER_SN, modo: 'pickup', pickup: { addressId: 2001 } });
    if (corpo.modo !== 'pickup') throw new Error('esperava pickup');
    expect('pickupTimeId' in corpo.pickup).toBe(false);
    aceitoPeloPacote(f.shipOrder);
  });

  it('pickup decidido + dropoff construível ⇒ o ship é o PICKUP', async () => {
    const f = fakeClient({
      parametro: { ...UM_ENDERECO, info_needed: { ...UM_ENDERECO.info_needed, dropoff: [] } },
    });
    await programarPacoteShopee(f.client, ALVO, ENVIO_AUTOMATICO, AGORA);
    expect(corpoDoShip(f.shipOrder)).toStrictEqual({
      orderSn: ORDER_SN,
      modo: 'pickup',
      pickup: { addressId: 2001, pickupTimeId: 'slot-1' },
    });
  });

  it('indecisa (dois endereços, nenhum principal) ⇒ pergunta com escolhaInvalida false, ZERO ship', async () => {
    const f = fakeClient({ parametro: DOIS_ENDERECOS });
    const r = await programarPacoteShopee(f.client, ALVO, ENVIO_AUTOMATICO, AGORA);
    expect(r).toMatchObject({ tipo: 'pergunta', permiteDropoff: false, escolhaInvalida: false });
    expect(f.shipOrder).not.toHaveBeenCalled();
  });

  it('nada construível ⇒ a recusa, ZERO ship', async () => {
    const f = fakeClient({
      parametro: {
        info_needed: { dropoff: ['branch_id'] },
        dropoff: { branch_list: [{ branch_id: 31 }, { branch_id: 32 }] },
      },
    });
    await expect(
      programarPacoteShopee(f.client, ALVO, ENVIO_AUTOMATICO, AGORA),
    ).resolves.toStrictEqual({
      tipo: 'recusa',
      motivo: MOTIVO_ETIQUETA_SHOPEE.agenciaPrecisaEscolha,
    });
    expect(f.shipOrder).not.toHaveBeenCalled();
  });

  it.each([
    ['logistics.ship_order_pickup_time_invalid', 'Invalid pickup time id.'],
    [
      'logistics.ship_order_need_address_pickup_time',
      'Parameter address_id and pickup_time_id are required.',
    ],
  ])(
    'mutante 25: %s sob a sentinela ⇒ aguardar programando, UM ship e UMA leitura — nunca a pergunta, nunca o 2º ship',
    async (code, frase) => {
      // The operator chooser would RE-ASK here (two addresses), so a sentinel
      // that fell through to the operator path answers `pergunta`, not `aguardar`.
      const f = fakeClient({ parametro: DOIS_COM_PRINCIPAL, ship: [envelope(code, frase)] });
      await expect(
        programarPacoteShopee(f.client, ALVO, ENVIO_AUTOMATICO, AGORA),
      ).resolves.toStrictEqual({
        tipo: 'aguardar',
        fase: 'programando',
        tentarEmMs: TENTAR_EM_SHOPEE_MS,
      });
      expect(f.shipOrder).toHaveBeenCalledTimes(1);
      expect(f.getShippingParameter).toHaveBeenCalledTimes(1);

      // Near-miss: the operator's answer for the same address meets the same
      // refusal ⇒ re-asked, marked stale — still ONE ship.
      const g = fakeClient({ parametro: DOIS_COM_PRINCIPAL, ship: [envelope(code, frase)] });
      const escolha: EscolhaDeEnvio = {
        pacote: PACOTE,
        modo: 'pickup',
        enderecoId: '2002',
        horarioId: 'slot-2',
      };
      const r = await programarPacoteShopee(g.client, ALVO, escolha, AGORA);
      expect(r).toMatchObject({ tipo: 'pergunta', escolhaInvalida: true });
      expect(g.shipOrder).toHaveBeenCalledTimes(1);
    },
  );

  it('a sentinela muda SÓ o reescolher: o reenvio documentado de R-l continua UM só', async () => {
    const f = fakeClient({
      ship: [envelope('logistics.ship_order_not_need_pacakge_number', null)],
    });
    await expect(
      programarPacoteShopee(f.client, ALVO_DIVIDIDO, ENVIO_AUTOMATICO, AGORA),
    ).resolves.toStrictEqual({ tipo: 'programado', semPacote: true });
    expect(f.shipOrder).toHaveBeenCalledTimes(2);
    aceitoPeloPacote(f.shipOrder, 0);
    aceitoPeloPacote(f.shipOrder, 1);
  });

  it('" logistics.package_already_shipped" sob a sentinela ⇒ ja-programado, UM ship', async () => {
    const f = fakeClient({ ship: [envelope(' logistics.package_already_shipped', 'shipped')] });
    await expect(
      programarPacoteShopee(f.client, ALVO, ENVIO_AUTOMATICO, AGORA),
    ).resolves.toStrictEqual({ tipo: 'ja-programado' });
    expect(f.shipOrder).toHaveBeenCalledTimes(1);
  });
});
