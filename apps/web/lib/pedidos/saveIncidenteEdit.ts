import type { Incidente } from '@delfrance/schemas';

import {
  CAMPOS_AUTORAIS_INCIDENTE,
  buildIncidentePatch,
  detectIncidenteConflict,
  type CampoAutoralIncidente,
  type IncidenteFormState,
  type IncidentePatch,
} from '@/app/(app)/pedidos/_components/tabs/incidenteForm';

/**
 * Writing the Incidentes tab's edits back to an existing
 * `pedidos/{pedidoId}/incidentes/{id}` document.
 *
 * The concurrency design is `incidenteForm.ts`'s, made operational here — the
 * same two tiers `saveListing` runs for a Mercado Livre listing:
 *
 *  - **tier 0** — only `CAMPOS_AUTORAIS_INCIDENTE` ride, and only when the
 *    value actually changed, so the write surface is as small as the edit. The
 *    ML claim state (`claimStatus` / `claimStage` / `entregue`), the
 *    server-owned `overrideBloqueio`, the stamps and every passthrough key are
 *    not in the race at all;
 *  - **tier 3** — the doc is re-read inside a transaction and compared against
 *    the snapshot the form was seeded from. An overlap raises
 *    {@link IncidenteConflictError} carrying the remote doc, so a human decides
 *    (root `CLAUDE.md` rule 7 / `apps/web/CLAUDE.md` rule 3: the browser SDK has
 *    no `lastUpdateTime` precondition, so tier 1 is unreachable here).
 *
 * This replaces the whole-document converter `set` (`saveIncidente` →
 * `buildIncidenteOp`) on the UPDATE path only. That `set` spread a copy of the
 * document captured when the editor opened, so an edit made minutes later wrote
 * back the claim state as it was minutes ago — and `claimImport` documents what
 * a stale `claimStatus` costs: despacho, NF-e and finalizar stay refused on an
 * order the marketplace has already settled. CREATE still goes through
 * `saveIncidente`: it mints the id and stamps `timestamp`, and there is no
 * stored document to regress.
 *
 * Port-shaped for the same reason `saveListing` is: the whole decision tree
 * runs in a unit test with a fake, and the Firestore transaction lives in
 * exactly one place (`incidentePort.ts`).
 */

/** Thrown when the incidente is gone — another operator deleted it mid-edit. */
export class IncidenteMissingError extends Error {
  constructor() {
    super('Este incidente foi excluído por outra pessoa. Recarregue a lista.');
    this.name = 'IncidenteMissingError';
  }
}

/**
 * Thrown when the document changed remotely on a field this save also writes.
 * Carries the remote doc so the UI can show the diff and offer an override that
 * re-baselines on the version the operator just read.
 */
export class IncidenteConflictError extends Error {
  constructor(
    readonly current: Incidente,
    readonly campos: CampoAutoralIncidente[],
    /** The resolução lock armed while the form was open — a different message. */
    readonly bloqueouAgora: boolean,
  ) {
    super('O incidente foi alterado por outra pessoa desde que você o abriu.');
    this.name = 'IncidenteConflictError';
  }
}

export interface IncidenteSavePort {
  /**
   * Re-read the incidente and apply `patchFor` to it atomically. `patchFor`
   * receives the CURRENT doc (null when absent) and returns the patch to write;
   * returning an empty patch writes nothing. Throwing aborts the transaction.
   */
  update(patchFor: (current: Incidente | null) => Record<string, unknown>): Promise<void>;
  /**
   * ⚠️ MICROSECONDS. `incidente.ultimaModificacao` is `microsSinceEpoch`, unlike
   * the Mercado Livre link docs this port is modelled on, whose stamp is ms.
   * Mixing the units gives a comparison that never fires (root `CLAUDE.md`
   * rule 7).
   */
  now(): number;
}

export interface SaveIncidenteEditArgs {
  /** Current form state, already past `validateIncidenteForm`. */
  form: IncidenteFormState;
  /** The incidente the form was seeded from — the concurrency baseline. */
  baseline: Incidente;
}

/**
 * Persist the operator's edits, or refuse and say why.
 *
 * Resolves with the patch that was written (empty when nothing changed).
 */
export async function saveIncidenteEdit(
  port: IncidenteSavePort,
  args: SaveIncidenteEditArgs,
): Promise<IncidentePatch> {
  let escrito: IncidentePatch = {};

  await port.update((current) => {
    if (current === null) throw new IncidenteMissingError();

    // What the operator MEANT to write, judged against the version they were
    // looking at — that is what decides which fields they had permission to
    // edit and which ones they actually touched.
    const pretendido = buildIncidentePatch(args.form, args.baseline, port.now());
    const veredito = detectIncidenteConflict(args.baseline, current, pretendido);
    if (veredito.conflito) {
      throw new IncidenteConflictError(current, veredito.campos, veredito.bloqueouAgora);
    }

    // The write is the INTERSECTION of what was judged and what re-derivation
    // against the tx-fresh document still asks for. Both halves are load-bearing
    // and neither is sufficient alone:
    //
    //  - only `pretendido`'s keys may be written, because those are the ones the
    //    verdict above covered. An authored field the operator left alone is not
    //    in it — and re-derivation WOULD ask to write it, because the form still
    //    holds the baseline value while the document holds someone else's. That
    //    write reverts them, and `detectIncidenteConflict` never looked at the
    //    key, so nothing catches it and the modal never shows it. It is the
    //    whole-document `set` regression in miniature;
    //  - the VALUES come from the re-derivation, because that is what drops a
    //    resolução that locked since the baseline (a lock can arm without
    //    conflicting, when the operator never touched it) and what carries the
    //    live `resolucao.frete`.
    //
    // Nothing captured before the read reaches the write, so an OCC retry
    // recomputes from scratch.
    const contraCurrent = buildIncidentePatch(args.form, current, port.now());
    escrito = {};
    for (const campo of CAMPOS_AUTORAIS_INCIDENTE) {
      if (!Object.prototype.hasOwnProperty.call(pretendido, campo)) continue;
      if (!Object.prototype.hasOwnProperty.call(contraCurrent, campo)) continue;
      Object.assign(escrito, { [campo]: contraCurrent[campo] });
    }
    if (Object.keys(escrito).length === 0) return {};
    // Stamped inside the callback: the retry loop can run this more than once,
    // and a stamp taken before the transaction would age with each attempt.
    return { ...escrito, ultimaModificacao: port.now() };
  });

  return escrito;
}
