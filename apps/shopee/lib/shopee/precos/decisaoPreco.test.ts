import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { PRICE_LIST_SO_A_DIFERENCA, SHOPEE_PRECO_MODEL_ID_SEM_MODELO } from './constantesPreco';
import {
  codigoDoErpDePreco,
  decidirEnvioDePreco,
  montarCorpoDePreco,
  type DecisaoDePreco,
  type LinhaModeloPreco,
} from './decisaoPreco';
import { MOTIVO_PRECO_SHOPEE, type MotivoPrecoShopee } from './errosPreco';
import type { LeituraDePreco, ModeloLido } from './leituraPreco';
import type { AlvoDeModelo, ItemDePreco } from './planoPreco';

/* -------------------------------------------------------------------------- */
/*                                  fixtures                                   */
/* -------------------------------------------------------------------------- */

const ITEM = 2_500_139_861;
const MODELO_A = 2_000_458_802;
const MODELO_B = 2_000_458_803;
const MODELO_C = 2_000_458_804;
/** A Shopee model with NO ERP child — never addressed, but judged by the ratio. */
const MODELO_SOLTO = 2_000_458_899;

const BR = { moeda: 'BRL', multiplo: 4 } as const;
const SG = { moeda: 'SGD', multiplo: 5 } as const;
const GUARDA = { baixarPreco: false } as const;
const SEM_GUARDA = { baixarPreco: true } as const;

const M = MOTIVO_PRECO_SHOPEE;

/** This module's raw TEXT — its purity is measured on it. */
const FONTE = readFileSync(fileURLToPath(new URL('./decisaoPreco.ts', import.meta.url)), 'utf8');

/** A no-model item priced at `precoAlvo`. */
function itemSemModelos(precoAlvo: number | null): ItemDePreco {
  return {
    produtoId: 'p-ancora',
    linkDocId: 'link-1',
    itemId: ITEM,
    semModelos: true,
    alvos: [
      {
        modelId: SHOPEE_PRECO_MODEL_ID_SEM_MODELO,
        produtoId: 'p-ancora',
        varLinkDocId: null,
        precoAlvo,
      },
    ],
  };
}

/** A has-model item: one alvo per `[modelId, precoAlvo]`. */
function itemComModelos(alvos: readonly (readonly [number, number | null])[]): ItemDePreco {
  return {
    produtoId: 'p-ancora',
    linkDocId: 'link-1',
    itemId: ITEM,
    semModelos: false,
    alvos: alvos.map(
      ([modelId, precoAlvo]): AlvoDeModelo => ({
        modelId,
        produtoId: `p-filho-${String(modelId)}`,
        varLinkDocId: `var-${String(modelId)}`,
        precoAlvo,
      }),
    ),
  };
}

/** One fresh model. */
function lido(
  modelId: number,
  precoAnterior: number | null,
  moeda: string | null = 'BRL',
): ModeloLido {
  return { modelId, precoAnterior, moeda, status: 'MODEL_NORMAL' };
}

/** A no-model listing's read. */
function leituraSemModelos(
  precoAnterior: number | null,
  over: Partial<Omit<LeituraDePreco, 'modelos'>> & { moeda?: string | null } = {},
): LeituraDePreco {
  return {
    itemStatus: over.itemStatus === undefined ? 'NORMAL' : over.itemStatus,
    temModelos: over.temModelos ?? false,
    modelos: [
      {
        modelId: SHOPEE_PRECO_MODEL_ID_SEM_MODELO,
        precoAnterior,
        moeda: over.moeda === undefined ? 'BRL' : over.moeda,
        status: null,
      },
    ],
  };
}

/** A has-model listing's read. */
function leituraComModelos(
  modelos: readonly ModeloLido[],
  over: Partial<Omit<LeituraDePreco, 'modelos'>> = {},
): LeituraDePreco {
  return {
    itemStatus: over.itemStatus === undefined ? 'NORMAL' : over.itemStatus,
    temModelos: over.temModelos ?? true,
    modelos,
  };
}

/** `[modelId, resultado, motivo]` per row — the compact shape most tests assert. */
function resumo(d: DecisaoDePreco) {
  return d.linhas.map((l) => [l.modelId, l.resultado, l.motivo]);
}

let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
});

/* -------------------------------------------------------------------------- */
/*                               G2 — the status                              */
/* -------------------------------------------------------------------------- */

describe('G2 — o status FRESCO do anúncio', () => {
  it('PAR — BANNED, REVIEWING e os dois DELETE pulam o item inteiro, cada linha com o mesmo slug', () => {
    const casos: readonly (readonly [string, MotivoPrecoShopee])[] = [
      ['BANNED', M.anuncioBanido],
      ['REVIEWING', M.anuncioEmRevisao],
      ['SELLER_DELETE', M.anuncioRemovido],
      ['SHOPEE_DELETE', M.anuncioRemovido],
    ];
    for (const [itemStatus, motivo] of casos) {
      const d = decidirEnvioDePreco(
        itemComModelos([
          [MODELO_A, 20],
          [MODELO_B, 30],
        ]),
        leituraComModelos([lido(MODELO_A, 10), lido(MODELO_B, 10)], { itemStatus }),
        BR,
        GUARDA,
      );
      expect(d).toMatchObject({ tipo: 'pular', motivo });
      expect(resumo(d)).toEqual([
        [MODELO_A, 'pulado', motivo],
        [MODELO_B, 'pulado', motivo],
      ]);
    }
  });

  it('⚠️ (M29) — o status vem ANTES da igualdade: banido e com o preço igual ⇒ `anuncio-banido`, nunca `preco-igual`', () => {
    const d = decidirEnvioDePreco(
      itemSemModelos(10),
      leituraSemModelos(10, { itemStatus: 'BANNED' }),
      BR,
      GUARDA,
    );
    expect(d).toMatchObject({ tipo: 'pular', motivo: M.anuncioBanido });
  });

  it('⚠️ QUASE-IGUAL (M37) — um status DESCONHECIDO (`FOO`) ENVIA, com UM aviso no log; `banned` minúsculo também envia (código exato)', () => {
    for (const itemStatus of ['FOO', 'banned']) {
      warn.mockClear();
      const d = decidirEnvioDePreco(
        itemSemModelos(12),
        leituraSemModelos(10, { itemStatus }),
        BR,
        GUARDA,
      );
      expect(d.tipo).toBe('enviar');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[1]).toEqual({ itemId: ITEM, itemStatus });
    }
  });

  it('PAR — NORMAL, UNLIST e um status ausente (`null`) enviam SEM aviso nenhum', () => {
    for (const itemStatus of ['NORMAL', 'UNLIST', null]) {
      const d = decidirEnvioDePreco(
        itemSemModelos(12),
        leituraSemModelos(10, { itemStatus }),
        BR,
        GUARDA,
      );
      expect(d.tipo).toBe('enviar');
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('um status com nome de chave herdada (`constructor`) não é tabela: envia, com aviso', () => {
    const d = decidirEnvioDePreco(
      itemSemModelos(12),
      leituraSemModelos(10, { itemStatus: 'constructor' }),
      BR,
      GUARDA,
    );
    expect(d.tipo).toBe('enviar');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                         G3 / G3b — the model structure                      */
/* -------------------------------------------------------------------------- */

describe('G3 — a forma dos modelos que o plano viu contra a que a Shopee tem AGORA', () => {
  it('PAR — item SEM modelos contra um anúncio que agora TEM modelos ⇒ `falhar forma-de-modelo-divergente`, com o código `erp:`', () => {
    const d = decidirEnvioDePreco(
      itemSemModelos(12),
      leituraComModelos([lido(MODELO_A, 10)]),
      BR,
      GUARDA,
    );
    expect(d).toEqual({
      tipo: 'falhar',
      motivo: M.formaDeModeloDivergente,
      codigoErp: 'erp:forma-de-modelo-divergente',
      linhas: [
        {
          modelId: SHOPEE_PRECO_MODEL_ID_SEM_MODELO,
          produtoId: 'p-ancora',
          varLinkDocId: null,
          precoAlvo: 12,
          precoAnterior: null,
          resultado: 'falha',
          motivo: M.formaDeModeloDivergente,
          codigo: null,
        },
      ],
    });
  });

  it('PAR (espelho) — item COM modelos contra um anúncio que perdeu os modelos ⇒ a mesma recusa, em TODAS as linhas', () => {
    const d = decidirEnvioDePreco(
      itemComModelos([
        [MODELO_A, 12],
        [MODELO_B, 13],
      ]),
      leituraSemModelos(10),
      BR,
      GUARDA,
    );
    expect(d).toMatchObject({ tipo: 'falhar', motivo: M.formaDeModeloDivergente });
    expect(resumo(d)).toEqual([
      [MODELO_A, 'falha', M.formaDeModeloDivergente],
      [MODELO_B, 'falha', M.formaDeModeloDivergente],
    ]);
  });

  it('QUASE-IGUAL — as formas batendo (sem × sem, com × com) passam e ENVIAM', () => {
    expect(decidirEnvioDePreco(itemSemModelos(12), leituraSemModelos(10), BR, GUARDA).tipo).toBe(
      'enviar',
    );
    expect(
      decidirEnvioDePreco(
        itemComModelos([[MODELO_A, 12]]),
        leituraComModelos([lido(MODELO_A, 10)]),
        BR,
        GUARDA,
      ).tipo,
    ).toBe('enviar');
  });
});

describe('G3b — um modelo vinculado que a leitura fresca não traz', () => {
  it('⚠️ (M39) — só a linha AUSENTE vira `pulado modelo-ausente`; a vizinha segue e só ela vai no corpo', () => {
    const d = decidirEnvioDePreco(
      itemComModelos([
        [MODELO_A, 12],
        [MODELO_B, 13],
      ]),
      leituraComModelos([lido(MODELO_B, 10)]),
      BR,
      GUARDA,
    );
    expect(d.tipo).toBe('enviar');
    expect(resumo(d)).toEqual([
      [MODELO_A, 'pulado', M.modeloAusente],
      [MODELO_B, 'enviado', null],
    ]);
    expect(d.tipo === 'enviar' && d.priceList).toEqual([
      { model_id: MODELO_B, original_price: 13 },
    ]);
    expect(d.linhas[0]?.precoAnterior).toBeNull();
  });

  it('todos os vinculados ausentes ⇒ o item PULA com `modelo-ausente`, sem corpo', () => {
    const d = decidirEnvioDePreco(
      itemComModelos([
        [MODELO_A, 12],
        [MODELO_B, 13],
      ]),
      leituraComModelos([lido(MODELO_SOLTO, 10)]),
      BR,
      GUARDA,
    );
    expect(d).toMatchObject({ tipo: 'pular', motivo: M.modeloAusente });
    expect(resumo(d)).toEqual([
      [MODELO_A, 'pulado', M.modeloAusente],
      [MODELO_B, 'pulado', M.modeloAusente],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                               G4 — the currency                             */
/* -------------------------------------------------------------------------- */

describe('G4 — a moeda do anúncio contra a da conta', () => {
  it('⚠️ PAR (M38) — `SGD` fresco numa conta BR ⇒ `falhar moeda-divergente` com `erp:`; a linha AUSENTE continua `modelo-ausente`', () => {
    const d = decidirEnvioDePreco(
      itemComModelos([
        [MODELO_A, 12],
        [MODELO_B, 13],
      ]),
      leituraComModelos([lido(MODELO_A, 10, 'SGD')]),
      BR,
      GUARDA,
    );
    expect(d).toMatchObject({
      tipo: 'falhar',
      motivo: M.moedaDivergente,
      codigoErp: 'erp:moeda-divergente',
    });
    expect(resumo(d)).toEqual([
      [MODELO_A, 'falha', M.moedaDivergente],
      [MODELO_B, 'pulado', M.modeloAusente],
    ]);
  });

  it('⚠️ a moeda de um modelo SEM filho no ERP também recusa — é a moeda do ANÚNCIO que se julga', () => {
    const d = decidirEnvioDePreco(
      itemComModelos([[MODELO_A, 12]]),
      leituraComModelos([lido(MODELO_A, 10, 'BRL'), lido(MODELO_SOLTO, 10, 'SGD')]),
      BR,
      GUARDA,
    );
    expect(d).toMatchObject({ tipo: 'falhar', motivo: M.moedaDivergente });
  });

  it('QUASE-IGUAL — uma moeda AUSENTE (`null`) não recusa e envia; `brl` minúsculo RECUSA (comparação exata)', () => {
    expect(
      decidirEnvioDePreco(itemSemModelos(12), leituraSemModelos(10, { moeda: null }), BR, GUARDA)
        .tipo,
    ).toBe('enviar');
    expect(
      decidirEnvioDePreco(itemSemModelos(12), leituraSemModelos(10, { moeda: 'brl' }), BR, GUARDA),
    ).toMatchObject({ tipo: 'falhar', motivo: M.moedaDivergente });
  });

  it('a moeda vem do CONTEXTO: o mesmo `SGD` passa numa conta SG', () => {
    expect(
      decidirEnvioDePreco(itemSemModelos(12), leituraSemModelos(10, { moeda: 'SGD' }), SG, GUARDA)
        .tipo,
    ).toBe('enviar');
  });
});

/* -------------------------------------------------------------------------- */
/*                         G5 — no price, or already equal                     */
/* -------------------------------------------------------------------------- */

describe('G5 — sem preço-alvo, ou o preço já é o mesmo (a dobra `mesmoPrecoEmReais`)', () => {
  it('⚠️ PAR — atual `10.004` e alvo `10` caem no MESMO centavo ⇒ `pulado preco-igual`, sem corpo', () => {
    const d = decidirEnvioDePreco(itemSemModelos(10), leituraSemModelos(10.004), BR, GUARDA);
    expect(d).toMatchObject({ tipo: 'pular', motivo: M.precoIgual });
    expect(resumo(d)).toEqual([[SHOPEE_PRECO_MODEL_ID_SEM_MODELO, 'pulado', M.precoIgual]]);
  });

  it('⚠️ QUASE-IGUAL — atual `49.99` e alvo `50` ficam a UM centavo ⇒ ENVIADO (uma dobra larga demais engoliria a edição)', () => {
    const d = decidirEnvioDePreco(itemSemModelos(50), leituraSemModelos(49.99), BR, GUARDA);
    expect(d).toMatchObject({
      tipo: 'enviar',
      priceList: [{ model_id: SHOPEE_PRECO_MODEL_ID_SEM_MODELO, original_price: 50 }],
    });
  });

  it('um alvo SEM preço ⇒ aquela linha `pulado preco-nao-encontrado`; a vizinha com preço segue', () => {
    const d = decidirEnvioDePreco(
      itemComModelos([
        [MODELO_A, null],
        [MODELO_B, 13],
      ]),
      leituraComModelos([lido(MODELO_A, 10), lido(MODELO_B, 10)]),
      BR,
      GUARDA,
    );
    expect(resumo(d)).toEqual([
      [MODELO_A, 'pulado', M.precoNaoEncontrado],
      [MODELO_B, 'enviado', null],
    ]);
  });

  it('nada sobra: `preco-igual` domina `preco-nao-encontrado`; só sem-preço ⇒ `preco-nao-encontrado`', () => {
    const igualESemPreco = decidirEnvioDePreco(
      itemComModelos([
        [MODELO_A, null],
        [MODELO_B, 10],
      ]),
      leituraComModelos([lido(MODELO_A, 10), lido(MODELO_B, 10)]),
      BR,
      GUARDA,
    );
    expect(igualESemPreco).toMatchObject({ tipo: 'pular', motivo: M.precoIgual });

    const soSemPreco = decidirEnvioDePreco(itemSemModelos(null), leituraSemModelos(10), BR, GUARDA);
    expect(soSemPreco).toMatchObject({ tipo: 'pular', motivo: M.precoNaoEncontrado });
  });

  it('`preco-nao-encontrado` domina `modelo-ausente` quando nada sobra', () => {
    const d = decidirEnvioDePreco(
      itemComModelos([
        [MODELO_A, 12],
        [MODELO_B, null],
      ]),
      leituraComModelos([lido(MODELO_B, 10)]),
      BR,
      GUARDA,
    );
    expect(d).toMatchObject({ tipo: 'pular', motivo: M.precoNaoEncontrado });
  });
});

/* -------------------------------------------------------------------------- */
/*                            G6 — the decrease guard                          */
/* -------------------------------------------------------------------------- */

describe('G6 — a guarda de redução (desligada por `baixarPreco`)', () => {
  it('⚠️ (M30) — preço atual ILEGÍVEL com a guarda ligada ⇒ `pulado preco-atual-ilegivel`, sem corpo', () => {
    const d = decidirEnvioDePreco(itemSemModelos(12), leituraSemModelos(null), BR, GUARDA);
    expect(d).toMatchObject({ tipo: 'pular', motivo: M.precoAtualIlegivel });
    expect(d).not.toHaveProperty('priceList');
  });

  it('⚠️ PAR — alvo `9.99` sob atual `10` ⇒ `pulado preco-menor-bloqueado`', () => {
    const d = decidirEnvioDePreco(itemSemModelos(9.99), leituraSemModelos(10), BR, GUARDA);
    expect(d).toMatchObject({ tipo: 'pular', motivo: M.precoMenorBloqueado });
  });

  it('⚠️ QUASE-IGUAL — alvo `10.01` sobre atual `10` (um centavo ACIMA) ⇒ enviado', () => {
    const d = decidirEnvioDePreco(itemSemModelos(10.01), leituraSemModelos(10), BR, GUARDA);
    expect(d.tipo).toBe('enviar');
  });

  it('⚠️ (M31) — com `baixarPreco` a redução É enviada, e o atual ilegível também', () => {
    expect(
      decidirEnvioDePreco(itemSemModelos(9.99), leituraSemModelos(10), BR, SEM_GUARDA),
    ).toMatchObject({
      tipo: 'enviar',
      priceList: [{ model_id: SHOPEE_PRECO_MODEL_ID_SEM_MODELO, original_price: 9.99 }],
    });
    expect(
      decidirEnvioDePreco(itemSemModelos(12), leituraSemModelos(null), BR, SEM_GUARDA),
    ).toMatchObject({
      tipo: 'enviar',
      priceList: [{ model_id: SHOPEE_PRECO_MODEL_ID_SEM_MODELO, original_price: 12 }],
    });
  });

  it('`baixarPreco` não fura a IGUALDADE: igual continua `preco-igual`', () => {
    const d = decidirEnvioDePreco(itemSemModelos(10), leituraSemModelos(10), BR, SEM_GUARDA);
    expect(d).toMatchObject({ tipo: 'pular', motivo: M.precoIgual });
  });

  it('nada sobra: `preco-menor-bloqueado` > `preco-atual-ilegivel` > `preco-igual`', () => {
    const tres = decidirEnvioDePreco(
      itemComModelos([
        [MODELO_A, 10],
        [MODELO_B, 12],
        [MODELO_C, 5],
      ]),
      leituraComModelos([lido(MODELO_A, 10), lido(MODELO_B, null), lido(MODELO_C, 10)]),
      BR,
      GUARDA,
    );
    expect(tres).toMatchObject({ tipo: 'pular', motivo: M.precoMenorBloqueado });
    expect(resumo(tres)).toEqual([
      [MODELO_A, 'pulado', M.precoIgual],
      [MODELO_B, 'pulado', M.precoAtualIlegivel],
      [MODELO_C, 'pulado', M.precoMenorBloqueado],
    ]);

    const dois = decidirEnvioDePreco(
      itemComModelos([
        [MODELO_A, 10],
        [MODELO_B, 12],
      ]),
      leituraComModelos([lido(MODELO_A, 10), lido(MODELO_B, null)]),
      BR,
      GUARDA,
    );
    expect(dois).toMatchObject({ tipo: 'pular', motivo: M.precoAtualIlegivel });
  });

  it('um modelo barrado e outro que sobe ⇒ ENVIA só o que sobe; o barrado fica `pulado` na linha', () => {
    const d = decidirEnvioDePreco(
      itemComModelos([
        [MODELO_A, 8],
        [MODELO_B, 12],
      ]),
      leituraComModelos([lido(MODELO_A, 10), lido(MODELO_B, 10)]),
      BR,
      GUARDA,
    );
    expect(d).toMatchObject({
      tipo: 'enviar',
      priceList: [{ model_id: MODELO_B, original_price: 12 }],
    });
    expect(resumo(d)).toEqual([
      [MODELO_A, 'pulado', M.precoMenorBloqueado],
      [MODELO_B, 'enviado', null],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                                 G7 — the ratio                              */
/* -------------------------------------------------------------------------- */

describe('G7 — a razão máx/mín entre as variações DEPOIS da escrita', () => {
  it('⚠️ PAR (M33) — BR, exatamente 4× (`40.00` / `10.00`) PASSA', () => {
    const d = decidirEnvioDePreco(
      itemComModelos([
        [MODELO_A, 40],
        [MODELO_B, 10],
      ]),
      leituraComModelos([lido(MODELO_A, 30), lido(MODELO_B, 9)]),
      BR,
      GUARDA,
    );
    expect(d.tipo).toBe('enviar');
  });

  it('⚠️ QUASE-IGUAL (M33) — BR, `40.01` / `10.00` RECUSA: só as linhas que iriam são `falha`, com `erp:`', () => {
    const d = decidirEnvioDePreco(
      itemComModelos([
        [MODELO_A, 40.01],
        [MODELO_B, 10],
        [MODELO_C, 20],
      ]),
      leituraComModelos([lido(MODELO_A, 30), lido(MODELO_B, 9), lido(MODELO_C, 20)]),
      BR,
      GUARDA,
    );
    expect(d).toMatchObject({
      tipo: 'falhar',
      motivo: M.razaoDePrecosExcedida,
      codigoErp: 'erp:razao-de-precos-excedida',
    });
    expect(resumo(d)).toEqual([
      [MODELO_A, 'falha', M.razaoDePrecosExcedida],
      [MODELO_B, 'falha', M.razaoDePrecosExcedida],
      [MODELO_C, 'pulado', M.precoIgual],
    ]);
  });

  it('⚠️ PAR (M34) — SG, exatamente 5× (`50.00` / `10.00`) PASSA; o MESMO par numa conta BR recusa', () => {
    const item = itemComModelos([
      [MODELO_A, 50],
      [MODELO_B, 10],
    ]);
    const leitura = leituraComModelos([lido(MODELO_A, 40, 'SGD'), lido(MODELO_B, 9, 'SGD')]);
    expect(decidirEnvioDePreco(item, leitura, SG, GUARDA).tipo).toBe('enviar');
    const br = leituraComModelos([lido(MODELO_A, 40), lido(MODELO_B, 9)]);
    expect(decidirEnvioDePreco(item, br, BR, GUARDA)).toMatchObject({
      tipo: 'falhar',
      motivo: M.razaoDePrecosExcedida,
    });
  });

  it('⚠️ QUASE-IGUAL (M34) — SG, `50.01` / `10.00` RECUSA', () => {
    const d = decidirEnvioDePreco(
      itemComModelos([
        [MODELO_A, 50.01],
        [MODELO_B, 10],
      ]),
      leituraComModelos([lido(MODELO_A, 40, 'SGD'), lido(MODELO_B, 9, 'SGD')]),
      SG,
      GUARDA,
    );
    expect(d).toMatchObject({ tipo: 'falhar', motivo: M.razaoDePrecosExcedida });
  });

  it('⚠️ a conta é em CENTAVOS inteiros: SG `1.80` / `0.36` (exatamente 5×) passa, onde `5 × 0.36` em ponto flutuante daria `1.7999999999999998`', () => {
    const d = decidirEnvioDePreco(
      itemComModelos([
        [MODELO_A, 1.8],
        [MODELO_B, 0.36],
      ]),
      leituraComModelos([lido(MODELO_A, 1, 'SGD'), lido(MODELO_B, 0.3, 'SGD')]),
      SG,
      SEM_GUARDA,
    );
    expect(d.tipo).toBe('enviar');
  });

  it('⚠️ PAR (M32, probe P11b) — um irmão NÃO enviado a `50` (igual) ao lado de um enviado a `10` RECUSA o item', () => {
    const d = decidirEnvioDePreco(
      itemComModelos([
        [MODELO_A, 50],
        [MODELO_B, 10],
      ]),
      leituraComModelos([lido(MODELO_A, 50), lido(MODELO_B, 12)]),
      BR,
      SEM_GUARDA,
    );
    expect(d).toMatchObject({ tipo: 'falhar', motivo: M.razaoDePrecosExcedida });
    expect(resumo(d)).toEqual([
      [MODELO_A, 'pulado', M.precoIgual],
      [MODELO_B, 'falha', M.razaoDePrecosExcedida],
    ]);
  });

  it('⚠️ QUASE-IGUAL (M32) — o mesmo irmão não enviado a `40` (dentro de 4×) deixa o enviado a `10` PASSAR', () => {
    const d = decidirEnvioDePreco(
      itemComModelos([
        [MODELO_A, 40],
        [MODELO_B, 10],
      ]),
      leituraComModelos([lido(MODELO_A, 40), lido(MODELO_B, 12)]),
      BR,
      SEM_GUARDA,
    );
    expect(d).toMatchObject({
      tipo: 'enviar',
      priceList: [{ model_id: MODELO_B, original_price: 10 }],
    });
  });

  it('⚠️ um modelo da Shopee SEM filho no ERP entra na razão pelo preço ATUAL', () => {
    const d = decidirEnvioDePreco(
      itemComModelos([[MODELO_A, 10]]),
      leituraComModelos([lido(MODELO_A, 9), lido(MODELO_SOLTO, 45)]),
      BR,
      GUARDA,
    );
    expect(d).toMatchObject({ tipo: 'falhar', motivo: M.razaoDePrecosExcedida });
    expect(resumo(d)).toEqual([[MODELO_A, 'falha', M.razaoDePrecosExcedida]]);
  });

  it('um irmão BARRADO pela guarda de redução entra na razão pelo preço ATUAL, não pelo alvo', () => {
    // A: alvo 5 < atual 50 ⇒ barrado; entra a 50. B sobe para 12 ⇒ 50 / 12 > 4 ⇒ recusa.
    const d = decidirEnvioDePreco(
      itemComModelos([
        [MODELO_A, 5],
        [MODELO_B, 12],
      ]),
      leituraComModelos([lido(MODELO_A, 50), lido(MODELO_B, 11)]),
      BR,
      GUARDA,
    );
    expect(d).toMatchObject({ tipo: 'falhar', motivo: M.razaoDePrecosExcedida });
    expect(resumo(d)).toEqual([
      [MODELO_A, 'pulado', M.precoMenorBloqueado],
      [MODELO_B, 'falha', M.razaoDePrecosExcedida],
    ]);
  });

  it('um preço atual ILEGÍVEL fica FORA da razão, contado num aviso; os demais ainda são julgados', () => {
    const d = decidirEnvioDePreco(
      itemComModelos([[MODELO_A, 12]]),
      leituraComModelos([lido(MODELO_A, 10), lido(MODELO_SOLTO, null), lido(MODELO_C, 20)]),
      BR,
      GUARDA,
    );
    expect(d.tipo).toBe('enviar');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toEqual({ itemId: ITEM, considerados: 2, ilegiveis: 1 });
  });

  it('um item SEM modelos tem um preço só e sempre passa a razão, sem aviso', () => {
    const d = decidirEnvioDePreco(itemSemModelos(999), leituraSemModelos(1), BR, SEM_GUARDA);
    expect(d.tipo).toBe('enviar');
    expect(warn).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*                                 G8 — the body                               */
/* -------------------------------------------------------------------------- */

describe('G8 — o corpo do `update_price`', () => {
  it('⚠️ (M36) — item SEM modelos: exatamente `[{ model_id: 0, original_price }]`, com a chave `model_id` PRESENTE', () => {
    const d = decidirEnvioDePreco(itemSemModelos(12.34), leituraSemModelos(10), BR, GUARDA);
    expect(d.tipo).toBe('enviar');
    if (d.tipo !== 'enviar') return;
    expect(d.priceList).toEqual([{ model_id: 0, original_price: 12.34 }]);
    expect(Object.keys(d.priceList[0] ?? {})).toEqual(['model_id', 'original_price']);
  });

  it('⚠️ PAR (M35, probe P8) — com a constante LIGADA o corpo leva SÓ os modelos que mudam', () => {
    expect(PRICE_LIST_SO_A_DIFERENCA).toBe(true);
    const d = decidirEnvioDePreco(
      itemComModelos([
        [MODELO_A, 10],
        [MODELO_B, 13],
        [MODELO_C, 20],
      ]),
      leituraComModelos([lido(MODELO_A, 10), lido(MODELO_B, 12), lido(MODELO_C, 20)]),
      BR,
      GUARDA,
    );
    expect(d).toMatchObject({
      tipo: 'enviar',
      priceList: [{ model_id: MODELO_B, original_price: 13 }],
    });
    expect(resumo(d)).toEqual([
      [MODELO_A, 'pulado', M.precoIgual],
      [MODELO_B, 'enviado', null],
      [MODELO_C, 'pulado', M.precoIgual],
    ]);
  });

  it('⚠️ QUASE-IGUAL (constante VIRADA, pelo helper) — todo modelo vinculado VIVO vai; o que não muda vai pelo preço ATUAL', () => {
    // A igual, B sobe, C barrado (redução), D sem preço-alvo mas legível, E ausente, F atual ilegível.
    const MODELO_D = 2_000_458_805;
    const MODELO_E = 2_000_458_806;
    const MODELO_F = 2_000_458_807;
    const item = itemComModelos([
      [MODELO_A, 10],
      [MODELO_B, 13],
      [MODELO_C, 5],
      [MODELO_D, null],
      [MODELO_E, 11],
      [MODELO_F, 12],
    ]);
    const d = decidirEnvioDePreco(
      item,
      leituraComModelos([
        lido(MODELO_A, 10),
        lido(MODELO_B, 12),
        lido(MODELO_C, 9),
        lido(MODELO_D, 11),
        lido(MODELO_F, null),
      ]),
      BR,
      GUARDA,
    );
    expect(d.tipo).toBe('enviar');
    expect(montarCorpoDePreco(item, d.linhas, true)).toEqual([
      { model_id: MODELO_B, original_price: 13 },
    ]);
    expect(montarCorpoDePreco(item, d.linhas, false)).toEqual([
      { model_id: MODELO_A, original_price: 10 },
      { model_id: MODELO_B, original_price: 13 },
      // ⚠️ o barrado vai pelo ATUAL 9, NUNCA pelo alvo 5 que a guarda recusou
      { model_id: MODELO_C, original_price: 9 },
      { model_id: MODELO_D, original_price: 11 },
    ]);
  });

  it('a constante VIRADA não muda nada num item sem modelos (não há irmão a preservar)', () => {
    const item = itemSemModelos(12);
    const d = decidirEnvioDePreco(item, leituraSemModelos(10), BR, GUARDA);
    expect(montarCorpoDePreco(item, d.linhas, false)).toEqual([
      { model_id: SHOPEE_PRECO_MODEL_ID_SEM_MODELO, original_price: 12 },
    ]);
    // Uma linha `pulado` sem modelos nunca vira corpo, nem virada.
    const linhaPulada: LinhaModeloPreco = {
      modelId: SHOPEE_PRECO_MODEL_ID_SEM_MODELO,
      produtoId: 'p-ancora',
      varLinkDocId: null,
      precoAlvo: 10,
      precoAnterior: 10,
      resultado: 'pulado',
      motivo: M.precoIgual,
      codigo: null,
    };
    expect(montarCorpoDePreco(item, [linhaPulada], false)).toEqual([]);
  });

  it('virada, uma linha `modelo-ausente` nunca é preservada, mesmo trazendo um preço atual (não há o que preservar na Shopee)', () => {
    const ausente: LinhaModeloPreco = {
      modelId: MODELO_A,
      produtoId: 'p',
      varLinkDocId: 'v',
      precoAlvo: 12,
      precoAnterior: 10,
      resultado: 'pulado',
      motivo: M.modeloAusente,
      codigo: null,
    };
    expect(montarCorpoDePreco({ semModelos: false }, [ausente], false)).toEqual([]);
    expect(
      montarCorpoDePreco({ semModelos: false }, [{ ...ausente, motivo: M.precoIgual }], false),
    ).toEqual([{ model_id: MODELO_A, original_price: 10 }]);
  });

  it('uma linha `enviado` sem preço-alvo é uma decisão impossível: o helper LANÇA em vez de mandar um modelo sem preço', () => {
    const linha: LinhaModeloPreco = {
      modelId: MODELO_A,
      produtoId: 'p',
      varLinkDocId: 'v',
      precoAlvo: null,
      precoAnterior: 10,
      resultado: 'enviado',
      motivo: null,
      codigo: null,
    };
    expect(() => montarCorpoDePreco({ semModelos: false }, [linha], true)).toThrow(
      /sem preço-alvo/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                          the row contract (S1 starts here)                  */
/* -------------------------------------------------------------------------- */

describe('as linhas: UMA por alvo, na MESMA ordem, qualquer que seja a decisão', () => {
  const item = itemComModelos([
    [MODELO_C, 20],
    [MODELO_A, 12],
    [MODELO_B, null],
  ]);
  // Leitura EMBARALHADA e com um modelo a mais: a ordem das linhas é a dos ALVOS.
  const base = [lido(MODELO_B, 10), lido(MODELO_SOLTO, 11), lido(MODELO_A, 10), lido(MODELO_C, 20)];
  const cenarios: readonly (readonly [string, LeituraDePreco, typeof BR, typeof GUARDA])[] = [
    ['pular (status)', leituraComModelos(base, { itemStatus: 'BANNED' }), BR, GUARDA],
    ['falhar (forma)', leituraComModelos(base, { temModelos: false }), BR, GUARDA],
    ['falhar (moeda)', leituraComModelos([...base, lido(MODELO_SOLTO, 1, 'USD')]), BR, GUARDA],
    ['pular (nada sobra)', leituraComModelos([lido(MODELO_A, 12), lido(MODELO_C, 20)]), BR, GUARDA],
    ['falhar (razão)', leituraComModelos([...base, lido(MODELO_SOLTO, 100)]), BR, GUARDA],
    ['enviar', leituraComModelos(base), BR, GUARDA],
  ];

  it.each(cenarios)('%s', (_nome, leitura, ctx, opts) => {
    const d = decidirEnvioDePreco(item, leitura, ctx, opts);
    expect(d.linhas.map((l) => [l.modelId, l.produtoId, l.varLinkDocId, l.precoAlvo])).toEqual(
      item.alvos.map((a) => [a.modelId, a.produtoId, a.varLinkDocId, a.precoAlvo]),
    );
    for (const l of d.linhas) {
      expect(l.codigo).toBeNull();
      expect(l.motivo === null).toBe(l.resultado === 'enviado');
    }
  });

  it('as seis decisões acima são mesmo seis tipos distintos (o cenário não é vácuo)', () => {
    const vistos = cenarios.map(([, leitura, ctx, opts]) => {
      const d = decidirEnvioDePreco(item, leitura, ctx, opts);
      return d.tipo === 'enviar' ? 'enviar' : `${d.tipo}:${d.motivo}`;
    });
    expect(vistos).toEqual([
      `pular:${M.anuncioBanido}`,
      `falhar:${M.formaDeModeloDivergente}`,
      `falhar:${M.moedaDivergente}`,
      `pular:${M.precoIgual}`,
      `falhar:${M.razaoDePrecosExcedida}`,
      'enviar',
    ]);
  });

  it('cada linha carrega o preço ATUAL do seu modelo, lido por `model_id` (o primeiro, se a leitura repetir)', () => {
    const d = decidirEnvioDePreco(
      itemComModelos([
        [MODELO_A, 12],
        [MODELO_B, 13],
      ]),
      leituraComModelos([lido(MODELO_B, 11), lido(MODELO_A, 10), lido(MODELO_A, 99)]),
      BR,
      GUARDA,
    );
    expect(d.linhas.map((l) => l.precoAnterior)).toEqual([10, 11]);
  });
});

/* -------------------------------------------------------------------------- */
/*                               the ERP code, purity                          */
/* -------------------------------------------------------------------------- */

describe('o código `erp:` e a pureza do módulo', () => {
  it('PAR — uma grafia só, `erp:<motivo>`', () => {
    expect(codigoDoErpDePreco(M.razaoDePrecosExcedida)).toBe('erp:razao-de-precos-excedida');
    expect(codigoDoErpDePreco(M.moedaDivergente)).toBe('erp:moeda-divergente');
  });

  it('⚠️ não importa a operação de escrita nem o escritor de vínculos — o dry run do CLI reusa esta decisão', () => {
    const imports = FONTE.split('\n').filter((l) => /^import\b/.test(l) || /from '/.test(l));
    expect(imports.join('\n')).not.toMatch(/linkPreco|enviarPreco|verificacaoPreco|leitorDeBase/);
    expect(FONTE).not.toMatch(/updatePrice|firebase|@delfrance\/data/);
    // Tipos da leitura e do plano entram só como TIPO (apagados na compilação).
    expect(FONTE).toMatch(/import type \{ LeituraDePreco, ModeloLido \} from '\.\/leituraPreco';/);
    expect(FONTE).toMatch(/import type \{ AlvoDeModelo, ItemDePreco \} from '\.\/planoPreco';/);
  });
});
