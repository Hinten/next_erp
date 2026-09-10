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
 * The smallest body whose WALK path ends with `sufixo` — an `*` segment becomes
 * a real one-element array, which is the whole point: the walker pushes `'*'`
 * for every array level, so a suffix whose parent is an array can only be
 * exercised through a body that actually has one.
 */
function corpoParaSufixo(sufixo: readonly string[], folha: WireValue): WireValue {
  let atual: WireValue = folha;
  for (let i = sufixo.length - 1; i >= 0; i -= 1) {
    const segmento = sufixo[i]!;
    atual = segmento === '*' ? [atual] : { [segmento]: atual };
  }
  return { response: { order_list: [atual] } };
}

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

    // ⚠️ `payment_info` is an ARRAY, so the walker's path carries an index and a
    // two-segment `['payment_info', <leaf>]` entry matches NOTHING. Asserting the
    // VALUE (not the type) is what catches that: a `typeof === 'string'` check
    // passes on the leaked CNPJ just as happily as on the placeholder.
    const pagamento = (linha as unknown as { payment_info: Record<string, unknown>[] })
      .payment_info[0]!;
    expect(pagamento.payment_processor_register).toBe('00000000000000');
    expect(pagamento.transaction_id).toBe('000000');
    // …and the near-miss: the two siblings that are NOT on the denylist keep
    // their values verbatim, so this is a suffix match and not a blanket wipe of
    // the block. (`payment_amount`/`payment_method` are asserted again in the
    // TYPE test below.)
    expect(pagamento.payment_amount).toBe(31.99);
    expect(pagamento.payment_method).toBe('Pix');

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

  it('⚠️ toda entrada do denylist REDIGE de verdade um corpo montado no seu próprio caminho', () => {
    // Âncora anti-vacuidade: sem ela, uma entrada com erro de digitação ficaria
    // no denylist para sempre sem nunca casar com nada.
    //
    // ⚠️ Ela pergunta ao CONSUMIDOR — `redactWireBody` — e não ao matcher: cada
    // entrada vira o menor corpo cujo caminho de walk termina naquele sufixo,
    // com um ARRAY de verdade onde o sufixo diz `*`, e a folha tem de sair
    // diferente. A versão anterior comparava o sufixo consigo mesmo através do
    // `isRedactedPath` e por isso não conseguia dizer NADA sobre um pai que é
    // array; quem cobre esse eixo é o par de testes abaixo (a grafia curta) e a
    // asserção de VALOR sobre `payment_info` no primeiro teste deste arquivo,
    // que roda sobre o corpo real.
    const SENTINELA = 'VALOR-QUE-NAO-PODE-SOBREVIVER';
    for (const sufixo of REDACTED_PATH_SUFFIXES) {
      const corpo = corpoParaSufixo(sufixo, SENTINELA);
      expect(JSON.stringify(redactWireBody(corpo)), sufixo.join('.')).not.toContain(SENTINELA);
      // …e o caminho que o walk realmente produz é reconhecido pelo matcher.
      expect(isRedactedPath(['response', 'order_list', '*', ...sufixo]), sufixo.join('.')).toBe(
        true,
      );
    }
    expect(REDACTED_PATH_SUFFIXES.length).toBeGreaterThanOrEqual(18);
  });

  it('⚠️ NEAR-MISS: a grafia CURTA de um sufixo de array não casa com nada', () => {
    // O casamento é segmento a segmento, sem semântica de curinga: um `*` no
    // sufixo é um segmento literal, e é exatamente o que o `walk` empilha para
    // cada nível de array. `payment_info` é `z.array(...)`, então a grafia de
    // dois segmentos — a que estava no denylist — não podia casar com o caminho
    // que o corpo real produz.
    expect(isRedactedPath(['payment_info', 'payment_processor_register'])).toBe(false);
    expect(isRedactedPath(['payment_info', 'transaction_id'])).toBe(false);
    expect(
      isRedactedPath([
        'response',
        'order_list',
        '*',
        'payment_info',
        '*',
        'payment_processor_register',
      ]),
    ).toBe(true);
    expect(
      isRedactedPath(['response', 'order_list', '*', 'payment_info', '*', 'transaction_id']),
    ).toBe(true);
    // …e o inverso, que é o que mantém os outros sufixos honestos: um pai que é
    // OBJETO não leva índice, e ganhar um passaria a não casar.
    expect(isRedactedPath(['recipient_address', '*', 'name'])).toBe(false);
    expect(isRedactedPath(['recipient_address', 'name'])).toBe(true);
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
