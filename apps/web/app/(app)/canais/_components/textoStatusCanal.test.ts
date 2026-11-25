import { INTEGRACAO_TIPO, marketplaceCapsFor } from '@delfrance/schemas';
import { describe, expect, it } from 'vitest';

import { textoStatusCanal } from './textoStatusCanal';

describe('textoStatusCanal', () => {
  it('explains non-marketplace integrations without an implementation alert', () => {
    expect(textoStatusCanal(null)).toEqual({
      dica: 'Não é um canal de marketplace (balcão, WhatsApp)',
      alerta: null,
    });
  });

  it('names the backend of an implemented channel without an implementation alert', () => {
    expect(textoStatusCanal({ channel: 'mercado-livre', implementado: true })).toEqual({
      dica: 'Backend: apps/mercado-livre',
      alerta: null,
    });
  });

  it('shows the missing-backend copy for an unfinished channel with no backend name', () => {
    const { dica, alerta } = textoStatusCanal({ channel: null, implementado: false });
    expect(dica).toBe('Nenhum backend implementado para este canal ainda');
    expect(alerta).not.toBeNull();
  });

  it('names the backend and the unavailable bulk actions for an unfinished channel', () => {
    const { dica, alerta } = textoStatusCanal({ channel: 'loja-integrada', implementado: false });
    expect(dica).toBe(
      'Backend apps/loja-integrada em construção — as ações de /produtos (estoque, preços, pausa) ainda não chegam a este canal',
    );
    expect(dica).not.toContain('Nenhum backend');
    expect(alerta).not.toBeNull();
  });

  // Revisit the operator-facing copy when either channel reaches step 22.
  it.each([
    { tipo: INTEGRACAO_TIPO.lojaIntegrada, channel: 'loja-integrada' },
    { tipo: INTEGRACAO_TIPO.amazon, channel: 'amazon' },
  ])('shows the backend under construction for the live $channel row', ({ tipo, channel }) => {
    const { dica, alerta } = textoStatusCanal(marketplaceCapsFor(tipo));
    expect(dica).toContain(`Backend apps/${channel} em construção`);
    expect(alerta).not.toBeNull();
  });
});
