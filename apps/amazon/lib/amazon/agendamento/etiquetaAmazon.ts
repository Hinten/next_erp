/**
 * The body of the label route `POST /api/marketplace/amazon/etiqueta` (step 15,
 * PR 15-d): print ONE Amazon pedido's Easy Ship ZPL label, inside the request.
 * The route file only verifies the caller (`PERM.frete.read`), binds the deps and
 * answers what this module returns.
 *
 * The label is never stored, so every print asks Amazon for it: the live order
 * decides, and the scheduling bulk answers a fresh pre-signed link to a zip. For
 * an order not scheduled yet that same call schedules it, which is why a first
 * schedule needs `podeAgendar` (the caller's `frete.write`) and a reprint does
 * not (step-15 plan §3 decisions 7 and 18). This module is the ONE production
 * file naming the two document helpers, so the link has one reader.
 *
 * ## The ladder, in order
 *
 * - **R2 — the body.** At most {@link MAX_CORPO_ETIQUETA_BYTES}, JSON, STRICTLY
 *   `{ pedidoId }` with the ERP pedido document id; anything else ⇒ 400
 *   `CORPO_INVALIDO` with the field PATHS.
 * - **R3 — the read switch.** Not exactly `on` ⇒ 503
 *   `AMAZON_CHAMADAS_DESLIGADAS`, nothing read.
 * - **R4 — the valve**, read once and logged (`evento: 'valvula'`).
 * - **R5 — the pedido and its NF-e documents.** ONE raw pedido read (absent ⇒ 404
 *   `PEDIDO_NAO_ENCONTRADO`), then ONE unfiltered `nfev4` listing (a subcollection:
 *   no index) through `gateNotasAgendamentoAmazon`, which gates a first schedule
 *   only: a reprint over an existing schedule still prints.
 * - **R6 — the stored gates** (`gatesArmazenadosAgendamentoAmazon`) ⇒ 409
 *   `NAO_ELEGIVEL` with the motivo.
 * - **R7 — the target** under the valve. `off` ⇒ 503 `DESLIGADA`, zero Amazon calls.
 * - **R8 — the context** (`loadAmazonContext`, through
 *   `classificarFalhaDeLeituraAmazon`): an inactive, unknown, unconnected or parked
 *   conta, or a credential refusal ⇒ 503 `CONTA_INDISPONIVEL`. The conta comes from
 *   the pedido, so "absent" is a conta problem here, never a 404 of the request.
 * - **R9 — the run** (`executarAgendamentoAmazon`, `modo: 'impressao'`, no attempt,
 *   so a read older than the stored floor comes back flagged and the plan never
 *   writes on it). Without a write:
 *   - a stale read, whatever the order says ⇒ 503 `AMAZON_INDISPONIVEL`;
 *   - a dry-run, or `on` outside the canary ⇒ 503 `DESLIGADA`: no label without
 *     the bulk;
 *   - `agendar` and the caller may not schedule ⇒ 403 `SEM_PERMISSAO`;
 *   - `aceite-pendente` ⇒ 409 `AGUARDANDO_NFE`, its motivo keyed on the order-level
 *     invoice status;
 *   - any refusal (the NF-e gate's included) ⇒ 409 `NAO_ELEGIVEL`.
 *   A failure before the plan reached the write (`fase: 'leitura'`, nothing was
 *   sent) reads through the shared class ladder and is NEVER `RECUSADA`.
 * - **R10 — the bulk's outcome**, decided by `desfechoImpressaoAgendamentoAmazon`:
 *   each of its tokens has one answer here, and the table itself lives there.
 * - **R11 — the download** of the zip, immediately, with the SAME `fetch` the
 *   context got; a refusal ⇒ 502 `INDISPONIVEL`.
 * - **R12 — the extraction** of exactly one ZPL entry; a refusal ⇒ 502
 *   `INDISPONIVEL`. The zip is never forwarded.
 * - **R13 — the answer**: the entry's bytes, as `amazon-<orderId>.zpl`.
 *
 * ## What leaves as a 500
 *
 * The LWA pair missing from the deploy (`ConfigAmazonAusenteError`), a Firestore
 * error, and a package class no table answers (an `AmazonConfigError`: a bug) write
 * ONE ERROR line (`resultado: 'falhou'`, the class only) and propagate, through
 * `sanitizarFalhaDaTarefaAmazon`: a package error's message can embed a request
 * path, and the platform logs what a route throws. Anything else (a `TypeError`)
 * propagates untouched, with no line (root `CLAUDE.md` rule 6).
 *
 * ## Rule 7
 *
 * NO pedido, freight, scheduling or aviso write, and no enqueue (step-15 plan §3
 * decisions 6 and 14): the operator reads the reason in the answer, the scheduling
 * task raises the avisos, and the order import mirrors the schedule. The ONE write
 * this request can cause is the context's own, when a request meets a stale LWA
 * token or the forced refresh after a 401/403 renews it: the credential's field
 * patch, then the resolve of a standing `amazonSegredoLwaRecusado`. The bulk is sent
 * at most once per request (twice only through the engine's forced-refresh rule, on
 * a 401/403, which was not processed).
 *
 * ## The one line per answer
 *
 * `evento: 'agendamento'` with exactly the campos of {@link registrar}: ids, closed
 * tokens, codes through their grammars and byte counts. The switch's refusal is the
 * shared `chamada-bloqueada` line. A label's pre-signed link (its host and query
 * too), the Restricted Data Token, a ZPL or zip byte, a zip entry name, a tracking,
 * package or slot id, Amazon's text and the caller's uid never reach this line. The
 * SP-API CALL lines (`evento: 'chamada'`) are the observer's own, and by step 2b's
 * design their excerpt keeps Amazon-made ids.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { nfev4Collection, pedidoCollection } from '@delfrance/data/admin/collections';
import { isGrpcStatusError } from '@delfrance/data/admin/grpcErrors';
import {
  AmazonDocumentoEasyShipError,
  AmazonError,
  AmazonHttpError,
  baixarDocumentosEasyShip,
  extrairEtiquetaZplEasyShip,
} from '@delfrance/integrations-amazon-sp-api';
import {
  CODIGO_ERRO_AMAZON,
  CODIGO_ERRO_ETIQUETA_AMAZON,
  type CodigoErroEtiquetaAmazon,
  type ErroEtiquetaAmazon,
  MOTIVO_ETIQUETA_AMAZON,
} from '@delfrance/schemas';
import { type ZodError, z } from 'zod';

import { type ContextoAmazon, type ContextoAmazonDeps, loadAmazonContext } from '../core/contexto';
import { ConfigAmazonAusenteError } from '../core/erros';
import { type LoggerAmazon, type SeveridadeAmazon, registrarEventoAmazon } from '../core/log';
import { codigoDeErroSeguro } from '../core/redacao';
import {
  CHAMADAS_ENV_AMAZON,
  FLUXO_AMAZON,
  MODO_AMAZON,
  decidirAlvo,
  lerChaveDeChamadasAmazon,
  lerValvula,
  registrarChamadaBloqueadaAmazon,
  registrarValvulaAmazon,
} from '../core/valvulas';
import type { AmbienteAmazon } from '../env';
import { pisoDoPedidoAmazon } from '../nfe/pedidoNfe';
import { tarefaNfeAmazonSchema } from '../nfe/tarefaNfe';
import { lerCorpoLimitado } from '../notificacoes/corpo';
import { sanitizarFalhaDaTarefaAmazon } from '../notificacoes/notificacao';
import {
  FALHA_LEITURA_AMAZON,
  classificarFalhaDeLeituraAmazon,
} from '../pedidos/falhaLeituraAmazon';
import {
  ACAO_AGENDAMENTO_AMAZON,
  type AcaoAgendamentoAmazon,
  MODO_AGENDAMENTO_AMAZON,
  MOTIVO_LEITURA_DEFASADA_AGENDAMENTO_AMAZON,
  type MotivoAceitePendenteAgendamentoAmazon,
  type PlanoAgendamentoAmazon,
  type ResultadoBulkImpressaoAgendamentoAmazon,
  desfechoImpressaoAgendamentoAmazon,
  gateNotasAgendamentoAmazon,
  gatesArmazenadosAgendamentoAmazon,
  lerRespostaAgendamentoAmazon,
} from './decisaoAgendamento';
import { FASE_FALHA_AGENDAMENTO_AMAZON, executarAgendamentoAmazon } from './executarAgendamento';

/** The `rota` of this route's lines (the blocked-call line included). */
export const ROTA_ETIQUETA_AMAZON = 'etiqueta';

const ROTULO = '[amazon] etiqueta';

/**
 * The largest body read: 4 KiB. A bound on the READ (an authenticated caller can
 * still send anything), far above the one valid body, a 64-character id and its key.
 */
export const MAX_CORPO_ETIQUETA_BYTES = 4 * 1024;

/** The `resultado` of the line of a label answered. */
const IMPRESSO = 'impresso';

/** The `resultado` of the ERROR line of a failure that leaves as a 500. */
const FALHOU = 'falhou';

/** Everything one print needs — injected, so a test drives the ladder with doubles. */
export interface DepsEtiquetaAmazon {
  /** The process environment: the read switch, the LWA pair, the scheduling valve and canary. */
  readonly ambiente: AmbienteAmazon;
  /** Resolved LAZILY: a refusal before R5 never builds the handle. */
  readonly db: () => Firestore;
  readonly logger: LoggerAmazon;
  /** Whether the caller may make a FIRST schedule (`frete.write`). */
  readonly podeAgendar: boolean;
  /**
   * Test seam, resolved ONCE and handed to BOTH the context and the download, so
   * one scripted `fetch` sees every request a print makes.
   */
  readonly fetch?: typeof globalThis.fetch;
  /** Test seams: now in MILLISECONDS (default `Date.now`), and the correlation ids. */
  readonly agora?: () => number;
  readonly gerarCorrelationId?: () => string;
}

/** Every status an error answer of this route can carry. */
export type StatusErroEtiquetaAmazon = 400 | 403 | 404 | 409 | 502 | 503;

/** What the route answers: the label's bytes, or a status and the JSON envelope. */
export type ResultadoEtiquetaAmazon =
  | { readonly tipo: 'zpl'; readonly bytes: Uint8Array; readonly nomeArquivo: string }
  | {
      readonly tipo: 'erro';
      readonly status: StatusErroEtiquetaAmazon;
      readonly corpo: ErroEtiquetaAmazon;
    };

/** Every code this route answers: its own set, and the read switch's. */
type CodigoRespostaEtiqueta =
  | CodigoErroEtiquetaAmazon
  | typeof CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS;

/** One code's answer: its status, its default sentence, and whether the answer carries the motivo. */
interface RespostaDoCodigo {
  readonly status: StatusErroEtiquetaAmazon;
  readonly error: string;
  readonly comMotivo: boolean;
}

/**
 * Every code's answer. Only the 409s carry a `motivo`: the 502 and 503 detail stays
 * in the log, because the operator's remedy is the same for each. The 503 of
 * `AMAZON_INDISPONIVEL` says to WAIT and reprint, never to try again: a cut bulk may
 * still be running at Amazon (step-15 plan §3 decision 11).
 */
const RESPOSTAS: Readonly<Record<CodigoRespostaEtiqueta, RespostaDoCodigo>> = {
  [CODIGO_ERRO_ETIQUETA_AMAZON.CORPO_INVALIDO]: {
    status: 400,
    comMotivo: false,
    error:
      'Corpo inválido: envie apenas { pedidoId } — o id do documento do pedido no ERP (64 ' +
      'caracteres hexadecimais, o mesmo da URL da tela do pedido), não o número do pedido na ' +
      'Amazon. Nada foi enviado à Amazon.',
  },
  [CODIGO_ERRO_ETIQUETA_AMAZON.PEDIDO_NAO_ENCONTRADO]: {
    status: 404,
    comMotivo: false,
    error: 'Pedido não encontrado; nada foi enviado à Amazon.',
  },
  [CODIGO_ERRO_ETIQUETA_AMAZON.SEM_PERMISSAO]: {
    status: 403,
    comMotivo: false,
    error:
      'A coleta deste pedido ainda não foi agendada, e agendar exige permissão de escrita de ' +
      'frete; nada foi enviado à Amazon.',
  },
  [CODIGO_ERRO_ETIQUETA_AMAZON.NAO_ELEGIVEL]: {
    status: 409,
    comMotivo: true,
    error: 'A etiqueta deste pedido não pode ser impressa agora; nada foi enviado à Amazon.',
  },
  [CODIGO_ERRO_ETIQUETA_AMAZON.AGUARDANDO_NFE]: {
    status: 409,
    comMotivo: true,
    error: 'A Amazon ainda não aceitou a NF-e deste pedido; nada foi enviado à Amazon.',
  },
  [CODIGO_ERRO_ETIQUETA_AMAZON.RECUSADA]: {
    status: 409,
    comMotivo: true,
    error: 'A Amazon recusou agendar a coleta deste pedido.',
  },
  [CODIGO_ERRO_ETIQUETA_AMAZON.INDISPONIVEL]: {
    status: 502,
    comMotivo: false,
    error: 'A Amazon não devolveu uma etiqueta utilizável; imprima pelo Seller Central.',
  },
  [CODIGO_ERRO_ETIQUETA_AMAZON.AMAZON_INDISPONIVEL]: {
    status: 503,
    comMotivo: false,
    error:
      'A Amazon está indisponível no momento. Aguarde cerca de 1 minuto e reimprima pela lista ' +
      'de pedidos.',
  },
  [CODIGO_ERRO_ETIQUETA_AMAZON.CONTA_INDISPONIVEL]: {
    status: 503,
    comMotivo: false,
    error:
      'A conta Amazon deste pedido não pode ser usada agora (desativada, desconectada ou com a ' +
      'autorização pendente); nenhuma coleta foi agendada por esta impressão.',
  },
  [CODIGO_ERRO_ETIQUETA_AMAZON.DESLIGADA]: {
    status: 503,
    comMotivo: false,
    error:
      'A impressão de etiquetas da Amazon está desligada para este pedido neste backend; ' +
      'imprima pelo Seller Central.',
  },
  [CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS]: {
    status: 503,
    comMotivo: false,
    error:
      'As chamadas à Amazon estão desligadas neste backend (até a migração, ou por ' +
      'configuração); nada foi enviado à Amazon.',
  },
};

/**
 * The `AGUARDANDO_NFE` sentence per motivo: only the first one may ask for a wait.
 * A note Amazon refused or never received does not resolve itself, however many
 * reprints it gets.
 */
const FRASES_AGUARDANDO_NFE: Readonly<Record<MotivoAceitePendenteAgendamentoAmazon, string>> = {
  [MOTIVO_ETIQUETA_AMAZON.nfeEmProcessamento]:
    'A Amazon ainda está processando a NF-e deste pedido. Reimprima pela lista de pedidos ' +
    'depois do aceite; nada foi enviado à Amazon.',
  [MOTIVO_ETIQUETA_AMAZON.nfeRecusadaPelaAmazon]:
    'A Amazon recusou a NF-e deste pedido. Veja o aviso de NF-e do pedido; nada foi enviado à ' +
    'Amazon.',
  [MOTIVO_ETIQUETA_AMAZON.nfeNaoEnviada]:
    'A Amazon não recebeu a NF-e deste pedido. Veja o aviso de NF-e do pedido; nada foi enviado ' +
    'à Amazon.',
};

/**
 * The `RECUSADA` sentence per motivo: `dimensoes-ausentes` names its remedy, while
 * `agendamento-recusado` names none, because the codes behind it have different
 * causes and the code stays in the log.
 */
const FRASES_RECUSADA = {
  [MOTIVO_ETIQUETA_AMAZON.dimensoesAusentes]:
    'A Amazon recusou agendar a coleta: faltam dimensões ou peso no anúncio deste pedido.',
  [MOTIVO_ETIQUETA_AMAZON.agendamentoRecusado]: 'A Amazon recusou agendar a coleta deste pedido.',
} as const;

/* -------------------------------------------------------------------------- */
/*                                  the body                                  */
/* -------------------------------------------------------------------------- */

/** The body, STRICTLY: the pedido id by the NF-e payload's own grammar (the same document id). */
const corpoEtiquetaSchema = z.object({ pedidoId: tarefaNfeAmazonSchema.shape.pedidoId }).strict();

/** The issue path of a refusal with no field of its own (no JSON, not an object, too big). */
const CORPO = '(corpo)';

type LeituraCorpoEtiqueta =
  | { readonly ok: true; readonly pedidoId: string }
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

/** R2: the bounded read, the JSON, the strict shape. */
async function lerCorpo(req: Request): Promise<LeituraCorpoEtiqueta> {
  const lido = await lerCorpoLimitado(
    req.body,
    req.headers.get('content-length'),
    MAX_CORPO_ETIQUETA_BYTES,
  );
  if (lido.tipo === 'grande') return { ok: false, issues: [CORPO] };
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(lido.dados));
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return { ok: false, issues: [CORPO] };
  }
  const corpo = corpoEtiquetaSchema.safeParse(json);
  if (!corpo.success) return { ok: false, issues: caminhosDosProblemas(corpo.error) };
  return { ok: true, pedidoId: corpo.data.pedidoId };
}

/* -------------------------------------------------------------------------- */
/*                                the one line                                */
/* -------------------------------------------------------------------------- */

/** What one answer's line knows, as far as the ladder got. */
interface CamposDaLinha {
  readonly pedidoId?: string;
  readonly conta?: string;
  readonly pedido?: string;
  readonly acao?: AcaoAgendamentoAmazon;
  /** A closed token: a refusal's slug, a failure's class token, a dry-run's reason. */
  readonly motivo?: string;
  readonly bytesZip?: number;
  readonly bytesZpl?: number;
  /** Our order's rejection code, as the answer's reader put it through its grammar. */
  readonly codigoRejeicao?: string | null;
  /** An HTTP failure's codes, raw: the line keeps only the closed ones. */
  readonly codigos?: readonly string[];
}

/** The ONE `evento: 'agendamento'` line of an answer (module header). */
function registrar(
  deps: DepsEtiquetaAmazon,
  severidade: SeveridadeAmazon,
  resultado: string,
  c: CamposDaLinha,
): void {
  registrarEventoAmazon(
    deps.logger,
    'agendamento',
    severidade,
    `${ROTULO} ${resultado}`,
    {
      rota: ROTA_ETIQUETA_AMAZON,
      resultado,
      motivo: c.motivo ?? null,
      acao: c.acao ?? null,
      pedidoId: c.pedidoId ?? null,
      pedido: c.pedido ?? null,
      bytesZip: c.bytesZip ?? null,
      bytesZpl: c.bytesZpl ?? null,
      codigoRejeicao: c.codigoRejeicao ?? null,
      codigos:
        c.codigos === undefined || c.codigos.length === 0
          ? null
          : c.codigos.map(codigoDeErroSeguro).join(','),
    },
    { fluxo: FLUXO_AMAZON.agendamento, conta: c.conta ?? null },
  );
}

/** The envelope of `codigo`, with no line. */
function responder(
  codigo: CodigoRespostaEtiqueta,
  extras: {
    readonly motivo?: string;
    readonly issues?: readonly string[];
    readonly error?: string;
  } = {},
): ResultadoEtiquetaAmazon {
  const resposta = RESPOSTAS[codigo];
  return {
    tipo: 'erro',
    status: resposta.status,
    corpo: {
      error: extras.error ?? resposta.error,
      code: codigo,
      ...(extras.issues === undefined ? {} : { issues: [...extras.issues] }),
      ...(resposta.comMotivo && extras.motivo !== undefined ? { motivo: extras.motivo } : {}),
    },
  };
}

/** An error answer and its ONE line: a 5xx a person has to look at is a WARNING. */
function recusar(
  deps: DepsEtiquetaAmazon,
  codigo: CodigoRespostaEtiqueta,
  c: CamposDaLinha,
  extras: { readonly issues?: readonly string[]; readonly error?: string } = {},
): ResultadoEtiquetaAmazon {
  registrar(deps, RESPOSTAS[codigo].status >= 500 ? 'WARNING' : 'INFO', codigo, c);
  return responder(codigo, { ...extras, motivo: c.motivo });
}

/** A named failure's CLASS, with its gRPC code; `null` for what this route does not name (a bug). */
function classeNomeada(err: unknown): string | null {
  if (isGrpcStatusError(err)) return `Firestore/${String(err.code)}`;
  if (err instanceof ConfigAmazonAusenteError || err instanceof AmazonError) return err.name;
  return null;
}

/**
 * What leaves as a 500 (module header): ONE ERROR line for a failure this route
 * names, then the failure itself, sanitized. For the caller to `throw`.
 */
function falhaQueSai(deps: DepsEtiquetaAmazon, c: CamposDaLinha, err: unknown): unknown {
  const classe = classeNomeada(err);
  if (classe !== null) registrar(deps, 'ERROR', FALHOU, { ...c, motivo: classe });
  return sanitizarFalhaDaTarefaAmazon(err);
}

/** An HTTP failure's codes, or none. */
function codigosDe(err: unknown): readonly string[] {
  return err instanceof AmazonHttpError ? err.codigosErro : [];
}

/* -------------------------------------------------------------------------- */
/*                            R8, R9: the read side                           */
/* -------------------------------------------------------------------------- */

/**
 * A failure with nothing sent (the context, or the run's `fase: 'leitura'`), through
 * the shared class ladder: NEVER `RECUSADA`, because no bulk was sent. `null` for
 * what the ladder does not answer: the caller throws it ({@link falhaQueSai}).
 */
function falhaDeLeitura(
  deps: DepsEtiquetaAmazon,
  c: CamposDaLinha,
  err: unknown,
): ResultadoEtiquetaAmazon | null {
  const falha = classificarFalhaDeLeituraAmazon(err);
  const comFalha: CamposDaLinha = { ...c, motivo: falha, codigos: codigosDe(err) };
  switch (falha) {
    case FALHA_LEITURA_AMAZON.pausa:
    case FALHA_LEITURA_AMAZON.transitorio:
      return recusar(deps, CODIGO_ERRO_ETIQUETA_AMAZON.AMAZON_INDISPONIVEL, comFalha);
    case FALHA_LEITURA_AMAZON.authLwa:
    case FALHA_LEITURA_AMAZON.authSpApi:
    case FALHA_LEITURA_AMAZON.contaInativa:
    case FALHA_LEITURA_AMAZON.contaIndisponivel:
      return recusar(deps, CODIGO_ERRO_ETIQUETA_AMAZON.CONTA_INDISPONIVEL, comFalha);
    case FALHA_LEITURA_AMAZON.naoEncontrado:
    case FALHA_LEITURA_AMAZON.httpDefinitivo:
    case FALHA_LEITURA_AMAZON.esquema:
    case FALHA_LEITURA_AMAZON.ilegivel:
      return recusar(deps, CODIGO_ERRO_ETIQUETA_AMAZON.INDISPONIVEL, comFalha);
    case FALHA_LEITURA_AMAZON.chamadasDesligadas:
      return recusar(deps, CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS, comFalha);
    case FALHA_LEITURA_AMAZON.relancar:
      return null;
  }
}

/** R9: a plan that wrote nothing (module header). */
function semEscrita(
  deps: DepsEtiquetaAmazon,
  c: CamposDaLinha,
  plano: PlanoAgendamentoAmazon,
): ResultadoEtiquetaAmazon {
  const comAcao: CamposDaLinha = { ...c, acao: plano.acao };
  // Whatever the stale read says the order is: the stored order is newer.
  if (plano.motivo === MOTIVO_LEITURA_DEFASADA_AGENDAMENTO_AMAZON) {
    return recusar(deps, CODIGO_ERRO_ETIQUETA_AMAZON.AMAZON_INDISPONIVEL, {
      ...comAcao,
      motivo: plano.motivo,
    });
  }
  const { decisao } = plano;
  switch (plano.acao) {
    case ACAO_AGENDAMENTO_AMAZON.agendar:
      // Only a caller who may not schedule reaches here with a plan to schedule.
      return recusar(deps, CODIGO_ERRO_ETIQUETA_AMAZON.SEM_PERMISSAO, comAcao);
    case ACAO_AGENDAMENTO_AMAZON.aceitePendente: {
      const motivo =
        decisao.acao === ACAO_AGENDAMENTO_AMAZON.aceitePendente
          ? decisao.motivo
          : MOTIVO_ETIQUETA_AMAZON.nfeEmProcessamento;
      return recusar(
        deps,
        CODIGO_ERRO_ETIQUETA_AMAZON.AGUARDANDO_NFE,
        { ...comAcao, motivo },
        { error: FRASES_AGUARDANDO_NFE[motivo] },
      );
    }
    case ACAO_AGENDAMENTO_AMAZON.recusar:
      return recusar(deps, CODIGO_ERRO_ETIQUETA_AMAZON.NAO_ELEGIVEL, {
        ...comAcao,
        motivo: plano.motivo ?? MOTIVO_ETIQUETA_AMAZON.statusPedidoInesperado,
      });
    case ACAO_AGENDAMENTO_AMAZON.jaAgendado:
      // In `impressao` mode a non-stale `ja-agendado` always writes.
      throw new TypeError('etiquetaAmazon.ts: um plano de reimpressão que não escreve');
  }
}

/* -------------------------------------------------------------------------- */
/*                      R10–R13: after the bulk, the label                    */
/* -------------------------------------------------------------------------- */

/** The two actions that write in `impressao` mode; anything else is a contract bug of the run. */
function acaoDaImpressao(
  acao: AcaoAgendamentoAmazon,
): typeof ACAO_AGENDAMENTO_AMAZON.agendar | typeof ACAO_AGENDAMENTO_AMAZON.jaAgendado {
  if (acao === ACAO_AGENDAMENTO_AMAZON.agendar || acao === ACAO_AGENDAMENTO_AMAZON.jaAgendado) {
    return acao;
  }
  throw new TypeError('etiquetaAmazon.ts: a execução escreveu sobre um plano que não imprime');
}

/** What the line says about the bulk: the reader's `tipo` and code, or the failure's token and codes. */
function detalheDoBulk(
  bulk: ResultadoBulkImpressaoAgendamentoAmazon,
): Pick<CamposDaLinha, 'motivo' | 'codigoRejeicao' | 'codigos'> {
  if (bulk.tipo === 'resposta') {
    return { motivo: bulk.resposta.tipo, codigoRejeicao: bulk.resposta.codigo };
  }
  return { motivo: classificarFalhaDeLeituraAmazon(bulk.erro), codigos: codigosDe(bulk.erro) };
}

/** R11–R13: the download, the extraction and the answer. A document refusal ⇒ 502. */
async function baixarEEntregar(
  deps: DepsEtiquetaAmazon,
  c: CamposDaLinha,
  url: string,
  buscar: typeof globalThis.fetch,
  orderId: string,
): Promise<ResultadoEtiquetaAmazon> {
  let bytesZip: number | undefined;
  let zpl: Uint8Array;
  try {
    const zip = await baixarDocumentosEasyShip(url, { fetch: buscar });
    bytesZip = zip.byteLength;
    zpl = extrairEtiquetaZplEasyShip(zip);
  } catch (err) {
    if (!(err instanceof AmazonDocumentoEasyShipError)) throw err;
    return recusar(deps, CODIGO_ERRO_ETIQUETA_AMAZON.INDISPONIVEL, {
      ...c,
      motivo: err.motivo,
      bytesZip,
    });
  }
  registrar(deps, 'INFO', IMPRESSO, { ...c, bytesZip, bytesZpl: zpl.byteLength });
  return { tipo: 'zpl', bytes: zpl, nomeArquivo: `amazon-${orderId}.zpl` };
}

/** R10: each outcome token's answer; `desfechoImpressaoAgendamentoAmazon` holds the table. */
function depoisDoBulk(
  deps: DepsEtiquetaAmazon,
  c: CamposDaLinha,
  acao: AcaoAgendamentoAmazon,
  bulk: ResultadoBulkImpressaoAgendamentoAmazon,
  buscar: typeof globalThis.fetch,
  orderId: string,
): Promise<ResultadoEtiquetaAmazon> | ResultadoEtiquetaAmazon {
  const desfecho = desfechoImpressaoAgendamentoAmazon(acaoDaImpressao(acao), bulk);
  const comDetalhe: CamposDaLinha = { ...c, ...detalheDoBulk(bulk) };
  switch (desfecho.tipo) {
    case 'baixar':
      return baixarEEntregar(
        deps,
        { ...c, codigoRejeicao: comDetalhe.codigoRejeicao },
        desfecho.url,
        buscar,
        orderId,
      );
    case 'recusada':
      return recusar(
        deps,
        CODIGO_ERRO_ETIQUETA_AMAZON.RECUSADA,
        { ...comDetalhe, motivo: desfecho.motivo },
        { error: FRASES_RECUSADA[desfecho.motivo] },
      );
    case 'indisponivel':
      return recusar(deps, CODIGO_ERRO_ETIQUETA_AMAZON.INDISPONIVEL, comDetalhe);
    case 'amazon-indisponivel':
      return recusar(deps, CODIGO_ERRO_ETIQUETA_AMAZON.AMAZON_INDISPONIVEL, comDetalhe);
    case 'conta-indisponivel':
      return recusar(deps, CODIGO_ERRO_ETIQUETA_AMAZON.CONTA_INDISPONIVEL, comDetalhe);
    case 'chamadas-desligadas':
      return recusar(deps, CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS, comDetalhe);
    case 'relancar':
      if (bulk.tipo === 'erro') throw falhaQueSai(deps, c, bulk.erro);
      // The outcome's table answers `relancar` for a thrown failure only.
      throw new TypeError('etiquetaAmazon.ts: um desfecho a relançar sem falha');
  }
}

/* -------------------------------------------------------------------------- */
/*                                 the ladder                                 */
/* -------------------------------------------------------------------------- */

/**
 * Print ONE pedido's label: the ladder of the module header. Throws only what it
 * must not answer (module header, "What leaves as a 500").
 */
export async function imprimirEtiquetaAmazon(
  req: Request,
  deps: DepsEtiquetaAmazon,
): Promise<ResultadoEtiquetaAmazon> {
  // Resolved ONCE: the context and the download must see the same object.
  const buscar = deps.fetch ?? globalThis.fetch;

  // ---- R2: the body, strictly — before anything else is read. ----
  const corpo = await lerCorpo(req);
  if (!corpo.ok) {
    return recusar(deps, CODIGO_ERRO_ETIQUETA_AMAZON.CORPO_INVALIDO, {}, { issues: corpo.issues });
  }
  const { pedidoId } = corpo;

  // ---- R3: the read switch — nothing read before it answers. ----
  if (!lerChaveDeChamadasAmazon(deps.ambiente)) {
    registrarChamadaBloqueadaAmazon(deps.logger, {
      rota: ROTA_ETIQUETA_AMAZON,
      valor: deps.ambiente[CHAMADAS_ENV_AMAZON],
    });
    return responder(CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS);
  }

  // ---- R4: the valve, read ONCE, logged. ----
  const valvula = lerValvula(FLUXO_AMAZON.agendamento, deps.ambiente);
  registrarValvulaAmazon(deps.logger, valvula);

  // ---- R5: the pedido, then its NF-e documents. ----
  const db = deps.db();
  let raw: Readonly<Record<string, unknown>>;
  let notas: ReturnType<typeof gateNotasAgendamentoAmazon>;
  try {
    const pedidoSnap = await pedidoCollection.docRef(db, {}, pedidoId).get();
    if (!pedidoSnap.exists) {
      return recusar(deps, CODIGO_ERRO_ETIQUETA_AMAZON.PEDIDO_NAO_ENCONTRADO, { pedidoId });
    }
    raw = (pedidoSnap.data() ?? {}) as Record<string, unknown>;
    const lista = await nfev4Collection.ref(db, { pedidoId }).get();
    notas = gateNotasAgendamentoAmazon(
      lista.docs.map((d) => ({ raw: (d.data() ?? {}) as Record<string, unknown> })),
    );
  } catch (err) {
    throw falhaQueSai(deps, { pedidoId }, err);
  }

  // ---- R6: the stored gates. ----
  const gate = gatesArmazenadosAgendamentoAmazon(pedidoId, raw);
  if (!gate.segue) {
    return recusar(deps, CODIGO_ERRO_ETIQUETA_AMAZON.NAO_ELEGIVEL, {
      pedidoId,
      motivo: gate.motivo,
    });
  }
  const { contaId, orderId } = gate;
  const identidade: CamposDaLinha = { pedidoId, conta: contaId, pedido: orderId };

  // ---- R7: the target under the valve. ----
  if (decidirAlvo(valvula, contaId, orderId).modo === MODO_AMAZON.off) {
    return recusar(deps, CODIGO_ERRO_ETIQUETA_AMAZON.DESLIGADA, {
      ...identidade,
      motivo: MODO_AMAZON.off,
    });
  }

  // ---- R8: the context. ----
  const registro = { fluxo: FLUXO_AMAZON.agendamento, tentativa: null, idTarefa: null };
  const depsDoContexto: ContextoAmazonDeps = {
    ambiente: deps.ambiente,
    agora: deps.agora ?? Date.now,
    logger: deps.logger,
    registro,
    fetch: buscar,
    gerarCorrelationId: deps.gerarCorrelationId,
  };
  let contexto: ContextoAmazon;
  try {
    contexto = await loadAmazonContext(db, contaId, depsDoContexto);
  } catch (err) {
    const r = falhaDeLeitura(deps, identidade, err);
    if (r === null) throw falhaQueSai(deps, identidade, err);
    return r;
  }

  // ---- R9: the run — the live order, the plan, at most ONE mint + bulk (sent again
  // only by the engine's forced refresh, after a 401/403 Amazon did not process). ----
  let execucao: Awaited<ReturnType<typeof executarAgendamentoAmazon>>;
  try {
    execucao = await executarAgendamentoAmazon({
      valvula,
      alvo: { contaId, orderId, pisoUs: pisoDoPedidoAmazon(raw) },
      contexto,
      deps: depsDoContexto,
      registro,
      modo: MODO_AGENDAMENTO_AMAZON.impressao,
      podeAgendar: deps.podeAgendar,
      notas,
    });
  } catch (err) {
    throw falhaQueSai(deps, identidade, err);
  }

  switch (execucao.tipo) {
    case 'desligado':
      // R7 already answered `off` on the same snapshot; kept total.
      return recusar(deps, CODIGO_ERRO_ETIQUETA_AMAZON.DESLIGADA, {
        ...identidade,
        motivo: MODO_AMAZON.off,
      });
    case 'simulado':
      return recusar(deps, CODIGO_ERRO_ETIQUETA_AMAZON.DESLIGADA, {
        ...identidade,
        acao: execucao.plano.acao,
        motivo: execucao.motivo,
      });
    case 'sem-escrita':
      return semEscrita(deps, identidade, execucao.plano);
    case 'falha':
      if (execucao.fase === FASE_FALHA_AGENDAMENTO_AMAZON.leitura) {
        const r = falhaDeLeitura(deps, identidade, execucao.erro);
        if (r === null) throw falhaQueSai(deps, identidade, execucao.erro);
        return r;
      }
      // ---- R10: a thrown write failure. ----
      return depoisDoBulk(
        deps,
        { ...identidade, acao: execucao.plano.acao },
        execucao.plano.acao,
        { tipo: 'erro', erro: execucao.erro },
        buscar,
        orderId,
      );
    case 'escrito':
      // ---- R10: Amazon's 2xx answer, then R11–R13. ----
      return depoisDoBulk(
        deps,
        { ...identidade, acao: execucao.plano.acao },
        execucao.plano.acao,
        { tipo: 'resposta', resposta: lerRespostaAgendamentoAmazon(execucao.resposta, orderId) },
        buscar,
        orderId,
      );
  }
}
