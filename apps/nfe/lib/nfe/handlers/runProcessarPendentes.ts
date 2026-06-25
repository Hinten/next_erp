/**
 * Shared backstop-sweep handler — the post-auth, HTTP-free core of what was
 * `POST /api/nfe/processar-pendentes`. Used by the `nfeReconcileSweep` Cloud
 * Function (executes it in-process) and by the (kept) manual route.
 *
 * Collection-group scans the `nfev4` subcollections for docs stuck in
 * `enviando` / `aguardandoResposta` / `epecAprovado`, then: transmits approved
 * EPECs once the filial leaves contingency, reconciles due lotes by receipt
 * (`reconcileByRecibo`, deduped by `nRec`), and consults legacy (no-`nRec`) docs
 * by chave. Per-doc errors are accumulated, never thrown — the sweep always
 * returns a full report.
 */
import type { Firestore } from 'firebase-admin/firestore';

import { cartaCorrecaoCollection, nfev4Collection } from '@delfrance/data/admin/collections';
import {
  applyOutcome,
  buildNFeProc,
  classifyCStat,
  consultarSituacaoNFe,
  DEFAULT_STUCK_TIMEOUT_MS,
  isStuckEnviando,
  outcomeFromRetConsSit,
  type TpEmis,
} from '@delfrance/integrations-nfe';
import {
  type CartaCorrecao,
  ESTADO_ENVI_NFE_MSG,
  ESTADO_NFE,
  type EstadoNFe,
  type NotaFiscalEletronica,
} from '@delfrance/schemas';

import type { NFeBaseRuntime } from '../runtime';
import { resolveFilialRuntime, resolveFilialRuntimeByCnpj } from '../filial-cert';
import { persistPatch, procPersistExtras } from '../orchestrator/audit';
import { loadNfeConfigForEmission } from '../orchestrator/bundle';
import { reconcileCartaCorrecaoVinculo } from '../orchestrator/carta-correcao';
import { transmitirPosEpec } from '../orchestrator/epec';
import { recover539IfNeeded } from '../orchestrator/recover539';
import { reconcileByRecibo } from '../orchestrator/reconcile';
import { sefazCallFor } from '../orchestrator/sefaz-call';

export interface ProcessarPendentesParams {
  readonly batchSize?: number;
  readonly timeoutMs?: number;
}

export interface ProcessarPendentesResult {
  readonly scanned: number;
  readonly recovered: number;
  readonly stillPending: number;
  readonly errors: ReadonlyArray<{ chave: string | null; error: string }>;
}

interface PendingDoc {
  readonly path: string;
  readonly estado: EstadoNFe;
  readonly chave: string | null;
  readonly tpEmis: number | null;
  readonly filialId: string | null;
  readonly ultima_modificacao: string | null;
  readonly retries: number | null;
  /** Lote receipt — when present, the doc is reconciled by recibo (consReci), not consSit. */
  readonly nRec: string | null;
  /** Async-reconciler due gate (µs epoch). Null on legacy docs → fall back to `isStuckEnviando`. */
  readonly proximaConsultaEm: number | null;
  /** The persist-before-send anchor — feeds `buildNFeProc` when the consult recovers `autorizada`. */
  readonly xml_assinado: string | null;
}

/**
 * Backstop due-gate: a doc is due iff its `proximaConsultaEm` (µs epoch) has
 * passed. Legacy docs predating the field (`proximaConsultaEm == null`) fall
 * back to the coarse `isStuckEnviando` timeout. Respecting `proximaConsultaEm`
 * is what keeps the sweep from consulting a lote the Cloud Task is already
 * pacing — the consumo-indevido guard (#77).
 */
function isDue(data: PendingDoc, now: Date, timeoutMs: number): boolean {
  if (data.proximaConsultaEm != null) {
    return data.proximaConsultaEm <= now.getTime() * 1000;
  }
  return isStuckEnviando(
    { estado: data.estado, ultima_modificacao: data.ultima_modificacao ?? null },
    now,
    timeoutMs,
  );
}

/**
 * CC-e backstop sweep — the `cartacorrecao` analogue of the lote sweep (#241).
 *
 * A cStat-136 CC-e (`aguardandoVinculo`) is normally resolved by its `cce-vinculo`
 * Cloud Task; if that task is ever lost (enqueue failure, function down at
 * dispatch, dead-lettered past `maxAttempts`), the record would sit pending
 * forever. This collection-group scan re-checks each due record via the same
 * idempotent `reconcileCartaCorrecaoVinculo` the task uses — restoring the
 * dual-mechanism (task + sweep) symmetry the lote path already has.
 *
 * Like the lote path, it does NOT re-enqueue a task: the cron's own cadence,
 * gated by each record's refreshed `proximaConsultaEm`, is the recovery. The
 * estado filter is server-side (a single-field group query — no index needed on
 * Firestore Enterprise); the due-gate is applied in code so the sweep never
 * preempts a healthy task.
 */
export async function sweepCartasCorrecaoPendentes(args: {
  fs: Firestore;
  baseRt: NFeBaseRuntime;
  batchSize: number;
  now: Date;
}): Promise<ProcessarPendentesResult> {
  const { fs, baseRt, batchSize, now } = args;
  const nowMicros = now.getTime() * 1000;

  const snap = await cartaCorrecaoCollection
    .groupQuery(fs)
    .where('estado', '==', ESTADO_ENVI_NFE_MSG.aguardandoVinculo)
    .limit(batchSize)
    .get();

  let scanned = 0;
  let recovered = 0;
  let stillPending = 0;
  const errors: { chave: string | null; error: string }[] = [];

  for (const doc of snap.docs) {
    scanned++;
    const data = doc.data() as CartaCorrecao;

    // Due-gate: respect a future `proximaConsultaEm` (the task's pacing) so the
    // backstop never re-checks ahead of schedule. A null pacing (a stranded
    // record whose schedule was lost) is treated as due so it still recovers.
    if (data.proximaConsultaEm != null && data.proximaConsultaEm > nowMicros) {
      stillPending++;
      continue;
    }

    // Reconstruct the task payload from the doc path
    // (pedidos/{pedidoId}/nfev4/{nfeId}/cartacorrecao/{cceId}). The filial is
    // resolved inside reconcileCartaCorrecaoVinculo from the NF-e doc, so no
    // filialId is needed here.
    const cceId = doc.ref.id;
    const nfeId = doc.ref.parent.parent?.id;
    const pedidoId = doc.ref.parent.parent?.parent.parent?.id;
    if (!nfeId || !pedidoId) {
      errors.push({ chave: null, error: `${doc.ref.path}: malformed cartacorrecao path` });
      continue;
    }

    try {
      const result = await reconcileCartaCorrecaoVinculo(fs, baseRt, {
        kind: 'cce-vinculo',
        pedidoId,
        nfeId,
        cceId,
        nSeqEvento: data.nSeqEvento,
        attempt: data.retries ?? 0,
      });
      if (result.disposition === 'pending') {
        stillPending++;
      } else {
        // resolved / capped / rejected / gone / already-resolved → terminal for
        // this record (or an idempotent no-op); count as handled.
        recovered++;
      }
    } catch (e) {
      errors.push({
        chave: null,
        error: `${doc.ref.path}: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  return { scanned, recovered, stillPending, errors };
}

export async function runProcessarPendentes(args: {
  fs: Firestore;
  baseRt: NFeBaseRuntime;
  params: ProcessarPendentesParams;
}): Promise<ProcessarPendentesResult> {
  const { fs, baseRt, params } = args;
  const batchSize = params.batchSize ?? 100;
  const timeoutMs = params.timeoutMs ?? DEFAULT_STUCK_TIMEOUT_MS;
  const now = new Date();

  const snap = await nfev4Collection
    .groupQuery(fs)
    .where('estado', 'in', [
      ESTADO_NFE.enviando,
      ESTADO_NFE.aguardandoResposta,
      ESTADO_NFE.epecAprovado,
    ])
    .limit(batchSize)
    .get();

  let scanned = 0;
  let recovered = 0;
  let stillPending = 0;
  const errors: { chave: string | null; error: string }[] = [];
  // Filial contingency modes, read once per filial per run — an approved
  // EPEC is only transmitted once the operator flipped the modo back.
  const modoByFilial = new Map<string, string>();
  // Due lotes to reconcile by receipt, deduped by nRec so each lote is
  // consulted ONCE per run (consReci returns the whole lote) — consulting the
  // same recibo once per member doc would be the consumo-indevido vector (#77).
  const dueLotes = new Map<string, { filialId: string; tpEmis: number }>();

  for (const doc of snap.docs) {
    scanned++;
    const data = doc.data() as PendingDoc;

    // Approved EPECs (estado 'p'): the pendência is the mandatory pós-EPEC
    // full transmission to the home SEFAZ, not a lost-response recovery.
    if (data.estado === ESTADO_NFE.epecAprovado) {
      if (!data.filialId) {
        errors.push({ chave: data.chave, error: `${doc.ref.path}: EPEC doc missing filialId` });
        continue;
      }
      try {
        let modo = modoByFilial.get(data.filialId);
        if (modo === undefined) {
          modo = (await loadNfeConfigForEmission(fs, data.filialId)).contingencia_modo;
          modoByFilial.set(data.filialId, modo);
        }
        if (modo === 'epec') {
          // Outage still on — transmitting now would just 468/fail.
          stillPending++;
          continue;
        }
        const pedidoId = doc.ref.parent.parent?.id;
        if (!pedidoId) {
          errors.push({ chave: data.chave, error: `${doc.ref.path}: no parent pedido` });
          continue;
        }
        const result = await transmitirPosEpec({
          fs,
          rt: await resolveFilialRuntime(fs, baseRt, data.filialId),
          filialId: data.filialId,
          pedidoId,
          nfeRef: doc.ref,
          nota: doc.data() as NotaFiscalEletronica,
        });
        if (result.estado === ESTADO_NFE.epecAprovado) {
          stillPending++; // 468 — EPEC not yet synced at the home SEFAZ
        } else {
          recovered++;
        }
      } catch (e) {
        errors.push({
          chave: data.chave,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      continue;
    }

    // Due-gate: respect `proximaConsultaEm` (the task's pacing) so the backstop
    // never consults a lote ahead of its scheduled time. Not-yet-due docs are
    // left for the Cloud Task (or a later sweep tick).
    if (!isDue(data, now, timeoutMs)) {
      stillPending++;
      continue;
    }
    // Preferred path: reconcile by RECEIPT. Bucket by nRec so the whole lote is
    // consulted once after the scan (reconcileByRecibo re-queries by nRec, so it
    // also picks up lote members beyond this batch's limit). Needs the filial to
    // resolve its A1 cert; nRec-but-no-filialId legacy docs fall through to
    // consSit below.
    if (data.nRec && data.filialId) {
      dueLotes.set(data.nRec, { filialId: data.filialId, tpEmis: data.tpEmis ?? 1 });
      continue;
    }
    if (!data.chave) {
      errors.push({ chave: null, error: `${doc.ref.path}: missing chave on stuck doc` });
      continue;
    }
    // Fallback: legacy docs with no nRec (or no filialId) — consult by chave.
    try {
      // mTLS presents the filial's cert (or env fallback) when the doc carries
      // a filialId; legacy docs without one resolve the cert from the emit CNPJ
      // baked into the chave (positions 6–20) — there is no shared env cert.
      const frt = data.filialId
        ? await resolveFilialRuntime(fs, baseRt, data.filialId)
        : await resolveFilialRuntimeByCnpj(fs, baseRt, data.chave.slice(6, 20));
      // Consult the authorizer that owns the NF-e's tpEmis — an SVC-emitted
      // doc (6/7) is recovered at its SVC, not at the (possibly still down)
      // home SEFAZ.
      const retSit = await consultarSituacaoNFe(
        sefazCallFor(frt, (data.tpEmis ?? 1) as TpEmis, 'NfeConsultaProtocolo'),
        { chave: data.chave },
      );
      const outcome = outcomeFromRetConsSit(retSit);
      let patch = applyOutcome({ estado: data.estado, retries: data.retries }, outcome);

      // cStat=539 (duplicidade com chave diferente) → recover the asserted chave
      // or flip to terminal `error`, never left aguardandoResposta (#243). Needs
      // the filial to look up our audit log; a legacy doc with no filialId can't,
      // so it keeps the generic outcome (pre-existing behavior for that rare case).
      let chaveSwapped = false;
      if (data.filialId) {
        const recovered539 = await recover539IfNeeded({
          fs,
          bundle: { pedidoId: doc.ref.parent?.parent?.id ?? doc.ref.path, filialId: data.filialId },
          nfeRef: doc.ref,
          rt: frt,
          tpEmis: (data.tpEmis ?? 1) as TpEmis,
          outcome,
          patch,
        });
        patch = recovered539.patch;
        chaveSwapped = recovered539.chaveOverride != null;
      }

      // A consult that lands `autorizada` carries the authoritative protNFe —
      // persist the `nfeProc` here too (the emit path does it inside
      // `applyAutorizadoOutcome`), so a cron-recovered doc can render a DANFE
      // and sheds the duplicate signed XML in the same atomic write (#128). A
      // 539 chave-swap skips it (the local signed XML no longer matches).
      const nfeProcXml =
        !chaveSwapped &&
        classifyCStat(patch.cStat) === 'autorizada' &&
        retSit.protNFe != null &&
        retSit.protNFe.infProt.chNFe === data.chave &&
        data.xml_assinado != null
          ? buildNFeProc(data.xml_assinado, retSit.protNFe)
          : null;
      // persistPatch (not an inline merge) so its nRec preservation applies
      // here too: a consSit outcome carries no receipt, and overwriting the
      // nRec saved on cStat=103 with null would orphan the lote-poll trail.
      await persistPatch(
        doc.ref,
        patch,
        nfeProcXml != null ? procPersistExtras(nfeProcXml) : undefined,
      );
      recovered++;
    } catch (e) {
      errors.push({
        chave: data.chave,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Reconcile each due lote by receipt — once per nRec. The shared core consults
  // `consReciNFe`, applies per-chave outcomes, enforces the 656-terminal rule and
  // the attempt cap, and re-stamps each doc's `proximaConsultaEm`. The backstop
  // does NOT re-enqueue a Cloud Task — its own cadence (gated by the refreshed
  // `proximaConsultaEm`) is the recovery when the primary task path is lost.
  for (const [nRec, info] of dueLotes) {
    try {
      const rt = await resolveFilialRuntime(fs, baseRt, info.filialId);
      const r = await reconcileByRecibo({
        fs,
        rt,
        filialId: info.filialId,
        nRec,
        tpEmis: info.tpEmis as TpEmis,
        attempt: 0,
      });
      recovered += r.recovered + r.errored;
      stillPending += r.stillPending;
    } catch (e) {
      errors.push({
        chave: null,
        error: `nRec ${nRec}: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  // CC-e backstop sweep (#241) — the cartacorrecao analogue of the lote sweep
  // above. Folded into the same tallies; its per-doc errors carry a
  // cartacorrecao path (chave: null) in the message.
  const cce = await sweepCartasCorrecaoPendentes({ fs, baseRt, batchSize, now });

  return {
    scanned: scanned + cce.scanned,
    recovered: recovered + cce.recovered,
    stillPending: stillPending + cce.stillPending,
    errors: [...errors, ...cce.errors],
  };
}
