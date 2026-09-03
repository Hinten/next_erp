import { describe, expect, it } from 'vitest';
import { INTEGRACAO_TIPO, type IntegracaoTipo } from '@delfrance/schemas';

import {
  type AcaoCanal,
  capsPermitem,
  mensagemNaoSuportado,
  motivoDaCapacidade,
  vereditoCanal,
} from './suporteCanal';

/** Stand-in for a registry map — only its keys matter here. */
const COM_ML = { [INTEGRACAO_TIPO.mercadoLivre]: {} } as Partial<Record<IntegracaoTipo, object>>;
const VAZIO = {} as Partial<Record<IntegracaoTipo, object>>;

describe('motivoDaCapacidade — the precedence, exhaustively', () => {
  it.each([
    ['nao', true, 'canal-nao-suportado'],
    ['nao', false, 'canal-nao-suportado'],
    ['desconhecido', true, 'canal-nao-pesquisado'],
    ['desconhecido', false, 'canal-nao-pesquisado'],
    ['sim', false, 'canal-nao-implementado'],
  ] as const)('suporte=%s implementado=%s → %s', (suporte, implementado, esperado) => {
    expect(motivoDaCapacidade(suporte, implementado)).toBe(esperado);
  });

  it('nothing stands in the way when the provider can and we built it', () => {
    expect(motivoDaCapacidade('sim', true)).toBeNull();
  });

  /**
   * ⚠️ The near-misses. Each pair differs in ONE fact and must NOT collapse
   * onto the same reason — collapsing them is the whole defect #1430 fixes,
   * where four situations shared one sentence.
   */
  it('keeps "cannot" distinct from "nobody checked"', () => {
    expect(motivoDaCapacidade('nao', false)).not.toBe(motivoDaCapacidade('desconhecido', false));
  });

  it('keeps "nobody checked" distinct from "we have not built it"', () => {
    expect(motivoDaCapacidade('desconhecido', false)).not.toBe(motivoDaCapacidade('sim', false));
  });

  it('a provider that CANNOT stays "cannot" even once the channel is built', () => {
    // The one arm that does not soften with `implementado` — shipping a backend
    // does not teach a marketplace an endpoint it does not have.
    expect(motivoDaCapacidade('nao', true)).toBe('canal-nao-suportado');
  });
});

describe('vereditoCanal / capsPermitem — against the real table', () => {
  const acoes: readonly AcaoCanal[] = ['estoque', 'preco', 'anuncioStatus'];

  it.each(acoes)('Mercado Livre supports %s and its provider is registered', (acao) => {
    expect(capsPermitem(acao, INTEGRACAO_TIPO.mercadoLivre)).toBe(true);
    expect(vereditoCanal(acao, INTEGRACAO_TIPO.mercadoLivre, COM_ML)).toEqual({ suportado: true });
  });

  it.each(acoes)('an unbuilt channel is "nobody checked", not "cannot", for %s', (acao) => {
    // Shopee/Amazon/Magalu/Loja Integrada/Facebook are all `'desconhecido'` on
    // these three today. Reading that as `'nao'` is the false claim #815 undid.
    expect(vereditoCanal(acao, INTEGRACAO_TIPO.shopee, COM_ML)).toEqual({
      suportado: false,
      motivo: 'canal-nao-pesquisado',
    });
    expect(capsPermitem(acao, INTEGRACAO_TIPO.shopee)).toBe(false);
  });

  it.each([INTEGRACAO_TIPO.balcao, INTEGRACAO_TIPO.whatsapp, INTEGRACAO_TIPO.nenhuma])(
    'tipo %s is not a marketplace at all',
    (tipo) => {
      expect(vereditoCanal('estoque', tipo, COM_ML)).toEqual({
        suportado: false,
        motivo: 'nao-marketplace',
      });
    },
  );

  it('a tipo outside the enum answers "not a marketplace" instead of throwing', () => {
    // Firestore documents reach the UI unparsed and the migrated corpus carries
    // wire-format enums this union does not model.
    expect(vereditoCanal('estoque', 9999 as IntegracaoTipo, COM_ML)).toEqual({
      suportado: false,
      motivo: 'nao-marketplace',
    });
  });

  it('caps saying yes with no registered provider is a WIRING gap, named as one', () => {
    expect(vereditoCanal('estoque', INTEGRACAO_TIPO.mercadoLivre, VAZIO)).toEqual({
      suportado: false,
      motivo: 'canal-sem-provider',
    });
    // ⚠️ And `capsPermitem` still says yes — the two questions are different,
    // which is exactly what the registries' drift test compares.
    expect(capsPermitem('estoque', INTEGRACAO_TIPO.mercadoLivre)).toBe(true);
  });
});

describe('mensagemNaoSuportado', () => {
  it('names the conta and the channel in every arm', () => {
    const motivos = [
      'nao-marketplace',
      'canal-nao-suportado',
      'canal-nao-pesquisado',
      'canal-nao-implementado',
      'canal-sem-provider',
    ] as const;
    for (const motivo of motivos) {
      const msg = mensagemNaoSuportado(motivo, 'estoque', 'Shopee BR', INTEGRACAO_TIPO.shopee);
      expect(msg, motivo).toContain('Shopee BR');
      expect(msg, motivo).toContain('Shopee');
    }
  });

  it('gives each reason its OWN sentence', () => {
    const ditas = new Set(
      (
        [
          'nao-marketplace',
          'canal-nao-suportado',
          'canal-nao-pesquisado',
          'canal-nao-implementado',
          'canal-sem-provider',
        ] as const
      ).map((m) => mensagemNaoSuportado(m, 'preco', 'Conta', INTEGRACAO_TIPO.magalu)),
    );
    expect(ditas.size).toBe(5);
  });

  it('names the ACTION, so the same channel reads differently per operation', () => {
    const estoque = mensagemNaoSuportado(
      'canal-nao-pesquisado',
      'estoque',
      'Conta',
      INTEGRACAO_TIPO.magalu,
    );
    const preco = mensagemNaoSuportado(
      'canal-nao-pesquisado',
      'preco',
      'Conta',
      INTEGRACAO_TIPO.magalu,
    );
    expect(estoque).toContain('envio de estoque');
    expect(preco).toContain('envio de preços');
    expect(estoque).not.toBe(preco);
  });

  it('never claims the legacy app is where to do it instead', () => {
    // Root `CLAUDE.md` rule 8: there is no dual run, and the legacy app is
    // switched OFF at the cutover. The sentence it replaced said the opposite.
    const msg = mensagemNaoSuportado(
      'canal-nao-pesquisado',
      'estoque',
      'Shopee BR',
      INTEGRACAO_TIPO.shopee,
    );
    expect(msg).not.toContain('aplicativo antigo');
  });

  it('degrades to a readable label for a tipo outside the enum', () => {
    const msg = mensagemNaoSuportado(
      'nao-marketplace',
      'estoque',
      'Conta legada',
      9999 as IntegracaoTipo,
    );
    expect(msg).toContain('Conta legada');
    expect(msg).toContain('canal desconhecido');
  });
});
