'use client';

/**
 * The save decision for the filial's Simples Nacional panel — pure, so the part
 * that can be wrong is the part vitest can reach. The Firestore half is
 * `simplesConfigPort.ts`.
 *
 * Modelled on `saveNfeConfig`, including its central idea: **there is no force
 * flag.** Re-applying after a conflict passes the version the operator just
 * reviewed as the new `baseline`, and the comparison still runs — so a third
 * writer landing meanwhile raises the modal again instead of being overwritten.
 */
import {
  ANEXO_SIMPLES,
  type AnexoSimplesWire,
  type SimplesNacionalConfig,
} from '@delfrance/schemas';

/**
 * The fields this panel writes. Everything else on the document belongs to the
 * monthly runner, and a UI write would clobber a figure the operator cannot see
 * — `rbt12`, `aliquotaEfetiva`, `faixa`, the counters.
 */
export const PAINEL_SIMPLES_KEYS = ['anexo', 'aliquotaDeclarada', 'recalculoAutomatico'] as const;

export type PainelSimplesKey = (typeof PAINEL_SIMPLES_KEYS)[number];

/**
 * Thrown when the config changed remotely on a field this save also writes.
 * Carries the remote doc so the UI can show the diff and offer an override that
 * re-baselines on the version just reviewed.
 */
export class SimplesConfigConflictError extends Error {
  constructor(
    readonly current: SimplesNacionalConfig,
    readonly fields: PainelSimplesKey[],
  ) {
    super(
      'A configuração do Simples Nacional foi alterada por outra pessoa desde que você a abriu.',
    );
    this.name = 'SimplesConfigConflictError';
  }
}

/**
 * Thrown when the panel believed it was CREATING the document and someone else
 * created it first. A create is not a merge: proceeding would silently discard
 * whatever they configured.
 */
export class SimplesConfigJaExisteError extends Error {
  constructor(readonly current: SimplesNacionalConfig) {
    super(
      'Outra pessoa configurou o Simples Nacional desta filial enquanto esta tela estava aberta.',
    );
    this.name = 'SimplesConfigJaExisteError';
  }
}

export interface SimplesConfigSavePort {
  /**
   * Re-read the config doc and apply `nextFor` atomically. `nextFor` receives
   * the CURRENT doc (null when absent) and returns the full document to store;
   * throwing aborts the transaction.
   */
  update(nextFor: (current: SimplesNacionalConfig | null) => SimplesNacionalConfig): Promise<void>;
  /** Millisecond clock — `ultimaModificacao` is ms on this document. */
  now(): number;
}

export interface SaveSimplesConfigArgs {
  /** Local edits. `null` means "the operator did not touch this". */
  anexo: AnexoSimplesWire | null;
  /**
   * ⚠️ **Three-valued, unlike its neighbours**: `undefined` is "not touched",
   * and `null` is "the operator CLEARED it".
   *
   * The other two cannot be cleared — `anexo` renders with
   * `allowDeselect={false}` and the switch is a boolean — so `null` is free to
   * mean untouched there. Here it is not: `DecimalInput` emits `null` for an
   * empty field, so folding the two together made "the accountant withdrew the
   * figure" unrepresentable. The document models it (`.nullable()`), and once a
   * rate had been typed the only way off it was another rate (#1546 review).
   */
  aliquotaDeclarada: number | null | undefined;
  recalculoAutomatico: boolean | null;
  /**
   * The doc the panel rendered from — the concurrency baseline. `null` means
   * the panel rendered the "not configured yet" state and is CREATING.
   */
  baseline: SimplesNacionalConfig | null;
}

/** Panel-owned fields whose stored value differs from the baseline. */
function mudouRemotamente(
  baseline: SimplesNacionalConfig,
  current: SimplesNacionalConfig,
): PainelSimplesKey[] {
  return PAINEL_SIMPLES_KEYS.filter((k) => baseline[k] !== current[k]);
}

/**
 * The document a first-time configuration creates.
 *
 * ⚠️ Every runner-owned field starts `null` / `[]`, never a guess. An invented
 * `aliquotaEfetiva` would be published to emission as though it had been
 * apurada, and a wrong rate that LOOKS apurada is worse than an absent one.
 */
function documentoInicial(args: SaveSimplesConfigArgs, agora: number): SimplesNacionalConfig {
  return {
    anexo: args.anexo ?? ANEXO_SIMPLES.comercio,
    aliquotaDeclarada: args.aliquotaDeclarada ?? null,
    recalculoAutomatico: args.recalculoAutomatico ?? false,
    rbt12: null,
    aliquotaEfetiva: null,
    faixa: null,
    competencia: null,
    estadoApuracao: null,
    calculadoEm: null,
    notasIlegiveis: null,
    notasNeutras: null,
    filiaisConsolidadas: [],
    ultimaModificacao: agora,
  };
}

/**
 * Persist the panel's edits, or refuse and say why.
 *
 * ⚠️ The patch touches ONLY panel-owned keys. The runner's fields are carried
 * through from the transaction-fresh document, never from the baseline the
 * panel rendered — an apuração that landed while the form sat open must survive
 * the save, not be rolled back to what the screen happened to show.
 */
export async function saveSimplesConfig(
  port: SimplesConfigSavePort,
  args: SaveSimplesConfigArgs,
): Promise<void> {
  const { anexo, aliquotaDeclarada, recalculoAutomatico, baseline } = args;

  // Which panel fields this save actually writes. An untouched field is not
  // written, so it cannot lose a race it never entered — nor raise a conflict.
  const escreve = new Set<PainelSimplesKey>();
  if (anexo !== null) escreve.add('anexo');
  // ⚠️ `!== undefined`, not `!== null`: a CLEARED field is an edit to write.
  if (aliquotaDeclarada !== undefined) escreve.add('aliquotaDeclarada');
  if (recalculoAutomatico !== null) escreve.add('recalculoAutomatico');

  await port.update((current) => {
    const agora = port.now();

    if (baseline === null) {
      // The panel rendered "not configured". Someone creating it first is not a
      // merge conflict — it is a different document than the one being made.
      if (current !== null) throw new SimplesConfigJaExisteError(current);
      return documentoInicial(args, agora);
    }

    if (current === null) {
      // Deleted under us. Re-creating from a stale baseline would resurrect a
      // document nobody asked for, so treat it as the create path instead.
      return documentoInicial(args, agora);
    }

    const colidiram = mudouRemotamente(baseline, current).filter((k) => escreve.has(k));
    if (colidiram.length > 0) throw new SimplesConfigConflictError(current, colidiram);

    return {
      // ⚠️ Spread the TX-FRESH document, not the baseline: the runner may have
      // published an apuração while this form was open, and those fields must
      // survive untouched.
      ...current,
      ...(anexo !== null ? { anexo } : {}),
      ...(aliquotaDeclarada !== undefined ? { aliquotaDeclarada } : {}),
      ...(recalculoAutomatico !== null ? { recalculoAutomatico } : {}),
      ultimaModificacao: agora,
    };
  });
}
