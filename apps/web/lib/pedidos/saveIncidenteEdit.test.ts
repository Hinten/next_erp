import { describe, expect, it } from 'vitest';
import {
  ESTADO_FRETE,
  ORIGEM_INCIDENTE,
  STATUS_CLAIM,
  TIPO_INCIDENTE,
  TIPO_RESOLUCAO,
  type EstadoFrete,
  type Incidente,
} from '@delfrance/schemas';

import {
  formFromIncidente,
  type IncidenteFormState,
} from '@/app/(app)/pedidos/_components/tabs/incidenteForm';
import {
  IncidenteConflictError,
  IncidenteMissingError,
  saveIncidenteEdit,
  type IncidenteSavePort,
} from './saveIncidenteEdit';

const NOW = 1_800_000_000_000_000; // µs epoch

function incidente(overrides: Partial<Incidente> = {}): Incidente {
  return {
    origem: ORIGEM_INCIDENTE.pedidoMercadoLivre,
    tipo: TIPO_INCIDENTE.devolucao,
    motivoDoIncidente: 'Motivo original',
    comentarios: 'Comentário original',
    timestamp: 1,
    ultimaModificacao: 1,
    externalId: '9001',
    resolucao: null,
    claimStatus: STATUS_CLAIM.aberta,
    claimStage: null,
    entregue: null,
    ...overrides,
  } as Incidente;
}

function comFrete(estado: EstadoFrete): NonNullable<Incidente['resolucao']> {
  return {
    data: 10,
    valor: 0,
    tipo: TIPO_RESOLUCAO.etiquetaDeDevolucao,
    comentarios: null,
    frete: { estado },
  } as NonNullable<Incidente['resolucao']>;
}

/** The form right after `openEdit` on `doc` — untouched. */
const pristine = (doc: Incidente): IncidenteFormState => formFromIncidente(doc);

/** In-memory port: records what a save would write, without Firestore. */
function fakePort(current: Incidente | null) {
  const writes: Array<Record<string, unknown>> = [];
  const port: IncidenteSavePort = {
    now: () => NOW,
    async update(patchFor) {
      const patch = patchFor(current);
      if (Object.keys(patch).length > 0) writes.push(patch);
    },
  };
  return { port, writes };
}

describe('saveIncidenteEdit', () => {
  it('writes only the authored keys that actually changed, plus the stamp', async () => {
    const baseline = incidente();
    const { port, writes } = fakePort(baseline);

    await saveIncidenteEdit(port, {
      form: { ...pristine(baseline), motivo: 'Motivo novo' },
      baseline,
    });

    expect(writes).toEqual([{ motivoDoIncidente: 'Motivo novo', ultimaModificacao: NOW }]);
  });

  it('writes nothing when the form ends where it started', async () => {
    const baseline = incidente();
    const { port, writes } = fakePort(baseline);

    await saveIncidenteEdit(port, { form: pristine(baseline), baseline });

    expect(writes).toHaveLength(0);
  });

  /**
   * ⭐ The pair that matters. The first half shows the guard FIRES; the second
   * shows where it STOPS. `claimStatus` / `claimStage` / `entregue` are Mercado
   * Livre's own facts, merged onto this doc by `claimImport` on its own
   * schedule — conflicting on them would make the tab unusable on any incidente
   * ML is working, and (before #1250) writing them back is what could leave
   * despacho / NF-e / finalizar refused on a settled order.
   */
  it('conflicts on a remote change to an authored field this save writes', async () => {
    const baseline = incidente();
    const current = incidente({ motivoDoIncidente: 'Outra pessoa escreveu isto' });
    const { port, writes } = fakePort(current);

    const err = await saveIncidenteEdit(port, {
      form: { ...pristine(baseline), motivo: 'Motivo novo' },
      baseline,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(IncidenteConflictError);
    expect((err as IncidenteConflictError).campos).toEqual(['motivoDoIncidente']);
    expect((err as IncidenteConflictError).current).toBe(current);
    expect(writes).toHaveLength(0);
  });

  it('does NOT conflict on a remote change to a field nobody here authors', async () => {
    const baseline = incidente();
    const current = incidente({
      claimStatus: STATUS_CLAIM.fechada,
      claimStage: 'dispute',
      entregue: true,
      externalId: '9002',
      ultimaModificacao: 999,
    });
    const { port, writes } = fakePort(current);

    await saveIncidenteEdit(port, {
      form: { ...pristine(baseline), motivo: 'Motivo novo' },
      baseline,
    });

    // Written: the edit and the stamp. NOT written: the ML claim state, which
    // stays exactly as the webhook left it.
    expect(writes).toEqual([{ motivoDoIncidente: 'Motivo novo', ultimaModificacao: NOW }]);
  });

  /**
   * ⚠️ The other half of the scope pair, and the one the first pass got wrong.
   *
   * The verdict is judged over the patch built against the BASELINE, but the
   * write was rebuilt against `current` — so an authored key the operator never
   * touched, which someone else changed, was absent from the judged patch (no
   * conflict) yet present in the written one (form value != remote value), and
   * went back over the other writer silently. Narrower than the whole-document
   * `set` this PR removes, identical in kind.
   */
  it('never writes an authored field the operator left alone, however it moved remotely', async () => {
    const baseline = incidente();
    const current = incidente({ comentarios: 'Outra pessoa escreveu isto' });
    const { port, writes } = fakePort(current);

    await saveIncidenteEdit(port, {
      form: { ...pristine(baseline), motivo: 'Motivo novo' },
      baseline,
    });

    expect(writes).toEqual([{ motivoDoIncidente: 'Motivo novo', ultimaModificacao: NOW }]);
  });

  it('conflicts with bloqueouAgora when the lock arms over pending resolução edits', async () => {
    const baseline = incidente({ resolucao: comFrete(ESTADO_FRETE.iniciado) });
    const current = incidente({ resolucao: comFrete(ESTADO_FRETE.postado) });
    const { port, writes } = fakePort(current);

    const err = await saveIncidenteEdit(port, {
      form: { ...pristine(baseline), resValor: 99 },
      baseline,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(IncidenteConflictError);
    expect((err as IncidenteConflictError).bloqueouAgora).toBe(true);
    expect(writes).toHaveLength(0);
  });

  it('drops resolucao — without conflicting — when the lock arms and it was untouched', async () => {
    const baseline = incidente({ resolucao: comFrete(ESTADO_FRETE.iniciado) });
    const current = incidente({ resolucao: comFrete(ESTADO_FRETE.postado) });
    const { port, writes } = fakePort(current);

    await saveIncidenteEdit(port, {
      form: { ...pristine(baseline), motivo: 'Motivo novo' },
      baseline,
    });

    expect(writes).toEqual([{ motivoDoIncidente: 'Motivo novo', ultimaModificacao: NOW }]);
  });

  it('refuses to re-create a document deleted under the open form', async () => {
    const baseline = incidente();
    const { port, writes } = fakePort(null);

    await expect(
      saveIncidenteEdit(port, { form: { ...pristine(baseline), motivo: 'x' }, baseline }),
    ).rejects.toBeInstanceOf(IncidenteMissingError);
    expect(writes).toHaveLength(0);
  });

  it('clears a text field to null rather than to an empty string', async () => {
    const baseline = incidente();
    const { port, writes } = fakePort(baseline);

    await saveIncidenteEdit(port, {
      form: { ...pristine(baseline), comentarios: '   ' },
      baseline,
    });

    expect(writes).toEqual([{ comentarios: null, ultimaModificacao: NOW }]);
  });

  it('stamps ultimaModificacao from inside the callback, so an OCC retry re-stamps', async () => {
    const baseline = incidente();
    let calls = 0;
    const writes: Array<Record<string, unknown>> = [];
    const port: IncidenteSavePort = {
      now: () => NOW + ++calls,
      async update(patchFor) {
        patchFor(baseline); // a first attempt, discarded as a retry would be
        writes.push(patchFor(baseline));
      },
    };

    await saveIncidenteEdit(port, {
      form: { ...pristine(baseline), motivo: 'Motivo novo' },
      baseline,
    });

    // A stamp taken before the transaction would still read NOW+1 here.
    expect(writes[0]?.ultimaModificacao).toBeGreaterThan(NOW + 1);
  });
});
