/**
 * The price RUN document's I/O (step 13, PR 13-e): `precosAmazon/{contaId}`,
 * through the run handle (`precoAmazonCollection`) and nothing else. Built
 * beside the stock reconcile's run I/O, never through it: the price run
 * carries a plan, a batch ledger and a cancel that the stock run has none of.
 *
 * ## Reads: by id, through a MASK
 *
 * {@link lerExecucaoPrecoAmazon} reads the run by id with a field mask
 * ({@link MascaraExecucaoPrecoAmazon}, built by {@link mascaraExecucaoPrecoAmazon}):
 * only the top-level fields a caller decides from come back, parsed by the run
 * schema PICKED to them (a field the stored run lacks takes its default).
 * {@link EXECUCAO_PRECO_INTEIRA} reads the whole document. A stored run that
 * does not parse throws {@link ExecucaoPrecoInvalidaError}: it never reads as
 * absent, which a claim would overwrite and a cancel would answer "no run" for.
 *
 * ## The ONE write: {@link escreverExecucaoPrecoAmazon} (rule 7, tier 1)
 *
 * Every write of the run goes through this helper. The caller DECIDES from a
 * read (`decidir`); the helper writes what was decided, under that read's own
 * precondition:
 *
 *  - a WHOLE run (`execucao`, parsed by the run schema, every default filled):
 *    `create` when the read found no run, else `update` of EVERY field with `{
 *    lastUpdateTime }` of the read, so the earlier run is replaced whole, its
 *    maps and lists included;
 *  - a field PATCH (`campos`, parsed by the handle's merge parse): `update(…, {
 *    lastUpdateTime })` on the run the read found (a patch on no run is a
 *    caller's bug: `TypeError`, nothing written);
 *  - nothing: the decision's answer, no write.
 *
 * A lost precondition (ALREADY_EXISTS for a `create`, FAILED_PRECONDITION or
 * NOT_FOUND for an `update`) RE-READS the run under the SAME mask and asks
 * `decidir` again, so a decision is always a function of the state it lands
 * on, never of a value captured before an `await`: at most
 * {@link MAX_TENTATIVAS_EXECUCAO_PRECO_AMAZON} attempts, then
 * {@link ExecucaoPrecoEmConflitoError}. Never a blind overwrite: no `set` of
 * the run exists. A caller that already holds a read (the claim's own write, a
 * page's fresh read) hands it in as `inicial`, and the first attempt writes on
 * ITS precondition.
 *
 * ## A page's sums
 *
 * {@link somarPaginaNaExecucaoPrecoAmazon} adds one page's counters and decrease
 * sample to the run's: every counter summed, the refusals by motivo summed key
 * by key, `limiteTaxa` the lowest one seen, and the sample cut to the largest
 * decreases by the price plan's one ranking (`planoPreco.ts`). This module
 * compares no price.
 *
 * Units: every number stamp of the run is ms; `relogioInicio` is a Firestore
 * `Timestamp`. No transaction, no batch.
 */
import type {
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Timestamp,
} from 'firebase-admin/firestore';
import { precoAmazonCollection } from '@delfrance/data/admin/collections';
import {
  isAlreadyExists,
  isFailedPrecondition,
  isNotFound,
} from '@delfrance/data/admin/grpcErrors';
import {
  CONTA_ID_AMAZON_REGEX,
  type ContagensExecucaoPrecoAmazon,
  type ExecucaoPrecoAmazon,
  FASE_EXECUCAO_PRECO_AMAZON,
  type FaseExecucaoPrecoAmazon,
  contagensExecucaoPrecoAmazonSchema,
  execucaoPrecoAmazonSchema,
} from '@delfrance/schemas';
import type { z } from 'zod';

import { amostraReducoesPrecoAmazon } from './planoPreco';

/** The most write attempts of one decision (module header): the first, and two re-derives. */
export const MAX_TENTATIVAS_EXECUCAO_PRECO_AMAZON = 3;

/** A top-level field of the run document. */
export type CampoExecucaoPrecoAmazon = keyof ExecucaoPrecoAmazon;

/** How a caller reads the run (module header, "Reads"). */
export interface MascaraExecucaoPrecoAmazon<E> {
  /** The top-level fields read, in the order given; `null` reads the whole document. */
  readonly campos: readonly CampoExecucaoPrecoAmazon[] | null;
  /** The run schema, picked to those fields. */
  readonly schema: z.ZodType<E>;
}

/** The whole run document. */
export const EXECUCAO_PRECO_INTEIRA: MascaraExecucaoPrecoAmazon<ExecucaoPrecoAmazon> = {
  campos: null,
  schema: execucaoPrecoAmazonSchema,
};

/**
 * A mask of `campos` (module header, "Reads").
 *
 * @throws {RangeError} no field, or a field named twice.
 */
export function mascaraExecucaoPrecoAmazon<K extends CampoExecucaoPrecoAmazon>(
  campos: readonly K[],
): MascaraExecucaoPrecoAmazon<Pick<ExecucaoPrecoAmazon, K>> {
  if (campos.length === 0 || new Set(campos).size !== campos.length) {
    throw new RangeError('execucaoPrecoFirestore.ts: uma máscara nomeia cada campo uma vez');
  }
  const forma = Object.fromEntries(campos.map((campo) => [campo, true])) as Partial<
    Record<CampoExecucaoPrecoAmazon, true>
  >;
  return {
    campos: [...campos],
    schema: execucaoPrecoAmazonSchema.pick(forma) as unknown as z.ZodType<
      Pick<ExecucaoPrecoAmazon, K>
    >,
  };
}

/** One read of the run. */
export interface LeituraExecucaoPrecoAmazon<E> {
  /** The run as the mask reads it; `null` when there is no run. */
  readonly estado: E | null;
  /** The run's commit stamp: the precondition of a write decided on this read. */
  readonly updateTime: Timestamp | null;
  /** The read's own time. */
  readonly readTime: Timestamp;
}

/**
 * A stored run that no longer parses: only a hand edit makes one (every write
 * here goes through the schema). Never read as "no run".
 */
export class ExecucaoPrecoInvalidaError extends Error {
  readonly contaId: string;
  /** The top-level fields Zod blamed — never a value. */
  readonly campos: readonly string[];

  constructor(contaId: string, campos: readonly string[]) {
    super(`A execução de preço da conta ${contaId} não é válida (campos: ${campos.join(', ')}).`);
    this.name = 'ExecucaoPrecoInvalidaError';
    this.contaId = contaId;
    this.campos = campos;
  }
}

/** Every attempt of one decision lost its precondition: a concurrent writer kept winning. */
export class ExecucaoPrecoEmConflitoError extends Error {
  readonly contaId: string;

  constructor(contaId: string) {
    super(
      `A execução de preço da conta ${contaId} mudou a cada tentativa de gravação (${String(
        MAX_TENTATIVAS_EXECUCAO_PRECO_AMAZON,
      )} tentativas).`,
    );
    this.name = 'ExecucaoPrecoEmConflitoError';
    this.contaId = contaId;
  }
}

/** A conta id under its grammar, or a `RangeError` naming the rule (never the value). */
function exigirConta(contaId: string): void {
  if (typeof contaId !== 'string' || !CONTA_ID_AMAZON_REGEX.test(contaId)) {
    throw new RangeError('execucaoPrecoFirestore.ts: contaId fora de CONTA_ID_AMAZON_REGEX');
  }
}

/**
 * The run document's reference (`precosAmazon/{contaId}`).
 *
 * @throws {RangeError} a conta id outside its grammar.
 */
export function refExecucaoPrecoAmazon(db: Firestore, contaId: string): DocumentReference {
  exigirConta(contaId);
  return precoAmazonCollection.docRef(db, {}, contaId);
}

/** Whether a phase is a LIVE run's: walking its pages, or deciding. */
export function execucaoPrecoAmazonViva(fase: FaseExecucaoPrecoAmazon): boolean {
  return (
    fase === FASE_EXECUCAO_PRECO_AMAZON.paginando || fase === FASE_EXECUCAO_PRECO_AMAZON.decidindo
  );
}

/** The top-level fields a failed parse blamed, sorted: never a value. */
function camposDoErro(issues: readonly { readonly path: readonly PropertyKey[] }[]): string[] {
  return [...new Set(issues.map((i) => String(i.path[0] ?? '(raiz)')))].sort();
}

/** A snapshot read under `mascara` (module header, "Reads"). */
function lerDoSnapshot<E>(
  snap: DocumentSnapshot | undefined,
  contaId: string,
  mascara: MascaraExecucaoPrecoAmazon<E>,
): LeituraExecucaoPrecoAmazon<E> {
  if (snap === undefined) {
    throw new TypeError('execucaoPrecoFirestore.ts: a leitura não devolveu o documento');
  }
  if (!snap.exists) return { estado: null, updateTime: null, readTime: snap.readTime };
  const lido = mascara.schema.safeParse(snap.data());
  if (!lido.success) throw new ExecucaoPrecoInvalidaError(contaId, camposDoErro(lido.error.issues));
  const { updateTime } = snap;
  if (updateTime === undefined) {
    throw new TypeError('execucaoPrecoFirestore.ts: documento existente sem updateTime');
  }
  return { estado: lido.data, updateTime, readTime: snap.readTime };
}

/**
 * The run, by id, under `mascara` (module header, "Reads").
 *
 * @throws {RangeError} a conta id outside its grammar (nothing read).
 * @throws {ExecucaoPrecoInvalidaError} a stored run that does not parse.
 */
export async function lerExecucaoPrecoAmazon<E>(
  db: Firestore,
  contaId: string,
  mascara: MascaraExecucaoPrecoAmazon<E>,
): Promise<LeituraExecucaoPrecoAmazon<E>> {
  const ref = refExecucaoPrecoAmazon(db, contaId);
  const [snap] =
    mascara.campos === null
      ? await db.getAll(ref)
      : await db.getAll(ref, { fieldMask: [...mascara.campos] });
  return lerDoSnapshot(snap, contaId, mascara);
}

/** What a decision writes (module header, "The ONE write"). */
export type EscritaExecucaoPrecoAmazon =
  /** A whole run: created, or replacing the run the read found. */
  | { readonly tipo: 'execucao'; readonly execucao: z.input<typeof execucaoPrecoAmazonSchema> }
  /** A field patch of the run the read found. */
  | { readonly tipo: 'campos'; readonly campos: Readonly<Partial<ExecucaoPrecoAmazon>> };

/** A decision on one read: what to write (or `null`), and what to answer once it landed. */
export interface DecisaoExecucaoPrecoAmazon<R> {
  readonly escrita: EscritaExecucaoPrecoAmazon | null;
  readonly resposta: R;
}

/** What {@link escreverExecucaoPrecoAmazon} did: the decision that held, and its write. */
export interface ResultadoEscritaExecucaoPrecoAmazon<E, R> {
  readonly resposta: R;
  /** The read the decision that held was made on. */
  readonly lida: LeituraExecucaoPrecoAmazon<E>;
  /** The write's commit; `null` when that decision wrote nothing. */
  readonly writeTime: Timestamp | null;
  /** The fields written, as parsed (a whole run: every field); `null` when nothing. */
  readonly escrito: Readonly<Partial<ExecucaoPrecoAmazon>> | null;
}

/** The fields one decision writes, parsed (module header, "The ONE write"). */
function dadosDaEscrita(
  escrita: EscritaExecucaoPrecoAmazon,
  existe: boolean,
): Partial<ExecucaoPrecoAmazon> {
  if (escrita.tipo === 'execucao') return precoAmazonCollection.parse(escrita.execucao);
  if (!existe) {
    throw new TypeError('execucaoPrecoFirestore.ts: um patch só se grava numa execução que existe');
  }
  const dados = precoAmazonCollection.parseMerge({ ...escrita.campos });
  if (Object.keys(dados).length === 0) {
    throw new TypeError('execucaoPrecoFirestore.ts: um patch sem campo não é uma escrita');
  }
  return dados;
}

/**
 * ONE write on a read's precondition: its commit, or `null` when that
 * precondition was lost.
 */
async function gravar(
  ref: DocumentReference,
  updateTime: Timestamp | null,
  dados: Partial<ExecucaoPrecoAmazon>,
): Promise<Timestamp | null> {
  try {
    const { writeTime } =
      updateTime === null
        ? await ref.create(dados)
        : await ref.update(dados, { lastUpdateTime: updateTime });
    return writeTime;
  } catch (err) {
    if (isAlreadyExists(err) || isFailedPrecondition(err) || isNotFound(err)) return null;
    throw err;
  }
}

/**
 * THE write of the run (module header, "The ONE write"): `decidir` on a read,
 * the decision written on that read's precondition, a lost one re-read under
 * `mascara` and decided again.
 *
 * @throws {RangeError} a conta id outside its grammar (nothing read).
 * @throws {ExecucaoPrecoInvalidaError} a stored run that does not parse.
 * @throws {ExecucaoPrecoEmConflitoError} every attempt lost its precondition.
 * @throws {TypeError} a patch decided on no run, or a patch with no field.
 * @throws a `ZodError` for a decision the run schema refuses (nothing written),
 *   and whatever `decidir` throws; Firestore's own failures, untouched.
 */
export async function escreverExecucaoPrecoAmazon<E, R>(
  db: Firestore,
  contaId: string,
  mascara: MascaraExecucaoPrecoAmazon<E>,
  decidir: (lida: LeituraExecucaoPrecoAmazon<E>) => DecisaoExecucaoPrecoAmazon<R>,
  inicial: LeituraExecucaoPrecoAmazon<E> | null = null,
): Promise<ResultadoEscritaExecucaoPrecoAmazon<E, R>> {
  const ref = refExecucaoPrecoAmazon(db, contaId);
  let lida = inicial ?? (await lerExecucaoPrecoAmazon(db, contaId, mascara));
  for (let tentativa = 1; ; tentativa += 1) {
    const { escrita, resposta } = decidir(lida);
    if (escrita === null) return { resposta, lida, writeTime: null, escrito: null };
    const dados = dadosDaEscrita(escrita, lida.updateTime !== null);
    const writeTime = await gravar(ref, lida.updateTime, dados);
    if (writeTime !== null) return { resposta, lida, writeTime, escrito: dados };
    if (tentativa >= MAX_TENTATIVAS_EXECUCAO_PRECO_AMAZON) {
      throw new ExecucaoPrecoEmConflitoError(contaId);
    }
    lida = await lerExecucaoPrecoAmazon(db, contaId, mascara);
  }
}

/* -------------------------------------------------------------------------- */
/*                                 A page's sums                               */
/* -------------------------------------------------------------------------- */

/** A counter of the run that a page adds to. */
type ContadorExecucaoPrecoAmazon = Exclude<
  keyof ContagensExecucaoPrecoAmazon,
  'porChave' | 'limiteTaxa'
>;

/** Every counter of the run, read off its schema: a new counter is summed with no edit here. */
const CONTADORES_EXECUCAO_PRECO_AMAZON = Object.keys(
  contagensExecucaoPrecoAmazonSchema.shape,
).filter((c): c is ContadorExecucaoPrecoAmazon => c !== 'porChave' && c !== 'limiteTaxa');

/** What one page adds to the run (module header, "A page's sums"). */
export interface SomaPaginaExecucaoPrecoAmazon {
  /** The page's counters (any subset: an absent one adds 0), its refusals by motivo, its lowest rate limit. */
  readonly contagens: Readonly<Partial<Record<ContadorExecucaoPrecoAmazon, number>>> & {
    readonly porChave?: Readonly<Record<string, number>>;
    readonly limiteTaxa?: number | null;
  };
  /** The page's decrease sample, `sku:antes>depois`. */
  readonly amostra: readonly string[];
}

/** A page's count, checked: a non-negative safe integer, or a `RangeError` naming the counter. */
function contagemDaPagina(valor: number | undefined, nome: string): number {
  if (valor === undefined) return 0;
  if (!Number.isSafeInteger(valor) || valor < 0) {
    throw new RangeError(`execucaoPrecoFirestore.ts: a contagem ${nome} da página não é válida`);
  }
  return valor;
}

/** The lower of two rate limits, `null` standing for "none seen". */
function menorLimite(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/**
 * The run's counters and sample once `pagina` is added (module header, "A
 * page's sums"). Pure.
 *
 * @throws {RangeError} a page count that is not a non-negative safe integer.
 * @throws a `ZodError` for a sum the run schema refuses (a rate limit below 0).
 */
export function somarPaginaNaExecucaoPrecoAmazon(
  execucao: Pick<ExecucaoPrecoAmazon, 'contagens' | 'amostraReducoes'>,
  pagina: SomaPaginaExecucaoPrecoAmazon,
): Pick<ExecucaoPrecoAmazon, 'contagens' | 'amostraReducoes'> {
  const base = execucao.contagens;
  const soma: Record<string, unknown> = {};
  for (const contador of CONTADORES_EXECUCAO_PRECO_AMAZON) {
    soma[contador] = base[contador] + contagemDaPagina(pagina.contagens[contador], contador);
  }
  const porChave = new Map<string, number>(Object.entries(base.porChave));
  for (const [motivo, n] of Object.entries(pagina.contagens.porChave ?? {})) {
    porChave.set(motivo, (porChave.get(motivo) ?? 0) + contagemDaPagina(n, motivo));
  }
  soma.porChave = Object.fromEntries(porChave);
  soma.limiteTaxa = menorLimite(base.limiteTaxa, pagina.contagens.limiteTaxa ?? null);
  return {
    contagens: contagensExecucaoPrecoAmazonSchema.parse(soma),
    amostraReducoes: amostraReducoesPrecoAmazon(
      [],
      [...execucao.amostraReducoes, ...pagina.amostra],
    ),
  };
}
