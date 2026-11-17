/**
 * The step-15 SEAM of the NF-e upload (step 14, PR 14-c; step-14 plan §3
 * decision 14): what runs once Amazon ACCEPTED this pedido's NF-e — the hand-off
 * to the pickup scheduling (Easy Ship).
 *
 * FILLED by step 15 (PR 15-c): ENQUEUE-ONLY, never an Amazon call. `agendar` is
 * the scheduling's first entry (E1, `agendamento/entradasAgendamento.ts`): it
 * enqueues ONE task onto the scheduling queue, named after this NF-e dispatch's
 * own task id and delayed 60 s; the task re-reads the order live and schedules
 * there. The NF-e task's `aceita` path calls it AFTER the stamp clear and the
 * `nfe-validada` resolve, and never with a cancelled sibling (`nfe-substituta`),
 * an ambiguous pedido (`nfe-ambigua`), a partial acceptance or a cancelled sale.
 * A deterministic enqueue refusal (the queue valve, a missing or malformed
 * region, a raw SDK failure) is one WARNING line and never a throw; a TRANSIENT
 * one is rethrown — the whole NF-e dispatch retries (it never resubmits: its
 * status-first read says Accepted, and the retry enqueues under the SAME name)
 * — except on the NF-e queue's last attempt, where it is the same WARNING.
 *
 * ⚠️ The scheduling gates on Amazon's LIVE state, never on "the freight is not
 * `error`" (the stamp clear is step 14's alone), and has its own entry for an
 * NF-e uploaded by hand through Seller Central (the order import, E2), which
 * never passes through here.
 */
import type { AgendadorAgendamentoAmazon } from '../agendamento/agendadorAgendamento';
import { enfileirarAgendamentoDoAceiteAmazon } from '../agendamento/entradasAgendamento';
import type { LoggerAmazon } from '../core/log';

/** What the seam receives: ids only (the order is re-read live by its consumer). */
export interface AceiteNfeAmazon {
  readonly contaId: string;
  readonly pedidoId: string;
  readonly nfeId: string;
  /** Amazon's order id (3-7-7). */
  readonly orderId: string;
}

/** What the NF-e dispatch hands the seam besides the acceptance. */
export interface DepsDestinoAceiteNfeAmazon {
  /** The scheduling queue's producer — the functions root's, built only when the seam runs. */
  readonly agendamento: () => AgendadorAgendamentoAmazon;
  readonly logger: LoggerAmazon;
  /** The NF-e dispatch's own Cloud Tasks id: the observation E1's task is named after. */
  readonly idTarefa: string | null;
  /** The NF-e queue's LAST attempt: a transient enqueue failure is then a WARNING, never a throw. */
  readonly ultimaTentativa: boolean;
}

/** The seam's table: one consumer. */
export interface DestinoAceiteNfeAmazon {
  readonly agendar:
    | ((aceite: AceiteNfeAmazon, deps: DepsDestinoAceiteNfeAmazon) => Promise<void>)
    | null;
}

/** FILLED by step 15 (module header): enqueue-only, never an Amazon call. */
export const DESTINO_ACEITE_NFE_AMAZON: DestinoAceiteNfeAmazon = {
  agendar: enfileirarAgendamentoDoAceiteAmazon,
};
