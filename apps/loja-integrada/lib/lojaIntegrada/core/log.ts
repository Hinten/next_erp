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
 * (`client.ts`), so a logger must never throw — for a WRITE that would reject a
 * write that landed. Every campo is a primitive (`CampoLogLi` has no slot for an
 * object, a bigint or a cycle), and the body goes through `redacao.ts`, which is
 * total.
 *
 * ⚠️ **A structured value reaches a line through {@link serializarValorLi}
 * only** — the write engine's restore snapshot, its diff, its deriva. It is
 * total without a `catch`: JSON for a JSON value, and a marker (`<ciclo>`,
 * `<bigint>`, `<ausente>`, `<fundo>`, `<nao-serializavel>`) wherever
 * `JSON.stringify` would throw, call code (a getter, `toJSON`) or fold a
 * difference away (`undefined` read as nothing, `NaN` as `null`). The line
 * itself is {@link linhaSerializadaLi}: the exact text the default sink writes,
 * and the text a size cap is measured on.
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
  type ValorJsonLi,
  bytesUtf8,
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
 * switch refused (`core/valvulas.ts`), a run of the order poller
 * (`pedidos/pollPedidos.ts`), and the write engine's own lines (`core/escrita.ts`,
 * master-plan step 7): the restore snapshot before a write, a field a run that
 * may not write would have written, a write's outcome, a read-back that differs
 * from what was written, the situação-history check after a write, and an event
 * a write run found outdated. A later write step adds a kind here only when no
 * existing one says it — an outcome is a `resultado` of `escrita`, never a new
 * event.
 */
export type EventoLi =
  | 'chamada'
  | 'valvula'
  | 'chamada-bloqueada'
  | 'poll'
  | 'restauracao'
  | 'diff'
  | 'escrita'
  | 'deriva'
  | 'conferencia-historico'
  | 'superado';

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

/* -------------------------------------------------------------------------- */
/*                     The total serialiser and the exact line                 */
/* -------------------------------------------------------------------------- */

/** How deep {@link serializarValorLi} walks; anything deeper is {@link MARCA_SERIALIZACAO_LI}`.fundo`. */
export const PROFUNDIDADE_MAXIMA_SERIALIZACAO_LI = 32;

/** What stands in for a value JSON cannot hold, or that the serialiser will not read. */
export const MARCA_SERIALIZACAO_LI = {
  ciclo: '<ciclo>',
  bigint: '<bigint>',
  ausente: '<ausente>',
  fundo: '<fundo>',
  naoSerializavel: '<nao-serializavel>',
} as const;

type MarcaSerializacaoLi = (typeof MARCA_SERIALIZACAO_LI)[keyof typeof MARCA_SERIALIZACAO_LI];

/** A plain object or an array — the only containers walked; anything else is not a JSON value. */
function ehConteinerJson(v: object): boolean {
  if (Array.isArray(v)) return true;
  const prototipo: unknown = Object.getPrototypeOf(v);
  return prototipo === Object.prototype || prototipo === null;
}

/**
 * One own property's value, read through its DESCRIPTOR: a data property gives
 * its value; an accessor is never called (a getter may throw or have effects).
 */
function valorProprio(
  alvo: object,
  chave: string,
): { readonly tipo: 'valor'; readonly valor: unknown } | { readonly tipo: 'acessor' } {
  const d = Object.getOwnPropertyDescriptor(alvo, chave);
  return d !== undefined && 'value' in d ? { tipo: 'valor', valor: d.value } : { tipo: 'acessor' };
}

const marca = (m: MarcaSerializacaoLi): string => JSON.stringify(m);

/** The marker of a value that is not JSON by itself, or `null` for a JSON scalar or container. */
function marcaDoValor(v: unknown): MarcaSerializacaoLi | null {
  switch (typeof v) {
    case 'undefined':
      return MARCA_SERIALIZACAO_LI.ausente;
    case 'bigint':
      return MARCA_SERIALIZACAO_LI.bigint;
    case 'symbol':
    case 'function':
      return MARCA_SERIALIZACAO_LI.naoSerializavel;
    case 'number':
      // `JSON.stringify(NaN)` is `null`: a non-finite number would read as null.
      return Number.isFinite(v) ? null : MARCA_SERIALIZACAO_LI.naoSerializavel;
    case 'object':
      return v !== null && !ehConteinerJson(v) ? MARCA_SERIALIZACAO_LI.naoSerializavel : null;
    case 'string':
    case 'boolean':
      return null;
  }
}

function serializarNo(v: unknown, prof: number, ancestrais: Set<object>): string {
  const m = marcaDoValor(v);
  if (m !== null) return marca(m);
  if (typeof v === 'string' || typeof v === 'number') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v !== 'object' || v === null) return 'null';
  if (prof >= PROFUNDIDADE_MAXIMA_SERIALIZACAO_LI) return marca(MARCA_SERIALIZACAO_LI.fundo);
  if (ancestrais.has(v)) return marca(MARCA_SERIALIZACAO_LI.ciclo);
  ancestrais.add(v);
  let texto: string;
  if (Array.isArray(v)) {
    const itens: string[] = [];
    for (let i = 0; i < v.length; i++) {
      const p = valorProprio(v, String(i));
      itens.push(
        p.tipo === 'valor'
          ? serializarNo(p.valor, prof + 1, ancestrais)
          : marca(MARCA_SERIALIZACAO_LI.naoSerializavel),
      );
    }
    texto = `[${itens.join(',')}]`;
  } else {
    const pares: string[] = [];
    for (const chave of Object.keys(v)) {
      const p = valorProprio(v, chave);
      // A key whose value is absent is absent, as in JSON.
      if (p.tipo === 'valor' && p.valor === undefined) continue;
      const valor =
        p.tipo === 'valor'
          ? serializarNo(p.valor, prof + 1, ancestrais)
          : marca(MARCA_SERIALIZACAO_LI.naoSerializavel);
      pares.push(`${JSON.stringify(chave)}:${valor}`);
    }
    texto = `{${pares.join(',')}}`;
  }
  ancestrais.delete(v);
  return texto;
}

/**
 * Any value as text for a log line — TOTAL, with no `catch` (module header).
 *
 * - A JSON value: exactly what `JSON.stringify` writes.
 * - Inside a value: a cycle, a bigint, an absent array element, a non-finite
 *   number, a function, a symbol, an accessor property, a non-plain object, or
 *   anything deeper than {@link PROFUNDIDADE_MAXIMA_SERIALIZACAO_LI}, becomes its
 *   marker as a JSON string (`"<ciclo>"`); a key whose value is absent is left
 *   out, as JSON does.
 * - At the top: such a value is its marker, bare (`<ausente>` for `undefined`),
 *   so an absent value never reads as `null` on a line.
 */
export function serializarValorLi(v: unknown): string {
  return marcaDoValor(v) ?? serializarNo(v, 0, new Set());
}

/**
 * The EXACT text of one line, without its newline: `severity` and `message`
 * first (the keys Cloud Logging reads; a campo can overwrite neither), then the
 * campos in order. The default sink writes this; a size cap is measured on it.
 */
export function linhaSerializadaLi(
  severidade: SeveridadeLi,
  mensagem: string,
  campos: Readonly<Record<string, CampoLogLi>>,
): string {
  // `fromEntries` defines own properties, so even a `__proto__` campo is just a key.
  const registro: Readonly<Record<string, CampoLogLi>> = Object.fromEntries([
    ['severity', severidade],
    ['message', mensagem],
    ...Object.entries(campos).filter(([chave]) => chave !== 'severity' && chave !== 'message'),
  ]);
  return serializarValorLi(registro);
}

/** The default sink: one JSON line on stdout — {@link linhaSerializadaLi} and a newline. */
export const escritorPadrao: EscritorLogLi = (severidade, mensagem, campos) => {
  process.stdout.write(`${linhaSerializadaLi(severidade, mensagem, campos)}\n`);
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
  (o.escrever ?? escritorPadrao)(
    severidade,
    mensagemDoEventoLi(evento),
    camposDoEventoLi(evento, campos, o),
  );
}

/** The message of an event line. */
export function mensagemDoEventoLi(evento: EventoLi): string {
  return `[loja-integrada] ${evento}`;
}

/** An event line's campos: the envelope, then the event's own, which cannot overwrite it. */
export function camposDoEventoLi(
  evento: EventoLi,
  campos: Readonly<Record<string, CampoLogLi>>,
  o: OpcoesRegistroLi,
): Readonly<Record<string, CampoLogLi>> {
  const envelope: readonly (readonly [string, CampoLogLi])[] = [
    ['evento', evento],
    ['conta', o.conta],
    ['fluxo', o.fluxo ?? null],
    ['tentativa', o.tentativa ?? null],
    ['idTarefa', o.idTarefa ?? null],
    ['idNotificacao', o.idNotificacao ?? null],
  ];
  const doEnvelope = new Set(envelope.map(([chave]) => chave));
  return Object.fromEntries([
    ...envelope,
    ...Object.entries(campos).filter(([chave]) => !doEnvelope.has(chave)),
  ]);
}

/* -------------------------------------------------------------------------- */
/*            The write engine's lines (`core/escrita.ts`, step 7)            */
/* -------------------------------------------------------------------------- */

/**
 * The restore snapshot's cap: the UTF-8 bytes of the WHOLE line as the default
 * sink writes it ({@link linhaSerializadaLi}, newline excluded). A snapshot that
 * does not fit is never written in part — the write it would precede is not
 * made at all (`core/escrita.ts`).
 */
export const MAX_LINHA_RESTAURACAO_BYTES = 200 * 1024;

/** One restore snapshot: the read a write is decided on, as `redacao.ts` lets it out. */
export interface RestauracaoLi {
  /** The target resource (the order `numero`). */
  readonly recurso: number;
  /** The REQUEST path of the deciding read; it is redacted before it reaches the line. */
  readonly caminho: string;
  readonly status: number;
  /** `corpoDeRestauracaoLi`'s estrutural walk of the response. */
  readonly corpo: ValorJsonLi;
}

/** Whether the snapshot line was written, and its size either way. */
export interface ResultadoRestauracaoLi {
  readonly escrita: boolean;
  readonly bytes: number;
}

/**
 * The restore line (`evento: 'restauracao'`, INFO) — written only when the
 * whole line fits {@link MAX_LINHA_RESTAURACAO_BYTES}; otherwise NOTHING is
 * written and `escrita` is `false`. Measured on the exact line, through the
 * same campos the sink receives.
 */
export function registrarRestauracaoLi(
  r: RestauracaoLi,
  o: OpcoesRegistroLi,
): ResultadoRestauracaoLi {
  const caminho = textoDoCaminho(redigirCaminhoEQuery({ caminho: r.caminho, query: [] }));
  const campos = camposDoEventoLi(
    'restauracao',
    {
      recurso: r.recurso,
      caminho,
      status: r.status,
      politica: 'estrutural',
      corpo: serializarValorLi(r.corpo),
    },
    o,
  );
  const mensagem = mensagemDoEventoLi('restauracao');
  const bytes = bytesUtf8(linhaSerializadaLi('INFO', mensagem, campos));
  if (bytes > MAX_LINHA_RESTAURACAO_BYTES) return { escrita: false, bytes };
  (o.escrever ?? escritorPadrao)('INFO', mensagem, campos);
  return { escrita: true, bytes };
}

/**
 * How a written field may appear on a line: `valor` logs its value (through the
 * serialiser); `so-mudou` logs only whether it changed — for a field whose value
 * must never be logged (a credential).
 */
export type PoliticaCampoLi = 'valor' | 'so-mudou';

/** One field a run that may not write would have written (`evento: 'diff'`). */
export interface DiffLi {
  readonly recurso: number;
  /** The write kind (`core/escrita.ts`). */
  readonly tipo: string;
  readonly campo: string;
  readonly politica: PoliticaCampoLi;
  readonly antes: unknown;
  readonly depois: unknown;
  /** Computed by the caller with the shared comparator — this module imports none. */
  readonly mudou: boolean;
  /** Why it was not written: the target decision (`valvula`, `sem-canario`, …). */
  readonly motivo: string;
}

/** The value campos of a field, as its policy allows. */
function valoresDoCampo(
  politica: PoliticaCampoLi,
  a: unknown,
  b: unknown,
): readonly [string | null, string | null] {
  return politica === 'valor' ? [serializarValorLi(a), serializarValorLi(b)] : [null, null];
}

/** One INFO `diff` line per field. A `so-mudou` field logs no value. */
export function registrarDiffLi(d: DiffLi, o: OpcoesRegistroLi): void {
  const [antes, depois] = valoresDoCampo(d.politica, d.antes, d.depois);
  registrarEventoLi(
    'diff',
    'INFO',
    {
      recurso: d.recurso,
      tipo: d.tipo,
      campo: d.campo,
      politica: d.politica,
      antes,
      depois,
      mudou: d.mudou,
      motivo: d.motivo,
    },
    o,
  );
}

/**
 * The outcomes an `escrita` line names: a PUT that landed (`aplicada`) or was
 * accepted (`pendente`, a 202); and the write-back sequence's own (step 7):
 * LI's own move seen after a tracking-code write (`efeito-observado`) or not
 * yet (`efeito-pendente`); a code stored without that move (`objeto-sem-efeito`);
 * a stored code deliberately not sent (`objeto-nao-enviado`); a write refused
 * while the token still reads, to be retried (`recusada-retentativa`).
 */
export type ResultadoEscritaLogLi =
  | 'aplicada'
  | 'pendente'
  | 'efeito-observado'
  | 'efeito-pendente'
  | 'objeto-sem-efeito'
  | 'objeto-nao-enviado'
  | 'recusada-retentativa';

export const SEVERIDADE_DA_ESCRITA_LI = {
  aplicada: 'INFO',
  pendente: 'INFO',
  'efeito-observado': 'INFO',
  'efeito-pendente': 'INFO',
  'objeto-sem-efeito': 'WARNING',
  'objeto-nao-enviado': 'INFO',
  'recusada-retentativa': 'WARNING',
} as const satisfies Record<ResultadoEscritaLogLi, SeveridadeLi>;

/** One `escrita` line: ids, the outcome, the status — never an echo body. */
export interface EscritaLogLi {
  readonly recurso: number;
  readonly tipo: string;
  readonly campo: string;
  readonly resultado: ResultadoEscritaLogLi;
  readonly status: number | null;
  /** The package's reading of a 2xx (`sim` / `pendente`), when there was one. */
  readonly aplicada: string | null;
  /** How the echo read (`ok`, `vazio`, `nao-json`, `formato`, `falhou`), when there was one. */
  readonly leituraEco: string | null;
}

export function registrarEscritaLi(e: EscritaLogLi, o: OpcoesRegistroLi): void {
  registrarEventoLi(
    'escrita',
    SEVERIDADE_DA_ESCRITA_LI[e.resultado],
    {
      recurso: e.recurso,
      tipo: e.tipo,
      campo: e.campo,
      resultado: e.resultado,
      status: e.status,
      aplicada: e.aplicada,
      leituraEco: e.leituraEco,
    },
    o,
  );
}

/** A read-back that differs from what was written (`evento: 'deriva'`). */
export interface DerivaLi {
  readonly recurso: number;
  readonly tipo: string;
  readonly campo: string;
  readonly politica: PoliticaCampoLi;
  readonly escrito: unknown;
  readonly lido: unknown;
}

/** One WARNING `deriva` line. A `so-mudou` field logs no value. */
export function registrarDerivaLi(d: DerivaLi, o: OpcoesRegistroLi): void {
  const [escrito, lido] = valoresDoCampo(d.politica, d.escrito, d.lido);
  registrarEventoLi(
    'deriva',
    'WARNING',
    { recurso: d.recurso, tipo: d.tipo, campo: d.campo, politica: d.politica, escrito, lido },
    o,
  );
}
