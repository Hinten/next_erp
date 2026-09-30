/**
 * `ide/gCompraGov` (NT 2025.002 Grupo BB, #331) — a sale to a government entity.
 *
 * ⚠️ LIBRARY-ONLY. No pedido field carries this yet and apps/nfe never passes
 * it: the government-purchase math (`pRedutor` applied to every item's IBS/CBS
 * rates, art. 472/370 LC 214/2025) and the pedido data model are the follow-up
 * issue "full gCompraGov". What lives here is the group's own shape and the
 * cardinality SEFAZ checks without a database (BB05-10…50, BB05-140).
 */
import { CHAVE_NFE_REGEX } from '@delfrance/schemas';

import { fmtRate } from '../tribute/format';
import type { TCompraGov } from '../types/nfe-schema';
import { NFeIdeError } from './ide-error';

export interface CompraGovInput {
  /** 1 União, 2 Estado, 3 DF, 4 Município, 5 Consórcio Público, 6 Comitê Gestor do IBS. */
  readonly tpEnteGov: TCompraGov['tpEnteGov'];
  /** Percentual de redução da alíquota em compra governamental (0–100). */
  readonly pRedutor: number;
  /**
   * 1 fornecimento com pagamento posterior · 2 recebimento do pagamento com
   * fornecimento já realizado · 3 fornecimento com pagamento já realizado ·
   * 4 recebimento do pagamento com fornecimento posterior.
   */
  readonly tpOperGov: TCompraGov['tpOperGov'];
  /** Chaves of the earlier DF-e this operation completes (BB05). */
  readonly refDFeAnt?: readonly string[];
}

/** BB05-10…50 — how many `refDFeAnt` each `tpOperGov` takes: [min, max]. */
const CARDINALIDADE_REF: Readonly<Record<TCompraGov['tpOperGov'], readonly [number, number]>> = {
  '1': [0, 0], // BB05-10 (1195): informada indevidamente
  '2': [1, 1], // BB05-20 (1196) required; BB05-30: mais de uma
  '3': [1, 99], // BB05-40: required
  '4': [0, 0], // BB05-50: informada indevidamente
};

/** Build `ide/gCompraGov`, refusing (NFeIdeError) what SEFAZ refuses on shape alone. */
export function buildCompraGov(c: CompraGovInput): TCompraGov {
  const refs = [...(c.refDFeAnt ?? [])];
  const [min, max] = CARDINALIDADE_REF[c.tpOperGov];
  if (refs.length < min || refs.length > max) {
    throw new NFeIdeError(
      `gCompraGov: tpOperGov ${c.tpOperGov} takes ${min === max ? min : `${min}–${max}`} ` +
        `refDFeAnt, got ${refs.length} (BB05)`,
    );
  }
  for (const ref of refs) {
    if (!CHAVE_NFE_REGEX.test(ref)) {
      throw new NFeIdeError(`gCompraGov.refDFeAnt is not a chave de acesso: '${ref}'`);
    }
  }
  if (new Set(refs).size !== refs.length) {
    throw new NFeIdeError('gCompraGov.refDFeAnt references the same DF-e twice (BB05-140)');
  }
  if (!Number.isFinite(c.pRedutor) || c.pRedutor < 0 || c.pRedutor > 100) {
    throw new NFeIdeError(`gCompraGov.pRedutor must be a percentage 0–100, got ${c.pRedutor}`);
  }
  return {
    tpEnteGov: c.tpEnteGov,
    pRedutor: fmtRate('gCompraGov.pRedutor', c.pRedutor),
    tpOperGov: c.tpOperGov,
    ...(refs.length > 0 ? { refDFeAnt: refs } : {}),
  };
}
