import { ZodError } from 'zod';
import {
  CODIGO_ERRO_LI,
  INTEGRACAO_TIPO,
  MAX_PRODUTOS_ENVIO_ESTOQUE_LI,
  RESULTADO_ENVIO_ESTOQUE_LI,
  type RespostaEnvioEstoqueLi,
  type ResultadoEnvioEstoqueLi,
} from '@delfrance/schemas';
import {
  LojaIntegradaClientHttpError,
  LojaIntegradaClientNetworkError,
  LojaIntegradaClientRespostaInvalidaError,
  LojaIntegradaClientTempoEsgotadoError,
} from '@/lib/loja-integrada/client';

import { makeRowKeyer } from '../../push/types';
import type {
  StockPushChannelResult,
  StockPushInput,
  StockPushOutcome,
  StockPushProvider,
  StockPushRow,
} from '../types';

/**
 * Loja Integrada stock push — `POST /api/marketplace/loja-integrada/enviar-estoque`
 * on the apps/loja-integrada backend (master plan step 12).
 *
 * ⚠️ UNREACHABLE until the step-22 caps flip: the caps row still says
 * `implementado: false`, and `resolveStockPushProvider` asks the caps BEFORE the
 * provider map, so every Loja Integrada conta gets the placeholder's
 * `canal-nao-implementado` row today (`caps/registriesAlinhadas.test.ts` pins
 * that middle state, the Shopee rows-first precedent).
 *
 * ⚠️ The backend QUEUES, it does not send. Each row it answers is one CHILD
 * (every Loja Integrada child is its own listing): `enfileirado` means its send
 * task is on the channel's stock queue, and the send run decides minutes later,
 * from fresh reads, whether anything is written. So this provider never says
 * `enviado` — the shared dialog renders `enfileirado` with its own label.
 *
 * A thin adapter otherwise, like the other providers: the backend owns every
 * row's pt-BR `mensagem` and its skip vocabulary; the answer is READ against the
 * shared contract (`respostaEnvioEstoqueLiSchema` in `@delfrance/schemas`), so a
 * malformed or older backend's answer is a failure row, never a cast.
 *
 * - **`reenviarComErro` is not forwarded**: this channel keeps no refusal latch
 *   for a manual push to bypass, and the route's strict body has no such key.
 * - **The selection is sliced** into requests of at most
 *   `MAX_PRODUTOS_ENVIO_ESTOQUE_LI` distinct ids, sent one after the other: a
 *   supported channel receives the WHOLE /produtos selection (`push/run.ts`),
 *   and the body's cap would otherwise make the client throw and break every
 *   conta after this one.
 * - ⚠️ **At most ONE slice per run may queue anything.** The backend bounds the
 *   children ONE request queues (`LI_SELECAO_EXCEDE_LIMITE` refuses a slice
 *   whole above it) so that a manual push never holds the channel's single-file
 *   stock queue long enough to delay the sends a sale triggers; that bound is
 *   per REQUEST, so N slices would queue N times it. Once a slice MAY have
 *   queued something — a row `enfileirado`, a `falha` row (it may have
 *   landed), or an outcome nobody can confirm — every later id is
 *   `nao-tentado` ({@link MOTIVO_UM_LOTE_POR_ENVIO_LI}), with the sentence for
 *   WHY: a queued row is a fact, anything else only a possibility, and the
 *   rows above it already say the outcome is unconfirmed. A slice that provably
 *   queued nothing (only skips, or a refusal) lets the next one go: a sparse
 *   /produtos selection still reaches the ids of this channel it carries.
 * - **An id an earlier slice already answered** — a selected child its
 *   selected parent's expansion reached first — is left out of every later
 *   slice: neither sent again nor marked `nao-tentado`, so it keeps the one row
 *   it has. (The other order, a child answered first and its parent sent
 *   later, still gets the backend's second row for it: the parent's request is
 *   needed for its other children, and a backend row is never dropped — it may
 *   be a real queue.)
 * - **A conta-level answer is one row per requested id of that slice**: the
 *   backend switched off (read switch, stock valve, its task queues) or the
 *   slice over the children bound ⇒ `nao-tentado` (nothing was queued); any
 *   other refusal ⇒ `falha` with the backend's sentence.
 * - **An outcome nobody can confirm** — a 2xx the contract refuses, a 5xx, the
 *   deadline, the network — is `falha`, saying it may have been queued and that
 *   repeating is safe (inside the minute the backend's task names collide).
 * - **A cancel** returns the slices already answered and nothing more; the run
 *   reports the cancellation itself.
 *
 * ⚠️ Narrowed by CLASS, subclasses FIRST: `RespostaInvalida` extends the HTTP
 * error and `TempoEsgotado` the network error. Anything unrecognised is
 * rethrown (root `CLAUDE.md` rule 6).
 */

/** The selected produto ids one request carries at most (the route's body cap). */
export const FATIA_ENVIO_ESTOQUE_LI = MAX_PRODUTOS_ENVIO_ESTOQUE_LI;

/** The motivo of an id left out because an earlier slice of this run queued, or may have (header). */
export const MOTIVO_UM_LOTE_POR_ENVIO_LI = 'um-lote-por-envio';

/**
 * Why a slice of this run stops the later ones: it queued a child (a fact), or
 * its outcome is UNKNOWN — a `falha` row, a 5xx, the deadline, the network, a
 * 2xx this build cannot read (a possibility).
 */
type LoteDaRodada = 'enfileirado' | 'incerto';

/**
 * Its copy, one sentence per cause: nothing was attempted for this id, and why
 * repeating is the fix. ⚠️ Never claim the queue for a cause that only MAY
 * have queued: the rows above it say the outcome is unknown.
 */
export const MENSAGEM_UM_LOTE_POR_ENVIO_LI: Readonly<Record<LoteDaRodada, string>> = {
  enfileirado:
    'Não tentado: cada envio enfileira no máximo um lote por conta da Loja Integrada, para não ' +
    'atrasar as outras atualizações de estoque da loja, e este envio já enfileirou o seu. ' +
    'Selecione estes produtos e envie de novo.',
  incerto:
    'Não tentado: cada envio enfileira no máximo um lote por conta da Loja Integrada, para não ' +
    'atrasar as outras atualizações de estoque da loja, e não foi possível confirmar se o lote ' +
    'anterior deste envio foi enfileirado. Selecione estes produtos e envie de novo.',
};

/** The row a backend answer's `resultado` becomes — `enfileirado` stays itself. */
const OUTCOME_DO_RESULTADO: Record<ResultadoEnvioEstoqueLi, StockPushOutcome> = {
  [RESULTADO_ENVIO_ESTOQUE_LI.enfileirado]: 'enfileirado',
  [RESULTADO_ENVIO_ESTOQUE_LI.pulado]: 'pulado',
  [RESULTADO_ENVIO_ESTOQUE_LI.falha]: 'falha',
};

/**
 * The codes that mean NOTHING was attempted for the whole slice: the backend is
 * switched off for this (until the migration, or by configuration), or the
 * slice reaches more children than one push may queue. The backend's sentence
 * says which, and what to do.
 */
const CODIGOS_NAO_TENTADO: ReadonlySet<string> = new Set<string>([
  CODIGO_ERRO_LI.chamadasDesligadas,
  CODIGO_ERRO_LI.estoqueDesligado,
  CODIGO_ERRO_LI.tarefasDesligadas,
  CODIGO_ERRO_LI.selecaoExcedeLimite,
]);

/** No client: logged out, or this build cannot reach the backend safely. */
export const MENSAGEM_SEM_CLIENTE_LI =
  'O backend da Loja Integrada não está disponível nesta sessão (faça login de novo ou avise o suporte).';

/** The network copy — the other providers' sentence, naming this channel's backend. */
export const MENSAGEM_REDE_LI = 'Não foi possível contatar o backend da Loja Integrada.';

/** A body the shared schema refused before any request (a malformed conta or produto id). */
export const MENSAGEM_SELECAO_INVALIDA_LI =
  'A seleção tem um identificador que o backend da Loja Integrada não aceita. Nada foi enfileirado.';

/**
 * Appended when the outcome is UNKNOWN — the route may have queued some children
 * before the answer was lost or unreadable. Repeating is safe: inside the same
 * minute the task names collide, after it each child gets one more send run,
 * which re-reads everything before writing anything.
 */
export const SUFIXO_RESULTADO_INCERTO_LI =
  ' Não foi possível confirmar se o estoque foi enfileirado; repetir o envio é seguro.';

/** What a failed slice turned into. */
type FalhaDaFatia =
  | { readonly tipo: 'cancelado' }
  | {
      readonly tipo: 'fatia';
      readonly outcome: 'falha' | 'nao-tentado';
      readonly motivo: string;
      readonly mensagem: string;
      /** The outcome is UNKNOWN: the route may have queued some children (header). */
      readonly podeTerEnfileirado: boolean;
    };

/** Classify a failed push call. `null` ⇒ not ours: the caller rethrows. */
function classificarFalha(err: unknown, signal: AbortSignal | undefined): FalhaDaFatia | null {
  // A cancel is told apart by the SIGNAL, never by the error's shape (the
  // `lib/shopee/falhaDoEnvio.ts` rule): the caller's abort comes back as the
  // abort itself, and a real network failure while nobody cancelled stays one.
  if (
    signal?.aborted === true &&
    (err instanceof LojaIntegradaClientNetworkError ||
      (err instanceof DOMException && err.name === 'AbortError'))
  ) {
    return { tipo: 'cancelado' };
  }
  if (err instanceof ZodError) {
    return {
      tipo: 'fatia',
      outcome: 'falha',
      motivo: 'selecao-invalida',
      mensagem: MENSAGEM_SELECAO_INVALIDA_LI,
      podeTerEnfileirado: false,
    };
  }
  // ⚠️ BEFORE the HTTP error, its parent: a 2xx this build cannot read may well
  // have queued every child it was about to describe.
  if (err instanceof LojaIntegradaClientRespostaInvalidaError) {
    return {
      tipo: 'fatia',
      outcome: 'falha',
      motivo: 'resposta-invalida',
      mensagem: err.message + SUFIXO_RESULTADO_INCERTO_LI,
      podeTerEnfileirado: true,
    };
  }
  if (err instanceof LojaIntegradaClientHttpError) {
    if (err.code !== null && CODIGOS_NAO_TENTADO.has(err.code)) {
      return {
        tipo: 'fatia',
        outcome: 'nao-tentado',
        motivo: err.code,
        mensagem: err.message,
        podeTerEnfileirado: false,
      };
    }
    // A 5xx may come after some tasks landed (the route's own header).
    const incerto = err.status >= 500;
    return {
      tipo: 'fatia',
      outcome: 'falha',
      motivo: err.code ?? 'erro-http',
      mensagem: incerto ? err.message + SUFIXO_RESULTADO_INCERTO_LI : err.message,
      podeTerEnfileirado: incerto,
    };
  }
  // ⚠️ BEFORE the network error, its parent.
  if (err instanceof LojaIntegradaClientTempoEsgotadoError) {
    return {
      tipo: 'fatia',
      outcome: 'falha',
      motivo: 'tempo-esgotado',
      mensagem: err.message + SUFIXO_RESULTADO_INCERTO_LI,
      podeTerEnfileirado: true,
    };
  }
  if (err instanceof LojaIntegradaClientNetworkError) {
    return {
      tipo: 'fatia',
      outcome: 'falha',
      motivo: 'rede',
      mensagem: MENSAGEM_REDE_LI + SUFIXO_RESULTADO_INCERTO_LI,
      podeTerEnfileirado: true,
    };
  }
  return null;
}

/** `ids` in consecutive slices of at most `tamanho`, in order. */
function fatiar(ids: readonly string[], tamanho: number): string[][] {
  const fatias: string[][] = [];
  for (let i = 0; i < ids.length; i += tamanho) fatias.push(ids.slice(i, i + tamanho));
  return fatias;
}

export const lojaIntegradaStockProvider: StockPushProvider = {
  tipos: [INTEGRACAO_TIPO.lojaIntegrada],

  async enviarEstoque(input: StockPushInput): Promise<StockPushChannelResult> {
    const { integracao, deps } = input;
    const client = deps.lojaIntegrada;
    // Distinct, in selection order: `solicitados` on the backend counts the same.
    const ids = [...new Set(input.produtoIds)];

    const chave = makeRowKeyer();
    const linha = (
      over: Partial<StockPushRow> & Pick<StockPushRow, 'produtoId'>,
    ): StockPushRow => ({
      key: chave(over.produtoId, integracao.id, over.anuncioId ?? null),
      produtoNome: input.nomePorProdutoId.get(over.produtoId) ?? null,
      integracaoId: integracao.id,
      integracaoNome: integracao.nome,
      anuncioId: null,
      linkDocId: null,
      outcome: 'falha',
      motivo: null,
      mensagem: '',
      quantidade: null,
      ...over,
    });

    /** One slice's answer, as display rows. */
    const linhasDaResposta = (res: RespostaEnvioEstoqueLi): StockPushRow[] => {
      const rows = res.listings.map((l) =>
        linha({
          // The CHILD — its own listing on this channel; the store product id
          // tells two children of one family apart.
          produtoId: l.produtoId,
          // The child's own name when the backend read it; else the name of the
          // id the operator SELECTED (its parent, or itself).
          produtoNome:
            l.produtoNome ??
            input.nomePorProdutoId.get(l.solicitadoId) ??
            input.nomePorProdutoId.get(l.produtoId) ??
            null,
          anuncioId: l.idLi,
          outcome: OUTCOME_DO_RESULTADO[l.resultado],
          motivo: l.motivo,
          mensagem: l.mensagem,
        }),
      );
      // A selected id none of whose children made a row: ONE row, under the id
      // the operator asked for.
      for (const p of res.produtosSemEnvio) {
        rows.push(
          linha({
            produtoId: p.produtoId,
            produtoNome: p.produtoNome ?? input.nomePorProdutoId.get(p.produtoId) ?? null,
            outcome: 'pulado',
            motivo: p.motivo,
            mensagem: p.mensagem,
          }),
        );
      }
      return rows;
    };

    /** A slice-level verdict, as one row per requested id of that slice. */
    const fatiaInteira = (
      fatia: readonly string[],
      outcome: StockPushOutcome,
      motivo: string,
      mensagem: string,
    ): StockPushRow[] => fatia.map((produtoId) => linha({ produtoId, outcome, motivo, mensagem }));

    if (!client) {
      return {
        pausadoAte: null,
        rows: fatiaInteira(ids, 'falha', 'sem-cliente', MENSAGEM_SEM_CLIENTE_LI),
      };
    }

    const rows: StockPushRow[] = [];
    // Why a slice of this run MAY have queued anything (header): then no other slice goes.
    let lote: LoteDaRodada | null = null;
    // Every id a slice of this run already answered: no later slice answers it again (header).
    const respondidos = new Set<string>();
    const registrar = (novas: readonly StockPushRow[]): void => {
      rows.push(...novas);
      for (const r of novas) respondidos.add(r.produtoId);
    };
    for (const selecionados of fatiar(ids, FATIA_ENVIO_ESTOQUE_LI)) {
      // Cancelled between slices: what was answered stands, the run reports it.
      if (input.signal?.aborted === true) break;
      const fatia = selecionados.filter((id) => !respondidos.has(id));
      if (fatia.length === 0) continue;
      if (lote !== null) {
        registrar(
          fatiaInteira(
            fatia,
            'nao-tentado',
            MOTIVO_UM_LOTE_POR_ENVIO_LI,
            MENSAGEM_UM_LOTE_POR_ENVIO_LI[lote],
          ),
        );
        continue;
      }
      try {
        const res = await client.enviarEstoque(
          { contaId: integracao.id, produtoIds: fatia },
          input.signal === undefined ? {} : { sinal: input.signal },
        );
        registrar(linhasDaResposta(res));
        // A queued row is a fact and wins over a `falha` beside it (header).
        if (res.listings.some((l) => l.resultado === RESULTADO_ENVIO_ESTOQUE_LI.enfileirado)) {
          lote = 'enfileirado';
        } else if (res.listings.some((l) => l.resultado === RESULTADO_ENVIO_ESTOQUE_LI.falha)) {
          lote = 'incerto';
        }
      } catch (err) {
        const falha = classificarFalha(err, input.signal);
        if (falha === null) throw err; // never a generic catch (repo rule 6)
        if (falha.tipo === 'cancelado') break;
        registrar(fatiaInteira(fatia, falha.outcome, falha.motivo, falha.mensagem));
        if (falha.podeTerEnfileirado) lote = 'incerto';
      }
    }
    // This channel's backend never pauses a conta for a quota: it queues.
    return { rows, pausadoAte: null };
  },
};
