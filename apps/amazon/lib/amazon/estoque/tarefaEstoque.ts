/**
 * The stock patch task's CONTRACT (step 12, PR 12-d), pure: the payload one
 * per-SKU stock task carries, its NAME, and whether a sent patch earns one
 * read-back. The producer is `produtorEstoque.ts` and the task
 * `processarEstoque.ts` (PR 12-e1).
 *
 * ## The payload: identities only
 *
 * `{ v: 1, contaId, sku, origem, referencia, depositoId }`, `.strict()`. It
 * never carries a quantity: the task computes the ERP quantity when it RUNS,
 * so a retried or late task can never send a stale value. Who produced it:
 *
 *  - `delta` — a movement the tick (or a recovery, for a SKU it does not
 *    force) saw; `referencia` is the OBSERVATION, the newest commit
 *    `updateTime` among the SKU's rows, rendered by
 *    {@link referenciaDaObservacao};
 *  - `reconciliacao` — a daily reconcile's drift; `referencia` is the run's
 *    `execucaoId`, and `depositoId` the depósito the walk read (the task sends
 *    nothing at another one);
 *  - `catch-up` — a FORCED SKU after a feed; `referencia` is the recovered
 *    feed's `feedId` or `execucaoId`, or, for a recovery-born window batch
 *    handed to patches, that batch's own `execucaoId` (the recovery's
 *    identity, stable across its retries);
 *  - `manual` — an operator's request; `referencia` is the request's id;
 *  - `verificacao` — the one read-back after an accepted patch; `referencia`
 *    is Amazon's `submissionId`.
 *
 * `depositoId` is set exactly for `reconciliacao`. The SKU is bounded in size
 * only: whether Amazon can carry it is the task's valve and path check to
 * answer, with a line, never a second copy of either rule here.
 *
 * ## The name: one per observation
 *
 * {@link nomeTarefaEstoque} = `sha256Hex('estoque:' + origem + ':' + contaId
 * + ':' + referencia + ':' + sku)`. The origem, the conta and the reference
 * hold no `:`, so a SKU that does can never shift a field. The same movement
 * minted twice (the tick's overlap, a re-run tick, a recovery seeing it again)
 * is one name and dedupes; a later write moves the row's commit `updateTime`,
 * so it is a new observation and a new name, even when the writer's clock lost
 * the `ultimaModificacao` maximum. A delta name never depends on the tick's
 * clock, its cursor or `ultimaModificacao`.
 *
 * {@link referenciaDaObservacao} renders a `Timestamp` as
 * `<seconds>.<nanoseconds>`, the nanoseconds as nine digits: one rendering per
 * instant, compared as an identity, never converted to ms.
 *
 * ## The read-back
 *
 * {@link precisaVerificacao}: an accepted patch earns ONE delayed re-run,
 * except a read-back itself (never a chain) and a reconcile's patch (the next
 * reconcile reads it back).
 *
 * PURE: no Firestore, no clock, no network.
 */
import { sha256Hex } from '@delfrance/data/admin';
import {
  CONTA_ID_AMAZON_REGEX,
  ID_LOTE_FEED_AMAZON_REGEX,
  type TimestampLike,
} from '@delfrance/schemas';
import { z } from 'zod';

import { partesDoCommit } from './descobertaEstoque';

/** The payload version. */
export const VERSAO_TAREFA_ESTOQUE_AMAZON = 1;

/** The most UTF-16 code units a payload's SKU holds: 40 code points of two units each. */
export const MAX_UNIDADES_SKU_TAREFA_ESTOQUE = 80;

/** Who produced a stock task (module header). */
export const origemTarefaEstoqueAmazonSchema = z.enum([
  'delta',
  'reconciliacao',
  'catch-up',
  'manual',
  'verificacao',
]);
export type OrigemTarefaEstoqueAmazon = z.infer<typeof origemTarefaEstoqueAmazonSchema>;

/** Named members of {@link origemTarefaEstoqueAmazonSchema} — see `delfrance/prefer-schema-enum`. */
export const ORIGEM_TAREFA_ESTOQUE_AMAZON = {
  delta: 'delta',
  reconciliacao: 'reconciliacao',
  catchUp: 'catch-up',
  manual: 'manual',
  verificacao: 'verificacao',
} as const satisfies Record<string, OrigemTarefaEstoqueAmazon>;

/** An observation, rendered: `<seconds>.<nanoseconds>`, the nanoseconds as nine digits. */
export const REFERENCIA_OBSERVACAO_REGEX = /^[0-9]{1,16}\.[0-9]{9}$/;

/** Amazon's `submissionId`: visible ASCII without `:`, so it can never shift a name's field. */
export const REFERENCIA_SUBMISSAO_REGEX = /^[\x21-\x39\x3B-\x7E]{1,128}$/;

/** The grammar of each origem's `referencia` (module header). */
const REFERENCIA_DA_ORIGEM: Readonly<Record<OrigemTarefaEstoqueAmazon, RegExp>> = {
  [ORIGEM_TAREFA_ESTOQUE_AMAZON.delta]: REFERENCIA_OBSERVACAO_REGEX,
  [ORIGEM_TAREFA_ESTOQUE_AMAZON.reconciliacao]: ID_LOTE_FEED_AMAZON_REGEX,
  [ORIGEM_TAREFA_ESTOQUE_AMAZON.catchUp]: ID_LOTE_FEED_AMAZON_REGEX,
  [ORIGEM_TAREFA_ESTOQUE_AMAZON.manual]: ID_LOTE_FEED_AMAZON_REGEX,
  [ORIGEM_TAREFA_ESTOQUE_AMAZON.verificacao]: REFERENCIA_SUBMISSAO_REGEX,
};

/** The stock task's payload (module header). */
export const tarefaEstoqueAmazonSchema = z
  .object({
    v: z.literal(VERSAO_TAREFA_ESTOQUE_AMAZON),
    contaId: z.string().regex(CONTA_ID_AMAZON_REGEX),
    sku: z.string().min(1).max(MAX_UNIDADES_SKU_TAREFA_ESTOQUE),
    origem: origemTarefaEstoqueAmazonSchema,
    referencia: z.string(),
    /** The walk's depósito id for `reconciliacao`; `null` for every other origem. */
    depositoId: z.string().regex(ID_LOTE_FEED_AMAZON_REGEX).nullable(),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (!REFERENCIA_DA_ORIGEM[t.origem].test(t.referencia)) {
      ctx.addIssue({
        code: 'custom',
        message: `referencia fora da gramática da origem ${t.origem}`,
        path: ['referencia'],
      });
    }
    const comDeposito = t.origem === ORIGEM_TAREFA_ESTOQUE_AMAZON.reconciliacao;
    if (comDeposito !== (t.depositoId !== null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'depositoId existe exatamente para a origem reconciliacao',
        path: ['depositoId'],
      });
    }
  });
export type TarefaEstoqueAmazon = z.infer<typeof tarefaEstoqueAmazonSchema>;

/** An integer under a bound, or a `RangeError` naming the field (never the value). */
function exigirInteiro(valor: number, minimo: number, maximo: number, campo: string): number {
  if (!Number.isSafeInteger(valor) || valor < minimo || valor > maximo) {
    throw new RangeError(`tarefaEstoque.ts: ${campo} fora do intervalo`);
  }
  return valor;
}

/**
 * An observation's rendering (module header): `<seconds>.<nanoseconds>`, nine
 * nanosecond digits.
 *
 * @throws {RangeError} seconds outside a non-negative safe integer, or
 *   nanoseconds outside `0…999,999,999`.
 */
export function referenciaDaObservacao(updateTime: TimestampLike): string {
  const [s, n] = partesDoCommit(updateTime);
  const segundos = exigirInteiro(s, 0, Number.MAX_SAFE_INTEGER, 'os segundos');
  const nanos = exigirInteiro(n, 0, 999_999_999, 'os nanossegundos');
  return `${String(segundos)}.${String(nanos).padStart(9, '0')}`;
}

/**
 * A stock task's name (module header): `sha256Hex` of
 * `estoque:<origem>:<contaId>:<referencia>:<sku>`.
 *
 * @throws {RangeError} a field outside its grammar (the message names the
 *   field, never its value).
 */
export function nomeTarefaEstoque(
  origem: OrigemTarefaEstoqueAmazon,
  contaId: string,
  sku: string,
  referencia: string,
): string {
  if (!origemTarefaEstoqueAmazonSchema.safeParse(origem).success) {
    throw new RangeError('tarefaEstoque.ts: origem fora do conjunto fechado');
  }
  if (!CONTA_ID_AMAZON_REGEX.test(contaId)) {
    throw new RangeError('tarefaEstoque.ts: contaId fora da gramática');
  }
  if (sku === '' || sku.length > MAX_UNIDADES_SKU_TAREFA_ESTOQUE) {
    throw new RangeError('tarefaEstoque.ts: sku vazio ou longo demais');
  }
  if (!REFERENCIA_DA_ORIGEM[origem].test(referencia)) {
    throw new RangeError('tarefaEstoque.ts: referencia fora da gramática da origem');
  }
  return sha256Hex(`estoque:${origem}:${contaId}:${referencia}:${sku}`);
}

/** A payload's own name: {@link nomeTarefaEstoque} of its fields. */
export function nomeDaTarefaEstoque(tarefa: TarefaEstoqueAmazon): string {
  return nomeTarefaEstoque(tarefa.origem, tarefa.contaId, tarefa.sku, tarefa.referencia);
}

/** Whether an ACCEPTED patch of this origem earns its one read-back (module header). */
export function precisaVerificacao(origem: OrigemTarefaEstoqueAmazon): boolean {
  return (
    origem !== ORIGEM_TAREFA_ESTOQUE_AMAZON.verificacao &&
    origem !== ORIGEM_TAREFA_ESTOQUE_AMAZON.reconciliacao
  );
}
