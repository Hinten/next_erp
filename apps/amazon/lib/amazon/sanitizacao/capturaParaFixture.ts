/**
 * One capture pair → one fixture envelope, or the reasons it is refused.
 *
 * In order:
 * 1. the sidecar becomes the request (`requisicao.ts`), refused on any problem;
 * 2. the path gives the class (`segredo` and `sem-tabela` are refused there);
 * 3. the body is decoded as UTF-8, its BOM stripped (UTF-16 and invalid UTF-8
 *    refused);
 * 4. the fixture parse cap and the depth pre-scan apply;
 * 5. the body is parsed, and any integer of 16+ digits that `JSON.parse` already
 *    altered refuses the pair (`inteiro-alterado-pelo-parse`) — in the Pipe
 *    record's `body` string too;
 * 6. the Pipe `body` string is parsed and walked (by the redactor itself);
 * 7. the body goes through the `fixture` profile (`redigirCorpo`), the request
 *    line through the path and query redactor, the optional `.req.json` through
 *    the bulk request table and the optional `.zip.txt` through `zip.ts` — every
 *    id through the run's keyed faker;
 * 8. the whole envelope goes through `piiScan` with the denylist.
 *
 * ⚠️ **A value a table KEEPS that the profile had to FAKE is a finding, never a
 * silent fake** (a `sellerSku` that is a valid CPF; a carrier outside the
 * fixture's closed label vocabulary — free text a seller may have typed a
 * courier's name into): the fake is safe, but it would silently drop a value the
 * fixtures keep. ANY finding refuses the pair,
 * and the run (`executar.ts`) then writes nothing at all.
 *
 * ⚠️ Nothing of the raw body or the raw sidecar reaches a result except through
 * the redactor: findings carry where and what, never a value, and the parsed raw
 * tree feeds only the leaf table (paths, types, treatments) and the integer
 * check. A failed `lerRespostaJson` result is never serialised.
 *
 * Pure: bytes, a modification time and a faker in, a result out.
 */
import { lerRespostaJson } from '@delfrance/core/wire';
import { z } from 'zod';

import {
  type FalsificadorAmazon,
  ISENTOS_DE_DIGITOS,
  LIMITE_ANALISE_BYTES,
  PROFUNDIDADE_MAXIMA_JSON,
  type ValorJsonAmazon,
  classificarCaminho,
  mascararTexto,
  passaPredicadoAmazon,
  profundidadeJson,
  redigirCaminhoEQuery,
  redigirCorpo,
  redigirRequisicaoParaFixture,
  regrasDaFolhaAmazon,
  rotuloMantidoNaFixtureAmazon,
} from '../core/redacao';
import {
  type ListaDeNomesAmazon,
  STATUS_DA_NOTIFICACAO,
  type TipoAchadoAmazon,
  piiScan,
  tiposDoTextoAmazon,
  tiposMascaradosAmazon,
} from '../fixtures/piiScan';
import { type EnvelopeFixtureAmazon, serializarFixtureAmazon } from '../fixtures/wireCorpus';
import { type LinhaDeFolhaAmazon, folhasEmParalelo, tabelaDeFolhas } from './folhas';
import {
  type ProblemaDoSidecar,
  type RequisicaoCapturadaAmazon,
  caminhoDoRedator,
  decodificarUtf8,
  lerSidecar,
} from './requisicao';
import { type EntradaDoZipAmazon, lerListagemDoZip } from './zip';

/** One capture pair (plus its optional attachments), as the script read it. */
export interface CapturaAmazon {
  readonly sidecar: Uint8Array;
  readonly corpo: Uint8Array;
  /** The body file's modification time (ms since the epoch): the default capture date. */
  readonly corpoModificadoEmMs: number;
  /** `<nome>.req.json`, or `null`. */
  readonly requisicao: Uint8Array | null;
  /** `<nome>.zip.txt`, or `null`. */
  readonly zip: Uint8Array | null;
}

/** A refusal: WHERE (`.txt:3`, `.json`, an envelope path) and WHAT. Never a value. */
export interface AchadoDaCapturaAmazon {
  readonly onde: string;
  readonly tipo: string;
}

/** What `--dry-run` prints about a pair; it holds no body value. */
export interface ResumoDaCapturaAmazon {
  /**
   * The request line after the redactor (`METODO caminho?query`, or
   * `NOTIFICACAO ORDER_CHANGE <transporte>`); `null` when it trips any pattern of
   * the scanner or a listed term: a refused value is never printed.
   */
  readonly linhaRequisicao: string | null;
  /** Why `linhaRequisicao` is `null`: the kinds it trips (empty when it is printed). */
  readonly linhaOmitidaPor: readonly TipoAchadoAmazon[];
  readonly credencial: string;
  readonly papeis: readonly string[];
  readonly status: number | null;
  readonly forma: 'json' | 'vazio' | null;
  /** The body file's size in bytes. */
  readonly bytes: number;
  readonly folhas: readonly LinhaDeFolhaAmazon[];
}

export type ResultadoDaCapturaAmazon =
  | {
      readonly ok: true;
      readonly envelope: EnvelopeFixtureAmazon;
      /** The fixture file's exact text. */
      readonly texto: string;
      readonly resumo: ResumoDaCapturaAmazon;
    }
  | {
      readonly ok: false;
      readonly achados: readonly AchadoDaCapturaAmazon[];
      readonly resumo: ResumoDaCapturaAmazon | null;
    };

const ehDigito = (c: number) => c >= 48 && c <= 57;
const ehEspaco = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

/**
 * How many integer literals of 16 or more digits, in VALUE position (outside
 * every string), do not survive a `Number` round trip — i.e. `JSON.parse` has
 * already changed them, and the fixture would disagree with production. One
 * linear pass that skips strings; a number with a fraction or an exponent never
 * counts (a double is lossy by nature).
 */
export function contarInteirosInseguros(texto: string): number {
  let inseguros = 0;
  let emString = false;
  let anterior = 0; // the last non-space character outside strings; 0 at the start
  for (let i = 0; i < texto.length; i++) {
    const c = texto.charCodeAt(i);
    if (emString) {
      if (c === 0x5c) i++;
      else if (c === 0x22) {
        emString = false;
        anterior = c;
      }
      continue;
    }
    if (c === 0x22) {
      emString = true;
      continue;
    }
    const comecaNumero = ehDigito(c) || (c === 0x2d && ehDigito(texto.charCodeAt(i + 1)));
    const emPosicaoDeValor =
      anterior === 0 || anterior === 0x3a || anterior === 0x5b || anterior === 0x2c;
    if (comecaNumero && emPosicaoDeValor) {
      let j = c === 0x2d ? i + 1 : i;
      while (j < texto.length && ehDigito(texto.charCodeAt(j))) j++;
      const literal = texto.slice(i, j);
      const proximo = texto.charCodeAt(j);
      const inteiro = proximo !== 0x2e && proximo !== 0x65 && proximo !== 0x45;
      const digitos = literal.length - (c === 0x2d ? 1 : 0);
      if (inteiro && digitos >= 16 && String(Number(literal)) !== literal) inseguros += 1;
      // Skip the rest of the number token (fraction, exponent).
      while (j < texto.length && /[0-9.eE+-]/.test(texto.charAt(j))) j++;
      i = j - 1;
      anterior = 0x30;
      continue;
    }
    if (!ehEspaco(c)) anterior = c;
  }
  return inseguros;
}

/** The record-level `body` strings of a notification (the Pipe's), for the integer check. */
function corposAninhados(v: unknown): string[] {
  const registros = Array.isArray(v) ? v : [v];
  return registros.flatMap((r) =>
    typeof r === 'object' && r !== null && !Array.isArray(r)
      ? Object.entries(r)
          .filter(([k, x]) => k.toLowerCase() === 'body' && typeof x === 'string')
          .map(([, x]) => x as string)
      : [],
  );
}

/** The capture date: the `data:` line, else the body file's modification day in UTC. */
function diaUtc(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

const ondeDoSidecar = (p: ProblemaDoSidecar): AchadoDaCapturaAmazon => ({
  onde:
    p.chave === undefined
      ? `.txt${p.linha === null ? '' : `:${String(p.linha)}`}`
      : `.txt:${String(p.linha ?? 1)} query:${p.chave}`,
  tipo: p.tipo,
});

/**
 * Where the `fixture` profile FAKED a value its table keeps: the regex layer hit
 * it (each kind it trips), or it is a `rotulo` outside the fixture vocabulary
 * (`rotulo-fora-do-vocabulario`). Values the profile fakes BY DESIGN (a `soLog`
 * id that is clean) are not reported.
 */
function mantidosQueForamFalsificados(
  bruto: unknown,
  sanitizado: ValorJsonAmazon,
  modelo: string,
  prefixo: string,
  lista: ListaDeNomesAmazon,
): AchadoDaCapturaAmazon[] {
  const achados: AchadoDaCapturaAmazon[] = [];
  for (const p of folhasEmParalelo(bruto, sanitizado, lista)) {
    if (typeof p.bruto !== 'string') continue;
    for (const regra of regrasDaFolhaAmazon(modelo, p.caminhoDaTabela)) {
      if (regra.tipo !== 'permitida' && regra.tipo !== 'soLog') continue;
      if (!passaPredicadoAmazon(regra.predicado, p.bruto)) continue;
      const digitos = !ISENTOS_DE_DIGITOS.has(regra.predicado);
      const onde = `${prefixo}.${p.caminhoImpresso}`;
      if (mascararTexto(p.bruto, { digitos }).mascarados > 0) {
        const tipos = tiposMascaradosAmazon(p.bruto, { digitos });
        for (const tipo of tipos.length > 0 ? tipos : ['valor-mantido-falsificado']) {
          achados.push({ onde, tipo });
        }
      } else if (
        regra.tipo === 'permitida' &&
        regra.predicado === 'rotulo' &&
        !rotuloMantidoNaFixtureAmazon(p.bruto)
      ) {
        achados.push({ onde, tipo: 'rotulo-fora-do-vocabulario' });
      }
    }
  }
  return achados;
}

function linhaDaRequisicao(
  req: RequisicaoCapturadaAmazon,
  falsificador: FalsificadorAmazon,
): {
  readonly texto: string;
  readonly mascarados: number;
  readonly caminho: string;
  readonly query: readonly (readonly [string, string])[];
} {
  if (req.tipo === 'notificacao') {
    return {
      texto: `NOTIFICACAO ORDER_CHANGE ${req.transporte}`,
      mascarados: 0,
      caminho: '',
      query: [],
    };
  }
  const r = redigirCaminhoEQuery(req.caminho, req.query, 'fixture', { falsificador });
  return {
    texto: `${req.metodo} ${r.texto}`,
    mascarados: r.mascarados,
    caminho: r.caminho,
    query: r.query,
  };
}

/**
 * Converts one pair. `lista` is the owner's denylist; `falsificador` the run's
 * keyed faker (`falsificacao.ts`).
 */
export function capturaParaFixture(
  c: CapturaAmazon,
  lista: ListaDeNomesAmazon,
  falsificador: FalsificadorAmazon,
): ResultadoDaCapturaAmazon {
  const sidecar = lerSidecar(c.sidecar);
  if (!sidecar.ok) {
    return { ok: false, achados: sidecar.problemas.map(ondeDoSidecar), resumo: null };
  }
  const req = sidecar.requisicao;
  const caminho = caminhoDoRedator(req);
  const statusDoRedator = req.tipo === 'http' ? req.status : STATUS_DA_NOTIFICACAO;

  const pedido = linhaDaRequisicao(req, falsificador);
  const omitidaPor = tiposDoTextoAmazon(pedido.texto, lista);
  const base: ResumoDaCapturaAmazon = {
    linhaRequisicao: omitidaPor.length === 0 ? pedido.texto : null,
    linhaOmitidaPor: omitidaPor,
    credencial: req.credencial,
    papeis: req.papeis,
    status: req.tipo === 'http' ? req.status : null,
    forma: null,
    bytes: c.corpo.length,
    folhas: [],
  };
  const recusa = (
    achados: readonly AchadoDaCapturaAmazon[],
    resumo = base,
  ): ResultadoDaCapturaAmazon => ({ ok: false, achados, resumo });

  // The attachments belong to a POST bulk only (C3).
  const anexoIndevido: AchadoDaCapturaAmazon[] = [];
  const ehBulk = req.tipo === 'http' && req.metodo === 'POST';
  if (c.requisicao !== null && !ehBulk)
    anexoIndevido.push({ onde: '.req.json', tipo: 'anexo-indevido' });
  if (c.zip !== null && !ehBulk) anexoIndevido.push({ onde: '.zip.txt', tipo: 'anexo-indevido' });
  if (anexoIndevido.length > 0) return recusa(anexoIndevido);

  if (c.corpo.length > LIMITE_ANALISE_BYTES.fixture) {
    return recusa([{ onde: '.json', tipo: 'corpo-acima-do-limite' }]);
  }
  const decodificado = decodificarUtf8(c.corpo);
  if (!decodificado.ok) return recusa([{ onde: '.json', tipo: decodificado.motivo }]);
  const texto = decodificado.texto;
  if (profundidadeJson(texto) > PROFUNDIDADE_MAXIMA_JSON) {
    return recusa([{ onde: '.json', tipo: 'corpo-profundo-demais' }]);
  }

  // The raw tree, for the unsafe-integer check and the leaf table only.
  const leitura = texto.length === 0 ? null : lerRespostaJson(texto, z.unknown());
  const bruto = leitura?.ok === true ? { valor: leitura.data } : null;
  if (bruto !== null) {
    const aninhados = req.tipo === 'notificacao' ? corposAninhados(bruto.valor) : [];
    const inseguros = [texto, ...aninhados].reduce((n, t) => n + contarInteirosInseguros(t), 0);
    if (inseguros > 0) {
      return recusa([
        { onde: '.json', tipo: `inteiro-alterado-pelo-parse (${String(inseguros)})` },
      ]);
    }
  }

  const corpo = redigirCorpo({ caminho, status: statusDoRedator, corpo: texto }, 'fixture', {
    falsificador,
  });
  if (!corpo.ok) return recusa([{ onde: '.json', tipo: `recusado-${corpo.motivo}` }]);

  // The optional request body (`.req.json`), through the bulk request table.
  const achados: AchadoDaCapturaAmazon[] = [];
  let corpoDaRequisicao: ValorJsonAmazon = null;
  if (c.requisicao !== null && req.tipo === 'http') {
    const lida = decodificarUtf8(c.requisicao);
    if (!lida.ok) return recusa([{ onde: '.req.json', tipo: lida.motivo }]);
    const r = redigirRequisicaoParaFixture(
      { caminho: req.caminho, metodo: req.metodo, corpo: lida.texto },
      { falsificador },
    );
    if (!r.ok) return recusa([{ onde: '.req.json', tipo: `recusado-${r.motivo}` }]);
    if (r.mascarados > 0) {
      achados.push({ onde: 'requisicao.corpo', tipo: 'valor-mantido-falsificado' });
    }
    corpoDaRequisicao = r.corpo;
  }

  // The optional zip layout (`.zip.txt`): names shape-faked, sizes kept.
  let entradasDoZip: readonly EntradaDoZipAmazon[] | null = null;
  if (c.zip !== null) {
    const listagem = lerListagemDoZip(c.zip, falsificador);
    if (!listagem.ok) {
      return recusa(
        listagem.problemas.map((p) => ({
          onde: `.zip.txt${p.linha === null ? '' : `:${String(p.linha)}`}`,
          tipo: p.tipo,
        })),
      );
    }
    entradasDoZip = listagem.entradas;
  }

  const capturadoEm = req.data ?? diaUtc(c.corpoModificadoEmMs);
  if (capturadoEm === null) return recusa([{ onde: '.json', tipo: 'sem-data' }]);

  const envelope: EnvelopeFixtureAmazon = {
    versao: 1,
    perfil: 'fixture',
    credencial: req.credencial,
    papeis: req.papeis,
    capturadoEm,
    limiteTaxa: req.limiteTaxa,
    requisicao:
      req.tipo === 'http'
        ? {
            tipo: 'http',
            metodo: req.metodo,
            caminho: pedido.caminho,
            query: pedido.query,
            corpo: corpoDaRequisicao,
          }
        : { tipo: 'notificacao', notificacao: 'ORDER_CHANGE', transporte: req.transporte },
    resposta: {
      status: req.tipo === 'http' ? req.status : null,
      politica: corpo.politica,
      forma: corpo.forma,
      bytes: corpo.bytes,
      corpo: corpo.corpo,
    },
    anexos: { zip: entradasDoZip === null ? null : { entradas: entradasDoZip } },
  };
  const resumo: ResumoDaCapturaAmazon = {
    ...base,
    forma: corpo.forma,
    folhas: bruto === null ? [] : tabelaDeFolhas(bruto.valor, corpo.corpo, lista),
  };

  // Kept values the profile had to fake: located leaf by leaf when the path is
  // a table's; the count catches the rest (a key, the Pipe's nested body).
  if (pedido.mascarados > 0) {
    achados.push({ onde: 'requisicao.caminho', tipo: 'valor-mantido-falsificado' });
  }
  if (corpo.mascarados > 0) {
    const sucesso = statusDoRedator >= 200 && statusDoRedator <= 299;
    const modelo = classificarCaminho(caminho).modelo;
    const localizados =
      bruto === null || !sucesso || modelo === null
        ? []
        : mantidosQueForamFalsificados(bruto.valor, corpo.corpo, modelo, 'resposta.corpo', lista);
    achados.push(
      ...(localizados.length > 0
        ? localizados
        : [{ onde: 'resposta.corpo', tipo: 'valor-mantido-falsificado' }]),
    );
  }
  achados.push(
    ...piiScan(envelope, lista).map((a) => ({
      onde: a.caminho === '' ? '<raiz>' : a.caminho,
      tipo: a.tipo,
    })),
  );
  const vistos = new Set<string>();
  const unicos = achados.filter((a) => {
    const chave = `${a.onde}\u0000${a.tipo}`;
    if (vistos.has(chave)) return false;
    vistos.add(chave);
    return true;
  });
  if (unicos.length > 0) return recusa(unicos, resumo);
  return { ok: true, envelope, texto: serializarFixtureAmazon(envelope), resumo };
}
