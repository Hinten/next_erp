import { describe, expect, it } from 'vitest';
import { ACAO_BLOQUEADA, ORIGEM_INCIDENTE, STATUS_CLAIM, TIPO_INCIDENTE } from '@delfrance/schemas';

import { calcularMarcadores } from './sincronizarBloqueioIncidente';

/**
 * The pedido-level fold (#1322): a pedido's incidentes → the two markers plus
 * the released-actions union.
 */

const NOW = 9_000_000;

function incML(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    origem: ORIGEM_INCIDENTE.pedidoMercadoLivre,
    tipo: TIPO_INCIDENTE.mediacaoDoMarketplace,
    claimStatus: STATUS_CLAIM.aberta,
    resolucao: null,
    entregue: null,
    timestamp: 1_000,
    ...over,
  };
}

describe('calcularMarcadores', () => {
  it('no incidentes → nothing set', () => {
    expect(calcularMarcadores([], NOW)).toEqual({
      disputaAbertaEm: null,
      devolucaoAbertaEm: null,
      bloqueiosLiberados: null,
    });
  });

  it('separates the two markers by kind', () => {
    const out = calcularMarcadores(
      [incML({ timestamp: 5_000 }), incML({ tipo: TIPO_INCIDENTE.devolucao, timestamp: 7_000 })],
      NOW,
    );
    expect(out.disputaAbertaEm).toBe(5_000);
    expect(out.devolucaoAbertaEm).toBe(7_000);
  });

  it('keeps the OLDEST of each kind', () => {
    // So the banner can say how long the pedido has been held, rather than
    // resetting every time ML sends another update on the same claim.
    const out = calcularMarcadores(
      [incML({ timestamp: 8_000 }), incML({ timestamp: 2_000 }), incML({ timestamp: 5_000 })],
      NOW,
    );
    expect(out.disputaAbertaEm).toBe(2_000);
  });

  it('an incidente with no timestamp still blocks, standing in at `nowUs`', () => {
    const out = calcularMarcadores([incML({ timestamp: null })], NOW);
    expect(out.disputaAbertaEm).toBe(NOW);
  });

  it('a closed claim contributes nothing', () => {
    const out = calcularMarcadores([incML({ claimStatus: STATUS_CLAIM.fechada })], NOW);
    expect(out).toEqual({
      disputaAbertaEm: null,
      devolucaoAbertaEm: null,
      bloqueiosLiberados: null,
    });
  });

  it('a non-marketplace incidente contributes nothing', () => {
    const out = calcularMarcadores(
      [incML({ origem: ORIGEM_INCIDENTE.troca, tipo: TIPO_INCIDENTE.devolucao })],
      NOW,
    );
    expect(out.devolucaoAbertaEm).toBeNull();
  });

  it('an incidente with an UNPARSEABLE tipo is skipped, not guessed', () => {
    // Guessing would either block a pedido for no reason or silently fail to
    // block one; both are worse than treating it as a data problem.
    const out = calcularMarcadores([incML({ tipo: 'nao-e-um-tipo' })], NOW);
    expect(out.disputaAbertaEm).toBeNull();
  });

  it('unions the released actions across OPEN incidentes', () => {
    const out = calcularMarcadores(
      [
        incML({ overrideBloqueio: { acoes: [ACAO_BLOQUEADA.despacho] } }),
        incML({
          tipo: TIPO_INCIDENTE.devolucao,
          overrideBloqueio: { acoes: [ACAO_BLOQUEADA.finalizar] },
        }),
      ],
      NOW,
    );
    expect(out.bloqueiosLiberados).toEqual(['despacho', 'finalizar']);
  });

  it('⚠️ an override on a CLOSED incidente releases nothing — the self-clearing half', () => {
    // This is what stops a release outliving the claim that justified it and
    // silently unblocking the NEXT dispute on the same pedido. Mutation check:
    // move the union above the `continue` and this fails.
    const out = calcularMarcadores(
      [
        incML({
          claimStatus: STATUS_CLAIM.fechada,
          overrideBloqueio: { acoes: [ACAO_BLOQUEADA.despacho] },
        }),
        incML({ timestamp: 3_000 }),
      ],
      NOW,
    );
    expect(out.disputaAbertaEm).toBe(3_000);
    expect(out.bloqueiosLiberados).toBeNull();
  });

  it('drops an unknown action name rather than voiding the whole override', () => {
    const out = calcularMarcadores(
      [incML({ overrideBloqueio: { acoes: ['nao-existe', ACAO_BLOQUEADA.nfe] } })],
      NOW,
    );
    expect(out.bloqueiosLiberados).toEqual(['nfe']);
  });

  it('a malformed override is inert, never a throw', () => {
    for (const overrideBloqueio of [null, 'texto', 42, {}, { acoes: 'despacho' }]) {
      const out = calcularMarcadores([incML({ overrideBloqueio })], NOW);
      expect(out.bloqueiosLiberados, JSON.stringify(overrideBloqueio)).toBeNull();
      // The block itself must survive a broken override.
      expect(out.disputaAbertaEm).toBe(1_000);
    }
  });
});
