/**
 * Writing the Contingência panel's edits back to a `nfeconfig` doc.
 *
 * The panel owns four fields; everything else on the doc is server-written —
 * the counters (`numeracao_atual` / `idLote`) advance inside `apps/nfe`
 * transactions on every emission. So the design mirrors `saveListing.ts`:
 *
 *  - **tier 0 by field disjointness** — only the fields the operator actually
 *    touched ride, rebuilt from the TX-FRESH doc, so an emission advancing a
 *    counter can never collide with a contingency edit;
 *  - **tier 3 for the residual overlap** — two operators editing contingência
 *    raise {@link NfeConfigConflictError} for a human instead of one silently
 *    overwriting the other.
 *
 * ⚠️ The tier-3 half is not decoration here. The panel reads through TanStack
 * Query with `refetchOnWindowFocus: false` and no `onSnapshot`, so a mounted tab
 * holds its snapshot indefinitely — the stale window is "however long the tab
 * has been open", not milliseconds. And what a stale write reverts is
 * `contingencia_modo`: switching contingency OFF mid-outage routes every
 * emission back at the dead SEFAZ (`apps/nfe`'s `emitir` reads this doc) while
 * `ContingenciaBanner` stops warning, because it queries `!= 'none'`.
 *
 * Port-shaped for the same reason `saveListing` is: the whole decision tree runs
 * in a unit test with a fake, and the Firestore transaction lives in exactly one
 * place.
 */
import { valuesEqual } from '@delfrance/core/equality';
import { CONTINGENCIA_MODO, type ContingenciaModo, type NFeConfig } from '@delfrance/schemas';

/**
 * The fields this panel writes. Everything else on the doc belongs to the
 * emission path, and a UI write would clobber live truth.
 *
 * `contingencia_dataInicio` is on the list but is DERIVED, never typed: it is
 * stamped when the mode turns on, carried while it stays on, and cleared on the
 * way back to normal.
 */
export const PANEL_OWNED_KEYS = [
  'contingencia_modo',
  'contingencia_justificativa',
  'contingencia_dataInicio',
  'emitirReformaTributaria',
] as const;

export type PanelOwnedKey = (typeof PANEL_OWNED_KEYS)[number];

/** Thrown when the config doc is gone — deleted while the panel was open. */
export class NfeConfigMissingError extends Error {
  constructor() {
    super('A configuração de NF-e desta filial não existe mais.');
    this.name = 'NfeConfigMissingError';
  }
}

/**
 * Thrown when the config changed remotely on a field this save also writes.
 * Carries the remote doc so the UI can show the diff and offer an override that
 * re-baselines on the version the operator just reviewed.
 */
export class NfeConfigConflictError extends Error {
  constructor(
    readonly current: NFeConfig,
    readonly fields: PanelOwnedKey[],
  ) {
    super('A configuração de NF-e foi alterada por outra pessoa desde que você a abriu.');
    this.name = 'NfeConfigConflictError';
  }
}

export interface NfeConfigSavePort {
  /**
   * Re-read the config doc and apply `nextFor` to it atomically. `nextFor`
   * receives the CURRENT doc (null when absent) and returns the full document to
   * store. Throwing aborts the transaction.
   */
  update(nextFor: (current: NFeConfig | null) => NFeConfig): Promise<void>;
  /** Millisecond clock — `timestamp` / `contingencia_dataInicio` are ms here. */
  now(): number;
}

export interface SaveNfeConfigArgs {
  /** The panel's local edits. `null` means "the operator did not touch this". */
  modo: ContingenciaModo | null;
  justificativa: string | null;
  rtc: boolean | null;
  /** The doc the panel rendered from — the concurrency baseline. */
  baseline: NFeConfig;
}

/** Panel-owned fields whose stored value differs from the baseline. */
function remotelyChanged(baseline: NFeConfig, current: NFeConfig): PanelOwnedKey[] {
  return PANEL_OWNED_KEYS.filter((key) => !valuesEqual(baseline[key], current[key]));
}

/**
 * Persist the contingency edits, or refuse and say why.
 *
 * ⚠️ There is deliberately **no `force` escape**. To re-apply after reviewing a
 * conflict, the caller passes the version it just showed the operator as
 * `baseline` — and the comparison below still runs against it. That is what
 * makes "Salvar mesmo assim" a re-baseline rather than a blind write:
 *
 *  - nothing moved since the modal opened ⇒ `baseline === current` ⇒ no
 *    overlap ⇒ the save proceeds;
 *  - a THIRD writer landed while the operator was reading the diff ⇒ overlap
 *    ⇒ the conflict raises again, now showing that newer version.
 *
 * It converges (each click re-baselines and retries) and it can never silently
 * overwrite a version nobody saw. An earlier revision took a `force` flag that
 * skipped the check outright, which reintroduced exactly the
 * switch-contingency-off-mid-outage damage this module exists to prevent — one
 * step later in the flow, and against a write the operator had been told was
 * safe. Critical rule 7 tier 3: an interactive edit that loses raises a
 * conflict, never a silent drop.
 */
export async function saveNfeConfig(
  port: NfeConfigSavePort,
  args: SaveNfeConfigArgs,
): Promise<void> {
  const { modo, justificativa, rtc, baseline } = args;

  // Which panel fields this save actually writes — the disjointness argument.
  // An untouched field is not written at all, so it cannot lose a race it never
  // entered, and it cannot raise a conflict either.
  const writes = new Set<PanelOwnedKey>();
  if (modo !== null) {
    writes.add('contingencia_modo');
    // Both follow the mode: the justification is cleared by `none` and required
    // otherwise, and dhCont is stamped/cleared with it.
    writes.add('contingencia_justificativa');
    writes.add('contingencia_dataInicio');
  }
  if (justificativa !== null) writes.add('contingencia_justificativa');
  if (rtc !== null) writes.add('emitirReformaTributaria');

  await port.update((current) => {
    if (current === null) throw new NfeConfigMissingError();

    // Always. See the docblock: the re-baseline IS the override, so this must
    // keep running or a third write is swallowed.
    const overlap = remotelyChanged(baseline, current).filter((key) => writes.has(key));
    if (overlap.length > 0) throw new NfeConfigConflictError(current, overlap);

    // ⚠️ Every value below is re-derived from `current` — the TX-FRESH doc —
    // never from the `cfg` the panel rendered with. That render-time snapshot
    // is what the conflict check above is ABOUT; using it to build the write
    // too would mean an untouched field silently reverts to whatever the tab
    // last saw (ADR 0011's first named trap).
    const nextModo = modo ?? current.contingencia_modo;
    const nextRtc = rtc ?? current.emitirReformaTributaria ?? false;
    const nextJust =
      nextModo === CONTINGENCIA_MODO.none
        ? null
        : (justificativa ?? current.contingencia_justificativa ?? '');

    return {
      ...current,
      contingencia_modo: nextModo,
      contingencia_justificativa: nextJust,
      // Stamp dhCont when the mode turns ON; keep it while it stays on; clear it
      // on the way back to normal.
      contingencia_dataInicio:
        nextModo === CONTINGENCIA_MODO.none
          ? null
          : (current.contingencia_dataInicio ?? port.now()),
      emitirReformaTributaria: nextRtc,
      timestamp: port.now(),
    };
  });
}
