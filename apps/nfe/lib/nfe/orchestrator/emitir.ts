import type { Firestore } from 'firebase-admin/firestore';

import { nfeConfigCollection, nfev4Collection } from '@delfrance/data/admin/collections';
import {
  applyOutcome,
  autorizarLote,
  buildNFeProc,
  classifyCStat,
  consultarLote,
  consultarSituacaoNFe,
  extractCNFFromChave,
  generateNFe,
  isBloqueada,
  NFeConfigNotFoundError,
  outcomeFromInfProt,
  outcomeFromRetConsSit,
  outcomeFromRetEnviNFe,
  resolveTpEmis,
  signNFe,
  type NFeStatePatch,
  type SefazCall,
  type SefazOutcome,
  type TpEmis,
  type TRetEnviNFe,
} from '@delfrance/integrations-nfe';
import {
  ESTADO_NFE,
  nfeConfigSchema,
  type ContingenciaModo,
  type NFeConfig,
  type NotaFiscalEletronica,
} from '@delfrance/schemas';

import type { NFeBaseRuntime, NFeRuntime } from '../runtime';
import { resolveFilialRuntime } from '../filial-cert';
import {
  NFeBlockedError,
  NFeMissingImpostoError,
  NFeOrchestratorError,
  NFePedidoNotFoundError,
} from './errors';
import {
  createBatchReadContext,
  DEFAULT_NFE_CONFIG_DOC_ID,
  flattenAndValidate,
  loadNfeConfigForEmission,
  loadPedidoBundle,
  nfeDocId,
  preResolveImpostos,
  type BatchReadContext,
  type EmitResult,
  type FiscalItem,
  type PedidoBundle,
} from './bundle';
import { sefazCallFor } from './sefaz-call';
import {
  buildEnviNFeMsgFromConsulta,
  buildEnviNFeMsgFromLote,
  enviNfeCollection,
  existingToEmitResult,
  findLatestEnviNFeMsgWithNRec,
  markAsLost,
  outcomeFromConsReci,
  persistPatch,
  procPersistExtras,
} from './audit';
import { buildGeneratorInput } from './generator-input';
import { enviarEpecParaNota, transmitirPosEpec } from './epec';

/**
 * Result of `prepareEmission` — the inputs `runAllocateGenerateSignTx`
 * needs, with no side effects yet. Single source of truth for the
 * single-pedido orchestrator AND the batch orchestrator.
 */
export interface EmissionPrep {
  readonly bundle: PedidoBundle;
  readonly items: ReadonlyArray<FiscalItem>;
  readonly tpEmis: TpEmis;
  /**
   * Snapshot of the filial's contingency state at prep time. `dhCont` /
   * `xJust` are non-null exactly when `modo !== 'none'` (enforced by the
   * nfeConfig schema's superRefine) and ride into the generated XML
   * (B28/B29) + the persisted nfev4 doc.
   */
  readonly contingencia: {
    readonly modo: ContingenciaModo;
    readonly dhCont: Date | null;
    readonly xJust: string | null;
  };
  readonly nfeRef: FirebaseFirestore.DocumentReference;
  readonly nfeConfigRef: FirebaseFirestore.DocumentReference;
}

export type TxOutcome =
  | { skip: true; existing: NotaFiscalEletronica }
  /**
   * The doc is an approved EPEC awaiting its full transmission — the emit
   * cycle must NOT regenerate/resend (a fresh EPEC would 485-duplicate);
   * it routes into `transmitirPosEpec` instead.
   */
  | { skip: true; epecPending: true; existing: NotaFiscalEletronica }
  | { skip: false; chave: string; signedXml: string; idLote: number };

/**
 * Phase 1 of the emit cycle: load + resolve + validate + compute the
 * stable nfev4 doc id. Pure (no SOAP, no Firestore writes). Throws
 * `NFeBlockedError` when `bloquearEmissaoNFe` is set so the batch path
 * can classify the pedido into the "Não emitidas" bucket cleanly.
 */
export async function prepareEmission(
  fs: Firestore,
  rt: NFeBaseRuntime,
  pedidoId: string,
  ctx?: BatchReadContext,
): Promise<EmissionPrep> {
  const bundle = await loadPedidoBundle(fs, pedidoId, ctx);
  if (bundle.pedido.bloquearEmissaoNFe) {
    throw new NFeBlockedError(pedidoId);
  }
  await preResolveImpostos(bundle, fs, ctx);
  const items = flattenAndValidate(bundle);

  // Contingency mode comes from the filial's NFeConfig — the operator's
  // manual switch. It decides tpEmis BEFORE any allocation, because tpEmis
  // is baked into both the chave and the nfev4 doc id.
  const cfg = await loadNfeConfigForEmission(fs, bundle.filialId, ctx);
  // dhCont/xJust may linger on the config doc after a toggle-off — only a
  // non-'none' modo carries them forward (a tpEmis=1 NF-e with B28/B29 is a
  // generator error by design).
  const contingencia: EmissionPrep['contingencia'] =
    cfg.contingencia_modo === 'none'
      ? { modo: 'none', dhCont: null, xJust: null }
      : {
          modo: cfg.contingencia_modo,
          dhCont:
            cfg.contingencia_dataInicio != null ? new Date(cfg.contingencia_dataInicio) : null,
          xJust: cfg.contingencia_justificativa,
        };

  // Stable doc id per (pedido, tpEmis) — mirrors Flutter's
  // `NotaFiscalEletronica.nFeSaidaIdFromTpEmis(tpEmis)` so every retry
  // for the same pedido targets the same nfev4 doc instead of accreting
  // chave-keyed duplicates. Switching contingency mode targets a NEW doc
  // (`s6` vs `s1`) → fresh numeração, which is exactly the MOC's
  // renumbering rule for normal→contingency reissues.
  const tpEmis = resolveTpEmis(bundle.filial.sede.estado, contingencia.modo);
  const nfeRef = nfev4Collection.docRef(fs, { pedidoId }, nfeDocId(tpEmis));
  const nfeConfigRef = nfeConfigCollection.docRef(
    fs,
    { filialId: bundle.filialId },
    DEFAULT_NFE_CONFIG_DOC_ID,
  );
  return { bundle, items, tpEmis, contingencia, nfeRef, nfeConfigRef };
}

/**
 * Generate + sign one NF-e and assemble its `estado='enviando'` nfev4
 * doc payload. Pure CPU (no Firestore I/O) so it is safe to call inside a
 * transaction. Shared by the single-pedido tx and the batch chunk tx so
 * the persisted doc shape can never diverge between the two paths. The
 * chave is deterministic from nNF + serie + dhEmi + filial CNPJ + tpEmis,
 * so a tx retry with the same inputs regenerates a consistent set.
 *
 * When `cNF` is supplied (rejeitada-retry path), the generator reuses it
 * so the regenerated chave matches the one already persisted on the
 * existing nfev4 doc — required by the SEFAZ retry contract and the
 * anti-loss anchor (`apps/nfe/CLAUDE.md` rule 1).
 */
export function buildNfeDocWrite(
  bundle: PedidoBundle,
  items: ReadonlyArray<FiscalItem>,
  nNF: number,
  serie: number,
  idLote: number,
  rt: NFeRuntime,
  tpEmis: TpEmis,
  cNF?: string,
  contingencia?: EmissionPrep['contingencia'],
): { chave: string; signedXml: string; docData: Record<string, unknown> } {
  const input = buildGeneratorInput(
    bundle,
    items,
    nNF,
    serie,
    rt.ambiente,
    tpEmis,
    cNF,
    contingencia,
  );
  const generated = generateNFe(input);
  const signedXml = signNFe(generated.nfeXml, rt.cert);
  const now = new Date().toISOString();
  return {
    chave: generated.chave,
    signedXml,
    docData: nfev4Collection.parse({
      numeracao: nNF,
      serie,
      tpEmis,
      estado: ESTADO_NFE.enviando,
      filialId: bundle.filialId,
      chave: generated.chave,
      idLote: String(idLote),
      infNFe: null,
      xml_nfe_proc: null,
      xml_epec_proc: null,
      xml_assinado: signedXml,
      nRec: null,
      retries: 0,
      cStat: null,
      xMotivo: null,
      data_emissao: now,
      data_autorizacao: null,
      dataContingencia: contingencia?.dhCont?.toISOString() ?? null,
      justificativaContingencia: contingencia?.xJust ?? null,
      error: null,
      ultima_modificacao: now,
    }),
  };
}

/**
 * Phase 2 of the SINGLE-pedido emit cycle: atomic dedup pre-check +
 * allocate (nNF + idLote) + generate + sign + persist `estado='enviando'`.
 * All counter advances and XML persistence happen in ONE Firestore
 * transaction so a crash mid-flight can never strand a consumed numeração
 * without a matching nfev4 doc. The SEFAZ SOAP call happens AFTER the tx
 * commits. The batch path uses `runChunkAllocateGenerateSignTx` instead.
 */
export async function runAllocateGenerateSignTx(
  fs: Firestore,
  rt: NFeRuntime,
  prep: EmissionPrep,
): Promise<TxOutcome> {
  const { bundle, items, tpEmis, nfeRef, nfeConfigRef } = prep;
  const pedidoId = bundle.pedidoId;
  return fs.runTransaction<TxOutcome>(async (tx) => {
    // Reads MUST precede writes in a Firestore transaction.
    const nfeSnap = await tx.get(nfeRef);
    const existing = nfeSnap.exists ? (nfeSnap.data() as NotaFiscalEletronica) : null;

    // EPEC-approved docs (estado 'p') are checked BEFORE isBloqueada — their
    // event cStat (135/136) is not in STATUS_BLOQUEADORES, so they'd
    // otherwise fall into the reuse branch and re-send a duplicate EPEC.
    // The emit cycle routes them into the pós-EPEC full transmission.
    if (existing?.estado === ESTADO_NFE.epecAprovado) {
      return { skip: true, epecPending: true, existing };
    }

    // Bloqueada NFes (cStat in STATUS_BLOQUEADORES) short-circuit —
    // covers both the normal pre-check AND the race where another emit
    // wrote the doc between attempts of this transaction.
    if (existing && isBloqueada(existing.cStat)) {
      console.debug(
        `[nfe/orchestrator] pedido '${pedidoId}' has existing bloqueada NFe ` +
          `(cStat=${existing.cStat}) — skipping emit and returning persisted state`,
      );
      return { skip: true, existing };
    }

    console.debug(
      `[nfe/orchestrator] No bloqueada NFe found for pedidoId '${pedidoId}' — proceeding with emit. ` +
        `Existing NFe doc ${existing ? 'is not bloqueada (cStat=' + existing.cStat + ')' : 'does not exist'}.`,
    );

    const cfgSnap = await tx.get(nfeConfigRef);
    if (!cfgSnap.exists) throw new NFeConfigNotFoundError(bundle.filialId);
    const cfg = nfeConfigSchema.parse(cfgSnap.data()) as NFeConfig;

    // Reuse numeração + serie when an existing rejeitada / error /
    // never-sent doc is present; allocate fresh otherwise. idLote
    // always advances — every retry is a fresh SEFAZ lote.
    //
    // Also reuse the existing `cNF` when the prior doc has a chave
    // (anything past the placeholder stage), so the regenerated chave
    // matches what was already persisted. A placeholder doc has
    // `chave: null` and falls back to a fresh random cNF.
    const reuse = existing != null;
    const nNF = reuse ? existing.numeracao : cfg.numeracao_atual + 1;
    const serie = reuse ? existing.serie : cfg.serie;
    const reuseCNF = reuse && existing.chave ? extractCNFFromChave(existing.chave) : undefined;
    const idLote = cfg.idLote + 1;

    const { chave, signedXml, docData } = buildNfeDocWrite(
      bundle,
      items,
      nNF,
      serie,
      idLote,
      rt,
      tpEmis,
      reuseCNF,
      prep.contingencia,
    );

    // Writes — counter doc first, then NFe doc. Both commit or neither.
    tx.set(
      nfeConfigRef,
      nfeConfigCollection.parse({
        ...cfg,
        ...(reuse ? {} : { numeracao_atual: nNF }),
        idLote,
        timestamp: new Date().toISOString(),
      }),
    );
    tx.set(nfeRef, docData);

    return { skip: false, chave, signedXml, idLote };
  });
}

/** One classified pedido from the chunk allocation transaction. */
export type ChunkMember =
  | { skip: true; pedidoId: string; prep: EmissionPrep; existing: NotaFiscalEletronica }
  | {
      skip: false;
      pedidoId: string;
      prep: EmissionPrep;
      nNF: number;
      serie: number;
      /**
       * The chave already persisted on a reuse pedido's existing nfev4
       * doc, when present. The downstream sign step extracts the `cNF`
       * from it so the regenerated chave matches. `null` for freshly
       * allocated pedidos and for reuse pedidos whose existing doc is a
       * crashed `enviando` placeholder (`chave: null`).
       */
      existingChave: string | null;
    };

/**
 * Minimal `estado='enviando'` nfev4 doc written for a FRESH pedido inside
 * the allocation transaction — it anchors the consumed numeração so a
 * crash can never strand an `nNF` without a matching doc (anti-loss). The
 * chave + signed XML land in a second write once the NF-e is generated +
 * signed outside the tx; both are `.nullable()` in the schema, so this
 * placeholder is valid on its own.
 */
export function buildPlaceholderNfeDoc(
  nNF: number,
  serie: number,
  idLote: number,
  tpEmis: TpEmis,
  filialId: string,
  contingencia?: EmissionPrep['contingencia'],
): Record<string, unknown> {
  const now = new Date().toISOString();
  return nfev4Collection.parse({
    numeracao: nNF,
    serie,
    tpEmis,
    estado: ESTADO_NFE.enviando,
    filialId,
    chave: null,
    idLote: String(idLote),
    infNFe: null,
    xml_nfe_proc: null,
    xml_epec_proc: null,
    xml_assinado: null,
    nRec: null,
    retries: 0,
    cStat: null,
    xMotivo: null,
    data_emissao: now,
    data_autorizacao: null,
    dataContingencia: contingencia?.dhCont?.toISOString() ?? null,
    justificativaContingencia: contingencia?.xJust ?? null,
    error: null,
    ultima_modificacao: now,
  });
}

/**
 * Batch allocation for an entire (filial, ≤20-pedido) chunk in ONE
 * Firestore transaction — **allocation only** (no generate/sign; those run
 * per-pedido OUTSIDE the tx so one pedido's failure can't sink the chunk,
 * and no RSA work lengthens the tx). Mirrors the Flutter batch flow
 * (`.old/packages/pedido_nfe/lib/src/tasks.dart:255-285`):
 *
 *   1. read `NFeConfig` once + every pedido's nfev4 doc;
 *   2. classify — bloqueada → skip (jaAprovadas bucket); existing
 *      non-bloqueada doc → reuse its numeração; absent → fresh;
 *   3. bulk-allocate contiguous `nNF` for **exactly the fresh count** (the
 *      `proxima_numeracao_batch_transaction` technique) — skip/reuse burn
 *      no slot, so no `inutNFe` gap;
 *   4. advance the counter once and write a placeholder doc per FRESH
 *      pedido (anti-loss anchor). Reuse pedidos keep their existing doc
 *      until the out-of-tx step overwrites it with the regenerated NF-e.
 *
 * A chunk-level throw (missing/invalid NFeConfig) propagates to the
 * caller, which cascades it to every pedido. Per-pedido generate/sign
 * failures are handled by the caller, not here.
 */
export async function runChunkAllocateTx(
  fs: Firestore,
  filialId: string,
  group: ReadonlyArray<{ prep: EmissionPrep; pedidoId: string }>,
): Promise<{ members: ChunkMember[]; idLote: number }> {
  const nfeConfigRef = nfeConfigCollection.docRef(fs, { filialId }, DEFAULT_NFE_CONFIG_DOC_ID);
  return fs.runTransaction(async (tx) => {
    // Reads first (Firestore rule): config once + every nfev4 doc.
    const cfgSnap = await tx.get(nfeConfigRef);
    if (!cfgSnap.exists) throw new NFeConfigNotFoundError(filialId);
    const cfg = nfeConfigSchema.parse(cfgSnap.data()) as NFeConfig;
    const existingSnaps = await Promise.all(group.map((sp) => tx.get(sp.prep.nfeRef)));

    const idLote = cfg.idLote + 1;
    const members: ChunkMember[] = [];
    const placeholders: Array<{
      ref: FirebaseFirestore.DocumentReference;
      data: Record<string, unknown>;
    }> = [];
    // Fresh pedidos take contiguous nNFs off `numeracao_atual`; skip/reuse
    // pedidos consume none (Flutter `pedidosSemNota` parity).
    let freshCount = 0;

    for (let i = 0; i < group.length; i++) {
      const sp = group[i]!;
      const snap = existingSnaps[i]!;
      const existing = snap.exists ? (snap.data() as NotaFiscalEletronica) : null;

      // Approved EPECs never re-ride a lote — the batch reports the persisted
      // state; the pendentes poller (or a single-pedido emit) transmits them.
      if (existing?.estado === ESTADO_NFE.epecAprovado) {
        members.push({ skip: true, pedidoId: sp.pedidoId, prep: sp.prep, existing });
        continue;
      }
      if (existing && isBloqueada(existing.cStat)) {
        members.push({ skip: true, pedidoId: sp.pedidoId, prep: sp.prep, existing });
        continue;
      }

      const reuse = existing != null;
      const nNF = reuse ? existing.numeracao : cfg.numeracao_atual + 1 + freshCount;
      const serie = reuse ? existing.serie : cfg.serie;
      const existingChave = reuse ? existing.chave : null;
      if (!reuse) {
        freshCount += 1;
        // Anchor the consumed numeração now; the generated + signed NF-e
        // overwrites this placeholder outside the tx.
        placeholders.push({
          ref: sp.prep.nfeRef,
          data: buildPlaceholderNfeDoc(
            nNF,
            serie,
            idLote,
            sp.prep.tpEmis,
            sp.prep.bundle.filialId,
            sp.prep.contingencia,
          ),
        });
      }
      members.push({
        skip: false,
        pedidoId: sp.pedidoId,
        prep: sp.prep,
        nNF,
        serie,
        existingChave,
      });
    }

    // Writes: advance the counter once for the whole chunk, then anchor
    // each fresh pedido. Reuse pedidos keep their numeração, so only the
    // fresh count advances `numeracao_atual`.
    tx.set(
      nfeConfigRef,
      nfeConfigCollection.parse({
        ...cfg,
        numeracao_atual: cfg.numeracao_atual + freshCount,
        idLote,
        timestamp: new Date().toISOString(),
      }),
    );
    for (const p of placeholders) tx.set(p.ref, p.data);

    return { members, idLote };
  });
}

/**
 * Phase 3 of the emit cycle: audit-log + outcome + recovery branches +
 * `<nfeProc>` build + persist. Per-chave; the batch path calls this
 * once per pedido after polling `consultarLote` for the lote's
 * `protNFe[]`.
 *
 * `protNFeForChave` is the chave-specific protocol when the caller
 * already has it (batch path — extracted from `consultarLote.protNFe[]`).
 * Single-pedido path passes `null` and the helper derives the outcome
 * from `retEnvi.protNFe` (the sync response).
 */
export async function applyAutorizadoOutcome(args: {
  fs: Firestore;
  rt: NFeRuntime;
  /** Only ids are needed — the pós-EPEC transmit calls in without a full bundle. */
  bundle: Pick<PedidoBundle, 'pedidoId' | 'filialId'>;
  nfeRef: FirebaseFirestore.DocumentReference;
  chave: string;
  signedXml: string;
  idLote: number;
  tpEmis: TpEmis;
  retEnvi: Awaited<ReturnType<typeof autorizarLote>>;
  /** Pre-stringified `retEnvi`, cached once per chunk by the batch path. */
  retEnviJson?: string;
  protNFeForChave: NonNullable<Awaited<ReturnType<typeof autorizarLote>>['protNFe']> | null;
  /** `'1'` (sync, single NFe) or `'0'` (async, batch). */
  indSinc: '0' | '1';
}): Promise<EmitResult> {
  const { fs, rt, bundle, nfeRef, chave, signedXml, idLote, tpEmis, retEnvi, indSinc } = args;

  // Audit-log the SOAP round-trip BEFORE running the state machine — so
  // nRec is durable even if anything below this line crashes.
  await enviNfeCollection(fs, bundle.filialId).add(
    buildEnviNFeMsgFromLote({
      chave,
      idLote,
      tpEmis,
      signedXml,
      retEnvi,
      retEnviJson: args.retEnviJson,
      indSinc,
    }),
  );

  // Derive the initial outcome — from the chave-specific protocol when
  // the batch caller supplied one, otherwise from the lote-level
  // retEnvi (the sync single-NFe path).
  let outcome: SefazOutcome = args.protNFeForChave
    ? outcomeFromInfProt(args.protNFeForChave.infProt)
    : outcomeFromRetEnviNFe(retEnvi);
  let patch = applyOutcome({ estado: ESTADO_NFE.enviando, retries: 0 }, outcome);
  // The chave that ends up on the result (and on the nfev4 doc) may
  // change during a cStat=539 recovery: the "real" NF-e at SEFAZ lives
  // under a different chave (the one in xMotivo's [chNFe:...] marker).
  let finalChave = chave;
  // Capture the authoritative SEFAZ protocol object for our chave —
  // populated for the happy path and re-assigned for each recovery
  // branch that surfaces one. Used at the end to build `<nfeProc>`.
  // Left as `null` for 539 (chave swap) since our local signedXml
  // doesn't match the recovered protocol's chNFe.
  let protNFeRaw: typeof retEnvi.protNFe | null = args.protNFeForChave ?? retEnvi.protNFe ?? null;

  // Duplicidade / lote-not-found → query SEFAZ for the real status.
  if (patch.action === 'recover-via-consulta') {
    if (outcome.cStat === '539') {
      const recovered = await recoverFrom539({
        fs,
        bundle,
        nfeRef,
        rt,
        tpEmis,
        outcome,
        patch,
      });
      patch = recovered.patch;
      if (recovered.chaveOverride) finalChave = recovered.chaveOverride;
      protNFeRaw = null;
    } else if (patch.nRec) {
      const consReciCall: SefazCall = sefazCallFor(rt, tpEmis, 'NfeRetAutorizacao');
      const retRec = await consultarLote(consReciCall, { nRec: patch.nRec });
      await enviNfeCollection(fs, bundle.filialId).add(
        buildEnviNFeMsgFromConsulta({ chave, nRec: patch.nRec, ret: retRec, tpEmis }),
      );
      protNFeRaw = retRec.protNFe?.find((p) => p.infProt.chNFe === chave) ?? null;
      outcome = outcomeFromConsReci(retRec, chave);
      patch = applyOutcome({ estado: patch.estado, retries: patch.retries }, outcome);
    } else {
      const consSitCall: SefazCall = sefazCallFor(rt, tpEmis, 'NfeConsultaProtocolo');
      const retSit = await consultarSituacaoNFe(consSitCall, { chave });
      await enviNfeCollection(fs, bundle.filialId).add(
        buildEnviNFeMsgFromConsulta({ chave, nRec: null, ret: retSit, tpEmis }),
      );
      protNFeRaw = retSit.protNFe ?? null;
      outcome = outcomeFromRetConsSit(retSit);
      patch = applyOutcome({ estado: patch.estado, retries: patch.retries }, outcome);
    }
  }

  // Build the `<nfeProc>` envelope when SEFAZ authorized the NF-e and
  // we still have the matching local signedXml (no chave swap). This
  // is the canonical form for DANFE rendering and fiscal archives.
  const nfeProcXml =
    classifyCStat(patch.cStat) === 'autorizada' && protNFeRaw != null && finalChave === chave
      ? buildNFeProc(signedXml, protNFeRaw)
      : null;

  await persistPatch(nfeRef, patch, nfeProcXml != null ? procPersistExtras(nfeProcXml) : undefined);

  return {
    nfeId: nfeRef.id,
    pedidoId: bundle.pedidoId,
    estado: patch.estado,
    chave: finalChave,
    nRec: patch.nRec,
    cStat: patch.cStat,
    xMotivo: patch.xMotivo,
    reused: false,
  };
}

/**
 * The full emit cycle for a single pedido. Persists `estado='enviando'`
 * BEFORE the SOAP send; applies `applyOutcome` after; runs an inline
 * `consultarSituacaoNFe` if the state machine asks for
 * `recover-via-consulta`.
 *
 * Composition of the three phase helpers (`prepareEmission`,
 * `runAllocateGenerateSignTx`, `applyAutorizadoOutcome`) — `emitirPedidosLote`
 * uses the same three helpers with one shared `idLote` per chunk.
 */
export async function emitirPedido(
  fs: Firestore,
  baseRt: NFeBaseRuntime,
  pedidoId: string,
): Promise<EmitResult> {
  console.debug(
    `[nfe/orchestrator] Starting emit cycle for pedidoId '${pedidoId}', runtime ambiente '${baseRt.ambiente}'`,
  );

  const prep = await prepareEmission(fs, baseRt, pedidoId);
  // Per-filial cert: sign + transmit with the filial's own A1 (or the env
  // fallback). `prepareEmission` is cert-free, so deriving here — once the
  // bundle reveals filialId — binds the rest of the cycle to the right cert.
  const rt = await resolveFilialRuntime(fs, baseRt, prep.bundle.filialId);
  const captured = await runAllocateGenerateSignTx(fs, rt, prep);

  if (captured.skip) {
    if ('epecPending' in captured) {
      // Approved EPEC — the emit action becomes "transmit the full NF-e to
      // the home SEFAZ" (same chave, stored xml_assinado).
      console.debug(
        `[nfe/orchestrator] pedido '${pedidoId}' has an approved EPEC — ` +
          'routing into the pós-EPEC full transmission',
      );
      return transmitirPosEpec({
        fs,
        rt,
        filialId: prep.bundle.filialId,
        pedidoId,
        nfeRef: prep.nfeRef,
        nota: captured.existing,
      });
    }
    console.debug(
      `[nfe/orchestrator] pedido '${pedidoId}' has existing bloqueada NFe ` +
        `(cStat=${captured.existing.cStat}) — returning persisted state without re-emission`,
    );
    return existingToEmitResult(pedidoId, prep.nfeRef.id, captured.existing);
  }

  const { chave, signedXml, idLote } = captured;

  // EPEC mode: the NF-e is persisted (anti-loss anchor) but NOT sent to the
  // (down) home SEFAZ — the EPEC summary evento goes to the Ambiente
  // Nacional instead. The full NF-e is transmitted post-outage.
  if (prep.contingencia.modo === 'epec') {
    return enviarEpecParaNota({
      fs,
      rt,
      filialId: prep.bundle.filialId,
      pedidoId,
      nfeRef: prep.nfeRef,
      chave,
      signedXml,
    });
  }

  const call: SefazCall = sefazCallFor(rt, prep.tpEmis, 'NfeAutorizacao');

  const retEnvi = await autorizarLote(call, {
    idLote: String(idLote),
    NFe: [signedXml],
  });
  console.debug(
    `[nfe/orchestrator] autorizarLote cStat=${retEnvi.cStat} nRec=${retEnvi.infRec?.nRec ?? '-'}`,
  );

  return applyAutorizadoOutcome({
    fs,
    rt,
    bundle: prep.bundle,
    nfeRef: prep.nfeRef,
    chave,
    signedXml,
    idLote,
    tpEmis: prep.tpEmis,
    retEnvi,
    protNFeForChave: null,
    indSinc: '1',
  });
}

// ---------------------------------------------------------------------------
// Batch emission — emitirPedidosLote
// ---------------------------------------------------------------------------

/** SEFAZ MOC 7.0 caps a single batch at 50 NF-es. We enforce this at request entry. */
export const MAX_PEDIDOS_PER_BATCH = 50;
/**
 * SEFAZ accepts up to 50 per lote, but Flutter's `gerarNFePedidos`
 * (`.old/packages/pedido_nfe/lib/src/tasks.dart:633`) chunks at 20 per
 * lote for connection reliability + message-size headroom. We mirror
 * that battle-tested limit.
 */
export const MAX_PEDIDOS_PER_CHUNK = 20;
export const POLL_MAX_ATTEMPTS = 12;
export const POLL_INITIAL_DELAY_MS = 1000;
export const POLL_MAX_DELAY_MS = 8000;

/** Per-pedido failure inside a batch. Distinct shape from EmitResult so callers can branch. */
export interface EmitError {
  readonly pedidoId: string;
  /** Class name of the error (JSON-safe — `NFeBlockedError`, `NFePedidoNotFoundError`, ...). */
  readonly errorCode: string;
  readonly errorMessage: string;
}

export interface BatchEmitResult {
  readonly results: ReadonlyArray<EmitResult | EmitError>;
}

/**
 * Batch emit cycle. Mirrors `emitirPedido` but fans out across one
 * shared idLote per (filial, ≤20-pedido) chunk. Per-pedido failures
 * surface as `EmitError` entries in the result array — the request
 * never throws unless an upstream invariant fails (empty input, >50
 * total pedidos, runtime boot).
 *
 * Mirror of Flutter's `gerarNFePedidos` at
 * `.old/packages/pedido_nfe/lib/src/tasks.dart:59`: group by filial,
 * sub-chunk at 20, allocate one idLote per chunk, call autorizarLote
 * once per chunk, poll consultarLote for async chunks, apply per-chave
 * outcome.
 */
export async function emitirPedidosLote(
  fs: Firestore,
  rt: NFeBaseRuntime,
  pedidoIds: ReadonlyArray<string>,
): Promise<BatchEmitResult> {
  if (pedidoIds.length === 0) {
    throw new NFeOrchestratorError('emitirPedidosLote: pedidoIds is empty');
  }
  if (pedidoIds.length > MAX_PEDIDOS_PER_BATCH) {
    throw new NFeOrchestratorError(
      `emitirPedidosLote: ${pedidoIds.length} pedidos exceeds MAX_PEDIDOS_PER_BATCH (${MAX_PEDIDOS_PER_BATCH})`,
    );
  }
  console.debug(
    `[nfe/orchestrator] Batch emit starting — ${pedidoIds.length} pedido(s), ambiente '${rt.ambiente}'`,
  );

  // 1. Prepare every pedido in parallel. prepareEmission failures
  //    (NFeBlockedError, NFePedidoNotFoundError, NFeMissingImpostoError,
  //    NFeOrchestratorError) become per-pedido EmitError entries — the
  //    pedido never reaches a lote.
  // One read context for the whole batch — dedups the shared filial /
  // operação / regraimposto reads and shares one imposto resolver per
  // operacaoId across all pedidos (PR-δ).
  const ctx = createBatchReadContext();
  const preps = await Promise.allSettled(pedidoIds.map((id) => prepareEmission(fs, rt, id, ctx)));
  const results: Array<EmitResult | EmitError> = [];
  const successPreps: Array<{ prep: EmissionPrep; pedidoId: string }> = [];
  preps.forEach((p, i) => {
    const pedidoId = pedidoIds[i]!;
    if (p.status === 'rejected') {
      results.push(toEmitError(pedidoId, p.reason));
    } else {
      successPreps.push({ prep: p.value, pedidoId });
    }
  });
  if (successPreps.length === 0) return { results };

  // 2. Group by filialId — each filial has its own NFeConfig + idLote
  //    counter. Mirrors the Flutter outer loop at tasks.dart:134.
  const groups = new Map<string, Array<{ prep: EmissionPrep; pedidoId: string }>>();
  for (const sp of successPreps) {
    const filialId = sp.prep.bundle.filialId;
    const arr = groups.get(filialId) ?? [];
    arr.push(sp);
    groups.set(filialId, arr);
  }

  // 3. Sub-chunk each filial group into runs of ≤20 (Flutter parity).
  const chunks: Array<{
    filialId: string;
    group: Array<{ prep: EmissionPrep; pedidoId: string }>;
  }> = [];
  for (const [filialId, group] of groups) {
    for (let i = 0; i < group.length; i += MAX_PEDIDOS_PER_CHUNK) {
      chunks.push({
        filialId,
        group: group.slice(i, i + MAX_PEDIDOS_PER_CHUNK),
      });
    }
  }
  console.debug(
    `[nfe/orchestrator] Batch fan-out: ${groups.size} filial(is) × ${chunks.length} chunk(s)`,
  );

  // 4. Process each chunk in parallel. Chunk-level failures (e.g.
  //    NFeConfig missing) cascade to every pedido in that chunk.
  const chunkResults = await Promise.allSettled(
    chunks.map((c) => processChunk(fs, rt, c.filialId, c.group)),
  );
  chunkResults.forEach((cr, i) => {
    const chunk = chunks[i]!;
    if (cr.status === 'rejected') {
      for (const sp of chunk.group) {
        results.push(toEmitError(sp.pedidoId, cr.reason));
      }
    } else {
      for (const r of cr.value) results.push(r);
    }
  });
  return { results };
}

/**
 * Process one (filial, ≤20-pedido) chunk: bulk-allocate numeração for the
 * chunk in one transaction, then generate + sign + persist each NF-e
 * per-pedido OUTSIDE the tx (isolated failures), call autorizarLote once
 * for the chunk, poll for async lotes, apply per-chave outcome.
 */
export async function processChunk(
  fs: Firestore,
  baseRt: NFeBaseRuntime,
  filialId: string,
  group: ReadonlyArray<{ prep: EmissionPrep; pedidoId: string }>,
): Promise<Array<EmitResult | EmitError>> {
  // The chunk is single-filial — resolve its A1 cert (or env fallback) once
  // and bind signing + every SOAP send below to it.
  const rt = await resolveFilialRuntime(fs, baseRt, filialId);
  // 4a. Allocate idLote + bulk-allocate nNF (fresh count only) and anchor
  //     each fresh pedido's numeração in ONE transaction (Flutter parity:
  //     .old/packages/pedido_nfe/lib/src/tasks.dart:255-285). A chunk-level
  //     throw cascades to every pedido via emitirPedidosLote's allSettled.
  const { members, idLote: sharedIdLote } = await runChunkAllocateTx(fs, filialId, group);
  const txResults: Array<EmitResult | EmitError> = [];
  const fresh: Array<{
    prep: EmissionPrep;
    pedidoId: string;
    nNF: number;
    serie: number;
    existingChave: string | null;
  }> = [];
  for (const m of members) {
    if (m.skip) {
      // Mirrors Flutter's `jaAprovadas` short-circuit (tasks.dart:159) —
      // a bloqueada/aprovada/cancelada nfev4 lands in the "Não emitidas"
      // bucket instead of riding the lote.
      txResults.push(existingToEmitResult(m.pedidoId, m.prep.nfeRef.id, m.existing));
    } else {
      fresh.push({
        prep: m.prep,
        pedidoId: m.pedidoId,
        nNF: m.nNF,
        serie: m.serie,
        existingChave: m.existingChave,
      });
    }
  }

  // 4b. Generate + sign + persist each NF-e OUTSIDE the allocation tx, per
  //     pedido. A generate/sign failure (e.g. a raw fiscal-field overflow)
  //     fails ONLY that pedido — its placeholder doc keeps the numeração
  //     for recovery (inutilização or fix + re-emit) — while the rest
  //     proceed. The chave + signed XML are persisted (full doc overwrite)
  //     BEFORE autorizarLote, so the anti-loss anchor is complete before
  //     any SOAP send. Signing here (not in the tx) keeps RSA work out of
  //     the transaction.
  const toSend: Array<{
    prep: EmissionPrep;
    pedidoId: string;
    chave: string;
    signedXml: string;
  }> = [];
  const signed = await Promise.allSettled(
    fresh.map(async (f) => {
      const reuseCNF = f.existingChave ? extractCNFFromChave(f.existingChave) : undefined;
      const { chave, signedXml, docData } = buildNfeDocWrite(
        f.prep.bundle,
        f.prep.items,
        f.nNF,
        f.serie,
        sharedIdLote,
        rt,
        f.prep.tpEmis,
        reuseCNF,
        f.prep.contingencia,
      );
      await f.prep.nfeRef.set(docData);
      return { prep: f.prep, pedidoId: f.pedidoId, chave, signedXml };
    }),
  );
  signed.forEach((s, i) => {
    if (s.status === 'rejected') {
      txResults.push(toEmitError(fresh[i]!.pedidoId, s.reason));
    } else {
      toSend.push(s.value);
    }
  });
  if (toSend.length === 0) return txResults;

  // EPEC mode: no lote — each NF-e gets its own EPEC evento at the Ambiente
  // Nacional (one evento per envEvento in v1). Failures stay per-pedido.
  if (toSend[0]!.prep.contingencia.modo === 'epec') {
    const epecs = await Promise.allSettled(
      toSend.map((s) =>
        enviarEpecParaNota({
          fs,
          rt,
          filialId: s.prep.bundle.filialId,
          pedidoId: s.pedidoId,
          nfeRef: s.prep.nfeRef,
          chave: s.chave,
          signedXml: s.signedXml,
        }),
      ),
    );
    epecs.forEach((e, i) => {
      if (e.status === 'rejected') {
        txResults.push(toEmitError(toSend[i]!.pedidoId, e.reason));
      } else {
        txResults.push(e.value);
      }
    });
    return txResults;
  }

  // 4c. autorizarLote — one SOAP call for the whole chunk. indSinc='1'
  //     when only one NFe survived prep+tx; '0' otherwise. The chunk shares
  //     one filial → one NFeConfig → one tpEmis, so the first member's
  //     tpEmis routes the whole lote.
  const chunkTpEmis = toSend[0]!.prep.tpEmis;
  const call: SefazCall = sefazCallFor(rt, chunkTpEmis, 'NfeAutorizacao');
  const indSinc: '0' | '1' = toSend.length === 1 ? '1' : '0';
  const retEnvi = await autorizarLote(call, {
    idLote: String(sharedIdLote),
    NFe: toSend.map((s) => s.signedXml),
    indSinc,
  });
  console.debug(
    `[nfe/orchestrator] Batch chunk autorizarLote — filial=${filialId} ` +
      `idLote=${sharedIdLote} count=${toSend.length} indSinc=${indSinc} ` +
      `retCStat=${retEnvi.cStat}`,
  );

  // 4d. For async chunks, poll consultarLote until cStat=104 (lote
  //     processado) or the budget runs out.
  let protNFeArr: NonNullable<TRetEnviNFe['protNFe']>[] = [];
  if (indSinc === '0') {
    const nRec = retEnvi.infRec?.nRec ?? null;
    if (!nRec) {
      // SEFAZ accepted but didn't give us nRec — exceptional but
      // defended. Each pedido stays in aguardandoResposta; the
      // processar-pendentes cron has nothing to look up, so the
      // operator handles via consSit(chave).
      for (const s of toSend) {
        txResults.push({
          nfeId: s.prep.nfeRef.id,
          pedidoId: s.pedidoId,
          estado: ESTADO_NFE.aguardandoResposta,
          chave: s.chave,
          nRec: null,
          cStat: retEnvi.cStat,
          xMotivo: retEnvi.xMotivo,
          reused: false,
        });
      }
      return txResults;
    }
    protNFeArr = await pollConsultarLote(rt, chunkTpEmis, nRec);
    if (protNFeArr.length === 0) {
      // Timed out without resolution. Persist nRec on each nfev4 so
      // the cron at apps/nfe/app/api/nfe/processar-pendentes can
      // drain it later, then return aguardandoResposta entries.
      await Promise.all(
        toSend.map((s) =>
          persistPatch(s.prep.nfeRef, {
            estado: ESTADO_NFE.aguardandoResposta,
            retries: 0,
            nRec,
            cStat: '105',
            xMotivo: 'Lote em processamento — handed off to processar-pendentes',
            action: 'backoff',
          }),
        ),
      );
      for (const s of toSend) {
        txResults.push({
          nfeId: s.prep.nfeRef.id,
          pedidoId: s.pedidoId,
          estado: ESTADO_NFE.aguardandoResposta,
          chave: s.chave,
          nRec,
          cStat: '105',
          xMotivo: 'Lote em processamento — handed off to processar-pendentes',
          reused: false,
        });
      }
      return txResults;
    }
  } else {
    // Sync (single-NFe) chunk — retEnvi.protNFe is the singular protocol.
    if (retEnvi.protNFe) protNFeArr = [retEnvi.protNFe];
  }

  // 4e. Apply outcome per chave. Index protNFe by chave once (was an
  //     O(N) array scan per pedido → O(N²) across the chunk) and cache
  //     the retEnvi JSON once (buildEnviNFeMsgFromLote would otherwise
  //     re-stringify the same lote response once per chave) — PR-δ.
  const protByChave = new Map<string, (typeof protNFeArr)[number]>();
  for (const p of protNFeArr) protByChave.set(p.infProt.chNFe, p);
  const retEnviJson = JSON.stringify(retEnvi);
  const outcomes = await Promise.allSettled(
    toSend.map(async (s) => {
      const proto = protByChave.get(s.chave) ?? null;
      return applyAutorizadoOutcome({
        fs,
        rt,
        bundle: s.prep.bundle,
        nfeRef: s.prep.nfeRef,
        chave: s.chave,
        signedXml: s.signedXml,
        idLote: sharedIdLote,
        tpEmis: s.prep.tpEmis,
        retEnvi,
        retEnviJson,
        protNFeForChave: proto,
        indSinc,
      });
    }),
  );
  outcomes.forEach((o, i) => {
    const s = toSend[i]!;
    if (o.status === 'rejected') {
      txResults.push(toEmitError(s.pedidoId, o.reason));
    } else {
      txResults.push(o.value);
    }
  });
  return txResults;
}

/**
 * Poll `consultarLote(nRec)` until cStat=104 (lote processado) or the
 * budget runs out. Returns the `protNFe[]` on success; empty array on
 * timeout (caller persists nRec and hands off to the cron).
 */
export async function pollConsultarLote(
  rt: NFeRuntime,
  tpEmis: TpEmis,
  nRec: string,
): Promise<NonNullable<TRetEnviNFe['protNFe']>[]> {
  const consReciCall: SefazCall = sefazCallFor(rt, tpEmis, 'NfeRetAutorizacao');
  let delay = POLL_INITIAL_DELAY_MS;
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, POLL_MAX_DELAY_MS);
    }
    const retRec = await consultarLote(consReciCall, { nRec });
    console.debug(
      `[nfe/orchestrator] pollConsultarLote nRec=${nRec} attempt=${attempt} ` +
        `cStat=${retRec.cStat} protNFe=${retRec.protNFe?.length ?? 0}`,
    );
    if (retRec.cStat === '104' && retRec.protNFe && retRec.protNFe.length > 0) {
      return retRec.protNFe;
    }
    if (retRec.cStat !== '105') {
      // 4xx / 5xx / unexpected — bail out. The caller's per-chave
      // recovery branch handles non-104/105 outcomes via consSit.
      return [];
    }
  }
  return []; // budget exhausted
}

/**
 * Narrow an unknown exception into a JSON-safe EmitError. Non-Error
 * throwables are re-raised (CLAUDE.md rule 6 — don't swallow what we
 * can't classify).
 */
export function toEmitError(pedidoId: string, reason: unknown): EmitError {
  if (reason instanceof NFeBlockedError) {
    return { pedidoId, errorCode: 'NFeBlockedError', errorMessage: reason.message };
  }
  if (reason instanceof NFePedidoNotFoundError) {
    return { pedidoId, errorCode: 'NFePedidoNotFoundError', errorMessage: reason.message };
  }
  if (reason instanceof NFeMissingImpostoError) {
    return { pedidoId, errorCode: 'NFeMissingImpostoError', errorMessage: reason.message };
  }
  if (reason instanceof NFeOrchestratorError) {
    return { pedidoId, errorCode: 'NFeOrchestratorError', errorMessage: reason.message };
  }
  if (reason instanceof NFeConfigNotFoundError) {
    return { pedidoId, errorCode: 'NFeConfigNotFoundError', errorMessage: reason.message };
  }
  if (reason instanceof Error) {
    return { pedidoId, errorCode: reason.name, errorMessage: reason.message };
  }
  throw reason;
}

/**
 * Handle a cStat=539 outcome: SEFAZ already has an NF-e with our
 * `nNF + serie + tpEmis + emit-CNPJ` but under a DIFFERENT chave (the
 * `[chNFe:...]` marker in xMotivo). Recovery strategy:
 *   1. Pull the previously-emitted chave from xMotivo markers.
 *   2. Look it up in our `EnviNFeMsg` audit log (the SEFAZ-roundtrip
 *      log written on every lote send / consult).
 *   3. If found, the previous lote's `nRec` is also in the audit log
 *      msg — call `consultarLote(prevNRec)` to fetch SEFAZ's
 *      authoritative protocol for that chave, swap the nfev4 doc's
 *      `chave` to the recovered one, and return the consult outcome.
 *   4. If not found (or no chNFe marker), the note is "lost" from our
 *      side — return a patch marking estado=error with the original
 *      cStat=539 + xMotivo preserved so the operator can fix manually
 *      (download from SEFAZ portal + upload).
 *
 * NB: this does NOT touch `xml_assinado` — it still holds the locally
 * signed XML for OUR chave. After a successful 539 recovery the doc
 * has a mismatch (recovered chave + local signed XML for the old
 * chave); the next step in production is to fetch the authorized XML
 * from SEFAZ DistDFe (a Phase D port).
 */
export async function recoverFrom539(params: {
  fs: Firestore;
  bundle: Pick<PedidoBundle, 'pedidoId' | 'filialId'>;
  nfeRef: FirebaseFirestore.DocumentReference;
  rt: NFeRuntime;
  tpEmis: TpEmis;
  outcome: SefazOutcome;
  patch: NFeStatePatch;
}): Promise<{ patch: NFeStatePatch; chaveOverride?: string }> {
  const { fs, bundle, nfeRef, rt, tpEmis, outcome, patch } = params;

  const recoveredChave = outcome.chNFeFromXMotivo;
  if (!recoveredChave) {
    console.warn(
      `[nfe/orchestrator] pedido '${bundle.pedidoId}': cStat=539 sem ` +
        `marcador [chNFe:...] em xMotivo — marcando como error.`,
    );
    return { patch: markAsLost(patch, 'cStat=539 sem marcador [chNFe:...] em xMotivo') };
  }

  const prevMsg = await findLatestEnviNFeMsgWithNRec(fs, bundle.filialId, recoveredChave);
  if (!prevMsg?.nRec) {
    console.warn(
      `[nfe/orchestrator] pedido '${bundle.pedidoId}': cStat=539 — chave ` +
        `${recoveredChave} não encontrada no audit log com nRec; marcando como error.`,
    );
    return {
      patch: markAsLost(patch, `cStat=539 — chave ${recoveredChave} não está no audit log local`),
    };
  }

  const consReciCall: SefazCall = sefazCallFor(rt, tpEmis, 'NfeRetAutorizacao');
  const retRec = await consultarLote(consReciCall, { nRec: prevMsg.nRec });
  await enviNfeCollection(fs, bundle.filialId).add(
    buildEnviNFeMsgFromConsulta({
      chave: recoveredChave,
      nRec: prevMsg.nRec,
      ret: retRec,
      tpEmis,
    }),
  );
  const recoveredOutcome = outcomeFromConsReci(retRec, recoveredChave);
  const recoveredPatch = applyOutcome({ estado: patch.estado, retries: 0 }, recoveredOutcome);

  // Swap chave on the nfev4 doc — done outside persistPatch (which is
  // generic) since this only happens on 539 recovery.
  await nfeRef.set(
    nfev4Collection.parseMerge({
      chave: recoveredChave,
      ultima_modificacao: new Date().toISOString(),
    }),
    { merge: true },
  );

  return { patch: recoveredPatch, chaveOverride: recoveredChave };
}
