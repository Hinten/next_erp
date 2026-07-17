import type { Firestore } from 'firebase-admin/firestore';

import { nfev4Collection } from '@delfrance/data/admin/collections';
import {
  applyOutcome,
  buildNFeProcSafe,
  classifyCStat,
  consultarLote,
  consultarSituacaoNFe,
  isEstadoFinalNFe,
  outcomeFromRetConsSit,
  type NFeStatePatch,
  type SefazCall,
  type SefazOutcome,
  type TpEmis,
  type TRetConsReciNFe,
} from '@delfrance/integrations-nfe';
import type { NotaFiscalEletronica } from '@delfrance/schemas';

import type { NFeBaseRuntime, NFeRuntime } from '../runtime';
import { resolveFilialRuntime } from '../filial-cert';
import { NFeOrchestratorError } from './errors';
import { loadPedidoBundle, type EmitResult } from './bundle';
import { sefazCallFor } from './sefaz-call';
import { recover539IfNeeded } from './recover539';
import {
  buildEnviNFeMsgFromConsulta,
  enviNfeCollection,
  existingToEmitResult,
  findLatestEnviNFeMsgWithNRec,
  outcomeFromConsReci,
  persistPatchUnlessFinal,
  procPersistExtras,
} from './audit';

/** What one persisted-chave SEFAZ consulta produced. */
export interface ConsultaChaveResult {
  /** The persisted patch (already written to the nfev4 doc). */
  readonly patch: NFeStatePatch;
  /** The doc's chave after a possible cStat=539 swap. */
  readonly chaveFinal: string;
  /** The lote receipt the consReci path used, when one existed in the audit log. */
  readonly nRecUsado: string | null;
}

/**
 * Consult SEFAZ for ONE already-persisted nfev4 doc and persist the outcome —
 * the shared core of `consultarPedido` (CLI) and `verificarEnviNfeMsgs`
 * (the manual "Verificar novamente" action).
 *
 * Prefers `consReciNFe(nRec)` when an audit-log msg holds a receipt — it works
 * while the lote is still queued at SEFAZ (cStat=105) and yields the protocol
 * once processed. When the consReci outcome asks for `recover-via-consulta`
 * (duplicidade ≠539 / lote não localizado — e.g. an expired receipt, cStat=106),
 * falls through to `consSitNFe(chave)` in the same call so a manual
 * verification is conclusive (mirrors `emitirPedido`'s recover branch). With
 * no receipt at all it goes straight to `consSitNFe`.
 *
 * Every SEFAZ round-trip appends an `enviNfe` audit doc. The final outcome
 * runs `applyOutcome` (with the doc's current estado/cStat/xMotivo, so the
 * cancelada/inutilizada anti-regression defense can fire), the shared 539
 * gate, the digest-safe `<nfeProc>` stitch on autorizada, and the
 * TOCTOU-guarded `persistPatchUnlessFinal` (a doc that reaches a final estado
 * during the SEFAZ round-trip is never overwritten; the returned patch then
 * reflects the doc's CURRENT estado/cStat/xMotivo).
 *
 * NOT gated on `isEstadoFinalNFe` — callers own that guard (they decide
 * whether to skip or report).
 *
 * `consReciCache` (optional): a per-run `nRec → retConsReciNFe` cache. A batch
 * caller consulting N chaves of the SAME lote (e.g. `verificarEnviNfeMsgs` on
 * a legacy multi-chave msg) would otherwise fire N back-to-back `consReciNFe`
 * calls for one nRec — the SEFAZ cStat=656 (consumo indevido) vector. On a
 * cache hit the stored response is reused: no SEFAZ call and no duplicate
 * audit doc (the audit row was written on first fetch). Single-chave callers
 * (`consultarPedido`) simply pass none.
 */
export async function consultarChavePersistida(params: {
  fs: Firestore;
  rt: NFeRuntime;
  filialId: string;
  pedidoId: string;
  nfeRef: FirebaseFirestore.DocumentReference;
  nota: NotaFiscalEletronica;
  chave: string;
  consReciCache?: Map<string, TRetConsReciNFe>;
}): Promise<ConsultaChaveResult> {
  const { fs, rt, filialId, pedidoId, nfeRef, nota, chave, consReciCache } = params;
  // SEFAZ routing follows the PERSISTED tpEmis (an SVC-emitted NF-e is
  // consulted at its SVC even after the mode is switched back).
  const notaTpEmis = (nota.tpEmis ?? 1) as TpEmis;
  const current = {
    estado: nota.estado,
    retries: nota.retries ?? 0,
    cStat: nota.cStat,
    xMotivo: nota.xMotivo,
  };

  const msgWithNRec = await findLatestEnviNFeMsgWithNRec(fs, filialId, chave);

  // The authoritative SEFAZ protocol for our chave, when one surfaced —
  // needed for the `<nfeProc>` stitch on autorizada.
  let protNFeRaw: Awaited<ReturnType<typeof consultarSituacaoNFe>>['protNFe'] | null = null;

  async function consultarPorChave(): Promise<SefazOutcome> {
    const consSitCall: SefazCall = sefazCallFor(rt, notaTpEmis, 'NfeConsultaProtocolo');
    const retSit = await consultarSituacaoNFe(consSitCall, { chave });
    await enviNfeCollection(fs, filialId).add(
      buildEnviNFeMsgFromConsulta({ chave, nRec: null, ret: retSit, tpEmis: notaTpEmis }),
    );
    protNFeRaw = retSit.protNFe ?? null;
    return outcomeFromRetConsSit(retSit);
  }

  let outcome: SefazOutcome;
  if (msgWithNRec?.nRec) {
    const nRec = msgWithNRec.nRec;
    // Per-run dedupe: N chaves of the same lote share one consReciNFe
    // round-trip (and one audit doc) — see the `consReciCache` jsdoc.
    let retRec = consReciCache?.get(nRec);
    if (!retRec) {
      const consReciCall: SefazCall = sefazCallFor(rt, notaTpEmis, 'NfeRetAutorizacao');
      retRec = await consultarLote(consReciCall, { nRec });
      await enviNfeCollection(fs, filialId).add(
        buildEnviNFeMsgFromConsulta({
          chave,
          nRec,
          ret: retRec,
          tpEmis: notaTpEmis,
        }),
      );
      consReciCache?.set(nRec, retRec);
    }
    protNFeRaw = retRec.protNFe?.find((p) => p.infProt.chNFe === chave) ?? null;
    outcome = outcomeFromConsReci(retRec, chave);
  } else {
    outcome = await consultarPorChave();
  }

  let patch = applyOutcome(current, outcome);

  // Fall-through: the receipt no longer resolves (106 lote não localizado /
  // duplicidade ≠539) — consult by chave in the same call so the manual
  // verification is conclusive (mirrors emitirPedido's recover branch). 539
  // stays with the shared recover539 gate; the no-nRec path already IS the
  // consSit, so it never re-consults.
  if (msgWithNRec?.nRec && patch.action === 'recover-via-consulta' && outcome.cStat !== '539') {
    outcome = await consultarPorChave();
    patch = applyOutcome(current, outcome);
  }

  // cStat=539 (duplicidade com chave diferente): recover the SEFAZ-asserted
  // chave if it is one we emitted, else flip to terminal `error` — never leave
  // the doc stuck aguardandoResposta (#243). No-op for every other outcome.
  const recovered539 = await recover539IfNeeded({
    fs,
    bundle: { pedidoId, filialId },
    nfeRef,
    rt,
    tpEmis: notaTpEmis,
    outcome,
    patch,
  });
  patch = recovered539.patch;
  const chaveSwapped = recovered539.chaveOverride != null;
  const chaveFinal = recovered539.chaveOverride ?? chave;

  // Build `<nfeProc>` when SEFAZ authorized this chave and we still hold the
  // matching signed XML — same atomic anchor-clear as the emit path (#128).
  // The digest-safe stitch (#396) refuses to pair the protocol with bytes it
  // did not authorize; the doc then stays aprovada WITHOUT proc for a
  // DistDFe/manual fetch. A 539 chave-swap skips the build (our local signed
  // XML points at the old chave).
  const proc =
    !chaveSwapped &&
    classifyCStat(patch.cStat) === 'autorizada' &&
    protNFeRaw != null &&
    nota.xml_assinado != null
      ? buildNFeProcSafe(nota.xml_assinado, protNFeRaw)
      : null;
  const nfeProcXml = proc?.xml ?? null;
  if (proc?.digest === 'mismatch') {
    console.warn(
      `[nfe/consultar] chave ${chave}: local DigestValue differs from the protNFe ` +
        `digVal — skipping the <nfeProc> build; the doc stays aprovada WITHOUT ` +
        `xml_nfe_proc (xml_assinado kept; fetch the authorized XML via DistDFe/manual import)`,
    );
  }

  // TOCTOU guard: `applyOutcome`'s anti-regression defense ran against the
  // estado read BEFORE the SEFAZ round-trip — a doc that became final
  // (e.g. cancelada) mid-call must not be blindly merged over.
  const persisted = await persistPatchUnlessFinal(
    fs,
    nfeRef,
    patch,
    nfeProcXml != null ? procPersistExtras(nfeProcXml) : undefined,
  );
  if (!persisted.written) {
    // Nothing was written — report the doc's live truth, not the stale patch.
    patch = {
      ...patch,
      estado: persisted.estadoAtual,
      cStat: persisted.cStatAtual ?? patch.cStat,
      xMotivo: persisted.xMotivoAtual ?? patch.xMotivo,
      retries: 0,
      action: 'done-terminal',
      tMed: null,
    };
  }

  return { patch, chaveFinal, nRecUsado: msgWithNRec?.nRec ?? null };
}

/**
 * Standalone SEFAZ consulta for an already-persisted nfev4 doc. Picks the
 * pedido's most recently touched NF-e (a pedido can hold one doc per tpEmis
 * — `s1` plus `s6`/`s7` across contingency flips), queries SEFAZ via the
 * shared `consultarChavePersistida` core, and returns the same shape
 * `emitirPedido` does.
 *
 * **Terminal guard**: a doc already in a SEFAZ-final estado (aprovada /
 * cancelada / numeração inutilizada) is returned as-is with `reused: true` —
 * no SEFAZ call, no writes. Another consulta can never legitimately change
 * those estados, and for cancelada/inutilizada it would even be harmful
 * (`consSitNFe` still returns the original authorization protNFe).
 *
 * Used by the `consult:dev-pedido` CLI for manual polling.
 */
export async function consultarPedido(
  fs: Firestore,
  baseRt: NFeBaseRuntime,
  pedidoId: string,
): Promise<EmitResult> {
  console.debug(`[nfe/orchestrator] consultarPedido pedidoId='${pedidoId}'`);

  const bundle = await loadPedidoBundle(fs, pedidoId);
  // mTLS for the consulta must present this filial's cert (or the env
  // fallback) — SEFAZ identifies the transmitter by the handshake cert.
  const rt = await resolveFilialRuntime(fs, baseRt, bundle.filialId);
  // Scan the pedido's nfev4 slots (at most a handful) instead of deriving
  // one slot from the CURRENT config mode — after a contingency toggle the
  // live NF-e may sit in `s6`/`s7` while the mode is already back to none
  // (or vice-versa). The most recently modified doc with a chave is the one
  // the operator means.
  const slotsSnap = await nfev4Collection.ref(fs, { pedidoId }).get();
  const chosen = slotsSnap.docs
    // Admin reads bypass the converter — parse each doc so a legacy ISO
    // `ultima_modificacao` is coerced to ms (else the numeric sort below → NaN).
    .map((d) => ({ id: d.id, nota: nfev4Collection.parseRead(d.data(), d.ref.path) }))
    .filter((c) => c.nota.chave)
    // `ultima_modificacao` is ms since epoch → numeric compare (newest first).
    .sort((a, b) => (b.nota.ultima_modificacao ?? 0) - (a.nota.ultima_modificacao ?? 0))[0];
  if (!chosen) {
    throw new NFeOrchestratorError(
      `pedido '${pedidoId}': no nfev4 doc with a chave under pedidos/${pedidoId}/nfev4 — ` +
        'nothing to consult. Run `emit:dev-pedido` first.',
    );
  }
  const nfeRef = nfev4Collection.docRef(fs, { pedidoId }, chosen.id);
  const nota = chosen.nota;
  const chave = nota.chave;
  if (!chave) {
    // Unreachable (filtered above) — narrows `chave` to string for the calls below.
    throw new NFeOrchestratorError(`pedido '${pedidoId}': persisted nfev4 doc has no chave.`);
  }

  if (isEstadoFinalNFe(nota.estado)) {
    console.debug(
      `[nfe/orchestrator] pedido '${pedidoId}' nfev4 '${chosen.id}' is already final ` +
        `(estado=${nota.estado}) — returning persisted state without a SEFAZ call`,
    );
    return existingToEmitResult(pedidoId, nfeRef.id, nota);
  }

  const { patch, chaveFinal, nRecUsado } = await consultarChavePersistida({
    fs,
    rt,
    filialId: bundle.filialId,
    pedidoId,
    nfeRef,
    nota,
    chave,
  });

  return {
    nfeId: nfeRef.id,
    pedidoId,
    estado: patch.estado,
    chave: chaveFinal,
    nRec: patch.nRec ?? nRecUsado ?? nota.nRec,
    cStat: patch.cStat,
    xMotivo: patch.xMotivo,
    reused: false,
  };
}
