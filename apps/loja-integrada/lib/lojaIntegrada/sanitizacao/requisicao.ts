/**
 * The request sidecar of a capture (`<nome>.txt`): its grammar, read offline.
 *
 * ```
 * GET https://api.awsli.com.br/v1/pedido/search/?limit=50 200     ← line 1, required
 * credencial: personal-token                                       ← required, no default
 * data: 2026-10-07                                                 ← optional
 * ```
 *
 * curl writes exactly that with `-w`; a capture taken from devtools or a log gets
 * the file written by hand, naming the credential that was really used.
 *
 * ⚠️ **Nothing of a refused line ever reaches output.** A sidecar typed by hand may
 * hold anything — an `Authorization:` line, a token pasted into the URL — so a
 * refusal names a LINE NUMBER and a kind, and at most a query KEY when the key is
 * a plain identifier. `URL.canParse` gates every `new URL`, because an uncaught
 * `ERR_INVALID_URL` prints its input.
 *
 * Pure: bytes in, a request or a list of refusals out.
 */
import { ORIGEM_LI } from '../core/redacao';
import {
  CREDENCIAIS_CAPTURA_LI,
  type CredencialCapturaLi,
  METODOS_CAPTURA_LI,
  type MetodoCapturaLi,
} from '../fixtures/wireCorpus';

/** A capture's request, as written (nothing redacted yet). */
export interface RequisicaoCapturada {
  readonly metodo: MetodoCapturaLi;
  /** The raw path, exactly as written; a trailing slash is kept. */
  readonly caminho: string;
  /** The raw query after `?` (`''` when there is none), never decoded. */
  readonly query: string;
  readonly status: number;
  readonly credencial: CredencialCapturaLi;
  /** The `data:` line (`AAAA-MM-DD`), or `null` when absent. */
  readonly data: string | null;
}

export type TipoProblemaDoSidecar =
  | 'utf16'
  | 'vazio'
  | 'linha-de-requisicao'
  | 'metodo'
  | 'status'
  | 'url-com-fragmento'
  | 'origem'
  | 'url-invalida'
  | 'webhook'
  | 'caminho-fora-de-v1'
  | 'caminho-inseguro'
  | 'caminho-nao-canonico'
  | 'credencial-na-url'
  | 'credencial-desconhecida'
  | 'credencial-repetida'
  | 'sem-credencial'
  | 'data-invalida'
  | 'data-repetida'
  | 'linha-nao-reconhecida';

export interface ProblemaDoSidecar {
  /** 1-based; `null` when the problem is the file as a whole. */
  readonly linha: number | null;
  readonly tipo: TipoProblemaDoSidecar;
  /** Only for `credencial-na-url`: the query key, or `<chave>` when it is not an identifier. */
  readonly chave?: string;
}

export type LeituraDoSidecar =
  | { readonly ok: true; readonly requisicao: RequisicaoCapturada }
  | { readonly ok: false; readonly problemas: readonly ProblemaDoSidecar[] };

/* -------------------------------------------------------------------------- */
/*                                  Encoding                                  */
/* -------------------------------------------------------------------------- */

/**
 * A capture file as text: UTF-8, its BOM stripped. A UTF-16 BOM (either order)
 * is refused: the file must be re-saved as UTF-8.
 */
export function decodificarUtf8(
  bytes: Uint8Array,
): { readonly ok: true; readonly texto: string } | { readonly ok: false } {
  const [a, b, c] = bytes;
  if ((a === 0xfe && b === 0xff) || (a === 0xff && b === 0xfe)) return { ok: false };
  const inicio = a === 0xef && b === 0xbb && c === 0xbf ? 3 : 0;
  return {
    ok: true,
    texto: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(inicio)),
  };
}

/* -------------------------------------------------------------------------- */
/*                                    URL                                     */
/* -------------------------------------------------------------------------- */

/** A query key that names a credential refuses the pair: delete both files. */
const CHAVE_DE_CREDENCIAL = /chave|token|aplicacao|api_?key|senha|secret|auth|password/i;
const CHAVE_IDENTIFICADOR = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Decoded the way `URLSearchParams` decodes (`+` is a space); never throws. */
const decodificar = (bruto: string) => new URLSearchParams(`v=${bruto}`).get('v') ?? '';

type LeituraDaUrl =
  | { readonly ok: true; readonly caminho: string; readonly query: string }
  | { readonly ok: false; readonly problemas: readonly ProblemaDoSidecar[] };

function lerUrl(url: string): LeituraDaUrl {
  const falha = (tipo: TipoProblemaDoSidecar): LeituraDaUrl => ({
    ok: false,
    problemas: [{ linha: 1, tipo }],
  });
  if (url.includes('#')) return falha('url-com-fragmento');
  // The gate comes FIRST: `new URL` on an unparseable input throws an error that
  // prints the input.
  if (!URL.canParse(url, ORIGEM_LI)) return falha('url-invalida');
  const analisada = new URL(url, ORIGEM_LI);

  // Exactly the LI origin, spelled exactly (no userinfo, no port, no other
  // case), or a path that starts at `/v1/…`.
  let resto: string;
  if (url.startsWith(`${ORIGEM_LI}/`)) resto = url.slice(ORIGEM_LI.length);
  else if (url.startsWith('/') && !url.startsWith('//')) resto = url;
  else return falha('origem');
  if (analisada.origin !== ORIGEM_LI) return falha('origem');

  const interrogacao = resto.indexOf('?');
  const caminho = interrogacao === -1 ? resto : resto.slice(0, interrogacao);
  const query = interrogacao === -1 ? '' : resto.slice(interrogacao + 1);

  if (caminho === '/webhooks' || caminho.startsWith('/webhooks/')) return falha('webhook');
  if (!caminho.startsWith('/v1/')) return falha('caminho-fora-de-v1');
  if (caminho.includes('..') || caminho.includes('\\') || /%(?:2f|5c|2e)/i.test(caminho)) {
    return falha('caminho-inseguro');
  }
  // The URL parser would have rewritten it (dot segments, percent-encoding):
  // what was captured is not what the path says.
  if (analisada.pathname !== caminho) return falha('caminho-nao-canonico');

  const problemas: ProblemaDoSidecar[] = [];
  for (const par of query === '' ? [] : query.split('&')) {
    const igual = par.indexOf('=');
    const chave = igual === -1 ? par : par.slice(0, igual);
    if (CHAVE_DE_CREDENCIAL.test(chave) || CHAVE_DE_CREDENCIAL.test(decodificar(chave))) {
      problemas.push({
        linha: 1,
        tipo: 'credencial-na-url',
        chave: CHAVE_IDENTIFICADOR.test(chave) ? chave : '<chave>',
      });
    }
  }
  return problemas.length > 0 ? { ok: false, problemas } : { ok: true, caminho, query };
}

/* -------------------------------------------------------------------------- */
/*                                  Sidecar                                   */
/* -------------------------------------------------------------------------- */

const ehMetodo = (m: string): m is MetodoCapturaLi =>
  METODOS_CAPTURA_LI.some((conhecido) => conhecido === m);
const ehCredencial = (c: string): c is CredencialCapturaLi =>
  CREDENCIAIS_CAPTURA_LI.some((conhecida) => conhecida === c);

const STATUS = /^\d{3}$/;
const LINHA_CREDENCIAL = /^credencial:[ \t]*(\S+)$/;
const LINHA_DATA = /^data:[ \t]*(\S+)$/;
const DATA = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date, `AAAA-MM-DD`; checked in UTC, never a local-time getter. */
function ehDataValida(s: string): boolean {
  const m = DATA.exec(s);
  if (m === null) return false;
  const [, ano, mes, dia] = m;
  const ms = Date.UTC(Number(ano), Number(mes) - 1, Number(dia));
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s;
}

/**
 * Reads a sidecar. Every problem is collected (by line number), so one run shows
 * them all; the request exists only when there is none.
 */
export function lerSidecar(bytes: Uint8Array): LeituraDoSidecar {
  const decodificado = decodificarUtf8(bytes);
  if (!decodificado.ok) return { ok: false, problemas: [{ linha: null, tipo: 'utf16' }] };

  const linhas = decodificado.texto.split(/\r?\n/).map((l) => l.replace(/[ \t]+$/, ''));
  while (linhas.length > 0 && linhas[linhas.length - 1] === '') linhas.pop();
  if (linhas.length === 0) return { ok: false, problemas: [{ linha: null, tipo: 'vazio' }] };

  const problemas: ProblemaDoSidecar[] = [];

  let metodo: MetodoCapturaLi | null = null;
  let status: number | null = null;
  let url: LeituraDaUrl | null = null;
  const tokens = (linhas[0] ?? '').trim().split(/[ \t]+/);
  if (tokens.length !== 3) {
    problemas.push({ linha: 1, tipo: 'linha-de-requisicao' });
  } else {
    const [m = '', u = '', s = ''] = tokens;
    if (ehMetodo(m)) metodo = m;
    else problemas.push({ linha: 1, tipo: 'metodo' });
    const numero = Number(s);
    if (STATUS.test(s) && numero >= 100 && numero <= 599) status = numero;
    else problemas.push({ linha: 1, tipo: 'status' });
    url = lerUrl(u);
    if (!url.ok) problemas.push(...url.problemas);
  }

  let credencial: CredencialCapturaLi | null = null;
  let credenciais = 0;
  let data: string | null = null;
  let datas = 0;
  for (let i = 1; i < linhas.length; i++) {
    const linha = linhas[i] ?? '';
    const numero = i + 1;
    const c = LINHA_CREDENCIAL.exec(linha);
    if (c !== null) {
      credenciais += 1;
      const valor = c[1] ?? '';
      if (credenciais > 1) problemas.push({ linha: numero, tipo: 'credencial-repetida' });
      else if (ehCredencial(valor)) credencial = valor;
      else problemas.push({ linha: numero, tipo: 'credencial-desconhecida' });
      continue;
    }
    const d = LINHA_DATA.exec(linha);
    if (d !== null) {
      datas += 1;
      const valor = d[1] ?? '';
      if (datas > 1) problemas.push({ linha: numero, tipo: 'data-repetida' });
      else if (ehDataValida(valor)) data = valor;
      else problemas.push({ linha: numero, tipo: 'data-invalida' });
      continue;
    }
    problemas.push({ linha: numero, tipo: 'linha-nao-reconhecida' });
  }
  if (credenciais === 0) problemas.push({ linha: null, tipo: 'sem-credencial' });

  if (
    problemas.length > 0 ||
    metodo === null ||
    status === null ||
    url === null ||
    !url.ok ||
    credencial === null
  ) {
    return { ok: false, problemas };
  }
  return {
    ok: true,
    requisicao: { metodo, caminho: url.caminho, query: url.query, status, credencial, data },
  };
}
