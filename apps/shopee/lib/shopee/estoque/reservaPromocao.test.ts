import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  SHOPEE_PROMOTION_STAGING,
  type ShopeeItemPromotionPayload,
  shopeeItemPromotionPayloadSchema,
} from '@delfrance/integrations-shopee';

import { aplicarPiso, ehRecusaDePiso, pisoAcimaDaBanda, pisoPorModelo } from './reservaPromocao';

/* ---------------------------------- fixtures ------------------------------ */

const ITEM_ID = 2500139861;
const OUTRO_ITEM_ID = 2500139862;
const MODELO = 2000458802;
const OUTRO_MODELO = 2000458803;
/** The no-model item's id on the write side — a legitimate key, never falsy. */
const SEM_VARIACAO = 0;
/** A fixture promotion id. Opaque, never read by this module. */
const PROMOCAO_ID = 77001;

/** A payload as the package hands it over: parsed, every default applied. */
function parseada(bruto: unknown): ShopeeItemPromotionPayload {
  return shopeeItemPromotionPayloadSchema.parse(bruto);
}

/**
 * A body NOBODY parsed — a fixture, a log line, a shape the wire has not been
 * measured to produce. The module promises a verdict for these too.
 */
function crua(bruto: unknown): ShopeeItemPromotionPayload {
  return bruto as ShopeeItemPromotionPayload;
}

/**
 * One promotion row.
 *
 * `aninhado` is the SAMPLE's position (`summary_info.total_reserved_stock`);
 * `irmao` is the response TABLE's, one level up. Omitting both leaves
 * `promotion_stock_info_v2` null — a row that says nothing about the reserve.
 */
function promocao(o: {
  readonly modelId?: number | null;
  readonly aninhado?: number | null;
  readonly irmao?: number | null;
  readonly staging?: string | null;
}): Record<string, unknown> {
  const v2: Record<string, unknown> = {};
  if (o.aninhado !== undefined) v2.summary_info = { total_reserved_stock: o.aninhado };
  if (o.irmao !== undefined) v2.total_reserved_stock = o.irmao;

  return {
    promotion_type: 'product_promotion',
    promotion_id: PROMOCAO_ID,
    model_id: o.modelId === undefined ? MODELO : o.modelId,
    start_time: 1_757_000_000,
    end_time: 1_757_600_000,
    promotion_staging: o.staging === undefined ? SHOPEE_PROMOTION_STAGING.ongoing : o.staging,
    promotion_stock_info_v2: Object.keys(v2).length > 0 ? v2 : null,
  };
}

/** One `success_list` row for `ITEM_ID` carrying the given promotion rows. */
function sucesso(promocoes: readonly unknown[], itemId: number = ITEM_ID): unknown {
  return { success_list: [{ item_id: itemId, promotion: promocoes }] };
}

/* -------------------------------------------------------------------------- */
/*                 pisoPorModelo — combining promotions: MAX                   */
/* -------------------------------------------------------------------------- */

describe('pisoPorModelo — combinando promoções no mesmo modelo', () => {
  it('⚠️ PAR: dois pisos (10 e 30) no MESMO modelo ⇒ 30 — o MÁXIMO, jamais a soma', () => {
    const pisos = pisoPorModelo(
      parseada(sucesso([promocao({ aninhado: 10 }), promocao({ aninhado: 30 })])),
      ITEM_ID,
    );

    expect(pisos.get(MODELO)).toBe(30);
    // ⚠️ O mutante: somar daria 40 e publicaria estoque que o ERP não tem.
    expect(pisos.get(MODELO)).not.toBe(40);
    expect(pisos.size).toBe(1);
  });

  it('⚠️ NEAR-MISS: UMA promoção só rende exatamente o piso DELA — nada é acumulado', () => {
    const pisos = pisoPorModelo(parseada(sucesso([promocao({ aninhado: 30 })])), ITEM_ID);

    expect(pisos.get(MODELO)).toBe(30);
    expect(pisos.size).toBe(1);
  });

  it('a ORDEM de chegada não importa — 30 depois de 10 e 10 depois de 30 dão o mesmo', () => {
    const crescente = pisoPorModelo(
      parseada(sucesso([promocao({ aninhado: 10 }), promocao({ aninhado: 30 })])),
      ITEM_ID,
    );
    const decrescente = pisoPorModelo(
      parseada(sucesso([promocao({ aninhado: 30 }), promocao({ aninhado: 10 })])),
      ITEM_ID,
    );

    expect(crescente.get(MODELO)).toBe(decrescente.get(MODELO));
    expect(decrescente.get(MODELO)).toBe(30);
  });

  it('⚠️ NEAR-MISS: promoções em MODELOS diferentes não se combinam — uma entrada cada', () => {
    const pisos = pisoPorModelo(
      parseada(
        sucesso([
          promocao({ modelId: MODELO, aninhado: 10 }),
          promocao({ modelId: OUTRO_MODELO, aninhado: 30 }),
        ]),
      ),
      ITEM_ID,
    );

    expect(pisos.get(MODELO)).toBe(10);
    expect(pisos.get(OUTRO_MODELO)).toBe(30);
    expect(pisos.size).toBe(2);
  });

  it('três promoções no mesmo modelo ⇒ o maior dos três, nunca o último nem a soma', () => {
    const pisos = pisoPorModelo(
      parseada(
        sucesso([
          promocao({ aninhado: 7 }),
          promocao({ aninhado: 41 }),
          promocao({ aninhado: 12 }),
        ]),
      ),
      ITEM_ID,
    );

    expect(pisos.get(MODELO)).toBe(41);
    expect(pisos.get(MODELO)).not.toBe(12);
    expect(pisos.get(MODELO)).not.toBe(60);
  });
});

/* -------------------------------------------------------------------------- */
/*                     pisoPorModelo — o staging não filtra                    */
/* -------------------------------------------------------------------------- */

describe('pisoPorModelo — o promotion_staging', () => {
  it('⚠️ PAR: uma linha ongoing e uma upcoming CONTAM as duas — o máximo atravessa o staging', () => {
    const pisos = pisoPorModelo(
      parseada(
        sucesso([
          promocao({ aninhado: 5, staging: SHOPEE_PROMOTION_STAGING.ongoing }),
          promocao({ aninhado: 20, staging: SHOPEE_PROMOTION_STAGING.upcoming }),
        ]),
      ),
      ITEM_ID,
    );

    // Filtrar upcoming responderia 5 — sub-clampando justo quando a reserva é
    // mais nova e o número do ERP é o mais provável de estar abaixo dela.
    expect(pisos.get(MODELO)).toBe(20);
  });

  it('uma promoção SÓ upcoming rende piso — é a própria amostra da página (20)', () => {
    const pisos = pisoPorModelo(
      parseada(sucesso([promocao({ aninhado: 20, staging: SHOPEE_PROMOTION_STAGING.upcoming })])),
      ITEM_ID,
    );

    expect(pisos.get(MODELO)).toBe(20);
  });

  it('⚠️ NEAR-MISS: um staging null ou desconhecido também conta — nada filtra por ele', () => {
    const nulo = pisoPorModelo(
      parseada(sucesso([promocao({ aninhado: 9, staging: null })])),
      ITEM_ID,
    );
    const inventado = pisoPorModelo(
      parseada(sucesso([promocao({ aninhado: 9, staging: 'flash_sale_amanha' })])),
      ITEM_ID,
    );

    expect(nulo.get(MODELO)).toBe(9);
    expect(inventado.get(MODELO)).toBe(9);
  });
});

/* -------------------------------------------------------------------------- */
/*                 pisoPorModelo — as DUAS posições do campo                   */
/* -------------------------------------------------------------------------- */

describe('pisoPorModelo — as duas posições declaradas de total_reserved_stock', () => {
  it('⚠️ PAR: a posição ANINHADA (amostra) e a IRMÃ (tabela) rendem o MESMO piso', () => {
    const aninhada = pisoPorModelo(parseada(sucesso([promocao({ aninhado: 14 })])), ITEM_ID);
    const irma = pisoPorModelo(parseada(sucesso([promocao({ irmao: 14 })])), ITEM_ID);

    expect(aninhada.get(MODELO)).toBe(14);
    expect(irma.get(MODELO)).toBe(14);
    expect(aninhada.get(MODELO)).toBe(irma.get(MODELO));
  });

  it('⚠️ NEAR-MISS: uma linha sem NENHUMA das duas posições NÃO rende piso — e não rende 0', () => {
    const pisos = pisoPorModelo(parseada(sucesso([promocao({})])), ITEM_ID);

    expect(pisos.has(MODELO)).toBe(false);
    expect(pisos.get(MODELO)).toBeUndefined();
    // ⚠️ A diferença que importa: ausência de afirmação ≠ "a Shopee não reserva
    // nada". Um 0 aqui declararia que todo envio é seguro.
    expect(pisos.get(MODELO)).not.toBe(0);
    expect(pisos.size).toBe(0);
  });

  it('a ANINHADA vence a irmã quando as duas chegam — um leitor só, o do pacote', () => {
    const pisos = pisoPorModelo(parseada(sucesso([promocao({ aninhado: 33, irmao: 4 })])), ITEM_ID);

    expect(pisos.get(MODELO)).toBe(33);
  });

  it('⚠️ uma aninhada 0 NÃO cai para a irmã — o leitor usa ?? e 0 é uma resposta', () => {
    const pisos = pisoPorModelo(parseada(sucesso([promocao({ aninhado: 0, irmao: 50 })])), ITEM_ID);

    expect(pisos.get(MODELO)).toBe(0);
    expect(pisos.get(MODELO)).not.toBe(50);
  });

  it('uma linha sem posição alguma convive com outra que tem — só a que fala entra', () => {
    const pisos = pisoPorModelo(
      parseada(
        sucesso([promocao({ modelId: MODELO }), promocao({ modelId: OUTRO_MODELO, aninhado: 6 })]),
      ),
      ITEM_ID,
    );

    expect(pisos.has(MODELO)).toBe(false);
    expect(pisos.get(OUTRO_MODELO)).toBe(6);
  });
});

/* -------------------------------------------------------------------------- */
/*                   pisoPorModelo — a chave do model_id                       */
/* -------------------------------------------------------------------------- */

describe('pisoPorModelo — a chave do modelo', () => {
  it('⚠️ PAR: model_id null e model_id AUSENTE caem na MESMA chave 0 — e combinam por máximo', () => {
    const pisos = pisoPorModelo(
      crua({
        success_list: [
          {
            item_id: ITEM_ID,
            promotion: [
              promocao({ modelId: null, aninhado: 11 }),
              // A mesma linha, sem a chave `model_id` de todo.
              (() => {
                const semChave = promocao({ aninhado: 25 });
                delete semChave.model_id;
                return semChave;
              })(),
            ],
          },
        ],
      }),
      ITEM_ID,
    );

    expect(pisos.get(SEM_VARIACAO)).toBe(25);
    expect(pisos.size).toBe(1);
  });

  it('⚠️ PAR: um model_id 0 EXPLÍCITO é a mesma chave que um ausente', () => {
    const explicito = pisoPorModelo(
      parseada(sucesso([promocao({ modelId: SEM_VARIACAO, aninhado: 11 })])),
      ITEM_ID,
    );
    const ausente = pisoPorModelo(
      parseada(sucesso([promocao({ modelId: null, aninhado: 11 })])),
      ITEM_ID,
    );

    expect(explicito.get(SEM_VARIACAO)).toBe(11);
    expect(ausente.get(SEM_VARIACAO)).toBe(11);
  });

  it('⚠️ NEAR-MISS: o modelo 0 e um modelo real NÃO se misturam — o fold para na ausência', () => {
    const pisos = pisoPorModelo(
      parseada(
        sucesso([
          promocao({ modelId: null, aninhado: 11 }),
          promocao({ modelId: MODELO, aninhado: 44 }),
        ]),
      ),
      ITEM_ID,
    );

    expect(pisos.get(SEM_VARIACAO)).toBe(11);
    expect(pisos.get(MODELO)).toBe(44);
    expect(pisos.size).toBe(2);
  });

  it('⚠️ PAR: um model_id STRING PARSEADO pelo pacote é o MESMO modelo que o número', () => {
    // A tolerância do pacote dobra a string em número ANTES deste módulo ver o
    // corpo — é a única forma que a via real produz.
    const texto = pisoPorModelo(
      parseada(
        crua({
          success_list: [
            { item_id: ITEM_ID, promotion: [promocao({ modelId: MODELO, aninhado: 8 })] },
          ],
        }),
      ),
      ITEM_ID,
    );
    const comStringNaRede = pisoPorModelo(
      parseada({
        success_list: [
          {
            item_id: ITEM_ID,
            promotion: [{ ...promocao({ aninhado: 8 }), model_id: String(MODELO) }],
          },
        ],
      }),
      ITEM_ID,
    );

    expect(texto.get(MODELO)).toBe(8);
    expect(comStringNaRede.get(MODELO)).toBe(8);
  });

  it('⚠️ NEAR-MISS: num corpo NÃO parseado a mesma string cai na chave 0 — o falso negativo', () => {
    // A direção registrada: o remetente procura o model_id que ele conhece, não
    // acha piso e vai terminal. Coagir aqui seria uma SEGUNDA tolerância, livre
    // para discordar da do schema.
    const pisos = pisoPorModelo(
      crua({
        success_list: [
          {
            item_id: ITEM_ID,
            promotion: [{ ...promocao({ aninhado: 8 }), model_id: String(MODELO) }],
          },
        ],
      }),
      ITEM_ID,
    );

    expect(pisos.get(MODELO)).toBeUndefined();
    expect(pisos.get(SEM_VARIACAO)).toBe(8);
  });

  it('um model_id NaN cai na chave 0 — jamais uma chave NaN no mapa', () => {
    const pisos = pisoPorModelo(
      crua({
        success_list: [
          {
            item_id: ITEM_ID,
            promotion: [{ ...promocao({ aninhado: 3 }), model_id: Number.NaN }],
          },
        ],
      }),
      ITEM_ID,
    );

    expect(pisos.get(SEM_VARIACAO)).toBe(3);
    expect([...pisos.keys()].some((k) => Number.isNaN(k))).toBe(false);
  });

  it('a chave 0 é legítima: o mapa a ENTREGA, nada a trata como ausência', () => {
    const pisos = pisoPorModelo(
      parseada(sucesso([promocao({ modelId: SEM_VARIACAO, aninhado: 7 })])),
      ITEM_ID,
    );

    expect(pisos.has(SEM_VARIACAO)).toBe(true);
    expect([...pisos.keys()]).toEqual([SEM_VARIACAO]);
  });
});

/* -------------------------------------------------------------------------- */
/*            pisoPorModelo — a leitura tolerante de "sem promoção"            */
/* -------------------------------------------------------------------------- */

describe('pisoPorModelo — leituras que não rendem piso algum', () => {
  it('⚠️ NEAR-MISS: uma linha de OUTRO item_id é ignorada mesmo com o mesmo model_id', () => {
    const pisos = pisoPorModelo(
      parseada(sucesso([promocao({ aninhado: 99 })], OUTRO_ITEM_ID)),
      ITEM_ID,
    );

    expect(pisos.size).toBe(0);
  });

  it('⚠️ PAR: o item na lista certa rende; o MESMO corpo lido por outro item_id não', () => {
    const corpo = parseada(sucesso([promocao({ aninhado: 99 })]));

    expect(pisoPorModelo(corpo, ITEM_ID).get(MODELO)).toBe(99);
    expect(pisoPorModelo(corpo, OUTRO_ITEM_ID).size).toBe(0);
  });

  it('o nosso item em failure_list ⇒ mapa VAZIO, nunca uma exceção', () => {
    const pisos = pisoPorModelo(
      parseada({
        success_list: [],
        failure_list: [{ item_id: ITEM_ID, failed_reason: 'Product not found' }],
      }),
      ITEM_ID,
    );

    expect(pisos.size).toBe(0);
  });

  it('promotion: [] ⇒ mapa vazio — a forma que a sonda mediu para "sem promoção"', () => {
    const pisos = pisoPorModelo(parseada(sucesso([])), ITEM_ID);

    expect(pisos.size).toBe(0);
  });

  it('promotion ausente ou null ⇒ mapa vazio', () => {
    const ausente = pisoPorModelo(crua({ success_list: [{ item_id: ITEM_ID }] }), ITEM_ID);
    const nulo = pisoPorModelo(
      crua({ success_list: [{ item_id: ITEM_ID, promotion: null }] }),
      ITEM_ID,
    );

    expect(ausente.size).toBe(0);
    expect(nulo.size).toBe(0);
  });

  it('o item em NENHUMA das duas listas ⇒ mapa vazio', () => {
    const pisos = pisoPorModelo(parseada({ success_list: [], failure_list: [] }), ITEM_ID);

    expect(pisos.size).toBe(0);
  });

  it('⚠️ uma leitura vazia é um mapa VAZIO, jamais um piso 0 para o modelo', () => {
    const pisos = pisoPorModelo(parseada(sucesso([])), ITEM_ID);

    expect(pisos.get(MODELO)).toBeUndefined();
    expect(pisos.get(SEM_VARIACAO)).toBeUndefined();
    // E o que o remetente faz com isso: `aplicarPiso` com `undefined ?? null`
    // não mexe em nada — a decisão terminal é dele, não um clamp para zero.
    expect(aplicarPiso(4, pisos.get(MODELO) ?? null)).toEqual({ valor: 4, clampado: false });
  });

  it('um corpo ilegível não LANÇA — ele responde um mapa vazio', () => {
    expect(pisoPorModelo(crua({}), ITEM_ID).size).toBe(0);
    expect(pisoPorModelo(crua({ success_list: null }), ITEM_ID).size).toBe(0);
    expect(pisoPorModelo(crua({ success_list: 'nada' }), ITEM_ID).size).toBe(0);
    expect(pisoPorModelo(crua({ success_list: [null, 7] }), ITEM_ID).size).toBe(0);
    expect(
      pisoPorModelo(crua({ success_list: [{ item_id: ITEM_ID, promotion: [null] }] }), ITEM_ID)
        .size,
    ).toBe(0);
  });

  it('um total_reserved_stock não numérico não rende piso — nem 0, nem NaN', () => {
    const pisos = pisoPorModelo(
      crua({
        success_list: [
          {
            item_id: ITEM_ID,
            promotion: [
              {
                model_id: MODELO,
                promotion_stock_info_v2: { summary_info: { total_reserved_stock: null } },
              },
            ],
          },
        ],
      }),
      ITEM_ID,
    );

    expect(pisos.size).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*                                aplicarPiso                                  */
/* -------------------------------------------------------------------------- */

describe('aplicarPiso — o clamp sobe e nunca desce', () => {
  it('⚠️ PAR: um piso ACIMA sobe a quantidade e marca clampado', () => {
    expect(aplicarPiso(3, 10)).toEqual({ valor: 10, clampado: true });
    expect(aplicarPiso(0, 1)).toEqual({ valor: 1, clampado: true });
  });

  it('⚠️ NEAR-MISS: um piso IGUAL não é um clamp — o pedido já satisfaz a desigualdade', () => {
    expect(aplicarPiso(10, 10)).toEqual({ valor: 10, clampado: false });
    expect(aplicarPiso(0, 0)).toEqual({ valor: 0, clampado: false });
  });

  it('⚠️ o piso NUNCA baixa a quantidade — 100 com piso 5 continua 100', () => {
    expect(aplicarPiso(100, 5)).toEqual({ valor: 100, clampado: false });
    // O mutante do trilho de segurança virando teto de vendas.
    expect(aplicarPiso(100, 5).valor).not.toBe(5);
  });

  it('⚠️ NEAR-MISS: um piso NEGATIVO não muda nada — a desigualdade da faq 59 vai a negativo', () => {
    expect(aplicarPiso(3, -7)).toEqual({ valor: 3, clampado: false });
    expect(aplicarPiso(0, -1)).toEqual({ valor: 0, clampado: false });
  });

  it('um piso null não muda nada — "a página não falou" não é uma instrução', () => {
    expect(aplicarPiso(3, null)).toEqual({ valor: 3, clampado: false });
  });

  it('um piso zero não muda nada', () => {
    expect(aplicarPiso(3, 0)).toEqual({ valor: 3, clampado: false });
  });

  it('um piso NaN ou infinito não muda nada — nunca um NaN vai para o corpo', () => {
    expect(aplicarPiso(3, Number.NaN)).toEqual({ valor: 3, clampado: false });
    expect(aplicarPiso(3, Number.POSITIVE_INFINITY)).toEqual({ valor: 3, clampado: false });
  });

  it('clampado é verdadeiro SÓ quando o valor se mexeu — os três casos lado a lado', () => {
    expect(aplicarPiso(3, 10).clampado).toBe(true);
    expect(aplicarPiso(10, 10).clampado).toBe(false);
    expect(aplicarPiso(30, 10).clampado).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                               ehRecusaDePiso                                */
/* -------------------------------------------------------------------------- */

/** As quatro grafias da própria lista de erros da página, verbatim. */
const RECUSAS_DE_PISO = [
  'Total stock must be more than reserved stock.',
  'Stock should be larger than reserved stock.',
  'Can not update item with stock less than reserved stock',
  'Can not update item with stock less than reserve stock',
] as const;

describe('ehRecusaDePiso — a agulha do braço A', () => {
  it('⚠️ PAR: as QUATRO grafias da página casam — "reserved stock" e "reserve stock"', () => {
    for (const mensagem of RECUSAS_DE_PISO) {
      expect(ehRecusaDePiso(mensagem), mensagem).toBe(true);
    }
  });

  it('⚠️ PAR: a caixa é foldada — MAIÚSCULAS e Title Case casam igual', () => {
    expect(ehRecusaDePiso('TOTAL STOCK MUST BE MORE THAN RESERVED STOCK.')).toBe(true);
    expect(ehRecusaDePiso('Stock Should Be Larger Than Reserved Stock.')).toBe(true);
  });

  it('⚠️ NEAR-MISS: a recusa de location_id e a de férias NÃO casam — as duas falam de stock', () => {
    expect(ehRecusaDePiso('Lack of location_id, please double check.')).toBe(false);
    expect(ehRecusaDePiso('Cannot change stock in holiday mode.')).toBe(false);
  });

  it('⚠️ NEAR-MISS: "stock" sozinho, "reserve" sozinho e a string vazia NÃO casam', () => {
    expect(ehRecusaDePiso('Stock is invalid.')).toBe(false);
    expect(ehRecusaDePiso('The reserve is high.')).toBe(false);
    expect(ehRecusaDePiso('')).toBe(false);
  });

  it('é CEGA ao código — a mesma frase sob error.param, error_auth ou error_param casa igual', () => {
    // A função só recebe a mensagem; nenhum código a alcança. O braço A é o
    // primeiro da escada exatamente por isso: `error.param` vira `param`.
    const frase = 'Can not update item with stock less than reserved stock';
    expect(ehRecusaDePiso(frase)).toBe(true);
    expect(ehRecusaDePiso(`error.param: ${frase}`)).toBe(true);
    expect(ehRecusaDePiso(`error_auth: ${frase}`)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*                              pisoAcimaDaBanda                               */
/* -------------------------------------------------------------------------- */

describe('pisoAcimaDaBanda — o pedido impossível', () => {
  it('⚠️ PAR: um piso acima da banda é impossível ⇒ true', () => {
    expect(pisoAcimaDaBanda(60, 50)).toBe(true);
  });

  it('⚠️ NEAR-MISS: um piso IGUAL ao máximo cabe ⇒ false (a comparação é > estrita)', () => {
    expect(pisoAcimaDaBanda(50, 50)).toBe(false);
    expect(pisoAcimaDaBanda(49, 50)).toBe(false);
  });

  it('sem banda resolvida (null) ⇒ false — uma banda desconhecida não fabrica recusa', () => {
    expect(pisoAcimaDaBanda(60, null)).toBe(false);
  });

  it('⚠️ PAR: a banda null e a banda INFINITA respondem o mesmo — as duas grafias de "sem banda"', () => {
    expect(pisoAcimaDaBanda(60, null)).toBe(false);
    expect(pisoAcimaDaBanda(60, Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('sem piso (null) ⇒ false — não há nada de impossível a declarar', () => {
    expect(pisoAcimaDaBanda(null, 50)).toBe(false);
    expect(pisoAcimaDaBanda(null, null)).toBe(false);
  });

  it('um NaN de qualquer lado ⇒ false', () => {
    expect(pisoAcimaDaBanda(Number.NaN, 50)).toBe(false);
    expect(pisoAcimaDaBanda(60, Number.NaN)).toBe(false);
  });

  it('⚠️ é uma RECUSA, não um segundo clamp: a banda nunca aparece em aplicarPiso', () => {
    // Piso 60, banda 50: o remetente recusa sem chamar. Se alguém "resolvesse"
    // baixando para a banda, o ERP publicaria 50 — um número que não tem E que
    // continua abaixo do piso.
    expect(pisoAcimaDaBanda(60, 50)).toBe(true);
    expect(aplicarPiso(3, 60)).toEqual({ valor: 60, clampado: true });
  });
});

/* -------------------------------------------------------------------------- */
/*                            a disciplina do módulo                           */
/* -------------------------------------------------------------------------- */

describe('a disciplina do módulo', () => {
  const fonte = readFileSync(
    fileURLToPath(new URL('./reservaPromocao.ts', import.meta.url)),
    'utf8',
  );
  /** A fonte sem comentários — o que EXECUTA. */
  const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('o piso combina por MÁXIMO — a soma não existe no código', () => {
    // ÂNCORA: o arquivo foi mesmo lido e carrega mesmo a combinação.
    expect(codigo).toContain('Math.max(anterior, reservado)');
    // Nenhuma soma sobre pisos. `+=` e `anterior + reservado` são as duas
    // grafias do mutante.
    expect(codigo).not.toMatch(/anterior\s*\+/);
    expect(codigo).not.toMatch(/\+=/);
  });

  it('⚠️ há UM leitor das duas posições — o módulo nunca abre a caixa do pacote', () => {
    expect(codigo).toContain('reservadoDaPromocao(');
    expect(codigo).not.toMatch(/promotion_stock_info_v2/);
    expect(codigo).not.toMatch(/summary_info/);
    expect(codigo).not.toMatch(/total_reserved_stock/);
    // ...e o docblock explica por quê.
    expect(fonte).toContain('promotion_stock_info_v2');
  });

  it('⚠️ nada filtra por staging — o nome do campo não aparece no código', () => {
    expect(codigo).not.toMatch(/promotion_staging/);
    expect(codigo).not.toMatch(/upcoming/);
    expect(codigo).not.toMatch(/ongoing/);
    // A prosa carrega a regra.
    expect(fonte).toContain('upcoming');
  });

  it('o clamp é um Math.max — nunca um Math.min nem uma atribuição', () => {
    expect(codigo).toContain('Math.max(quantidade, piso)');
    expect(codigo).not.toMatch(/Math\.min/);
  });

  it('⚠️ o docblock separa a reserva da Shopee da reserva do ERP (a linha do inventário)', () => {
    // A mesma frase é a entrada de `reserva-arithmetic-inventory.test.js`: sem
    // ela o arquivo sai do inventário e a distinção vira folclore.
    expect(fonte).toContain('quantidadeReservada');
    expect(fonte).toContain('SUBTRACTED');
    expect(codigo).not.toMatch(/quantidadeReservada/);
  });

  it('o módulo é PURO — sem Firestore, sem relógio, sem chamada à Shopee', () => {
    expect(codigo).not.toMatch(/firestore/i);
    expect(codigo).not.toMatch(/\bfetch\(/);
    expect(codigo).not.toMatch(/\bnew Date\b/);
    // Uma única importação, e ela é de tipos e de um leitor puro.
    expect(fonte.match(/^import /gm)?.length ?? 0).toBe(1);
  });
});
