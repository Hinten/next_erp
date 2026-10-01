import { describe, expect, it } from 'vitest';

import {
  shopeeShippingParameterPayloadSchema,
  type ShopeeShippingParameter,
} from '@delfrance/integrations-shopee';

import { escolherModoDeEnvio, type EscolhaDeEnvio, type ModoEscolhido } from './modoDeEnvio';
import { MOTIVO_ETIQUETA_SHOPEE } from './motivosEtiqueta';

/* --------------------------------- fixtures --------------------------------- */

/** Through the package's own schema, so the chooser sees exactly what the client returns. */
function parametro(raw: unknown): ShopeeShippingParameter {
  return shopeeShippingParameterPayloadSchema.parse(raw);
}

const COLETA = 'pickup_address';
const PADRAO = 'default_address';

function endereco(
  id: number,
  flags: string[] | null,
  slots: unknown[] | null = null,
  extra: Record<string, unknown> = {},
) {
  return {
    address_id: id,
    region: 'BR',
    state: 'SP',
    city: 'Cidade do Vendedor',
    district: 'Centro',
    town: '',
    address: 'Rua do Vendedor, 100',
    zipcode: '00000-000',
    address_flag: flags,
    time_slot_list: slots,
    ...extra,
  };
}

function horario(id: unknown, flags: string[] | null = null, extra: Record<string, unknown> = {}) {
  return { date: 1_790_000_000, time_text: '09:00-12:00', pickup_time_id: id, flags, ...extra };
}

/** Pickup only, the two items the page documents. */
function soColeta(enderecos: unknown[], itens: string[] = ['address_id', 'pickup_time_id']) {
  return parametro({
    info_needed: { pickup: itens },
    pickup: { address_list: enderecos },
  });
}

function escolhaColeta(enderecoId: string, horarioId: string | null): EscolhaDeEnvio {
  return { pacote: 'OFG000000000001', modo: 'pickup', enderecoId, horarioId };
}

const ESCOLHA_POSTAGEM: EscolhaDeEnvio = { pacote: 'OFG000000000001', modo: 'dropoff' };

function recusa(chave: keyof typeof MOTIVO_ETIQUETA_SHOPEE): ModoEscolhido {
  return { tipo: 'recusa', motivo: MOTIVO_ETIQUETA_SHOPEE[chave] };
}

/* ---------------------------------- tests ----------------------------------- */

describe('escolherModoDeEnvio — a amostra da própria página', () => {
  it('pickup + dropoff [] oferecidos ⇒ pergunta com permiteDropoff; só o endereço de COLETA', () => {
    // `get_shipping_parameter`'s response sample, verbatim in shape.
    const p = parametro({
      info_needed: { dropoff: [], pickup: ['address_id', 'pickup_time_id'] },
      dropoff: null,
      pickup: {
        address_list: [
          {
            address_id: 123,
            region: 'SG',
            state: '',
            city: '',
            district: '',
            town: '',
            address: '',
            zipcode: '40009',
            address_flag: ['default_address', 'pickup_address', 'return_address'],
            time_slot_list: null,
          },
          {
            address_id: 234,
            region: 'SG',
            state: '',
            city: '',
            district: '',
            town: '',
            address: 'hhh, #34',
            zipcode: 'xxx',
            address_flag: [],
            time_slot_list: null,
          },
        ],
      },
    });
    expect(escolherModoDeEnvio(p, null)).toStrictEqual({
      tipo: 'pergunta',
      enderecos: [{ id: '123', rotulo: '40009', principal: true, horarios: [] }],
      permiteDropoff: true,
      escolhaInvalida: false,
    });
  });
});

describe('escolherModoDeEnvio — o modo é a CHAVE presente em info_needed', () => {
  it('ABSENT ≠ []: dropoff null não oferece o modo; dropoff [] oferece (e pergunta)', () => {
    const base = { pickup: { address_list: [endereco(5, [COLETA])] } };
    const semPostagem = parametro({
      ...base,
      info_needed: { pickup: ['address_id'], dropoff: null },
    });
    const comPostagem = parametro({
      ...base,
      info_needed: { pickup: ['address_id'], dropoff: [] },
    });
    expect(escolherModoDeEnvio(semPostagem, null)).toStrictEqual({
      tipo: 'corpo',
      corpo: { modo: 'pickup', pickup: { addressId: 5 } },
    });
    expect(escolherModoDeEnvio(comPostagem, null)).toMatchObject({
      tipo: 'pergunta',
      permiteDropoff: true,
      escolhaInvalida: false,
    });
  });

  it('dropoff [] sozinho ⇒ corpo com "dropoff": {} — a chave PRESENTE, objeto vazio', () => {
    const modo = escolherModoDeEnvio(parametro({ info_needed: { dropoff: [] } }), null);
    expect(modo).toStrictEqual({ tipo: 'corpo', corpo: { modo: 'dropoff', dropoff: {} } });
  });

  it('non_integrated sozinho ⇒ recusa sem-etiqueta-shopee (com ou sem itens)', () => {
    for (const itens of [[], ['tracking_no']]) {
      expect(
        escolherModoDeEnvio(parametro({ info_needed: { non_integrated: itens } }), null),
      ).toStrictEqual(recusa('semEtiquetaShopee'));
    }
  });

  it('non_integrated ao lado de pickup não impede o pickup', () => {
    const p = parametro({
      info_needed: { pickup: ['address_id'], non_integrated: [] },
      pickup: { address_list: [endereco(5, [COLETA])] },
    });
    expect(escolherModoDeEnvio(p, null)).toMatchObject({
      tipo: 'corpo',
      corpo: { modo: 'pickup' },
    });
  });

  it.each([
    ['info_needed ausente', {}],
    ['info_needed vazio', { info_needed: {} }],
    // The page's prose spells this key with a hyphen: it rides passthrough and is NO mode.
    ['a chave com hífen', { info_needed: { 'non-integrated': [] } }],
  ])('%s ⇒ recusa modo-nao-suportado (nunca adivinha)', (_nome, raw) => {
    expect(escolherModoDeEnvio(parametro(raw), null)).toStrictEqual(recusa('modoNaoSuportado'));
  });
});

describe('escolherModoDeEnvio — S41, o endereço de coleta', () => {
  it('default_address SOZINHO não é endereço de coleta ⇒ recusa sem-endereco-de-coleta', () => {
    expect(escolherModoDeEnvio(soColeta([endereco(5, [PADRAO])]), null)).toStrictEqual(
      recusa('semEnderecoDeColeta'),
    );
  });

  it('near-miss: o mesmo endereço COM pickup_address ⇒ corpo', () => {
    expect(escolherModoDeEnvio(soColeta([endereco(5, [PADRAO, COLETA])]), null)).toStrictEqual({
      tipo: 'corpo',
      corpo: { modo: 'pickup', pickup: { addressId: 5 } },
    });
  });

  it('address_flag null ou [] ⇒ não elegível', () => {
    expect(escolherModoDeEnvio(soColeta([endereco(5, null), endereco(6, [])]), null)).toStrictEqual(
      recusa('semEnderecoDeColeta'),
    );
  });

  it('dois endereços de coleta ⇒ pergunta, na ordem da Shopee; principal = também default', () => {
    const modo = escolherModoDeEnvio(
      soColeta([endereco(5, [COLETA]), endereco(6, [COLETA, PADRAO]), endereco(7, [PADRAO])]),
      null,
    );
    expect(modo).toMatchObject({ tipo: 'pergunta', permiteDropoff: false, escolhaInvalida: false });
    if (modo.tipo !== 'pergunta') throw new Error('esperava pergunta');
    expect(modo.enderecos.map((e) => [e.id, e.principal])).toStrictEqual([
      ['5', false],
      ['6', true],
    ]);
  });

  it('um address_id int64 INSEGURO vira a sentinela da linha; o irmão segue', () => {
    const p = soColeta([endereco(9_007_199_254_740_994, [COLETA]), endereco(7, [COLETA])]);
    expect(p.pickup?.address_list?.[0]).toBeNull();
    expect(escolherModoDeEnvio(p, null)).toStrictEqual({
      tipo: 'corpo',
      corpo: { modo: 'pickup', pickup: { addressId: 7 } },
    });
  });

  it('pickup pedindo um item que o ERP não preenche ⇒ recusa modo-nao-suportado', () => {
    expect(
      escolherModoDeEnvio(
        soColeta([endereco(5, [COLETA])], ['address_id', 'tracking_number']),
        null,
      ),
    ).toStrictEqual(recusa('modoNaoSuportado'));
  });
});

describe('escolherModoDeEnvio — os horários', () => {
  it('zero horários ⇒ corpo SEM pickupTimeId (legal)', () => {
    const modo = escolherModoDeEnvio(soColeta([endereco(5, [COLETA], null)]), null);
    expect(modo).toStrictEqual({
      tipo: 'corpo',
      corpo: { modo: 'pickup', pickup: { addressId: 5 } },
    });
    if (modo.tipo !== 'corpo' || modo.corpo.modo !== 'pickup') throw new Error('esperava pickup');
    expect('pickupTimeId' in modo.corpo.pickup).toBe(false);
  });

  it('um horário ⇒ corpo com ele', () => {
    expect(
      escolherModoDeEnvio(soColeta([endereco(5, [COLETA], [horario('h1')])]), null),
    ).toStrictEqual({
      tipo: 'corpo',
      corpo: { modo: 'pickup', pickup: { addressId: 5, pickupTimeId: 'h1' } },
    });
  });

  it('dois horários ⇒ pergunta; recomendado = flags ∋ recommended', () => {
    const modo = escolherModoDeEnvio(
      soColeta([endereco(5, [COLETA], [horario('h1'), horario('h2', ['recommended'])])]),
      null,
    );
    if (modo.tipo !== 'pergunta') throw new Error('esperava pergunta');
    expect(modo.enderecos[0]?.horarios.map((h) => [h.id, h.recomendado])).toStrictEqual([
      ['h1', false],
      ['h2', true],
    ]);
  });

  it('pickup_time_id fora de info_needed.pickup ⇒ nenhum horário é oferecido nem enviado', () => {
    expect(
      escolherModoDeEnvio(
        soColeta([endereco(5, [COLETA], [horario('h1'), horario('h2')])], ['address_id']),
        null,
      ),
    ).toStrictEqual({ tipo: 'corpo', corpo: { modo: 'pickup', pickup: { addressId: 5 } } });
  });

  it('um pickup_time_id NUMÉRICO no fio viaja como seus dígitos, ida e volta', () => {
    const p = soColeta([endereco(5, [COLETA], [horario(1_700_000_001), horario('h2')])]);
    const pergunta = escolherModoDeEnvio(p, null);
    if (pergunta.tipo !== 'pergunta') throw new Error('esperava pergunta');
    expect(pergunta.enderecos[0]?.horarios[0]?.id).toBe('1700000001');
    expect(escolherModoDeEnvio(p, escolhaColeta('5', '1700000001'))).toStrictEqual({
      tipo: 'corpo',
      corpo: { modo: 'pickup', pickup: { addressId: 5, pickupTimeId: '1700000001' } },
    });
  });
});

describe('escolherModoDeEnvio — S42/S43, a escolha casa EXATAMENTE com esta leitura', () => {
  const p = soColeta([
    endereco(123, [COLETA], [horario('h1'), horario('h2')]),
    endereco(456, [COLETA], null),
  ]);

  it('a escolha exata ⇒ corpo, addressId de volta como NÚMERO', () => {
    const modo = escolherModoDeEnvio(p, escolhaColeta('123', 'h2'));
    expect(modo).toStrictEqual({
      tipo: 'corpo',
      corpo: { modo: 'pickup', pickup: { addressId: 123, pickupTimeId: 'h2' } },
    });
  });

  it.each(['0123', ' 123', '123 ', '1.23e2', '123.0', '+123'])(
    'S43: enderecoId %j — Number() diria 123, a comparação de string não ⇒ pergunta de novo',
    (id) => {
      expect(Number(id)).toBe(123); // the near-miss is real
      expect(escolherModoDeEnvio(p, escolhaColeta(id, 'h1'))).toMatchObject({
        tipo: 'pergunta',
        escolhaInvalida: true,
      });
    },
  );

  it('S42: um endereço que sumiu ⇒ pergunta de novo com as opções FRESCAS, nunca um corpo', () => {
    const modo = escolherModoDeEnvio(p, escolhaColeta('999', null));
    expect(modo).toMatchObject({ tipo: 'pergunta', escolhaInvalida: true, permiteDropoff: false });
    if (modo.tipo !== 'pergunta') throw new Error('esperava pergunta');
    expect(modo.enderecos.map((e) => e.id)).toStrictEqual(['123', '456']);
  });

  it('um horário que sumiu ⇒ pergunta de novo', () => {
    expect(escolherModoDeEnvio(p, escolhaColeta('123', 'h9'))).toMatchObject({
      tipo: 'pergunta',
      escolhaInvalida: true,
    });
  });

  it('horarioId null só vale para um endereço SEM horários', () => {
    expect(escolherModoDeEnvio(p, escolhaColeta('123', null))).toMatchObject({
      tipo: 'pergunta',
      escolhaInvalida: true,
    });
    expect(escolherModoDeEnvio(p, escolhaColeta('456', null))).toStrictEqual({
      tipo: 'corpo',
      corpo: { modo: 'pickup', pickup: { addressId: 456 } },
    });
  });

  it('um endereço que perdeu a flag de coleta não casa, mesmo com o id certo', () => {
    const agora = soColeta([endereco(123, [PADRAO]), endereco(456, [COLETA])]);
    expect(escolherModoDeEnvio(agora, escolhaColeta('123', null))).toMatchObject({
      tipo: 'pergunta',
      escolhaInvalida: true,
    });
  });

  it('uma escolha velha com UMA opção restante pergunta de novo — nunca troca em silêncio', () => {
    const agora = soColeta([endereco(456, [COLETA])]);
    expect(escolherModoDeEnvio(agora, escolhaColeta('123', null))).toStrictEqual({
      tipo: 'pergunta',
      enderecos: [
        {
          id: '456',
          rotulo: 'Rua do Vendedor, 100, Centro, Cidade do Vendedor, SP, 00000-000',
          principal: false,
          horarios: [],
        },
      ],
      permiteDropoff: false,
      escolhaInvalida: true,
    });
  });

  it('uma escolha velha sem NADA para perguntar ⇒ a recusa desta leitura, nunca uma pergunta vazia', () => {
    const agora = soColeta([endereco(123, [PADRAO])]);
    expect(escolherModoDeEnvio(agora, escolhaColeta('123', null))).toStrictEqual(
      recusa('semEnderecoDeColeta'),
    );
  });
});

describe('escolherModoDeEnvio — dropoff (R-z, sem seletor de agência)', () => {
  function soPostagem(itens: string[], agencias: unknown[] | null) {
    return parametro({ info_needed: { dropoff: itens }, dropoff: { branch_list: agencias } });
  }
  const agencia = (id: number) => ({ branch_id: id, city: 'Cidade', address: 'Agência' });

  it('branch_id com UMA agência ⇒ automática', () => {
    expect(escolherModoDeEnvio(soPostagem(['branch_id'], [agencia(31)]), null)).toStrictEqual({
      tipo: 'corpo',
      corpo: { modo: 'dropoff', dropoff: { branchId: 31 } },
    });
  });

  it('branch_id com mais de uma ⇒ recusa agencia-precisa-escolha', () => {
    expect(
      escolherModoDeEnvio(soPostagem(['branch_id'], [agencia(31), agencia(32)]), null),
    ).toStrictEqual(recusa('agenciaPrecisaEscolha'));
  });

  it('a contagem é da lista CRUA: uma ilegível + uma legível ainda são duas', () => {
    const p = soPostagem(['branch_id'], [{ branch_id: 'x' }, agencia(32)]);
    expect(p.dropoff?.branch_list?.[0]).toBeNull();
    expect(escolherModoDeEnvio(p, null)).toStrictEqual(recusa('agenciaPrecisaEscolha'));
  });

  it.each([
    ['nenhuma lista', null],
    ['lista vazia', []],
    ['só a sentinela', [{ branch_id: 'x' }]],
  ])('branch_id com %s ⇒ recusa modo-nao-suportado', (_nome, agencias) => {
    expect(escolherModoDeEnvio(soPostagem(['branch_id'], agencias), null)).toStrictEqual(
      recusa('modoNaoSuportado'),
    );
  });

  it.each([['sender_real_name'], ['tracking_no'], ['slug'], ['branch_id', 'sender_real_name']])(
    'dropoff pedindo %s ⇒ recusa modo-nao-suportado',
    (...itens) => {
      expect(escolherModoDeEnvio(soPostagem(itens, [agencia(31)]), null)).toStrictEqual(
        recusa('modoNaoSuportado'),
      );
    },
  );
});

describe('escolherModoDeEnvio — a escolha do modo', () => {
  const ambos = parametro({
    info_needed: { pickup: ['address_id'], dropoff: [] },
    pickup: { address_list: [endereco(5, [COLETA])] },
  });

  it('dropoff escolhido com os dois oferecidos ⇒ corpo dropoff {}', () => {
    expect(escolherModoDeEnvio(ambos, ESCOLHA_POSTAGEM)).toStrictEqual({
      tipo: 'corpo',
      corpo: { modo: 'dropoff', dropoff: {} },
    });
  });

  it('pickup escolhido com os dois oferecidos ⇒ corpo pickup', () => {
    expect(escolherModoDeEnvio(ambos, escolhaColeta('5', null))).toStrictEqual({
      tipo: 'corpo',
      corpo: { modo: 'pickup', pickup: { addressId: 5 } },
    });
  });

  it('dropoff escolhido mas não mais oferecido ⇒ pergunta de novo, sem dropoff', () => {
    const p = soColeta([endereco(5, [COLETA])]);
    expect(escolherModoDeEnvio(p, ESCOLHA_POSTAGEM)).toMatchObject({
      tipo: 'pergunta',
      permiteDropoff: false,
      escolhaInvalida: true,
    });
  });

  it('pickup escolhido mas só dropoff oferecido ⇒ pergunta de novo, só com o dropoff', () => {
    expect(
      escolherModoDeEnvio(parametro({ info_needed: { dropoff: [] } }), escolhaColeta('5', null)),
    ).toStrictEqual({
      tipo: 'pergunta',
      enderecos: [],
      permiteDropoff: true,
      escolhaInvalida: true,
    });
  });

  it('dropoff escolhido com várias agências ⇒ a postagem NÃO é oferecida: pergunta de novo, só com o pickup (review 2, F2)', () => {
    // Before F2 this answer was a 409 `agencia-precisa-escolha` — for an option
    // the question itself had offered. The dropoff is not buildable here, so a
    // dropoff answer no longer matches anything this read offers: it is stale,
    // re-asked with the one side that CAN ship — never shipped as the pickup
    // in silence.
    const p = parametro({
      info_needed: { pickup: ['address_id'], dropoff: ['branch_id'] },
      pickup: { address_list: [endereco(5, [COLETA])] },
      dropoff: { branch_list: [{ branch_id: 1 }, { branch_id: 2 }] },
    });
    expect(escolherModoDeEnvio(p, ESCOLHA_POSTAGEM)).toStrictEqual({
      tipo: 'pergunta',
      enderecos: [
        {
          id: '5',
          rotulo: 'Rua do Vendedor, 100, Centro, Cidade do Vendedor, SP, 00000-000',
          principal: false,
          horarios: [],
        },
      ],
      permiteDropoff: false,
      escolhaInvalida: true,
    });
  });

  it('dropoff escolhido com várias agências e NADA para perguntar ⇒ a recusa da postagem', () => {
    const p = parametro({
      info_needed: { pickup: ['address_id'], dropoff: ['branch_id'] },
      pickup: { address_list: [endereco(5, [PADRAO])] },
      dropoff: { branch_list: [{ branch_id: 1 }, { branch_id: 2 }] },
    });
    expect(escolherModoDeEnvio(p, ESCOLHA_POSTAGEM)).toStrictEqual(recusa('agenciaPrecisaEscolha'));
  });

  it('pickup escolhido num pickup que não se constrói ⇒ pergunta de novo, só com a postagem', () => {
    const p = parametro({
      info_needed: { pickup: ['address_id', 'tracking_number'], dropoff: [] },
      pickup: { address_list: [endereco(5, [COLETA]), endereco(6, [COLETA])] },
    });
    expect(escolherModoDeEnvio(p, escolhaColeta('5', null))).toStrictEqual({
      tipo: 'pergunta',
      enderecos: [],
      permiteDropoff: true,
      escolhaInvalida: true,
    });
  });
});

describe('escolherModoDeEnvio — só se oferece o que o servidor consegue enviar (review 2, F2)', () => {
  const agencia = (id: number) => ({ branch_id: id, city: 'Cidade', address: 'Agência' });

  it('sonda (a): um endereço sem horário + 2 agências ⇒ o PICKUP, decidido sem pergunta', () => {
    const p = parametro({
      info_needed: { pickup: ['address_id'], dropoff: ['branch_id'] },
      pickup: { address_list: [endereco(5, [COLETA])] },
      dropoff: { branch_list: [agencia(31), agencia(32)] },
    });
    expect(escolherModoDeEnvio(p, null)).toStrictEqual({
      tipo: 'corpo',
      corpo: { modo: 'pickup', pickup: { addressId: 5 } },
    });
  });

  it('sonda (b): um pickup que pede tracking_number + dropoff [] ⇒ a POSTAGEM, decidida sem pergunta', () => {
    const p = parametro({
      info_needed: { pickup: ['address_id', 'tracking_number'], dropoff: [] },
      pickup: { address_list: [endereco(5, [COLETA]), endereco(6, [COLETA])] },
    });
    expect(escolherModoDeEnvio(p, null)).toStrictEqual({
      tipo: 'corpo',
      corpo: { modo: 'dropoff', dropoff: {} },
    });
  });

  it('sem endereço de coleta elegível + dropoff [] ⇒ a POSTAGEM, nunca uma pergunta sem endereço', () => {
    const p = parametro({
      info_needed: { pickup: ['address_id'], dropoff: [] },
      pickup: { address_list: [endereco(5, [PADRAO])] },
    });
    expect(escolherModoDeEnvio(p, null)).toStrictEqual({
      tipo: 'corpo',
      corpo: { modo: 'dropoff', dropoff: {} },
    });
  });

  it('um pickup que ainda PEDE escolha (2 endereços) + uma postagem que não se constrói ⇒ pergunta SEM postagem', () => {
    const p = parametro({
      info_needed: { pickup: ['address_id'], dropoff: ['branch_id'] },
      pickup: { address_list: [endereco(5, [COLETA]), endereco(6, [COLETA])] },
      dropoff: { branch_list: [agencia(31), agencia(32)] },
    });
    const modo = escolherModoDeEnvio(p, null);
    expect(modo).toMatchObject({ tipo: 'pergunta', permiteDropoff: false, escolhaInvalida: false });
    if (modo.tipo !== 'pergunta') throw new Error('esperava pergunta');
    expect(modo.enderecos.map((e) => e.id)).toStrictEqual(['5', '6']);
  });

  it('near-miss: os DOIS construíveis (1 endereço, 1 agência) ⇒ ainda uma pergunta, com os dois', () => {
    const p = parametro({
      info_needed: { pickup: ['address_id'], dropoff: ['branch_id'] },
      pickup: { address_list: [endereco(5, [COLETA])] },
      dropoff: { branch_list: [agencia(31)] },
    });
    const modo = escolherModoDeEnvio(p, null);
    expect(modo).toMatchObject({ tipo: 'pergunta', permiteDropoff: true, escolhaInvalida: false });
    if (modo.tipo !== 'pergunta') throw new Error('esperava pergunta');
    expect(modo.enderecos.map((e) => e.id)).toStrictEqual(['5']);
    // And each offered option ships as answered.
    expect(escolherModoDeEnvio(p, ESCOLHA_POSTAGEM)).toStrictEqual({
      tipo: 'corpo',
      corpo: { modo: 'dropoff', dropoff: { branchId: 31 } },
    });
    expect(escolherModoDeEnvio(p, escolhaColeta('5', null))).toStrictEqual({
      tipo: 'corpo',
      corpo: { modo: 'pickup', pickup: { addressId: 5 } },
    });
  });

  it.each([
    [
      'pickup pede tracking_number + várias agências',
      { pickup: ['address_id', 'tracking_number'], dropoff: ['branch_id'] },
      [endereco(5, [COLETA])],
      [agencia(31), agencia(32)],
      'agenciaPrecisaEscolha',
    ],
    [
      'sem endereço de coleta + dropoff pedindo sender_real_name',
      { pickup: ['address_id'], dropoff: ['sender_real_name'] },
      [endereco(5, [PADRAO])],
      [agencia(31)],
      'modoNaoSuportado',
    ],
  ] as const)(
    'nenhum construível (%s) ⇒ a recusa da POSTAGEM, a preferida quando os dois vieram',
    (_nome, info_needed, enderecos, agencias, chave) => {
      const p = parametro({
        info_needed,
        pickup: { address_list: enderecos },
        dropoff: { branch_list: agencias },
      });
      expect(escolherModoDeEnvio(p, null)).toStrictEqual(recusa(chave));
      // A stale answer on either side meets the same refusal — never a question.
      expect(escolherModoDeEnvio(p, ESCOLHA_POSTAGEM)).toStrictEqual(recusa(chave));
      expect(escolherModoDeEnvio(p, escolhaColeta('5', null))).toStrictEqual(recusa(chave));
    },
  );

  it('nenhum construível, só UM lado oferecido ⇒ a recusa DESSE lado', () => {
    expect(
      escolherModoDeEnvio(
        soColeta([endereco(5, [COLETA])], ['address_id', 'tracking_number']),
        null,
      ),
    ).toStrictEqual(recusa('modoNaoSuportado'));
    expect(
      escolherModoDeEnvio(
        parametro({
          info_needed: { dropoff: ['branch_id'] },
          dropoff: { branch_list: [agencia(31), agencia(32)] },
        }),
        null,
      ),
    ).toStrictEqual(recusa('agenciaPrecisaEscolha'));
  });

  it('invariante: toda pergunta carrega ao menos UMA opção que o servidor envia', () => {
    const itensColeta = [['address_id'], ['address_id', 'tracking_number'], null] as const;
    const itensPostagem = [[], ['branch_id'], ['sender_real_name'], null] as const;
    const enderecosDoMundo = [
      [],
      [endereco(5, [COLETA])],
      [endereco(5, [COLETA]), endereco(6, [COLETA])],
    ];
    const agenciasDoMundo = [[agencia(31)], [agencia(31), agencia(32)]];
    const respostas: (EscolhaDeEnvio | null)[] = [null, ESCOLHA_POSTAGEM, escolhaColeta('9', null)];
    let perguntas = 0;
    for (const pickup of itensColeta) {
      for (const dropoff of itensPostagem) {
        for (const address_list of enderecosDoMundo) {
          for (const branch_list of agenciasDoMundo) {
            const p = parametro({
              info_needed: { pickup, dropoff },
              pickup: { address_list },
              dropoff: { branch_list },
            });
            for (const escolha of respostas) {
              const modo = escolherModoDeEnvio(p, escolha);
              if (modo.tipo !== 'pergunta') continue;
              perguntas += 1;
              // The web's `.refine`: no address ⇒ the dropoff is offered.
              expect(modo.enderecos.length > 0 || modo.permiteDropoff).toBe(true);
              // And every offered option ships when answered.
              if (modo.permiteDropoff) {
                expect(escolherModoDeEnvio(p, ESCOLHA_POSTAGEM).tipo).toBe('corpo');
              }
              for (const e of modo.enderecos) {
                const h = e.horarios[0]?.id ?? null;
                expect(escolherModoDeEnvio(p, escolhaColeta(e.id, h)).tipo).toBe('corpo');
              }
            }
          }
        }
      }
    }
    expect(perguntas).toBeGreaterThan(0); // the sweep really reached questions
  });
});

describe('escolherModoDeEnvio — o rótulo é o texto do PRÓPRIO vendedor', () => {
  it('monta o rótulo dos campos do endereço e nunca lê uma chave passthrough', () => {
    const p = soColeta([
      endereco(5, [COLETA], [horario('h1', null, { comprador: 'MARCADOR-PII' }), horario('h2')], {
        recipient_name: 'MARCADOR-PII',
        phone: 'MARCADOR-PII',
      }),
    ]);
    const modo = escolherModoDeEnvio(p, null);
    if (modo.tipo !== 'pergunta') throw new Error('esperava pergunta');
    expect(modo.enderecos[0]?.rotulo).toBe(
      'Rua do Vendedor, 100, Centro, Cidade do Vendedor, SP, 00000-000',
    );
    expect(JSON.stringify(modo)).not.toContain('MARCADOR-PII');
  });

  it('a data do horário no fuso do operador, EXPLÍCITO (near-miss: em UTC seria outro dia)', () => {
    // 2026-10-01 02:00 UTC = 2026-09-30 23:00 in São Paulo.
    const segundos = Date.UTC(2026, 9, 1, 2, 0, 0) / 1000;
    const p = soColeta([
      endereco(5, [COLETA], [horario('h1', null, { date: segundos }), horario('h2')]),
    ]);
    const modo = escolherModoDeEnvio(p, null);
    if (modo.tipo !== 'pergunta') throw new Error('esperava pergunta');
    expect(modo.enderecos[0]?.horarios[0]?.rotulo).toBe('30/09/2026 · 09:00-12:00');
  });

  it('sem texto utilizável ⇒ o rótulo cai no id (o "-" da Shopee não é texto)', () => {
    const vazio = { address: '-', town: '', district: ' ', city: null, state: '', zipcode: '' };
    const p = soColeta([
      endereco(
        5,
        [COLETA],
        [horario('h1', null, { date: 0, time_text: '-' }), horario('h2')],
        vazio,
      ),
    ]);
    const modo = escolherModoDeEnvio(p, null);
    if (modo.tipo !== 'pergunta') throw new Error('esperava pergunta');
    expect(modo.enderecos[0]?.rotulo).toBe('Endereço 5');
    expect(modo.enderecos[0]?.horarios[0]?.rotulo).toBe('Horário h1');
  });
});

describe('escolherModoDeEnvio — a flag de coleta casa EXATA (review 1, mutante 35)', () => {
  // `address_flag` is free strings on the wire (`types.ts`): nothing upstream
  // narrows a flag that merely CONTAINS `pickup_address`.
  it('o par: exatamente pickup_address ⇒ elegível', () => {
    expect(escolherModoDeEnvio(soColeta([endereco(5, [COLETA])]), null)).toStrictEqual({
      tipo: 'corpo',
      corpo: { modo: 'pickup', pickup: { addressId: 5 } },
    });
  });

  it.each(['pickup_address_x', ' pickup_address', 'pickup_address ', 'not_pickup_address'])(
    'near-miss: a flag %j só CONTÉM pickup_address ⇒ não elegível',
    (flag) => {
      expect(flag).toContain(COLETA); // the substring is really there
      expect(escolherModoDeEnvio(soColeta([endereco(5, [flag, PADRAO])]), null)).toStrictEqual(
        recusa('semEnderecoDeColeta'),
      );
    },
  );
});

describe('escolherModoDeEnvio — pura', () => {
  it('não muda a entrada e responde igual duas vezes', () => {
    const p = soColeta([
      endereco(5, [COLETA], [horario('h1'), horario('h2')]),
      endereco(6, [COLETA]),
    ]);
    const antes = JSON.stringify(p);
    const a = escolherModoDeEnvio(p, escolhaColeta('5', 'h2'));
    const b = escolherModoDeEnvio(p, escolhaColeta('5', 'h2'));
    expect(a).toStrictEqual(b);
    expect(JSON.stringify(p)).toBe(antes);
  });
});
