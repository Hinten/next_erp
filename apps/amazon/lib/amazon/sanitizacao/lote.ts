/**
 * The capture folder as a listing: the run-wide refusals, pairing, the name
 * grammar, the owner's denylist (`nomes-proibidos.txt`) and the salt
 * (`.sal-sanitizador`).
 *
 * **Run-wide refusals** — any one means exit 1 and zero writes:
 * - a `*.har` entry of ANY type (file, link, folder): a HAR carries the
 *   `x-amz-access-token` header;
 * - any entry whose name starts with `.env`;
 * - any regular file whose FIRST BYTES are a zip (`PK\x03\x04`), a ZPL (`^XA`),
 *   a PDF (`%PDF-`) or a gzip (`\x1f\x8b`) — whatever its name. A label never
 *   sits in the folder; only its listing (`<nome>.zip.txt`) does, and the check
 *   reads at most {@link BYTES_DE_ASSINATURA} bytes, so the label is refused
 *   without ever being opened.
 *
 * Pure: it takes file NAMES and bytes, never a path, and reads nothing. A name
 * outside the grammar is counted, never printed — the owner may have named a
 * file after anything.
 */
import {
  type ListaDeNomesAmazon,
  type TipoAchadoAmazon,
  dobrarNomeDeLoja,
  tiposDoTextoAmazon,
  tiposMascaradosAmazon,
} from '../fixtures/piiScan';
import { TAMANHO_DO_SAL } from './falsificacao';
import { decodificarUtf8 } from './requisicao';

/**
 * A usage error: the run cannot start. The script prints the message and exits
 * 2. ⚠️ Every message is fixed text plus a position or a line number — never an
 * argument, a file name or a term.
 */
export class ErroDeUsoSanitizacao extends Error {
  override readonly name = 'ErroDeUsoSanitizacao';
}

/**
 * A run of 6 or more digits, or of 8 or more split by single `-`: an order id
 * (`123-4567890-1234567`), a phone (`11987654321`, `11-98765-4321`), a CEP
 * (`01234567`, `01234-567`), a document, a date. No pattern of the scanner sees
 * a BARE phone or CEP (they look exactly like Amazon ids), so a name is held to
 * this stricter rule. Short groups stay legal: `c2-12345`, `c1-9-10-pedido`.
 */
const CORRIDA_DE_DIGITOS = /\d{6}|\d(?:-?\d){7}/;

/**
 * A capture's name, and so a fixture's PUBLIC file name without `.json`:
 * lowercase letters, digits and `-`, at most 40, and no
 * {@link CORRIDA_DE_DIGITOS}. A name describes the request (`c1-pedido-cpf`),
 * never the order, the buyer or the store: a real order id here would be
 * committed as a file name, where no layer of the scanner looks.
 */
export const NOME_DE_CAPTURA_AMAZON = /^(?!.*(?:\d{6}|\d(?:-?\d){7}))[a-z0-9-]{1,40}$/;

/** What a name trips beyond the scanner's patterns: a {@link CORRIDA_DE_DIGITOS}. */
export type TipoDoNomeAmazon = TipoAchadoAmazon | 'digitos-no-nome';

/**
 * Every kind a NAME trips — a capture's name, a folder entry, a `--verificar`
 * path: the mask with its check-digit pass, every pattern of the scanner's layer
 * 2 (an Amazon order id, an ASIN, an account id, the listed terms…), and a
 * {@link CORRIDA_DE_DIGITOS}. Empty means the name may be printed, and a capture's name
 * be a fixture's file name. `lista` is `null` where there is none (CI).
 */
export function tiposDoNomeAmazon(
  nome: string,
  lista: ListaDeNomesAmazon | null,
): TipoDoNomeAmazon[] {
  const tipos = new Set<TipoDoNomeAmazon>([
    ...tiposMascaradosAmazon(nome, { digitos: true }),
    ...tiposDoTextoAmazon(nome, lista),
  ]);
  if (CORRIDA_DE_DIGITOS.test(nome)) tipos.add('digitos-no-nome');
  return [...tipos];
}

/** The owner's local denylist. It never enters the repository. */
export const ARQUIVO_NOMES_PROIBIDOS = 'nomes-proibidos.txt';

/** The faker's salt, created once beside the captures (32 random bytes, exclusive create). */
export const ARQUIVO_SAL = '.sal-sanitizador';

/** A term shorter than this (letters and digits, after the fold) is refused. */
export const MINIMO_POR_TERMO = 4;

/* -------------------------------------------------------------------------- */
/*                            Run-wide refusals                               */
/* -------------------------------------------------------------------------- */

export type TipoBinario = 'zip' | 'zpl' | 'pdf' | 'gzip';

/** The first bytes of a label or a compressed file. Escapes only (`no-control-bytes`). */
export const ASSINATURAS_BINARIAS: readonly {
  readonly tipo: TipoBinario;
  readonly bytes: readonly number[];
}[] = [
  { tipo: 'zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { tipo: 'zpl', bytes: [0x5e, 0x58, 0x41] },
  { tipo: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { tipo: 'gzip', bytes: [0x1f, 0x8b] },
];

/** How many first bytes the check reads: the longest signature. */
export const BYTES_DE_ASSINATURA = Math.max(...ASSINATURAS_BINARIAS.map((a) => a.bytes.length));

/** The signature `inicio` starts with, or `null`. */
export function assinaturaBinaria(inicio: Uint8Array): TipoBinario | null {
  for (const a of ASSINATURAS_BINARIAS) {
    if (a.bytes.every((b, i) => inicio[i] === b)) return a.tipo;
  }
  return null;
}

const HAR = /\.har$/i;
const ENV = /^\.env/i;

/** A HAR, of any type: pass EVERY entry name. */
export const ehHar = (nome: string): boolean => HAR.test(nome);
/** `.env`, `.env.local`, …: never in the folder. */
export const ehEnv = (nome: string): boolean => ENV.test(nome);

/* -------------------------------------------------------------------------- */
/*                                  Pairing                                   */
/* -------------------------------------------------------------------------- */

export type ExtensaoDeCaptura = 'json' | 'txt' | 'req.json' | 'zip.txt';

const CANDIDATO = /\.(?:json|txt)$/i;
const VALIDO = /^(.+?)\.(req\.json|zip\.txt|json|txt)$/;

export type ProblemaDoLote =
  | { readonly tipo: 'sem-sidecar' | 'sem-corpo'; readonly nome: string }
  | {
      readonly tipo: 'anexo-sem-par';
      readonly nome: string;
      readonly extensao: 'req.json' | 'zip.txt';
    }
  | { readonly tipo: 'nao-e-arquivo'; readonly nome: string; readonly extensao: ExtensaoDeCaptura }
  | { readonly tipo: 'nome-fora-da-gramatica'; readonly quantidade: number };

export interface ParDeCaptura {
  readonly nome: string;
  /** `<nome>.req.json` sits beside it. */
  readonly requisicao: boolean;
  /** `<nome>.zip.txt` sits beside it. */
  readonly zip: boolean;
}

export interface LoteDeCapturas {
  /** Complete pairs to convert (after `--so`), sorted. */
  readonly pares: readonly ParDeCaptura[];
  /** Entries that are neither a capture nor a file the sanitizer keeps. Counted, never named. */
  readonly ignorados: number;
  /** Half pairs, orphan attachments, non-files, names outside the grammar: the run refuses. */
  readonly problemas: readonly ProblemaDoLote[];
}

const ordenar = <T>(xs: readonly T[], chave: (x: T) => string): T[] =>
  [...xs].sort((a, b) => (chave(a) < chave(b) ? -1 : chave(a) > chave(b) ? 1 : 0));

/**
 * Pairs `<nome>.json` with `<nome>.txt`, with the optional `<nome>.req.json` and
 * `<nome>.zip.txt`. With `so` (`--so`), only those pairs are converted and the
 * rest of the folder is not judged; a `so` name that is not a complete pair is a
 * usage error, and so is a run with zero pairs.
 *
 * `arquivos` are the regular files; `naoArquivos` every other entry. A capture is
 * read only from a regular file, so a non-file entry named like one refuses the
 * run (`nao-e-arquivo`) instead of vanishing.
 */
export function montarLote(
  arquivos: readonly string[],
  so: readonly string[],
  naoArquivos: readonly string[] = [],
): LoteDeCapturas {
  const vistos = new Map<ExtensaoDeCaptura, Set<string>>([
    ['json', new Set()],
    ['txt', new Set()],
    ['req.json', new Set()],
    ['zip.txt', new Set()],
  ]);
  const naoSaoArquivos: { nome: string; extensao: ExtensaoDeCaptura }[] = [];
  let foraDaGramatica = 0;
  let ignorados = 0;
  const entradas = [
    ...arquivos.map((nome) => ({ nome, arquivo: true })),
    ...naoArquivos.map((nome) => ({ nome, arquivo: false })),
  ];
  for (const { nome, arquivo } of entradas) {
    if (nome === ARQUIVO_NOMES_PROIBIDOS || nome === ARQUIVO_SAL) continue;
    if (!CANDIDATO.test(nome)) {
      ignorados += 1;
      continue;
    }
    const m = VALIDO.exec(nome);
    const raiz = m?.[1] ?? '';
    if (m === null || !NOME_DE_CAPTURA_AMAZON.test(raiz)) {
      foraDaGramatica += 1;
      continue;
    }
    const extensao = m[2] as ExtensaoDeCaptura;
    if (!arquivo) naoSaoArquivos.push({ nome: raiz, extensao });
    else vistos.get(extensao)?.add(raiz);
  }
  const corpos = vistos.get('json') ?? new Set<string>();
  const sidecars = vistos.get('txt') ?? new Set<string>();
  const requisicoes = vistos.get('req.json') ?? new Set<string>();
  const zips = vistos.get('zip.txt') ?? new Set<string>();
  const completos = [...corpos].filter((n) => sidecars.has(n)).sort();
  const par = (nome: string): ParDeCaptura => ({
    nome,
    requisicao: requisicoes.has(nome),
    zip: zips.has(nome),
  });

  if (so.length > 0) {
    so.forEach((nome, i) => {
      if (!completos.includes(nome)) {
        throw new ErroDeUsoSanitizacao(
          `--so number ${String(i + 1)} names no complete pair (<nome>.json + <nome>.txt) in the folder`,
        );
      }
    });
    return { pares: [...new Set(so)].sort().map(par), ignorados, problemas: [] };
  }

  if (completos.length === 0) {
    throw new ErroDeUsoSanitizacao(
      'the folder holds no complete capture pair (<nome>.json + <nome>.txt)',
    );
  }
  // A half whose other half is a link is reported as `nao-e-arquivo`, not as unpaired.
  const comNaoArquivo = new Set(naoSaoArquivos.map((n) => n.nome));
  const completosSet = new Set(completos);
  const problemas: ProblemaDoLote[] = [
    ...[...corpos]
      .filter((n) => !sidecars.has(n) && !comNaoArquivo.has(n))
      .sort()
      .map((nome) => ({ tipo: 'sem-sidecar' as const, nome })),
    ...[...sidecars]
      .filter((n) => !corpos.has(n) && !comNaoArquivo.has(n))
      .sort()
      .map((nome) => ({ tipo: 'sem-corpo' as const, nome })),
    ...(['req.json', 'zip.txt'] as const).flatMap((extensao) =>
      [...(extensao === 'req.json' ? requisicoes : zips)]
        .filter((n) => !completosSet.has(n) && !comNaoArquivo.has(n))
        .sort()
        .map((nome) => ({ tipo: 'anexo-sem-par' as const, nome, extensao })),
    ),
    ...ordenar(naoSaoArquivos, (n) => `${n.nome}.${n.extensao}`).map((n) => ({
      tipo: 'nao-e-arquivo' as const,
      ...n,
    })),
  ];
  if (foraDaGramatica > 0) {
    problemas.push({ tipo: 'nome-fora-da-gramatica', quantidade: foraDaGramatica });
  }
  return { pares: completos.map(par), ignorados, problemas };
}

/* -------------------------------------------------------------------------- */
/*                       The files the sanitizer keeps                        */
/* -------------------------------------------------------------------------- */

/**
 * The terms of `nomes-proibidos.txt`: one per line, `#` comment lines and blank
 * lines skipped; UTF-8 with or without a BOM, LF or CRLF. Missing, UTF-16, not
 * UTF-8, empty, or holding a term shorter than {@link MINIMO_POR_TERMO} → usage
 * error (by line number, never the term).
 */
export function lerNomesProibidos(bytes: Uint8Array | null): string[] {
  if (bytes === null) {
    throw new ErroDeUsoSanitizacao(
      `the folder has no ${ARQUIVO_NOMES_PROIBIDOS} (a regular file); the sanitizer does not run without it`,
    );
  }
  const decodificado = decodificarUtf8(bytes);
  if (!decodificado.ok) {
    throw new ErroDeUsoSanitizacao(
      `${ARQUIVO_NOMES_PROIBIDOS} is not UTF-8 text (${decodificado.motivo}); re-save it as UTF-8`,
    );
  }
  const termos: string[] = [];
  decodificado.texto.split(/\r?\n/).forEach((linha, i) => {
    const termo = linha.trim();
    if (termo === '' || termo.startsWith('#')) return;
    if (dobrarNomeDeLoja(termo).replaceAll(' ', '').length < MINIMO_POR_TERMO) {
      throw new ErroDeUsoSanitizacao(
        `${ARQUIVO_NOMES_PROIBIDOS} line ${String(i + 1)}: a term needs at least ${String(MINIMO_POR_TERMO)} letters or digits`,
      );
    }
    termos.push(termo);
  });
  if (termos.length === 0) {
    throw new ErroDeUsoSanitizacao(`${ARQUIVO_NOMES_PROIBIDOS} holds no term`);
  }
  return termos;
}

/**
 * The salt as read: exactly {@link TAMANHO_DO_SAL} bytes, or a usage error. A
 * shorter (or longer) file is refused, never padded: a different salt would
 * silently re-key every fake and churn every fixture.
 */
export function validarSal(bytes: Uint8Array): Uint8Array {
  if (bytes.length !== TAMANHO_DO_SAL) {
    throw new ErroDeUsoSanitizacao(
      `${ARQUIVO_SAL} is not ${String(TAMANHO_DO_SAL)} bytes: restore it, or delete it (and every fixture it keyed will change)`,
    );
  }
  return bytes;
}
