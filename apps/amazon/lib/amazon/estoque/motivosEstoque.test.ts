/**
 * The stock sync's closed vocabulary: the slug pairing, the subsets and their
 * algebra, the counters, and that every token fits the run's counter map.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { CHAVE_CONTAGEM_ESTOQUE_AMAZON_REGEX } from '@delfrance/schemas';

import {
  CONTADOR_ESTOQUE_AMAZON,
  type ContadorEstoqueAmazon,
  MOTIVO_ESTOQUE_AMAZON,
  type MotivoEstoqueAmazon,
  RECUSAS_HUMANAS_ESTOQUE_AMAZON,
  RECUSAS_LISTING_ESTOQUE_AMAZON,
  RECUSAS_VINCULO_ESTOQUE_AMAZON,
} from './motivosEstoque';

const TODOS: readonly MotivoEstoqueAmazon[] = Object.values(MOTIVO_ESTOQUE_AMAZON);
const CONTADORES: readonly ContadorEstoqueAmazon[] = Object.values(CONTADOR_ESTOQUE_AMAZON);

/** kebab-case → camelCase. */
const camel = (slug: string) => slug.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

describe('the outcomes', () => {
  it('every key is its slug in camelCase, and the slugs are distinct', () => {
    for (const [chave, slug] of Object.entries(MOTIVO_ESTOQUE_AMAZON))
      expect(chave).toBe(camel(slug));
    expect(new Set(TODOS).size).toBe(TODOS.length);
  });

  it('★ the closed set is exactly the stock sync’s outcomes, refusals and batch forms', () => {
    expect([...TODOS].sort()).toEqual(
      [
        'enviado',
        'igual',
        'simulado',
        'desligado',
        'fora-do-canario',
        'sem-caminho',
        'vinculo-ambiguo',
        'produto-ausente',
        'filho-com-sku-do-pai',
        'unidade-com-variacoes',
        'envio-desligado',
        'pai-do-vinculo-ilegivel',
        'unidade-ausente',
        'conta-sem-deposito',
        'conta-indisponivel',
        'deposito-mudou',
        'nao-listado',
        'nao-confirmado',
        'pai',
        'afn',
        'asin-divergente',
        'leitura-falhou',
        'escrita-falhou',
        'escrita-incerta',
        'prazo-da-tarefa',
        'pausado',
        'orcamento-esgotado',
        'snapshot-lento',
        'janela-grande',
        'em-patches',
        'em-feed',
        'em-reconciliacao',
        'repassado-para-patches',
        'ja-visto',
      ].sort(),
    );
  });

  it('the link verdict’s refusals are exactly six; the listing gate’s exactly four; the two disjoint', () => {
    expect([...RECUSAS_VINCULO_ESTOQUE_AMAZON].sort()).toEqual(
      [
        'vinculo-ambiguo',
        'produto-ausente',
        'pai-do-vinculo-ilegivel',
        'filho-com-sku-do-pai',
        'unidade-com-variacoes',
        'envio-desligado',
      ].sort(),
    );
    expect([...RECUSAS_LISTING_ESTOQUE_AMAZON].sort()).toEqual(
      ['nao-listado', 'pai', 'afn', 'asin-divergente'].sort(),
    );
    for (const m of RECUSAS_LISTING_ESTOQUE_AMAZON) {
      expect(RECUSAS_VINCULO_ESTOQUE_AMAZON.has(m), m).toBe(false);
    }
  });

  it('sem-caminho is decided by the patch path, neither by the verdict nor by the gate', () => {
    expect(RECUSAS_VINCULO_ESTOQUE_AMAZON.has(MOTIVO_ESTOQUE_AMAZON.semCaminho)).toBe(false);
    expect(RECUSAS_LISTING_ESTOQUE_AMAZON.has(MOTIVO_ESTOQUE_AMAZON.semCaminho)).toBe(false);
  });
});

describe('★ the refusals a person must fix', () => {
  it('are exactly the ambiguous link, the gone produto, the child with its parent’s identity, the unit with variations and the unreadable pointer', () => {
    expect([...RECUSAS_HUMANAS_ESTOQUE_AMAZON].sort()).toEqual(
      [
        'vinculo-ambiguo',
        'produto-ausente',
        'filho-com-sku-do-pai',
        'unidade-com-variacoes',
        'pai-do-vinculo-ilegivel',
      ].sort(),
    );
  });

  it('are all link refusals', () => {
    for (const m of RECUSAS_HUMANAS_ESTOQUE_AMAZON) {
      expect(RECUSAS_VINCULO_ESTOQUE_AMAZON.has(m), m).toBe(true);
    }
  });

  it('NEAR-MISSES: the operator’s own opt-out, the path, and the listing gate never avisa', () => {
    for (const m of [
      MOTIVO_ESTOQUE_AMAZON.envioDesligado,
      MOTIVO_ESTOQUE_AMAZON.semCaminho,
      MOTIVO_ESTOQUE_AMAZON.naoListado,
      MOTIVO_ESTOQUE_AMAZON.pai,
      MOTIVO_ESTOQUE_AMAZON.afn,
      MOTIVO_ESTOQUE_AMAZON.asinDivergente,
      MOTIVO_ESTOQUE_AMAZON.unidadeAusente,
      MOTIVO_ESTOQUE_AMAZON.naoConfirmado,
    ]) {
      expect(RECUSAS_HUMANAS_ESTOQUE_AMAZON.has(m), m).toBe(false);
    }
  });
});

describe('the counters', () => {
  it('★ are exactly the six counted shapes, each its own key', () => {
    expect([...CONTADORES].sort()).toEqual(
      [
        'pacote',
        'semRelacoes',
        'semAsinNaAmazon',
        'semAsinNoVinculo',
        'confirmadoPorGet',
        'zeroSemLinha',
      ].sort(),
    );
    for (const [chave, valor] of Object.entries(CONTADOR_ESTOQUE_AMAZON)) expect(chave).toBe(valor);
  });

  it('★ every slug and counter is a token the run’s counter map accepts, and the two sets are disjoint', () => {
    for (const token of [...TODOS, ...CONTADORES]) {
      expect(CHAVE_CONTAGEM_ESTOQUE_AMAZON_REGEX.test(token), token).toBe(true);
    }
    const motivos = new Set<string>(TODOS);
    for (const c of CONTADORES) expect(motivos.has(c), c).toBe(false);
  });
});

describe('the module stays LIGHT', () => {
  it('imports nothing', () => {
    const texto = readFileSync(new URL('./motivosEstoque.ts', import.meta.url), 'utf8');
    expect(texto).not.toMatch(/^\s*import\b/m);
    expect(texto).not.toMatch(/\brequire\(/);
  });
});
