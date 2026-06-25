import type { Firestore } from 'firebase-admin/firestore';

import { inutNumeracaoCollection, nfev4Collection } from '@delfrance/data/admin/collections';
import {
  cUFFromUF,
  inutilizarNumeracao as inutilizarNumeracaoSefaz,
  NFeInutilizacaoError,
  type SefazCall,
} from '@delfrance/integrations-nfe';
import {
  ESTADO_ENVI_NFE_MSG,
  ESTADO_NFE,
  type EstadoNFe,
  type Filial,
  type NotaFiscalEletronica,
} from '@delfrance/schemas';

import type { NFeBaseRuntime } from '../runtime';
import { resolveFilialRuntime } from '../filial-cert';
import { NFeInutilizacaoAbortedError, NFeOrchestratorError } from './errors';

/** Result of an inutilização de numeração. */
export interface InutilizarNumeracaoResult {
  readonly filialId: string;
  readonly serie: number;
  readonly nNFIni: number;
  readonly nNFFin: number;
  readonly cStat: string;
  readonly xMotivo: string;
  readonly nProt: string | null;
  /** `true` when SEFAZ homologou (cStat 102). */
  readonly aprovada: boolean;
  /** Count of nfev4 docs flipped to `numeracaoInutilizada` after a 102. */
  readonly reconciled: number;
}

/**
 * NF-e estados that mean the número was authorized at SEFAZ and is therefore
 * consumed — it can NEVER be inutilized (consumo indevido). `cancelada` counts:
 * a cancelled NF-e was authorized first, so its número is spent.
 */
export const ESTADOS_NFE_AUTORIZADAS: ReadonlySet<EstadoNFe> = new Set<EstadoNFe>([
  ESTADO_NFE.aprovada,
  ESTADO_NFE.epecAprovado,
  ESTADO_NFE.cancelada,
]);

/**
 * Inutilizar a contiguous range of NF-e números for a filial
 * (`NfeInutilizacao4`). For números that will never be authorized (gaps).
 *
 * Flow:
 *   1. **Pre-check (consumo indevido guard):** collection-group scan of `nfev4`
 *      in the (série, range) attributable to this filial; if any is already
 *      authorized (aprovada / EPEC / cancelada) → abort with
 *      `NFeInutilizacaoAbortedError`, send nothing.
 *   2. Send the synchronous `inutNFe`.
 *   3. Persist a durable record to `filiais/{filialId}/inutilizacao` — the
 *      single source of truth for the round-trip, **whether homologada or
 *      rejeitada** (no separate `enviNfe` audit entry).
 *   4. On `cStat=102`: reconcile — flip every other attributable in-range nfev4
 *      doc to `numeracaoInutilizada` ('i'), and return the protocol + count.
 *      Any other cStat throws `NFeInutilizacaoError` (record already saved).
 *
 * Does NOT touch the `NFeConfig` counter — these números were already skipped.
 */
export async function inutilizarNumeracao(
  fs: Firestore,
  baseRt: NFeBaseRuntime,
  args: {
    readonly filialId: string;
    readonly serie: number;
    readonly nNFIni: number;
    readonly nNFFin: number;
    readonly xJust: string;
  },
): Promise<InutilizarNumeracaoResult> {
  console.debug(
    `[nfe/orchestrator] inutilizarNumeracao filial=${args.filialId} serie=${args.serie} ` +
      `range=${args.nNFIni}-${args.nNFFin}`,
  );
  if (args.nNFIni > args.nNFFin) {
    throw new NFeOrchestratorError(
      `inutilização: nNFIni (${args.nNFIni}) must be ≤ nNFFin (${args.nNFFin})`,
    );
  }
  // eslint-disable-next-line no-restricted-syntax -- read-only filial lookup (no apps/nfe write handle for filiais)
  const filialSnap = await fs.doc(`filiais/${args.filialId}`).get();
  if (!filialSnap.exists) {
    throw new NFeOrchestratorError(`filial '${args.filialId}' not found`);
  }
  const filial = filialSnap.data() as Filial;
  // Inutilização is sent + signed with the filial's own cert (or env fallback).
  const rt = await resolveFilialRuntime(fs, baseRt, args.filialId);
  const cUF = cUFFromUF(filial.sede.estado);
  const ano = String(new Date().getFullYear() % 100).padStart(2, '0');

  // 1. Pre-check: every nfev4 doc whose número is in the range, then narrow to
  // this filial + série in memory. Deliberately left index-free: inutilização is
  // a rare admin op, so the unindexed collection-group scan (Firestore Enterprise
  // auto-creates NO indexes — an undeclared query degrades to a full group scan,
  // it never throws) carries a negligible recurring cost. Not worth an index (#108).
  // Attribution: the denormalized `filialId`, or (legacy docs) the emitter
  // CNPJ embedded in the chave (positions 6-20). An authorized doc always
  // carries a chave, so the CNPJ path keeps the guard correct for docs written
  // before `filialId` existed.
  const rangeSnap = await nfev4Collection
    .groupQuery(fs)
    .where('numeracao', '>=', args.nNFIni)
    .where('numeracao', '<=', args.nNFFin)
    .get();
  const owned = rangeSnap.docs.filter((d) => {
    const data = d.data() as NotaFiscalEletronica;
    if (data.serie !== args.serie) return false;
    if (data.filialId === args.filialId) return true;
    return typeof data.chave === 'string' && data.chave.slice(6, 20) === filial.cnpj;
  });

  const autorizadas = owned
    .map((d) => d.data() as NotaFiscalEletronica)
    .filter((data) => ESTADOS_NFE_AUTORIZADAS.has(data.estado));
  if (autorizadas.length > 0) {
    const nums = autorizadas.map((d) => d.numeracao).sort((a, b) => a - b);
    throw new NFeInutilizacaoAbortedError(
      `inutilização abortada: número(s) ${nums.join(', ')} da série ${args.serie} ` +
        `pertence(m) a NF-e já autorizada(s) — não é possível inutilizar (consumo indevido)`,
    );
  }

  // 2. Send to SEFAZ.
  const call: SefazCall = {
    cert: rt.cert,
    agent: rt.agent,
    tpAmb: rt.tpAmb,
    url: rt.endpoints.NfeInutilizacao,
  };
  const res = await inutilizarNumeracaoSefaz(call, {
    cUF,
    ano,
    cnpj: filial.cnpj,
    serie: args.serie,
    nNFIni: args.nNFIni,
    nNFFin: args.nNFFin,
    xJust: args.xJust,
  });
  const inf = res.ret.infInut;
  const aprovada = inf.cStat === '102';
  const now = new Date().toISOString();
  // Normalize the protocol: an absent OR empty `<nProt/>` element becomes null
  // (the record schema is `nProt: z.string().min(1).nullable()`, which rejects '').
  const nProt = inf.nProt || null;

  // 3. Persist the durable inutilização record — homologada OR rejeitada. This
  // is the single source of truth for the round-trip: it already stores the
  // signed request, the SEFAZ reply, cStat/xMotivo/nProt and estado, so there
  // is no separate `enviNfe` audit entry (that generic log is for emit/cancel
  // of a specific NF-e; the inutilização screen reads this record directly).
  await inutNumeracaoCollection.add(
    fs,
    { filialId: args.filialId },
    {
      serie: args.serie,
      nNFIni: args.nNFIni,
      nNFFin: args.nNFFin,
      xJust: args.xJust,
      xml_enviado: res.signedXml,
      xml_retorno: res.rawResponse,
      cStat: inf.cStat,
      xMotivo: inf.xMotivo,
      nProt,
      error: aprovada ? null : `cStat ${inf.cStat} — ${inf.xMotivo}`,
      estado: aprovada ? ESTADO_ENVI_NFE_MSG.concluido : ESTADO_ENVI_NFE_MSG.error,
      timestamp: now,
      ultima_modificacao: now,
    },
  );

  if (!aprovada) {
    throw new NFeInutilizacaoError(
      `inutilização rejeitada por SEFAZ — cStat=${inf.cStat} ${inf.xMotivo}`,
    );
  }

  // 4. Reconcile: flip every attributable in-range NF-e that was NOT authorized
  // (and isn't already inutilizada) to `numeracaoInutilizada`. These docs
  // consumed a número that is now officially burned.
  const toBurn = owned.filter((d) => {
    const estado = (d.data() as NotaFiscalEletronica).estado;
    return !ESTADOS_NFE_AUTORIZADAS.has(estado) && estado !== ESTADO_NFE.numeracaoInutilizada;
  });
  if (toBurn.length > 0) {
    const batch = fs.batch();
    const burnedAt = new Date().toISOString();
    for (const d of toBurn) {
      batch.set(
        d.ref,
        nfev4Collection.parseMerge({
          estado: ESTADO_NFE.numeracaoInutilizada,
          cStat: inf.cStat,
          xMotivo: inf.xMotivo,
          ultima_modificacao: burnedAt,
        }),
        { merge: true },
      );
    }
    await batch.commit();
  }

  return {
    filialId: args.filialId,
    serie: args.serie,
    nNFIni: args.nNFIni,
    nNFFin: args.nNFFin,
    cStat: inf.cStat,
    xMotivo: inf.xMotivo,
    nProt,
    aprovada: true,
    reconciled: toBurn.length,
  };
}
