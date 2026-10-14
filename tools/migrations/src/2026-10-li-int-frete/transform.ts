import { intFreteContaSync, type IntFreteEncontrado } from '@delfrance/data/admin/frete';
import {
  TIPOS_ALVO_MAPA_FRETE_LI,
  VINCULO_INT_FRETE_CONTA,
  idDoAlvoDoMapaLi,
} from '@delfrance/schemas';

import { adocaoIntFrete } from '../intFreteAdocao/plano';

/**
 * The Loja Integrada binding of the shared `int_frete` window adoption pass (master-plan step 20,
 * #1826). Runbook: `tools/migrations/li-int-frete.README.md`; the entry point is `backfill.ts`.
 *
 * The plan — the labels, the STOP verdict, the JSONL rows — is the ONE copy every channel binds,
 * `../intFreteAdocao/plano.ts`, and it decides nothing of its own: every create / patch /
 * deactivate verdict comes from the shared core's planner and chooser through
 * {@link syncLojaIntegrada}, the SAME zero-option binding the `onIntegracaoLojaIntegradaChanged`
 * trigger runs (#1369). No tolerant scan: a migrated doc whose back-ref is not canonical is
 * REPORTED (and STOPs the pass), never matched.
 *
 * What this file adds is the read-only `mapa` audit ({@link auditarMapa}): counts the dry run
 * prints so the window operator sees how many stored mapping rows the conta screen's editor will
 * need to fix. Counts only — never a STOP verdict, never a write.
 */

/** The Loja Integrada binding — zero options, exactly the trigger's (no tolerant scan). */
export const syncLojaIntegrada = intFreteContaSync(VINCULO_INT_FRETE_CONTA.lojaIntegrada);

/** The shared pass, bound to {@link syncLojaIntegrada}. */
export const adocaoLojaIntegrada = adocaoIntFrete(syncLojaIntegrada, {
  runbook: 'li-int-frete.README.md',
});

/* ------------------------------ the mapa audit ----------------------------- */

/**
 * The read-only `mapa` audit of the scanned Loja Integrada docs. Each count is its own predicate,
 * so one row can be counted under several of them.
 */
export interface AuditoriaDoMapa {
  /**
   * Docs whose `mapa` is present and neither `null` nor an array. The order importer's
   * auto-registration refuses to write on such a doc (`mapa-invalido`), so its new shipping
   * methods never get a row until a person fixes it.
   */
  docsComMapaInvalido: number;
  /** The rows: plain-object elements of every array `mapa`. */
  linhas: number;
  /** Rows whose `integracaoUid` names a doc — decided by the uid, never by the target tipo. */
  mapeadas: number;
  /** Mapped rows whose `targetTipoIntegracao` is not one of `TIPOS_ALVO_MAPA_FRETE_LI`. */
  tipoForaDosAlvos: number;
  /** Mapped rows whose target id is the id of NO scanned doc of the five target tipos. */
  alvoAusente: number;
  /** Mapped rows whose `integracaoUid` is not the bare id it names (a path, or stray slashes). */
  uidComCaminho: number;
}

export const CAMPOS_DA_AUDITORIA = [
  'docsComMapaInvalido',
  'linhas',
  'mapeadas',
  'tipoForaDosAlvos',
  'alvoAusente',
  'uidComCaminho',
] as const satisfies ReadonlyArray<keyof AuditoriaDoMapa>;

function comoObjeto(valor: unknown): Readonly<Record<string, unknown>> | null {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Readonly<Record<string, unknown>>)
    : null;
}

/**
 * Pure. `docs` are the scanned `int_frete` docs of tipo `lojaIntegrada` (all of them — inactive,
 * duplicated and orphaned ones too: this is an audit of the stored corpus, not of the plan);
 * `idsDosAlvos` are the ids of the scanned docs of the five target tipos. Tolerant of any stored
 * shape: nothing is parsed, and nothing throws.
 *
 * The target id comes from `idDoAlvoDoMapaLi`, the conta screen's own reading: `'abc'`,
 * `'int_frete/abc'` and `'documents/int_frete/abc'` all name `abc` (the two path forms also count
 * under `uidComCaminho`), while `'abcd'` is another target; `''`, `null` and a non-string are
 * unmapped, whatever `targetTipoIntegracao` says.
 */
export function auditarMapa(entrada: {
  docs: ReadonlyArray<IntFreteEncontrado>;
  idsDosAlvos: Iterable<string>;
}): AuditoriaDoMapa {
  const alvos = new Set(entrada.idsDosAlvos);
  const tiposAlvo = new Set<unknown>(TIPOS_ALVO_MAPA_FRETE_LI);
  const auditoria: AuditoriaDoMapa = {
    docsComMapaInvalido: 0,
    linhas: 0,
    mapeadas: 0,
    tipoForaDosAlvos: 0,
    alvoAusente: 0,
    uidComCaminho: 0,
  };
  for (const doc of entrada.docs) {
    const { mapa } = doc.data;
    if (mapa == null) continue;
    if (!Array.isArray(mapa)) {
      auditoria.docsComMapaInvalido += 1;
      continue;
    }
    for (const elemento of mapa as readonly unknown[]) {
      const linha = comoObjeto(elemento);
      if (linha === null) continue;
      auditoria.linhas += 1;
      const alvo = idDoAlvoDoMapaLi(linha.integracaoUid);
      if (alvo === null) continue;
      auditoria.mapeadas += 1;
      if (!tiposAlvo.has(linha.targetTipoIntegracao)) auditoria.tipoForaDosAlvos += 1;
      if (!alvos.has(alvo)) auditoria.alvoAusente += 1;
      if (linha.integracaoUid !== alvo) auditoria.uidComCaminho += 1;
    }
  }
  return auditoria;
}
