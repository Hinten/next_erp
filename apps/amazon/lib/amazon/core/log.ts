/**
 * The structured logger of every Amazon call: ONE JSON line per call, with a
 * Cloud Logging `severity` — and the app's one logger (`LoggerAmazon`), which
 * every other line of `apps/amazon` goes through too.
 *
 * ## The only module that sees the raw event
 *
 * The package hands each call to an observer as a `ChamadaAmazon`, which
 * carries the raw query, the credential ref and the full response text. This
 * file is the ONLY place in the app that names that type or builds an
 * observer: the package's hook is wired at exactly three sites (the LWA
 * refresh and the SP-API client in `contexto.ts`, the code exchange in
 * `conectar.ts`), each with `criarObservadorAmazon(…)` as its whole value, and
 * `estrutura.test.ts` fails on any other observer, or on the type named
 * anywhere else. So the raw event reaches a line only through
 * {@link linhaDaChamada}.
 *
 * ## The line is a projection, never a spread
 *
 * {@link linhaDaChamada} names every field it writes ({@link CHAVES_DA_LINHA}),
 * each a primitive. Never in the line: the raw query, a header, the credential
 * ref or its fingerprint, the seller id, an LWA body. The credential is labelled
 * by its kind (`credencial`) and the ref's VERSION (`versaoCredencial`,
 * `formatoDaRef.ts`). The envelope (`conta`, `fluxo`, `tentativa`, `idTarefa`,
 * `idNotificacao`) comes from the observer's options, each checked by grammar.
 *
 * ## The excerpt fails closed (checked in this order)
 *
 * 1. an LWA call — no excerpt (the package already sends `corpo: null`);
 * 2. a 401 or 403 — no excerpt on ANY path: the package scrubs only the token
 *    AS SENT, and an encoded, escaped or partial echo would survive it;
 * 3. no ref version (`versaoCredencial === null`) — no excerpt, whatever the
 *    status;
 * 4. a `segredo` path — no excerpt (`redacao.ts`);
 * 5–8. `redacao.ts`'s `log` profile: empty, over 1 MiB, not a JSON object or
 *    array (no excerpt), else the allow-list walk — every leaf masked, then
 *    serialized, then cut to {@link MAX_TRECHO_CORPO_BYTES}.
 *
 * ## Total by construction — there is no `catch` here
 *
 * The package rethrows an observer's error in place of the call's outcome. For
 * the OAuth code exchange that LOSES the seller's grant: the single-use state
 * is consumed before the exchange (`conectar.ts` step 8). So the observer must
 * never throw, and it is total by construction: every campo is a primitive,
 * the redactor is total, and the depth is pre-scanned before any `JSON.parse`.
 * The sink applies {@link camposSeguros} at RUNTIME too, because
 * `escreverAviso` (`packages/data`) calls the structural `warn` untyped.
 *
 * ## The sink writes the line itself
 *
 * `process.stdout.write(JSON.stringify(…) + '\n')`, never `console.*`: a
 * `console.x(msg, obj)` is split across Cloud Logging entries and loses its
 * severity. That App Hosting and Cloud Run parse a stdout JSON line into
 * `jsonPayload` with its `severity` is unverified in this repo (step-2b plan
 * §5 risk 1). No new dependency.
 */
import type {
  ChamadaAmazon,
  CodigoErroLwa,
  ResultadoChamadaAmazon,
} from '@delfrance/integrations-amazon-sp-api';

import { REF_CONSENTIMENTO, versaoDaRef } from './formatoDaRef';
import { idDeContaValido } from './idConta';
import {
  type FormaCorpoAmazon,
  type PoliticaCorpoAmazon,
  bytesUtf8,
  classificarCaminho,
  codigoDeErroSeguro,
  cortarUtf8,
  mascararTexto,
  redigirCaminhoEQuery,
  redigirCorpo,
} from './redacao';

export type SeveridadeAmazon = 'INFO' | 'WARNING' | 'ERROR';

/** Primitives only: no object, no bigint, no cycle — what keeps a line total. */
export type CampoLogAmazon = string | number | boolean | null;
export type CamposLogAmazon = Readonly<Record<string, CampoLogAmazon>>;

/**
 * The app's one logger. A route hands in {@link LOGGER_STDOUT_AMAZON}; a test
 * hands in a spy. Campos are primitives: a list is joined into one string at
 * the call site (`faltando`, `invalidas`, `campos`), and nothing passes an
 * `err.message` (an `AmazonError` message embeds the path, which can carry a
 * seller id).
 */
export interface LoggerAmazon {
  info(mensagem: string, campos?: CamposLogAmazon): void;
  warn(mensagem: string, campos?: CamposLogAmazon): void;
  error(mensagem: string, campos?: CamposLogAmazon): void;
}

/**
 * What a line is about: a call, a call the read switch refused, a write valve
 * read at the start of a run (`valvulas.ts`), a reads-queue task (step 3: its
 * one dispatch line, and the intake's own refusals), a reprocess sweep lane
 * (step 3), a push delivery at the receiver (step 3: one line per delivery),
 * the backstop poll (step 4: one line per conta run, and the tick's gate), the
 * conta trigger (step 20: one line per `int_frete` reconcile) or the order
 * import (step 5: its own WARNING lines — a stale read accepted, a lost
 * precondition, a recent-cancel wait, the decision's closed log codes — ids,
 * counts and closed codes only).
 */
export type EventoAmazon =
  | 'chamada'
  | 'chamada-bloqueada'
  | 'valvula'
  | 'tarefa'
  | 'varredura'
  | 'notificacao'
  | 'poll'
  | 'int-frete'
  | 'pedido';

/** What a NON-call line is about: `chamada` is written by the observer alone. */
export type EventoAvulsoAmazon = Exclude<EventoAmazon, 'chamada'>;

/** Every {@link EventoAvulsoAmazon}, at run time (a new member fails to compile until listed). */
const EVENTOS_AVULSOS: Readonly<Record<EventoAvulsoAmazon, true>> = {
  'chamada-bloqueada': true,
  valvula: true,
  tarefa: true,
  varredura: true,
  notificacao: true,
  poll: true,
  'int-frete': true,
  pedido: true,
};

/** The body excerpt's cap, in UTF-8 bytes, applied AFTER the regex layer. */
export const MAX_TRECHO_CORPO_BYTES = 2048;

/** The cap of every other campo string, and of the message, in UTF-8 bytes. */
export const MAX_CAMPO_TEXTO_BYTES = 256;

/** What an envelope value outside its grammar becomes. */
export const INVALIDO = '<invalido>';

/** What a non-primitive campo becomes at the sink. */
export const NAO_PRIMITIVO = '<nao-primitivo>';

export interface OpcoesObservadorAmazon {
  readonly logger: LoggerAmazon;
  /** The `integracaoId` of the conta the call ran for. */
  readonly conta: string;
  /** The flow (`intake`, `estoque`, `oauth-callback`, …): what `jsonPayload.fluxo` filters on. */
  readonly fluxo?: string | null;
  /** The Cloud Tasks attempt; `null` on a route. */
  readonly tentativa?: number | null;
  readonly idTarefa?: string | null;
  readonly idNotificacao?: string | null;
}

/**
 * What a caller of the context loader passes (step 3: the task's flow, attempt
 * and ids). `logger` and `conta` are NOT in it: the loader adds them last, so
 * a `registro` can never relabel a line.
 */
export type RegistroDeChamadaAmazon = Omit<OpcoesObservadorAmazon, 'logger' | 'conta'>;

/** The envelope of a non-call line (`registrarEventoAmazon`). Only the keys given are written. */
export type EnvelopeEventoAmazon = Partial<Omit<OpcoesObservadorAmazon, 'logger' | 'conta'>> & {
  readonly conta?: string | null;
};

/** How the call authenticated, never which credential. */
export type CredencialDaLinhaAmazon = 'lwa-acesso' | 'lwa-refresh' | 'lwa-codigo' | typeof INVALIDO;

/** A type alias, not an interface: it must be assignable to {@link CamposLogAmazon}. */
export type LinhaChamadaAmazon = {
  readonly evento: 'chamada';
  readonly conta: string;
  readonly fluxo: string | null;
  readonly tentativa: number | null;
  readonly idTarefa: string | null;
  readonly idNotificacao: string | null;
  readonly destino: string;
  readonly operacao: string;
  readonly metodo: string;
  readonly politica: PoliticaCorpoAmazon;
  /** The redacted path, plus `?` and the redacted query. */
  readonly caminho: string;
  readonly status: number | null;
  readonly resultado: string;
  readonly credencial: CredencialDaLinhaAmazon;
  /** The ref's version (ms), never the ref; `null` for the consent or anything malformed. */
  readonly versaoCredencial: number | null;
  readonly limiteTaxa: number | null;
  readonly latenciaMs: number | null;
  readonly correlationId: string;
  readonly requestIdAmazon: string | null;
  /** The distinct codes through the closed set, joined with `,`; `null` when none. */
  readonly codigosErro: string | null;
  readonly codigoLwa: string | null;
  readonly trechoCorpo: string | null;
  readonly corpoBytes: number | null;
  readonly corpoForma: FormaCorpoAmazon | null;
  readonly corpoTruncado: boolean;
  readonly mascarados: number;
};

/** Every key of a `chamada` line, in order (26). */
export const CHAVES_DA_LINHA = [
  'evento',
  'conta',
  'fluxo',
  'tentativa',
  'idTarefa',
  'idNotificacao',
  'destino',
  'operacao',
  'metodo',
  'politica',
  'caminho',
  'status',
  'resultado',
  'credencial',
  'versaoCredencial',
  'limiteTaxa',
  'latenciaMs',
  'correlationId',
  'requestIdAmazon',
  'codigosErro',
  'codigoLwa',
  'trechoCorpo',
  'corpoBytes',
  'corpoForma',
  'corpoTruncado',
  'mascarados',
] as const satisfies readonly (keyof LinhaChamadaAmazon)[];

/* -------------------------------------------------------------------------- */
/*                      Grammars of what a line may carry                      */
/* -------------------------------------------------------------------------- */

const FLUXO = /^[a-z][a-z0-9-]{0,39}$/;
const ID_DE_TAREFA = /^[A-Za-z0-9._:-]{1,128}$/;
const OPERACAO = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const RESULTADOS: ReadonlySet<string> = new Set<ResultadoChamadaAmazon>([
  'ok',
  'http',
  'auth',
  'nao-encontrado',
  'limite',
  'schema',
  'rede',
  'tempo-esgotado',
  'cancelado',
  'inesperado',
]);
const DESTINOS: ReadonlySet<string> = new Set(['sp-api', 'lwa']);
const METODOS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const CODIGOS_LWA: ReadonlySet<string> = new Set<CodigoErroLwa>([
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
  'access_denied',
  'server_error',
  'temporarily_unavailable',
  'outro',
]);

/** `valor` when it is a string in `conjunto`, else {@link INVALIDO}. */
const doConjunto = (conjunto: ReadonlySet<string>, valor: unknown): string =>
  typeof valor === 'string' && conjunto.has(valor) ? valor : INVALIDO;

/** `null` for absent; the value when it matches; {@link INVALIDO} otherwise. */
function textoOuInvalido(valor: unknown, re: RegExp): string | null {
  if (valor === null || valor === undefined) return null;
  return typeof valor === 'string' && re.test(valor) ? valor : INVALIDO;
}

const numeroFinito = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

function statusSeguro(v: unknown): number | null {
  return Number.isSafeInteger(v) && (v as number) >= 100 && (v as number) <= 599
    ? (v as number)
    : null;
}

function tentativaSegura(v: unknown): number | null {
  return Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 1000
    ? (v as number)
    : null;
}

/** The envelope keys of a line, each through its grammar. */
interface EnvelopeDaLinha {
  readonly conta: string;
  readonly fluxo: string | null;
  readonly tentativa: number | null;
  readonly idTarefa: string | null;
  readonly idNotificacao: string | null;
}

function envelopeSeguro(o: OpcoesObservadorAmazon): EnvelopeDaLinha {
  return {
    conta: idDeContaValido(o.conta) ? o.conta : INVALIDO,
    fluxo: textoOuInvalido(o.fluxo, FLUXO),
    tentativa: tentativaSegura(o.tentativa),
    idTarefa: textoOuInvalido(o.idTarefa, ID_DE_TAREFA),
    idNotificacao: textoOuInvalido(o.idNotificacao, ID_DE_TAREFA),
  };
}

/** The distinct codes through the closed set, joined; `null` when there are none. */
function codigosSeguros(codigos: unknown): string | null {
  if (!Array.isArray(codigos) || codigos.length === 0) return null;
  const vistos = new Set<string>();
  for (const c of codigos) vistos.add(codigoDeErroSeguro(c));
  return [...vistos].join(',');
}

/* -------------------------------------------------------------------------- */
/*                                 The call line                               */
/* -------------------------------------------------------------------------- */

/**
 * | `resultado` | severity |
 * | --- | --- |
 * | `ok`, `cancelado` | INFO |
 * | `nao-encontrado`, `limite`, `rede`, `tempo-esgotado`; `http` 5xx | WARNING |
 * | `http` 3xx/4xx, `schema`, `auth`, `inesperado`, anything unknown | ERROR |
 *
 * A 3xx is an ERROR: the client never follows a redirect, so one means a wrong
 * path. LI's table verbatim (§3 decision 22): the outcome union is the same.
 */
export function severidadeDaChamada(resultado: unknown, status: unknown): SeveridadeAmazon {
  switch (resultado) {
    case 'ok':
    case 'cancelado':
      return 'INFO';
    case 'nao-encontrado':
    case 'limite':
    case 'rede':
    case 'tempo-esgotado':
      return 'WARNING';
    case 'http': {
      const s = statusSeguro(status);
      return s !== null && s >= 500 ? 'WARNING' : 'ERROR';
    }
    default:
      return 'ERROR';
  }
}

function credencialDaLinha(destino: string, ref: unknown): CredencialDaLinhaAmazon {
  if (destino === 'sp-api') return 'lwa-acesso';
  if (destino !== 'lwa') return INVALIDO;
  if (ref === REF_CONSENTIMENTO) return 'lwa-codigo';
  return versaoDaRef(ref) === null ? INVALIDO : 'lwa-refresh';
}

/** The excerpt part of the line. */
interface Trecho {
  readonly politica: PoliticaCorpoAmazon;
  readonly trechoCorpo: string | null;
  readonly corpoBytes: number | null;
  readonly corpoForma: FormaCorpoAmazon | null;
  readonly corpoTruncado: boolean;
  readonly mascarados: number;
}

function trechoDaChamada(
  e: ChamadaAmazon,
  caminhoBruto: string,
  destino: string,
  status: number | null,
  versaoCredencial: number | null,
): Trecho {
  const corpo = typeof e.corpo === 'string' ? e.corpo : null;
  const politica = classificarCaminho(caminhoBruto).politica;
  const semTrecho: Trecho = {
    politica,
    trechoCorpo: null,
    corpoBytes: corpo === null ? null : bytesUtf8(corpo),
    corpoForma: null,
    corpoTruncado: false,
    mascarados: 0,
  };
  // 1. LWA: the 200 IS the token pair; an error carries an `error_description`.
  if (destino !== 'sp-api') return { ...semTrecho, corpoBytes: null };
  // 2. A credential refusal may echo the token in a form the package's
  //    exact-string scrub misses (encoded, escaped, partial): never excerpted.
  if (status === 401 || status === 403) return semTrecho;
  // 3. No stored version: a candidate credential, or a malformed ref.
  if (versaoCredencial === null) return semTrecho;
  // 4–8. The redactor: `segredo`, empty, too big, too deep, not JSON, else the walk.
  const r = redigirCorpo({ caminho: caminhoBruto, status, corpo }, 'log', {
    maxBytes: MAX_TRECHO_CORPO_BYTES,
  });
  return {
    politica: r.politica,
    trechoCorpo: r.trecho,
    corpoBytes: r.bytes,
    corpoForma: r.forma,
    corpoTruncado: r.truncado,
    mascarados: r.mascarados,
  };
}

/** The one line of a call, and its severity. Pure and total. */
export function linhaDaChamada(
  e: ChamadaAmazon,
  o: OpcoesObservadorAmazon,
): { readonly severidade: SeveridadeAmazon; readonly linha: LinhaChamadaAmazon } {
  const envelope = envelopeSeguro(o);
  const destino = doConjunto(DESTINOS, e.destino);
  const status = statusSeguro(e.status);
  const versaoCredencial = versaoDaRef(e.refCredencial);
  // Read ONCE, by type: `String(x)` throws for a null-prototype object or a
  // throwing `toString`. Anything but a string is an unknown path (`<seg>`).
  const caminhoBruto = typeof e.caminho === 'string' ? e.caminho : '';
  const query = Array.isArray(e.query)
    ? e.query.filter(
        (p): p is readonly [string, string] =>
          Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string',
      )
    : [];
  const caminho = redigirCaminhoEQuery(caminhoBruto, query, 'log');
  const trecho = trechoDaChamada(e, caminhoBruto, destino, status, versaoCredencial);
  const linha: LinhaChamadaAmazon = {
    evento: 'chamada',
    conta: envelope.conta,
    fluxo: envelope.fluxo,
    tentativa: envelope.tentativa,
    idTarefa: envelope.idTarefa,
    idNotificacao: envelope.idNotificacao,
    destino,
    operacao: textoOuInvalido(e.operacao, OPERACAO) ?? INVALIDO,
    metodo: doConjunto(METODOS, e.metodo),
    politica: trecho.politica,
    caminho: caminho.texto,
    status,
    resultado: doConjunto(RESULTADOS, e.resultado),
    credencial: credencialDaLinha(destino, e.refCredencial),
    versaoCredencial,
    limiteTaxa: numeroFinito(e.limiteTaxa),
    latenciaMs: numeroFinito(e.latenciaMs),
    correlationId: textoOuInvalido(e.correlationId, CORRELATION_ID) ?? INVALIDO,
    requestIdAmazon: textoOuInvalido(e.requestIdAmazon, CORRELATION_ID),
    codigosErro: codigosSeguros(e.codigosErro),
    codigoLwa:
      e.codigoLwa === null || e.codigoLwa === undefined
        ? null
        : doConjunto(CODIGOS_LWA, e.codigoLwa),
    trechoCorpo: trecho.trechoCorpo,
    corpoBytes: trecho.corpoBytes,
    corpoForma: trecho.corpoForma,
    corpoTruncado: trecho.corpoTruncado,
    mascarados: trecho.mascarados + caminho.mascarados,
  };
  return { severidade: severidadeDaChamada(e.resultado, e.status), linha };
}

/** The logger method a severity writes through. */
function escrever(logger: LoggerAmazon, severidade: SeveridadeAmazon) {
  if (severidade === 'ERROR') return logger.error.bind(logger);
  if (severidade === 'WARNING') return logger.warn.bind(logger);
  return logger.info.bind(logger);
}

/**
 * The observer handed to the package's hook at the three call sites: one line
 * per call, through `o.logger`, with the method named by the severity and the
 * message `[amazon] <operacao>: <status|sem-resposta> (<resultado>)`. No `catch`:
 * total by construction (module header).
 */
export function criarObservadorAmazon(o: OpcoesObservadorAmazon): (e: ChamadaAmazon) => void {
  return (e) => {
    const { severidade, linha } = linhaDaChamada(e, o);
    const status = linha.status === null ? 'sem-resposta' : String(linha.status);
    escrever(o.logger, severidade)(
      `[amazon] ${linha.operacao}: ${status} (${linha.resultado})`,
      linha,
    );
  };
}

/* -------------------------------------------------------------------------- */
/*                               Non-call lines                                */
/* -------------------------------------------------------------------------- */

const CHAVES_DO_ENVELOPE: ReadonlySet<string> = new Set([
  'evento',
  'conta',
  'fluxo',
  'tentativa',
  'idTarefa',
  'idNotificacao',
]);

/** The excerpt campo: the sink exempts it on a CALL line only (see {@link camposSeguros}). */
const CAMPO_DO_TRECHO = 'trechoCorpo';

/**
 * Any other event line (a call the read switch refused; a write valve read). Its
 * envelope — `evento`, then each of `conta`, `fluxo`, `tentativa`, `idTarefa`,
 * `idNotificacao` the caller GAVE, through the same grammars as a call line —
 * is written LAST, and a campo holding an envelope name is dropped, so no campo
 * can relabel the line. It is never a call line: an `evento` outside
 * {@link EventoAvulsoAmazon} (a cast `chamada`) is {@link INVALIDO}, and a
 * `trechoCorpo` campo is dropped.
 */
export function registrarEventoAmazon(
  logger: LoggerAmazon,
  evento: EventoAvulsoAmazon,
  severidade: SeveridadeAmazon,
  mensagem: string,
  campos: CamposLogAmazon,
  envelope: EnvelopeEventoAmazon = {},
): void {
  const doEnvelope: (readonly [string, CampoLogAmazon])[] = [
    [
      'evento',
      typeof evento === 'string' && Object.hasOwn(EVENTOS_AVULSOS, evento) ? evento : INVALIDO,
    ],
  ];
  if (envelope.conta !== undefined) {
    const conta = envelope.conta;
    doEnvelope.push(['conta', conta === null ? null : idDeContaValido(conta) ? conta : INVALIDO]);
  }
  if (envelope.fluxo !== undefined)
    doEnvelope.push(['fluxo', textoOuInvalido(envelope.fluxo, FLUXO)]);
  if (envelope.tentativa !== undefined) {
    doEnvelope.push(['tentativa', tentativaSegura(envelope.tentativa)]);
  }
  if (envelope.idTarefa !== undefined) {
    doEnvelope.push(['idTarefa', textoOuInvalido(envelope.idTarefa, ID_DE_TAREFA)]);
  }
  if (envelope.idNotificacao !== undefined) {
    doEnvelope.push(['idNotificacao', textoOuInvalido(envelope.idNotificacao, ID_DE_TAREFA)]);
  }
  const linha: CamposLogAmazon = Object.fromEntries([
    ...Object.entries(campos).filter(
      ([chave]) => !CHAVES_DO_ENVELOPE.has(chave) && chave !== CAMPO_DO_TRECHO,
    ),
    ...doEnvelope,
  ]);
  escrever(logger, severidade)(mensagem, linha);
}

/* -------------------------------------------------------------------------- */
/*                                  The sink                                   */
/* -------------------------------------------------------------------------- */

/**
 * A string as the sink writes it: masked FIRST, cut second. Only a call line's
 * excerpt (`trecho`) keeps its own cap and skips the check-digit pass, which
 * already ran per leaf (an exempt id must survive it).
 */
function textoSeguro(valor: string, trecho: boolean): string {
  const mascarado = mascararTexto(valor, { digitos: !trecho }).texto;
  return cortarUtf8(mascarado, trecho ? MAX_TRECHO_CORPO_BYTES : MAX_CAMPO_TEXTO_BYTES).texto;
}

function campoSeguro(valor: unknown, trecho: boolean): CampoLogAmazon {
  if (valor === null || typeof valor === 'boolean') return valor;
  if (typeof valor === 'string') return textoSeguro(valor, trecho);
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  return NAO_PRIMITIVO;
}

/**
 * Campos as the sink writes them, at RUNTIME, whatever the static type said:
 *
 * - only own enumerable string keys, read through their DESCRIPTORS (a getter
 *   is never invoked: it becomes {@link NAO_PRIMITIVO});
 * - a string is masked (the regex layer, with the check-digit pass) and cut to
 *   {@link MAX_CAMPO_TEXTO_BYTES}. The ONE exception is the excerpt of a CALL
 *   line (`evento: 'chamada'`, which only the observer writes): it keeps its
 *   own cap and skips the check-digit pass. A `trechoCorpo` on any other line is
 *   an ordinary string;
 * - a non-finite number becomes `null`; `undefined` is dropped;
 * - an object, bigint, function or symbol becomes {@link NAO_PRIMITIVO};
 * - an own `__proto__` key is just a key (`Object.fromEntries` defines it).
 *
 * `severity` and `message` campos are not dropped here: the sink writes them
 * AFTER the campos, so they are overwritten.
 */
export function camposSeguros(campos: unknown): Record<string, CampoLogAmazon> {
  if (typeof campos !== 'object' || campos === null) return {};
  const descritores = Object.entries(Object.getOwnPropertyDescriptors(campos));
  const linhaDeChamada = descritores.some(
    ([chave, d]) =>
      chave === 'evento' && d.enumerable === true && 'value' in d && d.value === 'chamada',
  );
  const saida: (readonly [string, CampoLogAmazon])[] = [];
  for (const [chave, d] of descritores) {
    if (d.enumerable !== true) continue;
    if (!('value' in d)) {
      saida.push([chave, NAO_PRIMITIVO]);
      continue;
    }
    if (d.value === undefined) continue;
    saida.push([chave, campoSeguro(d.value, linhaDeChamada && chave === CAMPO_DO_TRECHO)]);
  }
  return Object.fromEntries(saida);
}

/**
 * One JSON line on stdout — the shape Cloud Logging reads `severity` and
 * `message` from. The campos come FIRST, so a campo can never overwrite either.
 */
function linhaNoStdout(severity: SeveridadeAmazon) {
  return (mensagem: string, campos?: CamposLogAmazon): void => {
    const message = textoSeguro(typeof mensagem === 'string' ? mensagem : NAO_PRIMITIVO, false);
    process.stdout.write(`${JSON.stringify({ ...camposSeguros(campos), severity, message })}\n`);
  };
}

/**
 * The app's `warn`, for a SHARED module that logs untyped campos
 * (`escreverAviso` in `packages/data` passes a Firestore error's message):
 * every campo is narrowed by {@link camposSeguros} before it reaches the logger.
 */
export function warnNaoTipado(logger: Pick<LoggerAmazon, 'warn'>): {
  readonly warn: (mensagem: string, campos?: Record<string, unknown>) => void;
} {
  return {
    warn: (mensagem, campos) => {
      // By type, never `String(x)`, which throws for a null-prototype object.
      logger.warn(typeof mensagem === 'string' ? mensagem : NAO_PRIMITIVO, camposSeguros(campos));
    },
  };
}

/** The production sink: what the routes (and step 3's functions) hand in. */
export const LOGGER_STDOUT_AMAZON: LoggerAmazon = {
  info: linhaNoStdout('INFO'),
  warn: linhaNoStdout('WARNING'),
  error: linhaNoStdout('ERROR'),
};
