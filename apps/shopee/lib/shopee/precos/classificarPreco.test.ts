import { describe, expect, it } from 'vitest';
import { SHOPEE_ERROR_KIND, type ShopeeErrorKind } from '@delfrance/integrations-shopee';

import { classificarCodigoDePreco, type ClassePreco } from './classificarPreco';
import { MOTIVOS_QUE_CARIMBAM, MOTIVO_PRECO_SHOPEE, type MotivoPrecoShopee } from './errosPreco';

const OUTRO: ShopeeErrorKind = SHOPEE_ERROR_KIND.other;
const TRANSITORIO: ClassePreco = { classe: 'transitorio' };

function pular(motivo: MotivoPrecoShopee): ClassePreco {
  return { classe: 'pular', motivo };
}

/** `carimbar` literal `true`: a linha pina a coluna "stamp" da §2.7, não o conjunto. */
function falhaCarimbada(motivo: MotivoPrecoShopee): ClassePreco {
  return { classe: 'falhar', motivo, carimbar: true };
}

function fatal(motivo: 'loja-com-penalidade' | 'sem-permissao'): ClassePreco {
  return { classe: 'fatal', motivo };
}

const DESCONHECIDA = falhaCarimbada(MOTIVO_PRECO_SHOPEE.recusaDesconhecida);

interface Linha {
  readonly linha: string;
  readonly codigo: string;
  readonly mensagem: string;
  readonly kind: ShopeeErrorKind;
  readonly esperado: ClassePreco;
}

/**
 * A tabela INTEIRA, código a código, na ordem declarada. Cada código vem na
 * forma NUA; o teste a pareia com a forma prefixada `product.` — a Shopee
 * imprime as duas, às vezes na mesma página.
 */
const TABELA: readonly Linha[] = [
  // T1 — as quatro travas de promoção.
  ...[
    'error_cannt_edit_price_in_promotion',
    'error_in_item_promotion_item_price_lock',
    'error_cannot_update_price_in_promotion',
    'error_related_product_in_promotion',
  ].map((codigo) => ({
    linha: 'T1',
    codigo,
    mensagem: '',
    kind: OUTRO,
    esperado: pular(MOTIVO_PRECO_SHOPEE.bloqueadoPorPromocao),
  })),
  // T2 — a promoção de preço riscado (slash sale), NÃO a relâmpago.
  {
    linha: 'T2',
    codigo: 'error_slash_price_not_lowest',
    mensagem: 'In slash sale, price should not be lower or same as slash price.',
    kind: OUTRO,
    esperado: pular(MOTIVO_PRECO_SHOPEE.precoRiscado),
  },
  {
    linha: 'T2',
    codigo: 'error_slash_price_models_diff',
    mensagem: 'In slash sale, the model price should be the same.',
    kind: OUTRO,
    esperado: pular(MOTIVO_PRECO_SHOPEE.precoRiscado),
  },
  // T3
  {
    linha: 'T3',
    codigo: 'error_edit_item_price_for_item_has_model',
    mensagem: '',
    kind: OUTRO,
    esperado: falhaCarimbada(MOTIVO_PRECO_SHOPEE.formaDeModeloDivergente),
  },
  // T4 — os dois detalhes de `error_param`.
  {
    linha: 'T4',
    codigo: 'error_param',
    mensagem: 'Wrong parameters, detail: repeat model_id.',
    kind: OUTRO,
    esperado: falhaCarimbada(MOTIVO_PRECO_SHOPEE.modeloInvalido),
  },
  {
    linha: 'T4',
    codigo: 'error_param',
    mensagem: 'Wrong parameters, detail: Wrong model_id.',
    kind: OUTRO,
    esperado: falhaCarimbada(MOTIVO_PRECO_SHOPEE.modeloInvalido),
  },
  // T5 … T11
  ...(
    [
      ['T5', 'error_item_not_belong_shop', MOTIVO_PRECO_SHOPEE.anuncioDeOutraLoja],
      ['T5', 'error_item_not_found', MOTIVO_PRECO_SHOPEE.anuncioInexistente],
      ['T5', 'error_nil_shopid_or_itemid', MOTIVO_PRECO_SHOPEE.anuncioInexistente],
      ['T6', 'error_price_exceed_min_limitt', MOTIVO_PRECO_SHOPEE.precoForaDaFaixa],
      ['T6', 'error_price_exceed_max_limitt', MOTIVO_PRECO_SHOPEE.precoForaDaFaixa],
      ['T6', 'error_price_out_of_range', MOTIVO_PRECO_SHOPEE.precoForaDaFaixa],
      ['T7', 'error_invalid_price', MOTIVO_PRECO_SHOPEE.precoInvalido],
      ['T8', 'error_invalid_price_for_logistic', MOTIVO_PRECO_SHOPEE.precoAcimaDoLimiteDoFrete],
      ['T9', 'error_busi_price_lower_then_wholesale_price', MOTIVO_PRECO_SHOPEE.conflitoComAtacado],
      ['T9', 'error_wholesale_price_less_than_ratio_limit', MOTIVO_PRECO_SHOPEE.conflitoComAtacado],
      ['T9', 'error_price_should_be_same_for_wholesales', MOTIVO_PRECO_SHOPEE.conflitoComAtacado],
      ['T10', 'error_busi_cannot_edit_vsku', MOTIVO_PRECO_SHOPEE.lojaVsku],
      ['T11', 'error_item_uneditable', MOTIVO_PRECO_SHOPEE.anuncioNaoEditavel],
    ] as const
  ).map(([linha, codigo, motivo]) => ({
    linha,
    codigo,
    mensagem: '',
    kind: OUTRO,
    esperado: falhaCarimbada(motivo),
  })),
  // T12 — da LOJA, não do anúncio.
  {
    linha: 'T12',
    codigo: 'error_seller_under_penalty',
    mensagem: '',
    kind: OUTRO,
    esperado: fatal('loja-com-penalidade'),
  },
  {
    linha: 'T12',
    codigo: 'error_perm_non_admin',
    mensagem: '',
    kind: OUTRO,
    esperado: fatal('sem-permissao'),
  },
  // T12b — o achado da sonda.
  {
    linha: 'T12b',
    codigo: 'error_update_price_fail',
    mensagem: 'Update price failed, please try later.',
    kind: OUTRO,
    esperado: falhaCarimbada(MOTIVO_PRECO_SHOPEE.precoRecusado),
  },
  // T13 — o soluço da própria Shopee.
  {
    linha: 'T13',
    codigo: 'error_server',
    mensagem: 'Something wrong. Please try later.',
    kind: SHOPEE_ERROR_KIND.transient,
    esperado: TRANSITORIO,
  },
  {
    linha: 'T13',
    codigo: 'error_system_busy',
    mensagem: 'Our system is taking some time to respond, please try later.',
    kind: OUTRO,
    esperado: TRANSITORIO,
  },
  {
    linha: 'T13',
    codigo: 'error_inner',
    mensagem: 'System error, please try again later or contact the OpenAPI support team.',
    kind: OUTRO,
    esperado: TRANSITORIO,
  },
  {
    linha: 'T13',
    codigo: 'error_inner',
    mensagem: 'Our system is taking some time to respond.',
    kind: OUTRO,
    esperado: TRANSITORIO,
  },
  {
    linha: 'T13',
    codigo: 'error_inner',
    mensagem: 'Internal hiccup, please try later.',
    kind: OUTRO,
    esperado: TRANSITORIO,
  },
  // T14
  {
    linha: 'T14',
    codigo: 'error_codigo_que_ninguem_ensinou',
    mensagem: 'Something new.',
    kind: OUTRO,
    esperado: DESCONHECIDA,
  },
];

describe('classificarCodigoDePreco — a tabela, linha a linha', () => {
  it.each(TABELA)(
    '1 — PAR $linha: `$codigo` e `product.$codigo` classificam IGUAL, e como a linha manda',
    ({ codigo, mensagem, kind, esperado }) => {
      // M42: uma busca só pela grafia VERBATIM classificaria a forma nua e
      // mandaria a prefixada para T14 — carimbando "recusa desconhecida" num
      // código que a tabela conhece.
      expect(classificarCodigoDePreco(codigo, mensagem, kind)).toEqual(esperado);
      expect(classificarCodigoDePreco(`product.${codigo}`, mensagem, kind)).toEqual(esperado);
    },
  );

  it('2 — a tabela acima cobre T1 … T14 e T12b, nenhuma linha esquecida', () => {
    expect(new Set(TABELA.map((l) => l.linha))).toEqual(
      new Set([
        'T1',
        'T2',
        'T3',
        'T4',
        'T5',
        'T6',
        'T7',
        'T8',
        'T9',
        'T10',
        'T11',
        'T12',
        'T12b',
        'T13',
        'T14',
      ]),
    );
  });

  it('3 — ⛔ NEAR-MISS: a busca é EXATA — um código que só COMEÇA como outro não herda a linha dele', () => {
    // T7 (`error_invalid_price`) é prefixo de T8 (`…_for_logistic`): um
    // `startsWith` responderia "formato inválido" para o teto do frete.
    expect(classificarCodigoDePreco('error_invalid_price_for_logistic', '', OUTRO)).toEqual(
      falhaCarimbada(MOTIVO_PRECO_SHOPEE.precoAcimaDoLimiteDoFrete),
    );
    expect(classificarCodigoDePreco('error_item_uneditable_now', '', OUTRO)).toEqual(DESCONHECIDA);
    expect(classificarCodigoDePreco('error_update_price_failed', '', OUTRO)).toEqual(DESCONHECIDA);
  });
});

describe('T12b — `error_update_price_fail` é DETERMINÍSTICO (sonda B-3)', () => {
  it('4 — PAR: o texto exato da sonda ⇒ `falhar preco-recusado`, carimbado — NÃO transitório', () => {
    // A manchete da sonda: a frase diz "please try later" e é FALSA. Lida como
    // transitória, a fila re-tentaria para sempre uma escrita que nunca pousa.
    expect(
      classificarCodigoDePreco(
        'product.error_update_price_fail',
        'Update price failed, please try later.',
        OUTRO,
      ),
    ).toEqual({ classe: 'falhar', motivo: 'preco-recusado', carimbar: true });
  });

  it('5 — ⛔ NEAR-MISS: `error_system_busy` com a MESMA cauda continua transitório', () => {
    expect(
      classificarCodigoDePreco(
        'product.error_system_busy',
        'Our system is taking some time to respond, please try later.',
        OUTRO,
      ),
    ).toEqual(TRANSITORIO);
  });

  it('6 — ⛔ NEAR-MISS: nem um `kind` transitório tira T12b do lugar (T12b antes de T13)', () => {
    expect(
      classificarCodigoDePreco(
        'product.error_update_price_fail',
        'Update price failed, please try later.',
        SHOPEE_ERROR_KIND.transient,
      ),
    ).toEqual(falhaCarimbada(MOTIVO_PRECO_SHOPEE.precoRecusado));
  });

  it('7 — ⛔ NEAR-MISS: a agulha solta "please try later" SAIU — num código qualquer ela não faz transitório', () => {
    // C-2: só `kind` transient, `error_system_busy` e `error_inner` com uma
    // frase de nova tentativa ficam em T13. A frase sozinha não decide nada.
    expect(
      classificarCodigoDePreco('error_codigo_novo', 'Something failed, please try later.', OUTRO),
    ).toEqual(DESCONHECIDA);
    // O mesmo `error_server` do teste 1: é o KIND do transporte que o faz
    // transitório, não a frase.
    expect(
      classificarCodigoDePreco('error_server', 'Something wrong. Please try later.', OUTRO),
    ).toEqual(DESCONHECIDA);
    expect(
      classificarCodigoDePreco(
        'error_server',
        'Something wrong. Please try later.',
        SHOPEE_ERROR_KIND.transient,
      ),
    ).toEqual(TRANSITORIO);
  });
});

describe('T13 — `error_inner` carrega as duas frases', () => {
  it('8 — PAR: `error_inner` + "try again" ⇒ transitório', () => {
    expect(
      classificarCodigoDePreco(
        'error_inner',
        'System error, please try again later or contact the OpenAPI support team.',
        OUTRO,
      ),
    ).toEqual(TRANSITORIO);
  });

  it('9 — ⛔ NEAR-MISS: `error_inner` + "Update item failed" ⇒ `recusa-desconhecida`, carimbada (M44)', () => {
    // O mutante "`error_inner` sempre transitório" re-tentaria uma recusa
    // permanente; o texto do estoque (`Invalid stock location ID`) também é
    // permanente e cai em T14.
    expect(classificarCodigoDePreco('error_inner', 'Update item failed x', OUTRO)).toEqual(
      DESCONHECIDA,
    );
    expect(
      classificarCodigoDePreco('product.error_inner', 'Invalid stock location ID', OUTRO),
    ).toEqual(DESCONHECIDA);
  });
});

describe('a ORDEM é carga', () => {
  it('10 — PAR T1 antes de T4/T14: `error_param` + detalhe de promoção ⇒ `bloqueado-por-promocao`, sem carimbo (M40)', () => {
    expect(
      classificarCodigoDePreco(
        'product.error_param',
        'Wrong parameters, detail: item is in promotion, price can not be edited.',
        OUTRO,
      ),
    ).toEqual(pular(MOTIVO_PRECO_SHOPEE.bloqueadoPorPromocao));
    // Mesmo com um detalhe de T4 na mesma frase: T1 vem primeiro.
    expect(
      classificarCodigoDePreco(
        'error_param',
        'Wrong parameters, detail: wrong model_id, model in promotion.',
        OUTRO,
      ),
    ).toEqual(pular(MOTIVO_PRECO_SHOPEE.bloqueadoPorPromocao));
  });

  it('11 — ⛔ NEAR-MISS: `error_param` sem detalhe de promoção nem de modelo ⇒ T14, carimbado', () => {
    expect(
      classificarCodigoDePreco(
        'error_param',
        'Wrong parameters, detail: price is required.',
        OUTRO,
      ),
    ).toEqual(DESCONHECIDA);
  });

  it('12 — ⛔ NEAR-MISS: os detalhes de T4 valem só sob `error_param` — noutro código ⇒ T14', () => {
    expect(classificarCodigoDePreco('error_data', 'repeat model_id', OUTRO)).toEqual(DESCONHECIDA);
  });

  it('13 — PAR T12 antes de T13: a penalidade é `fatal` mesmo com `kind` transitório (M46)', () => {
    // Lida como transitória, uma recusa da LOJA re-tentaria a execução inteira;
    // lida como linha, carimbaria cada anúncio por algo que é da conta.
    expect(
      classificarCodigoDePreco(
        'product.error_seller_under_penalty',
        '',
        SHOPEE_ERROR_KIND.transient,
      ),
    ).toEqual(fatal('loja-com-penalidade'));
    expect(
      classificarCodigoDePreco('error_perm_non_admin', '', SHOPEE_ERROR_KIND.transient),
    ).toEqual(fatal('sem-permissao'));
  });

  it('14 — ⛔ NEAR-MISS: um código desconhecido com `kind` transitório É transitório (é o kind que decide ali)', () => {
    expect(classificarCodigoDePreco('error_codigo_novo', '', SHOPEE_ERROR_KIND.transient)).toEqual(
      TRANSITORIO,
    );
    expect(classificarCodigoDePreco('error_codigo_novo', '', OUTRO)).toEqual(DESCONHECIDA);
  });

  it('15 — T3 antes de T4, e T4 antes de T5: a primeira linha que casa responde', () => {
    expect(
      classificarCodigoDePreco(
        'error_edit_item_price_for_item_has_model',
        'model ID not exist in sku',
        OUTRO,
      ),
    ).toEqual(falhaCarimbada(MOTIVO_PRECO_SHOPEE.formaDeModeloDivergente));
    expect(
      classificarCodigoDePreco('error_item_not_found', 'model ID not exist in sku', OUTRO),
    ).toEqual(falhaCarimbada(MOTIVO_PRECO_SHOPEE.modeloInvalido));
  });

  it('16 — PAR: o código de forma-de-modelo é FALHA carimbada, não pulo (M41)', () => {
    // É também o sinal de deriva do vínculo: o anúncio ganhou variações no
    // Seller Centre, e a ação do operador é reimportar.
    const c = classificarCodigoDePreco(
      'product.error_edit_item_price_for_item_has_model',
      '',
      OUTRO,
    );
    expect(c).toEqual({ classe: 'falhar', motivo: 'forma-de-modelo-divergente', carimbar: true });
  });

  it('17 — ⛔ NEAR-MISS: os códigos de preço riscado são PULO, sem carimbo — não falha (M45)', () => {
    for (const codigo of [
      'error_slash_price_not_lowest',
      'product.error_slash_price_models_diff',
    ]) {
      const c = classificarCodigoDePreco(codigo, '', OUTRO);
      expect(c, codigo).toEqual({ classe: 'pular', motivo: 'preco-riscado' });
      expect('carimbar' in c, codigo).toBe(false);
    }
  });
});

describe('a metade POR MODELO — o `failed_reason` chega COMO o código', () => {
  it('18 — PAR: o texto medido na sonda (P9) ⇒ `modelo-invalido`, nas DUAS convenções de chamada', () => {
    const texto = 'model ID not exist in sku';
    const esperado = falhaCarimbada(MOTIVO_PRECO_SHOPEE.modeloInvalido);
    // Como o estoque chama (o texto nos dois argumentos)…
    expect(classificarCodigoDePreco(texto, texto, OUTRO)).toEqual(esperado);
    // …e só como código, com a mensagem vazia: a agulha lê o código também.
    expect(classificarCodigoDePreco(texto, '', OUTRO)).toEqual(esperado);
  });

  it('19 — ⛔ NEAR-MISS: um texto de modelo SEM a agulha ⇒ `recusa-desconhecida`, carimbada', () => {
    expect(classificarCodigoDePreco('model ID invalid in sku', '', OUTRO)).toEqual(DESCONHECIDA);
    expect(classificarCodigoDePreco('fail', 'fail', OUTRO)).toEqual(DESCONHECIDA);
  });

  it('20 — PAR: uma trava de promoção num `failed_reason` ⇒ PULO, nas duas convenções', () => {
    const texto = 'The model is in Promotion, price can not be updated';
    const esperado = pular(MOTIVO_PRECO_SHOPEE.bloqueadoPorPromocao);
    expect(classificarCodigoDePreco(texto, texto, OUTRO)).toEqual(esperado);
    expect(classificarCodigoDePreco(texto, '', OUTRO)).toEqual(esperado);
  });

  it('21 — ⛔ NEAR-MISS: "promo" não é "promotion" — a agulha é a palavra inteira da Shopee', () => {
    expect(classificarCodigoDePreco('The model is in a promo', '', OUTRO)).toEqual(DESCONHECIDA);
  });
});

describe('chaves do PROTÓTIPO e o que fica FORA da tabela', () => {
  it('22 — ⛔ NEAR-MISS: `constructor`, `__proto__` e amigos são códigos DESCONHECIDOS (M43)', () => {
    // Num objeto literal, `TABELA['constructor']` devolve a FUNÇÃO `Object` —
    // verdadeira, `!== undefined` — e uma string que ninguém ensinou ganharia
    // uma linha real (ou pior: um `fatal` que encerra a conta).
    for (const doPrototipo of [
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
      'valueOf',
      'product.constructor',
      'product.__proto__',
    ]) {
      const c = classificarCodigoDePreco(doPrototipo, doPrototipo, OUTRO);
      expect(c, doPrototipo).toEqual(DESCONHECIDA);
    }
  });

  it('23 — PAR: um código desconhecido ⇒ `recusa-desconhecida` COM carimbo (o código cru é a evidência)', () => {
    expect(
      classificarCodigoDePreco('error_auth', 'Your shop can not use model level dts', OUTRO),
    ).toEqual({ classe: 'falhar', motivo: 'recusa-desconhecida', carimbar: true });
  });

  it('24 — ⛔ NEAR-MISS: `burst`, `daily` e `reauth` não são da tabela — a escada de classes os estreita ANTES', () => {
    // C-5: o remetente lê o `kind` de um erro parcial antes de consultar esta
    // tabela. Chegando aqui, um código desconhecido desses kinds é T14 — a
    // tabela não adivinha pausa nem reautorização.
    for (const kind of [
      SHOPEE_ERROR_KIND.burst,
      SHOPEE_ERROR_KIND.daily,
      SHOPEE_ERROR_KIND.reauth,
    ]) {
      expect(classificarCodigoDePreco('error_codigo_novo', '', kind), kind).toEqual(DESCONHECIDA);
    }
  });
});

describe('o carimbo vem de MOTIVOS_QUE_CARIMBAM — uma fonte só', () => {
  it('25 — PAR: toda FALHA da tabela carimba, e `carimbar` é exatamente a pertença ao conjunto', () => {
    const falhas = TABELA.map((l) => classificarCodigoDePreco(l.codigo, l.mensagem, l.kind)).filter(
      (c): c is Extract<ClassePreco, { classe: 'falhar' }> => c.classe === 'falhar',
    );
    expect(falhas.length).toBeGreaterThan(15);
    for (const c of falhas) {
      expect(c.carimbar, c.motivo).toBe(true);
      expect(c.carimbar, c.motivo).toBe(MOTIVOS_QUE_CARIMBAM.has(c.motivo));
    }
  });

  it('26 — ⛔ NEAR-MISS: travas e recusas da LOJA NÃO estão no conjunto (C-n)', () => {
    const naoCarimbam = TABELA.map((l) =>
      classificarCodigoDePreco(l.codigo, l.mensagem, l.kind),
    ).filter(
      (c): c is Extract<ClassePreco, { classe: 'pular' | 'fatal' }> =>
        c.classe === 'pular' || c.classe === 'fatal',
    );
    // As 4 travas de promoção + as 2 de preço riscado + as 2 da loja.
    expect(naoCarimbam).toHaveLength(8);
    for (const c of naoCarimbam) {
      expect(MOTIVOS_QUE_CARIMBAM.has(c.motivo), c.motivo).toBe(false);
    }
  });
});
