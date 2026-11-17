import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { patternFindings, redactionResidue, scanForPiiReprovavel } from './piiScan';
import {
  CAMINHOS_DE_SKU,
  CAMINHOS_SEM_SAIDA_MASCARADA,
  FOLHAS_DE_TEXTO_DO_ANUNCIO,
  REDACTED_PATH_SUFFIXES,
  REDACTED_SUBTREES_SEM_EXCECAO,
  type WireValue,
  chaveDaFolha,
  ehCaminhoSemSaidaMascarada,
  ehSkuSemConteudo,
  ehSubarvoreSemExcecao,
  ehValorMascarado,
  isRedactedPath,
  placeholderFor,
  redactWireBody,
} from './redact';
import { WIRE_DIR } from './wireCorpus';

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
    expect(REDACTED_PATH_SUFFIXES.length).toBeGreaterThanOrEqual(32);
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

/* -------------------------------------------------------------------------- */
/*                  Devoluções (passo 17, #1525): os dois corpos               */
/* -------------------------------------------------------------------------- */

/**
 * An UNREDACTED `get_return_detail` body, in the shape the page documents —
 * every buyer block present. ⚠️ Every personal value is INVENTED and the ids are
 * the fixture ids; the masked e-mail copies only the page's SHAPE (stars, two
 * letters, a domain), on a reserved domain.
 */
const CRU_DEVOLUCAO: WireValue = {
  error: '-',
  message: '-',
  response: {
    image: ['https://fotos.example.com/devolucao/1.jpg'],
    buyer_videos: [
      {
        thumbnail_url: 'https://videos.example.com/miniatura.jpg',
        video_url: 'https://videos.example.com/video.mp4',
      },
    ],
    reason: 'NOT_RECEIPT',
    text_reason: 'Não recebi. Falar com Joana, (11) 98765-4321',
    return_sn: '260910ABCDE0001',
    refund_amount: 13.97,
    currency: 'BRL',
    create_time: 1_655_205_084,
    update_time: 1_655_219_544,
    status: 'ACCEPTED',
    due_date: 1_655_377_883,
    tracking_number: 'RASTREIO-REVERSO-INVENTADO',
    dispute_reason: 2,
    dispute_text_reason: 'Texto do vendedor que cita a compradora Joana Inventada',
    needs_logistics: false,
    amount_before_discount: 13.99,
    user: {
      username: 'comprador_inventado',
      email: '********xy@example.com',
      portrait: 'https://fotos.example.com/perfil.jpg',
    },
    item: [
      {
        model_id: 2_000_458_802,
        name: 'Camiseta de algodão',
        images: ['https://fotos.example.com/item.jpg'],
        amount: 1,
        item_price: 10,
        item_id: 2_500_139_861,
        item_sku: 'CAM-01',
        variation_sku: 'PRETA-M',
      },
    ],
    order_sn: '260910KJBHUJDM',
    negotiation: {
      negotiation_status: 'PENDING_RESPOND',
      latest_solution: 'RETURN_REFUND',
      latest_offer_amount: 12.34,
      latest_offer_creator: 'comprador_inventado',
      counter_limit: 0,
      offer_due_date: 1_655_438_336,
    },
    seller_compensation: {
      seller_compensation_status: 'PENDING_REQUEST',
      seller_compensation_due_date: 1_655_438_336,
      compensation_amount: 100,
    },
    reverse_logistic_status: 'LOGISTICS_REQUEST_CREATED',
    return_pickup_address: {
      address: 'Rua Inventada, 100',
      name: 'Joana Inventada',
      phone: '11987654321',
      town: 'Centro',
      district: '',
      city: 'São Paulo',
      state: 'SP',
      region: 'BR',
      zipcode: '01310100',
    },
    virtual_contact_number: '0900000000',
    package_query_number: '12340000',
    return_address: { whs_id: 'SPX' },
    return_refund_type: 'RRAOC',
  },
};

/**
 * An UNREDACTED `get_return_list` page — one row. ⚠️ Invented values again; the
 * list carries `user` too, so even a list-only reader receives buyer data.
 */
const CRU_LISTA_DEVOLUCOES: WireValue = {
  error: '-',
  message: '-',
  response: {
    more: false,
    return: [
      {
        image: ['https://fotos.example.com/devolucao/2.jpg'],
        reason: 'PHYSICAL_DMG',
        text_reason: 'Chegou quebrado',
        return_sn: '2609100000000001',
        tracking_number: 'RASTREIO-REVERSO-INVENTADO-2',
        dispute_reason: ['UNKNOWN'],
        dispute_text_reason: ['Primeiro texto do vendedor', 'Segundo texto'],
        user: {
          username: 'outro_comprador_inventado',
          email: '***********z1@example.com',
          portrait: 'https://fotos.example.com/perfil-2.jpg',
        },
        order_sn: '260910KJBHUJDM',
        status: 'REQUESTED',
        negotiation_status: 'PENDING_RESPOND',
      },
    ],
  },
};

type Registro = Record<string, unknown>;

describe('redactWireBody — os blocos do comprador de uma DEVOLUÇÃO (passo 17)', () => {
  it('redige TODA folha pessoal do detalhe e deixa o resto intocado', () => {
    const limpo = (redactWireBody(CRU_DEVOLUCAO) as { response: Registro }).response;
    const usuario = limpo.user as Registro;
    const coleta = limpo.return_pickup_address as Registro;
    const video = (limpo.buyer_videos as Registro[])[0]!;
    const item = (limpo.item as Registro[])[0]!;
    const negociacao = limpo.negotiation as Registro;

    expect(limpo.image).toEqual(['REDACTED']);
    expect(video).toEqual({ thumbnail_url: 'REDACTED', video_url: 'REDACTED' });
    expect(limpo.text_reason).toBe('REDACTED');
    expect(limpo.dispute_text_reason).toBe('REDACTED');
    expect(limpo.tracking_number).toBe('REDACTED');
    expect(limpo.virtual_contact_number).toBe('REDACTED');
    expect(limpo.package_query_number).toBe('REDACTED');
    expect(usuario).toEqual({ username: 'REDACTED', email: 'REDACTED', portrait: 'REDACTED' });
    expect(item.images).toEqual(['REDACTED']);
    expect(negociacao.latest_offer_creator).toBe('REDACTED');
    // O endereço de coleta sai INTEIRO — até `state`/`region`, que no
    // `recipient_address` ficam: nada do ERP lê este bloco.
    expect(coleta).toEqual({
      address: 'REDACTED',
      name: 'REDACTED',
      phone: '00000000000',
      town: 'REDACTED',
      district: '',
      city: 'REDACTED',
      state: 'REDACTED',
      region: 'REDACTED',
      zipcode: '00000000',
    });

    // ⚠️ NEAR-MISS: o que o importador LÊ fica com o valor — status, motivo,
    // ids, dinheiro, prazos, o nome do PRODUTO (que não é uma pessoa) e os
    // tokens de negociação e logística reversa.
    expect(limpo.return_sn).toBe('260910ABCDE0001');
    expect(limpo.order_sn).toBe('260910KJBHUJDM');
    expect(limpo.status).toBe('ACCEPTED');
    expect(limpo.reason).toBe('NOT_RECEIPT');
    expect(limpo.dispute_reason).toBe(2);
    expect(limpo.refund_amount).toBe(13.97);
    expect(limpo.update_time).toBe(1_655_219_544);
    expect(limpo.due_date).toBe(1_655_377_883);
    expect(limpo.reverse_logistic_status).toBe('LOGISTICS_REQUEST_CREATED');
    expect(limpo.return_refund_type).toBe('RRAOC');
    expect((limpo.return_address as Registro).whs_id).toBe('SPX');
    expect(item.name).toBe('Camiseta de algodão');
    expect(item.item_sku).toBe('CAM-01');
    expect(item.item_id).toBe(2_500_139_861);
    expect(negociacao.negotiation_status).toBe('PENDING_RESPOND');
    expect(negociacao.latest_solution).toBe('RETURN_REFUND');
    expect(negociacao.latest_offer_amount).toBe(12.34);
    expect((limpo.seller_compensation as Registro).seller_compensation_status).toBe(
      'PENDING_REQUEST',
    );
  });

  it('⚠️ e-mail MASCARADO sob `user` é SUBSTITUÍDO; nome mascarado no `recipient_address` FICA', () => {
    // O par que separa as duas saídas. A máscara de `user.email` ainda carrega
    // um domínio e duas letras — o padrão de e-mail do piiScan lê isso como
    // vazamento, e nada do ERP lê esse bloco. A do destinatário do PEDIDO é a
    // evidência que `valorUtilizavel` precisa recusar, e continua intocada.
    const devolucao = redactWireBody({
      user: { email: '********xy@example.com', username: 'c****o' },
      return_pickup_address: { name: 'J****a', phone: '******64' },
    }) as { user: Registro; return_pickup_address: Registro };
    expect(devolucao.user).toEqual({ email: 'REDACTED', username: 'REDACTED' });
    expect(devolucao.return_pickup_address).toEqual({ name: 'REDACTED', phone: '00000000000' });

    const pedido: WireValue = {
      recipient_address: { name: 'J****a', phone: '******64', full_address: 'Ấp******' },
    };
    expect(redactWireBody(pedido)).toEqual(pedido);
    expect(ehSubarvoreSemExcecao(['response', 'user', 'email'])).toBe(true);
    expect(ehSubarvoreSemExcecao(['response', 'recipient_address', 'name'])).toBe(false);
  });

  it('`dispute_text_reason` sai nas DUAS grafias — string no detalhe, string[] na lista', () => {
    const detalhe = (redactWireBody(CRU_DEVOLUCAO) as { response: Registro }).response;
    expect(detalhe.dispute_text_reason).toBe('REDACTED');
    const linha = (redactWireBody(CRU_LISTA_DEVOLUCOES) as { response: { return: Registro[] } })
      .response.return[0]!;
    expect(linha.dispute_text_reason).toEqual(['REDACTED', 'REDACTED']);
    // …e o resto da linha da lista, do mesmo jeito que o detalhe.
    expect(linha.text_reason).toBe('REDACTED');
    expect(linha.tracking_number).toBe('REDACTED');
    expect(linha.image).toEqual(['REDACTED']);
    expect(linha.user).toEqual({ username: 'REDACTED', email: 'REDACTED', portrait: 'REDACTED' });
    // NEAR-MISS: `dispute_reason` é um TOKEN da Shopee, nunca prosa.
    expect(linha.dispute_reason).toEqual(['UNKNOWN']);
    expect(linha.return_sn).toBe('2609100000000001');
    expect(linha.negotiation_status).toBe('PENDING_RESPOND');
  });

  it('o `tracking_number` redigido é o da DEVOLUÇÃO — o de um pacote do pedido fica', () => {
    // ⚠️ NEAR-MISS do "com o pai, de propósito": um `tracking_number` de pacote
    // do pedido (ida) não é o da logística reversa e não casa com nenhum sufixo.
    expect(isRedactedPath(['response', 'tracking_number'])).toBe(true);
    expect(isRedactedPath(['response', 'return', '*', 'tracking_number'])).toBe(true);
    expect(
      isRedactedPath(['response', 'order_list', '*', 'package_list', '*', 'tracking_number']),
    ).toBe(false);
    // …e o `name` de um ITEM da devolução é um produto, não uma pessoa.
    expect(isRedactedPath(['response', 'item', '*', 'name'])).toBe(false);
  });

  it('é IDEMPOTENTE sobre os dois corpos de devolução — o ponto fixo que o piiScan usa', () => {
    for (const cru of [CRU_DEVOLUCAO, CRU_LISTA_DEVOLUCOES]) {
      const uma = redactWireBody(cru);
      expect(redactWireBody(uma)).toEqual(uma);
      expect(redactWireBody(redactWireBody(uma))).toEqual(uma);
    }
  });

  it('⚠️ o piiScan aprova os dois corpos REDIGIDOS — e reprova os crus', () => {
    // Âncora do sentido inverso: se o cru também passasse, "nenhum achado" seria
    // uma frase sobre o scanner e não sobre a redação.
    for (const cru of [CRU_DEVOLUCAO, CRU_LISTA_DEVOLUCOES]) {
      expect(scanForPiiReprovavel(redactWireBody(cru))).toEqual([]);
      expect(scanForPiiReprovavel(cru).length).toBeGreaterThan(0);
    }
    // E o achado que a máscara de `user.email` produziria se SOBREVIVESSE é
    // exatamente o de e-mail, no caminho dele — o motivo de a saída mascarada
    // fechar ali (`masked` sozinho é informativo e não reprova).
    expect(
      patternFindings({ user: { email: '********xy@example.com' } }).filter(
        (f) => f.kind !== 'masked',
      ),
    ).toEqual([{ path: 'user.email', kind: 'email' }]);
  });

  it('⚠️ toda subárvore SEM EXCEÇÃO redige uma chave imprevista, máscara incluída — e mantém o vazio', () => {
    // Âncora anti-vacuidade da lista nova: cada segmento vira um corpo real, com
    // uma folha MASCARADA (a saída que esta lista fecha), um número, um booleano
    // e uma string vazia sob uma chave que nenhum denylist previu.
    const SENTINELA = 'VALOR*MASCARADO*QUE-NAO-PODE-SOBREVIVER';
    for (const segmento of REDACTED_SUBTREES_SEM_EXCECAO) {
      const corpo: WireValue = {
        response: {
          [segmento]: { chave_imprevista: SENTINELA, numero: 42, ativo: true, vazio: '' },
        },
      };
      const limpo = (redactWireBody(corpo) as { response: Record<string, Registro> }).response[
        segmento
      ]!;
      expect(limpo, segmento).toEqual({
        chave_imprevista: 'REDACTED',
        numero: 0,
        ativo: false,
        vazio: '',
      });
    }
    expect([...REDACTED_SUBTREES_SEM_EXCECAO].sort()).toEqual([
      'buyer_videos',
      'return_pickup_address',
      'user',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*          As páginas de LEITURA de anúncio (#1911): as capturas BR          */
/* -------------------------------------------------------------------------- */

/**
 * An UNREDACTED `get_item_base_info` page, in the shape the BR production read
 * answers. ⚠️ Every value is INVENTED — the title, the description, the SKU,
 * the URLs — and the ids are the corpus's fixture ids. The `imagem-redigida`
 * strings are the BR capture script's OWN placeholder, which this module keeps.
 */
const CRU_ANUNCIO: WireValue = {
  error: '',
  message: '',
  warning: '',
  response: {
    item_list: [
      {
        item_id: 2_500_139_861,
        category_id: 100_244,
        item_name: 'Camiseta Inventada da Loja Inventada',
        description: 'Descrição inventada que cita a Loja Inventada e o seu endereço.',
        description_type: 'normal',
        item_sku: 'CAM-PRETA-M',
        image: {
          image_id_list: ['imagem-redigida'],
          image_url_list: ['https://cf.shopee.com.br/file/br-inventada-1'],
        },
        promotion_image: {
          image_id_list: ['imagem-redigida'],
          image_url_list: ['https://cf.shopee.com.br/file/br-inventada-2'],
        },
        size_chart: 'https://cf.shopee.com.br/file/br-tabela-inventada',
        size_chart_id: 0,
        video_info: [
          {
            video_url: 'https://video.shopee.com.br/inventado.mp4',
            thumbnail_url: 'https://cf.shopee.com.br/file/br-miniatura-inventada',
            duration: 12,
          },
        ],
      },
    ],
  },
};

/**
 * A SKU in the SHAPE of the BR capture script's keyed pseudonym (`SKU-` + eight
 * lowercase hex) — ⚠️ INVENTED, never a committed one. A test that pins the
 * pseudonym exit needs a value of that shape, and copying one out of a `.br-`
 * body would put a capture value in a test (it did, once: #1911's review). The
 * `inventado de verdade` test below reds the day this constant matches anything
 * in `__wire__/`.
 */
const PSEUDONIMO_INVENTADO = 'SKU-c0ffee42';

/**
 * An UNREDACTED `get_model_list` page — the two tier spellings and three models.
 * ⚠️ Invented values (the pseudonym-shaped SKU is {@link PSEUDONIMO_INVENTADO});
 * `101054`/`101056` and the group id are public taxonomy, and `LOCAL-REDIGIDO`
 * is the capture script's placeholder.
 */
const CRU_MODELOS: WireValue = {
  error: '',
  message: '',
  response: {
    tier_variation: [
      {
        name: 'Cor',
        option_list: [
          {
            option: 'Preto',
            image: {
              image_id: 'imagem-redigida',
              image_url: 'https://cf.shopee.com.br/file/br-opcao-inventada',
            },
          },
        ],
      },
    ],
    standardise_tier_variation: [
      {
        variation_id: 101_054,
        variation_name: 'Cor',
        variation_option_list: [
          {
            variation_option_id: 0,
            variation_option_name: 'Preto',
            image_id: 'imagem-redigida',
            image_url: 'https://cf.shopee.com.br/file/br-opcao-padrao-inventada',
          },
        ],
      },
      { variation_id: 101_056, variation_group_id: 844_758_844_060_204, variation_name: 'Tamanho' },
    ],
    model: [
      {
        model_id: 2_000_458_802,
        model_sku: 'AZUL-P',
        tier_index: [0],
        stock_info_v2: { seller_stock: [{ location_id: 'LOCAL-REDIGIDO', stock: 3 }] },
      },
      { model_id: 2_000_458_803, model_sku: PSEUDONIMO_INVENTADO, tier_index: [1] },
      { model_id: 2_000_458_804, model_sku: 'SONDA-KIT-M1', tier_index: [2] },
    ],
  },
};

type LinhaDoAnuncio = Registro & {
  image: Registro;
  promotion_image: Registro;
  video_info: Registro[];
};

interface ModelosRedigidos {
  tier_variation: { option_list: { image: Registro }[] }[];
  standardise_tier_variation: { variation_option_list?: Registro[] }[];
  model: Registro[];
}

function anuncioRedigido(cru: WireValue = CRU_ANUNCIO): LinhaDoAnuncio {
  return (redactWireBody(cru) as { response: { item_list: LinhaDoAnuncio[] } }).response
    .item_list[0]!;
}

function modelosRedigidos(): ModelosRedigidos {
  return (redactWireBody(CRU_MODELOS) as unknown as { response: ModelosRedigidos }).response;
}

/** The smallest `get_item_base_info` page with ONE leaf at `item_list[0][chave]`. */
function anuncioCom(chave: string, valor: WireValue): WireValue {
  return { response: { item_list: [{ [chave]: valor }] } };
}

function skuDoAnuncio(sku: string): unknown {
  return anuncioRedigido(anuncioCom('item_sku', sku)).item_sku;
}

/** The SKU of the smallest `get_model_list` page with ONE `model_sku`, redacted. */
function skuDoModelo(sku: string): unknown {
  const limpo = redactWireBody({ response: { model: [{ model_sku: sku }] } });
  return (limpo as { response: { model: Registro[] } }).response.model[0]!.model_sku;
}

describe('redactWireBody — as páginas de LEITURA de anúncio (#1911)', () => {
  it('o TÍTULO do anúncio sai — `response.item_list.*.item_name`, QUATRO segmentos', () => {
    expect(anuncioRedigido().item_name).toBe('REDACTED');
    expect(isRedactedPath(['response', 'item_list', '*', 'item_name'])).toBe(true);
  });

  it('⚠️ NEAR-MISS: o título da LINHA DO PEDIDO, o do KIT e o do PUSH ficam', () => {
    // Por isso são QUATRO segmentos: `['item_list', '*', 'item_name']` casaria a
    // linha do pedido — dado do PEDIDO, que a importação leva a `nomeDeVenda`.
    const pedido = (
      redactWireBody(CRU) as { response: { order_list: { item_list: Registro[] }[] } }
    ).response.order_list[0]!.item_list[0]!;
    expect(pedido.item_name).toBe('Camiseta de algodão');

    const kit = (
      redactWireBody({
        response: {
          product_info: { item_name: 'Kit inventado', description: 'Descrição do kit inventada' },
        },
      }) as { response: { product_info: Registro } }
    ).response.product_info;
    expect(kit).toEqual({ item_name: 'Kit inventado', description: 'Descrição do kit inventada' });

    const push = (
      redactWireBody({ code: 16, data: { item_id: 2_500_139_861, item_name: 'Título' } }) as {
        data: Registro;
      }
    ).data;
    expect(push.item_name).toBe('Título');

    expect(isRedactedPath(['response', 'order_list', '*', 'item_list', '*', 'item_name'])).toBe(
      false,
    );
    expect(isRedactedPath(['response', 'product_info', 'item_name'])).toBe(false);
    expect(isRedactedPath(['data', 'item_name'])).toBe(false);
    // Um `item_list` que não pende de `response` também não é a página de leitura.
    expect(isRedactedPath(['data', 'item_list', '*', 'item_name'])).toBe(false);
  });

  it('D-3 PAR: a DESCRIÇÃO do anúncio sai — e o placeholder do script de captura vira `REDACTED`', () => {
    expect(anuncioRedigido().description).toBe('REDACTED');
    // O script de captura BR escreveu `REDIGIDO (n caracteres)`; o redator do
    // repositório não confia nele e o substitui (o README guarda cada `n`).
    expect(
      anuncioRedigido(anuncioCom('description', 'REDIGIDO (1234 caracteres)')).description,
    ).toBe('REDACTED');
    expect(isRedactedPath(['response', 'item_list', '*', 'description'])).toBe(true);
    // …e a saída do VAZIO continua valendo ali.
    expect(anuncioRedigido(anuncioCom('description', '')).description).toBe('');
  });

  it('⚠️ D-3 NEAR-MISS: uma `description` em OUTRO caminho fica — o corpo de PEDIDO do kit e a leitura do kit', () => {
    // O corpo de pedido de `add_kit_item` (`item_setting.description`): um
    // pedido NOSSO, não uma leitura da loja.
    const pedido: WireValue = {
      item_setting: {
        item_name: 'Kit inventado',
        description: 'Kit de teste inventado. Nao comprar.',
        item_sku: 'KIT-INVENTADO',
      },
    };
    expect(redactWireBody(pedido)).toEqual(pedido);
    expect(isRedactedPath(['item_setting', 'description'])).toBe(false);
    // A leitura do KIT (`get_kit_item_info`): `wireCorpus.test.ts` afirma que a
    // descrição do kit tem texto (`/\S/`).
    expect(isRedactedPath(['response', 'product_info', 'description'])).toBe(false);
    // Um `item_list` que não pende de `response` também não é a página de
    // leitura — o par do título acima, para a descrição.
    expect(isRedactedPath(['data', 'item_list', '*', 'description'])).toBe(false);
    // …e `description_type` é vocabulário da Shopee, não texto do anúncio.
    expect(anuncioRedigido().description_type).toBe('normal');
  });

  /** One `get_item_base_info` row whose description is EXTENDED: two blocks. */
  const DESCRICAO_ESTENDIDA: WireValue = {
    response: {
      item_list: [
        {
          description: '',
          description_type: 'extended',
          description_info: {
            extended_description: {
              field_list: [
                { field_type: 'text', text: 'Texto inventado do anúncio *promo*' },
                { field_type: 'image', image_info: { image_id: 'imagem-inventada' } },
              ],
            },
          },
        },
      ],
    },
  };

  it('D-3 PAR: a descrição ESTENDIDA também sai — cada bloco `text`, mesmo com `*`', () => {
    const redigido = redactWireBody(DESCRICAO_ESTENDIDA);
    const limpo = redigido as {
      response: {
        item_list: { description_info: { extended_description: { field_list: Registro[] } } }[];
      };
    };
    const blocos = limpo.response.item_list[0]!.description_info.extended_description.field_list;
    expect(blocos[0]).toEqual({ field_type: 'text', text: 'REDACTED' });
    expect(
      isRedactedPath([
        'response',
        'item_list',
        '*',
        'description_info',
        'extended_description',
        'field_list',
        '*',
        'text',
      ]),
    ).toBe(true);
    expect(redactWireBody(redigido)).toEqual(redigido);
  });

  it('⚠️ D-3 NEAR-MISS: na descrição estendida, `field_type` e a imagem do bloco ficam; um `text` fora da página de leitura fica', () => {
    const limpo = redactWireBody(DESCRICAO_ESTENDIDA) as {
      response: {
        item_list: { description_info: { extended_description: { field_list: Registro[] } } }[];
      };
    };
    const blocos = limpo.response.item_list[0]!.description_info.extended_description.field_list;
    expect(blocos[1]).toEqual({
      field_type: 'image',
      image_info: { image_id: 'imagem-inventada' },
    });
    // O corpo de PEDIDO de `add_item` (`description_info` no topo): nosso, não
    // uma leitura da loja.
    const pedido: WireValue = {
      description_info: {
        extended_description: { field_list: [{ field_type: 'text', text: 'Texto inventado' }] },
      },
    };
    expect(redactWireBody(pedido)).toEqual(pedido);
    expect(
      isRedactedPath(['description_info', 'extended_description', 'field_list', '*', 'text']),
    ).toBe(false);
  });

  it('a URL de imagem de um `string[]` vira a URL-placeholder — a chave é o último segmento que NÃO é índice', () => {
    const linha = anuncioRedigido();
    expect(linha.image.image_url_list).toEqual(['https://redacted.invalid/imagem']);
    expect(linha.promotion_image.image_url_list).toEqual(['https://redacted.invalid/imagem']);
    // O marcador antigo das sondas de kit (passo 19) também é regravado.
    const sonda = redactWireBody({
      image: { image_url_list: ['https://example.invalid/file/redacted'] },
    }) as { image: Registro };
    expect(sonda.image.image_url_list).toEqual(['https://redacted.invalid/imagem']);
    expect(chaveDaFolha(['response', 'item_list', '*', 'image', 'image_url_list', '*'])).toBe(
      'image_url_list',
    );
    expect(chaveDaFolha(['dispute_text_reason', '*', '*'])).toBe('dispute_text_reason');
    expect(chaveDaFolha(['*'])).toBe('');
    expect(chaveDaFolha([])).toBe('');
  });

  it('⚠️ NEAR-MISS: `image`, `images` e a lista de `dispute_text_reason` continuam `REDACTED` — nenhuma tem caso de URL', () => {
    const limpo = redactWireBody({
      image: ['https://fotos.example.com/1.jpg'],
      item: [{ images: ['https://fotos.example.com/2.jpg'] }],
      dispute_text_reason: ['texto inventado'],
    }) as { image: unknown; item: Registro[]; dispute_text_reason: unknown };
    expect(limpo.image).toEqual(['REDACTED']);
    expect(limpo.item[0]!.images).toEqual(['REDACTED']);
    expect(limpo.dispute_text_reason).toEqual(['REDACTED']);
  });

  it('`image_url` em UM segmento — a opção de tier e a opção padronizada também saem', () => {
    const modelos = modelosRedigidos();
    expect(modelos.tier_variation[0]!.option_list[0]!.image.image_url).toBe(
      'https://redacted.invalid/imagem',
    );
    expect(modelos.standardise_tier_variation[0]!.variation_option_list![0]!.image_url).toBe(
      'https://redacted.invalid/imagem',
    );
    // NEAR-MISS: o id da imagem (o placeholder do script) e o resto da opção ficam.
    expect(modelos.tier_variation[0]!.option_list[0]!.image.image_id).toBe('imagem-redigida');
    expect(modelos.standardise_tier_variation[0]!.variation_option_list![0]).toMatchObject({
      variation_option_id: 0,
      variation_option_name: 'Preto',
      image_id: 'imagem-redigida',
    });
    expect(modelos.standardise_tier_variation[1]).toEqual({
      variation_id: 101_056,
      variation_group_id: 844_758_844_060_204,
      variation_name: 'Tamanho',
    });
  });

  it('`size_chart` vira a URL-placeholder; vazio fica vazio; `size_chart_id` fica', () => {
    expect(anuncioRedigido().size_chart).toBe('https://redacted.invalid/imagem');
    expect(anuncioRedigido(anuncioCom('size_chart', '')).size_chart).toBe('');
    expect(anuncioRedigido().size_chart_id).toBe(0);
    expect(isRedactedPath(['response', 'item_list', '*', 'size_chart_id'])).toBe(false);
  });

  it('o VÍDEO sai como `REDACTED` — sem caso de URL, que reescreveria o `buyer_videos` já gravado', () => {
    const video = anuncioRedigido().video_info[0]!;
    expect(video).toEqual({ video_url: 'REDACTED', thumbnail_url: 'REDACTED', duration: 12 });
    expect(placeholderFor('video_url', 'https://video.example.com/x.mp4')).toBe('REDACTED');
    expect(placeholderFor('thumbnail_url', 'https://video.example.com/x.jpg')).toBe('REDACTED');
  });

  it('o SKU de anúncio e de modelo sai — salvo o PSEUDÔNIMO do script e o marcador da sonda', () => {
    expect(skuDoAnuncio('CAM-PRETA-M')).toBe('REDACTED');
    expect(skuDoAnuncio(PSEUDONIMO_INVENTADO)).toBe(PSEUDONIMO_INVENTADO);
    expect(skuDoAnuncio('SONDA-KIT')).toBe('SONDA-KIT');
    expect(skuDoModelo('AZUL-P')).toBe('REDACTED');
    expect(skuDoModelo(PSEUDONIMO_INVENTADO)).toBe(PSEUDONIMO_INVENTADO);
    expect(skuDoModelo('SONDA-KIT-M1')).toBe('SONDA-KIT-M1');
    expect(skuDoModelo('SONDA-KIT2')).toBe('SONDA-KIT2');
    // O corpo inteiro: cada modelo pela sua regra.
    expect(modelosRedigidos().model.map((m) => m.model_sku)).toEqual([
      'REDACTED',
      PSEUDONIMO_INVENTADO,
      'SONDA-KIT-M1',
    ]);
    // …e o vazio fica vazio.
    expect(skuDoAnuncio('')).toBe('');
  });

  it.each([
    ['hex MAIÚSCULO', 'SKU-C0FFEE42'],
    ['sete dígitos hex', 'SKU-c0ffee4'],
    ['nove dígitos hex', 'SKU-c0ffee425'],
    ['prefixo minúsculo', 'sku-c0ffee42'],
    ['espaço antes', ' SKU-c0ffee42'],
    ['sufixo depois', 'SKU-c0ffee42-M'],
    ['um asterisco no lugar de um dígito', 'SKU-c0ffee4*'],
    ['sonda minúscula', 'SONDA-kit'],
    ['sonda com minúscula no fim', 'SONDA-KITx'],
    ['sonda com prefixo', 'XSONDA-KIT'],
  ])('⚠️ NEAR-MISS do pseudônimo: %s (%j) NÃO é saída — sai `REDACTED`', (_, sku) => {
    expect(skuDoAnuncio(sku)).toBe('REDACTED');
    expect(skuDoModelo(sku)).toBe('REDACTED');
  });

  it('⚠️ NEAR-MISS de ESCOPO: o SKU do pedido, da devolução e do escrow fica; o pseudônimo em outro caminho redigido sai', () => {
    // O SKU da linha do pedido e o do escrow, que as suítes da cascata de SKU
    // leem do corpo gravado — nenhum termina num dos dois sufixos.
    const pedido = (
      redactWireBody({
        response: {
          order_list: [{ item_list: [{ item_sku: 'CAM-01', model_sku: '123002002' }] }],
        },
      }) as { response: { order_list: { item_list: Registro[] }[] } }
    ).response.order_list[0]!.item_list[0]!;
    expect(pedido).toEqual({ item_sku: 'CAM-01', model_sku: '123002002' });
    const escrow = JSON.stringify(
      redactWireBody({
        response: { order_income: { items: [{ item_sku: 'CAM-01', model_sku: 'PRETA-M' }] } },
      }),
    );
    expect(escrow).toContain('"item_sku":"CAM-01"');
    expect(escrow).toContain('"model_sku":"PRETA-M"');
    // A devolução (o `item.item_sku` acima, no teste do detalhe) também fica.
    expect(isRedactedPath(['response', 'item', '*', 'item_sku'])).toBe(false);
    expect(isRedactedPath(['response', 'order_list', '*', 'item_list', '*', 'model_sku'])).toBe(
      false,
    );
    // E a saída NÃO vaza para as outras entradas: um valor com forma de
    // pseudônimo num nome de destinatário ou num título sai como qualquer valor.
    const destinatario = redactWireBody({ recipient_address: { name: PSEUDONIMO_INVENTADO } }) as {
      recipient_address: Registro;
    };
    expect(destinatario.recipient_address.name).toBe('REDACTED');
    expect(anuncioRedigido(anuncioCom('item_name', 'SONDA-KIT')).item_name).toBe('REDACTED');
    expect(ehSkuSemConteudo(['recipient_address', 'name'], PSEUDONIMO_INVENTADO)).toBe(false);
    expect(ehSkuSemConteudo(['response', 'item_list', '*', 'item_sku'], PSEUDONIMO_INVENTADO)).toBe(
      true,
    );
    expect(ehSkuSemConteudo(['response', 'model', '*', 'model_sku'], 'SONDA-KIT')).toBe(true);
    expect(ehSkuSemConteudo(['response', 'model', '*', 'model_sku'], 'AZUL-P')).toBe(false);
    expect(CAMINHOS_DE_SKU).toEqual([
      ['response', 'item_list', '*', 'item_sku'],
      ['response', 'model', '*', 'model_sku'],
    ]);
  });

  it('⚠️ PAR: um `*` no título, na descrição ou no SKU do anúncio NÃO abre a saída do mascarado — sai `REDACTED`', () => {
    // A Shopee não mascara o anúncio da PRÓPRIA loja: um `*` ali é texto que a
    // loja digitou, e a saída do mascarado o manteria — como ponto fixo, que o
    // `piiScan` só conta como achado `masked` informativo, nunca reprovação.
    expect(
      anuncioRedigido(anuncioCom('item_name', '*Promocao* Camiseta Inventada')).item_name,
    ).toBe('REDACTED');
    expect(
      anuncioRedigido(anuncioCom('description', '*** oferta ***\n* algodao')).description,
    ).toBe('REDACTED');
    expect(skuDoAnuncio('CAM*01')).toBe('REDACTED');
    expect(skuDoModelo('AZUL*P')).toBe('REDACTED');
    // …o vazio continua saída ali, e o resultado é ponto fixo.
    expect(anuncioRedigido(anuncioCom('item_name', '')).item_name).toBe('');
    const uma = redactWireBody(anuncioCom('item_name', '*Promocao*'));
    expect(redactWireBody(uma)).toEqual(uma);
    expect(FOLHAS_DE_TEXTO_DO_ANUNCIO).toEqual([
      ['response', 'item_list', '*', 'item_name'],
      ['response', 'item_list', '*', 'description'],
      [
        'response',
        'item_list',
        '*',
        'description_info',
        'extended_description',
        'field_list',
        '*',
        'text',
      ],
    ]);
    expect(CAMINHOS_SEM_SAIDA_MASCARADA).toEqual([
      ...FOLHAS_DE_TEXTO_DO_ANUNCIO,
      ...CAMINHOS_DE_SKU,
    ]);
    for (const caminho of CAMINHOS_SEM_SAIDA_MASCARADA) {
      expect(ehCaminhoSemSaidaMascarada(caminho), caminho.join('.')).toBe(true);
    }
  });

  it('⚠️ NEAR-MISS: FORA dessas folhas o mascarado continua saída — o destinatário fica `****`; a linha do pedido e o kit ficam', () => {
    const limpo = redactWireBody({
      response: {
        order_list: [
          {
            recipient_address: { name: '****', phone: '******64' },
            item_list: [{ item_name: 'Camiseta *promo*', item_sku: 'CAM*01' }],
          },
        ],
        product_info: { item_name: 'Kit *inventado*' },
      },
    }) as {
      response: {
        order_list: { recipient_address: Registro; item_list: Registro[] }[];
        product_info: Registro;
      };
    };
    const pedido = limpo.response.order_list[0]!;
    expect(pedido.recipient_address).toEqual({ name: '****', phone: '******64' });
    expect(pedido.item_list[0]).toEqual({ item_name: 'Camiseta *promo*', item_sku: 'CAM*01' });
    expect(limpo.response.product_info.item_name).toBe('Kit *inventado*');
    expect(
      ehCaminhoSemSaidaMascarada(['response', 'order_list', '*', 'recipient_address', 'name']),
    ).toBe(false);
    expect(
      ehCaminhoSemSaidaMascarada(['response', 'order_list', '*', 'item_list', '*', 'item_name']),
    ).toBe(false);
    expect(ehCaminhoSemSaidaMascarada(['response', 'product_info', 'item_name'])).toBe(false);
  });

  it('o pseudônimo destes testes é INVENTADO de verdade — o seu hex não aparece em NENHUM arquivo de `__wire__/`', () => {
    const hex = PSEUDONIMO_INVENTADO.slice('SKU-'.length);
    expect(/^[0-9a-f]{8}$/.test(hex)).toBe(true);
    const arquivos = readdirSync(WIRE_DIR);
    // Âncora anti-vacuidade: o diretório tem os corpos que a busca percorre.
    expect(arquivos.filter((f) => f.endsWith('.json')).length).toBeGreaterThan(0);
    // Uma CONTAGEM, comparada em minúsculas: uma falha nunca imprime o trecho.
    expect(
      arquivos.filter((f) => readFileSync(join(WIRE_DIR, f), 'utf8').toLowerCase().includes(hex))
        .length,
    ).toBe(0);
  });

  it('os placeholders do PRÓPRIO script de captura que não são texto do anúncio ficam: `imagem-redigida` e `LOCAL-REDIGIDO`', () => {
    expect(anuncioRedigido().image.image_id_list).toEqual(['imagem-redigida']);
    expect(modelosRedigidos().model[0]!.stock_info_v2).toEqual({
      seller_stock: [{ location_id: 'LOCAL-REDIGIDO', stock: 3 }],
    });
    expect(isRedactedPath(['response', 'item_list', '*', 'image', 'image_id_list', '*'])).toBe(
      false,
    );
    expect(
      isRedactedPath([
        'response',
        'model',
        '*',
        'stock_info_v2',
        'seller_stock',
        '*',
        'location_id',
      ]),
    ).toBe(false);
  });

  it('as entradas #1911 estão no denylist como desenhadas — e as grafias erradas NÃO', () => {
    for (const entrada of [
      ['response', 'item_list', '*', 'item_name'],
      ['response', 'item_list', '*', 'description'],
      ['image_url_list', '*'],
      ['image_url'],
      ['size_chart'],
      ['video_info', '*', 'video_url'],
      ['video_info', '*', 'thumbnail_url'],
      ['response', 'item_list', '*', 'item_sku'],
      ['response', 'model', '*', 'model_sku'],
    ]) {
      expect(REDACTED_PATH_SUFFIXES, entrada.join('.')).toContainEqual(entrada);
    }
    for (const errada of [
      ['item_list', '*', 'item_name'],
      ['item_name'],
      ['description'],
      ['item_sku'],
      ['model_sku'],
      ['image_info', 'image_url'],
    ]) {
      expect(REDACTED_PATH_SUFFIXES, errada.join('.')).not.toContainEqual(errada);
    }
  });

  it('é IDEMPOTENTE sobre as duas páginas — o ponto fixo que o piiScan usa', () => {
    for (const cru of [CRU_ANUNCIO, CRU_MODELOS]) {
      const uma = redactWireBody(cru);
      expect(redactWireBody(uma)).toEqual(uma);
      expect(redactWireBody(redactWireBody(uma))).toEqual(uma);
      expect(redactionResidue(uma)).toEqual([]);
      expect(scanForPiiReprovavel(uma)).toEqual([]);
    }
  });

  it('CONTROLE A: o resíduo de redação acusa CADA folha nova nos corpos crus, e nenhuma vizinha', () => {
    const prefixo = 'response.item_list.*.';
    expect(
      redactionResidue(CRU_ANUNCIO)
        .map((f) => f.path)
        .sort(),
    ).toEqual(
      [
        `${prefixo}description`,
        `${prefixo}image.image_url_list.*`,
        `${prefixo}item_name`,
        `${prefixo}item_sku`,
        `${prefixo}promotion_image.image_url_list.*`,
        `${prefixo}size_chart`,
        `${prefixo}video_info.*.thumbnail_url`,
        `${prefixo}video_info.*.video_url`,
      ].sort(),
    );
    expect(
      redactionResidue(CRU_MODELOS)
        .map((f) => f.path)
        .sort(),
    ).toEqual(
      [
        'response.model.*.model_sku',
        'response.standardise_tier_variation.*.variation_option_list.*.image_url',
        'response.tier_variation.*.option_list.*.image.image_url',
      ].sort(),
    );
  });
});
