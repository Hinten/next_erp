/*
 * The vocabulary and its text table (#1523, step 15). The first two `describe`
 * blocks below were CUT from `errosEtiqueta.test.ts` and pasted unedited when
 * the vocabulary moved to `motivosEtiqueta.ts` (review 1, R5-2); the third is
 * step 15b's (#1744), the fragment accessor the despacho aviso embeds.
 */
import { describe, expect, it } from 'vitest';

import {
  MOTIVO_ETIQUETA_SHOPEE,
  fraseDoMotivoEtiqueta,
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

/** The first letter capitalized, re-derived here — the module's own helper is not imported. */
function capitalizar(texto: string): string {
  return `${texto.charAt(0).toLocaleUpperCase('pt-BR')}${texto.slice(1)}`;
}

/**
 * A FRAGMENT: non-empty, no surrounding blank, opens on a letter that
 * capitalizing CHANGES, and carries no closing period.
 */
function ehFragmento(texto: string): boolean {
  if (texto.length === 0 || texto !== texto.trim()) return false;
  if (texto.endsWith('.')) return false;
  return texto.charAt(0) !== capitalizar(texto).charAt(0);
}

describe('fraseDoMotivoEtiqueta — o fragmento que o aviso de despacho embute (passo 15b)', () => {
  it.each(TODOS)('%s: é um FRAGMENTO — começa minúsculo e não termina em ponto', (motivo) => {
    expect(ehFragmento(fraseDoMotivoEtiqueta(motivo))).toBe(true);
  });

  it.each(TODOS)(
    '%s: a frase do operador é EXATAMENTE o fragmento capitalizado + UM ponto',
    (motivo) => {
      const fragmento = fraseDoMotivoEtiqueta(motivo);
      expect(mensagemDoMotivoEtiqueta(motivo)).toBe(`${capitalizar(fragmento)}.`);
      // NEAR-MISSES: the fragment is neither the sentence itself nor the
      // sentence minus its period — capitalizing it must CHANGE it.
      expect(fragmento).not.toBe(mensagemDoMotivoEtiqueta(motivo));
      expect(fragmento).not.toBe(capitalizar(fragmento));
    },
  );

  it('o fragmento por valor é a frase congelada acima sem a maiúscula e sem o ponto', () => {
    expect(fraseDoMotivoEtiqueta(MOTIVO_ETIQUETA_SHOPEE.agenciaPrecisaEscolha)).toBe(
      'escolha a agência na Central do Vendedor e clique de novo — a Shopee oferece mais de uma agência para este envio',
    );
    expect(fraseDoMotivoEtiqueta(MOTIVO_ETIQUETA_SHOPEE.semHorarioOuAgencia)).toBe(
      'tente de novo mais tarde ou organize o envio na Central do Vendedor — a Shopee não encontrou horário de coleta ou agência de postagem disponível para este envio',
    );
  });

  it('o próprio predicado de fragmento pega o que deve pegar (near-miss onde capitalizar não muda nada)', () => {
    // The pair: plain and accented lowercase starts are fragments.
    expect(ehFragmento('escolha a agência')).toBe(true);
    expect(ehFragmento('é feito pela logística do vendedor')).toBe(true);
    // Near-misses where capitalizing changes NOTHING — an already capitalized
    // start, or no letter at all — so the equality above could not tell the
    // fragment from the sentence.
    expect(ehFragmento('Escolha a agência')).toBe(false);
    expect(ehFragmento('É feito pela logística do vendedor')).toBe(false);
    expect(ehFragmento('— a Shopee recusou')).toBe(false);
    // …and the other two shapes a fragment must not take.
    expect(ehFragmento('escolha a agência.')).toBe(false);
    expect(ehFragmento(' escolha a agência')).toBe(false);
    expect(ehFragmento('')).toBe(false);
  });
});
