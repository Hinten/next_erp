/**
 * ONE stock send run (master plan step 12, PR 12-e): one CHILD produto of one conta, its ERP
 * quantity S sent to the matching Loja Integrada product's stock row through the write engine
 * (`core/escrita.ts`), the ONLY module that sends a write. The decisions are the pure plan's
 * (`planoEstoqueLi.ts`) and the quantity core's (`quantidadeEstoqueLi.ts`); the ERP reads are
 * `leituraEstoqueErp.ts`'s; the refusal aviso `avisosEstoque.ts`'s; the one follow-up's producer
 * `agendadorEstoque.ts`'s.
 *
 * ## The order of one run — every skip before the write context
 *
 *  1. The payload, parsed STRICT (`tarefaEstoqueLiSchema`: ids only — a quantity, or any key
 *     the schema does not name, is refused): `payload-invalido`, zero reads.
 *  2. The valve FIRST (`iniciarEscritaLi`): `off` — recognised or not — is `desligado`, zero reads.
 *  3. The cap (`LOJA_INTEGRADA_ESTOQUE_MAX`, read from the environment the entry point passes,
 *     never baked anywhere): unset or blank ⇒ none; otherwise a positive integer in canonical
 *     decimal; anything else refuses EVERY run (`teto-invalido`, one ERROR line, zero reads) — a
 *     cap nobody can read is never guessed, and `0` would zero every row.
 *  4. The conta (the cached reader): gone, not a Loja Integrada conta, inactive, or no readable
 *     depósito ⇒ skipped.
 *  5. The produto (masked) and its own links, together. No produto ⇒ skipped.
 *  6. The links alone (`planoDosVinculosEstoqueLi`): no counting child link, a parent's, a root
 *     with no grades, two store products, or the parity switch ⇒ skipped WITHOUT reading a stock
 *     record.
 *  7. Its records: the produto's own at the depósito (a canonical hint by id — never a delete's,
 *     whose hint names the record deleted — else the query) — not for a kit its components bound,
 *     whose own record never feeds S — and the bounding components'; then the plan.
 *     `consultar-estoques` ⇒ ONE listing of any record at any depósito, then the plan again (the
 *     never-had-stock hold, read literally: only a produto with no record ANYWHERE is held). Only
 *     an `enviar` pays the duplicate-link probe, and a hit plans again (`vinculo-duplicado`).
 *     `retido`, `estoque-ambiguo` and `vinculo-duplicado` are one WARNING line each; their
 *     per-conta avisos are the daily reconcile's (a send run raising them would overwrite the
 *     reconcile's full count with one).
 *  8. The target `<conta>:<store id>` and its decision (`decidirAlvo`: `on`, or why not).
 *  9. Only NOW the write context (the read switch first, then the conta, one credential read):
 *     its refusals DROP, with the class — there is no failure store; the reconcile re-covers.
 * 10. The deciding GET (`lerBaseLi`, the stock detail by PRODUCT id): a 404 ⇒ `ausente` (one
 *     WARNING); a row naming another produto ⇒ `linha-divergente` (one ERROR, nothing written).
 * 11. Model A (`decidirEnvioEstoqueLi`): the target `min(S, cap) + max(0, reservation)`; the row
 *     already showing all four leaves ⇒ `refletido`; a reservation it cannot read ⇒ ERROR drop.
 * 12. The write, by origin ({@link tipoEscritaDaOrigemLi}): an event, a manual push, a publish
 *     and a `deriva` follow-up write `estoque-produto` and are READ BACK (two intervals later); a
 *     reconcile and a kit fan-out write `estoque-produto-lote`, with NO read-back call (the next
 *     daily walk is theirs). Not `on`: the engine's one diff line, nothing sent.
 * 13. The read-back's drift rule: the written leaves read back differently, or the store's
 *     reservation moved so that model A now targets another quantity — or the read-back could not
 *     be made at all (fail open) ⇒ ONE `deriva` follow-up (generation 1) through the producer; a
 *     generation-1 run never enqueues another (one WARNING), so no loop is possible. This closes
 *     the race of an order LEAVING the store between the GET and the PUT: it lowers quantity and
 *     reservation by the same k, the PUT then advertises S + k, and the ERP's own matching pair
 *     moves no available quantity, so no event of ours would ever correct it.
 *
 * ## What a run costs (Firestore operations / credential reads / store calls)
 *
 * Every skip costs ZERO credential reads and ZERO store calls: the write context comes after
 * every skip decision. For a produto that is not a kit its components bound: a link skip reads the
 * conta, the produto and its links (3); a record skip one more (4); a hold its listing (5); a
 * duplicate the two probe queries (6). A send pays those 6 ERP operations, the context's
 * credential read, one credential re-read per store call, and — only under `on` — one read of the
 * refusal aviso (written only when it is OPEN). No Firestore write on success, ever.
 *
 * A kit its components bound reads no record of its own, but its k bounding components' (every
 * document of a `getAll` is one read): ONE `getAll` of the canonical ids the payload carries, then
 * two group queries per 30 components still missing, then one own-collection query per component
 * whose CANONICAL record is still unread (none found, or only legacy ones: a record with no
 * `parentId` is invisible to the join, so a legacy hit is never taken as the whole answer) — so a
 * bounding component with no record at the depósito, or with legacy records only, pays that query
 * on EVERY run. A send with every id in the payload pays 3 + k + 2 (the probe) ERP operations; one
 * with none, 3 + 2·⌈k/30⌉ + (components without their canonical record read) + 2; each plus the
 * aviso pre-read under `on`.
 *
 * ## Errors (deterministic outcomes RETURN, transient failures THROW — every retry re-derives
 * everything from a fresh read, and the quantity sent is absolute, never a delta)
 *
 *  - a 429 (`LiThrottleError`) or a 5xx: THROWN, on the read and on the write — a PUT answered
 *    either may have landed, so the run is closed and the retry's own GET decides;
 *  - a write refused with another 3xx/4xx: proves nothing landed; rethrown until the queue's LAST
 *    attempt, then `recusado`, one ERROR line and, under `on`, the aviso
 *    `lojaIntegradaEstoqueRecusado`;
 *  - a 401/403: on a deciding read, the conta is PARKED (`tratarFalhaDeAutenticacao`) and the run
 *    drops; on the write, the next deciding read on the same pinned credential is the confirming
 *    read — refused too ⇒ parked; reading fine ⇒ the write's refusal follows the rule above; not
 *    found ⇒ nothing to conclude, rethrown. A 401 for an older token rethrows (the retry reads
 *    with the new one);
 *  - the deciding read answered OFF its schema (`formato`: a fractional reservation, a missing
 *    leaf) drops at once with one ERROR (the retry would read the same row); an empty or non-JSON
 *    200 is the transport's and rethrows; another non-transient 3xx/4xx on a read rethrows until
 *    the last attempt, then drops with one ERROR (no aviso: that aviso is a refused WRITE);
 *  - the credential swapped under the pin, the write deadline (`PrazoDeEscritaEsgotadoLiError`),
 *    the network, our own `LiConfigError` and gRPC: THROWN;
 *  - the read switch off (`LiChamadasDesligadasError`): dropped — the context logs its line.
 *
 * ## Rule 7 — class
 *
 * Serialised by the stock queue (one dispatch at a time, one instance — narrowed, not absolute: an
 * abandoned dispatch or a rare duplicate delivery can overlap, and no write starts past the task
 * deadline); ONE write per run, decided by the deciding read just before it with no pacer interval
 * between them; S re-derived from the ERP on every attempt, never carried in the payload. The
 * store takes no version on a write, so a movement in the gap between the deciding read and the
 * write is the residual — closed by the `deriva` follow-up for the read-back origins, and within a
 * day by the reconcile for the bulk ones. Firestore: only the refusal aviso (tier 2, the run's
 * start as its clock) and the park (tier 1).
 *
 * ## Rollback
 *
 * The deciding read's restore line carries the store's whole stock row. Re-PUT its `quantidade`
 * to undo a send — through the same strict route, which sends only a non-negative quantity under
 * the four fixed leaves: a negative prior quantity, or a prior unmanaged row or lead-time setting,
 * cannot be restored through it.
 *
 * ⚠️ This module must never name the Admin SDK's multi-document read-and-write call — not even in
 * a comment (`estrutura.test.ts`) — and never reads the process environment: `deps.ambiente` is
 * the environment, passed in.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { TASK_MAX_ATTEMPTS } from '@delfrance/data/admin/notifications';
import {
  LiAuthError,
  LiHttpError,
  LiSchemaError,
  LiThrottleError,
  produtoIdDoEstoqueLi,
} from '@delfrance/integrations-loja-integrada';
import {
  INTEGRACAO_TIPO,
  ORIGEM_TAREFA_ESTOQUE_LI,
  type OrigemTarefaEstoqueLi,
  type TarefaEstoqueLi,
  tarefaEstoqueLiSchema,
} from '@delfrance/schemas';

import { lerContaEmCache } from '../core/contaCache';
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
  type BaseEscritaEstoqueLi,
  type BaseLidaEstoqueLi,
  type DestinoEscritaLi,
  type InicioEscritaLi,
  type MotorEscritaLi,
  type PayloadEscritaLi,
  type ResultadoEscritaLi,
  type TipoEscritaEstoqueLi,
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
  type AmbienteLi,
  FLUXO_LI,
  MODO_LI,
  type MotivoDryRunLi,
  chaveDoAlvo,
  decidirAlvo,
} from '../core/valvulas';
import type { DepsEscritaLi } from '../rastreio/processarRastreio';
import {
  type AgendadorEstoqueLi,
  LiTarefasDesligadasError,
  enfileirarTarefaEstoqueLi,
} from './agendadorEstoque';
import {
  type ProdutoDoAvisoEstoqueLi,
  avisarEstoqueRecusadoLi,
  resolverEstoqueRecusadoLi,
} from './avisosEstoque';
import {
  depositoDaContaLi,
  lerComponentesNoDepositoLi,
  lerEstoqueProprioLi,
  lerProdutoEstoqueLi,
  lerVinculosDoProdutoLi,
  sondarVinculoDuplicadoLi,
  temEstoqueEmQualquerDepositoLi,
} from './leituraEstoqueErp';
import {
  type EntradaPlanoEstoqueLi,
  type PlanoEstoqueLi,
  decidirEnvioEstoqueLi,
  estoqueNoDepositoLi,
  kitRestritoLi,
  planoDosVinculosEstoqueLi,
  planoEstoqueLi,
} from './planoEstoqueLi';
import { type CorpoEstoqueLi, type ProdutoEstoqueLi, alvoEstoqueLi } from './quantidadeEstoqueLi';

/* -------------------------------------------------------------------------- */
/*                         The deps, the cap, the outcomes                     */
/* -------------------------------------------------------------------------- */

/**
 * The longest ONE run can take, in ms, with every Loja Integrada call running to its whole 20 s
 * deadline: the deciding GET (two pacer intervals, 4 s, + 20 s), the PUT at once (+ 20 s), then
 * the read-back (4 s + 20 s) — or, after a write refused with 401/403, the confirming deciding
 * read in its place, the same 24 s. The PUT starts at most 24 s after the dispatch began, far
 * inside the engine's write deadline.
 *
 * Not an estimate kept in step by hand: `processarEstoque.test.ts` runs the grid on a clock that
 * every wait and every call advance, and pins that no run there is slower and that this path takes
 * exactly this long. The stock queue's timeout is sized against it (`functions/src/index.test.ts`).
 */
export const PIOR_EXECUCAO_ESTOQUE_LI_MS = 68_000;

/** The upper cap on what one row advertises (module header, step 3). */
export const TETO_ESTOQUE_ENV_LI = 'LOJA_INTEGRADA_ESTOQUE_MAX';

/** A positive integer in canonical decimal: no sign, no leading zero, no space, no fraction. */
const TETO_CANONICO = /^[1-9][0-9]*$/;

/**
 * The cap, as the run applies it: `+∞` when unset or blank (exactly `''`, nothing trimmed); the
 * number when the value is a positive safe integer in canonical decimal; `null` — the run refuses
 * — for anything else (`0`, `-1`, `1.5`, ` 3`, `03`, `abc`).
 */
export function lerTetoEstoqueLi(ambiente: AmbienteLi): number | null {
  const valor = ambiente[TETO_ESTOQUE_ENV_LI];
  if (valor === undefined || valor === '') return Number.POSITIVE_INFINITY;
  if (!TETO_CANONICO.test(valor)) return null;
  const teto = Number(valor);
  return Number.isSafeInteger(teto) ? teto : null;
}

/**
 * The write kind of each origin (module header, step 12). Exhaustive: an origin added later does
 * not compile until it is decided.
 */
export function tipoEscritaDaOrigemLi(origem: OrigemTarefaEstoqueLi): TipoEscritaEstoqueLi {
  switch (origem) {
    case ORIGEM_TAREFA_ESTOQUE_LI.evento:
    case ORIGEM_TAREFA_ESTOQUE_LI.manual:
    case ORIGEM_TAREFA_ESTOQUE_LI.publicacao:
    case ORIGEM_TAREFA_ESTOQUE_LI.deriva:
      return 'estoque-produto';
    case ORIGEM_TAREFA_ESTOQUE_LI.reconcile:
    case ORIGEM_TAREFA_ESTOQUE_LI.kit:
      return 'estoque-produto-lote';
  }
}

export interface DepsEstoqueLi extends DepsEscritaLi {
  /** The Cloud Tasks attempt, 0-based: only the LAST one concludes a refused write. */
  readonly tentativa: number;
  /** The stock queue's producer, for the ONE `deriva` follow-up. */
  readonly agendador: AgendadorEstoqueLi;
}

/** Why a run stopped BEFORE the write context: zero credential reads, zero store calls. */
export type MotivoPuloEstoqueLi =
  | 'conta-inexistente'
  | 'conta-inativa'
  | 'conta-sem-deposito'
  | 'produto-inexistente'
  | 'sem-vinculo'
  | 'pai'
  | 'nao-suportado'
  | 'vinculo-ambiguo'
  | 'paridade'
  | 'retido'
  | 'estoque-ambiguo'
  | 'vinculo-duplicado'
  | 'alvo-invalido';

/** Why a run stopped AFTER the write context, with nothing sent. */
export type MotivoDescarteEstoqueLi =
  | 'chamadas-desligadas'
  | 'conta-inexistente'
  | 'conta-inativa'
  | 'credencial-ausente'
  | 'credencial-invalida'
  | 'conta-parada'
  | 'ausente'
  | 'linha-divergente'
  | 'leitura-ilegivel'
  | 'leitura-recusada'
  | 'reserva-ilegivel'
  | 'sem-restauracao';

/** What a landed read-back write did about a drift (module header, step 13). */
export type SeguimentoEstoqueLi =
  /** Read back as written, the reservation where the deciding read saw it. */
  | 'nenhum'
  /** A drift: the ONE generation-1 follow-up is queued. */
  | 'enfileirado'
  /** A drift, and the sweep-only valve closed the queue: the reconcile re-covers. */
  | 'tarefas-desligadas'
  /** A drift in a generation-1 run: never another follow-up. */
  | 'sem-seguimento';

/**
 * Every outcome of one run — what the stock queue's one line per dispatch reads. A kind added
 * later stops that line from compiling until it is mapped.
 */
export type ResultadoEstoqueLi =
  | { readonly kind: 'payload-invalido' }
  /** The valve is `off`: nothing was read. */
  | { readonly kind: 'desligado' }
  /** The cap cannot be read: nothing was read. */
  | { readonly kind: 'teto-invalido' }
  | { readonly kind: 'pulado'; readonly motivo: MotivoPuloEstoqueLi }
  | { readonly kind: 'descartado'; readonly motivo: MotivoDescarteEstoqueLi }
  /** The row already shows the target body: nothing written. */
  | { readonly kind: 'refletido' }
  /** Dry-run, outside the canary or no canary: the engine's diff line, nothing sent. */
  | { readonly kind: 'nao-enviado'; readonly motivo: MotivoDryRunLi }
  /** A read-back write landed. */
  | { readonly kind: 'escrito'; readonly seguimento: SeguimentoEstoqueLi }
  /** A bulk write landed (no read-back call). */
  | { readonly kind: 'escrito-lote' }
  /** Refused on the last attempt with this status: the aviso was raised under `on`. */
  | { readonly kind: 'recusado'; readonly status: number };

const pulado = (motivo: MotivoPuloEstoqueLi): ResultadoEstoqueLi => ({ kind: 'pulado', motivo });
const descartado = (motivo: MotivoDescarteEstoqueLi): ResultadoEstoqueLi => ({
  kind: 'descartado',
  motivo,
});

/* -------------------------------------------------------------------------- */
/*                                The lines                                    */
/* -------------------------------------------------------------------------- */

/** The prefix of every line this run writes itself (the engine and the context write their own). */
export const LINHA_ESTOQUE_LI = '[loja-integrada/estoque]';

/** One run's own WARNING and ERROR lines: ids, the motivo and numbers only — never a body. */
interface LinhasEstoqueLi {
  aviso(motivo: string, extra?: Readonly<Record<string, string | number | null>>): void;
  erro(motivo: string, extra?: Readonly<Record<string, string | number | null>>): void;
}

function linhasDe(tarefa: TarefaEstoqueLi, deps: DepsEstoqueLi): LinhasEstoqueLi {
  const meta = (motivo: string, extra: Readonly<Record<string, string | number | null>>) => ({
    integracaoId: tarefa.contaId,
    produtoId: tarefa.produtoId,
    origem: tarefa.origem,
    geracao: tarefa.geracao,
    motivo,
    ...extra,
  });
  return {
    aviso: (motivo, extra = {}) => {
      const linha = `${LINHA_ESTOQUE_LI} ${motivo}`;
      if (deps.logger === undefined) console.warn(linha, meta(motivo, extra));
      else deps.logger.warn(linha, meta(motivo, extra));
    },
    erro: (motivo, extra = {}) => {
      const linha = `${LINHA_ESTOQUE_LI} ${motivo}`;
      if (deps.logger?.error === undefined) console.error(linha, meta(motivo, extra));
      else deps.logger.error(linha, meta(motivo, extra));
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                              Steps 1–7: the plan                            */
/* -------------------------------------------------------------------------- */

/** Step 7: the records, the plan, the hold's listing and the duplicate probe (module header). */
async function planejar(
  db: Firestore,
  tarefa: TarefaEstoqueLi,
  depositoId: string,
  produto: ProdutoEstoqueLi,
  links: readonly unknown[],
): Promise<PlanoEstoqueLi> {
  const restrito = kitRestritoLi(produto);
  // A delete's hint names the record that was DELETED: reading it buys nothing (a record
  // re-created since is found by the query anyway), so a delete's task goes straight to it.
  const hint = tarefa.apagado ? null : tarefa.estoqueId;
  const [registros, componentes] = await Promise.all([
    restrito ? Promise.resolve([]) : lerEstoqueProprioLi(db, tarefa.produtoId, depositoId, hint),
    lerComponentesNoDepositoLi(db, produto, depositoId, tarefa.estoqueIds),
  ]);
  let entrada: EntradaPlanoEstoqueLi = {
    contaId: tarefa.contaId,
    produtoId: tarefa.produtoId,
    depositoId,
    produto,
    links,
    estoque: restrito
      ? { tipo: 'nenhum' }
      : estoqueNoDepositoLi({ produtoId: tarefa.produtoId, depositoId, registros }),
    componentes,
    apagado: tarefa.apagado,
    temEstoqueEmQualquerDeposito: null,
    duplicado: false,
  };
  let plano = planoEstoqueLi(entrada);
  if (plano.tipo === 'consultar-estoques') {
    entrada = {
      ...entrada,
      temEstoqueEmQualquerDeposito: await temEstoqueEmQualquerDepositoLi(db, tarefa.produtoId),
    };
    plano = planoEstoqueLi(entrada);
  }
  if (
    plano.tipo === 'enviar' &&
    (await sondarVinculoDuplicadoLi(db, tarefa.contaId, plano.idLi, tarefa.produtoId))
  ) {
    plano = planoEstoqueLi({ ...entrada, duplicado: true });
  }
  return plano;
}

/**
 * One send run, start to finish (module header). Deterministic outcomes RETURN; everything else
 * rethrows the ORIGINAL error. `dados` is the task's RAW data.
 */
export async function processarTarefaEstoqueLi(
  db: Firestore,
  dados: unknown,
  deps: DepsEstoqueLi,
): Promise<ResultadoEstoqueLi> {
  // 1. The payload: ids only.
  const lida = tarefaEstoqueLiSchema.safeParse(dados);
  if (!lida.success) return { kind: 'payload-invalido' };
  const tarefa = lida.data;

  // 2. The valve FIRST.
  const inicio = iniciarEscritaLi(FLUXO_LI.estoque, deps.ambiente, {
    ...deps.registro,
    conta: tarefa.contaId,
  });
  if (inicio.kind === 'desligado') return { kind: 'desligado' };
  const linhas = linhasDe(tarefa, deps);

  // 3. The cap, from the environment the entry point passed.
  const teto = lerTetoEstoqueLi(deps.ambiente);
  if (teto === null) {
    linhas.erro('teto-invalido', { variavel: TETO_ESTOQUE_ENV_LI });
    return { kind: 'teto-invalido' };
  }

  // 4. The conta and its depósito.
  const conta = await lerContaEmCache(db, tarefa.contaId);
  if (conta === null || conta.tipo !== INTEGRACAO_TIPO.lojaIntegrada) {
    return pulado('conta-inexistente');
  }
  if (conta.ativo === false) return pulado('conta-inativa');
  const depositoId = depositoDaContaLi(conta);
  if (depositoId === null) {
    linhas.aviso('conta-sem-deposito');
    return pulado('conta-sem-deposito');
  }

  // 5. The produto and its own links.
  const [produto, links] = await Promise.all([
    lerProdutoEstoqueLi(db, tarefa.produtoId),
    lerVinculosDoProdutoLi(db, tarefa.produtoId),
  ]);
  if (produto === null) return pulado('produto-inexistente');

  // 6. The links alone: a link skip reads no stock record.
  const vinculos = planoDosVinculosEstoqueLi({ contaId: tarefa.contaId, links, produto });
  if (vinculos.tipo !== 'vinculado') return pulado(vinculos.tipo);

  // 7. The records and the plan.
  const plano = await planejar(db, tarefa, depositoId, produto, links);
  switch (plano.tipo) {
    case 'sem-vinculo':
    case 'pai':
    case 'nao-suportado':
    case 'vinculo-ambiguo':
    case 'paridade':
      return pulado(plano.tipo);
    case 'retido':
    case 'estoque-ambiguo':
    case 'vinculo-duplicado':
      linhas.aviso(plano.tipo, { idLi: plano.idLi });
      return pulado(plano.tipo);
    case 'consultar-estoques':
      // `planejar` answers the listing itself: the plan never asks twice.
      throw new TypeError('estoque: o plano pediu a listagem depois de lê-la');
    case 'enviar':
      break;
  }
  if (plano.kitNaoVerificavel) linhas.aviso('kit-nao-verificavel', { idLi: plano.idLi });

  // 8. The target and its decision.
  const alvo: AlvoLi = { contaId: tarefa.contaId, recurso: Number(plano.idLi) };
  if (chaveDoAlvo(alvo) === null) {
    linhas.erro('alvo-invalido', { idLi: plano.idLi });
    return pulado('alvo-invalido');
  }
  const ligado = decidirAlvo(inicio.valvula, alvo).modo === MODO_LI.on;

  // 9. Only now the write context.
  let contexto: ContextoEscritaLojaIntegrada;
  try {
    contexto = await loadLojaIntegradaContextoEscrita(db, tarefa.contaId, {
      ambiente: deps.ambiente,
      esperar: deps.esperar,
      registro: { ...deps.registro, fluxo: FLUXO_LI.estoque },
      fetch: deps.fetch,
    });
  } catch (err) {
    const motivo = motivoDaRecusaDaConta(err);
    if (motivo === null) throw err;
    return descartado(motivo);
  }

  const e: ExecucaoEstoqueLi = {
    db,
    tarefa,
    deps,
    alvo,
    ligado,
    contexto,
    motor: criarMotor(inicio, contexto, deps),
    linhas,
    idLi: plano.idLi,
    S: Math.min(plano.S, teto),
  };
  return depoisDoContexto(e, plano.S, teto);
}

/* -------------------------------------------------------------------------- */
/*                         Steps 9–13: against the store                       */
/* -------------------------------------------------------------------------- */

/** One run's state past the write context. */
interface ExecucaoEstoqueLi {
  readonly db: Firestore;
  readonly tarefa: TarefaEstoqueLi;
  readonly deps: DepsEstoqueLi;
  readonly alvo: AlvoLi;
  /** The target decision is `on`: only then are avisos read or written. */
  readonly ligado: boolean;
  readonly contexto: ContextoEscritaLojaIntegrada;
  readonly motor: MotorEscritaLi;
  readonly linhas: LinhasEstoqueLi;
  readonly idLi: string;
  /** S, capped: what model A adds the store's reservation to. */
  readonly S: number;
}

function criarMotor(
  inicio: InicioEscritaLi & { readonly kind: 'ativo' },
  contexto: ContextoEscritaLojaIntegrada,
  deps: DepsEstoqueLi,
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
function motivoDaRecusaDaConta(err: unknown): MotivoDescarteEstoqueLi | null {
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

/**
 * A 401/403 the conta's credential earned: park the conta, then answer by what the park found —
 * `null` = rethrow (the refusal was for an older token, or there is no usable ref).
 */
async function estacionar(
  e: ExecucaoEstoqueLi,
  err: LiAuthError,
): Promise<ResultadoEstoqueLi | null> {
  let tratamento: Awaited<ReturnType<typeof tratarFalhaDeAutenticacao>>;
  try {
    tratamento = await tratarFalhaDeAutenticacao(
      e.db,
      { integracaoId: e.contexto.integracaoId, lojaNome: lojaNomeDe(e.contexto) },
      err,
      e.deps,
    );
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
  e: ExecucaoEstoqueLi,
  err: unknown,
): Promise<ResultadoEstoqueLi | null> {
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
  e: ExecucaoEstoqueLi,
): Promise<{ readonly base: BaseEscritaEstoqueLi } | { readonly resultado: ResultadoEstoqueLi }> {
  try {
    return { base: await lerBaseLi(e.motor, e.alvo, 'produto-estoque') };
  } catch (err) {
    const r = await classificarFalhaDeLeitura(e, err);
    if (r === null) throw err;
    return { resultado: r };
  }
}

/** The produto as the refusal aviso names it. */
function produtoDoAviso(e: ExecucaoEstoqueLi): ProdutoDoAvisoEstoqueLi {
  return {
    integracaoId: e.tarefa.contaId,
    lojaNome: lojaNomeDe(e.contexto),
    produtoId: e.tarefa.produtoId,
    idLi: e.idLi,
    inicioDaTarefaMs: e.deps.inicioDaTarefaMs,
  };
}

/** Under `on`, close an open refusal aviso of this produto (one read; a write only when open). */
async function resolverRecusa(e: ExecucaoEstoqueLi): Promise<void> {
  if (!e.ligado) return;
  await resolverEstoqueRecusadoLi(e.db, produtoDoAviso(e), { nowMs: e.deps.agoraMs() });
}

/** Steps 10–11: the deciding GET, the row's identity, model A. */
async function depoisDoContexto(
  e: ExecucaoEstoqueLi,
  S: number,
  teto: number,
): Promise<ResultadoEstoqueLi> {
  const lido = await lerBase(e);
  if ('resultado' in lido) return lido.resultado;
  const base = lido.base;
  if (base.kind === 'ausente') {
    e.linhas.aviso('ausente', { idLi: e.idLi });
    return descartado('ausente');
  }
  if (produtoIdDoEstoqueLi(base.produtoEstoque.produto) !== e.alvo.recurso) {
    e.linhas.erro('linha-divergente', { idLi: e.idLi });
    return descartado('linha-divergente');
  }
  const decisao = decidirEnvioEstoqueLi({ S, cap: teto, linha: base.produtoEstoque });
  switch (decisao.tipo) {
    case 'recusa':
      e.linhas.erro(decisao.motivo, { idLi: e.idLi });
      return descartado('reserva-ilegivel');
    case 'refletido':
      await resolverRecusa(e);
      return { kind: 'refletido' };
    case 'escrever':
      return escrever(e, base, decisao.corpo);
  }
}

/**
 * A write refused with a 3xx/4xx that is not 401/403/429 — nothing landed: rethrown until the
 * queue's LAST attempt, which concludes `recusado` (one ERROR line, and the aviso under `on`).
 */
async function recusaDaEscrita(
  e: ExecucaoEstoqueLi,
  err: LiHttpError,
): Promise<ResultadoEstoqueLi> {
  if (e.deps.tentativa < TASK_MAX_ATTEMPTS - 1) throw err;
  e.linhas.erro('recusado', { idLi: e.idLi, status: err.status });
  if (e.ligado) {
    await avisarEstoqueRecusadoLi(e.db, produtoDoAviso(e), err.status, {
      increment: e.deps.increment,
      nowMs: e.deps.agoraMs(),
      logger: e.deps.logger,
    });
  }
  return { kind: 'recusado', status: err.status };
}

/**
 * A write refused with 401/403: the next DECIDING read, on the same pinned credential, confirms
 * it (module header, "Errors").
 */
async function confirmarRecusaDeCredencial(
  e: ExecucaoEstoqueLi,
  erro: LiAuthError,
): Promise<ResultadoEstoqueLi> {
  const segunda = await lerBase(e);
  if ('resultado' in segunda) return segunda.resultado;
  // Not found right after a read that found it: nothing to conclude — retry.
  if (segunda.base.kind !== 'lida') throw erro;
  return recusaDaEscrita(e, erro);
}

/**
 * The write's own failure, sorted (module header, "Errors"). `null` = rethrow the ORIGINAL error:
 * a 429 and a 5xx may have landed (the retry's own read decides), and the pin, the deadline, the
 * network, our own `LiConfigError` and gRPC are never concluded here.
 */
async function falhaDaEscrita(
  e: ExecucaoEstoqueLi,
  err: unknown,
): Promise<ResultadoEstoqueLi | null> {
  if (err instanceof LiThrottleError) return null;
  if (err instanceof LiAuthError) return confirmarRecusaDeCredencial(e, err);
  if (err instanceof LiHttpError) return err.transitorio ? null : recusaDaEscrita(e, err);
  const motivo = motivoDaRecusaDaConta(err);
  return motivo === null ? null : descartado(motivo);
}

/** Step 12: the ONE write of the run. */
async function escrever(
  e: ExecucaoEstoqueLi,
  base: BaseLidaEstoqueLi,
  corpo: CorpoEstoqueLi,
): Promise<ResultadoEstoqueLi> {
  const tipo = tipoEscritaDaOrigemLi(e.tarefa.origem);
  const destino: DestinoEscritaLi = { tipo, alvo: e.alvo };
  const payload: PayloadEscritaLi = { campo: 'estoque', valor: corpo };
  let resultado: ResultadoEscritaLi;
  try {
    resultado = await escreverLi(e.motor, destino, payload, base);
  } catch (err) {
    const r = await falhaDaEscrita(e, err);
    if (r === null) throw err;
    return r;
  }
  switch (resultado.kind) {
    case 'nao-enviado':
      return { kind: 'nao-enviado', motivo: resultado.motivo };
    case 'sem-restauracao':
      e.linhas.erro('sem-restauracao', { idLi: e.idLi });
      return descartado('sem-restauracao');
    case 'enviado':
      break;
  }

  // The write LANDED: from here on, no other write in this run.
  if (tipo === 'estoque-produto-lote') {
    await resolverRecusa(e);
    return { kind: 'escrito-lote' };
  }
  const seguimento = await conferirDepoisDaEscrita(
    e,
    { tipo: 'estoque-produto', alvo: e.alvo },
    payload,
    corpo,
  );
  await resolverRecusa(e);
  return { kind: 'escrito', seguimento };
}

/**
 * Step 13: the read-back, and the ONE follow-up when the store drifted under the write. The
 * drift is decided in model A's own terms — `alvoEstoqueLi(S, reservation read back)` against the
 * quantity sent — so a reservation that moves only below zero (−3 where the deciding read saw 0)
 * targets the same quantity and is no drift, while any move above zero is.
 */
async function conferirDepoisDaEscrita(
  e: ExecucaoEstoqueLi,
  destino: DestinoEscritaLi & { readonly tipo: 'estoque-produto' },
  payload: PayloadEscritaLi,
  corpo: CorpoEstoqueLi,
): Promise<SeguimentoEstoqueLi> {
  const volta = await lerDeVoltaLi(e.motor, e.alvo, destino.tipo);
  let deriva: boolean;
  if (volta.verificado) {
    const conferido = conferirEscritaLi(e.motor, destino, payload, volta);
    const reserva = volta.produtoEstoque.quantidade_reservada;
    const reservaMoveu = alvoEstoqueLi(e.S, reserva) !== corpo.quantidade;
    if (reservaMoveu) {
      e.linhas.aviso('reserva-moveu', { idLi: e.idLi, enviado: corpo.quantidade, reserva });
    }
    deriva = conferido === 'deriva' || reservaMoveu;
  } else {
    // A read-back refused with 401/403 parks the conta (a permitted throw after a landed write).
    // The follow-up below is enqueued all the same: a park lifted (or a token swapped) before it
    // dispatches lets it run; otherwise it drops at the conta's park, at no store call.
    if (volta.erro instanceof LiAuthError) {
      await tratarFalhaDeAutenticacao(
        e.db,
        { integracaoId: e.contexto.integracaoId, lojaNome: lojaNomeDe(e.contexto) },
        volta.erro,
        e.deps,
      );
    }
    e.linhas.aviso('sem-conferencia', { idLi: e.idLi, classe: volta.classe });
    // Fail open: a reflected follow-up costs one read; a missed drift, a wrong number for a day.
    deriva = true;
  }
  if (!deriva) return 'nenhum';
  if (e.tarefa.geracao === 1) {
    e.linhas.aviso('deriva-sem-seguimento', { idLi: e.idLi });
    return 'sem-seguimento';
  }
  try {
    await enfileirarTarefaEstoqueLi(e.deps.agendador, e.deps.agoraMs, {
      contaId: e.tarefa.contaId,
      produtoId: e.tarefa.produtoId,
      origem: ORIGEM_TAREFA_ESTOQUE_LI.deriva,
      estoqueId: e.tarefa.estoqueId,
      apagado: e.tarefa.apagado,
      estoqueIds: e.tarefa.estoqueIds,
      geracao: 1,
    });
    return 'enfileirado';
  } catch (err) {
    // The sweep-only valve: the daily reconcile re-covers. ANY other rejection rethrows — a
    // transient Cloud Tasks failure, a broken deploy, the root's region guard, the strict parse —
    // and the retry re-derives everything from a fresh read (a permitted throw after a landed
    // write: `core/escrita.ts`, requirement 6 (i)).
    if (err instanceof LiTarefasDesligadasError) {
      e.linhas.aviso('deriva-tarefas-desligadas', { idLi: e.idLi });
      return 'tarefas-desligadas';
    }
    throw err;
  }
}
