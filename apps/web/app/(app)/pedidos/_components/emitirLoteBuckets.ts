/**
 * Bucket classification for the batch NF-e emission dialog (`EmitirLoteDialog`).
 *
 * Kept as a pure module (no React) so the mapping can be unit-tested without a
 * DOM — same split as `lib/nfe/errors.ts`.
 *
 * An async lote (>1 NF-e → `indSinc=0`) comes back with SEFAZ **cStat 103**
 * "Lote recebido com sucesso": the orchestrator persists
 * `estado='aguardandoResposta'` ('2') and returns HTTP 200, and the notes are
 * later authorized by the async reconciliation. That is NOT a failure — so it
 * gets its own "Em processamento" bucket instead of being dumped into "Falhas"
 * (the bug behind #259). The single-pedido path already does this via the blue
 * "NF-e em processamento" toast in `errors.ts`.
 */
import {
  isNFeEmitError,
  type NFeEmitError,
  type NFeEmitResult,
} from '@delfrance/integrations-nfe/http-provider';
import { ESTADO_NFE } from '@delfrance/schemas';

export type Bucket = 'sucesso' | 'processando' | 'falhas' | 'naoEmitidas';

/**
 * Classify a single emit result into a counter bucket.
 * - `sucesso`: this run's autorizadas (`aprovada` and not reused).
 * - `processando`: async-pending — `enviando` ('1') or `aguardandoResposta`
 *   ('2', i.e. cStat 103). The lote was accepted; the protocol comes later.
 * - `naoEmitidas`: load/prepare failures (`NFeEmitError`) and dedup
 *   short-circuits (`aprovada` + `reused`, i.e. an NF-e already existed).
 * - `falhas`: terminal-non-autorizada — `rejeitada` ('n'), `error` ('e'), etc.
 */
export function classifyEmitResult(r: NFeEmitResult | NFeEmitError): Bucket {
  if (isNFeEmitError(r)) return 'naoEmitidas';
  if (r.estado === ESTADO_NFE.aprovada) return r.reused ? 'naoEmitidas' : 'sucesso';
  if (r.estado === ESTADO_NFE.enviando || r.estado === ESTADO_NFE.aguardandoResposta) {
    return 'processando';
  }
  return 'falhas';
}

/** Render order of the dialog's counters. */
export const BUCKET_ORDER: readonly Bucket[] = ['sucesso', 'processando', 'falhas', 'naoEmitidas'];

/** Per-bucket label + Mantine color, shared by the counters and the per-row badge. */
export const BUCKET_META: Record<Bucket, { readonly label: string; readonly color: string }> = {
  sucesso: { label: 'Sucesso', color: 'teal' },
  processando: { label: 'Em processamento', color: 'blue' },
  falhas: { label: 'Falhas', color: 'red' },
  naoEmitidas: { label: 'Não emitidas', color: 'yellow' },
};
