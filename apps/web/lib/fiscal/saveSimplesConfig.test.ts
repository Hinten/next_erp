import { describe, expect, it, vi } from 'vitest';

import { ANEXO_SIMPLES, type SimplesNacionalConfig } from '@delfrance/schemas';

import {
  SimplesConfigConflictError,
  SimplesConfigJaExisteError,
  saveSimplesConfig,
  type SimplesConfigSavePort,
} from './saveSimplesConfig';

const AGORA = 1_757_000_000_000;

function cfg(over: Partial<SimplesNacionalConfig> = {}): SimplesNacionalConfig {
  return {
    anexo: ANEXO_SIMPLES.comercio,
    aliquotaDeclarada: null,
    recalculoAutomatico: false,
    rbt12: 500_000,
    aliquotaEfetiva: 0.06728,
    faixa: 3,
    competencia: '2026-08',
    estadoApuracao: 'vigente',
    calculadoEm: AGORA - 1000,
    notasIlegiveis: 0,
    notasNeutras: 0,
    filiaisConsolidadas: ['f1'],
    ultimaModificacao: AGORA - 1000,
    ...over,
  };
}

/** A port whose stored doc is whatever `armazenado` holds when `update` runs. */
function porta(armazenado: SimplesNacionalConfig | null) {
  const escrito: SimplesNacionalConfig[] = [];
  const port: SimplesConfigSavePort = {
    now: () => AGORA,
    async update(nextFor) {
      escrito.push(nextFor(armazenado));
    },
  };
  return { port, escrito };
}

describe('saveSimplesConfig', () => {
  it('writes only the fields the operator touched', async () => {
    const atual = cfg();
    const { port, escrito } = porta(atual);
    await saveSimplesConfig(port, {
      anexo: ANEXO_SIMPLES.industria,
      aliquotaDeclarada: undefined,
      recalculoAutomatico: null,
      baseline: atual,
    });
    expect(escrito[0]?.anexo).toBe(ANEXO_SIMPLES.industria);
    // Untouched — carried through, not rewritten from the form.
    expect(escrito[0]?.aliquotaDeclarada).toBeNull();
    expect(escrito[0]?.recalculoAutomatico).toBe(false);
  });

  // ── The runner's fields must survive the save ───────────────────────────
  it('⚠️ carries the runner-owned fields from the TX-FRESH doc, not the baseline', async () => {
    // The apuração published a new rate while the form sat open. Saving an
    // unrelated field must not roll that back — this is the whole reason the
    // patch spreads `current` rather than `baseline`.
    const aberto = cfg({ aliquotaEfetiva: 0.06728, competencia: '2026-08', rbt12: 500_000 });
    const desdeEntao = cfg({ aliquotaEfetiva: 0.0845, competencia: '2026-09', rbt12: 900_000 });
    const { port, escrito } = porta(desdeEntao);

    await saveSimplesConfig(port, {
      anexo: ANEXO_SIMPLES.industria,
      aliquotaDeclarada: undefined,
      recalculoAutomatico: null,
      baseline: aberto,
    });

    expect(escrito[0]?.anexo).toBe(ANEXO_SIMPLES.industria);
    expect(escrito[0]?.aliquotaEfetiva).toBe(0.0845);
    expect(escrito[0]?.competencia).toBe('2026-09');
    expect(escrito[0]?.rbt12).toBe(900_000);
  });

  it('stamps ultimaModificacao from the port clock', async () => {
    const atual = cfg();
    const { port, escrito } = porta(atual);
    await saveSimplesConfig(port, {
      anexo: null,
      aliquotaDeclarada: undefined,
      recalculoAutomatico: true,
      baseline: atual,
    });
    expect(escrito[0]?.ultimaModificacao).toBe(AGORA);
  });

  // ── Conflicts ───────────────────────────────────────────────────────────
  describe('conflict detection', () => {
    it('raises when a field this save writes moved remotely', async () => {
      const aberto = cfg({ recalculoAutomatico: false });
      const { port } = porta(cfg({ recalculoAutomatico: true }));
      await expect(
        saveSimplesConfig(port, {
          anexo: null,
          aliquotaDeclarada: undefined,
          recalculoAutomatico: false,
          baseline: aberto,
        }),
      ).rejects.toBeInstanceOf(SimplesConfigConflictError);
    });

    it('does NOT raise when the field that moved is one this save leaves alone', async () => {
      // Disjointness: an untouched field cannot lose a race it never entered.
      const aberto = cfg({ anexo: ANEXO_SIMPLES.comercio, recalculoAutomatico: false });
      const { port, escrito } = porta(
        cfg({ anexo: ANEXO_SIMPLES.industria, recalculoAutomatico: false }),
      );
      await saveSimplesConfig(port, {
        anexo: null,
        aliquotaDeclarada: undefined,
        recalculoAutomatico: true,
        baseline: aberto,
      });
      expect(escrito[0]?.recalculoAutomatico).toBe(true);
      // and the other person's anexo survives
      expect(escrito[0]?.anexo).toBe(ANEXO_SIMPLES.industria);
    });

    it('names exactly the colliding fields', async () => {
      const aberto = cfg({ anexo: ANEXO_SIMPLES.comercio, recalculoAutomatico: false });
      const { port } = porta(cfg({ anexo: ANEXO_SIMPLES.industria, recalculoAutomatico: true }));
      await saveSimplesConfig(port, {
        anexo: ANEXO_SIMPLES.industria,
        aliquotaDeclarada: 0.05,
        recalculoAutomatico: true,
        baseline: aberto,
      }).catch((e: unknown) => {
        expect(e).toBeInstanceOf(SimplesConfigConflictError);
        expect((e as SimplesConfigConflictError).fields.sort()).toEqual([
          'anexo',
          'recalculoAutomatico',
        ]);
      });
      expect.assertions(2);
    });

    it('re-applying with the reviewed version as baseline SUCCEEDS — the override is a re-baseline', async () => {
      // There is deliberately no force flag: passing the version the operator
      // just saw makes the comparison pass, and a THIRD writer would raise
      // again instead of being silently overwritten.
      const revisado = cfg({ recalculoAutomatico: true });
      const { port, escrito } = porta(revisado);
      await saveSimplesConfig(port, {
        anexo: null,
        aliquotaDeclarada: undefined,
        recalculoAutomatico: false,
        baseline: revisado,
      });
      expect(escrito[0]?.recalculoAutomatico).toBe(false);
    });
  });

  // ── Creating the document ───────────────────────────────────────────────
  describe('first-time configuration', () => {
    it('creates the document when there was none', async () => {
      const { port, escrito } = porta(null);
      await saveSimplesConfig(port, {
        anexo: ANEXO_SIMPLES.industria,
        aliquotaDeclarada: 0.045,
        recalculoAutomatico: true,
        baseline: null,
      });
      expect(escrito[0]).toMatchObject({
        anexo: ANEXO_SIMPLES.industria,
        aliquotaDeclarada: 0.045,
        recalculoAutomatico: true,
      });
    });

    it('⚠️ never invents a computed value — every runner field starts empty', async () => {
      // An invented `aliquotaEfetiva` would be published to emission as though
      // it had been apurada. A wrong rate that LOOKS apurada is worse than an
      // absent one.
      const { port, escrito } = porta(null);
      await saveSimplesConfig(port, {
        anexo: ANEXO_SIMPLES.comercio,
        aliquotaDeclarada: 0.06,
        recalculoAutomatico: true,
        baseline: null,
      });
      expect(escrito[0]).toMatchObject({
        rbt12: null,
        aliquotaEfetiva: null,
        faixa: null,
        competencia: null,
        estadoApuracao: null,
        notasIlegiveis: null,
        filiaisConsolidadas: [],
      });
    });

    it('refuses when someone else created it first — a create is not a merge', async () => {
      const { port } = porta(cfg({ anexo: ANEXO_SIMPLES.industria }));
      await expect(
        saveSimplesConfig(port, {
          anexo: ANEXO_SIMPLES.comercio,
          aliquotaDeclarada: undefined,
          recalculoAutomatico: null,
          baseline: null,
        }),
      ).rejects.toBeInstanceOf(SimplesConfigJaExisteError);
    });

    it('a document deleted under an open form is re-created, not resurrected from stale values', async () => {
      const aberto = cfg({ rbt12: 500_000, aliquotaEfetiva: 0.06728 });
      const { port, escrito } = porta(null);
      await saveSimplesConfig(port, {
        anexo: ANEXO_SIMPLES.industria,
        aliquotaDeclarada: undefined,
        recalculoAutomatico: null,
        baseline: aberto,
      });
      expect(escrito[0]?.anexo).toBe(ANEXO_SIMPLES.industria);
      // The stale apuração does NOT come back.
      expect(escrito[0]?.rbt12).toBeNull();
      expect(escrito[0]?.aliquotaEfetiva).toBeNull();
    });
  });

  it('runs everything inside the port transaction — one update call', async () => {
    const atual = cfg();
    const update = vi.fn(async () => {});
    await saveSimplesConfig(
      { now: () => AGORA, update },
      {
        anexo: ANEXO_SIMPLES.industria,
        aliquotaDeclarada: undefined,
        recalculoAutomatico: null,
        baseline: atual,
      },
    );
    expect(update).toHaveBeenCalledTimes(1);
  });

  // ── Clearing a rate the accountant withdrew ──────────────────────────────
  describe('⚠️ aliquotaDeclarada is THREE-valued — undefined untouched, null cleared', () => {
    it('CLEARS a stored rate when the operator empties the field', async () => {
      // The #1546 review finding. `DecimalInput` emits `null` for an empty
      // field, and `null` used to also mean "untouched", so a typed rate could
      // never be withdrawn — the only way off one rate was another rate. The
      // document has always modelled the absence (`.nullable()`).
      const atual = cfg({ aliquotaDeclarada: 0.06728 });
      const { port, escrito } = porta(atual);
      await saveSimplesConfig(port, {
        anexo: null,
        aliquotaDeclarada: null,
        recalculoAutomatico: null,
        baseline: atual,
      });
      expect(escrito[0]?.aliquotaDeclarada).toBeNull();
    });

    it('⚠️ NEAR-MISS: an UNTOUCHED field leaves the stored rate exactly where it was', async () => {
      // The other direction, and the reason the two states cannot be folded:
      // if untouched also wrote, every save of the anexo alone would blank a
      // rate nobody edited.
      const atual = cfg({ aliquotaDeclarada: 0.06728 });
      const { port, escrito } = porta(atual);
      await saveSimplesConfig(port, {
        anexo: ANEXO_SIMPLES.industria,
        aliquotaDeclarada: undefined,
        recalculoAutomatico: null,
        baseline: atual,
      });
      expect(escrito[0]?.aliquotaDeclarada).toBe(0.06728);
    });

    it('a CLEAR conflicts like any other write when the stored rate moved', async () => {
      // Clearing is an edit, so it must enter the concurrency check — an
      // untouched field deliberately does not.
      const aberto = cfg({ aliquotaDeclarada: 0.06728 });
      const { port } = porta(cfg({ aliquotaDeclarada: 0.071 }));
      await expect(
        saveSimplesConfig(port, {
          anexo: null,
          aliquotaDeclarada: null,
          recalculoAutomatico: null,
          baseline: aberto,
        }),
      ).rejects.toBeInstanceOf(SimplesConfigConflictError);
    });

    it('an UNTOUCHED field raises no conflict even when the stored rate moved', async () => {
      const aberto = cfg({ aliquotaDeclarada: 0.06728 });
      const { port, escrito } = porta(cfg({ aliquotaDeclarada: 0.071 }));
      await saveSimplesConfig(port, {
        anexo: null,
        aliquotaDeclarada: undefined,
        recalculoAutomatico: true,
        baseline: aberto,
      });
      expect(escrito[0]?.aliquotaDeclarada).toBe(0.071);
    });

    it('a first-time create with a cleared field stores null, not undefined', async () => {
      // Firestore rejects `undefined`; the create path must land a real null.
      const { port, escrito } = porta(null);
      await saveSimplesConfig(port, {
        anexo: ANEXO_SIMPLES.comercio,
        aliquotaDeclarada: undefined,
        recalculoAutomatico: null,
        baseline: null,
      });
      expect(escrito[0]?.aliquotaDeclarada).toBeNull();
      expect(Object.hasOwn(escrito[0]!, 'aliquotaDeclarada')).toBe(true);
    });
  });
});
