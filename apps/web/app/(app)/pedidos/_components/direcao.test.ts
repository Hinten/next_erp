import { describe, expect, it } from 'vitest';

import { DIRECAO, direcaoOf } from './direcao';

describe('direcaoOf', () => {
  it('maps explicit false to entrada', () => {
    expect(direcaoOf(false)).toBe('entrada');
  });

  it('maps true to saída', () => {
    expect(direcaoOf(true)).toBe('saida');
  });

  it('maps null/undefined to saída (schema default)', () => {
    expect(direcaoOf(null)).toBe('saida');
    expect(direcaoOf(undefined)).toBe('saida');
  });
});

describe('DIRECAO', () => {
  it('carries the matching ehSaida flag per direction', () => {
    expect(DIRECAO.saida.ehSaida).toBe(true);
    expect(DIRECAO.entrada.ehSaida).toBe(false);
  });

  it('routes novo/editar under the direction list path', () => {
    for (const cfg of Object.values(DIRECAO)) {
      expect(cfg.novoPath).toBe(`${cfg.listPath}/novo`);
      expect(cfg.editarPath('abc123')).toBe(`${cfg.listPath}/abc123/editar`);
    }
  });

  it('round-trips through direcaoOf', () => {
    expect(direcaoOf(DIRECAO.saida.ehSaida)).toBe('saida');
    expect(direcaoOf(DIRECAO.entrada.ehSaida)).toBe('entrada');
  });

  it('carries a per-direction list description', () => {
    expect(DIRECAO.saida.listDescription).toBe(
      'Selecione pedidos e use o botão acima da tabela para emitir NF-e.',
    );
    expect(DIRECAO.entrada.listDescription).toBe('Entradas de mercadoria — compras e devoluções.');
  });
});
