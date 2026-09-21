import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type LinhaDeFamilia,
  type MembroDaFamilia,
  type MovimentosDaJanela,
  chaveMovimento,
} from '@delfrance/data/admin/estoque';
import { componentesKitSchema } from '@delfrance/schemas';

import type { FaixaDto } from '../taxonomia/limites';
import {
  deveEnviarFamiliaShopee,
  opcoesShopee,
  quantidadeDoMembroShopee,
  quantidadeParaPublicarShopee,
  quantidadesAnterioresShopee,
  quantidadesDaFamiliaShopee,
} from './quantidadeEstoque';

/* -------------------------------------------------------------------------- */
/*                                  fixtures                                  */
/* -------------------------------------------------------------------------- */

const DEPOSITO = 'dep-1';

/** The `montagemAnuncio.test.ts` fixture, verbatim: two constraining components. */
const COMPONENTES = componentesKitSchema.parse({
  'comp-a': { quantidade: 2, limitarEstoque: true },
  'comp-b': { quantidade: 1, limitarEstoque: true },
});

/** A kit whose only component declares `limitarEstoque: false` ⇒ UNCONSTRAINED. */
const COMPONENTES_LIVRES = componentesKitSchema.parse({
  'comp-a': { quantidade: 2, limitarEstoque: false },
});

function publicar(over: {
  ehKit?: boolean;
  ehKitVirtual?: boolean;
  componentesKit?: ReturnType<typeof componentesKitSchema.parse> | null;
  ownDisponivel?: number;
  disponivelByProdutoId?: Record<string, number | null | undefined>;
  banda?: FaixaDto | null;
}): number {
  return quantidadeParaPublicarShopee({
    ehKit: over.ehKit ?? false,
    ehKitVirtual: over.ehKitVirtual ?? false,
    componentesKit: over.componentesKit ?? null,
    ownDisponivel: over.ownDisponivel ?? 0,
    disponivelByProdutoId: over.disponivelByProdutoId ?? {},
    banda: over.banda ?? null,
  });
}

function membro(over: Partial<MembroDaFamilia> = {}): MembroDaFamilia {
  return {
    produtoId: 'prod-1',
    ehKit: false,
    ehKitVirtual: false,
    publicado: true,
    componentesKit: null,
    timestampMs: null,
    estoque: { quantidade: 0, quantidadeReservada: 0 },
    componentEstoques: [],
    ...over,
  };
}

const SEM_MOVIMENTOS: MovimentosDaJanela = new Map();

afterEach(() => {
  vi.unstubAllEnvs();
});

/* -------------------------------------------------------------------------- */
/*     (1) o PAR — os mesmos números que a implementação anterior produzia     */
/* -------------------------------------------------------------------------- */

describe('quantidadeParaPublicarShopee — PAR: a ligação ao núcleo responde os MESMOS números', () => {
  // Cada caso abaixo é uma entrada que `montagemAnuncio.test.ts` já fixava
  // ANTES da mudança, com o valor que a implementação local respondia. O corpo
  // agora é `quantidadeParaEnvioCore` + `opcoesShopee`; o que estes doze casos
  // provam é que a troca não moveu nenhum resultado.

  it('um kit usa o mínimo dos componentes e NÃO soma o estoque próprio', () => {
    expect(
      publicar({
        ehKit: true,
        componentesKit: COMPONENTES,
        ownDisponivel: 100,
        disponivelByProdutoId: { 'comp-a': 9, 'comp-b': 5 },
      }),
    ).toBe(4);
  });

  it('um kit VIRTUAL toma o MESMO ramo — nunca null e nunca o estoque próprio', () => {
    expect(
      publicar({
        ehKitVirtual: true,
        componentesKit: COMPONENTES,
        ownDisponivel: 100,
        disponivelByProdutoId: { 'comp-a': 9, 'comp-b': 5 },
      }),
    ).toBe(4);
  });

  it('um kit sem componente que limite cai no estoque próprio', () => {
    expect(publicar({ ehKit: true, componentesKit: null, ownDisponivel: 6 })).toBe(6);
  });

  it('um kit cujo único componente não limita também cai no estoque próprio', () => {
    expect(
      publicar({
        ehKit: true,
        componentesKit: COMPONENTES_LIVRES,
        ownDisponivel: 6,
        disponivelByProdutoId: { 'comp-a': 100 },
      }),
    ).toBe(6);
  });

  it('um componente sem estoque resolvível conta ZERO (#238), não é ignorado', () => {
    expect(
      publicar({
        ehKit: true,
        componentesKit: COMPONENTES,
        ownDisponivel: 100,
        disponivelByProdutoId: { 'comp-a': 9 },
      }),
    ).toBe(0);
  });

  it('o resultado é inteiro e nunca negativo — um próprio negativo vira 0', () => {
    expect(publicar({ ownDisponivel: -4 })).toBe(0);
  });

  it('um kit com próprio 0 ainda publica o mínimo dos componentes', () => {
    expect(
      publicar({
        ehKit: true,
        componentesKit: COMPONENTES,
        ownDisponivel: 0,
        disponivelByProdutoId: { 'comp-a': 9, 'comp-b': 9 },
      }),
    ).toBe(4);
  });

  it('a fração do mínimo do kit é ARREDONDADA PARA BAIXO', () => {
    expect(
      publicar({
        ehKit: true,
        componentesKit: COMPONENTES,
        ownDisponivel: 0,
        disponivelByProdutoId: { 'comp-a': 7, 'comp-b': 99 },
      }),
    ).toBe(3);
  });

  it('um próprio fracionário também é arredondado para baixo', () => {
    expect(publicar({ ownDisponivel: 7.9 })).toBe(7);
  });

  it('⚠️ NEAR-MISS: um estoque de min - 1 NUNCA é arredondado para o mínimo da banda', () => {
    expect(publicar({ ownDisponivel: 1, banda: { min: 2, max: 1_000_000 } })).toBe(1);
  });

  it('um estoque acima do máximo é limitado PARA BAIXO', () => {
    expect(publicar({ ownDisponivel: 1_000_001, banda: { min: 2, max: 10 } })).toBe(10);
  });

  it('um próprio NÃO finito vira 0 antes do núcleo (o piso não salvaria um NaN)', () => {
    expect(publicar({ ownDisponivel: Number.NaN })).toBe(0);
    expect(publicar({ ownDisponivel: Number.POSITIVE_INFINITY })).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*                      (2) opcoesShopee — os três parâmetros                  */
/* -------------------------------------------------------------------------- */

describe('opcoesShopee — o teto', () => {
  it('PAR: sem banda o teto é Infinity, e com banda é o máximo dela', () => {
    expect(opcoesShopee(null).estoqueMax).toBe(Number.POSITIVE_INFINITY);
    expect(opcoesShopee(10).estoqueMax).toBe(10);
  });

  it('⚠️ NEAR-MISS: sem banda a quantidade NÃO é zerada (um teto 0 zeraria tudo)', () => {
    expect(opcoesShopee(null).estoqueMax).not.toBe(0);
    expect(publicar({ ownDisponivel: 42, banda: null })).toBe(42);
    // Uma banda com máximo NULO é o mesmo "sem teto" — a sandbox mediu os dois
    // limites nulos na categoria dela, então isto é estado normal, não defeito.
    expect(publicar({ ownDisponivel: 42, banda: { min: null, max: null } })).toBe(42);
  });

  it('um teto 0 DECLARADO pela banda continua sendo obedecido', () => {
    // A distinção que o NEAR-MISS acima protege: "não li banda nenhuma" ≠ "a
    // banda diz zero". A segunda é uma instrução da Shopee e vale.
    expect(publicar({ ownDisponivel: 42, banda: { min: 0, max: 0 } })).toBe(0);
  });
});

describe('opcoesShopee — pularKitVirtual é PINADO em false', () => {
  it('opcoesShopee(null).pularKitVirtual === false', () => {
    expect(opcoesShopee(null).pularKitVirtual).toBe(false);
  });

  it('⚠️ NEAR-MISS: nenhuma variável de ambiente liga o pulo do kit virtual', () => {
    vi.stubEnv('SHOPEE_STOCK_KIT_VIRTUAL_SKIP_ENABLED', '1');
    vi.stubEnv('MERCADO_LIVRE_STOCK_KIT_VIRTUAL_SKIP_ENABLED', '1');
    expect(opcoesShopee(null).pularKitVirtual).toBe(false);
    expect(
      quantidadeDoMembroShopee(
        membro({
          ehKitVirtual: true,
          componentesKit: COMPONENTES,
          componentEstoques: [
            { parentId: 'comp-a', quantidade: 9, quantidadeReservada: 0 },
            { parentId: 'comp-b', quantidade: 5, quantidadeReservada: 0 },
          ],
        }),
        { bandaMax: null, kitNativo: false },
      ),
    ).toBe(4);
  });
});

describe('opcoesShopee — a escotilha do estoque próprio do kit', () => {
  it('PAR: com SHOPEE_STOCK_KIT_INCLUI_PROPRIO=1 o próprio SOMA a um kit CONSTRANGIDO', () => {
    vi.stubEnv('SHOPEE_STOCK_KIT_INCLUI_PROPRIO', '1');
    expect(opcoesShopee(null).incluirEstoqueProprioDoKit).toBe(true);
    expect(
      publicar({
        ehKit: true,
        componentesKit: COMPONENTES,
        ownDisponivel: 3,
        disponivelByProdutoId: { 'comp-a': 9, 'comp-b': 5 },
      }),
    ).toBe(7); // 4 (o mínimo) + 3 (o próprio)
  });

  it('⚠️ NEAR-MISS: com a mesma flag o próprio NÃO é somado duas vezes num kit SEM constrangimento', () => {
    vi.stubEnv('SHOPEE_STOCK_KIT_INCLUI_PROPRIO', '1');
    expect(
      publicar({
        ehKit: true,
        componentesKit: COMPONENTES_LIVRES,
        ownDisponivel: 3,
        disponivelByProdutoId: { 'comp-a': 100 },
      }),
    ).toBe(3);
  });

  it('a flag embarca DESLIGADA: qualquer valor que não seja "1" mantém o comportamento', () => {
    for (const valor of ['', '0', 'true', 'sim']) {
      vi.stubEnv('SHOPEE_STOCK_KIT_INCLUI_PROPRIO', valor);
      expect(opcoesShopee(null).incluirEstoqueProprioDoKit).toBe(false);
      expect(
        publicar({
          ehKit: true,
          componentesKit: COMPONENTES,
          ownDisponivel: 3,
          disponivelByProdutoId: { 'comp-a': 9, 'comp-b': 5 },
        }),
      ).toBe(4);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                   (3) quantidadeDoMembroShopee e o kitNativo                */
/* -------------------------------------------------------------------------- */

describe('quantidadeDoMembroShopee', () => {
  const kitDerivado = membro({ estoque: { quantidade: 12, quantidadeReservada: 2 } });

  it('PAR: kitNativo true é o ÚNICO null; false responde o número', () => {
    expect(quantidadeDoMembroShopee(kitDerivado, { bandaMax: null, kitNativo: true })).toBeNull();
    expect(quantidadeDoMembroShopee(kitDerivado, { bandaMax: null, kitNativo: false })).toBe(10);
  });

  it('⚠️ NEAR-MISS: um kit ERP (ehKit/ehKitVirtual) sem kitNativo continua respondendo um número', () => {
    for (const traço of [{ ehKit: true }, { ehKitVirtual: true }]) {
      expect(
        quantidadeDoMembroShopee(membro({ ...traço, estoque: { quantidade: 5 } }), {
          bandaMax: null,
          kitNativo: false,
        }),
      ).toBe(5);
    }
  });

  it('a banda do membro é o teto quando existe', () => {
    expect(quantidadeDoMembroShopee(kitDerivado, { bandaMax: 4, kitNativo: false })).toBe(4);
  });

  it('um membro sem linha de estoque lê 0, não null', () => {
    expect(
      quantidadeDoMembroShopee(membro({ estoque: null }), { bandaMax: null, kitNativo: false }),
    ).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*            (4) a família, a janela e a política — bandas nulas              */
/* -------------------------------------------------------------------------- */

describe('quantidadesDaFamiliaShopee / quantidadesAnterioresShopee', () => {
  const linha: LinhaDeFamilia = {
    anchor: membro({ produtoId: 'pai', estoque: { quantidade: 30, quantidadeReservada: 0 } }),
    children: [
      membro({ produtoId: 'filho-1', estoque: { quantidade: 4, quantidadeReservada: 1 } }),
      membro({ produtoId: 'filho-2', estoque: { quantidade: 0, quantidadeReservada: 0 } }),
    ],
  };

  it('a família inteira é mapeada, e NENHUM membro é omitido (o pulo do kit virtual está pinado)', () => {
    const atuais = quantidadesDaFamiliaShopee(linha);
    expect([...atuais.entries()]).toEqual([
      ['pai', 30],
      ['filho-1', 3],
      ['filho-2', 0],
    ]);
  });

  it('⚠️ NEAR-MISS: a banda é NULA na varredura — 30 não é limitado por teto nenhum aqui', () => {
    // O SENDER é quem aplica `stock_limit.max`. Se a varredura limitasse, os
    // dois mapas comparados abaixo divergiriam por causa do teto e não por
    // causa de um movimento real.
    expect(quantidadesDaFamiliaShopee(linha).get('pai')).toBe(30);
  });

  it('sem movimento na janela, o mapa anterior é IGUAL ao atual', () => {
    const anteriores = quantidadesAnterioresShopee(linha, DEPOSITO, SEM_MOVIMENTOS);
    expect([...anteriores.entries()]).toEqual([...quantidadesDaFamiliaShopee(linha).entries()]);
  });

  it('um movimento DESCONHECIDO OMITE o membro — a omissão é o mecanismo', () => {
    const movimentos: MovimentosDaJanela = new Map([
      [chaveMovimento('pai', DEPOSITO), { dq: 0, dr: 0, desconhecido: true }],
    ]);
    const anteriores = quantidadesAnterioresShopee(linha, DEPOSITO, movimentos);
    expect(anteriores.has('pai')).toBe(false);
    expect(deveEnviarFamiliaShopee(quantidadesDaFamiliaShopee(linha), anteriores, true)).toBe(true);
  });
});

describe('deveEnviarFamiliaShopee — o limiar alto vem de SHOPEE_STOCK_LIMIAR_ALTO', () => {
  const atual = (n: number): ReadonlyMap<string, number> => new Map([['pai', n]]);

  it('PAR: 110 → 95 ENVIA no incremental (min(anterior, atual) <= 100)', () => {
    expect(deveEnviarFamiliaShopee(atual(95), atual(110), true)).toBe(true);
  });

  it('⚠️ NEAR-MISS: 210 → 195 NÃO envia no incremental, mas envia no diário', () => {
    expect(deveEnviarFamiliaShopee(atual(195), atual(210), true)).toBe(false);
    expect(deveEnviarFamiliaShopee(atual(195), atual(210), false)).toBe(true);
  });

  it('o limiar é lido do ambiente da Shopee, não de um literal', () => {
    vi.stubEnv('SHOPEE_STOCK_LIMIAR_ALTO', '300');
    expect(deveEnviarFamiliaShopee(atual(195), atual(210), true)).toBe(true);
  });

  it('sem linha de base, envia', () => {
    expect(deveEnviarFamiliaShopee(atual(5), null, true)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*                  (5) a mudança de casa, no texto da fonte                   */
/* -------------------------------------------------------------------------- */

describe('a função MUDOU de casa e montagemAnuncio.ts apenas reexporta', () => {
  const fonte = readFileSync(
    fileURLToPath(new URL('../anuncios/montagemAnuncio.ts', import.meta.url)),
    { encoding: 'utf8' },
  );

  it('montagemAnuncio.ts não declara mais o corpo', () => {
    expect(fonte).not.toContain('export function quantidadeParaPublicarShopee');
    expect(fonte).not.toContain('kitEstoqueDisponivel(args.componentesKit');
  });

  it('montagemAnuncio.ts importa a função do novo módulo e a reexporta', () => {
    expect(fonte).toContain("from '../estoque/quantidadeEstoque'");
    expect(fonte).toContain('export { quantidadeParaPublicarShopee }');
  });
});
