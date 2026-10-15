/**
 * The capture folder as a listing: pairing, the name grammar, the HAR refusal,
 * and the owner's store-name list (`nomes-proibidos.txt`).
 *
 * Pure: it takes file NAMES (and the list's bytes), never a path, and reads
 * nothing. A name outside the grammar is counted, never printed — the owner may
 * have named a file after anything.
 */
import { NOME_DE_CAPTURA_LI } from '../fixtures/wireCorpus';
import { dobrarNomeDeLoja } from '../fixtures/piiScan';
import { decodificarUtf8 } from './requisicao';

/**
 * A usage error: the run cannot start. The script prints the message and exits
 * 2. ⚠️ Every message is fixed text plus a position or a line number — never an
 * argument, a file name or a term.
 */
export class ErroDeUsoSanitizacao extends Error {
  override readonly name = 'ErroDeUsoSanitizacao';
}

/** The owner's local list of store names and domains. It never enters the repository. */
export const ARQUIVO_NOMES_PROIBIDOS = 'nomes-proibidos.txt';

/** A term shorter than this (letters and digits, after the fold) is refused. */
export const MINIMO_POR_TERMO = 4;

const CANDIDATO = /\.(?:json|txt)$/i;
const VALIDO = /^(.+)\.(json|txt)$/;
const HAR = /\.har$/i;

export type ProblemaDoLote =
  | { readonly tipo: 'sem-sidecar' | 'sem-corpo'; readonly nome: string }
  | { readonly tipo: 'nao-e-arquivo'; readonly nome: string; readonly extensao: 'json' | 'txt' }
  | { readonly tipo: 'nome-fora-da-gramatica'; readonly quantidade: number };

export interface LoteDeCapturas {
  /** Complete pairs to convert (after `--so`), sorted. */
  readonly pares: readonly string[];
  /** Entries that are neither a capture nor the list. Counted, never named. */
  readonly ignorados: number;
  /** Unpaired captures, captures that are not regular files, names outside the grammar: the run refuses. */
  readonly problemas: readonly ProblemaDoLote[];
}

/**
 * Whether the listing holds a HAR: it carries the Authorization header and
 * cookies. Pass EVERY entry name, of any type: a HAR behind a link is still a HAR.
 */
export function temHar(nomes: readonly string[]): boolean {
  return nomes.some((nome) => HAR.test(nome));
}

/**
 * Pairs `<nome>.json` with `<nome>.txt`. With `so` (`--so`), only those pairs
 * are converted and the rest of the folder is not judged; a `so` name that is
 * not a complete pair is a usage error, and so is a run with zero pairs.
 *
 * `arquivos` are the regular files; `naoArquivos` every other entry (a link, a
 * folder). A capture is read only from a regular file, so a non-file entry named
 * like one refuses the run by name (`nao-e-arquivo`) instead of vanishing.
 */
export function montarLote(
  arquivos: readonly string[],
  so: readonly string[],
  naoArquivos: readonly string[] = [],
): LoteDeCapturas {
  const corpos = new Set<string>();
  const sidecars = new Set<string>();
  const naoSaoArquivos: { nome: string; extensao: 'json' | 'txt' }[] = [];
  let foraDaGramatica = 0;
  let ignorados = 0;
  const entradas = [
    ...arquivos.map((nome) => ({ nome, arquivo: true })),
    ...naoArquivos.map((nome) => ({ nome, arquivo: false })),
  ];
  for (const { nome, arquivo } of entradas) {
    if (nome === ARQUIVO_NOMES_PROIBIDOS) continue;
    if (!CANDIDATO.test(nome)) {
      ignorados += 1;
      continue;
    }
    const m = VALIDO.exec(nome);
    const raiz = m?.[1] ?? '';
    if (m === null || !NOME_DE_CAPTURA_LI.test(raiz)) {
      foraDaGramatica += 1;
      continue;
    }
    const extensao = m[2] === 'json' ? 'json' : 'txt';
    if (!arquivo) naoSaoArquivos.push({ nome: raiz, extensao });
    else if (extensao === 'json') corpos.add(raiz);
    else sidecars.add(raiz);
  }
  const completos = [...corpos].filter((n) => sidecars.has(n)).sort();

  if (so.length > 0) {
    so.forEach((nome, i) => {
      if (!completos.includes(nome)) {
        throw new ErroDeUsoSanitizacao(
          `--so number ${String(i + 1)} names no complete pair (<nome>.json + <nome>.txt) in the folder`,
        );
      }
    });
    return { pares: [...new Set(so)].sort(), ignorados, problemas: [] };
  }

  if (completos.length === 0) {
    throw new ErroDeUsoSanitizacao(
      'the folder holds no complete capture pair (<nome>.json + <nome>.txt)',
    );
  }
  // A half whose other half is a link is reported as `nao-e-arquivo`, not as unpaired.
  const comNaoArquivo = new Set(naoSaoArquivos.map((n) => n.nome));
  const problemas: ProblemaDoLote[] = [
    ...[...corpos]
      .filter((n) => !sidecars.has(n) && !comNaoArquivo.has(n))
      .sort()
      .map((nome) => ({ tipo: 'sem-sidecar' as const, nome })),
    ...[...sidecars]
      .filter((n) => !corpos.has(n) && !comNaoArquivo.has(n))
      .sort()
      .map((nome) => ({ tipo: 'sem-corpo' as const, nome })),
    ...naoSaoArquivos
      .map((n) => ({ chave: `${n.nome}.${n.extensao}`, n }))
      .sort((a, b) => (a.chave < b.chave ? -1 : a.chave > b.chave ? 1 : 0))
      .map(({ n }) => ({ tipo: 'nao-e-arquivo' as const, ...n })),
  ];
  if (foraDaGramatica > 0) {
    problemas.push({ tipo: 'nome-fora-da-gramatica', quantidade: foraDaGramatica });
  }
  return { pares: completos, ignorados, problemas };
}

/**
 * The terms of `nomes-proibidos.txt`: one per line, `#` comment lines and blank
 * lines skipped; UTF-8 with or without a BOM, LF or CRLF. Missing, UTF-16, empty,
 * or holding a term shorter than {@link MINIMO_POR_TERMO} → usage error (by line
 * number, never the term).
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
      `${ARQUIVO_NOMES_PROIBIDOS} is UTF-16 (a BOM or a NUL byte); re-save it as UTF-8`,
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
