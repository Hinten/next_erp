import { describe, expect, it } from 'vitest';
import { centavosDeReais } from '@delfrance/core/money';
import * as barrel from './index';
import * as modulo from './precoErpLojaIntegrada';
import {
  ASSINATURA_ENVIO_PRECO_LI_REGEX,
  MOTIVO_RETENCAO_PRECO_LI,
  type AlvoPrecoLi,
  type LeituraTabelaPrecoLi,
  assinaturaEnvioPrecoLi,
  decidirBaixaPrecoLi,
  efetivoPrecoLi,
  leituraTabelaPrecoLi,
  mesmoPrecoLi,
  motivoRetencaoPrecoLiSchema,
  paiDoProdutoErp,
  precoAlvoLi,
  precosDasLeiturasLi,
  promocionalLimpoLi,
  valorPrecoLi,
} from './precoErpLojaIntegrada';
import {
  precoDaTabela,
  precoDoFilhoNaTabela,
  propagaPrecoAosFilhos,
} from './produto/pureLogic/precoCalculo';
import { idDocumentoEstoqueLiSchema } from './sincEstoqueLojaIntegrada';

/**
 * The Loja Integrada price function (master plan step 13): every equal pair and near-miss of the
 * approved plan, where the function is defined, because the send run, the trigger, the reconcile
 * and a `tools/migrations` audit all call it.
 */

const NORMAL = 'tab-normal';
const PROMO = 'tab-promo';

const entrada = (valor: unknown) => ({ valor });

/** A root produto with these `precos`. */
const raiz = (precos: unknown, extra: Record<string, unknown> = {}) => ({
  id: 'r1',
  dados: { paiId: null, precos, ...extra },
});

/** A child of `pai1` with these own `precos`. */
const filho = (precos: unknown, extra: Record<string, unknown> = {}) => ({
  id: 'f1',
  dados: { paiId: 'pai1', precos, ...extra },
});

const alvo = (
  produto: { id: string; dados: Record<string, unknown> },
  pai: Record<string, unknown> | null = null,
  tabelaPromocionalId: string | null = PROMO,
): AlvoPrecoLi => precoAlvoLi({ produto, pai, tabelaNormalId: NORMAL, tabelaPromocionalId });

const enviar = (cheioCentavos: number, promo: { centavos: number } | 'limpar', sinais = {}) => ({
  tipo: 'enviar',
  cheioCentavos,
  promo,
  sinais: { promoIgualNormal: false, promoNaoMenor: false, ...sinais },
});

const retido = (motivo: string) => ({ tipo: 'retido', motivo });

describe('paiDoProdutoErp (who is a root)', () => {
  it('a non-empty string other than the produto’s own id is its parent', () => {
    expect(paiDoProdutoErp({ paiId: 'pai1' }, 'f1')).toBe('pai1');
  });

  it("EQUAL (roots): absent, null, the legacy `''`, a self-parent, any other shape", () => {
    for (const dados of [
      {},
      { paiId: null },
      { paiId: '' },
      { paiId: 'f1' },
      { paiId: 7 },
      { paiId: ['pai1'] },
    ]) {
      expect(paiDoProdutoErp(dados, 'f1'), JSON.stringify(dados)).toBeNull();
    }
  });

  it('⚠️ NEAR-MISS: ids are exact — another case, a space, a path are still parents', () => {
    expect(paiDoProdutoErp({ paiId: 'F1' }, 'f1')).toBe('F1');
    expect(paiDoProdutoErp({ paiId: ' ' }, 'f1')).toBe(' ');
    expect(paiDoProdutoErp({ paiId: 'a/b' }, 'f1')).toBe('a/b');
  });

  it('reads an OWN `paiId` only', () => {
    const herdado = Object.create({ paiId: 'pai1' }) as Record<string, unknown>;
    expect(paiDoProdutoErp(herdado, 'f1')).toBeNull();
  });
});

describe('leituraTabelaPrecoLi (one tabela entry)', () => {
  it('a price is precoDaTabela’s, rounded and positive', () => {
    expect(leituraTabelaPrecoLi({ [NORMAL]: entrada(274.42) }, NORMAL)).toEqual({ valor: 274.42 });
    expect(leituraTabelaPrecoLi({ [NORMAL]: entrada(10.004) }, NORMAL)).toEqual({ valor: 10 });
    expect(leituraTabelaPrecoLi({ [NORMAL]: entrada(0.005) }, NORMAL)).toEqual({ valor: 0.01 });
  });

  it('ausente: no tabela, no map, no OWN key', () => {
    expect(leituraTabelaPrecoLi({ [NORMAL]: entrada(10) }, null)).toBe('ausente');
    expect(leituraTabelaPrecoLi({ [NORMAL]: entrada(10) }, '')).toBe('ausente');
    for (const precos of [null, undefined, 5, 'x', [entrada(10)]]) {
      expect(leituraTabelaPrecoLi(precos, NORMAL), JSON.stringify(precos)).toBe('ausente');
    }
    expect(leituraTabelaPrecoLi({ outra: entrada(10) }, NORMAL)).toBe('ausente');
    expect(leituraTabelaPrecoLi({}, '__proto__')).toBe('ausente');
    expect(leituraTabelaPrecoLi({}, 'toString')).toBe('ausente');
  });

  it('⚠️ NEAR-MISS: a present but unreadable entry is ilegivel, never "no price"', () => {
    for (const valor of [10, '10', null, [entrada(10)], 'x']) {
      // A legacy bare number (or any non-object) under the tabela key.
      expect(leituraTabelaPrecoLi({ [NORMAL]: valor }, NORMAL), JSON.stringify(valor)).toBe(
        'ilegivel',
      );
    }
    for (const valor of ['10', Number.NaN, Number.POSITIVE_INFINITY, null, undefined, true]) {
      expect(leituraTabelaPrecoLi({ [NORMAL]: entrada(valor) }, NORMAL), String(valor)).toBe(
        'ilegivel',
      );
    }
    expect(leituraTabelaPrecoLi({ [NORMAL]: {} }, NORMAL)).toBe('ilegivel');
  });

  it('⚠️ DECISION: a stored valor that rounds to 0 is ausente; a NEGATIVE one is ilegivel', () => {
    for (const valor of [0, 0.004, -0]) {
      expect(leituraTabelaPrecoLi({ [NORMAL]: entrada(valor) }, NORMAL), String(valor)).toBe(
        'ausente',
      );
    }
    // NEAR-MISS: the sign is judged BEFORE rounding — a negative that rounds to 0 is still
    // negative, as `valorPrecoLi` reads it.
    for (const valor of [-1, -0.01, -0.006, -0.004, -0.001, -Number.MIN_VALUE]) {
      expect(leituraTabelaPrecoLi({ [NORMAL]: entrada(valor) }, NORMAL), String(valor)).toBe(
        'ilegivel',
      );
    }
  });

  it('agrees with precoDaTabela on EVERY input: a price exactly when it answers one, the same price', () => {
    const valores: unknown[] = [10, 10.004, 0.005, 0.004, 0, -1, '10', null, Number.NaN];
    const mapas: unknown[] = [
      null,
      5,
      [],
      {},
      ...valores.map((v) => ({ [NORMAL]: entrada(v) })),
      ...valores.map((v) => ({ [NORMAL]: v })),
    ];
    for (const precos of mapas) {
      const leitura = leituraTabelaPrecoLi(precos, NORMAL);
      const valor = precoDaTabela(precos, NORMAL);
      expect(typeof leitura === 'string' ? null : leitura.valor, JSON.stringify(precos)).toBe(
        valor,
      );
    }
  });
});

describe('precoAlvoLi (the price a linked child must show)', () => {
  it('a root: cheio from the normal tabela, the positive promo from the promo tabela', () => {
    expect(alvo(raiz({ [NORMAL]: entrada(50), [PROMO]: entrada(39.99) }))).toEqual(
      enviar(5000, { centavos: 3999 }),
    );
  });

  it('D10: no promo tabela, an empty one, or no positive promo ⇒ the promo is CLEARED', () => {
    const precos = { [NORMAL]: entrada(50), [PROMO]: entrada(39.99) };
    expect(alvo(raiz(precos), null, null)).toEqual(enviar(5000, 'limpar'));
    expect(alvo(raiz(precos), null, '')).toEqual(enviar(5000, 'limpar'));
    expect(alvo(raiz({ [NORMAL]: entrada(50) }))).toEqual(enviar(5000, 'limpar'));
    for (const promo of [0, 0.004]) {
      expect(alvo(raiz({ [NORMAL]: entrada(50), [PROMO]: entrada(promo) })), String(promo)).toEqual(
        enviar(5000, 'limpar'),
      );
    }
  });

  it('a promo tabela EQUAL to the normal one is "no promo list": it clears, and says so', () => {
    const produto = raiz({ [NORMAL]: entrada(50) });
    expect(
      precoAlvoLi({ produto, pai: null, tabelaNormalId: NORMAL, tabelaPromocionalId: NORMAL }),
    ).toEqual(enviar(5000, 'limpar', { promoIgualNormal: true }));
  });

  it('a promo at or above cheio is sent LITERALLY, and counted', () => {
    expect(alvo(raiz({ [NORMAL]: entrada(50), [PROMO]: entrada(60) }))).toEqual(
      enviar(5000, { centavos: 6000 }, { promoNaoMenor: true }),
    );
    expect(alvo(raiz({ [NORMAL]: entrada(50), [PROMO]: entrada(50) }))).toEqual(
      enviar(5000, { centavos: 5000 }, { promoNaoMenor: true }),
    );
    // NEAR-MISS: one centavo below is an ordinary promotion.
    expect(alvo(raiz({ [NORMAL]: entrada(50), [PROMO]: entrada(49.99) }))).toEqual(
      enviar(5000, { centavos: 4999 }),
    );
  });

  it('HELD: no normal-tabela price NOW (absent, 0, 0.004) ⇒ sem-preco', () => {
    for (const precos of [
      {},
      null,
      { [PROMO]: entrada(10) },
      { [NORMAL]: entrada(0) },
      { [NORMAL]: entrada(0.004) },
    ]) {
      expect(alvo(raiz(precos)), JSON.stringify(precos)).toEqual(retido('sem-preco'));
    }
  });

  it('⚠️ HELD: an unreadable entry the child depends on ⇒ ilegivel — never a clear', () => {
    expect(alvo(raiz({ [NORMAL]: 50 }))).toEqual(retido('ilegivel'));
    expect(alvo(raiz({ [NORMAL]: entrada(50), [PROMO]: 39.99 }))).toEqual(retido('ilegivel'));
    expect(alvo(raiz({ [NORMAL]: entrada(50), [PROMO]: entrada(-1) }))).toEqual(retido('ilegivel'));
    // It wins over sem-preco: fixing the missing price would still meet it.
    expect(alvo(raiz({ [PROMO]: entrada('39.99') }))).toEqual(retido('ilegivel'));
    // A price past a safe integer of centavos is unreadable too, so no target sent is one
    // decidirBaixaPrecoLi refuses; on the normal tabela, the promo one, and under a parent.
    for (const precos of [
      { [NORMAL]: entrada(1e17) },
      { [NORMAL]: entrada(50), [PROMO]: entrada(Number.MAX_VALUE) },
      { [PROMO]: entrada(1e17) },
    ]) {
      expect(alvo(raiz(precos)), JSON.stringify(precos)).toEqual(retido('ilegivel'));
      expect(alvo(filho({}), { precos }), JSON.stringify(precos)).toEqual(retido('ilegivel'));
    }
    // NEAR-MISS: the largest whole-reais price whose centavos are still a safe integer is sent.
    const maior = Math.floor(Number.MAX_SAFE_INTEGER / 100);
    const r = alvo(raiz({ [NORMAL]: entrada(maior) }));
    expect(r).toMatchObject({ tipo: 'enviar', cheioCentavos: centavosDeReais(maior) });
    if (r.tipo !== 'enviar') throw new Error('unreachable');
    expect(() =>
      decidirBaixaPrecoLi({ alvo: r, atual: { cheio: null, promocional: null } }),
    ).not.toThrow();
    // NEAR-MISS: an unreadable entry of a tabela the conta does not use is not read.
    expect(alvo(raiz({ [NORMAL]: entrada(50), outra: 7 }))).toEqual(enviar(5000, 'limpar'));
    expect(alvo(raiz({ [NORMAL]: entrada(50), [PROMO]: 7 }), null, null)).toEqual(
      enviar(5000, 'limpar'),
    );
  });

  it('no normal tabela on the conta ⇒ sem-tabela', () => {
    const produto = raiz({ [NORMAL]: entrada(50) });
    for (const tabelaNormalId of [null, '']) {
      expect(
        precoAlvoLi({ produto, pai: null, tabelaNormalId, tabelaPromocionalId: PROMO }),
      ).toEqual(retido('sem-tabela'));
    }
  });

  it('a child of a PROPAGATING parent reads the parent’s entries only (flag absent, true, or junk)', () => {
    const doFilho = { [NORMAL]: entrada(99), [PROMO]: entrada(88) };
    const doPai = { [NORMAL]: entrada(50), [PROMO]: entrada(39.99) };
    for (const flag of [undefined, true, 'false', 0, null]) {
      const pai =
        flag === undefined ? { precos: doPai } : { precos: doPai, propagatePriceToChildren: flag };
      expect(alvo(filho(doFilho), pai), String(flag)).toEqual(enviar(5000, { centavos: 3999 }));
    }
  });

  it('⚠️ NEAR-MISS: a propagating parent WITHOUT an entry holds the child even when the child has one', () => {
    const pai = { precos: {} };
    expect(alvo(filho({ [NORMAL]: entrada(99) }), pai)).toEqual(retido('sem-preco'));
    // …and its promo comes from the parent too: the child's own promo is never read.
    expect(
      alvo(filho({ [NORMAL]: entrada(99), [PROMO]: entrada(10) }), {
        precos: { [NORMAL]: entrada(50) },
      }),
    ).toEqual(enviar(5000, 'limpar'));
  });

  it('a NON-propagating parent: the child’s own entries, and the parent is not consulted', () => {
    const pai = {
      precos: { [NORMAL]: entrada(50), [PROMO]: entrada(39.99) },
      propagatePriceToChildren: false,
    };
    expect(alvo(filho({ [NORMAL]: entrada(70) }), pai)).toEqual(enviar(7000, 'limpar'));
    expect(alvo(filho({}), pai)).toEqual(retido('sem-preco'));
    // The parent's unreadable entry does not hold a child that reads its own map.
    expect(
      alvo(filho({ [NORMAL]: entrada(70) }), {
        precos: { [NORMAL]: 5 },
        propagatePriceToChildren: false,
      }),
    ).toEqual(enviar(7000, 'limpar'));
  });

  it('a missing parent ⇒ pai-ausente, never a guess; so is a parent id that names no document', () => {
    expect(alvo(filho({ [NORMAL]: entrada(70) }), null)).toEqual(retido('pai-ausente'));
    const pai = { precos: { [NORMAL]: entrada(50) } };
    // The ERP document-id grammar the snapshot's `pai` uses — one check, never a looser one.
    for (const paiId of ['a/b', '.', '..', '__x__', '____', 'x'.repeat(1501), 'é'.repeat(751)]) {
      const produto = { id: 'f1', dados: { paiId, precos: { [NORMAL]: entrada(70) } } };
      expect(alvo(produto, pai), paiId.slice(0, 8)).toEqual(retido('pai-ausente'));
      expect(idDocumentoEstoqueLiSchema.safeParse(paiId).success, paiId.slice(0, 8)).toBe(false);
    }
    // NEAR-MISS: an odd but valid id names a document — the child is priced from that parent.
    for (const paiId of ['a.b', '_x_', '__x', 'x'.repeat(1500), '…']) {
      const produto = { id: 'f1', dados: { paiId, precos: { [NORMAL]: entrada(70) } } };
      expect(alvo(produto, pai), paiId.slice(0, 8)).toEqual(enviar(5000, 'limpar'));
    }
  });

  it("⚠️ NEAR-MISS: a `''` or self parent is a ROOT — its own map, and a passed parent is ignored", () => {
    const pai = { precos: { [NORMAL]: entrada(50) } };
    for (const paiId of ['', 'r1']) {
      const produto = { id: 'r1', dados: { paiId, precos: { [NORMAL]: entrada(70) } } };
      expect(alvo(produto, pai), paiId).toEqual(enviar(7000, 'limpar'));
      expect(alvo(produto, null), paiId).toEqual(enviar(7000, 'limpar'));
    }
  });

  it('a kit is an ordinary store product: its own precos', () => {
    const kit = raiz({ [NORMAL]: entrada(120) }, { componentesKit: { a: 1, b: 2 } });
    expect(alvo(kit)).toEqual(enviar(12000, 'limpar'));
  });

  it('⚠️ NO custo: a custo on the produto or the parent never decides, never prices, never returns', () => {
    // Below, equal to and above the price, a centavo either side of it, huge, negative, text,
    // null — on the produto AND on the parent, for every kind of child the rule knows.
    const custos: unknown[] = [undefined, 0.01, 30, 69.99, 70, 70.01, 1e6, -3, '30', null];
    const casos: readonly [
      string,
      { id: string; dados: Record<string, unknown> },
      Record<string, unknown> | null,
    ][] = [
      ['a root with a price', raiz({ [NORMAL]: entrada(70) }), null],
      ['a root with a promotion', raiz({ [NORMAL]: entrada(70), [PROMO]: entrada(50) }), null],
      ['a root with NO price', raiz({}), null],
      [
        'a child of a propagating parent',
        filho({ [NORMAL]: entrada(99) }),
        { precos: { [NORMAL]: entrada(70) } },
      ],
      [
        'a child of a propagating parent with NO price',
        filho({ [NORMAL]: entrada(99) }),
        { precos: {} },
      ],
      [
        'a child of a non-propagating parent',
        filho({ [NORMAL]: entrada(70) }),
        { precos: {}, propagatePriceToChildren: false },
      ],
      [
        'a child with NO price of a non-propagating parent',
        filho({}),
        { precos: { [NORMAL]: entrada(70) }, propagatePriceToChildren: false },
      ],
    ];
    for (const [nome, produto, pai] of casos) {
      const semCusto = alvo(produto, pai);
      for (const custoProduto of custos) {
        for (const custoPai of custos) {
          const comCusto = alvo(
            custoProduto === undefined
              ? produto
              : { id: produto.id, dados: { ...produto.dados, custo: custoProduto } },
            pai === null || custoPai === undefined ? pai : { ...pai, custo: custoPai },
          );
          const rotulo = `${nome}: ${String(custoProduto)} / ${String(custoPai)}`;
          expect(comCusto, rotulo).toEqual(semCusto);
          expect(JSON.stringify(comCusto), rotulo).not.toMatch(/custo/i);
        }
      }
    }
    // Pinned outright, so the matrix above is not vacuous: no price ⇒ held, whatever the custo.
    expect(alvo(raiz({}, { custo: 30 }))).toEqual(retido('sem-preco'));
    expect(alvo(raiz({ [NORMAL]: entrada(10) }, { custo: 30 }))).toEqual(enviar(1000, 'limpar'));
    expect(alvo(filho({}, { custo: 30 }), { precos: {}, custo: 40 })).toEqual(retido('sem-preco'));
  });

  it('the price sent IS the shared child rule’s, and a hold is exactly its "no price"', () => {
    const mapas: unknown[] = [
      {},
      null,
      { [NORMAL]: entrada(50) },
      { [NORMAL]: entrada(70.004) },
      { [NORMAL]: 9 },
      { [NORMAL]: entrada(0) },
    ];
    for (const precosDoPai of mapas) {
      for (const precosDoFilho of mapas) {
        for (const flag of [true, false, undefined]) {
          const pai = { precos: precosDoPai, propagatePriceToChildren: flag };
          const r = alvo(filho(precosDoFilho), pai, null);
          const valor = precoDoFilhoNaTabela(
            { precosDoPai, propagaPreco: propagaPrecoAosFilhos(flag), precosDoFilho },
            NORMAL,
          );
          const rotulo = JSON.stringify({ precosDoPai, precosDoFilho, flag });
          if (valor === null) expect(r.tipo, rotulo).toBe('retido');
          else
            expect(r, rotulo).toMatchObject({
              tipo: 'enviar',
              cheioCentavos: centavosDeReais(valor),
            });
        }
      }
    }
  });

  it('the hold motivos are exactly the four, named', () => {
    expect(motivoRetencaoPrecoLiSchema.options).toEqual([
      'sem-tabela',
      'sem-preco',
      'ilegivel',
      'pai-ausente',
    ]);
    expect(Object.values(MOTIVO_RETENCAO_PRECO_LI)).toEqual(motivoRetencaoPrecoLiSchema.options);
  });
});

describe('precosDasLeiturasLi (stored readings replay through the one rule)', () => {
  it('round-trips every reading this module produces', () => {
    const leituras: LeituraTabelaPrecoLi[] = [
      { valor: 274.42 },
      { valor: 0.01 },
      'ausente',
      'ilegivel',
    ];
    for (const normal of leituras) {
      for (const promo of leituras) {
        const precos = precosDasLeiturasLi({ [NORMAL]: normal, [PROMO]: promo });
        expect(leituraTabelaPrecoLi(precos, NORMAL)).toEqual(normal);
        expect(leituraTabelaPrecoLi(precos, PROMO)).toEqual(promo);
      }
    }
  });

  it('a replayed root prices exactly as the original document', () => {
    const original = { [NORMAL]: entrada(274.42), [PROMO]: entrada(0.004), lixo: 3 };
    const replay = precosDasLeiturasLi({
      [NORMAL]: leituraTabelaPrecoLi(original, NORMAL),
      [PROMO]: leituraTabelaPrecoLi(original, PROMO),
    });
    expect(alvo(raiz(replay))).toEqual(alvo(raiz(original)));
  });
});

describe('valorPrecoLi (a store price value, read)', () => {
  it.each([
    [274.42, 27442],
    ['274.42', 27442],
    ['259.9', 25990],
    ['160.0000', 16000],
    ['259.9000', 25990],
    ['0.0100', 1],
    ['+10.00', 1000],
    ['.5', 50],
    [' 10.00 ', 1000],
    [10.004, 1000],
    [0, 0],
    ['0.00', 0],
    ['0', 0],
    ['0.0000', 0],
    [0.004, 0],
    [-0, 0],
    ['-0.00', 0],
  ] as const)('%j ⇒ %i centavos', (valor, centavos) => {
    expect(valorPrecoLi(valor)).toEqual({ centavos });
  });

  it('null and absent are vazio', () => {
    expect(valorPrecoLi(null)).toBe('vazio');
    expect(valorPrecoLi(undefined)).toBe('vazio');
  });

  it.each([
    ['1,50'],
    ['1e3'],
    [''],
    ['  '],
    ['abc'],
    ['-1.00'],
    [-1],
    [-0.01],
    ['3.'],
    ['0x1F'],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [1e300],
    ['9'.repeat(30) + '.5'],
    [true],
    [{ valor: 10 }],
    [[10]],
  ] as const)('⚠️ %j is ilegivel — neither a price nor empty', (valor) => {
    expect(valorPrecoLi(valor)).toBe('ilegivel');
  });
});

describe('mesmoPrecoLi (THE price equality)', () => {
  it.each([
    ['10.00', 10],
    [274.42, '274.42'],
    ['259.9', 259.9],
    [10.004, 10],
    ['+10.00', 10],
    ['.5', 0.5],
    ['160.0000', 160],
    ['160.0000', '160.00'],
    // The price resource's text against the produto detail's number for the same leaf.
    ['259.9000', 259.9],
  ] as const)('EQUAL: %j ≡ %j', (a, b) => {
    expect(mesmoPrecoLi(a, b)).toBe(true);
    expect(mesmoPrecoLi(b, a)).toBe(true);
  });

  it.each([
    ['10.01', 10],
    ['49.99', 50],
    [49.991, 50],
    ['259.9100', 259.9],
    ['22', 22.83],
    ['1,50', 1.5],
    ['1e3', 1000],
    ['', 0],
    ['-1.00', 1],
    [-1, 1],
  ] as const)('⚠️ NEAR-MISS: %j ≠ %j', (a, b) => {
    expect(mesmoPrecoLi(a, b)).toBe(false);
    expect(mesmoPrecoLi(b, a)).toBe(false);
  });

  it('⚠️ NEAR-MISS: a null or 0 price equals NOTHING — not even another null or 0', () => {
    expect(mesmoPrecoLi(null, null)).toBe(false);
    expect(mesmoPrecoLi(0, 0)).toBe(false);
    expect(mesmoPrecoLi(0, '0.00')).toBe(false);
    expect(mesmoPrecoLi(undefined, 0)).toBe(false);
    expect(mesmoPrecoLi('abc', 'abc')).toBe(false);
  });
});

describe('promocionalLimpoLi (a cleared promotion)', () => {
  it.each([[null], [undefined], [0], ['0.00'], ['0'], ['0.0000'], [0.004], ['0.004']] as const)(
    'EQUAL: %j is cleared',
    (valor) => {
      expect(promocionalLimpoLi(valor)).toBe(true);
    },
  );

  it.each([
    ['0.01'],
    ['0.0100'],
    [0.01],
    [0.005],
    // The text twin of the number above: half a centavo rounds the same way on both paths.
    ['0.0050'],
    ['-1.00'],
    [-1],
    ['1,50'],
    [''],
    ['1e3'],
    [39.99],
  ] as const)('⚠️ NEAR-MISS: %j is NOT cleared', (valor) => {
    expect(promocionalLimpoLi(valor)).toBe(false);
  });

  it('⚠️ NEAR-MISS: a promo EQUAL to the full price is a stored promotion, not a clear', () => {
    const cheio = 50;
    for (const promo of [50, '50.00', '50']) {
      expect(promocionalLimpoLi(promo), String(promo)).toBe(false);
      expect(mesmoPrecoLi(promo, cheio), String(promo)).toBe(true);
    }
  });
});

describe('efetivoPrecoLi (what the buyer pays)', () => {
  it('the lower positive of the two', () => {
    expect(efetivoPrecoLi(50, null)).toEqual({ centavos: 5000 });
    expect(efetivoPrecoLi(50, '0.00')).toEqual({ centavos: 5000 });
    expect(efetivoPrecoLi(50, 60)).toEqual({ centavos: 5000 });
    expect(efetivoPrecoLi('50.00', 39.99)).toEqual({ centavos: 3999 });
    expect(efetivoPrecoLi(null, 30)).toEqual({ centavos: 3000 });
    expect(efetivoPrecoLi(0, '30.00')).toEqual({ centavos: 3000 });
  });

  it('nothing positive ⇒ vazio; anything unreadable ⇒ ilegivel', () => {
    expect(efetivoPrecoLi(null, null)).toBe('vazio');
    expect(efetivoPrecoLi(0, '0.00')).toBe('vazio');
    expect(efetivoPrecoLi('abc', 10)).toBe('ilegivel');
    expect(efetivoPrecoLi(10, -1)).toBe('ilegivel');
  });
});

describe('decidirBaixaPrecoLi (no-lower, integer centavos)', () => {
  const decidir = (
    cheioCentavos: number,
    promo: { centavos: number } | 'limpar',
    cheio: unknown,
    promocional: unknown = null,
  ) => decidirBaixaPrecoLi({ alvo: { cheioCentavos, promo }, atual: { cheio, promocional } });

  it('the full price: lower is refused; equal and higher pass', () => {
    expect(decidir(4999, 'limpar', '50.00')).toEqual({
      tipo: 'baixa',
      cheio: true,
      promocional: false,
      efetivo: true,
    });
    // NEAR-MISS (`<` and never `<=`): the same price does not lower.
    expect(decidir(5000, 'limpar', '50.00')).toEqual({ tipo: 'nao-baixa' });
    expect(decidir(5001, 'limpar', 50)).toEqual({ tipo: 'nao-baixa' });
  });

  it('the promotion: a lower positive promo is refused', () => {
    expect(decidir(5000, { centavos: 3999 }, 50, '40.00')).toEqual({
      tipo: 'baixa',
      cheio: false,
      promocional: true,
      efetivo: true,
    });
    expect(decidir(5000, { centavos: 4000 }, 50, 40)).toEqual({ tipo: 'nao-baixa' });
  });

  it('⚠️ a store promo EQUAL to its full price is a stored promotion: a lower one lowers the promo leaf', () => {
    // The promo the store holds equal to `cheio` is not a clear (the fold's own near-miss), so
    // a lower target promo names the promo leaf too.
    expect(decidir(5000, { centavos: 4500 }, 50, '50.00')).toEqual({
      tipo: 'baixa',
      cheio: false,
      promocional: true,
      efetivo: true,
    });
    // NEAR-MISS: the same target against a store with NO promotion lowers the buyer price only.
    expect(decidir(5000, { centavos: 4500 }, 50, null)).toEqual({
      tipo: 'baixa',
      cheio: false,
      promocional: false,
      efetivo: true,
    });
  });

  it('⚠️ DECISION: the promo leaf compares promotions even when the store’s is ABOVE its full price', () => {
    // The approved rule applied literally: whether the store charges a promotion above its full
    // price is unknown (the owner's read-only price capture found no such row), and under either
    // reading this refusal lets no lowering through.
    expect(decidir(6500, { centavos: 6800 }, 60, 70)).toEqual({
      tipo: 'baixa',
      cheio: false,
      promocional: true,
      efetivo: false,
    });
    // NEAR-MISS: the same raise with a target promotion not below the store's passes.
    expect(decidir(6500, { centavos: 7000 }, 60, 70)).toEqual({ tipo: 'nao-baixa' });
  });

  it('⚠️ any lower buyer price: a NEW promo where the store shows none lowers it — refused', () => {
    // The plan's case: the store at 50.00 with no promo, the target promo 39.99.
    for (const semPromo of [null, '0.00', '0.0000', 0]) {
      expect(decidir(5000, { centavos: 3999 }, '50.00', semPromo), String(semPromo)).toEqual({
        tipo: 'baixa',
        cheio: false,
        promocional: false,
        efetivo: true,
      });
    }
  });

  it('⚠️ a CLEAR never counts as lowering by itself', () => {
    expect(decidir(5000, 'limpar', 50, 40)).toEqual({ tipo: 'nao-baixa' });
    expect(decidir(5000, 'limpar', 50, 50)).toEqual({ tipo: 'nao-baixa' });
    // The lowering here is the full price's, not the clear's.
    expect(decidir(4500, 'limpar', 50, 40)).toMatchObject({ tipo: 'baixa', cheio: true });
  });

  it('an empty or 0 full price in the store protects nothing on that leaf; the promo still does', () => {
    expect(decidir(100, 'limpar', null)).toEqual({ tipo: 'nao-baixa' });
    expect(decidir(100, 'limpar', '0.00')).toEqual({ tipo: 'nao-baixa' });
    expect(decidir(2500, 'limpar', null, 30)).toEqual({
      tipo: 'baixa',
      cheio: false,
      promocional: false,
      efetivo: true,
    });
    expect(decidir(3000, 'limpar', null, 30)).toEqual({ tipo: 'nao-baixa' });
  });

  it('⚠️ an unreadable current value is reported APART — not "lowers", not "does not"', () => {
    for (const [cheio, promocional] of [
      ['abc', null],
      [50, '1,50'],
      ['-1.00', null],
      [50, -1],
    ] as const) {
      expect(
        decidir(9999, 'limpar', cheio, promocional),
        `${String(cheio)}/${String(promocional)}`,
      ).toEqual({
        tipo: 'atual-ilegivel',
      });
    }
  });

  it('refuses a target that is not positive integer centavos (a bug)', () => {
    for (const [cheio, promo] of [
      [0, 'limpar'],
      [10.5, 'limpar'],
      [-1, 'limpar'],
      [100, { centavos: 0 }],
      [100, { centavos: 1.5 }],
    ] as const) {
      expect(() => decidir(cheio, promo, 50)).toThrow(RangeError);
    }
  });
});

describe('assinaturaEnvioPrecoLi (the reconcile’s non-convergence key)', () => {
  it('is the exact centavos text, 0 for the clear and for an empty store value', () => {
    const chave = assinaturaEnvioPrecoLi(
      { cheioCentavos: 5000, promo: 'limpar' },
      { cheio: '49.90', promocional: null },
    );
    expect(chave).toBe('5000:0:4990:0');
    expect(chave).toMatch(ASSINATURA_ENVIO_PRECO_LI_REGEX);
  });

  it('EQUAL: every spelling of the same store value gives one key', () => {
    const alvoEnvio = { cheioCentavos: 5000, promo: { centavos: 3999 } } as const;
    const chaves = [null, 0, '0.00', '0', '0.0000'].map((promocional) =>
      assinaturaEnvioPrecoLi(alvoEnvio, { cheio: '10.00', promocional }),
    );
    expect(new Set(chaves)).toEqual(new Set(['5000:3999:1000:0']));
    expect(assinaturaEnvioPrecoLi(alvoEnvio, { cheio: 10, promocional: null })).toBe(chaves[0]);
  });

  it('⚠️ NEAR-MISS: one centavo anywhere, or a promo equal to the full price, is another key', () => {
    const base = assinaturaEnvioPrecoLi(
      { cheioCentavos: 5000, promo: 'limpar' },
      { cheio: 50, promocional: null },
    );
    for (const outra of [
      assinaturaEnvioPrecoLi(
        { cheioCentavos: 5001, promo: 'limpar' },
        { cheio: 50, promocional: null },
      ),
      assinaturaEnvioPrecoLi(
        { cheioCentavos: 5000, promo: 'limpar' },
        { cheio: '50.01', promocional: null },
      ),
      assinaturaEnvioPrecoLi(
        { cheioCentavos: 5000, promo: 'limpar' },
        { cheio: 50, promocional: 50 },
      ),
      assinaturaEnvioPrecoLi(
        { cheioCentavos: 5000, promo: { centavos: 1 } },
        { cheio: 50, promocional: null },
      ),
    ]) {
      expect(outra).not.toBe(base);
    }
  });

  it('refuses an unreadable store value and a malformed target', () => {
    expect(() =>
      assinaturaEnvioPrecoLi(
        { cheioCentavos: 5000, promo: 'limpar' },
        { cheio: 'abc', promocional: null },
      ),
    ).toThrow(RangeError);
    expect(() =>
      assinaturaEnvioPrecoLi(
        { cheioCentavos: 0, promo: 'limpar' },
        { cheio: 50, promocional: null },
      ),
    ).toThrow(RangeError);
  });

  it('the grammar refuses a leading zero, a sign and a missing part', () => {
    for (const ruim of ['01:0:0:0', '-1:0:0:0', '1:0:0', '1:0:0:0:0', '1.5:0:0:0', '']) {
      expect(ASSINATURA_ENVIO_PRECO_LI_REGEX.test(ruim), ruim).toBe(false);
    }
  });
});

describe('the module', () => {
  it('exports nothing combined { schema, meta }, and the barrel re-exports every name', () => {
    for (const [nome, valor] of Object.entries(modulo)) {
      const temSchemaEMeta =
        typeof valor === 'object' && valor !== null && 'schema' in valor && 'meta' in valor;
      expect(temSchemaEMeta, nome).toBe(false);
      expect(Reflect.get(barrel, nome), nome).toBe(valor);
    }
  });
});
