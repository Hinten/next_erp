/**
 * The NF-e upload's closed vocabulary (step 14, PR 14-b): the slug pairing,
 * the three sets and their algebra, and the pt-BR fragments' shape.
 */
import { describe, expect, it } from 'vitest';

import {
  FRASE_DO_ERRO_NFE_AMAZON,
  MOTIVO_NFE_AMAZON,
  MOTIVOS_NFE_QUE_AVISAM,
  MOTIVOS_NFE_QUE_CARIMBAM,
  MOTIVOS_NFE_SO_LOG,
  MOTIVOS_NFE_SO_LOG_EM_WARNING,
  type MotivoNfeAmazon,
  fraseDoErroNfeAmazon,
  motivoNfeAvisa,
} from './motivosNfe';

const TODOS: readonly MotivoNfeAmazon[] = Object.values(MOTIVO_NFE_AMAZON);

/** kebab-case → camelCase. */
const camel = (slug: string) => slug.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

describe('the vocabulary', () => {
  it('every key is its slug in camelCase, and the slugs are distinct', () => {
    for (const [chave, slug] of Object.entries(MOTIVO_NFE_AMAZON)) expect(chave).toBe(camel(slug));
    expect(new Set(TODOS).size).toBe(TODOS.length);
    expect(TODOS.length).toBe(34);
  });

  it('★ every motivo is in exactly ONE of A (avisa) or log-only', () => {
    for (const m of TODOS) {
      expect(Number(MOTIVOS_NFE_QUE_AVISAM.has(m)) + Number(MOTIVOS_NFE_SO_LOG.has(m)), m).toBe(1);
    }
    expect(MOTIVOS_NFE_QUE_AVISAM.size + MOTIVOS_NFE_SO_LOG.size).toBe(TODOS.length);
  });

  it('★ CARIMBAM ⊂ AVISAM (a stamp nobody is told about stops a pedido silently)', () => {
    for (const m of MOTIVOS_NFE_QUE_CARIMBAM) expect(MOTIVOS_NFE_QUE_AVISAM.has(m), m).toBe(true);
  });

  it('S is exactly the five deterministic answers about THIS NF-e', () => {
    expect([...MOTIVOS_NFE_QUE_CARIMBAM].sort()).toEqual(
      [
        'xml-invalido',
        'envio-recusado',
        'nfe-grande-demais',
        'nfe-recusada',
        'nfe-nao-registrada',
      ].sort(),
    );
  });

  it('★ mutation 14: no stamp on the valve, the switches, the conta, a transient, the ladder’s end or an answer about the ORDER', () => {
    for (const m of [
      'envio-nao-ligado',
      'chamadas-desligadas',
      'tarefas-desligadas',
      'conta-indisponivel',
      'sem-permissao',
      'amazon-indisponivel',
      'aceite-nao-confirmado',
      'envio-nao-confirmado',
      'pedido-nao-encontrado-na-amazon',
      'nfe-substituta',
      'nfe-ambigua',
      'nfe-cancelada',
      'nfe-parcialmente-aceita',
      'status-nfe-desconhecido',
    ] as const) {
      expect(MOTIVOS_NFE_QUE_AVISAM.has(m), m).toBe(true);
      expect(MOTIVOS_NFE_QUE_CARIMBAM.has(m), m).toBe(false);
    }
  });

  it('the log-only set, and its WARNING subset', () => {
    expect([...MOTIVOS_NFE_SO_LOG].sort()).toEqual(
      [
        'nfe-nao-pronta',
        'nao-amazon',
        'nfe-nao-e-de-venda',
        'nao-dba',
        'nf-nao-requerida',
        'marketplace-estrangeiro',
        'pedido-cancelado',
        'ja-aceita',
        'emissao-bloqueada',
        'conta-inativa',
        'taxa-limitada',
        'pos-envio-falhou',
      ].sort(),
    );
    expect([...MOTIVOS_NFE_SO_LOG_EM_WARNING].sort()).toEqual(
      [
        'emissao-bloqueada',
        'conta-inativa',
        'nao-dba',
        'nf-nao-requerida',
        'marketplace-estrangeiro',
        'pos-envio-falhou',
      ].sort(),
    );
    for (const m of MOTIVOS_NFE_SO_LOG_EM_WARNING) expect(MOTIVOS_NFE_SO_LOG.has(m), m).toBe(true);
  });

  it('motivoNfeAvisa agrees with the A set', () => {
    for (const m of TODOS) expect(motivoNfeAvisa(m), m).toBe(MOTIVOS_NFE_QUE_AVISAM.has(m));
  });
});

describe('the fragments', () => {
  it('★ every A member has a fragment, and nothing else does', () => {
    expect(Object.keys(FRASE_DO_ERRO_NFE_AMAZON).sort()).toEqual(
      [...MOTIVOS_NFE_QUE_AVISAM].sort(),
    );
  });

  it.each([...MOTIVOS_NFE_QUE_AVISAM])(
    '%s: lowercase start, no trailing period, no digit run of 8+, no code, no URL',
    (motivo) => {
      const frase = fraseDoErroNfeAmazon(motivo);
      expect(frase.length).toBeGreaterThan(20);
      const primeira = frase.charAt(0);
      expect(primeira).toBe(primeira.toLocaleLowerCase('pt-BR'));
      expect(primeira).not.toBe(primeira.toLocaleUpperCase('pt-BR'));
      expect(frase.trimEnd()).toBe(frase);
      expect(frase).not.toMatch(/[.!]$/);
      expect(frase).not.toMatch(/\d{8,}/);
      expect(frase).not.toMatch(/EntityNotFound|InvalidInput|Errored|Rejected|https?:/);
    },
  );

  it('★ remedy first: every fragment is ONE remedy, a dash, then ONE cause', () => {
    // The remedy's opening words, closed: a fragment that leads with its cause
    // (or with no dash at all) fails here, whatever its case.
    const REMEDIO = /^(confira|emita|envie|reenvie|acione|reconecte|responda|se a nf-e) /;
    for (const m of MOTIVOS_NFE_QUE_AVISAM) {
      const partes = fraseDoErroNfeAmazon(m).toLocaleLowerCase('pt-BR').split(' — ');
      expect(partes, m).toHaveLength(2);
      const [remedio = '', causa = ''] = partes;
      expect(remedio, m).toMatch(REMEDIO);
      expect(causa, m).not.toMatch(REMEDIO);
    }
  });

  it('★ nfe-ambigua never claims Amazon holds nothing: it fires on aceita too, and in a verification after our own submit', () => {
    const frase = fraseDoErroNfeAmazon(MOTIVO_NFE_AMAZON.nfeAmbigua).toLocaleLowerCase('pt-BR');
    expect(frase).not.toContain('nenhuma foi enviada');
    // It asks which note Amazon holds BEFORE anything is cancelled.
    expect(frase.startsWith('confira na seller central qual nf-e a amazon tem')).toBe(true);
  });

  it('★ a fragment that asks for a new note says to cancel the authorized one FIRST, and never to drop items', () => {
    for (const m of [MOTIVO_NFE_AMAZON.nfeGrandeDemais, MOTIVO_NFE_AMAZON.nfeRecusada] as const) {
      const frase = fraseDoErroNfeAmazon(m).toLocaleLowerCase('pt-BR');
      expect(frase, m).toContain('cancele-a na sefaz antes de emitir');
      expect(frase, m).toContain('seller central');
    }
    for (const m of MOTIVOS_NFE_QUE_AVISAM) {
      expect(fraseDoErroNfeAmazon(m).toLocaleLowerCase('pt-BR'), m).not.toMatch(/menos itens/);
    }
  });

  it('★ nfe-substituta is ADVISORY: it asks which note Amazon holds before anything is sent', () => {
    const frase = fraseDoErroNfeAmazon(MOTIVO_NFE_AMAZON.nfeSubstituta).toLocaleLowerCase('pt-BR');
    expect(frase.startsWith('confira na seller central qual nf-e a amazon tem')).toBe(true);
    expect(frase).toContain('se for a cancelada');
  });

  it('a log-only motivo has no fragment (a RangeError, nothing to write)', () => {
    for (const m of MOTIVOS_NFE_SO_LOG)
      expect(() => fraseDoErroNfeAmazon(m), m).toThrow(RangeError);
  });
});
