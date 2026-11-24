/**
 * The price push's jobs-queue CONTRACT (step 13, PR 13-c), pure: the payload of
 * one per-SKU price task (`preco-sku`) and of one page of a price run
 * (`preco-pagina`), and every NAME they are enqueued under. The handlers and
 * the producers come in later PRs; the payloads join the jobs queue's union
 * then.
 *
 * ## `preco-sku`: identities only, NEVER a price
 *
 * `{ v, tipo, contaId, sku, origem, referencia, parte, baixarPreco,
 * solicitadoEmMs, codigosAntes }`, `.strict()`. The task computes the price
 * when it RUNS, so a retried or late task never sends a stale one, and no
 * field can carry one: an unknown key is refused. Who produced it:
 *
 *  - `manual` — an operator's push; `referencia` is the request's own id,
 *    `solicitadoEmMs` the request's clock;
 *  - `execucao` — a price run hands the SKU to a task (its decision step, or a
 *    batch handing its members over at send time); `referencia` is the RUN's
 *    `execucaoId`, `parte` the index of the run's part that counted the SKU (an
 *    index, never a price: the task reads its floor from that part), and
 *    `solicitadoEmMs` the hand-off's clock;
 *  - `verificacao` — the one check after an accepted send; `referencia` is
 *    Amazon's `submissionId`, and it carries the ORIGINAL send's
 *    `baixarPreco` and `solicitadoEmMs`, plus `codigosAntes`: the price-issue
 *    codes read before that send (at most 10).
 *
 * `parte` is set exactly for `execucao`; `codigosAntes` is empty for every
 * origem but `verificacao`. `baixarPreco` is the request's consent to lower
 * `our_price`.
 *
 * ## `preco-pagina`
 *
 * `{ v, tipo, contaId, execucaoId, pagina }`, `.strict()`: one page of one run.
 * The page re-derives from the run's document whether it is the page the run
 * walks next, so a duplicate dispatch does nothing.
 *
 * ## The names
 *
 * `sha256Hex` of a prefixed, `:`-joined preimage whose fields cannot hold `:`
 * (the SKU, last, may):
 *
 *  - {@link nomeTarefaPrecoAmazon} — `preco:<origem>:<contaId>:<referencia>:<sku>`:
 *    one task per (request, run or send) and SKU;
 *  - {@link nomePaginaPrecoAmazon} — `preco-pagina:<contaId>:<execucaoId>:<pagina>`;
 *  - {@link nomeRetomadaPrecoAmazon} — `preco-retomada:<contaId>:<execucaoId>:<pagina>:<progressoEmMs>`:
 *    the re-kick of a stalled run, one per stall.
 *
 * PURE: no Firestore, no clock, no network.
 */
import { sha256Hex } from '@delfrance/data/admin';
import {
  CONTA_ID_AMAZON_REGEX,
  ID_LOTE_FEED_AMAZON_REGEX,
  MAX_PARTES_EXECUCAO_PRECO_AMAZON,
} from '@delfrance/schemas';
import { z } from 'zod';

import { VERSAO_TAREFA_LOTE_AMAZON } from '../feeds/tarefaLote';
import { CODIGO_ISSUE_AMAZON_REGEX, MAX_CODIGOS_ANTES_PRECO_AMAZON } from './issuesPreco';

/** The most UTF-16 code units a payload's SKU holds: 40 code points of two units each. */
export const MAX_UNIDADES_SKU_TAREFA_PRECO = 80;

/** Amazon's `submissionId`: visible ASCII without `:`, so it can never shift a name's field. */
export const REFERENCIA_SUBMISSAO_PRECO_REGEX = /^[\x21-\x39\x3B-\x7E]{1,128}$/;

/** The two task kinds of the price push on the jobs queue. */
export const TIPO_TAREFA_PRECO_AMAZON = {
  sku: 'preco-sku',
  pagina: 'preco-pagina',
} as const;

/** Who produced a price task (module header). */
export const origemTarefaPrecoAmazonSchema = z.enum(['manual', 'execucao', 'verificacao']);
export type OrigemTarefaPrecoAmazon = z.infer<typeof origemTarefaPrecoAmazonSchema>;

/** Named members of {@link origemTarefaPrecoAmazonSchema} — see `delfrance/prefer-schema-enum`. */
export const ORIGEM_TAREFA_PRECO_AMAZON = {
  manual: 'manual',
  execucao: 'execucao',
  verificacao: 'verificacao',
} as const satisfies Record<string, OrigemTarefaPrecoAmazon>;

/** The grammar of each origem's `referencia` (module header). */
const REFERENCIA_DA_ORIGEM: Readonly<Record<OrigemTarefaPrecoAmazon, RegExp>> = {
  [ORIGEM_TAREFA_PRECO_AMAZON.manual]: ID_LOTE_FEED_AMAZON_REGEX,
  [ORIGEM_TAREFA_PRECO_AMAZON.execucao]: ID_LOTE_FEED_AMAZON_REGEX,
  [ORIGEM_TAREFA_PRECO_AMAZON.verificacao]: REFERENCIA_SUBMISSAO_PRECO_REGEX,
};

/** A non-negative SAFE integer: `String(n)` is plain digits, never an exponent. */
function inteiroSeguro() {
  return z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
}

/** `preco-sku` (module header). */
export const tarefaPrecoSkuAmazonSchema = z
  .object({
    v: z.literal(VERSAO_TAREFA_LOTE_AMAZON),
    tipo: z.literal(TIPO_TAREFA_PRECO_AMAZON.sku),
    contaId: z.string().regex(CONTA_ID_AMAZON_REGEX),
    sku: z.string().min(1).max(MAX_UNIDADES_SKU_TAREFA_PRECO),
    origem: origemTarefaPrecoAmazonSchema,
    referencia: z.string(),
    /** The run's part that counted the SKU: exactly for `execucao`, else `null`. */
    parte: z
      .number()
      .int()
      .min(0)
      .max(MAX_PARTES_EXECUCAO_PRECO_AMAZON - 1)
      .nullable(),
    baixarPreco: z.boolean(),
    /** ms — the clock the consent window counts from (module header). */
    solicitadoEmMs: inteiroSeguro(),
    /** The price-issue codes read before the send a check is about: `verificacao` only. */
    codigosAntes: z
      .array(z.string().regex(CODIGO_ISSUE_AMAZON_REGEX))
      .max(MAX_CODIGOS_ANTES_PRECO_AMAZON),
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
    if ((t.origem === ORIGEM_TAREFA_PRECO_AMAZON.execucao) !== (t.parte !== null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'parte existe exatamente para a origem execucao',
        path: ['parte'],
      });
    }
    if (t.origem !== ORIGEM_TAREFA_PRECO_AMAZON.verificacao && t.codigosAntes.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'só uma verificação carrega codigosAntes',
        path: ['codigosAntes'],
      });
    }
  });
export type TarefaPrecoSkuAmazon = z.infer<typeof tarefaPrecoSkuAmazonSchema>;

/** `preco-pagina` (module header). */
export const tarefaPaginaPrecoAmazonSchema = z
  .object({
    v: z.literal(VERSAO_TAREFA_LOTE_AMAZON),
    tipo: z.literal(TIPO_TAREFA_PRECO_AMAZON.pagina),
    contaId: z.string().regex(CONTA_ID_AMAZON_REGEX),
    execucaoId: z.string().regex(ID_LOTE_FEED_AMAZON_REGEX),
    pagina: inteiroSeguro(),
  })
  .strict();
export type TarefaPaginaPrecoAmazon = z.infer<typeof tarefaPaginaPrecoAmazonSchema>;

/* ---------------------------------- the names --------------------------------- */

/** An id under its grammar, or a `RangeError` naming the field (never the value). */
function exigir(regex: RegExp, valor: string, campo: string): string {
  if (typeof valor !== 'string' || !regex.test(valor)) {
    throw new RangeError(`tarefaPreco.ts: ${campo} fora da gramática`);
  }
  return valor;
}

/** A non-negative safe integer, or a `RangeError` naming the field. */
function exigirInteiro(valor: number, campo: string): string {
  if (!Number.isSafeInteger(valor) || valor < 0) {
    throw new RangeError(`tarefaPreco.ts: ${campo} deve ser um inteiro seguro não negativo`);
  }
  return String(valor);
}

/**
 * A price task's name (module header): `sha256Hex` of
 * `preco:<origem>:<contaId>:<referencia>:<sku>`.
 *
 * @throws {RangeError} a field outside its grammar (the message names the
 *   field, never its value).
 */
export function nomeTarefaPrecoAmazon(
  origem: OrigemTarefaPrecoAmazon,
  contaId: string,
  referencia: string,
  sku: string,
): string {
  if (!origemTarefaPrecoAmazonSchema.safeParse(origem).success) {
    throw new RangeError('tarefaPreco.ts: origem fora do conjunto fechado');
  }
  exigir(CONTA_ID_AMAZON_REGEX, contaId, 'contaId');
  exigir(REFERENCIA_DA_ORIGEM[origem], referencia, 'referencia');
  if (typeof sku !== 'string' || sku === '' || sku.length > MAX_UNIDADES_SKU_TAREFA_PRECO) {
    throw new RangeError('tarefaPreco.ts: sku vazio ou longo demais');
  }
  return sha256Hex(`preco:${origem}:${contaId}:${referencia}:${sku}`);
}

/** A payload's own name: {@link nomeTarefaPrecoAmazon} of its fields. */
export function nomeDaTarefaPrecoAmazon(t: TarefaPrecoSkuAmazon): string {
  return nomeTarefaPrecoAmazon(t.origem, t.contaId, t.referencia, t.sku);
}

/** A run page's name (module header): (conta, run, page). */
export function nomePaginaPrecoAmazon(contaId: string, execucaoId: string, pagina: number): string {
  exigir(CONTA_ID_AMAZON_REGEX, contaId, 'contaId');
  exigir(ID_LOTE_FEED_AMAZON_REGEX, execucaoId, 'execucaoId');
  return sha256Hex(`preco-pagina:${contaId}:${execucaoId}:${exigirInteiro(pagina, 'pagina')}`);
}

/**
 * The re-kick of a stalled run (module header): (conta, run, the page it walks
 * next, the run's last progress stamp in ms). A run that stalls again after
 * progressing has a new stamp, so a new name; the same stall re-kicked twice
 * is one task.
 */
export function nomeRetomadaPrecoAmazon(
  contaId: string,
  execucaoId: string,
  pagina: number,
  progressoEmMs: number,
): string {
  exigir(CONTA_ID_AMAZON_REGEX, contaId, 'contaId');
  exigir(ID_LOTE_FEED_AMAZON_REGEX, execucaoId, 'execucaoId');
  return sha256Hex(
    `preco-retomada:${contaId}:${execucaoId}:${exigirInteiro(pagina, 'pagina')}:${exigirInteiro(
      progressoEmMs,
      'progressoEmMs',
    )}`,
  );
}
