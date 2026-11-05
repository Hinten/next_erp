/**
 * The body of the NF-e RE-DRIVE route `POST /api/marketplace/amazon/enviar-nfe`
 * (step 14, PR 14-d): put ONE pedido's approved sale NF-e back on the NF-e
 * queue (`processAmazonNfeUpload`). The route file only verifies the caller
 * (`PERM.pedido.write`), binds the deps and answers what this module returns.
 *
 * It exists for the documents the trigger never enqueued — or whose chain
 * ended in an aviso a person has since acted on: the approval edge is consumed
 * ONCE, and there is NO NF-e sweep. So every `nfeUploadRejeitado` aviso that
 * says "reenvie" (the valve, the read switch or the queue valve was shut, the
 * conta was unavailable, Amazon did not answer, a refusal a person fixed), and a
 * migrated pedido's note (an import fires no trigger), come back through here.
 *
 * Naming: "reenvio" in this module is the HUMAN re-drive — a FRESH chain at
 * `reenvios: 0`, built by `tarefaInicialNfeAmazon`. `tarefaNfe.ts`'s
 * `reenvioNfeAmazon` and the payload's `reenvios` counter are the chain's ONE
 * automatic resubmit, which this route never builds (a body carrying that
 * counter is a 400).
 *
 * ## ⚠️ Enqueue-only: zero Amazon calls, zero Firestore writes
 *
 * The ONE side effect is an UNNAMED enqueue of {@link tarefaInicialNfeAmazon}
 * (step-14 plan §3 decision 10: a Cloud Tasks tombstone on a name derived from
 * the pedido would refuse the next legitimate re-drive; the one named enqueue
 * is the trigger's). Every Amazon decision is the TASK's (`processarNfe.ts`):
 *
 * - it BYPASSES only the edge (a re-drive exists for a document ALREADY ready,
 *   exactly what a transition predicate would refuse) and the trigger's stored
 *   Delivery-by-Amazon pre-filter (the task decides that live);
 * - it NEVER bypasses the NF-e valve and its canary, the read switch (checked
 *   here AND again by the task's context), the live order gates, the
 *   status-first read, the ownership proof, the sale gate or the sibling rules.
 *   The proof and the sale gate run here too, so a pointless re-drive is a 409
 *   rather than an aviso; everything else the task re-checks on its own.
 *
 * So two kinds of pedido are enqueued ON PURPOSE, and answered by the task:
 *
 * - a stored cancelled SALE (`cancelado` / `estornadoIntegralmente`): the task
 *   answers it at P3 with the incidente `amz-nfe-pedido-cancelado` and zero
 *   Amazon calls — an incidente this write-free route cannot raise, and the
 *   only path to it for a migrated pedido;
 * - a pedido with TWO eligible sale notes: the slot rule names one (or the
 *   body named one — the explicit arm reads that document alone, never the
 *   listing), and the sibling rule is the task's (step-14 plan §3 decision 4),
 *   which raises the aviso `nfe-ambigua` at P5, before any Amazon call. The
 *   slot rule's ORDER (the latest authorization, a tie to the lowest id)
 *   therefore never decides an upload — with ONE eligible note there is
 *   nothing to order.
 *
 * Some of the task's outcomes are LOG-ONLY (`motivosNfe.ts`'s `SO_LOG`: the
 * live order is not Delivery by Amazon, needs no NF-e or belongs to another
 * marketplace, the conta is inactive, …): a 202 followed by no change on the
 * pedido's aviso is read in that pedido's `evento: 'nfe'` lines.
 *
 * ⚠️ It never reads `AMAZON_MODO_NFE` or `AMAZON_CANARIO_NFE` (step-14 plan §3
 * decision 20): ONE source of truth for a write, the task, which reads the
 * valve on the functions surface at run time — a route-side check could
 * disagree with it during W8. The only variable read from `ambiente` is the
 * read switch `AMAZON_CHAMADAS` (its test pins the key set).
 *
 * ## The ladder, in order
 *
 * 1. the body, STRICTLY `{ pedidoId, nfeId? }` (`pedidoId` the importer's
 *    64-hex digest, `nfeId` a document id; any other key — a `fase`, a counter —
 *    is refused, never ignored: the payload is minted by the builder) ⇒ 400
 *    `AMAZON_CORPO_INVALIDO` with the field PATHS;
 * 2. the read switch not exactly `on` ⇒ 503 `AMAZON_CHAMADAS_DESLIGADAS` (the
 *    conta routes' code, one blocked-call line), NOTHING read;
 * 3. the queue valve (`AMAZON_TASKS_DISABLED=1`) ⇒ 503
 *    `AMAZON_TAREFAS_DESLIGADAS`, NOTHING read;
 * 4. the queue's REGION, resolved and validated exactly as the producer will
 *    (`caminhoDaFilaNfeAmazon`): missing or malformed ⇒ ONE ERROR line naming
 *    `AMAZON_TASKS_REGION`, then the error PROPAGATES (500), NOTHING read — a
 *    broken deploy shows on the first re-drive, whatever the pedido (the
 *    receiver checks its region before any read too);
 * 5. the RAW pedido ⇒ 404 `AMAZON_PEDIDO_NAO_ENCONTRADO`;
 * 6. the TASK's verdict on it (`avaliarPedidoParaTarefaNfeAmazon`: the proof,
 *    then the emission block — never the trigger's stored pre-filter) ⇒ 409
 *    `AMAZON_NFE_NAO_ELEGIVEL` with `motivo` `nao-amazon` / `emissao-bloqueada`,
 *    before any NF-e read;
 * 7. the slot. An explicit `nfeId`: its raw document (absent ⇒ 404
 *    `AMAZON_NFE_NAO_ENCONTRADA`), judged by `motivoForaDoEnvioNfeAmazon` — the
 *    LEVEL predicate, then the sale gate, the one eligibility the slot reader
 *    applies ⇒ 409 with that motivo. No `nfeId`: ONE unfiltered listing of
 *    `pedidos/{pedidoId}/nfev4` (a subcollection: no index), and
 *    `escolherNfeParaEnvioAmazon` picks (the latest authorization, a tie to the
 *    lowest id, a cancelled slot never) ⇒ 409 with the CLOSEST miss. A proc
 *    ILLEGIBLE to the sale gate passes on purpose, on both paths: the task
 *    answers it loudly (`xml-invalido`, aviso and stamp), and a 409 here would
 *    hide both;
 * 8. the enqueue ⇒ 202 `{ enfileirado: true, pedidoId, nfeId }`.
 *
 * ## An enqueue that fails
 *
 * ONLY `AmazonNfeTarefasDesligadasError` (the valve, closed between rung 3 and
 * the enqueue) is ANSWERED ⇒ the same 503 `AMAZON_TAREFAS_DESLIGADAS`.
 * Everything else PROPAGATES (rule 6) and the platform answers 500 — after ONE
 * ERROR line (`resultado: 'falhou'`, `motivo: 'enfileiramento/<class>'`) for
 * each failure the route names:
 *
 * - a Cloud Tasks transient (`AmazonTarefasTransitoriasError`, already
 *   sanitized by the producer) and a region error (`MissingRegionError`,
 *   `AmazonNfeRegiaoDaFilaInvalidaError`) are rethrown AS THEY ARE;
 * - a RAW SDK failure (`FirebaseFunctionsError` / `FirebaseAppError`: a missing
 *   grant answers `permission-denied`, a queue not deployed in that region
 *   `not-found`) is rethrown as {@link AmazonNfeEnfileiramentoFalhouError} —
 *   class, code and HTTP status, no `cause`, no `httpResponse`: the SDK's error
 *   carries the answered headers and body as its OWN properties, and the
 *   platform's log of a thrown error prints them (the receiver and the poll
 *   contain the same failure by class);
 * - anything else (a Firestore read failure, a bug) is rethrown untouched,
 *   with no line.
 *
 * Deliberately NOT a 503 with a code of its own: a transient enqueue (a
 * deadline in particular) may have CREATED the task, so no answer can honestly
 * say "nothing was enqueued" — a 500 says the outcome is unknown. A region or
 * grant error is a broken deploy, for a person to fix, not for the caller to
 * retry.
 *
 * ⚠️ A repeated re-drive is NOT made harmless by the task's status-first read.
 * Amazon's invoice status lags a submit (the verification still reads
 * `sem-nota` as that lag through `ULTIMO_DEGRAU_DO_ATRASO_NFE_AMAZON`, ≈ 3 min),
 * and the queue dispatches a second task seconds after the first one's submit:
 * a second re-drive of the same pedido inside that window will most likely
 * SUBMIT THE NF-e AGAIN (the residual step-14 plan §5 risk 2 accepts). And this
 * route writes nothing, so a re-drive does not clear the pedido's aviso row —
 * the row changes only at the task's next outcome. Re-drive a pedido ONCE,
 * after a 500 too, and wait about 5 minutes (or for its aviso to change)
 * before re-driving it again.
 *
 * ## Logs
 *
 * ONE line per answer, through the app's one logger: the switch refusal is the
 * shared `chamada-bloqueada` line (`rota: 'enviar-nfe'`); every other answer is
 * one `evento: 'nfe'` line (`rota`, `resultado` = the code, `enfileirado` or
 * `falhou`, `motivo`, the pedido id once it passed its grammar, the NF-e id
 * only once it names a STORED document) — WARNING for the queue valve, ERROR
 * for a propagated failure the route names (above), INFO otherwise. A Firestore
 * read failure or a bug writes none (the platform logs it). Never the XML, a
 * body text, an issue list, a caller id or an SDK message.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { MissingRegionError } from '@delfrance/core/region';
import { nfev4Collection, pedidoCollection } from '@delfrance/data/admin/collections';
import {
  CODIGO_ERRO_AMAZON,
  CODIGO_ERRO_NFE_AMAZON,
  type ErroEnvioNfeAmazon,
  type RespostaEnvioNfeAmazon,
} from '@delfrance/schemas';
import { type ZodError, z } from 'zod';

import {
  AmazonTarefasTransitoriasError,
  descreverFalhaDoSdkDeTarefasAmazon,
  ehFalhaDoSdkDeTarefasAmazon,
} from '../core/filaTarefas';
import { type LoggerAmazon, type SeveridadeAmazon, registrarEventoAmazon } from '../core/log';
import {
  CHAMADAS_ENV_AMAZON,
  FLUXO_AMAZON,
  lerChaveDeChamadasAmazon,
  registrarChamadaBloqueadaAmazon,
} from '../core/valvulas';
import { type AmbienteAmazon, TASKS_REGION_ENV } from '../env';
import { lerCorpoLimitado } from '../notificacoes/corpo';
import {
  type AgendadorNfeAmazon,
  AmazonNfeRegiaoDaFilaInvalidaError,
  AmazonNfeTarefasDesligadasError,
  caminhoDaFilaNfeAmazon,
} from './agendadorNfe';
import type { MOTIVO_NFE_AMAZON } from './motivosNfe';
import {
  type MotivoSemNfeParaEnvioAmazon,
  avaliarPedidoParaTarefaNfeAmazon,
  escolherNfeParaEnvioAmazon,
  motivoForaDoEnvioNfeAmazon,
} from './pedidoNfe';
import { tarefaInicialNfeAmazon, tarefaNfeAmazonSchema } from './tarefaNfe';

/** The `rota` of this route's lines (the blocked-call line included). */
export const ROTA_REENVIO_NFE_AMAZON = 'enviar-nfe';

const ROTULO = '[amazon] enviar-nfe';

/**
 * The largest body read: 4 KiB. A bound on the READ (an authenticated caller
 * can still send anything), far above the largest valid body — a 64-character
 * pedido id and a 128-character NF-e id with their keys.
 */
export const MAX_CORPO_REENVIO_NFE_BYTES = 4 * 1024;

/** Everything one re-drive needs — injected, so a test drives the ladder with doubles. */
export interface DepsReenvioNfeAmazon {
  /**
   * The process environment. ONLY `AMAZON_CHAMADAS` is read from it — never the
   * NF-e valve or its canary (module header).
   */
  readonly ambiente: AmbienteAmazon;
  /** Resolved LAZILY: a refusal before rung 5 never builds the handle. */
  readonly db: () => Firestore;
  /** The queue valve, as the App Hosting root read it (exactly `'1'` closes it). */
  readonly filaDesligada: boolean;
  /**
   * The NF-e queue's region, as the App Hosting root resolves it for its
   * producer (`MissingRegionError` when unset) — checked at rung 4, before any
   * read.
   */
  readonly regiao: () => string;
  /** The NF-e producer, built only at the enqueue. */
  readonly agendador: () => AgendadorNfeAmazon;
  readonly logger: LoggerAmazon;
}

/** Why the pedido or its NF-e cannot go to Amazon — the 409's `motivo`, a closed slug. */
export type MotivoNaoElegivelReenvioNfeAmazon =
  | typeof MOTIVO_NFE_AMAZON.naoAmazon
  | typeof MOTIVO_NFE_AMAZON.emissaoBloqueada
  | MotivoSemNfeParaEnvioAmazon;

/** The 409's sentence, per motivo: built by name, never from a value. */
export const FRASES_NAO_ELEGIVEL_REENVIO_NFE_AMAZON: Readonly<
  Record<MotivoNaoElegivelReenvioNfeAmazon, string>
> = {
  'nao-amazon': 'O pedido não é um pedido da Amazon de uma conta deste ERP',
  'emissao-bloqueada': 'A emissão de NF-e está bloqueada neste pedido',
  apagada: 'A NF-e foi apagada',
  'nao-aprovada': 'A NF-e não está aprovada',
  'xml-ausente': 'A NF-e aprovada não tem o XML autorizado salvo',
  'tpamb-homologacao': 'A NF-e não foi autorizada em produção',
  'nfe-nao-e-de-venda': 'A NF-e não é uma nota de venda',
  'sem-nfe-aprovada': 'O pedido não tem NF-e aprovada',
};

/**
 * A RAW Cloud Tasks SDK failure of the re-drive's enqueue, sanitized (module
 * header, "An enqueue that fails"): the SDK class and code and the HTTP status
 * Cloud Tasks answered — never the SDK's message, which for a non-JSON answer
 * quotes the response body, and no `cause` or `httpResponse`, which a logger of
 * the thrown error would print whole. Still a 500.
 */
export class AmazonNfeEnfileiramentoFalhouError extends Error {
  /** `<class>/<code>` (`descreverFalhaDoSdkDeTarefasAmazon`). */
  readonly falha: string;
  /** The status Cloud Tasks answered; `null` when no request was answered. */
  readonly httpStatus: number | null;

  constructor(falha: string, httpStatus: number | null) {
    const status = httpStatus === null ? '' : `, HTTP ${String(httpStatus)}`;
    super(`enqueue da NF-e no Cloud Tasks falhou (${falha}${status}); o resultado é desconhecido`);
    this.name = 'AmazonNfeEnfileiramentoFalhouError';
    this.falha = falha;
    this.httpStatus = httpStatus;
  }
}

/** The `resultado` of the ERROR line a propagated failure writes (module header). */
const FALHOU = 'falhou';

/** What the route answers: a status and the JSON body, both built here. */
export type ResultadoReenvioNfeAmazon =
  | { readonly status: 202; readonly corpo: RespostaEnvioNfeAmazon }
  | { readonly status: 400 | 404 | 409 | 503; readonly corpo: ErroEnvioNfeAmazon };

/** The body, STRICTLY: the two ids by the task payload's own grammars. */
const corpoReenvioNfeSchema = z
  .object({
    pedidoId: tarefaNfeAmazonSchema.shape.pedidoId,
    nfeId: tarefaNfeAmazonSchema.shape.nfeId.nullable().optional(),
  })
  .strict();

/** The issue path of a refusal with no field of its own (no JSON, not an object, too big). */
const CORPO = '(corpo)';

type LeituraCorpoReenvio =
  | { readonly ok: true; readonly pedidoId: string; readonly nfeId: string | null }
  | { readonly ok: false; readonly issues: readonly string[] };

/** The field PATHS a refusal names — an unknown KEY is a path too; never a value. */
function caminhosDosProblemas(err: ZodError): string[] {
  const caminhos = new Set<string>();
  for (const issue of err.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const chave of issue.keys) caminhos.add(chave);
    } else {
      caminhos.add(issue.path.length === 0 ? CORPO : issue.path.map(String).join('.'));
    }
  }
  return [...caminhos].sort();
}

/** Rung 1: the bounded read, the JSON, the strict shape. */
async function lerCorpo(req: Request): Promise<LeituraCorpoReenvio> {
  const lido = await lerCorpoLimitado(
    req.body,
    req.headers.get('content-length'),
    MAX_CORPO_REENVIO_NFE_BYTES,
  );
  if (lido.tipo === 'grande') return { ok: false, issues: [CORPO] };
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(lido.dados));
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return { ok: false, issues: [CORPO] };
  }
  const corpo = corpoReenvioNfeSchema.safeParse(json);
  if (!corpo.success) return { ok: false, issues: caminhosDosProblemas(corpo.error) };
  return { ok: true, pedidoId: corpo.data.pedidoId, nfeId: corpo.data.nfeId ?? null };
}

/** The ONE `evento: 'nfe'` line of an answer (module header). */
function registrar(
  deps: DepsReenvioNfeAmazon,
  severidade: SeveridadeAmazon,
  resultado: string,
  campos: {
    readonly motivo?: string;
    readonly pedidoId?: string;
    readonly nfeId?: string;
  } = {},
): void {
  registrarEventoAmazon(
    deps.logger,
    'nfe',
    severidade,
    `${ROTULO} ${resultado}`,
    {
      rota: ROTA_REENVIO_NFE_AMAZON,
      resultado,
      motivo: campos.motivo ?? null,
      pedidoId: campos.pedidoId ?? null,
      nfeId: campos.nfeId ?? null,
    },
    { fluxo: FLUXO_AMAZON.nfe },
  );
}

/** An error answer: the envelope, built by name. */
function erro(
  status: 400 | 404 | 409 | 503,
  code: string,
  error: string,
  extras: { readonly issues?: readonly string[]; readonly motivo?: string } = {},
): ResultadoReenvioNfeAmazon {
  return {
    status,
    corpo: {
      error,
      code,
      ...(extras.issues === undefined ? {} : { issues: [...extras.issues] }),
      ...(extras.motivo === undefined ? {} : { motivo: extras.motivo }),
    },
  };
}

function tarefasDesligadas(
  deps: DepsReenvioNfeAmazon,
  pedidoId: string,
): ResultadoReenvioNfeAmazon {
  registrar(deps, 'WARNING', CODIGO_ERRO_NFE_AMAZON.TAREFAS_DESLIGADAS, { pedidoId });
  return erro(
    503,
    CODIGO_ERRO_NFE_AMAZON.TAREFAS_DESLIGADAS,
    'A fila de envio de NF-e à Amazon está desligada neste backend (AMAZON_TASKS_DISABLED); ' +
      'nada foi enfileirado. Tente de novo quando a fila for religada.',
  );
}

function naoElegivel(
  deps: DepsReenvioNfeAmazon,
  pedidoId: string,
  motivo: MotivoNaoElegivelReenvioNfeAmazon,
  nfeId?: string,
): ResultadoReenvioNfeAmazon {
  registrar(deps, 'INFO', CODIGO_ERRO_NFE_AMAZON.NFE_NAO_ELEGIVEL, {
    motivo,
    pedidoId,
    ...(nfeId === undefined ? {} : { nfeId }),
  });
  return erro(
    409,
    CODIGO_ERRO_NFE_AMAZON.NFE_NAO_ELEGIVEL,
    `${FRASES_NAO_ELEGIVEL_REENVIO_NFE_AMAZON[motivo]}; nada foi enfileirado.`,
    { motivo },
  );
}

/** One raw document body, as the slot readers take it. */
function bruto(dados: unknown): Readonly<Record<string, unknown>> {
  return (dados ?? {}) as Record<string, unknown>;
}

/**
 * Re-drive ONE pedido's NF-e: the ladder of the module header, answered as a
 * status and a JSON body. Throws only what it must not answer (module header,
 * "An enqueue that fails").
 */
export async function reenviarNfeAmazon(
  req: Request,
  deps: DepsReenvioNfeAmazon,
): Promise<ResultadoReenvioNfeAmazon> {
  // ---- 1. the body, strictly — before anything else is read. ----
  const corpo = await lerCorpo(req);
  if (!corpo.ok) {
    registrar(deps, 'INFO', CODIGO_ERRO_NFE_AMAZON.CORPO_INVALIDO);
    return erro(
      400,
      CODIGO_ERRO_NFE_AMAZON.CORPO_INVALIDO,
      'Corpo inválido: envie apenas { pedidoId, nfeId? } — pedidoId é o id do documento do ' +
        'pedido no ERP (64 caracteres hexadecimais, o mesmo da URL da tela do pedido), não o ' +
        'número do pedido na Amazon; nfeId, quando informado, é o id de um documento de NF-e ' +
        'do pedido. Nada foi enfileirado.',
      { issues: corpo.issues },
    );
  }
  const { pedidoId } = corpo;

  // ---- 2. the read switch — nothing read before it answers. ----
  if (!lerChaveDeChamadasAmazon(deps.ambiente)) {
    registrarChamadaBloqueadaAmazon(deps.logger, {
      rota: ROTA_REENVIO_NFE_AMAZON,
      valor: deps.ambiente[CHAMADAS_ENV_AMAZON],
    });
    return erro(
      503,
      CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS,
      'As chamadas à Amazon estão desligadas neste backend (até a migração, ou por ' +
        'configuração); nada foi enfileirado.',
    );
  }

  // ---- 3. the queue valve — nothing read before it answers. ----
  if (deps.filaDesligada) return tarefasDesligadas(deps, pedidoId);

  // ---- 4. the queue's region — a broken deploy surfaces before any read. ----
  try {
    caminhoDaFilaNfeAmazon(deps.regiao());
  } catch (err) {
    if (err instanceof MissingRegionError || err instanceof AmazonNfeRegiaoDaFilaInvalidaError) {
      registrar(deps, 'ERROR', FALHOU, { motivo: `${TASKS_REGION_ENV}/${err.name}`, pedidoId });
    }
    throw err;
  }

  // ---- 5. the pedido, raw. ----
  const db = deps.db();
  const pedidoSnap = await pedidoCollection.docRef(db, {}, pedidoId).get();
  if (!pedidoSnap.exists) {
    registrar(deps, 'INFO', CODIGO_ERRO_NFE_AMAZON.PEDIDO_NAO_ENCONTRADO, { pedidoId });
    return erro(
      404,
      CODIGO_ERRO_NFE_AMAZON.PEDIDO_NAO_ENCONTRADO,
      'Pedido não encontrado; nada foi enfileirado.',
    );
  }

  // ---- 6. the TASK's verdict: the proof, then the emission block. ----
  const avaliacao = avaliarPedidoParaTarefaNfeAmazon(pedidoId, bruto(pedidoSnap.data()));
  if (!avaliacao.ok) return naoElegivel(deps, pedidoId, avaliacao.motivo);

  // ---- 7. the slot. ----
  let nfeId: string;
  if (corpo.nfeId !== null) {
    const nfeSnap = await nfev4Collection.docRef(db, { pedidoId }, corpo.nfeId).get();
    if (!nfeSnap.exists) {
      registrar(deps, 'INFO', CODIGO_ERRO_NFE_AMAZON.NFE_NAO_ENCONTRADA, { pedidoId });
      return erro(
        404,
        CODIGO_ERRO_NFE_AMAZON.NFE_NAO_ENCONTRADA,
        'A NF-e informada não foi encontrada neste pedido; nada foi enfileirado. Confira o ' +
          'nfeId, ou omita-o para que a NF-e aprovada do pedido seja escolhida.',
      );
    }
    const fora = motivoForaDoEnvioNfeAmazon(bruto(nfeSnap.data()));
    if (fora !== null) return naoElegivel(deps, pedidoId, fora, corpo.nfeId);
    nfeId = corpo.nfeId;
  } else {
    const lista = await nfev4Collection.ref(db, { pedidoId }).get();
    const escolha = escolherNfeParaEnvioAmazon(
      lista.docs.map((d) => ({ id: d.id, raw: bruto(d.data()) })),
    );
    if ('motivo' in escolha) return naoElegivel(deps, pedidoId, escolha.motivo);
    nfeId = escolha.nfeId;
  }

  // ---- 8. the ONE side effect: an UNNAMED enqueue. ----
  try {
    await deps.agendador().enfileirar(tarefaInicialNfeAmazon(pedidoId, nfeId));
  } catch (err) {
    if (err instanceof AmazonNfeTarefasDesligadasError) return tarefasDesligadas(deps, pedidoId);
    if (ehFalhaDoSdkDeTarefasAmazon(err)) {
      const falha = descreverFalhaDoSdkDeTarefasAmazon(err);
      registrar(deps, 'ERROR', FALHOU, { motivo: `enfileiramento/${falha}`, pedidoId, nfeId });
      throw new AmazonNfeEnfileiramentoFalhouError(falha, err.httpResponse?.status ?? null);
    }
    if (
      err instanceof AmazonTarefasTransitoriasError ||
      err instanceof MissingRegionError ||
      err instanceof AmazonNfeRegiaoDaFilaInvalidaError
    ) {
      registrar(deps, 'ERROR', FALHOU, { motivo: `enfileiramento/${err.name}`, pedidoId, nfeId });
    }
    throw err;
  }
  registrar(deps, 'INFO', 'enfileirado', { pedidoId, nfeId });
  return { status: 202, corpo: { enfileirado: true, pedidoId, nfeId } };
}
