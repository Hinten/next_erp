/**
 * ONE price send run (master plan step 13, PR 13-d): one linked CHILD produto of one conta, the
 * price the ERP gives it (`precoAlvoLi`, `@delfrance/schemas`) sent to the matching Loja Integrada
 * variation through the write engine (`core/escrita.ts`), the ONLY module that sends a write. The
 * decisions are the pure plan's (`planoPrecoLi.ts`); the ERP reads are `leituraPrecoErp.ts`'s; the
 * conta's tabelas `tabelasLi.ts`'s; the clear's forma `configPrecoLi.ts`'s; the refusal aviso
 * `avisosPreco.ts`'s; the one follow-up's producer `agendadorPreco.ts`'s. The order and the shape
 * are the stock run's (`estoque/processarEstoque.ts`), step for step.
 *
 * ## The order of one run — every skip before the write context
 *
 *  1. The payload, parsed STRICT (`tarefaPrecoLiSchema`: ids only — a price, or any key the
 *     schema does not name, is refused): `payload-invalido`, zero reads.
 *  2. The valve FIRST (`iniciarEscritaLi`, the `preco` flow): `off` — recognised or not — is
 *     `desligado`, zero reads.
 *  3. The clear's forma (`LOJA_INTEGRADA_PRECO_PROMO_LIMPO`, from the environment the entry point
 *     passes): unset or blank ⇒ `nulo`; anything but an exact forma refuses EVERY run
 *     (`forma-invalida`, one ERROR line, zero reads), in every mode.
 *  4. The conta (the cached reader): gone, not a Loja Integrada conta, inactive, or no normal
 *     tabela (`sem-tabela`, one WARNING) ⇒ skipped. A BULK send (`reconcile`, `atualizacao`)
 *     carries the tabelas its run priced at: a cached conta naming others is read once more past
 *     the cache (`invalidarContaEmCache`, this instance), and a conta that still names others drops
 *     the send (`tabela-mudou`, one WARNING) — its prices were computed from tabelas the conta no
 *     longer uses. Every other origin reads the conta's tabelas when it runs.
 *  5. The produto (masked to what the price function reads: no custo) and its own links,
 *     together. No produto ⇒ skipped.
 *  6. The links alone (`vinculoDaContaLi`): no counting child link, a parent's, a root with no
 *     grades, or two store products ⇒ skipped WITHOUT reading the parent.
 *  7. Only NOW the parent, when the produto names one and its id names a document.
 *  8. The target (`precoAlvoLi`, over the conta's RAW tabela pair): held (`sem-preco`, `ilegivel`,
 *     `pai-ausente`) ⇒ one WARNING with the reason; the store keeps its own price.
 *  9. The duplicate-link probe: another produto holding a counting link of this conta to the same
 *     store product ⇒ one WARNING, nothing sent.
 * 10. The target `<conta>:<store id>` and its decision (`decidirAlvo`: `on`, or why not).
 * 11. Only NOW the write context (the read switch first, then the conta, one credential read):
 *     its refusals DROP, with the class — there is no failure store.
 * 12. The deciding GET (`lerBaseLi`, the produto detail `GET /v1/produto/{id}/`): a 404 ⇒
 *     `ausente` (one WARNING).
 * 13. The plan (`planoPrecoLi`): the guard on the detail as read (its id, a variation, removido and
 *     bloqueado, a boolean `sob_consulta`), then the decision in integer centavos — an unreadable
 *     current price, already reflected (resolves the refusal aviso under `on`), a lowering the task
 *     may not make (`nao-baixado`, nothing sent, no aviso read), or the builder inputs to send.
 * 14. The ONE write, by origin ({@link tipoEscritaDaOrigemPrecoLi}): an event, a manual push, a
 *     publish and a `deriva` follow-up write `preco-produto` and are READ BACK (two intervals
 *     later); a reconcile and an "Atualizar preços" run write `preco-produto-lote`, with NO
 *     read-back call (the nightly by-id read is theirs; the engine's `eco` line is the only
 *     same-run evidence). Not `on`: the engine's one diff line, nothing sent. A store custo the
 *     restore line cannot carry verbatim blocks the write (`sem-restauracao`, one ERROR, `on`
 *     only); one the package's builder had to omit is sent without it, with ONE WARNING
 *     (`custo-omitido`) once the engine has answered.
 * 15. A landed bulk write resolves the refusal aviso under `on`. A landed `preco-produto` is read
 *     back: as written ⇒ resolved; a drift — or a read-back that could not be made, or that names
 *     another product (fail open) — ⇒ ONE `deriva` follow-up (generation 1) through the producer;
 *     a generation-1 run never enqueues another (one ERROR), so no loop is possible, and under
 *     `on`, when its read-back was VERIFIED, it raises the aviso `nao-refletido`.
 *
 * ## What a run costs (Firestore operations / credential reads / store calls)
 *
 * Every skip costs ZERO credential reads and ZERO store calls: the write context comes after
 * every skip decision. For a CHILD: a link skip reads the conta, the produto and its links (3); a
 * held target one more (the parent, 4 — none for a parent id that names no document); a duplicate
 * the two probe queries (6). A send pays those 6 ERP operations (a ROOT, 5: no parent), the
 * context's credential read, one credential re-read per store call, and — only under `on`, and
 * only on an outcome that resolves (reflected, written and read back as written, a landed bulk
 * write) — one read of the refusal aviso (written only when it is OPEN). A refused lowering and a
 * drift read no aviso. No Firestore write on success, ever.
 *
 * ## Errors (deterministic outcomes RETURN, transient failures THROW — every retry re-derives
 * everything from a fresh read, and the price sent is absolute, never a delta)
 *
 *  - a 429 (`LiThrottleError`) or a 5xx: THROWN, on the read and on the write — a PUT answered
 *    either may have landed, so the run is closed and the retry's own GET decides;
 *  - a write refused with another 3xx/4xx: proves nothing landed; rethrown until the queue's LAST
 *    attempt, then `recusado`, one ERROR line and, under `on`, the aviso `recusado`;
 *  - a 401/403: on a deciding read, the conta is PARKED (`tratarFalhaDeAutenticacao`) and the run
 *    drops; on the write, the next deciding read on the same pinned credential is the confirming
 *    read — refused too ⇒ parked; reading fine ⇒ the write's refusal follows the rule above; not
 *    found ⇒ nothing to conclude, rethrown. A 401 for an older token rethrows (the retry reads
 *    with the new one);
 *  - the deciding read answered OFF its schema (`formato`: a detail missing one of its nine leaves)
 *    drops at once with one ERROR (the retry would read the same detail); an empty or non-JSON 200
 *    is the transport's and rethrows; another non-transient 3xx/4xx on a read rethrows until the
 *    last attempt, then drops with one ERROR (no aviso: that aviso is a refused WRITE);
 *  - the credential swapped under the pin, the write deadline (`PrazoDeEscritaEsgotadoLiError`),
 *    the network, our own `LiConfigError`, gRPC and the builder's `RangeError` (a target past its
 *    exact round trip): THROWN;
 *  - the read switch off (`LiChamadasDesligadasError`): dropped — the context logs its line.
 *
 * ## Rule 7 — class
 *
 * Serialised by the price queue (one dispatch at a time, one instance — narrowed, not absolute:
 * an abandoned dispatch or a rare duplicate delivery can overlap, and no write starts past the
 * task deadline); ONE write per run, decided by the deciding read just before it with no pacer
 * interval between them; the target re-derived from the ERP on every attempt, never carried in
 * the payload; the custo and `sob_consulta` echoed from that same read. The store takes no version
 * on a write, so an edit in the gap between the deciding read and the write is the residual —
 * overwritten by design for the price leaves (the ERP is the source of the price), and for the
 * echoed custo and `sob_consulta`, which a store-panel edit in that gap can lose. Firestore: only
 * the refusal aviso (tier 2, the run's dispatch start as its clock) and the park (tier 1). No
 * transaction.
 *
 * ## Rollback
 *
 * The deciding read's restore line carries the detail's nine leaves, the four prices verbatim.
 * Re-PUT its `preco_cheio` and `preco_promocional` to undo a send — through the same strict route:
 * a prior price with more than two decimal places, or a prior `null` or 0 full price, cannot be
 * sent, and a prior `null` or 0 promotion goes back as the configured clear.
 *
 * ⚠️ This module must never name the Admin SDK's multi-document read-and-write call, nor a write
 * operation of the package — not even in a comment (`estrutura.test.ts`) — and never reads the
 * process environment: `deps.ambiente` is the environment, passed in.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { TASK_MAX_ATTEMPTS } from '@delfrance/data/admin/notifications';
import {
  LiAuthError,
  LiHttpError,
  LiSchemaError,
  LiThrottleError,
} from '@delfrance/integrations-loja-integrada';
import {
  type EnvioPrecoLi,
  type FormaPromoLimpaLi,
  INTEGRACAO_TIPO,
  MOTIVO_PRECO_RECUSADO_LI,
  ORIGEM_TAREFA_PRECO_LI,
  type TarefaPrecoLi,
  origemEmLotePrecoLi,
  precoAlvoLi,
  tarefaPrecoLiSchema,
  vinculoDaContaLi,
} from '@delfrance/schemas';

import { invalidarContaEmCache, lerContaEmCache } from '../core/contaCache';
import {
  type ContextoEscritaLojaIntegrada,
  loadLojaIntegradaContextoEscrita,
} from '../core/contextoEscrita';
import {
  LiChamadasDesligadasError,
  LiContaInativaError,
  LiContaNaoEncontradaError,
  LiContaParadaError,
  LiCredencialAusenteError,
  LiCredencialInvalidaError,
} from '../core/erros';
import {
  type BaseEscritaPrecoLi,
  type BaseLidaPrecoLi,
  type DestinoEscritaLi,
  type InicioEscritaLi,
  type MotorEscritaLi,
  type PayloadEscritaLi,
  type ResultadoEscritaLi,
  conferirEscritaLi,
  criarMotorEscritaLi,
  escreverLi,
  iniciarEscritaLi,
  lerBaseLi,
  lerDeVoltaLi,
} from '../core/escrita';
import { tratarFalhaDeAutenticacao } from '../core/estacionamento';
import {
  type AlvoLi,
  FLUXO_LI,
  MODO_LI,
  type MotivoDryRunLi,
  chaveDoAlvo,
  decidirAlvo,
} from '../core/valvulas';
import type { DepsEscritaLi } from '../rastreio/processarRastreio';
import {
  type AgendadorPrecoLi,
  LiTarefasDesligadasError,
  enfileirarTarefaPrecoLi,
} from './agendadorPreco';
import {
  type ProdutoDoAvisoPrecoLi,
  type RecusaPrecoLi,
  avisarPrecoRecusadoLi,
  resolverPrecoRecusadoLi,
} from './avisosPreco';
import { FORMA_PROMO_LIMPA_ENV_LI, lerFormaPromoLimpaLi } from './configPrecoLi';
import {
  lerProdutoPrecoLi,
  lerVinculosDoProdutoLi,
  paiParaLerPrecoLi,
  sondarVinculoDuplicadoLi,
} from './leituraPrecoErp';
import {
  type FolhaBaixaPrecoLi,
  type PlanoPrecoLi,
  planoPrecoLi,
  tipoEscritaDaOrigemPrecoLi,
} from './planoPrecoLi';
import { mesmasTabelasDoEnvioLi, tabelasDaContaLi } from './tabelasLi';

/* -------------------------------------------------------------------------- */
/*                         The deps, the bound, the outcomes                   */
/* -------------------------------------------------------------------------- */

/**
 * The longest ONE run can take, in ms, with every Loja Integrada call running to its whole 20 s
 * deadline: the deciding GET (two pacer intervals, 4 s, + 20 s), the PUT at once (+ 20 s), then
 * the read-back (4 s + 20 s) — or, after a write refused with 401/403, the confirming deciding
 * read in its place, the same 24 s. The PUT starts at most 24 s after the dispatch began, far
 * inside the engine's write deadline.
 *
 * Not an estimate kept in step by hand: `processarPreco.test.ts` runs the grid on a clock that
 * every wait and every call advance, and pins that no run there is slower and that this path takes
 * exactly this long. The price queue's timeout is sized against it (`functions/src/index.test.ts`).
 */
export const PIOR_EXECUCAO_PRECO_LI_MS = 68_000;

/** The write kind of each origin (module header, step 14) — the plan's, re-exported. */
export { tipoEscritaDaOrigemPrecoLi };

export interface DepsPrecoLi extends DepsEscritaLi {
  /** The Cloud Tasks attempt, 0-based: only the LAST one concludes a refused write. */
  readonly tentativa: number;
  /** The price queue's producer, for the ONE `deriva` follow-up. */
  readonly agendador: AgendadorPrecoLi;
}

/** Why a run stopped BEFORE the write context: zero credential reads, zero store calls. */
export type MotivoPuloPrecoLi =
  | 'conta-inexistente'
  | 'conta-inativa'
  /** The conta names no normal tabela. */
  | 'sem-tabela'
  /** A bulk send whose conta now names other tabelas than its run's (module header, step 4). */
  | 'tabela-mudou'
  | 'produto-inexistente'
  | 'sem-vinculo'
  | 'pai'
  | 'nao-suportado'
  | 'vinculo-ambiguo'
  /** The ERP gives no price the store may show (`precoAlvoLi`): the store keeps its own. */
  | 'retido'
  | 'vinculo-duplicado'
  | 'alvo-invalido';

/** Why a run stopped AFTER the write context, with nothing sent. */
export type MotivoDescartePrecoLi =
  | 'chamadas-desligadas'
  | 'conta-inexistente'
  | 'conta-inativa'
  | 'credencial-ausente'
  | 'credencial-invalida'
  | 'conta-parada'
  | 'ausente'
  | 'linha-divergente'
  | 'nao-e-variacao'
  | 'removido'
  | 'bloqueado'
  | 'guarda-ilegivel'
  | 'sob-consulta-ilegivel'
  | 'atual-ilegivel'
  | 'leitura-ilegivel'
  | 'leitura-recusada'
  | 'sem-restauracao';

/** What a landed read-back write did about a drift (module header, step 15). */
export type SeguimentoPrecoLi =
  /** Read back as written. */
  | 'nenhum'
  /** A drift (or no verified read-back): the ONE generation-1 follow-up is queued. */
  | 'enfileirado'
  /** A drift, and the sweep-only valve closed the queue: the next event re-covers. */
  | 'tarefas-desligadas'
  /** A drift in a generation-1 run: never another follow-up. */
  | 'sem-seguimento';

/**
 * Every outcome of one run — what the price queue's one line per dispatch reads. A kind added
 * later stops that line from compiling until it is mapped.
 */
export type ResultadoPrecoLi =
  | { readonly kind: 'payload-invalido' }
  /** The valve is `off`: nothing was read. */
  | { readonly kind: 'desligado' }
  /** The clear's forma cannot be read: nothing was read. */
  | { readonly kind: 'forma-invalida' }
  | { readonly kind: 'pulado'; readonly motivo: MotivoPuloPrecoLi }
  | { readonly kind: 'descartado'; readonly motivo: MotivoDescartePrecoLi }
  /** The store already shows the target: nothing written. */
  | { readonly kind: 'refletido' }
  /** The send would lower a buyer price and the task may not: nothing written. */
  | { readonly kind: 'nao-baixado'; readonly folhas: readonly FolhaBaixaPrecoLi[] }
  /** Dry-run, outside the canary or no canary: the engine's diff line, nothing sent. */
  | { readonly kind: 'nao-enviado'; readonly motivo: MotivoDryRunLi }
  /** A read-back write landed. */
  | { readonly kind: 'escrito'; readonly seguimento: SeguimentoPrecoLi }
  /** A bulk write landed (no read-back call). */
  | { readonly kind: 'escrito-lote' }
  /** Refused on the last attempt with this status: the aviso was raised under `on`. */
  | { readonly kind: 'recusado'; readonly status: number };

const pulado = (motivo: MotivoPuloPrecoLi): ResultadoPrecoLi => ({ kind: 'pulado', motivo });
const descartado = (motivo: MotivoDescartePrecoLi): ResultadoPrecoLi => ({
  kind: 'descartado',
  motivo,
});

/* -------------------------------------------------------------------------- */
/*                                The lines                                    */
/* -------------------------------------------------------------------------- */

/** The prefix of every line this run writes itself (the engine and the context write their own). */
export const LINHA_PRECO_LI = '[loja-integrada/preco]';

/** One run's own WARNING and ERROR lines: ids, the motivo and numbers only — never a body or a price. */
interface LinhasPrecoLi {
  aviso(motivo: string, extra?: Readonly<Record<string, string | number | null>>): void;
  erro(motivo: string, extra?: Readonly<Record<string, string | number | null>>): void;
}

function linhasDe(tarefa: TarefaPrecoLi, deps: DepsPrecoLi): LinhasPrecoLi {
  const meta = (motivo: string, extra: Readonly<Record<string, string | number | null>>) => ({
    integracaoId: tarefa.contaId,
    produtoId: tarefa.produtoId,
    origem: tarefa.origem,
    geracao: tarefa.geracao,
    baixar: tarefa.baixar,
    motivo,
    ...extra,
  });
  return {
    aviso: (motivo, extra = {}) => {
      const linha = `${LINHA_PRECO_LI} ${motivo}`;
      if (deps.logger === undefined) console.warn(linha, meta(motivo, extra));
      else deps.logger.warn(linha, meta(motivo, extra));
    },
    erro: (motivo, extra = {}) => {
      const linha = `${LINHA_PRECO_LI} ${motivo}`;
      if (deps.logger?.error === undefined) console.error(linha, meta(motivo, extra));
      else deps.logger.error(linha, meta(motivo, extra));
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                          Steps 1–11: before the store                       */
/* -------------------------------------------------------------------------- */

/**
 * One send run, start to finish (module header). Deterministic outcomes RETURN; everything else
 * rethrows the ORIGINAL error. `dados` is the task's RAW data.
 */
export async function processarTarefaPrecoLi(
  db: Firestore,
  dados: unknown,
  deps: DepsPrecoLi,
): Promise<ResultadoPrecoLi> {
  // 1. The payload: ids only.
  const lida = tarefaPrecoLiSchema.safeParse(dados);
  if (!lida.success) return { kind: 'payload-invalido' };
  const tarefa = lida.data;

  // 2. The valve FIRST.
  const inicio = iniciarEscritaLi(FLUXO_LI.preco, deps.ambiente, {
    ...deps.registro,
    conta: tarefa.contaId,
  });
  if (inicio.kind === 'desligado') return { kind: 'desligado' };
  const linhas = linhasDe(tarefa, deps);

  // 3. The clear's forma, from the environment the entry point passed.
  const forma = lerFormaPromoLimpaLi(deps.ambiente);
  if (forma === null) {
    linhas.erro('forma-promo-invalida', { variavel: FORMA_PROMO_LIMPA_ENV_LI });
    return { kind: 'forma-invalida' };
  }

  // 4. The conta and its tabelas.
  const emLote = origemEmLotePrecoLi(tarefa.origem);
  let conta = await lerContaEmCache(db, tarefa.contaId);
  if (emLote && conta !== null && !mesmasTabelasDoEnvioLi(tabelasDaContaLi(conta), tarefa)) {
    // A bulk send whose cached conta names other tabelas: read once more (module header).
    invalidarContaEmCache(tarefa.contaId);
    conta = await lerContaEmCache(db, tarefa.contaId);
  }
  if (conta === null || conta.tipo !== INTEGRACAO_TIPO.lojaIntegrada) {
    return pulado('conta-inexistente');
  }
  if (conta.ativo === false) return pulado('conta-inativa');
  const tabelas = tabelasDaContaLi(conta);
  if (tabelas.normal === null) {
    linhas.aviso('sem-tabela');
    return pulado('sem-tabela');
  }
  if (emLote && !mesmasTabelasDoEnvioLi(tabelas, tarefa)) {
    linhas.aviso('tabela-mudou');
    return pulado('tabela-mudou');
  }

  // 5. The produto and its own links.
  const [produto, links] = await Promise.all([
    lerProdutoPrecoLi(db, tarefa.produtoId),
    lerVinculosDoProdutoLi(db, tarefa.produtoId),
  ]);
  if (produto === null) return pulado('produto-inexistente');

  // 6. The links alone: a link skip reads no parent.
  const vinculo = vinculoDaContaLi(tarefa.contaId, links);
  if (vinculo.tipo !== 'vinculado') return pulado(vinculo.tipo);
  const idLi = vinculo.idLi;

  // 7. Only now the parent.
  const paiId = paiParaLerPrecoLi(produto);
  const pai = paiId === null ? null : await lerProdutoPrecoLi(db, paiId);

  // 8. The target, over the conta's RAW tabela pair.
  const alvoPreco = precoAlvoLi({
    produto,
    pai: pai?.dados ?? null,
    tabelaNormalId: tabelas.normal,
    tabelaPromocionalId: tabelas.promocional,
  });
  if (alvoPreco.tipo === 'retido') {
    linhas.aviso('retido', { idLi, retencao: alvoPreco.motivo });
    return pulado('retido');
  }

  // 9. The duplicate-link probe.
  if (await sondarVinculoDuplicadoLi(db, tarefa.contaId, idLi, tarefa.produtoId)) {
    linhas.aviso('vinculo-duplicado', { idLi });
    return pulado('vinculo-duplicado');
  }

  // 10. The target and its decision.
  const alvo: AlvoLi = { contaId: tarefa.contaId, recurso: Number(idLi) };
  if (chaveDoAlvo(alvo) === null) {
    linhas.erro('alvo-invalido', { idLi });
    return pulado('alvo-invalido');
  }
  const ligado = decidirAlvo(inicio.valvula, alvo).modo === MODO_LI.on;

  // 11. Only now the write context.
  let contexto: ContextoEscritaLojaIntegrada;
  try {
    contexto = await loadLojaIntegradaContextoEscrita(db, tarefa.contaId, {
      ambiente: deps.ambiente,
      esperar: deps.esperar,
      registro: { ...deps.registro, fluxo: FLUXO_LI.preco },
      fetch: deps.fetch,
    });
  } catch (err) {
    const motivo = motivoDaRecusaDaConta(err);
    if (motivo === null) throw err;
    return descartado(motivo);
  }

  const e: ExecucaoPrecoLi = {
    db,
    tarefa,
    deps,
    alvo,
    ligado,
    contexto,
    motor: criarMotor(inicio, contexto, deps),
    linhas,
    idLi,
    forma,
    envio: { cheioCentavos: alvoPreco.cheioCentavos, promo: alvoPreco.promo },
  };
  return depoisDoContexto(e);
}

/* -------------------------------------------------------------------------- */
/*                         Steps 12–15: against the store                      */
/* -------------------------------------------------------------------------- */

/** One run's state past the write context. */
interface ExecucaoPrecoLi {
  readonly db: Firestore;
  readonly tarefa: TarefaPrecoLi;
  readonly deps: DepsPrecoLi;
  readonly alvo: AlvoLi;
  /** The target decision is `on`: only then are avisos read or written. */
  readonly ligado: boolean;
  readonly contexto: ContextoEscritaLojaIntegrada;
  readonly motor: MotorEscritaLi;
  readonly linhas: LinhasPrecoLi;
  /** The store product id, canonical decimal text. */
  readonly idLi: string;
  /** The configured clear. */
  readonly forma: FormaPromoLimpaLi;
  /** The target, in integer centavos. */
  readonly envio: EnvioPrecoLi;
}

function criarMotor(
  inicio: InicioEscritaLi & { readonly kind: 'ativo' },
  contexto: ContextoEscritaLojaIntegrada,
  deps: DepsPrecoLi,
): MotorEscritaLi {
  return criarMotorEscritaLi({
    inicio,
    contexto,
    agora: deps.agoraMs,
    inicioDaTarefaMs: deps.inicioDaTarefaMs,
    registro: { ...deps.registro },
  });
}

/** A refusal of the write context or of a getter: the run drops, naming it; `null`: not one. */
function motivoDaRecusaDaConta(err: unknown): MotivoDescartePrecoLi | null {
  if (err instanceof LiChamadasDesligadasError) return 'chamadas-desligadas';
  if (err instanceof LiContaNaoEncontradaError) return 'conta-inexistente';
  if (err instanceof LiContaInativaError) return 'conta-inativa';
  if (err instanceof LiCredencialAusenteError) return 'credencial-ausente';
  if (err instanceof LiCredencialInvalidaError) return 'credencial-invalida';
  if (err instanceof LiContaParadaError) return 'conta-parada';
  return null;
}

/** The store name for a park or an aviso: the conta's `nome`, else its id. */
function lojaNomeDe(contexto: ContextoEscritaLojaIntegrada): string {
  return contexto.conta.nome === '' ? contexto.integracaoId : contexto.conta.nome;
}

/** Park the conta on a 401/403 its credential earned (the park answers what it found). */
function estacionarConta(
  e: ExecucaoPrecoLi,
  err: LiAuthError,
): ReturnType<typeof tratarFalhaDeAutenticacao> {
  return tratarFalhaDeAutenticacao(
    e.db,
    { integracaoId: e.contexto.integracaoId, lojaNome: lojaNomeDe(e.contexto) },
    err,
    e.deps,
  );
}

/**
 * A 401/403 on a deciding read: park the conta, then answer by what the park found — `null` =
 * rethrow (the refusal was for an older token, or there is no usable ref).
 */
async function estacionar(e: ExecucaoPrecoLi, err: LiAuthError): Promise<ResultadoPrecoLi | null> {
  let tratamento: Awaited<ReturnType<typeof tratarFalhaDeAutenticacao>>;
  try {
    tratamento = await estacionarConta(e, err);
  } catch (falha) {
    if (falha instanceof LiCredencialInvalidaError) return descartado('credencial-invalida');
    throw falha;
  }
  const estacionamento = tratamento.estacionamento;
  if (estacionamento === null) return null;
  switch (estacionamento.tipo) {
    case 'estacionado':
    case 'ja-estacionado':
      return descartado('conta-parada');
    case 'sem-credencial':
      return descartado('credencial-ausente');
    case 'credencial-substituida':
      return null;
  }
}

/**
 * Error → outcome for a DECIDING read (the first, and the one that confirms a refused write)
 * (module header, "Errors"). `null` = rethrow the ORIGINAL error.
 */
async function classificarFalhaDeLeitura(
  e: ExecucaoPrecoLi,
  err: unknown,
): Promise<ResultadoPrecoLi | null> {
  const motivo = motivoDaRecusaDaConta(err);
  if (motivo !== null) return descartado(motivo);
  if (err instanceof LiAuthError) return estacionar(e, err);
  if (err instanceof LiSchemaError) {
    // An empty or non-JSON 200 is the transport's: the retry may read it whole.
    if (err.motivo !== 'formato') return null;
    e.linhas.erro('leitura-ilegivel', { idLi: e.idLi, status: err.status });
    return descartado('leitura-ilegivel');
  }
  if (err instanceof LiThrottleError) return null;
  if (err instanceof LiHttpError) {
    if (err.transitorio || e.deps.tentativa < TASK_MAX_ATTEMPTS - 1) return null;
    e.linhas.erro('leitura-recusada', { idLi: e.idLi, status: err.status });
    return descartado('leitura-recusada');
  }
  return null;
}

/** A deciding read through the engine, its failure classified (`resultado`), or the base. */
async function lerBase(
  e: ExecucaoPrecoLi,
): Promise<{ readonly base: BaseEscritaPrecoLi } | { readonly resultado: ResultadoPrecoLi }> {
  try {
    return { base: await lerBaseLi(e.motor, e.alvo, 'produto-detalhe') };
  } catch (err) {
    const r = await classificarFalhaDeLeitura(e, err);
    if (r === null) throw err;
    return { resultado: r };
  }
}

/** The produto as the refusal aviso names it. */
function produtoDoAviso(e: ExecucaoPrecoLi): ProdutoDoAvisoPrecoLi {
  return {
    integracaoId: e.tarefa.contaId,
    lojaNome: lojaNomeDe(e.contexto),
    produtoId: e.tarefa.produtoId,
    idLi: e.idLi,
    inicioDaTarefaMs: e.deps.inicioDaTarefaMs,
  };
}

/** Under `on`, close an open refusal aviso of this produto (one read; a write only when open). */
async function resolverRecusa(e: ExecucaoPrecoLi): Promise<void> {
  if (!e.ligado) return;
  await resolverPrecoRecusadoLi(e.db, produtoDoAviso(e), { nowMs: e.deps.agoraMs() });
}

/** Under `on`, raise the refusal aviso with `recusa` (never after resolving it in the same run). */
async function avisarRecusa(e: ExecucaoPrecoLi, recusa: RecusaPrecoLi): Promise<void> {
  if (!e.ligado) return;
  await avisarPrecoRecusadoLi(e.db, produtoDoAviso(e), recusa, {
    increment: e.deps.increment,
    nowMs: e.deps.agoraMs(),
    logger: e.deps.logger,
  });
}

/** Steps 12–13: the deciding GET, then the plan. */
async function depoisDoContexto(e: ExecucaoPrecoLi): Promise<ResultadoPrecoLi> {
  const lido = await lerBase(e);
  if ('resultado' in lido) return lido.resultado;
  const base = lido.base;
  if (base.kind === 'ausente') {
    e.linhas.aviso('ausente', { idLi: e.idLi });
    return descartado('ausente');
  }
  const plano = planoPrecoLi({
    alvo: e.envio,
    detalhe: base.produtoDetalhe,
    idLi: e.alvo.recurso,
    baixar: e.tarefa.baixar,
    forma: e.forma,
  });
  switch (plano.tipo) {
    case 'linha-divergente':
      e.linhas.erro(plano.tipo, { idLi: e.idLi });
      return descartado(plano.tipo);
    case 'nao-e-variacao':
    case 'guarda-ilegivel':
    case 'sob-consulta-ilegivel':
    case 'atual-ilegivel':
      e.linhas.aviso(plano.tipo, { idLi: e.idLi });
      return descartado(plano.tipo);
    case 'removido':
    case 'bloqueado':
      return descartado(plano.tipo);
    case 'refletido':
      await resolverRecusa(e);
      return { kind: 'refletido' };
    case 'nao-baixado':
      // Neither landed nor proved anything: the refusal aviso is not read, let alone closed.
      return { kind: 'nao-baixado', folhas: plano.folhas };
    case 'enviar':
      return escrever(e, base, plano);
  }
}

/**
 * A write refused with a 3xx/4xx that is not 401/403/429 — nothing landed: rethrown until the
 * queue's LAST attempt, which concludes `recusado` (one ERROR line, and the aviso under `on`).
 */
async function recusaDaEscrita(e: ExecucaoPrecoLi, err: LiHttpError): Promise<ResultadoPrecoLi> {
  if (e.deps.tentativa < TASK_MAX_ATTEMPTS - 1) throw err;
  e.linhas.erro('recusado', { idLi: e.idLi, status: err.status });
  await avisarRecusa(e, { motivo: MOTIVO_PRECO_RECUSADO_LI.recusado, status: err.status });
  return { kind: 'recusado', status: err.status };
}

/**
 * A write refused with 401/403: the next DECIDING read, on the same pinned credential, confirms
 * it (module header, "Errors").
 */
async function confirmarRecusaDeCredencial(
  e: ExecucaoPrecoLi,
  erro: LiAuthError,
): Promise<ResultadoPrecoLi> {
  const segunda = await lerBase(e);
  if ('resultado' in segunda) return segunda.resultado;
  // Not found right after a read that found it: nothing to conclude — retry.
  if (segunda.base.kind !== 'lida') throw erro;
  return recusaDaEscrita(e, erro);
}

/**
 * The write's own failure, sorted (module header, "Errors"). `null` = rethrow the ORIGINAL error:
 * a 429 and a 5xx may have landed (the retry's own read decides), and the pin, the deadline, the
 * network, our own `LiConfigError`, gRPC and the builder's `RangeError` are never concluded here.
 */
async function falhaDaEscrita(e: ExecucaoPrecoLi, err: unknown): Promise<ResultadoPrecoLi | null> {
  if (err instanceof LiThrottleError) return null;
  if (err instanceof LiAuthError) return confirmarRecusaDeCredencial(e, err);
  if (err instanceof LiHttpError) return err.transitorio ? null : recusaDaEscrita(e, err);
  const motivo = motivoDaRecusaDaConta(err);
  return motivo === null ? null : descartado(motivo);
}

/** Step 14: the ONE write of the run. */
async function escrever(
  e: ExecucaoPrecoLi,
  base: BaseLidaPrecoLi,
  plano: Extract<PlanoPrecoLi, { readonly tipo: 'enviar' }>,
): Promise<ResultadoPrecoLi> {
  const tipo = tipoEscritaDaOrigemPrecoLi(e.tarefa.origem);
  const destino: DestinoEscritaLi = { tipo, alvo: e.alvo };
  const payload: PayloadEscritaLi = { campo: 'preco', valor: plano.entrada };
  let resultado: ResultadoEscritaLi;
  try {
    resultado = await escreverLi(e.motor, destino, payload, base);
  } catch (err) {
    const r = await falhaDaEscrita(e, err);
    if (r === null) throw err;
    return r;
  }
  if (resultado.kind === 'sem-restauracao') {
    // A store custo the restore line cannot carry verbatim: no rollback, so no write.
    e.linhas.erro('sem-restauracao', { idLi: e.idLi });
    return descartado('sem-restauracao');
  }
  // The body was built (sent, or diffed): say once when it had to leave the store's custo out.
  if (plano.custo === 'omitido-ilegivel') e.linhas.aviso('custo-omitido', { idLi: e.idLi });
  if (resultado.kind === 'nao-enviado') return { kind: 'nao-enviado', motivo: resultado.motivo };

  // The write LANDED: from here on, no other write in this run.
  if (tipo === 'preco-produto-lote') {
    await resolverRecusa(e);
    return { kind: 'escrito-lote' };
  }
  const seguimento = await conferirDepoisDaEscrita(
    e,
    { tipo: 'preco-produto', alvo: e.alvo },
    payload,
  );
  return { kind: 'escrito', seguimento };
}

/**
 * Step 15: the read-back, and the ONE follow-up when the store did not keep what was sent. A
 * read-back is VERIFIED only when it read the detail AND that detail names the product asked for
 * (the deciding read's identity rule): another product's detail proves nothing about ours, so it
 * fails open like a read-back that could not be made.
 */
async function conferirDepoisDaEscrita(
  e: ExecucaoPrecoLi,
  destino: DestinoEscritaLi & { readonly tipo: 'preco-produto' },
  payload: PayloadEscritaLi,
): Promise<SeguimentoPrecoLi> {
  const volta = await lerDeVoltaLi(e.motor, e.alvo, destino.tipo);
  let deriva: boolean;
  let verificada: boolean;
  if (volta.verificado && volta.produtoDetalhe.id === e.alvo.recurso) {
    // The engine logs the one WARNING `deriva` line itself.
    deriva = conferirEscritaLi(e.motor, destino, payload, volta) === 'deriva';
    verificada = true;
  } else {
    // A read-back refused with 401/403 parks the conta (a permitted throw after a landed write).
    // The follow-up below is enqueued all the same: a park lifted (or a token swapped) before it
    // dispatches lets it run; otherwise it drops at the conta's park, at no store call.
    if (!volta.verificado && volta.erro instanceof LiAuthError) {
      await estacionarConta(e, volta.erro);
    }
    e.linhas.aviso('sem-conferencia', {
      idLi: e.idLi,
      classe: volta.verificado ? 'linha-divergente' : volta.classe,
    });
    // Fail open: a reflected follow-up costs one read; a missed drift, a wrong price until the
    // next event re-covers it.
    deriva = true;
    verificada = false;
  }
  if (!deriva) {
    await resolverRecusa(e);
    return 'nenhum';
  }
  if (e.tarefa.geracao === 1) {
    e.linhas.erro('deriva-sem-seguimento', { idLi: e.idLi });
    // Only a VERIFIED drift says the store did not keep the price: a value never read proves
    // nothing. Raised WITHOUT resolving first — a resolve would stamp this run's clock, and the
    // raise that followed would carry the same clock and be dropped.
    if (verificada) await avisarRecusa(e, { motivo: MOTIVO_PRECO_RECUSADO_LI.naoRefletido });
    return 'sem-seguimento';
  }
  try {
    await enfileirarTarefaPrecoLi(e.deps.agendador, e.deps.agoraMs, {
      contaId: e.tarefa.contaId,
      produtoId: e.tarefa.produtoId,
      origem: ORIGEM_TAREFA_PRECO_LI.deriva,
      geracao: 1,
      baixar: e.tarefa.baixar,
    });
    return 'enfileirado';
  } catch (err) {
    // The sweep-only valve: the next event re-covers. ANY other rejection rethrows — a transient
    // Cloud Tasks failure, a broken deploy, the root's region guard, the strict parse — and the
    // retry re-derives everything from a fresh read (a permitted throw after a landed write:
    // `core/escrita.ts`, requirement 6 (i)).
    if (err instanceof LiTarefasDesligadasError) {
      e.linhas.aviso('deriva-tarefas-desligadas', { idLi: e.idLi });
      return 'tarefas-desligadas';
    }
    throw err;
  }
}
