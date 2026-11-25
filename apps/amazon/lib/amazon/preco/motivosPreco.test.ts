/**
 * The price push's closed vocabulary: the slug pairing, the subsets against
 * the shared verdict and gate, and that every token fits the run's counter map.
 */
import { describe, expect, it } from 'vitest';
import { CHAVE_CONTAGEM_ESTOQUE_AMAZON_REGEX } from '@delfrance/schemas';

import { MOTIVO_GATE_LISTING_AMAZON } from '../listings/gateListing';
import { MOTIVO_VINCULO_LISTING_AMAZON } from '../listings/vinculoListing';
import { DECISAO_PLANO_PRECO_AMAZON } from './planoPreco';
import {
  MOTIVO_PRECO_AMAZON,
  type MotivoPrecoAmazon,
  RECUSAS_LISTING_PRECO_AMAZON,
  RECUSAS_VINCULO_PRECO_AMAZON,
} from './motivosPreco';

const TODOS: readonly MotivoPrecoAmazon[] = Object.values(MOTIVO_PRECO_AMAZON);
const camel = (slug: string) => slug.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

describe('the outcomes', () => {
  it('every key is its slug in camelCase, and the slugs are distinct', () => {
    for (const [chave, slug] of Object.entries(MOTIVO_PRECO_AMAZON))
      expect(chave).toBe(camel(slug));
    expect(new Set(TODOS).size).toBe(TODOS.length);
  });

  it('★ the closed set is exactly the price push’s outcomes', () => {
    expect([...TODOS].sort()).toEqual(
      [
        'enviado',
        'igual',
        'simulado',
        'desligado',
        'fora-do-canario',
        'previa',
        'reducao-sem-consentimento',
        'reducao-apos-pagina',
        'preco-atual-ilegivel',
        'conta-sem-tabela-normal',
        'sem-preco',
        'faixa-invertida',
        'tipo-produto-ilegivel',
        'vinculo-ambiguo',
        'produto-ausente',
        'pai-do-vinculo-ilegivel',
        'filho-com-sku-do-pai',
        'unidade-com-variacoes',
        'sem-caminho',
        'nao-listado',
        'pai',
        'asin-divergente',
        'nao-confirmado',
        'leitura-falhou',
        'conta-indisponivel',
        'aguardando-feed',
        'execucao-substituida',
        'execucao-cancelada',
        'superado',
        'erp-mudou',
        'aceito',
        'aceito-com-avisos',
        'recusado',
        'escrita-falhou',
        'escrita-incerta',
        'prazo-da-tarefa',
        'pausado',
        'vinculo-mudou',
        'parte-ausente',
        'ja-visto',
      ].sort(),
    );
  });

  it('every slug is a key the run’s counter map accepts (they are persisted)', () => {
    for (const slug of TODOS)
      expect(CHAVE_CONTAGEM_ESTOQUE_AMAZON_REGEX.test(slug), slug).toBe(true);
  });

  it('the plan’s refusals are outcomes, under the same slugs', () => {
    for (const decisao of Object.values(DECISAO_PLANO_PRECO_AMAZON)) {
      if (decisao === 'igual' || decisao === 'escrever') continue;
      expect(TODOS).toContain(decisao);
    }
  });
});

describe('★ the subsets, against the shared verdict and gate', () => {
  it('the verdict’s refusals are the shared verdict’s 1–4; NEAR-MISS: the stock flow’s `envio-desligado` is not one', () => {
    expect([...RECUSAS_VINCULO_PRECO_AMAZON].sort()).toEqual(
      Object.values(MOTIVO_VINCULO_LISTING_AMAZON)
        .filter((m) => m !== MOTIVO_VINCULO_LISTING_AMAZON.envioDesligado)
        .sort(),
    );
    expect(TODOS).not.toContain(MOTIVO_VINCULO_LISTING_AMAZON.envioDesligado);
  });

  it('the gate’s refusals are the shared gate’s three (no `afn`: price does not refuse one)', () => {
    expect([...RECUSAS_LISTING_PRECO_AMAZON].sort()).toEqual(
      Object.values(MOTIVO_GATE_LISTING_AMAZON).sort(),
    );
    expect(TODOS).not.toContain('afn');
  });
});
