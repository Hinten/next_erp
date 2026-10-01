/*
 * The vocabulary and its text table (#1523, step 15). Both `describe` blocks
 * below were CUT from `errosEtiqueta.test.ts` and pasted unedited when the
 * vocabulary moved to `motivosEtiqueta.ts` (review 1, R5-2).
 */
import { describe, expect, it } from 'vitest';

import {
  MOTIVO_ETIQUETA_SHOPEE,
  mensagemDoMotivoEtiqueta,
  type MotivoEtiquetaShopee,
} from './motivosEtiqueta';

/** Every slug, in the order the const declares them. */
const TODOS: readonly MotivoEtiquetaShopee[] = Object.values(MOTIVO_ETIQUETA_SHOPEE);

/** `'pedido-em-cancelamento'` → `'pedidoEmCancelamento'`. */
function camelDoSlug(slug: string): string {
  return slug.replace(/-([a-z])/g, (_, letra: string) => letra.toUpperCase());
}

describe('MOTIVO_ETIQUETA_SHOPEE — o vocabulário', () => {
  it('é exatamente o conjunto congelado do reconcile §2.3 (a slug viaja no 409)', () => {
    // Written out by value ON PURPOSE: the slug is persisted on the wire and the
    // web branches on it, so an added, dropped or renamed member must be a
    // reviewed edit of this list, never a side effect.
    expect([...TODOS].sort()).toEqual(
      [
        'agencia-precisa-escolha',
        'cadastro-do-vendedor',
        'conta-inativa',
        'conta-nao-configurada',
        'documento-falhou',
        'etiqueta-indisponivel',
        'frete-de-outra-integracao',
        'ip-nao-declarado',
        'janela-fechada',
        'limite-diario',
        'modo-nao-suportado',
        'nao-shopee',
        'nfe-pendente',
        'pacote-inelegivel',
        'pacote-inexistente',
        'pacote-nao-pronto',
        'pacotes-mudaram',
        'pedido-cancelado',
        'pedido-de-reserva',
        'pedido-em-cancelamento',
        'pedido-fbs',
        'recusa-desconhecida',
        'retido-pela-shopee',
        'sem-endereco-de-coleta',
        'sem-etiqueta-shopee',
        'sem-horario-ou-agencia',
        'sem-pacotes',
        'somente-seller-centre',
        'status-desconhecido',
        'tipo-invalido',
      ].sort(),
    );
  });

  it('cada chave é a slug em camelCase — o código nomeia o membro, nunca soletra a slug', () => {
    for (const [chave, slug] of Object.entries(MOTIVO_ETIQUETA_SHOPEE)) {
      expect(chave).toBe(camelDoSlug(slug));
    }
  });

  it('não há slug repetida', () => {
    expect(new Set(TODOS).size).toBe(TODOS.length);
  });
});

describe('mensagemDoMotivoEtiqueta — a frase do operador', () => {
  it.each(TODOS)('%s: uma frase completa — maiúscula, não vazia, termina em UM ponto', (motivo) => {
    const frase = mensagemDoMotivoEtiqueta(motivo);
    expect(frase.trim().length).toBeGreaterThan(1);
    expect(frase).toBe(frase.trim());
    expect(frase.endsWith('.')).toBe(true);
    // Near-miss: a fragment that already ended in a period would come back
    // with two — the capitalizer adds exactly one.
    expect(frase.endsWith('..')).toBe(false);
    const primeira = frase.charAt(0);
    expect(primeira).toBe(primeira.toLocaleUpperCase('pt-BR'));
    expect(primeira).not.toBe(primeira.toLocaleLowerCase('pt-BR'));
  });

  it.each(TODOS)(
    '%s: nenhuma sequência de 7+ dígitos (nunca um pedido, pacote ou rastreio)',
    (motivo) => {
      expect(mensagemDoMotivoEtiqueta(motivo)).not.toMatch(/\d{7,}/);
    },
  );

  it('o próprio teste de dígitos pega o que deve pegar (near-miss do padrão)', () => {
    // The guard above is only as good as its regex: a 7-digit run is caught,
    // a 6-digit one is not — so the pattern is not vacuously loose or tight.
    expect('pacote 1234567 pronto').toMatch(/\d{7,}/);
    expect('pacote 123456 pronto').not.toMatch(/\d{7,}/);
  });

  it('cada motivo tem a SUA frase — duas razões diferentes nunca dizem a mesma coisa', () => {
    const frases = TODOS.map((m) => mensagemDoMotivoEtiqueta(m));
    expect(new Set(frases).size).toBe(frases.length);
  });

  it('a frase de quem tem o que fazer começa pela ação (o formato do passo 14)', () => {
    expect(mensagemDoMotivoEtiqueta(MOTIVO_ETIQUETA_SHOPEE.agenciaPrecisaEscolha)).toBe(
      'Escolha a agência na Central do Vendedor e clique de novo — a Shopee oferece mais de uma agência para este envio.',
    );
    expect(mensagemDoMotivoEtiqueta(MOTIVO_ETIQUETA_SHOPEE.nfePendente)).toMatch(/^Envie a NF-e/);
    expect(mensagemDoMotivoEtiqueta(MOTIVO_ETIQUETA_SHOPEE.janelaFechada)).toMatch(
      /já coletou o pacote/,
    );
  });

  it('R4-1: sem horário ou agência NÃO culpa o endereço de coleta (near-miss: sem-endereco culpa)', () => {
    const semHorario = mensagemDoMotivoEtiqueta(MOTIVO_ETIQUETA_SHOPEE.semHorarioOuAgencia);
    expect(semHorario).toBe(
      'Tente de novo mais tarde ou organize o envio na Central do Vendedor — a Shopee não encontrou horário de coleta ou agência de postagem disponível para este envio.',
    );
    expect(semHorario).not.toMatch(/endereço/);
    expect(mensagemDoMotivoEtiqueta(MOTIVO_ETIQUETA_SHOPEE.semEnderecoDeColeta)).toMatch(
      /endereço de coleta/,
    );
  });
});
