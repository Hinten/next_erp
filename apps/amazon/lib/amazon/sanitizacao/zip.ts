/**
 * The C3 label zip's LAYOUT, from the owner's listing `<nome>.zip.txt` — never
 * from the zip. One line per entry, `<bytes> <entry-name>`: the size and name
 * columns of `unzip -l` (which reads the central directory without extracting
 * anything), converted by the one-liner in `scripts/README.md` — raw `unzip -l`
 * output, with its header, dates and totals, is refused line by line.
 *
 * The zip itself never sits in the capture folder (`lote.ts` refuses the whole
 * run on its first bytes), so nothing here can open label content: there is no
 * zip to open. Each entry keeps its SIZE and a shape-faked NAME:
 *
 * - an Amazon order id inside a name goes through the run's id faker, so it
 *   joins the bulk response's (faked) `amazonOrderId`;
 * - every other letter becomes `x`, every other digit `0`; `.`, `/`, `_`, `-`
 *   and space stay; anything else becomes `_`;
 * - the extension (the last `.ext`) is kept as written ONLY when it is one of
 *   {@link EXTENSOES_MANTIDAS} (any case), so `label.zpl` and `label.pdf` stay
 *   distinct; any other "extension" is shape-faked like the rest of the name —
 *   whatever follows the last dot may be a surname (`nf.Sicrano`) or part of an
 *   id.
 *
 * Pure.
 */
import type { FalsificadorAmazon } from '../core/redacao';
import { decodificarUtf8 } from './requisicao';

export interface EntradaDoZipAmazon {
  readonly nome: string;
  readonly bytes: number;
}

export type ProblemaDaListagem =
  | { readonly linha: null; readonly tipo: 'utf16' | 'utf8-invalido' | 'vazio' }
  | { readonly linha: number; readonly tipo: 'linha-invalida' };

export type LeituraDaListagem =
  | { readonly ok: true; readonly entradas: readonly EntradaDoZipAmazon[] }
  | { readonly ok: false; readonly problemas: readonly ProblemaDaListagem[] };

const PEDIDO = /\d{3}-\d{7}-\d{7}/g;

/** The extensions a label zip's entry keeps, compared in lower case: label and document formats only. */
export const EXTENSOES_MANTIDAS: ReadonlySet<string> = new Set([
  'zpl',
  'pdf',
  'png',
  'gif',
  'jpg',
  'jpeg',
  'txt',
  'xml',
  'json',
  'html',
]);

const EXTENSAO = /\.([A-Za-z0-9]{1,8})$/;

/** The name's last `.ext` when it is a kept one, else `''` (the whole name is shape-faked). */
function extensaoMantida(nome: string): string {
  const m = EXTENSAO.exec(nome);
  return m !== null && EXTENSOES_MANTIDAS.has((m[1] ?? '').toLowerCase()) ? m[0] : '';
}
const LINHA = /^(\d{1,12}) (\S.*)$/;
const LETRA = /^\p{L}$/u;
const DIGITO = /^\p{N}$/u;

/** One stretch of a name that holds no order id. */
function forma(trecho: string): string {
  let saida = '';
  for (const c of trecho) {
    if (LETRA.test(c)) saida += 'x';
    else if (DIGITO.test(c)) saida += '0';
    else if (c === '.' || c === '/' || c === '_' || c === '-' || c === ' ') saida += c;
    else saida += '_';
  }
  return saida;
}

/** An entry name, shape-faked; the order ids in it through `falsificador`. Total. */
export function nomeFalsoDeEntrada(nome: string, falsificador: FalsificadorAmazon): string {
  const ext = extensaoMantida(nome);
  const base = nome.slice(0, nome.length - ext.length);
  let saida = '';
  let desde = 0;
  for (const m of base.matchAll(PEDIDO)) {
    saida += forma(base.slice(desde, m.index));
    saida += falsificador('pedido', m[0]);
    desde = m.index + m[0].length;
  }
  return `${saida}${forma(base.slice(desde))}${ext}`;
}

/** Reads a listing; every bad line is reported by number, never by content. */
export function lerListagemDoZip(
  bytes: Uint8Array,
  falsificador: FalsificadorAmazon,
): LeituraDaListagem {
  const texto = decodificarUtf8(bytes);
  if (!texto.ok) return { ok: false, problemas: [{ linha: null, tipo: texto.motivo }] };
  const entradas: EntradaDoZipAmazon[] = [];
  const problemas: ProblemaDaListagem[] = [];
  texto.texto.split(/\r?\n/).forEach((linha, i) => {
    if (linha.trim() === '') return;
    const m = LINHA.exec(linha);
    const bytesDaEntrada = Number(m?.[1]);
    if (m === null || !Number.isSafeInteger(bytesDaEntrada)) {
      problemas.push({ linha: i + 1, tipo: 'linha-invalida' });
      return;
    }
    entradas.push({ nome: nomeFalsoDeEntrada(m[2] ?? '', falsificador), bytes: bytesDaEntrada });
  });
  if (problemas.length > 0) return { ok: false, problemas };
  if (entradas.length === 0) return { ok: false, problemas: [{ linha: null, tipo: 'vazio' }] };
  return { ok: true, entradas };
}
