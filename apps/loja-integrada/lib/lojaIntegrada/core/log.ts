/**
 * The structured logger of every Loja Integrada (LI) call: ONE JSON line per
 * call, with a Cloud Logging `severity`.
 *
 * ## The only module that sees the raw event
 *
 * The package hands each call to an observer as a `ChamadaLi`, which carries the
 * raw query and the full response text. This file is the ONLY place in the app
 * that names that type or builds an observer: every client in the app gets
 * `criarObservadorLi(…)` (the context loader builds it itself; the two credential
 * routes pass it to the validating GET), and `estrutura.test.ts` fails on any
 * other observer, or on the type named anywhere else. So the raw event cannot
 * reach a log line except through `linhaDaChamada`.
 *
 * ## The line is a projection, never a spread
 *
 * `linhaDaChamada` names every field it writes (`CHAVES_DA_LINHA`). Never in the
 * line: the raw query, the response text, any header, the credential ref (its
 * fingerprint stays out of logs). The credential is labelled by the version
 * suffix of its ref only (`versaoCredencial`, `refCredencial.ts`), and by its
 * type (`credencial: 'personal-token'`).
 *
 * The package scrubs only the token AS SENT from the body text, so the body
 * excerpt fails closed where an echo is plausible: a 401/403 is never excerpted
 * (`redacao.ts`), and neither is any answer to a call made with a candidate
 * credential (the validating GET, `versaoCredencial: null`).
 *
 * `conta`, `fluxo`, `tentativa`, `idTarefa` and `idNotificacao` are added here,
 * from the observer's options: the package's event has none of them.
 * `correlationId` is logged with `enviouCorrelationId`, because today no call
 * SENDS the header (`ENVIAR_CORRELATION_ID_LI` is `false`).
 *
 * ## Total by construction — there is no `catch` here
 *
 * The package rethrows an observer's error in place of the call's outcome
 * (`client.ts`), so a logger must never throw. Every campo is a primitive
 * (`CampoLogLi` has no slot for an object, a bigint or a cycle), and the body
 * goes through `redacao.ts`, which is total. A structured value reaches a line
 * only after `redacao.ts` turned it into a string.
 *
 * ## The sink writes the line itself
 *
 * `process.stdout.write(JSON.stringify(…) + '\n')`, not `console.*`: a
 * `console.x(msg, obj)` is split across Cloud Logging entries and loses its
 * severity (see `apps/mercado-livre/app/api/webhooks/mercado-livre/route.ts`).
 * That App Hosting and Cloud Run parse a stdout JSON line into `jsonPayload`
 * with its `severity` is unverified in this repo. No `firebase-functions/logger`:
 * it would add a dependency to this app.
 */
import type { ChamadaLi } from '@delfrance/integrations-loja-integrada';

import {
  CREDENCIAL_LI,
  type FormaCorpoLi,
  type PoliticaCorpoLi,
  cortarUtf8,
  recursoDoCaminho,
  redigirCaminhoEQuery,
  redigirCorpo,
  textoDoCaminho,
} from './redacao';
import { versaoDaRef } from './refCredencial';

export type SeveridadeLi = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

/** Primitives only: no object, no bigint, no cycle — what keeps a line total. */
export type CampoLogLi = string | number | boolean | null;

export type EscritorLogLi = (
  severidade: SeveridadeLi,
  mensagem: string,
  campos: Readonly<Record<string, CampoLogLi>>,
) => void;

/** The body excerpt's cap, in UTF-8 bytes, applied AFTER the regex layer. */
export const MAX_TRECHO_CORPO_BYTES = 2048;

export interface OpcoesObservadorLi {
  /** The `integracaoId` of the conta the call ran for. */
  readonly conta: string;
  /** The flow, what `jsonPayload.fluxo` filters on (`intake`, `estoque`, …). */
  readonly fluxo?: string | null;
  /** The Cloud Tasks attempt; `null` on a route. */
  readonly tentativa?: number | null;
  readonly idTarefa?: string | null;
  readonly idNotificacao?: string | null;
  /** The sink. Defaults to one JSON line on stdout. */
  readonly escrever?: EscritorLogLi;
}

/** A line that is not about one conta (the valve read at a run's start) may say `null`. */
export type OpcoesRegistroLi = Omit<OpcoesObservadorLi, 'conta'> & {
  readonly conta: string | null;
};

/**
 * What a line is about: a call, a valve read at a run's start, a call the read
 * switch refused (`core/valvulas.ts`). Each write step adds its own.
 */
export type EventoLi = 'chamada' | 'valvula' | 'chamada-bloqueada';

/** A type alias, not an interface: it must be assignable to the sink's record of campos. */
export type LinhaChamadaLi = {
  readonly evento: 'chamada';
  readonly conta: string;
  readonly fluxo: string | null;
  readonly operacao: string;
  readonly metodo: ChamadaLi['metodo'];
  /** The resource after `/v1/` (`pedido`, `produto_estoque`, …), or `null`. */
  readonly recurso: string | null;
  readonly politica: PoliticaCorpoLi;
  /** The redacted path, plus `?` and the redacted query. */
  readonly caminho: string;
  readonly status: number | null;
  readonly resultado: ChamadaLi['resultado'];
  readonly tentativa: number | null;
  readonly credencial: typeof CREDENCIAL_LI;
  /** The version suffix of the credential ref, never the ref; `null` for a candidate token. */
  readonly versaoCredencial: string | null;
  readonly codigoLimite: number | null;
  readonly retryAfterS: number | null;
  readonly latenciaMs: number;
  readonly correlationId: string;
  readonly enviouCorrelationId: boolean;
  readonly idTarefa: string | null;
  readonly idNotificacao: string | null;
  readonly trechoCorpo: string | null;
  readonly corpoBytes: number | null;
  readonly corpoForma: FormaCorpoLi | null;
  readonly corpoTruncado: boolean;
  readonly mascarados: number;
};

/** Every key of a `chamada` line, in order. */
export const CHAVES_DA_LINHA = [
  'evento',
  'conta',
  'fluxo',
  'operacao',
  'metodo',
  'recurso',
  'politica',
  'caminho',
  'status',
  'resultado',
  'tentativa',
  'credencial',
  'versaoCredencial',
  'codigoLimite',
  'retryAfterS',
  'latenciaMs',
  'correlationId',
  'enviouCorrelationId',
  'idTarefa',
  'idNotificacao',
  'trechoCorpo',
  'corpoBytes',
  'corpoForma',
  'corpoTruncado',
  'mascarados',
] as const satisfies readonly (keyof LinhaChamadaLi)[];

/**
 * | `resultado` | severity |
 * | --- | --- |
 * | `ok`, `cancelado` | INFO |
 * | `nao-encontrado`, `limite`, `rede`, `tempo-esgotado`, `http` 5xx | WARNING |
 * | `http` 3xx/4xx, `schema`, `auth`, `inesperado` | ERROR |
 *
 * A 3xx is an ERROR: the client never follows a redirect, so one means a wrong
 * path form.
 */
export function severidadeDaChamada(
  resultado: ChamadaLi['resultado'],
  status: number | null,
): SeveridadeLi {
  switch (resultado) {
    case 'ok':
    case 'cancelado':
      return 'INFO';
    case 'nao-encontrado':
    case 'limite':
    case 'rede':
    case 'tempo-esgotado':
      return 'WARNING';
    case 'http':
      return status !== null && status >= 500 ? 'WARNING' : 'ERROR';
    case 'schema':
    case 'auth':
    case 'inesperado':
      return 'ERROR';
  }
}

/** The one line of a call, and its severity. Pure. */
export function linhaDaChamada(
  e: ChamadaLi,
  o: OpcoesObservadorLi,
): { severidade: SeveridadeLi; linha: LinhaChamadaLi } {
  const versaoCredencial = versaoDaRef(e.refCredencial);
  const redigido = redigirCorpo({ caminho: e.caminho, status: e.status, corpo: e.corpo }, 'log');
  // A candidate credential (the validating GET: no stored version) gets NO
  // excerpt, whatever the status: how Loja Integrada answers a bad token beyond
  // 401/403 is unobserved, and the package scrubs only the token AS SENT, so a
  // partial or escaped echo would survive.
  const corpo = versaoCredencial === null ? { ...redigido, trecho: null, mascarados: 0 } : redigido;
  const corte =
    corpo.trecho === null
      ? { texto: null, truncado: false }
      : cortarUtf8(corpo.trecho, MAX_TRECHO_CORPO_BYTES);
  const caminho = redigirCaminhoEQuery({ caminho: e.caminho, query: e.query });
  const linha: LinhaChamadaLi = {
    evento: 'chamada',
    conta: o.conta,
    fluxo: o.fluxo ?? null,
    operacao: e.operacao,
    metodo: e.metodo,
    recurso: recursoDoCaminho(e.caminho),
    politica: corpo.politica,
    caminho: textoDoCaminho(caminho),
    status: e.status,
    resultado: e.resultado,
    tentativa: o.tentativa ?? null,
    credencial: CREDENCIAL_LI,
    versaoCredencial,
    codigoLimite: e.codigoLimite,
    retryAfterS: e.retryAfterS,
    latenciaMs: e.latenciaMs,
    correlationId: e.correlationId,
    enviouCorrelationId: e.enviouCorrelationId,
    idTarefa: o.idTarefa ?? null,
    idNotificacao: o.idNotificacao ?? null,
    trechoCorpo: corte.texto,
    corpoBytes: corpo.bytes,
    corpoForma: corpo.forma,
    corpoTruncado: corte.truncado,
    mascarados: corpo.mascarados + caminho.mascarados,
  };
  return { severidade: severidadeDaChamada(e.resultado, e.status), linha };
}

/**
 * The default sink: one JSON line on stdout. `severity` and `message` are the
 * keys Cloud Logging reads; a campo can never overwrite either.
 */
export const escritorPadrao: EscritorLogLi = (severidade, mensagem, campos) => {
  // `fromEntries` defines own properties, so even a `__proto__` campo is just a key.
  const registro = Object.fromEntries([
    ['severity', severidade],
    ['message', mensagem],
    ...Object.entries(campos).filter(([chave]) => chave !== 'severity' && chave !== 'message'),
  ]);
  process.stdout.write(`${JSON.stringify(registro)}\n`);
};

/**
 * The observer every LI client of this app gets: one line per call. Building
 * it is the only way the app reaches a `ChamadaLi`.
 */
export function criarObservadorLi(o: OpcoesObservadorLi): (e: ChamadaLi) => void {
  const escrever = o.escrever ?? escritorPadrao;
  return (e) => {
    const { severidade, linha } = linhaDaChamada(e, o);
    const status = linha.status === null ? 'sem status' : String(linha.status);
    escrever(
      severidade,
      `[loja-integrada] ${linha.operacao}: ${status} (${linha.resultado})`,
      linha,
    );
  };
}

/**
 * Any other event line (the valve read at a run's start, a call the read switch
 * refused): the
 * same envelope as a call line — `evento`, `conta`, `fluxo`, `tentativa`,
 * `idTarefa`, `idNotificacao` — then the event's own primitive campos. A campo
 * may not overwrite the envelope.
 */
export function registrarEventoLi(
  evento: EventoLi,
  severidade: SeveridadeLi,
  campos: Readonly<Record<string, CampoLogLi>>,
  o: OpcoesRegistroLi,
): void {
  const envelope: readonly (readonly [string, CampoLogLi])[] = [
    ['evento', evento],
    ['conta', o.conta],
    ['fluxo', o.fluxo ?? null],
    ['tentativa', o.tentativa ?? null],
    ['idTarefa', o.idTarefa ?? null],
    ['idNotificacao', o.idNotificacao ?? null],
  ];
  const doEnvelope = new Set(envelope.map(([chave]) => chave));
  const linha: Readonly<Record<string, CampoLogLi>> = Object.fromEntries([
    ...envelope,
    ...Object.entries(campos).filter(([chave]) => !doEnvelope.has(chave)),
  ]);
  (o.escrever ?? escritorPadrao)(severidade, `[loja-integrada] ${evento}`, linha);
}
