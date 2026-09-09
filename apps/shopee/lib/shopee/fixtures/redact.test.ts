import { describe, expect, it } from 'vitest';

import {
  REDACTED_PATH_SUFFIXES,
  type WireValue,
  ehValorMascarado,
  isRedactedPath,
  placeholderFor,
  redactWireBody,
} from './redact';

/**
 * An UNREDACTED body, in the shape `get_order_detail` really answers. Every
 * personal value here is invented — see the ⚠️ on each one.
 */
const CRU: WireValue = {
  response: {
    order_list: [
      {
        order_sn: '220810QSK8S7BX',
        region: 'BR',
        // ⚠️ Nome/CPF/telefone/endereço INVENTADOS. O CPF é sintético (dígitos
        // verificadores válidos, valor obviamente falso).
        buyer_cpf_id: '12345678909',
        buyer_username: 'comprador_inventado',
        buyer_user_id: 102429130,
        message_to_seller: 'Entregar de manhã, falar com Joana',
        note: 'cliente antigo',
        cancel_reason: 'BACKEND_LOGISTICS_NOT_STARTED',
        recipient_address: {
          name: 'Joana Inventada',
          phone: '11987654321',
          town: 'Centro',
          district: 'Bela Vista',
          city: 'São Paulo',
          state: 'SP',
          region: 'BR',
          zipcode: '01310100',
          full_address: 'Avenida Paulista, 1000, Bela Vista',
          geolocation: { latitude: -23.567851, longitude: -46.6912611, precisao: 'alta' },
        },
        payment_info: [
          {
            payment_method: 'Pix',
            payment_processor_register: '38372267000182',
            card_brand: '',
            transaction_id: '951679',
            payment_amount: 31.99,
          },
        ],
        invoice_data: { number: '123', access_key: '3'.repeat(44) },
        item_list: [
          {
            item_id: 846056136,
            item_name: 'Camiseta de algodão',
            model_name: 'Preta, M',
            image_info: { image_url: 'https://cf.shopee.com.br/file/br-1234-abcd_tn' },
          },
        ],
      },
    ],
  },
};

describe('redactWireBody', () => {
  it('redige toda folha pessoal e deixa o resto intocado', () => {
    const limpo = redactWireBody(CRU) as never;
    const linha = (limpo as { response: { order_list: Record<string, never>[] } }).response
      .order_list[0]!;
    const endereco = linha.recipient_address as unknown as Record<string, unknown>;

    expect(endereco.name).toBe('REDACTED');
    expect(endereco.phone).toBe('00000000000');
    expect(endereco.full_address).toBe('Rua Redacted, 0');
    expect(endereco.zipcode).toBe('00000000');
    expect(endereco.town).toBe('REDACTED');
    expect(endereco.district).toBe('REDACTED');
    expect(endereco.city).toBe('REDACTED');
    expect((linha as unknown as Record<string, unknown>).buyer_cpf_id).toBe('00000000000');
    expect((linha as unknown as Record<string, unknown>).buyer_username).toBe('REDACTED');
    expect((linha as unknown as Record<string, unknown>).buyer_user_id).toBe(0);
    expect((linha as unknown as Record<string, unknown>).message_to_seller).toBe('REDACTED');
    expect((linha as unknown as Record<string, unknown>).note).toBe('REDACTED');
    expect((linha as unknown as Record<string, unknown>).cancel_reason).toBe('REDACTED');

    // ⚠️ NEAR-MISS, e é o desenho inteiro: o denylist é por SUFIXO de caminho.
    // `recipient_address.name` some; `item_name`, `model_name`, `state` e
    // `region` — que é o sinal de estrangeiro — FICAM.
    expect(endereco.state).toBe('SP');
    expect(endereco.region).toBe('BR');
    expect((linha as unknown as Record<string, unknown>).region).toBe('BR');
    expect((linha as unknown as Record<string, unknown>).order_sn).toBe('220810QSK8S7BX');
    const item = (linha as unknown as { item_list: Record<string, unknown>[] }).item_list[0]!;
    expect(item.item_name).toBe('Camiseta de algodão');
    expect(item.model_name).toBe('Preta, M');
    expect(item.item_id).toBe(846_056_136);
    expect((item.image_info as Record<string, unknown>).image_url).toBe(
      'https://redacted.invalid/imagem',
    );
  });

  it('a geolocation some INTEIRA, inclusive uma chave que o denylist não previu', () => {
    const limpo = redactWireBody(CRU) as unknown as {
      response: { order_list: { recipient_address: { geolocation: Record<string, unknown> } }[] };
    };
    const geo = limpo.response.order_list[0]!.recipient_address.geolocation;
    expect(geo.latitude).toBe(0);
    expect(geo.longitude).toBe(0);
    // ⚠️ `precisao` não está em sufixo nenhum: quem a apaga é o denylist de
    // SUBÁRVORE, que existe exatamente para a chave que ninguém previu.
    expect(geo.precisao).toBe('REDACTED');
  });

  it('preserva o TIPO de cada folha — um número vira número, um booleano vira booleano', () => {
    // ⚠️ Uma fixture existe para prender uma FORMA. Trocar um número por
    // 'REDACTED' reescreve justamente o que ela foi gravada para registrar.
    const limpo = redactWireBody(CRU) as unknown as {
      response: {
        order_list: {
          buyer_user_id: unknown;
          payment_info: Record<string, unknown>[];
          recipient_address: { geolocation: { latitude: unknown } };
        }[];
      };
    };
    const linha = limpo.response.order_list[0]!;
    expect(typeof linha.buyer_user_id).toBe('number');
    expect(typeof linha.recipient_address.geolocation.latitude).toBe('number');
    expect(typeof linha.payment_info[0]!.payment_processor_register).toBe('string');
    // O que NÃO está no denylist mantém o valor e o tipo.
    expect(linha.payment_info[0]!.payment_amount).toBe(31.99);
    expect(linha.payment_info[0]!.payment_method).toBe('Pix');
  });

  it('é IDEMPOTENTE — redigir de novo não muda nada (é o ponto fixo que o piiScan usa)', () => {
    const uma = redactWireBody(CRU);
    const duas = redactWireBody(uma);
    expect(duas).toEqual(uma);
    // Três vezes também, porque "estável na segunda" já bastaria para um
    // placeholder que dependesse do VALOR e alternasse.
    expect(redactWireBody(duas)).toEqual(uma);
  });

  it('mantém um valor JÁ MASCARADO pela Shopee, nas duas grafias', () => {
    // ⚠️ `"****"` (sandbox SG) e `P******n` (exemplo VN) não carregam nada e SÃO
    // a evidência que `valorUtilizavel` precisa recusar. Trocá-los por um
    // placeholder plausível apagaria a prova de que a máscara tem duas formas.
    const corpo: WireValue = {
      recipient_address: { name: '****', phone: '******64', full_address: 'Ấp******' },
    };
    expect(redactWireBody(corpo)).toEqual(corpo);
    expect(ehValorMascarado('****')).toBe(true);
    expect(ehValorMascarado('P******n')).toBe(true);
    // NEAR-MISS: um nome de verdade não tem estrela e É redigido.
    expect(ehValorMascarado('Joana Inventada')).toBe(false);
    expect(
      (
        redactWireBody({ recipient_address: { name: 'Joana Inventada' } }) as never as {
          recipient_address: { name: string };
        }
      ).recipient_address.name,
    ).toBe('REDACTED');
  });

  it('mantém o VAZIO vazio — "vazio por região" é um fato do fio, não uma ausência de dado', () => {
    const corpo: WireValue = {
      recipient_address: { town: '', district: '', city: '', zipcode: '' },
    };
    expect(redactWireBody(corpo)).toEqual(corpo);
  });

  it('null continua null — materializá-lo destruiria a distinção ausente/nulo', () => {
    const corpo: WireValue = { buyer_cpf_id: null, recipient_address: null, invoice_data: null };
    expect(redactWireBody(corpo)).toEqual(corpo);
  });

  it('atravessa arrays e casa o sufixo em qualquer profundidade', () => {
    expect(isRedactedPath(['response', 'order_list', '*', 'recipient_address', 'name'])).toBe(true);
    expect(isRedactedPath(['response', 'order_list', '*', 'item_list', '*', 'item_name'])).toBe(
      false,
    );
    // ⚠️ NEAR-MISS: `name` sozinho NÃO é caminho redigido — é `item_name`'s
    // vizinho em metade das respostas da Shopee.
    expect(isRedactedPath(['name'])).toBe(false);
    expect(isRedactedPath(['recipient_address', 'name'])).toBe(true);
  });

  it('todo sufixo do denylist é um caminho que ele mesmo reconhece', () => {
    // Âncora anti-vacuidade: sem ela, uma entrada com erro de digitação ficaria
    // no denylist para sempre sem nunca casar com nada.
    for (const sufixo of REDACTED_PATH_SUFFIXES) {
      expect(isRedactedPath(['response', 'order_list', '*', ...sufixo]), sufixo.join('.')).toBe(
        true,
      );
    }
    expect(REDACTED_PATH_SUFFIXES.length).toBeGreaterThanOrEqual(18);
  });

  it('o placeholder sai da CHAVE e do TIPO, nunca do valor — é isso que dá a idempotência', () => {
    expect(placeholderFor('zipcode', '01310100')).toBe('00000000');
    expect(placeholderFor('zipcode', '99999999')).toBe('00000000');
    expect(placeholderFor('buyer_cpf_id', '12345678909')).toHaveLength(11);
    expect(placeholderFor('payment_processor_register', '38372267000182')).toHaveLength(14);
    expect(placeholderFor('access_key', '3'.repeat(44))).toHaveLength(44);
    expect(placeholderFor('qualquer_coisa', 42)).toBe(0);
    expect(placeholderFor('qualquer_coisa', true)).toBe(false);
  });
});
