/**
 * The PRODUCER CORE of the Amazon listings flows (step 13, PR 13-b), pure: a
 * queue producer's enqueue rules, with the queue BINDING handed in. The stock
 * queue's producer (`estoque/produtorEstoque.ts`) binds all of it to its
 * payload contract, its task names, its valve class and its transport. The
 * batch takes ANY single enqueue, so a flow whose tasks ride another queue
 * runs it over that queue's own producer (the jobs producer
 * `feeds/agendadorLotes.ts` keeps its own enqueue and delays).
 *
 * Nothing here reads the process environment or imports the Cloud Tasks SDK:
 * the transport is STRUCTURAL ({@link FilaListingAmazon}), resolved per
 * enqueue by the binding, and the SDK knowledge is `core/filaTarefas.ts`'s.
 *
 * ## One enqueue: {@link enfileirarNaFilaListingAmazon}
 *
 * A task NAME is a Cloud Tasks id: a create whose id the queue already holds is
 * refused for about an hour after that task RAN, so a name makes an enqueue
 * idempotent (rule 7 tier 0) and a wrong name swallows a later legitimate one.
 *
 *  - With the binding's valve closed, the enqueue rejects with the binding's
 *    OWN class and the queue is never resolved.
 *  - Otherwise the queue is resolved and the enqueue runs through the shared
 *    transient naming (`enfileirarNomeandoFalhaTransitoriaAmazon`).
 *  - A NAMED enqueue whose id the queue already holds answers `ja-enfileirada`
 *    (already durable), never an error. An unnamed enqueue's 409 is never
 *    "already there": Cloud Tasks can answer it only ABORTED, a transient.
 *  - No enqueue sends a `uri` (under the emulator a supplied one would ship the
 *    task to the deployed function).
 *
 * ## Delays: WHOLE seconds ({@link atrasoDaFilaListingAmazon})
 *
 * A delay is handed to Cloud Tasks as `scheduleDelaySeconds`: `undefined` or
 * `0` ⇒ none; a negative, fractional or non-finite value is a `RangeError`,
 * nothing enqueued. So is a delay past the binding's maximum: a delay in that
 * range is a value handed over in MILLISECONDS.
 *
 * ## The batch: {@link enfileirarLoteListingAmazon}
 *
 * It starts the items in list order, at most {@link LARGURA_LOTE_LISTING_AMAZON}
 * in flight, each through the caller's ONE enqueue. Before STARTING each one it
 * asks `continuar` (a producer's deadline): `false` ⇒ nothing more is started,
 * and the ones never tried are counted (`naoTentadas`) so the caller can tell a
 * complete batch from a cut one. The first rejection stops every worker from
 * starting another item; the ones already in flight are awaited (never left
 * running behind an answer), and the rejection of the EARLIEST item in list
 * order is rethrown unchanged. When every item is named, re-running a cut or
 * failed batch enqueues only what is missing.
 */
import {
  ehTarefaJaExistenteAmazon,
  enfileirarNomeandoFalhaTransitoriaAmazon,
} from '../core/filaTarefas';

/** The most enqueues one batch keeps in flight (module header, "The batch"). */
export const LARGURA_LOTE_LISTING_AMAZON = 16;

/** What one enqueue carries besides the payload: a delay, and a task id when named. */
export interface OpcoesDaTarefaListingAmazon {
  readonly scheduleDelaySeconds?: number;
  readonly id?: string;
}

/**
 * The transport, as a root binds it — structurally, the Admin SDK's
 * `TaskQueue<T>`, of which only `enqueue(data, opts?)` is used.
 */
export interface FilaListingAmazon<T> {
  enqueue(payload: T, opcoes?: OpcoesDaTarefaListingAmazon): Promise<void>;
}

/** What a NAMED enqueue did. */
export type ResultadoEnfileiramentoListingAmazon = 'enfileirada' | 'ja-enfileirada';

/** What a batch did, counted (module header, "The batch"). */
export interface ResultadoLoteListingAmazon {
  readonly enfileiradas: number;
  readonly jaEnfileiradas: number;
  /** Items never started because `continuar` answered `false`. */
  readonly naoTentadas: number;
}

/** The queue BINDING one enqueue runs through (module header, "One enqueue"). */
export interface VinculoFilaListingAmazon<T> {
  /** The queue, resolved PER ENQUEUE and only when the valve is open. */
  readonly fila: () => FilaListingAmazon<T>;
  /** The queue valve, as the root read it: read at EVERY enqueue. */
  readonly desligado: boolean;
  /** The binding's OWN class for a closed valve: nothing was enqueued. */
  readonly desligada: () => Error;
}

/** A binding's delay bound (module header, "Delays"), and how its refusals name it. */
export interface LimiteDeAtrasoListingAmazon {
  /** The binding's module, as its refusals name it. */
  readonly rotulo: string;
  /** The longest delay the binding accepts, in seconds. */
  readonly maximoS: number;
  /** That bound in words, as its refusal names it. */
  readonly descricao: string;
}

/**
 * A delay as the transport takes it (module header, "Delays"): `undefined` or
 * `0` ⇒ none, a whole number of seconds up to the binding's maximum ⇒
 * `scheduleDelaySeconds`.
 *
 * @throws {RangeError} a negative, fractional, non-finite or ms-sized delay.
 */
export function atrasoDaFilaListingAmazon(
  atrasoS: number | undefined,
  limite: LimiteDeAtrasoListingAmazon,
): number | undefined {
  if (atrasoS === undefined) return undefined;
  if (!Number.isSafeInteger(atrasoS) || atrasoS < 0) {
    throw new RangeError(`${limite.rotulo}: atraso fora de segundos inteiros não negativos`);
  }
  if (atrasoS > limite.maximoS) {
    throw new RangeError(
      `${limite.rotulo}: atraso acima de ${limite.descricao} (milissegundos no lugar de segundos?)`,
    );
  }
  return atrasoS === 0 ? undefined : atrasoS;
}

/** The transport's options: the id when named, the delay when positive; none at all otherwise. */
export function opcoesDaTarefaListingAmazon(
  id: string | null,
  atrasoS: number | undefined,
): OpcoesDaTarefaListingAmazon | undefined {
  if (id === null && atrasoS === undefined) return undefined;
  return {
    ...(id === null ? {} : { id }),
    ...(atrasoS === undefined ? {} : { scheduleDelaySeconds: atrasoS }),
  };
}

/**
 * ONE enqueue of `tarefa` through `vinculo` (module header, "One enqueue"),
 * NAMED `id` unless `id` is `null`, with the transport's `extras`.
 */
export async function enfileirarNaFilaListingAmazon<T>(
  vinculo: VinculoFilaListingAmazon<T>,
  tarefa: T,
  id: string | null,
  extras: OpcoesDaTarefaListingAmazon | undefined,
): Promise<ResultadoEnfileiramentoListingAmazon> {
  if (vinculo.desligado) throw vinculo.desligada();
  let jaExiste = false;
  await enfileirarNomeandoFalhaTransitoriaAmazon(async () => {
    try {
      await (extras === undefined
        ? vinculo.fila().enqueue(tarefa)
        : vinculo.fila().enqueue(tarefa, extras));
    } catch (err) {
      // Read BEFORE the transient naming, which would call this 409 a
      // hiccup: Cloud Tasks already holds this name (tier 0). Only a NAMED
      // enqueue can meet it; an unnamed one's 409 is an ABORTED, a transient.
      if (id !== null && ehTarefaJaExistenteAmazon(err)) {
        jaExiste = true;
        return;
      }
      throw err;
    }
  });
  return jaExiste ? 'ja-enfileirada' : 'enfileirada';
}

/**
 * Every item of `itens` through `enviar`, in list order, at most
 * {@link LARGURA_LOTE_LISTING_AMAZON} in flight, `continuar` asked before
 * STARTING each (module header, "The batch").
 */
export async function enfileirarLoteListingAmazon<P extends object>(
  itens: readonly P[],
  enviar: (item: P) => Promise<ResultadoEnfileiramentoListingAmazon>,
  continuar: () => boolean = () => true,
): Promise<ResultadoLoteListingAmazon> {
  let proximo = 0;
  let parar = false;
  let enfileiradas = 0;
  let jaEnfileiradas = 0;
  let naoTentadas = 0;
  const largura = Math.min(LARGURA_LOTE_LISTING_AMAZON, Math.max(1, itens.length));
  /** The item each worker started last: a rejected worker failed on it. */
  const ultimoDoTrabalhador: number[] = [];
  const trabalhador = async (t: number): Promise<void> => {
    for (;;) {
      if (parar) return;
      const indice = proximo;
      const item = itens[indice];
      if (item === undefined) return;
      if (!continuar()) {
        // The deadline: nothing more starts, and everything left is counted.
        parar = true;
        naoTentadas = itens.length - indice;
        return;
      }
      proximo += 1;
      ultimoDoTrabalhador[t] = indice;
      try {
        const r = await enviar(item);
        if (r === 'ja-enfileirada') jaEnfileiradas += 1;
        else enfileiradas += 1;
      } catch (erro) {
        // Never contained: every worker stops starting another item, and the
        // rejection leaves through `allSettled` below.
        parar = true;
        throw erro;
      }
    }
  };
  // `allSettled`, never `all`: `all` would answer on the first rejection
  // while the siblings' enqueues were still running behind the answer.
  const saidas = await Promise.allSettled(
    Array.from({ length: largura }, (_, t) => trabalhador(t)),
  );
  let primeira: { readonly indice: number; readonly erro: unknown } | null = null;
  for (const [t, saida] of saidas.entries()) {
    if (saida.status !== 'rejected') continue;
    const indice = ultimoDoTrabalhador[t] ?? 0;
    if (primeira === null || indice < primeira.indice) {
      primeira = { indice, erro: saida.reason };
    }
  }
  if (primeira !== null) throw primeira.erro;
  return { enfileiradas, jaEnfileiradas, naoTentadas };
}
