/**
 * cStat=539 recovery — kept in its own module so the async paths
 * (`reconcileByRecibo`, `consultarPedido`, the `processar-pendentes` sweep) can
 * import the 539 gate WITHOUT pulling in the whole `emitir.ts` orchestrator
 * graph (sign / SOAP / generator / scheduler), which would bloat the reconcile
 * Cloud Task / sweep cold-start.
 */
import type { Firestore } from 'firebase-admin/firestore';

import {
  applyOutcome,
  consultarLote,
  type NFeStatePatch,
  type SefazCall,
  type SefazOutcome,
  type TpEmis,
} from '@delfrance/integrations-nfe';

import type { NFeRuntime } from '../runtime';
import type { PedidoBundle } from './bundle';
import { sefazCallFor } from './sefaz-call';
import {
  buildEnviNFeMsgFromConsulta,
  enviNfeCollection,
  findLatestEnviNFeMsgWithNRec,
  markAsLost,
  outcomeFromConsReci,
} from './audit';

/**
 * Handle a cStat=539 outcome: SEFAZ already has an NF-e with our
 * `nNF + serie + tpEmis + emit-CNPJ` but under a DIFFERENT chave (the
 * `[chNFe:...]` marker in xMotivo). Recovery strategy:
 *   1. Pull the previously-emitted chave from xMotivo markers.
 *   2. Look it up in our `EnviNFeMsg` audit log (the SEFAZ-roundtrip
 *      log written on every lote send / consult).
 *   3. If found, the previous lote's `nRec` is also in the audit log
 *      msg — call `consultarLote(prevNRec)` to fetch SEFAZ's
 *      authoritative protocol for that chave, and return the consult
 *      outcome with the recovered chave as `chaveOverride`.
 *   4. If not found (or no chNFe marker), the note is "lost" from our
 *      side — return a patch marking estado=error with the original
 *      cStat=539 + xMotivo preserved so the operator can fix manually
 *      (download from SEFAZ portal + upload).
 *
 * **It writes nothing to the nfev4 doc** (#1654 §2d). The chave swap is the
 * CALLER's to persist, in its own write of the returned patch
 * ({@link extrasDaTrocaDeChave}), so the swap lands with the outcome or not at
 * all: under the reconcile's and the manual verify's guarded persist, a write
 * refused by a concurrent writer swaps nothing either. (It used to be a plain
 * merge of its own, landing BEFORE the caller's write and outside any guard.)
 * It does append the recovery's `consReciNFe` to the `enviNfe` audit log.
 *
 * NB: the swap does NOT touch `xml_assinado` — it still holds the locally
 * signed XML for OUR chave. After a successful 539 recovery the doc
 * has a mismatch (recovered chave + local signed XML for the old
 * chave); the next step in production is to fetch the authorized XML
 * from SEFAZ DistDFe (a Phase D port).
 */
export async function recoverFrom539(params: {
  fs: Firestore;
  bundle: Pick<PedidoBundle, 'pedidoId' | 'filialId'>;
  rt: NFeRuntime;
  tpEmis: TpEmis;
  outcome: SefazOutcome;
  patch: NFeStatePatch;
}): Promise<{ patch: NFeStatePatch; chaveOverride?: string }> {
  const { fs, bundle, rt, tpEmis, outcome, patch } = params;

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

  return { patch: recoveredPatch, chaveOverride: recoveredChave };
}

/**
 * The `extras` that carry a recovered 539's chave swap in the caller's OWN
 * write of the recovered patch (`persistPatch` / `persistPatchUnlessFinal`),
 * or `undefined` when nothing was swapped. Never combined with the
 * `<nfeProc>` swap (`swapAnchorForProc`): a swapped chave no longer matches
 * our signed XML, so no proc is built for it.
 */
export function extrasDaTrocaDeChave(
  chaveOverride: string | undefined,
): { readonly chave: string } | undefined {
  return chaveOverride != null ? { chave: chaveOverride } : undefined;
}

/**
 * Shared cStat=539 gate. Every path that turns a SEFAZ lote/consult outcome into
 * a patch runs this so a 539 (duplicidade com chave diferente) is resolved
 * uniformly: recovered when the SEFAZ-asserted chave is one we emitted, else
 * flipped to terminal `error` (issue #243). Without it the async paths
 * (`reconcileByRecibo`, `consultarPedido`, the `processar-pendentes` consSit
 * branch) leave a 539 stuck in `aguardandoResposta` — `cStatToEstado('539')` is
 * `null`, so `applyOutcome` keeps the estado and re-queues the doc forever.
 *
 * No-op for every non-539 outcome (returns the patch untouched), so callers can
 * funnel every outcome through it right after `applyOutcome`. Like
 * {@link recoverFrom539} it writes nothing to the nfev4 doc: the caller persists
 * the patch, with `extrasDaTrocaDeChave(chaveOverride)` in the same write.
 */
export async function recover539IfNeeded(params: {
  fs: Firestore;
  bundle: Pick<PedidoBundle, 'pedidoId' | 'filialId'>;
  rt: NFeRuntime;
  tpEmis: TpEmis;
  outcome: SefazOutcome;
  patch: NFeStatePatch;
}): Promise<{ patch: NFeStatePatch; chaveOverride?: string }> {
  if (params.patch.action === 'recover-via-consulta' && params.outcome.cStat === '539') {
    return recoverFrom539(params);
  }
  return { patch: params.patch };
}
