import { describe, expect, it } from 'vitest';
import {
  ACAO_BLOQUEADA,
  ORIGEM_INCIDENTE,
  STATUS_CLAIM,
  TIPO_INCIDENTE,
  bloqueioDespachoAtivo,
  bloqueioFinalizarAtivo,
  bloqueioLiberado,
  bloqueioNFeAtivo,
  classificarIncidenteBloqueante,
  type IncidenteBloqueanteInput,
} from './pedido';

/**
 * The dispute overlay's pure core (#1322) — which incidentes block, which
 * marker they produce, and what each marker refuses.
 */

const ML: Pick<IncidenteBloqueanteInput, 'origem'> = {
  origem: ORIGEM_INCIDENTE.pedidoMercadoLivre,
};

function inc(over: Partial<IncidenteBloqueanteInput> = {}): IncidenteBloqueanteInput {
  return {
    ...ML,
    tipo: TIPO_INCIDENTE.mediacaoDoMarketplace,
    claimStatus: STATUS_CLAIM.aberta,
    resolucao: null,
    entregue: null,
    ...over,
  };
}

describe('classificarIncidenteBloqueante', () => {
  it('an open ML mediation is a disputa', () => {
    expect(classificarIncidenteBloqueante(inc())).toBe('disputa');
  });

  it('an open ML return is a devolucao', () => {
    expect(classificarIncidenteBloqueante(inc({ tipo: TIPO_INCIDENTE.devolucao }))).toBe(
      'devolucao',
    );
  });

  it('a mediation on an ALREADY-DELIVERED item is a devolucao, not a disputa', () => {
    // ML's `claim.fulfilled`. The distinction is the whole reason the two
    // markers exist: an undelivered dispute must not SHIP, a delivered one has
    // nothing left to ship and must not be CONSOLIDATED.
    expect(classificarIncidenteBloqueante(inc({ entregue: true }))).toBe('devolucao');
    expect(classificarIncidenteBloqueante(inc({ entregue: false }))).toBe('disputa');
  });

  it('⚠️ a NON-marketplace incidente never blocks — the origem filter is load-bearing', () => {
    // `incidenteSchema.tipo` DEFAULTS to `returns`, so without this filter every
    // hand-written incidente an operator forgot to retype would block
    // `finalizado`, and `trocaIncidentesBestEffort` would block on every pedido
    // save. Mutation check: drop the origem test and this flips to 'devolucao'.
    for (const origem of [
      ORIGEM_INCIDENTE.site,
      ORIGEM_INCIDENTE.troca,
      ORIGEM_INCIDENTE.devolucao,
      ORIGEM_INCIDENTE.outros,
      null,
    ]) {
      expect(
        classificarIncidenteBloqueante(inc({ origem, tipo: TIPO_INCIDENTE.devolucao })),
        `origem ${String(origem)} must not block`,
      ).toBeNull();
    }
  });

  it("⚠️ the ERP's OWN devolução/troca incidentes never block — the exact pair `registrarIncidentesDeRetorno` writes", () => {
    // The concrete regression the origem filter prevents, spelled out with the
    // real constants `packages/data/src/pedido/devolucao.ts` uses (`:441` and
    // `:598`). Every ERP-native devolução and troca stamps a `returns`/`t`
    // incidente on its ORIGIN pedido, and those rows carry NO `claimStatus` and
    // NO `resolucao` — so under the `resolucao == null` fallback they read as
    // permanently open. Without this filter the entire devolução feature would
    // block `finalizado` on every pedido it ever touched, for ever.
    const paresDoErp = [
      { origem: ORIGEM_INCIDENTE.devolucao, tipo: TIPO_INCIDENTE.devolucao },
      { origem: ORIGEM_INCIDENTE.troca, tipo: TIPO_INCIDENTE.troca },
    ];
    for (const par of paresDoErp) {
      expect(
        classificarIncidenteBloqueante(inc({ ...par, claimStatus: null, resolucao: null })),
        `${par.origem}/${par.tipo} must not block`,
      ).toBeNull();
    }
  });

  it('non-blocking tipos stay non-blocking even from the marketplace', () => {
    // A late delivery is a reason to ship FASTER, not to refuse shipping; `o`
    // is the passthrough-subtipo carrier the estoque sync writes drift rows
    // under, and blocking on it would stop dispatch on every pedido whose
    // stock ever needed reconciling.
    for (const tipo of [
      TIPO_INCIDENTE.troca,
      TIPO_INCIDENTE.atendimento,
      TIPO_INCIDENTE.entregaAtrasada,
      TIPO_INCIDENTE.outros,
    ]) {
      expect(classificarIncidenteBloqueante(inc({ tipo })), `tipo ${tipo}`).toBeNull();
    }
  });

  it('a claim ML has CLOSED stops blocking, even with no resolucao recorded', () => {
    expect(classificarIncidenteBloqueante(inc({ claimStatus: STATUS_CLAIM.fechada }))).toBeNull();
  });

  it('falls back to `resolucao == null` when claimStatus is absent (pre-#1322 rows)', () => {
    // A legacy incidente imported before the structured fields existed must not
    // read as permanently open.
    expect(classificarIncidenteBloqueante(inc({ claimStatus: null, resolucao: null }))).toBe(
      'disputa',
    );
    expect(
      classificarIncidenteBloqueante(inc({ claimStatus: null, resolucao: { tipo: 3 } })),
    ).toBeNull();
  });

  it('ML claimStatus OUTRANKS a recorded resolucao', () => {
    // The marketplace is the authority on whether its own claim is open. An
    // operator writing a note must not silently unblock a live mediation...
    expect(
      classificarIncidenteBloqueante(
        inc({ claimStatus: STATUS_CLAIM.aberta, resolucao: { tipo: 3 } }),
      ),
    ).toBe('disputa');
    // ...and equally, a closed claim stops blocking even with no note.
    expect(
      classificarIncidenteBloqueante(inc({ claimStatus: STATUS_CLAIM.fechada, resolucao: null })),
    ).toBeNull();
  });
});

describe('the three guards', () => {
  it('a dispute blocks all three actions', () => {
    const p = { disputaAbertaEm: 1_000, devolucaoAbertaEm: null, bloqueiosLiberados: null };
    expect(bloqueioDespachoAtivo(p)).toBe(true);
    expect(bloqueioNFeAtivo(p)).toBe(true);
    expect(bloqueioFinalizarAtivo(p)).toBe(true);
  });

  it('⚠️ a devolução blocks ONLY `finalizado`', () => {
    // The goods are already with the buyer: there is nothing left to ship, so
    // refusing the checkout would only stop the operator from processing the
    // pedido at all. What an open return contradicts is `finalizado`, which
    // asserts the return window has PASSED.
    const p = { disputaAbertaEm: null, devolucaoAbertaEm: 1_000, bloqueiosLiberados: null };
    expect(bloqueioDespachoAtivo(p)).toBe(false);
    expect(bloqueioNFeAtivo(p)).toBe(false);
    expect(bloqueioFinalizarAtivo(p)).toBe(true);
  });

  it('nothing open blocks nothing', () => {
    const p = { disputaAbertaEm: null, devolucaoAbertaEm: null, bloqueiosLiberados: null };
    expect(bloqueioDespachoAtivo(p)).toBe(false);
    expect(bloqueioNFeAtivo(p)).toBe(false);
    expect(bloqueioFinalizarAtivo(p)).toBe(false);
  });

  it('an override releases ONLY the action it names', () => {
    // Per-action on purpose: clearing the dispatch block must not silently also
    // permit the NF-e, which is the irreversible one.
    const p = {
      disputaAbertaEm: 1_000,
      devolucaoAbertaEm: null,
      bloqueiosLiberados: [ACAO_BLOQUEADA.despacho],
    };
    expect(bloqueioDespachoAtivo(p)).toBe(false);
    expect(bloqueioNFeAtivo(p)).toBe(true);
    expect(bloqueioFinalizarAtivo(p)).toBe(true);
  });

  it('an absent/undefined overlay reads as "nothing blocked"', () => {
    // Every pedido written before this feature, and every non-marketplace one.
    expect(bloqueioDespachoAtivo({})).toBe(false);
    expect(bloqueioNFeAtivo({})).toBe(false);
    expect(bloqueioFinalizarAtivo({})).toBe(false);
  });
});

describe('bloqueioLiberado', () => {
  it('an absent or empty override releases nothing', () => {
    expect(bloqueioLiberado(null, ACAO_BLOQUEADA.despacho)).toBe(false);
    expect(bloqueioLiberado(undefined, ACAO_BLOQUEADA.despacho)).toBe(false);
    expect(
      bloqueioLiberado(
        { acoes: [], data: null, usuarioOuterRef: null, motivo: null },
        ACAO_BLOQUEADA.despacho,
      ),
    ).toBe(false);
  });

  it('releases exactly the listed actions', () => {
    const o = {
      acoes: [ACAO_BLOQUEADA.nfe, ACAO_BLOQUEADA.finalizar],
      data: null,
      usuarioOuterRef: null,
      motivo: null,
    };
    expect(bloqueioLiberado(o, ACAO_BLOQUEADA.nfe)).toBe(true);
    expect(bloqueioLiberado(o, ACAO_BLOQUEADA.finalizar)).toBe(true);
    expect(bloqueioLiberado(o, ACAO_BLOQUEADA.despacho)).toBe(false);
  });
});
