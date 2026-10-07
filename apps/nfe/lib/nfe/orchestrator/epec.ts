/**
 * EPEC — Evento Prévio de Emissão em Contingência (tpEmis=4).
 *
 * Two halves of the MOC Anexo III flow:
 *
 *   1. `enviarEpecParaNota` — emission while the home SEFAZ is down: the
 *      NF-e is generated + signed + persisted as usual (anti-loss anchor),
 *      but instead of `autorizarLote` the orchestrator sends the EPEC
 *      summary evento (tpEvento 110140) to the **Ambiente Nacional**.
 *      cStat 135 **or** 136 = EPEC registrado → estado `'p'` (epecAprovado)
 *      + the archival `xml_epec_proc`; the DANFE may then be printed. A
 *      resend of the STORED bytes answered 485/573 means the EPEC is already
 *      registered (`'p'` without its protocol, #1675) — see
 *      {@link disposicaoDoEpec}.
 *
 *   2. `transmitirPosEpec` — after the outage: the FULL NF-e (the stored
 *      `xml_assinado`, **same chave** — never regenerated) is transmitted to
 *      the home SEFAZ. 100/150 → aprovada + `xml_nfe_proc`; **468** (EPEC
 *      not yet synced from the AN) keeps estado `'p'` for a later retry;
 *      duplicidade rides the standard recovery branches.
 */
import type { Firestore } from 'firebase-admin/firestore';

import { enviNfeMsgCollection } from '@delfrance/data/admin/collections';
import {
  CSTAT_EPEC_DUPLICIDADE,
  CSTAT_EPEC_NAO_SINCRONIZADO,
  EPEC_EVENT_REGISTRADO,
  autorizarLote,
  enviarEpec,
  extractEpecInputFromNFe,
  nextIdLote,
  nfeConfigStoreFromFirestore,
  type NFeStatePatch,
  type SefazCall,
} from '@delfrance/integrations-nfe';
import { ESTADO_ENVI_NFE_MSG, ESTADO_NFE, type NotaFiscalEletronica } from '@delfrance/schemas';

import type { NFeRuntime } from '../runtime';
import { NFeOrchestratorError } from './errors';
import type { EmitResult } from './bundle';
import { applyAutorizadoOutcome } from './emitir';
import {
  buildEnviNFeMsgFromLote,
  completarProtocoloEpec,
  enviNfeCollection,
  existingToEmitResult,
  markAsLost,
  persistPatchUnlessFinal,
  recusaToEmitResult,
  reivindicarEnvio,
} from './audit';
import { CSTAT_DUPLICIDADE_EVENTO } from './cancelar';
import { sefazCallFor } from './sefaz-call';

/**
 * The Ambiente Nacional's answers meaning "an EPEC for this NF-e is ALREADY
 * registered" (NT 2014.001 v1.30 §3.8/§3.9): 573 — duplicidade de evento, rule
 * 3P15-10, keyed on tpEvento + chNFe + nSeqEvento; 485 — duplicidade de
 * numeração do EPEC, rule 3P12-10, keyed on modelo + UF + CNPJ + série +
 * número. Which one an identical resend earns first is not documented, so both
 * are read alike.
 */
export const EPEC_JA_REGISTRADO: ReadonlySet<string> = new Set([
  CSTAT_EPEC_DUPLICIDADE,
  CSTAT_DUPLICIDADE_EVENTO,
]);

/** xMotivo suffix of an EPEC our STORED bytes already registered (#1675). */
export const EPEC_JA_REGISTRADO_SUFIXO =
  'EPEC já registrado por um envio anterior desta mesma NF-e — protocolo não recuperado; ' +
  'a DANFE sai após a transmissão pós-EPEC';

/** xMotivo suffix of a FRESH NF-e whose número/chave another EPEC already holds (#1675). */
export const EPEC_A_CONCILIAR =
  'EPEC já registrado para esta numeração/chave com outros dados — não reemita; concilie o ' +
  'EPEC pendente (Portal Nacional da NF-e: Consultar EPEC pendente de conciliação)';

/**
 * What one EPEC evento reply makes of its NF-e (#1675). Pure.
 *
 *  - 135/136 → `'p'` (epecAprovado) + the archival `xml_epec_proc`.
 *  - 485/573 ({@link EPEC_JA_REGISTRADO}) on the STORED bytes of a #396
 *    crash-window anchor → `'p'` WITHOUT `xml_epec_proc`, SEFAZ's cStat kept and
 *    {@link EPEC_JA_REGISTRADO_SUFIXO} appended. Those exact bytes were sent
 *    before and the reply was lost, so the registered EPEC is ours. Never
 *    `rejeitada`: that takes the regenerate branch (fresh dhEmi) and overwrites
 *    the bytes the registered EPEC summarises, and the pós-EPEC transmission
 *    then answers 467 — an orphaned EPEC, "pendente de conciliação". As `'p'`
 *    the doc goes to `transmitirPosEpec` once the outage ends, where the home
 *    SEFAZ answers 100/150 if the EPEC is ours. Its DANFE stays blocked until
 *    then (no protocol to print — `danfe.ts`); recovering it is #314 (DistDFe).
 *  - 485/573 on FRESH bytes (generated or regenerated for this send) → `error`
 *    with {@link EPEC_A_CONCILIAR}: these bytes were never sent, so the EPEC on
 *    record describes OTHER data — 573 is keyed on the chave, and a regenerate
 *    keeps the chave within the month. A `rejeitada` would only invite the
 *    same regenerate → 573 again; the operator has to conciliate it.
 *  - anything else → `rejeitada`.
 */
export function disposicaoDoEpec(
  cStat: string,
  xMotivo: string,
  opts: { readonly storedBytes: boolean; readonly procEventoNFe: string | null },
): { readonly patch: NFeStatePatch; readonly extras: Record<string, unknown> | undefined } {
  const base: NFeStatePatch = {
    estado: ESTADO_NFE.rejeitada,
    cStat,
    xMotivo,
    retries: 0,
    nRec: null,
    action: 'done-rejected',
    tMed: null,
  };
  if (EPEC_EVENT_REGISTRADO.has(cStat)) {
    return {
      patch: { ...base, estado: ESTADO_NFE.epecAprovado, action: 'done-authorized' },
      extras: opts.procEventoNFe ? { xml_epec_proc: opts.procEventoNFe } : undefined,
    };
  }
  if (EPEC_JA_REGISTRADO.has(cStat)) {
    return opts.storedBytes
      ? {
          patch: {
            ...base,
            estado: ESTADO_NFE.epecAprovado,
            xMotivo: `${xMotivo} | ${EPEC_JA_REGISTRADO_SUFIXO}`,
            action: 'done-authorized',
          },
          extras: undefined,
        }
      : { patch: markAsLost(base, EPEC_A_CONCILIAR), extras: undefined };
  }
  return { patch: base, extras: undefined };
}

/**
 * Send the EPEC evento for a just-signed contingency NF-e and persist the
 * outcome on its nfev4 doc. Called by the emit cycle in place of
 * `autorizarLote` when the filial's modo is `'epec'`.
 *
 * `idLote` is the claim token the emit's allocation transaction stamped on the
 * doc (with the send reservation, #1675): the outcome write is owned by it, so
 * an EPEC run that a newer claim superseded mid-call never overwrites that
 * claim's doc — it reports the live doc as `reused` instead. Its evento reply
 * stays in the enviNfe audit entry written first; and a REGISTERED reply
 * (135/136) whose write was refused still fills in the protocol of a live `'p'`
 * doc of the same chave that has none (`completarProtocoloEpec`) — the run that
 * superseded it got 485/573 for the same EPEC.
 *
 * `storedBytes`: `signedXml` is a #396 crash-window doc's STORED bytes, sent
 * before — it decides what a 485/573 means ({@link disposicaoDoEpec}).
 */
export async function enviarEpecParaNota(args: {
  fs: Firestore;
  rt: NFeRuntime;
  filialId: string;
  pedidoId: string;
  nfeRef: FirebaseFirestore.DocumentReference;
  chave: string;
  signedXml: string;
  idLote: number;
  storedBytes: boolean;
}): Promise<EmitResult> {
  const { fs, rt, filialId, pedidoId, nfeRef, chave, signedXml, idLote } = args;

  const input = extractEpecInputFromNFe(signedXml, { tpAmb: rt.tpAmb });
  const anTarget = rt.an();
  const call: SefazCall = {
    url: anTarget.endpoints.RecepcaoEvento,
    cert: rt.cert,
    agent: anTarget.agent,
    tpAmb: rt.tpAmb,
  };
  const res = await enviarEpec(call, input);
  const ev = res.ret.retEvento?.[0]?.infEvento;
  const cStat = ev?.cStat ?? res.ret.cStat;
  const xMotivo = ev?.xMotivo ?? res.ret.xMotivo;
  const registrado = EPEC_EVENT_REGISTRADO.has(cStat);
  const now = (): string => new Date().toISOString();

  // Audit-log the AN round-trip (both halves) before touching the nfev4 doc.
  await enviNfeCollection(fs, filialId).add(
    enviNfeMsgCollection.parse({
      targetsChnfe: [chave],
      idLote: null,
      indSinc: null,
      xml_enviado: res.signedEventoXml,
      xml_retorno: res.rawResponse,
      nRec: null,
      cStat,
      xMotivo,
      error: null,
      tpEmis: 4,
      estado: ESTADO_ENVI_NFE_MSG.concluido,
      timestamp: now(),
      ultima_modificacao: now(),
    }),
  );

  // 135/136 = registrado (legacy parity — 136's linkage happens when the
  // full NF-e lands at the home SEFAZ); 485/573 read by where the bytes came
  // from (#1675, disposicaoDoEpec). Written through `buildPersistData`, which
  // also releases the send reservation, and owned by this run's idLote.
  const { patch, extras } = disposicaoDoEpec(cStat, xMotivo, {
    storedBytes: args.storedBytes,
    procEventoNFe: res.procEventoNFe ?? null,
  });
  const gravado = await persistPatchUnlessFinal(fs, nfeRef, patch, extras, {
    expectedIdLote: String(idLote),
  });
  if (!gravado.written) {
    // Superseded. A registered reply still carries the protocol the newer run
    // (answered 485/573 for this same EPEC) could not recover: fill it in,
    // fill-only, on a live 'p' doc of this chave that has none.
    if (registrado && res.procEventoNFe) {
      const curado = await completarProtocoloEpec(fs, nfeRef, chave, {
        xml_epec_proc: res.procEventoNFe,
        cStat,
        xMotivo,
        cStatsJaRegistrado: EPEC_JA_REGISTRADO,
      });
      if (curado != null) return existingToEmitResult(pedidoId, nfeRef.id, curado);
    }
    return recusaToEmitResult(pedidoId, nfeRef.id, chave, gravado);
  }

  return {
    nfeId: nfeRef.id,
    pedidoId,
    estado: patch.estado,
    chave,
    nRec: null,
    cStat: patch.cStat,
    xMotivo: patch.xMotivo,
    reused: false,
  };
}

/**
 * Transmit the FULL NF-e of an EPEC-approved doc (estado `'p'`) to the home
 * SEFAZ — the mandatory post-outage step. Sends the **stored** `xml_assinado`
 * (same chave; regenerating would orphan the registered EPEC) as a fresh
 * single-NFe sync lote, then applies the standard outcome machine:
 * 100/150 → aprovada + `xml_nfe_proc`; 468 (EPEC não sincronizado no
 * destino) keeps `'p'` and backs off; duplicidade recovers via consulta.
 *
 * It CLAIMS the doc first (#1675, `reivindicarEnvio`): the fresh idLote and the
 * send reservation are stamped on it in a transaction that re-reads it, so an
 * operator emit and the backstop sweep can never both transmit it — a refused
 * claim (no longer `'p'`, or a transmission already in progress) is answered
 * with the live doc as `reused`, with no SOAP call. Every outcome write below
 * is owned by that idLote. The `nota` argument is only a pre-read for the
 * early checks; the claimed snapshot is what gets sent.
 */
export async function transmitirPosEpec(args: {
  fs: Firestore;
  rt: NFeRuntime;
  filialId: string;
  pedidoId: string;
  nfeRef: FirebaseFirestore.DocumentReference;
  nota: NotaFiscalEletronica;
}): Promise<EmitResult> {
  const { fs, rt, filialId, pedidoId, nfeRef } = args;
  if (args.nota.estado !== ESTADO_NFE.epecAprovado) {
    throw new NFeOrchestratorError(
      `pedido '${pedidoId}' nfe '${nfeRef.id}': estado='${args.nota.estado}' — ` +
        'transmissão pós-EPEC exige estado epecAprovado.',
    );
  }
  if (!args.nota.chave || !args.nota.xml_assinado) {
    throw new NFeOrchestratorError(
      `pedido '${pedidoId}' nfe '${nfeRef.id}': EPEC aprovado sem chave/xml_assinado ` +
        'persistidos — não é possível transmitir a NF-e completa.',
    );
  }

  // Fresh lote per attempt (the emission invariant), allocated transactionally
  // via the library's contention-hardened counter adapter. A refused claim
  // wastes it, which is harmless: an idLote only has to be unique.
  const idLote = await nextIdLote(nfeConfigStoreFromFirestore(fs), filialId);
  const claim = await reivindicarEnvio(fs, nfeRef, idLote);
  if (!claim.claimed) {
    return existingToEmitResult(pedidoId, nfeRef.id, claim.nota);
  }
  const nota = claim.nota;
  const { chave, xml_assinado: signedXml } = nota;
  // tpEmis=4 authorizes at the HOME SEFAZ (sefaz-call routes 4 → normal).
  const call: SefazCall = sefazCallFor(rt, 4, 'NfeAutorizacao');
  const retEnvi = await autorizarLote(call, {
    idLote: String(idLote),
    NFe: [signedXml],
  });

  // 468 — the home SEFAZ hasn't received the EPEC from the AN yet. Keep
  // estado 'p' (epecAprovado) and let the pendentes poller retry later; the
  // generic outcome machine would mis-map 468 to rejeitada.
  const protCStat = retEnvi.protNFe?.infProt.cStat;
  if (protCStat === CSTAT_EPEC_NAO_SINCRONIZADO) {
    // The non-468 path audit-logs inside applyAutorizadoOutcome — log this
    // round-trip too, or the 468 retries vanish from the EnviNFeMsg history.
    await enviNfeCollection(fs, filialId).add(
      buildEnviNFeMsgFromLote({
        chave,
        idLote,
        tpEmis: 4,
        signedXml,
        retEnvi,
        indSinc: '1',
      }),
    );
    const xMotivo = retEnvi.protNFe?.infProt.xMotivo ?? retEnvi.xMotivo;
    // Owned by this transmission's idLote (#1675); also releases the claim.
    const gravado = await persistPatchUnlessFinal(
      fs,
      nfeRef,
      {
        estado: ESTADO_NFE.epecAprovado,
        cStat: protCStat,
        xMotivo,
        retries: (nota.retries ?? 0) + 1,
        nRec: null,
        action: 'backoff',
        tMed: null,
      },
      undefined,
      { expectedIdLote: String(idLote) },
    );
    if (!gravado.written) return recusaToEmitResult(pedidoId, nfeRef.id, chave, gravado);
    return {
      nfeId: nfeRef.id,
      pedidoId,
      estado: ESTADO_NFE.epecAprovado,
      chave,
      nRec: null,
      cStat: protCStat,
      xMotivo,
      reused: false,
    };
  }

  // Everything else (100/150, rejections, duplicidade recovery, nfeProc
  // assembly + audit log) is the standard emission outcome flow — its writes
  // owned by this transmission's idLote.
  return applyAutorizadoOutcome({
    fs,
    rt,
    bundle: { pedidoId, filialId },
    nfeRef,
    chave,
    signedXml,
    idLote,
    tpEmis: 4,
    retEnvi,
    protNFeForChave: null,
    indSinc: '1',
    // Today's handling, byte for byte: the #1654 §1 no-receipt disposition and
    // recovery table do not apply to the pós-EPEC transmission.
    origem: 'pos-epec',
  });
}
