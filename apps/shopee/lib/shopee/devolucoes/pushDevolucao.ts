/**
 * Code 29 (`push 32`, `return_updates_push`) read as a POINTER (#1525, step 17).
 *
 * PURE: no clock, no Firestore, no wire call, no `console` — and **no unit
 * conversion**. The one timestamp that leaves this module is Shopee's own
 * SECONDS and says so in its name (`relogioDoPushS`); the return's watermark is
 * the PULLED `get_return_detail.update_time`, converted once in
 * `devolucaoMapping.ts`.
 *
 * ## What the push IS, on this path
 *
 * A pointer: "the return `<return_sn>` of order `<order_sn>` changed". The
 * handler re-fetches `get_return_detail` and writes THAT — which is what makes a
 * replayed, out-of-order or same-second push harmless (two deliveries sharing
 * one failure row both mean "go and look"). Nothing the push claims is ever
 * written:
 *
 *  - ⚠️ **The push has no top-level clock.** `push 32`'s only clocks sit PER
 *    FIELD inside `updated_values[]` (SECONDS), so it cannot be ordered against
 *    anything; the detail brings its own `update_time`.
 *  - ⚠️ **It reports four fields** (`return_status`, `return_solution`,
 *    `seller_proof_status`, `logistics_status`) and never a negotiation,
 *    compensation, due-date or amount change — which is why the 6-hourly poller
 *    exists. A push's silence is not "nothing changed".
 *  - ⚠️ `old_value` is not a staleness guard: Shopee's own sample moves
 *    `JUDGING → PROCESSING`, so status is not monotone.
 *
 * What it does carry is kept as a DIARY ({@link DiarioPushDevolucao}) for the
 * importer's one log line — `divergePushVsPull` compares the push's
 * `return_status` against the pulled one — and for nothing else.
 *
 * ## Three producers, one reader
 *
 * A real `push 32`, and the two SYNTHETIC code 29s
 * (`notificacaoSinteticaDeDevolucao`): the poller (`'reconciliacao'`) and the
 * post-action refresh (`'acao-vendedor'`). A synthetic carries EXACTLY
 * `{ order_sn, return_sn, origem }` — no `updated_values` — so its diary is
 * empty by construction, and its `origem` is the only key a real push never
 * sends.
 *
 * Reached ONLY dynamically from `notificacao.ts` (the receiver bundle stays
 * lean); static value imports from `../pedidos/*` are fine here.
 */
import { z } from 'zod';
import { wireInt } from '@delfrance/core/wire';
import { ehReturnSnShopee } from '@delfrance/schemas';

import { SENTINELA_AUSENTE_SHOPEE, segundosShopeeUtilizaveis } from '../pedidos/orderMapping';
import { TOKEN_SHOPEE_PARA_LOG } from './tokenParaLog';

/* -------------------------------------------------------------------------- */
/*                                   the types                                 */
/* -------------------------------------------------------------------------- */

/**
 * What the push CLAIMED, for the log line — **LOG ONLY, never data**.
 *
 * ⚠️ Not one field of this reaches a Firestore patch or an aviso: two pushes
 * that disagree about their own values but name the same return produce
 * byte-identical writes, because the write comes from the pull.
 */
export interface DiarioPushDevolucao {
  /** `updated_values[].update_field`, deduped in arrival order, at most {@link MAX_CAMPOS_NO_DIARIO}. */
  readonly camposMudados: readonly string[];
  /** The LATEST per-field `update_time`, SECONDS (2020-floored), or `null` — never a watermark. */
  readonly relogioDoPushS: number | null;
  /** The `new_value` of the push's `return_status` entry (the latest one), or `null`. */
  readonly statusNoPush: string | null;
}

/**
 * Who asked for this import. A real push is `'push'`; the two synthetic
 * producers stamp their own name in `data.origem`.
 */
export type OrigemImportacaoDevolucao = 'push' | 'reconciliacao' | 'acao-vendedor';

/**
 * What the devolução arm needs off a code 29, or why it cannot act.
 *
 * ⚠️ `motivo` carries field PATHS and fixed prose only — never a value and
 * never a body (#1015). A parked row is read by an operator, and a return_sn
 * that failed the shape check is exactly the value that must not be echoed.
 */
export type AlvoDoPushDeDevolucao =
  | {
      ok: true;
      orderSn: string;
      returnSn: string;
      origem: OrigemImportacaoDevolucao;
      diario: DiarioPushDevolucao;
    }
  | { ok: false; motivo: string };

/* -------------------------------------------------------------------------- */
/*                                 the readers                                 */
/* -------------------------------------------------------------------------- */

/**
 * How many distinct `update_field` names a diary keeps. `push 32` documents
 * four; eight is headroom for a field Shopee adds, and a bound for a body that
 * repeats one forever.
 */
export const MAX_CAMPOS_NO_DIARIO = 8;

/**
 * A push TOKEN — a field name or a status — never free text.
 *
 * ⚠️ The diary feeds a log line, and a log line here carries ids, tokens,
 * counts and booleans only. The token rule is the returns' ONE
 * (`tokenParaLog.ts`), but the diary DROPS what fails it rather than masking it:
 * the marker would fill `camposMudados` and, as `statusNoPush`, make
 * `divergePushVsPull` true for a push that said nothing readable. No documented
 * `update_field` or `return_status` value has a space or punctuation.
 */
function tokenOuNull(v: unknown): string | null {
  return typeof v === 'string' && TOKEN_SHOPEE_PARA_LOG.test(v) ? v : null;
}

/**
 * The order key, verbatim, or `null` when it is not usable.
 *
 * ⚠️ **Verbatim, not trimmed.** `order_sn` is the PREIMAGE of the pedido id
 * (`makePedidoIdShopee`), exactly as the code-3 arm reads `ordersn`, and the
 * importer later checks the pulled detail's `order_sn` against it with `!==`.
 * A padded value is therefore refused here — a trimmed one would silently
 * become a DIFFERENT pedido id from the one the padded value hashes to, and
 * neither would be the order Shopee meant. Blank and the `-` sentinel are
 * absences.
 */
function chaveDoPedido(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (v.length === 0 || v.trim() !== v) return null;
  return v === SENTINELA_AUSENTE_SHOPEE ? null : v;
}

/**
 * One `updated_values[]` entry. Every field is tolerated: the diary is a
 * DIAGNOSTIC, so a drifted entry reads as nothing and never costs the
 * delivery. Only the identity (above) can refuse a push.
 */
const entradaDoPushSchema = z
  .object({
    update_field: z.unknown(),
    new_value: z.unknown(),
    /** SECONDS — the push's per-field clock. */
    update_time: wireInt().nullable().catch(null),
  })
  .passthrough()
  .nullable()
  .catch(null);

/** Per-ELEMENT tolerance, and a non-array reads as no entry at all. */
const entradasDoPushSchema = z.array(entradaDoPushSchema).catch(() => []);

/** The `update_field` whose `new_value` is the return's status. */
const CAMPO_STATUS_DO_PUSH = 'return_status';

function diarioDoPush(bruto: unknown): DiarioPushDevolucao {
  const entradas = entradasDoPushSchema.parse(bruto ?? []);

  const camposMudados: string[] = [];
  let relogioDoPushS: number | null = null;
  let statusNoPush: string | null = null;
  let relogioDoStatusS: number | null = null;

  for (const entrada of entradas) {
    if (entrada == null) continue;
    const campo = tokenOuNull(entrada.update_field);
    // The same 2020 floor the rest of this wire gets: a zero-fill printed in a
    // log line as a clock is the 1970 bug wearing a diagnostic hat.
    const relogioS = segundosShopeeUtilizaveis(entrada.update_time);

    if (
      campo !== null &&
      !camposMudados.includes(campo) &&
      camposMudados.length < MAX_CAMPOS_NO_DIARIO
    ) {
      camposMudados.push(campo);
    }
    if (relogioS !== null && (relogioDoPushS === null || relogioS > relogioDoPushS)) {
      relogioDoPushS = relogioS;
    }
    if (campo === CAMPO_STATUS_DO_PUSH) {
      const status = tokenOuNull(entrada.new_value);
      // The LATEST status entry wins; a clock-less one wins only over nothing
      // or over another clock-less one (then the later-listed).
      const maisNovo =
        statusNoPush === null ||
        relogioDoStatusS === null ||
        (relogioS !== null && relogioS >= relogioDoStatusS);
      if (status !== null && maisNovo) {
        statusNoPush = status;
        relogioDoStatusS = relogioS;
      }
    }
  }

  return { camposMudados, relogioDoPushS, statusNoPush };
}

/** The `origem` a synthetic producer stamps; a real push sends none. */
const ORIGENS_IMPORTACAO: ReadonlySet<string> = new Set<OrigemImportacaoDevolucao>([
  'push',
  'reconciliacao',
  'acao-vendedor',
]);

function ehOrigemImportacao(v: unknown): v is OrigemImportacaoDevolucao {
  return typeof v === 'string' && ORIGENS_IMPORTACAO.has(v);
}

/* -------------------------------------------------------------------------- */
/*                         the reader the devolução arm calls                  */
/* -------------------------------------------------------------------------- */

/**
 * One code-29 `data` → the return it points at, or a readable refusal.
 *
 * - `orderSn` = `order_sn` (push 32's DOCUMENTED spelling, with the
 *   underscore — and the synthetic's) `??` `ordersn` (tolerated: `push 17`
 *   proved a push page can contradict its own table). The documented one wins
 *   when both are present and disagree.
 * - `returnSn` must pass `ehReturnSnShopee` — ALPHANUMERIC, verbatim, never
 *   ML's `Number.isSafeInteger`. ⚠️ A JSON NUMBER is refused too: the page
 *   documents a string, and a number above 2^53 has already been rounded by
 *   `JSON.parse` into a plausible id that is not the one Shopee sent.
 * - `origem` = `data.origem` when it is a member, else `'push'`.
 * - `diario` — LOG ONLY.
 */
export function alvoDoPushDeDevolucao(data: Record<string, unknown>): AlvoDoPushDeDevolucao {
  const returnSnBruto = data.return_sn;
  if (returnSnBruto === undefined || returnSnBruto === null || returnSnBruto === '') {
    return { ok: false, motivo: 'push de devolução sem return_sn — nada a importar' };
  }
  if (!ehReturnSnShopee(returnSnBruto)) {
    return {
      ok: false,
      motivo: 'push de devolução com return_sn fora do formato [A-Za-z0-9]{1,64} — nada a importar',
    };
  }

  const orderSn = chaveDoPedido(data.order_sn) ?? chaveDoPedido(data.ordersn);
  if (orderSn === null) {
    return {
      ok: false,
      motivo: 'push de devolução sem order_sn/ordersn utilizável — nada a importar',
    };
  }

  return {
    ok: true,
    orderSn,
    returnSn: returnSnBruto,
    origem: ehOrigemImportacao(data.origem) ? data.origem : 'push',
    diario: diarioDoPush(data.updated_values),
  };
}
