/**
 * The testable half of `scripts/etiqueta.ts` (#1523, step 15) — the
 * `baixar:etiqueta` CLI: argument parsing, the pedido → conta ladder, the run
 * in both modes, the renderer, the error describer and the usage text.
 *
 * ⚠️ **It lives here rather than in the script because `scripts/` is outside
 * this app's vitest `include`** (`{app,lib,functions}/**\/*.test.ts`) — step
 * 14's `nfe/enviarNfeCli.ts` shape. The script keeps the environment, the
 * dynamic imports, the one clock and the one sleep, and nothing else.
 *
 * ⚠️ **Script-only, imported by no route, no job and no bundle.** Nothing here
 * reads an environment variable or a clock (`deps.agora` / `deps.dormir` are the
 * script's), and the runner is INJECTED: this module names `executarEtiqueta.ts`
 * for its TYPES only (a test pins the raw text), so loading it does not load
 * the runner. Neither of them loads `next/server`: the 202 body's shape and the
 * runner's pt-BR sentences live in the pure `pendenteEtiqueta.ts`, and only the
 * route imports the Next-bound `respostaEtiqueta.ts` (review 1, R5-1).
 *
 * ## The two modes
 *
 * **The dry run (the DEFAULT)** calls the runner with `somenteLeitura: true`:
 * every READ runs (the order, the packages, the tracking number, the document
 * parameter and result), and the first write-ish action — `ship_order`,
 * `create_shipping_document`, `download_shipping_document` — is answered
 * `simulado` instead of sent (S46). When that action is the ARRANGE, this module
 * adds the one read the runner stops before: `get_shipping_parameter`, through
 * the shared chooser, to print the mode verdict.
 *
 * **`--live`** runs the same runner for real with a 5-minute budget for the
 * WHOLE run. `ship_order` is irreversible. The file is never written: the run
 * prints the sniffed format and the byte LENGTH.
 *
 * ## ⚠️ The only loop is the one the operator cannot do by hand
 *
 * A live run re-calls the runner in exactly two cases, and both exist because
 * this CLI never prints a package number — the operator could not name the
 * package in a second command:
 *
 * - **`escolher-envio`** for a package whose question was not yet answered in
 *   this run, when the operator gave a mode (`--endereco [--horario]` or
 *   `--dropoff`): the answer is bound to the package the QUESTION named and the
 *   runner is called again. Each package is answered at most once, so a stale
 *   answer (`escolhaInvalida`) ends the run instead of looping.
 * - **`baixar-por-pacote`** on a whole-order run: one call per listed package,
 *   in Shopee's order, moving on only after a file.
 *
 * Everything else ENDS the run — a wait, a refusal, the NF-e — and the operator
 * runs the command again. Bounded twice: {@link MAX_CHAMADAS_ETIQUETA_CLI} calls
 * and the {@link ORCAMENTO_CLI_ETIQUETA_MS} deadline.
 *
 * ⚠️ **Every re-call waits `ESPERA_POS_PROGRAMAR_MS` first** (review 1, R2-4).
 * The previous call may have ended right after our own `ship_order` (it arranged
 * package 1, then asked about package 2), and a read made at once may not
 * reflect the arrange yet (register 208) — the next call would then ask about,
 * or re-ship, a package that is already arranged. The runner's result does not
 * say whether a ship happened, so the CLI waits before EVERY re-call: at most
 * 19 waits of 2 s, inside the 5-minute budget. The first call never waits.
 *
 * ## The ladder (the label route's own — ONE copy, `alvoEtiqueta.ts`)
 *
 * The raw pedido (absent ⇒ `pedido-nao-encontrado`, the one rung that is this
 * CLI's own), then the two functions the route runs too (review 1, R5-3):
 * ownership and the frete block (⇒ `nao-shopee` / `frete-de-outra-integracao`),
 * then the conta (⇒ `conta-nao-configurada` / `conta-inativa`) BEFORE any
 * client is built. A refused pedido costs zero Shopee calls.
 *
 * ## What it prints, and what it must never print
 *
 * Counts, phases (by package POSITION), action and motivo slugs with their pt-BR
 * sentence, the chosen document TYPE token, the sniffed format and the byte
 * length — and, beside a `recusa-desconhecida`, Shopee's canonical CODE
 * (`code=…`, through `codigoSeguro`: the one datum a rehearsal exists to
 * capture, review 1 R3-F1). **Never** an order number, a package number, a
 * tracking number, an address (or its id), a byte, the pedido id or Shopee's
 * own text — every builder below is an ALLOW-LIST, fields named one at a time,
 * and nothing is copied from a runner result wholesale. Nor an argument the
 * operator typed: a bad command line is described by POSITION (R3-F3). On
 * `nfe-pendente` it prints "use `enviar:nfe`" and never re-drives the NF-e.
 *
 * Ver apps/shopee/scripts/README.md §16.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { pedidoCollection } from '@delfrance/data/admin/collections';
import {
  ShopeeApiError,
  ShopeeArquivoVazioError,
  ShopeeConfigError,
  ShopeeError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
  type ShopeeClient,
  type ShopeeShippingParameter,
} from '@delfrance/integrations-shopee';

import { naoDocId } from '../anuncios/corpoPublicacao';
import { readConta } from '../core/contaCache';
import {
  ShopeeContaSemShopIdError,
  ShopeeRefreshEmAndamentoError,
  ShopeeSemCredencialError,
} from '../core/tokenStore';
import { codigoSeguro } from '../nfe/redacaoNfe';
import { ArgumentoInvalidoError } from '../pedidos/importarPedidoCli';
import {
  avaliarContaParaEtiquetaShopee,
  avaliarPedidoParaEtiquetaShopee,
  type MotivoContaEtiquetaShopee,
  type MotivoPedidoEtiquetaShopee,
} from './alvoEtiqueta';
import { ESPERA_POS_PROGRAMAR_MS, TAMANHO_MAX_PACOTE, TIPO_OMITIDO } from './constantesEtiqueta';
import { classificarErroDeEtiqueta, type VereditoDeErro } from './errosEtiqueta';
import type { DepsExecucaoEtiqueta, EntradaEtiqueta, ResultadoEtiqueta } from './executarEtiqueta';
import type { AcaoEtiqueta, FaseEtiqueta, FasePacote } from './faseEtiqueta';
import { escolherModoDeEnvio, type EscolhaDeEnvio, type ModoEscolhido } from './modoDeEnvio';
import {
  MOTIVO_ETIQUETA_SHOPEE,
  mensagemDoMotivoEtiqueta,
  type MotivoEtiquetaShopee,
} from './motivosEtiqueta';
import type { EtiquetaPendente, Progresso } from './pendenteEtiqueta';

export { ArgumentoInvalidoError };

/* -------------------------------------------------------------------------- */
/*                                  arguments                                  */
/* -------------------------------------------------------------------------- */

/**
 * The live run's budget, in MILLISECONDS, for the WHOLE run (every runner call
 * included) — there is no HTTP cap in a script, so it can wait out a slow
 * tracking number that the route's 30 s cannot (reconcile R-y).
 */
export const ORCAMENTO_CLI_ETIQUETA_MS = 5 * 60_000;

/**
 * The most runner calls one run makes. A whole order is at most two calls per
 * package (its question, its file) plus the first; a run that reaches this is
 * cut, and says so.
 */
export const MAX_CHAMADAS_ETIQUETA_CLI = 20;

/** The two label formats the route accepts. */
export type FormatoEtiquetaCli = 'pdf' | 'zpl2';

const FORMATOS: ReadonlySet<string> = new Set<FormatoEtiquetaCli>(['pdf', 'zpl2']);

function ehFormato(v: string): v is FormatoEtiquetaCli {
  return FORMATOS.has(v);
}

/**
 * ⚠️ No `--` separator in any documented invocation: pnpm forwards the literal
 * token INTO the script, which parses its own argv.
 * `packages/config-eslint/rules/pnpm-run-args.test.js` fails CI on the spelling
 * that carries one — including inside this string.
 *
 * ⚠️ It names no shop, no order number and no credential: the conta is PROVED
 * from the pedido document at runtime.
 */
export const USO_BAIXAR_ETIQUETA = `
Baixa a etiqueta de envio de UM pedido Shopee pelo mesmo caminho do botão
Imprimir do ERP (organizar o envio → rastreio → gerar → baixar).

  pnpm --filter @delfrance/shopee-app baixar:etiqueta --pedido <pedidoId>

Obrigatório
  --pedido <id>        o DOCUMENTO do pedido (o id do Firestore — nunca o número
                       do pedido na Shopee).

Opções
  --formato pdf|zpl2   o formato pedido à Shopee (padrão: pdf; zpl2 = térmica).
  --pacote <número>    só este pacote de um pedido dividido. Sem ela, todos os
                       pacotes, um arquivo por pacote quando a Shopee não junta.
  --endereco <id>      a resposta à pergunta de envio: o endereço de coleta.
  --horario <id>       o horário de coleta; só junto de --endereco.
  --dropoff            a resposta à pergunta de envio: postar na agência.
  --dry-run            lê tudo e imprime o que faria, sem organizar o envio, sem
                       gerar e sem baixar a etiqueta. É o PADRÃO.
  --live               ORGANIZA O ENVIO DE VERDADE na Shopee (irreversível) e
                       baixa a etiqueta. O arquivo NÃO é gravado: só o formato e
                       o tamanho são impressos. Orçamento: 5 minutos.
  --project <id>       sobrescreve FIREBASE_PROJECT_ID antes de abrir o admin.
  --help, -h           mostra esta ajuda e sai com 0, sem abrir o Firestore
                       nem chamar a Shopee.

O dry-run lê o Firestore e CHAMA a Shopee (só leituras): ele nunca chama
ship_order, create_shipping_document nem download_shipping_document.
Nada é impresso que identifique o pedido na Shopee: nem o número do pedido, nem
o do pacote, nem o rastreio, nem endereços. A NF-e nunca é reenviada daqui: use
enviar:nfe.
Uma recusa é uma RESPOSTA: o comando sai com 0. Só uma falha sai com 1.
Ver apps/shopee/scripts/README.md.
`.trim();

/** The operator's answer to the shipping-mode question, not yet bound to a package. */
export type ModoInformadoEtiqueta =
  | { readonly modo: 'pickup'; readonly enderecoId: string; readonly horarioId: string | null }
  | { readonly modo: 'dropoff' };

export interface ArgsBaixarEtiqueta {
  readonly pedidoId: string;
  readonly formato: FormatoEtiquetaCli;
  /** One package of a split order; `null` ⇒ the whole order. */
  readonly pacote: string | null;
  readonly envio: ModoInformadoEtiqueta | null;
  /** `false` — the DRY-RUN default. `--live` is the only way to ship. */
  readonly live: boolean;
  /** `null` keeps whatever the environment resolves. */
  readonly projectId: string | null;
}

export type ComandoBaixarEtiqueta =
  | { readonly kind: 'ajuda' }
  | { readonly kind: 'etiqueta'; readonly args: ArgsBaixarEtiqueta };

/** `--pedido` was never given. */
export const MSG_PEDIDO_OBRIGATORIO = '--pedido <pedidoId> é obrigatório.';

function valorDe(nome: string, inline: string | undefined, proximo: string | undefined): string {
  const bruto = (inline ?? proximo)?.trim();
  if (bruto == null || bruto.length === 0 || bruto.startsWith('--')) {
    throw new ArgumentoInvalidoError(`--${nome} exige um valor.`);
  }
  return bruto;
}

/** A flag that takes a value and may appear once. */
function unico(nome: string, atual: string | undefined): void {
  if (atual !== undefined) {
    throw new ArgumentoInvalidoError(`--${nome} só pode aparecer uma vez.`);
  }
}

/**
 * A switch takes no value. ⚠️ Refused rather than ignored: `--live=0` read as
 * "the flag is present" would ship. The value itself is not echoed (R3-F3).
 */
function semValor(nome: string, inline: string | undefined): true {
  if (inline !== undefined) {
    throw new ArgumentoInvalidoError(
      `${nome} não aceita valor (o valor recebido não é impresso): a presença da flag já é o valor.`,
    );
  }
  return true;
}

/**
 * The refusal of a token the parser does not know — by its 1-based POSITION,
 * never by its text (review 1, R3-F3): a stray token is usually a SECOND
 * package number or address id (`--pacote A B`, `--endereco 1 2`), the usage
 * text promises that nothing identifying the order is printed, and this line
 * is what gets pasted into an issue.
 */
function tokenDesconhecido(arg: string, posicao: number): ArgumentoInvalidoError {
  return new ArgumentoInvalidoError(
    arg.startsWith('-')
      ? `Opção desconhecida na posição ${String(posicao)} (o texto não é impresso) — veja --help.`
      : `Argumento solto na posição ${String(posicao)} (o valor não é impresso): todo valor vem logo depois da sua opção — veja --help.`,
  );
}

/**
 * Parse the command line. Pure — it reads no environment and no clock.
 *
 * - `--help` is answered BEFORE anything is validated.
 * - **Dry-run is the default and `--live` the only opt-in**; both at once is a
 *   contradiction and is REFUSED, never resolved by precedence.
 * - `--pedido` once, through {@link naoDocId} (the channel's routes' own id
 *   predicate). `--formato` ∈ {pdf, zpl2}. `--pacote` non-blank and at most
 *   {@link TAMANHO_MAX_PACOTE} characters — the route's own bound.
 * - `--horario` only beside `--endereco`; `--dropoff` never beside either.
 * - There is NO `--confirmar-janela`: the 1-hour confirm was removed (Lucas,
 *   2026-09-30, reconcile Appendix A), so it is an unknown option like any other.
 */
export function parseArgsEtiqueta(argv: readonly string[]): ComandoBaixarEtiqueta {
  if (argv.some((a) => a === '--help' || a === '-h')) return { kind: 'ajuda' };

  let pedidoId: string | undefined;
  let formato: string | undefined;
  let pacote: string | undefined;
  let enderecoId: string | undefined;
  let horarioId: string | undefined;
  let projectId: string | undefined;
  let dropoff = false;
  let live = false;
  let dryRunExplicito = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--') {
      throw new ArgumentoInvalidoError(
        'Separador "--" recebido como argumento: o pnpm repassa esse token para o script. ' +
          'Remova-o e passe as flags direto (veja --help).',
      );
    }
    const igual = arg.indexOf('=');
    const nome = igual === -1 ? arg : arg.slice(0, igual);
    const inline = igual === -1 ? undefined : arg.slice(igual + 1);
    const consumir = (flag: string): string => {
      const v = valorDe(flag, inline, argv[i + 1]);
      if (inline === undefined) i += 1;
      return v;
    };
    switch (nome) {
      case '--pedido': {
        unico('pedido', pedidoId);
        const valor = consumir('pedido');
        if (naoDocId(valor)) {
          throw new ArgumentoInvalidoError(
            '--pedido não é um id de documento (o valor não é impresso): "/", "." e ".." endereçam outro caminho.',
          );
        }
        pedidoId = valor;
        break;
      }
      case '--formato':
        unico('formato', formato);
        formato = consumir('formato');
        break;
      case '--pacote':
        unico('pacote', pacote);
        pacote = consumir('pacote');
        break;
      case '--endereco':
        unico('endereco', enderecoId);
        enderecoId = consumir('endereco');
        break;
      case '--horario':
        unico('horario', horarioId);
        horarioId = consumir('horario');
        break;
      case '--project':
        unico('project', projectId);
        projectId = consumir('project');
        break;
      case '--dropoff':
        dropoff = semValor(nome, inline);
        break;
      case '--live':
        live = semValor(nome, inline);
        break;
      case '--dry-run':
        dryRunExplicito = semValor(nome, inline);
        break;
      default:
        throw tokenDesconhecido(arg, i + 1);
    }
  }

  if (live && dryRunExplicito) {
    throw new ArgumentoInvalidoError('--live e --dry-run são contraditórios; escolha um.');
  }
  if (pedidoId === undefined) throw new ArgumentoInvalidoError(MSG_PEDIDO_OBRIGATORIO);
  const formatoLido = formato ?? 'pdf';
  if (!ehFormato(formatoLido)) {
    throw new ArgumentoInvalidoError(
      '--formato não reconhecido (o valor não é impresso): use pdf ou zpl2.',
    );
  }
  if (pacote !== undefined && pacote.length > TAMANHO_MAX_PACOTE) {
    throw new ArgumentoInvalidoError(
      `--pacote tem mais de ${String(TAMANHO_MAX_PACOTE)} caracteres: não é um número de pacote.`,
    );
  }
  if (horarioId !== undefined && enderecoId === undefined) {
    throw new ArgumentoInvalidoError('--horario só vale junto de --endereco.');
  }
  if (dropoff && enderecoId !== undefined) {
    throw new ArgumentoInvalidoError(
      '--dropoff e --endereco são respostas contraditórias: postar na agência OU coleta.',
    );
  }

  const envio: ModoInformadoEtiqueta | null = dropoff
    ? { modo: 'dropoff' }
    : enderecoId !== undefined
      ? { modo: 'pickup', enderecoId, horarioId: horarioId ?? null }
      : null;

  return {
    kind: 'etiqueta',
    args: {
      pedidoId,
      formato: formatoLido,
      pacote: pacote ?? null,
      envio,
      live,
      projectId: projectId ?? null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                                 the ladder                                  */
/* -------------------------------------------------------------------------- */

/** The pedido document does not exist (the route's 404). */
export const PEDIDO_NAO_ENCONTRADO = 'pedido-nao-encontrado';

/**
 * Why the ladder refused the pedido before any Shopee call: the CLI's own
 * missing document, or one of `alvoEtiqueta.ts`'s refusals.
 */
export type MotivoAlvoEtiquetaCli =
  | typeof PEDIDO_NAO_ENCONTRADO
  | MotivoPedidoEtiquetaShopee
  | MotivoContaEtiquetaShopee;

/** The sentence of a ladder refusal. */
function mensagemDoMotivoAlvo(motivo: MotivoAlvoEtiquetaCli): string {
  return motivo === PEDIDO_NAO_ENCONTRADO
    ? 'O pedido não existe neste projeto — confira o id do documento e o --project.'
    : mensagemDoMotivoEtiqueta(motivo);
}

/* -------------------------------------------------------------------------- */
/*                                 the report                                  */
/* -------------------------------------------------------------------------- */

/** The dry run's reading of the shipping mode, at an ARRANGE — counts only. */
export type VereditoDoModoCli =
  | { readonly tipo: 'corpo'; readonly modo: 'pickup' | 'dropoff' }
  | {
      readonly tipo: 'pergunta';
      readonly enderecos: number;
      readonly horarios: number;
      readonly permiteDropoff: boolean;
      readonly escolhaInvalida: boolean;
    }
  | { readonly tipo: 'recusa'; readonly motivo: MotivoEtiquetaShopee }
  | {
      readonly tipo: 'falha';
      readonly veredito: VereditoDeErro['tipo'];
      readonly motivo: MotivoEtiquetaShopee | null;
    };

/** One runner answer, redacted — every field named, no number of Shopee's. */
export type ResumoChamadaEtiqueta =
  | {
      readonly tipo: 'bytes';
      readonly formato: 'pdf' | 'zip' | 'zpl';
      readonly contentType: string;
      readonly extensao: 'pdf' | 'zip' | 'txt';
      /** The byte LENGTH — never a byte. */
      readonly tamanho: number;
      readonly indice: number | null;
      readonly total: number;
    }
  | {
      readonly tipo: 'aguardar';
      readonly fase: FaseEtiqueta;
      readonly tentarEmMs: number;
      readonly mensagem: string;
      readonly progresso: Progresso;
    }
  | {
      readonly tipo: 'escolher-envio';
      /** "Pacote i de n" (a POSITION), or `null` on a single-package order. */
      readonly pacoteRotulo: string | null;
      readonly enderecos: number;
      readonly horarios: number;
      readonly permiteDropoff: boolean;
      readonly escolhaInvalida: boolean;
      readonly mensagem: string;
      readonly progresso: Progresso;
    }
  | {
      readonly tipo: 'baixar-por-pacote';
      readonly pacotes: number;
      readonly mensagem: string;
      readonly progresso: Progresso;
    }
  | {
      readonly tipo: 'recusa';
      readonly motivo: MotivoEtiquetaShopee;
      readonly mensagem: string;
      readonly tentarApos: number | null;
      /**
       * Shopee's canonical code on a `recusa-desconhecida`, already printable
       * (`codigoSeguro`, or `(não é um código)`); `null` when the runner
       * carried none.
       */
      readonly shopeeCode: string | null;
    }
  | { readonly tipo: 'nfe-pendente'; readonly mensagem: string }
  | { readonly tipo: 'sem-permissao' }
  | { readonly tipo: 'formato-desconhecido' }
  | {
      readonly tipo: 'simulado';
      readonly acao: AcaoEtiqueta['tipo'];
      /** How many packages the action names — never which. */
      readonly pacotesDaAcao: number;
      /** At an arrange: whether `package_number` would ride the ship. */
      readonly comPacote: boolean | null;
      /** At a download: the document type token (already printable). */
      readonly tipoDocumento: string | null;
      readonly fases: readonly FasePacote[];
      readonly progresso: Progresso;
      readonly modo: VereditoDoModoCli | null;
    };

export interface ChamadaEtiquetaCli {
  /** The package this call asked about, by POSITION in the per-package walk; `null` otherwise. */
  readonly pacote: { readonly indice: number; readonly total: number } | null;
  /** This call carried the operator's shipping-mode answer. */
  readonly comResposta: boolean;
  readonly resumo: ResumoChamadaEtiqueta;
}

export interface RelatorioBaixarEtiqueta {
  readonly live: boolean;
  readonly formato: FormatoEtiquetaCli;
  readonly pacoteExplicito: boolean;
  readonly envio: ModoInformadoEtiqueta['modo'] | null;
  /** The ladder's refusal — no client was built and Shopee was never called. */
  readonly recusaDoPedido: MotivoAlvoEtiquetaCli | null;
  readonly chamadas: readonly ChamadaEtiquetaCli[];
  /** Why the run's own walk stopped early, when it did. */
  readonly interrompido: 'limite-de-chamadas' | 'sem-tempo' | null;
}

/** Shopee's document-type TOKEN (`NORMAL_AIR_WAYBILL`, …) — anything else is not printed. */
const TIPO_DOCUMENTO_TOKEN = /^[A-Z][A-Z0-9_]{0,63}$/;

function tipoDocumentoImprimivel(tipo: string | null): string | null {
  if (tipo === null) return null;
  // The runner's "send no type" decision (Shopee's default) — its ONE sentinel,
  // imported, never re-typed here (review 1, R5-6).
  if (tipo === TIPO_OMITIDO) return 'padrão da Shopee (sem tipo)';
  return TIPO_DOCUMENTO_TOKEN.test(tipo) ? tipo : '(tipo fora do padrão — não impresso)';
}

/**
 * The four counts, copied BY NAME (an allow-list: a field added to `Progresso`
 * is not printed until this names it). Not `faseEtiqueta.ts`'s `progressoDe`,
 * which DERIVES the counts from the package observations — hence the other
 * name (review 1, R5-9).
 */
function copiaDoProgresso(p: Progresso): Progresso {
  return {
    total: p.total,
    organizados: p.organizados,
    comRastreio: p.comRastreio,
    prontos: p.prontos,
  };
}

function horariosDe(enderecos: readonly { readonly horarios: readonly unknown[] }[]): number {
  return enderecos.reduce((n, e) => n + e.horarios.length, 0);
}

function pacotesDaAcao(acao: AcaoEtiqueta): number {
  switch (acao.tipo) {
    case 'programar':
      return 1;
    case 'buscar-rastreio':
    case 'ler-parametros-documento':
    case 'ler-resultado':
    case 'criar-documento':
    case 'baixar':
    case 'por-pacote':
      return acao.pacotes.length;
    case 'recusa':
    case 'nfe-pendente':
    case 'aguardar-documento':
      return 0;
  }
}

/** The 202 body → its summary: counts, never the package numbers or the addresses it carries. */
function resumirPendente(c: EtiquetaPendente): ResumoChamadaEtiqueta {
  switch (c.acao) {
    case 'aguardar':
      return {
        tipo: 'aguardar',
        fase: c.fase,
        tentarEmMs: c.tentarEmMs,
        mensagem: c.mensagem,
        progresso: copiaDoProgresso(c.progresso),
      };
    case 'escolher-envio':
      return {
        tipo: 'escolher-envio',
        pacoteRotulo: c.pacoteRotulo,
        enderecos: c.enderecos.length,
        horarios: horariosDe(c.enderecos),
        permiteDropoff: c.permiteDropoff,
        escolhaInvalida: c.escolhaInvalida,
        mensagem: c.mensagem,
        progresso: copiaDoProgresso(c.progresso),
      };
    case 'baixar-por-pacote':
      return {
        tipo: 'baixar-por-pacote',
        pacotes: c.pacotes.length,
        mensagem: c.mensagem,
        progresso: copiaDoProgresso(c.progresso),
      };
  }
}

/** The runner's result → the allow-listed summary. */
function resumirResultadoEtiqueta(
  r: ResultadoEtiqueta,
  modo: VereditoDoModoCli | null,
): ResumoChamadaEtiqueta {
  switch (r.tipo) {
    case 'bytes':
      return {
        tipo: 'bytes',
        formato: r.formato,
        contentType: r.contentType,
        extensao: r.extensao,
        tamanho: r.bytes.byteLength,
        indice: r.indice,
        total: r.total,
      };
    case 'pendente':
      return resumirPendente(r.corpo);
    case 'recusa':
      return {
        tipo: 'recusa',
        motivo: r.motivo,
        mensagem: mensagemDoMotivoEtiqueta(r.motivo),
        tentarApos: r.tentarApos ?? null,
        // The runner already gated it; the CLI reads it through the SAME gate
        // its error describer uses, so a printed code is a token by
        // construction here too.
        shopeeCode: r.shopeeCode === undefined ? null : codigoImprimivel(r.shopeeCode),
      };
    case 'nfe-pendente':
      return {
        tipo: 'nfe-pendente',
        mensagem: mensagemDoMotivoEtiqueta(MOTIVO_ETIQUETA_SHOPEE.nfePendente),
      };
    case 'sem-permissao':
      return { tipo: 'sem-permissao' };
    case 'formato-desconhecido':
      return { tipo: 'formato-desconhecido' };
    case 'simulado':
      return {
        tipo: 'simulado',
        acao: r.acao.tipo,
        pacotesDaAcao: pacotesDaAcao(r.acao),
        comPacote: r.acao.tipo === 'programar' ? r.acao.comPacote : null,
        tipoDocumento:
          r.acao.tipo === 'baixar' ? tipoDocumentoImprimivel(r.acao.tipoDocumento) : null,
        fases: [...r.fases],
        progresso: copiaDoProgresso(r.progresso),
        modo,
      };
  }
}

/* -------------------------------------------------------------------------- */
/*                                   the run                                   */
/* -------------------------------------------------------------------------- */

export interface DepsBaixarEtiquetaCli {
  readonly db: Firestore;
  /** The clock, in MILLISECONDS — the script's. */
  readonly agora: () => number;
  readonly dormir: (ms: number) => Promise<void>;
  /** `loadShopeeContext(db, contaId).createShopClient()` — built only after the ladder passed. */
  readonly criarCliente: (contaId: string) => Promise<ShopeeClient>;
  /** `executarEtiquetaShopee`, INJECTED (this module names the runner for its types only). */
  readonly executar: (deps: DepsExecucaoEtiqueta, e: EntradaEtiqueta) => Promise<ResultadoEtiqueta>;
}

export type ArgsDaExecucaoEtiqueta = Pick<
  ArgsBaixarEtiqueta,
  'pedidoId' | 'formato' | 'pacote' | 'envio' | 'live'
>;

/** The operator's mode, bound to ONE package — the shape the runner matches exactly. */
function escolhaPara(modo: ModoInformadoEtiqueta, pacote: string): EscolhaDeEnvio {
  return modo.modo === 'dropoff'
    ? { pacote, modo: 'dropoff' }
    : { pacote, modo: 'pickup', enderecoId: modo.enderecoId, horarioId: modo.horarioId };
}

function vereditoDoModo(m: ModoEscolhido): VereditoDoModoCli {
  switch (m.tipo) {
    case 'corpo':
      return { tipo: 'corpo', modo: m.corpo.modo };
    case 'pergunta':
      return {
        tipo: 'pergunta',
        enderecos: m.enderecos.length,
        horarios: horariosDe(m.enderecos),
        permiteDropoff: m.permiteDropoff,
        escolhaInvalida: m.escolhaInvalida,
      };
    case 'recusa':
      return { tipo: 'recusa', motivo: m.motivo };
  }
}

/**
 * The dry run's ONE extra read, at an arrange: `get_shipping_parameter` for the
 * package (always named, as `programarPacote.ts` reads it), then the shared
 * chooser with the operator's answer bound to THAT package. A failure goes
 * through the same classifier; `null` ⇒ rethrown.
 */
async function lerModoDeEnvio(
  client: ShopeeClient,
  orderSn: string,
  pacote: string,
  informado: ModoInformadoEtiqueta | null,
  nowMs: number,
): Promise<VereditoDoModoCli> {
  let parametro: ShopeeShippingParameter;
  try {
    parametro = await client.getShippingParameter({ orderSn, packageNumber: pacote });
  } catch (err: unknown) {
    const v = classificarErroDeEtiqueta('parametro-envio', err, nowMs);
    if (v === null) throw err;
    return { tipo: 'falha', veredito: v.tipo, motivo: v.tipo === 'recusa' ? v.motivo : null };
  }
  return vereditoDoModo(
    escolherModoDeEnvio(parametro, informado === null ? null : escolhaPara(informado, pacote)),
  );
}

/**
 * **The run** (see the module docblock): the ladder, the client, then the
 * runner — once in the dry run, and in the live run as many times as the two
 * operator-impossible re-calls need, inside {@link MAX_CHAMADAS_ETIQUETA_CLI}
 * and {@link ORCAMENTO_CLI_ETIQUETA_MS}.
 */
export async function rodarEtiquetaCli(
  deps: DepsBaixarEtiquetaCli,
  args: ArgsDaExecucaoEtiqueta,
): Promise<RelatorioBaixarEtiqueta> {
  const prazo = deps.agora() + ORCAMENTO_CLI_ETIQUETA_MS;
  const base = {
    live: args.live,
    formato: args.formato,
    pacoteExplicito: args.pacote !== null,
    envio: args.envio?.modo ?? null,
  };

  // ---- the ladder: the pedido, raw, then the conta — BEFORE any client ----
  const snap = await pedidoCollection.docRef(deps.db, {}, args.pedidoId).get();
  if (!snap.exists) {
    return { ...base, recusaDoPedido: PEDIDO_NAO_ENCONTRADO, chamadas: [], interrompido: null };
  }
  const raw = (snap.data() ?? {}) as Record<string, unknown>;
  const alvo = avaliarPedidoParaEtiquetaShopee(args.pedidoId, raw);
  if (!alvo.ok) {
    return { ...base, recusaDoPedido: alvo.motivo, chamadas: [], interrompido: null };
  }
  const conta = avaliarContaParaEtiquetaShopee(await readConta(deps.db, alvo.contaId));
  if (!conta.ok) {
    return { ...base, recusaDoPedido: conta.motivo, chamadas: [], interrompido: null };
  }
  const client = await deps.criarCliente(alvo.contaId);

  // ---- the calls ----
  const chamadas: ChamadaEtiquetaCli[] = [];
  /** Packages whose question this run already answered — never twice. */
  const respondidos = new Set<string>();
  let pacote = args.pacote;
  let envio: EscolhaDeEnvio | null = null;
  if (args.pacote !== null && args.envio !== null) {
    envio = escolhaPara(args.envio, args.pacote);
    respondidos.add(args.pacote);
  }
  /** The per-package walk, held in memory only (the numbers are never printed). */
  let fila: readonly string[] | null = null;
  let posicao = 0;
  let interrompido: RelatorioBaixarEtiqueta['interrompido'] = null;

  for (;;) {
    if (chamadas.length >= MAX_CHAMADAS_ETIQUETA_CLI) {
      interrompido = 'limite-de-chamadas';
      break;
    }
    // R2-4: a RE-call may follow our own ship; let Shopee's read catch up
    // (module docblock). Before the budget check, so the wait is charged to it.
    if (chamadas.length > 0) await deps.dormir(ESPERA_POS_PROGRAMAR_MS);
    const restante = prazo - deps.agora();
    if (args.live && restante <= 0) {
      interrompido = 'sem-tempo';
      break;
    }
    const r = await deps.executar(
      {
        client,
        agora: deps.agora,
        dormir: deps.dormir,
        // A developer's run arranges; the route's permission split has no
        // counterpart in a script that holds the admin credential.
        podeProgramar: true,
        somenteLeitura: !args.live,
        ...(args.live ? { orcamentoMs: restante } : {}),
      },
      { orderSn: alvo.orderSn, formato: args.formato, pacote, envio },
    );
    const modo =
      !args.live && r.tipo === 'simulado' && r.acao.tipo === 'programar'
        ? await lerModoDeEnvio(client, alvo.orderSn, r.acao.pacote, args.envio, deps.agora())
        : null;
    chamadas.push({
      pacote: fila === null ? null : { indice: posicao + 1, total: fila.length },
      comResposta: envio !== null,
      resumo: resumirResultadoEtiqueta(r, modo),
    });
    if (!args.live) break;

    // 1. The question, answered once per package — for the package it NAMES.
    if (
      r.tipo === 'pendente' &&
      r.corpo.acao === 'escolher-envio' &&
      args.envio !== null &&
      !respondidos.has(r.corpo.pacote)
    ) {
      respondidos.add(r.corpo.pacote);
      envio = escolhaPara(args.envio, r.corpo.pacote);
      continue;
    }
    // 2. One file per package, in Shopee's order — on a whole-order run only.
    if (
      r.tipo === 'pendente' &&
      r.corpo.acao === 'baixar-por-pacote' &&
      fila === null &&
      args.pacote === null
    ) {
      fila = [...r.corpo.pacotes];
      posicao = 0;
      pacote = fila[0] ?? null;
      envio = null;
      if (pacote === null) break;
      continue;
    }
    if (fila !== null && r.tipo === 'bytes' && posicao + 1 < fila.length) {
      posicao += 1;
      pacote = fila[posicao] ?? null;
      if (pacote === null) break;
      continue;
    }
    break;
  }

  return { ...base, recusaDoPedido: null, chamadas, interrompido };
}

/* -------------------------------------------------------------------------- */
/*                                the renderer                                 */
/* -------------------------------------------------------------------------- */

const TRACO = '—';

function rotulo(nome: string, valor: string): string {
  return `  ${nome.padEnd(22, '.')} ${valor}`;
}

function simNao(v: boolean): string {
  return v ? 'sim' : 'não';
}

function linhaDoProgresso(p: Progresso): string {
  return rotulo(
    'progresso ',
    `${String(p.organizados)}/${String(p.total)} organizados · ${String(p.comRastreio)} com rastreio · ${String(p.prontos)} prontos`,
  );
}

function descreverModo(m: VereditoDoModoCli): string {
  switch (m.tipo) {
    case 'corpo':
      return `${m.modo === 'pickup' ? 'coleta' : 'postagem na agência'} — organizaria sem perguntar`;
    case 'pergunta':
      return (
        `perguntaria: ${String(m.enderecos)} endereço(s) de coleta, ${String(m.horarios)} horário(s), ` +
        `postagem na agência: ${simNao(m.permiteDropoff)}${m.escolhaInvalida ? ' — a resposta dada NÃO bate com a Shopee' : ''}`
      );
    case 'recusa':
      return `recusaria — ${m.motivo}: ${mensagemDoMotivoEtiqueta(m.motivo)}`;
    case 'falha':
      return `não lido — ${m.veredito}${m.motivo === null ? '' : `: ${m.motivo}`}`;
  }
}

/** One call's lines — every value read off the summary, nothing recomputed. */
function renderizarChamadaEtiqueta(c: ChamadaEtiquetaCli, indice: number, total: number): string[] {
  const titulo = [`### chamada ${String(indice + 1)}/${String(total)}`];
  if (c.pacote !== null) {
    titulo.push(`pacote ${String(c.pacote.indice)} de ${String(c.pacote.total)}`);
  }
  if (c.comResposta) titulo.push('com a resposta de envio');
  const linhas = [titulo.join(' — ')];
  const s = c.resumo;
  switch (s.tipo) {
    case 'bytes':
      linhas.push(
        rotulo(
          'arquivo ',
          `${s.formato} (${s.contentType}, .${s.extensao}) — ${String(s.tamanho)} bytes, NÃO gravado`,
        ),
      );
      if (s.indice !== null) {
        linhas.push(rotulo('pacote ', `${String(s.indice)} de ${String(s.total)}`));
      }
      break;
    case 'aguardar':
      linhas.push(rotulo('aguardar ', `${s.fase} — ${s.mensagem}`));
      linhas.push(rotulo('tentar em ', `${String(s.tentarEmMs)} ms — rode de novo`));
      linhas.push(linhaDoProgresso(s.progresso));
      break;
    case 'escolher-envio':
      linhas.push(rotulo('pergunta ', `${s.pacoteRotulo ?? 'o pacote do pedido'} — ${s.mensagem}`));
      linhas.push(
        rotulo(
          'opções ',
          `${String(s.enderecos)} endereço(s) de coleta, ${String(s.horarios)} horário(s), postagem na agência: ${simNao(s.permiteDropoff)}`,
        ),
      );
      if (s.escolhaInvalida) {
        linhas.push(rotulo('resposta ', 'a resposta dada não está mais disponível na Shopee'));
      }
      linhas.push(
        rotulo(
          'como responder ',
          '--endereco <id> [--horario <id>] ou --dropoff (endereços e ids não são impressos aqui)',
        ),
      );
      linhas.push(linhaDoProgresso(s.progresso));
      break;
    case 'baixar-por-pacote':
      linhas.push(rotulo('por pacote ', `${String(s.pacotes)} arquivo(s) — ${s.mensagem}`));
      linhas.push(linhaDoProgresso(s.progresso));
      break;
    case 'recusa':
      linhas.push(
        rotulo(
          'recusa ',
          `${s.motivo}${s.shopeeCode === null ? '' : ` code=${s.shopeeCode}`}: ${s.mensagem}`,
        ),
      );
      if (s.tentarApos !== null) {
        linhas.push(rotulo('tentar após ', new Date(s.tentarApos).toISOString()));
      }
      break;
    case 'nfe-pendente':
      linhas.push(rotulo('recusa ', `${MOTIVO_ETIQUETA_SHOPEE.nfePendente}: ${s.mensagem}`));
      linhas.push(
        rotulo('NF-e ', 'use enviar:nfe para reenviá-la à Shopee — esta CLI nunca reenvia a NF-e'),
      );
      break;
    case 'sem-permissao':
      linhas.push(rotulo('recusa ', 'sem permissão para organizar o envio'));
      break;
    case 'formato-desconhecido':
      linhas.push(
        rotulo('arquivo ', 'formato desconhecido — nada seria entregue (a rota responde 502)'),
      );
      break;
    case 'simulado':
      linhas.push(rotulo('próxima ação ', `${s.acao} (${String(s.pacotesDaAcao)} pacote(s))`));
      if (s.comPacote !== null) {
        linhas.push(rotulo('package_number no ship ', simNao(s.comPacote)));
      }
      if (s.modo !== null) linhas.push(rotulo('modo de envio ', descreverModo(s.modo)));
      if (s.tipoDocumento !== null) linhas.push(rotulo('tipo de etiqueta ', s.tipoDocumento));
      linhas.push(
        rotulo(
          'fases ',
          s.fases.length === 0
            ? TRACO
            : s.fases.map((f, i) => `${String(i + 1)}: ${f}`).join(' · '),
        ),
      );
      linhas.push(linhaDoProgresso(s.progresso));
      linhas.push(rotulo('dry-run ', 'nada foi organizado, gerado nem baixado — use --live'));
      break;
  }
  return linhas;
}

function descreverEnvio(r: RelatorioBaixarEtiqueta): string {
  switch (r.envio) {
    case 'pickup':
      return 'coleta (--endereco)';
    case 'dropoff':
      return 'postagem na agência (--dropoff)';
    case null:
      return 'nenhuma';
  }
}

/** The whole report: header, then one block per call (or the ladder's refusal). */
export function renderizarRelatorioEtiqueta(r: RelatorioBaixarEtiqueta): string[] {
  const linhas: string[] = [
    r.live
      ? '== LIVE — o envio é organizado de verdade; a etiqueta NÃO é gravada em arquivo =='
      : '== DRY-RUN — nada foi organizado, gerado nem baixado na Shopee ==',
    '',
    rotulo('formato ', r.formato),
    rotulo('pacote ', r.pacoteExplicito ? 'só o de --pacote' : 'todos os pacotes do pedido'),
    rotulo('resposta de envio ', descreverEnvio(r)),
  ];
  if (r.recusaDoPedido !== null) {
    linhas.push(
      rotulo(
        'pedido ',
        `recusado — ${r.recusaDoPedido}: ${mensagemDoMotivoAlvo(r.recusaDoPedido)}`,
      ),
    );
    linhas.push(rotulo('Shopee ', 'nenhuma chamada foi feita'));
    return linhas;
  }
  linhas.push(rotulo('chamadas ', String(r.chamadas.length)));
  r.chamadas.forEach((c, i) => {
    linhas.push('');
    linhas.push(...renderizarChamadaEtiqueta(c, i, r.chamadas.length));
  });
  if (r.interrompido !== null) {
    linhas.push('');
    linhas.push(
      r.interrompido === 'limite-de-chamadas'
        ? `⚠️ a CLI parou em ${String(MAX_CHAMADAS_ETIQUETA_CLI)} chamadas — rode de novo para continuar.`
        : '⚠️ o orçamento de 5 minutos acabou — rode de novo para continuar.',
    );
  }
  return linhas;
}

/* -------------------------------------------------------------------------- */
/*                                   errors                                    */
/* -------------------------------------------------------------------------- */

function codigoImprimivel(code: string): string {
  return codigoSeguro(code) ?? '(não é um código)';
}

/**
 * One failure, by CLASS plus the fields that identify it.
 *
 * ⚠️ **Never a Shopee error's `message`**: the package carries Shopee's own
 * sentence into it, and a logistics refusal may quote the order or the package
 * number. The class, the kind, the code (as a token), the HTTP status and the
 * path — nothing Shopee wrote. Our credential classes print a fixed sentence,
 * because their messages name the integração. `ShopeeConfigError` is ours (it
 * names a variable) and prints its message.
 */
export function descreverErroEtiqueta(err: unknown): string[] {
  if (err instanceof ArgumentoInvalidoError) {
    return [`❌ ${err.message}`, '', USO_BAIXAR_ETIQUETA];
  }
  // ⚠️ The two SUBCLASSES first: both extend the API class.
  if (err instanceof ShopeeRateLimitError || err instanceof ShopeeReauthRequiredError) {
    return [
      `❌ ${err.name} (${err.kind})`,
      `   code=${codigoImprimivel(err.code)} httpStatus=${String(err.httpStatus)} path=${err.path}`,
    ];
  }
  if (err instanceof ShopeeApiError) {
    return [
      `❌ ShopeeApiError (${err.kind})`,
      `   code=${codigoImprimivel(err.code)} httpStatus=${String(err.httpStatus)} path=${err.path}`,
      '   (a mensagem da Shopee não é impressa: ela pode citar o pedido ou o pacote)',
    ];
  }
  // ⚠️ The empty-file class extends the schema class.
  if (err instanceof ShopeeArquivoVazioError) {
    return ['❌ ShopeeArquivoVazioError — a Shopee devolveu a etiqueta VAZIA duas vezes.'];
  }
  if (err instanceof ShopeeSchemaError) {
    return [
      '❌ ShopeeSchemaError — a resposta não bate com o schema.',
      `   httpStatus=${String(err.httpStatus)} path=${err.path}`,
      `   campos: ${err.campos.length === 0 ? '(nenhum)' : err.campos.join(', ')}`,
    ];
  }
  if (err instanceof ShopeeHttpError) {
    return ['❌ ShopeeHttpError', `   httpStatus=${String(err.httpStatus)} path=${err.path}`];
  }
  if (err instanceof ShopeeNetworkError) return ['❌ ShopeeNetworkError — sem resposta da Shopee.'];
  if (err instanceof ShopeeConfigError) return ['❌ ShopeeConfigError', `   ${err.message}`];
  if (err instanceof ShopeeError) return [`❌ ${err.name}`];
  if (err instanceof ShopeeContaSemShopIdError) {
    return ['❌ ShopeeContaSemShopIdError — a conta está conectada sem uma loja (shop_id).'];
  }
  if (err instanceof ShopeeSemCredencialError) {
    return ['❌ ShopeeSemCredencialError — a conta não tem credencial: reconecte-a.'];
  }
  if (err instanceof ShopeeRefreshEmAndamentoError) {
    return ['❌ ShopeeRefreshEmAndamentoError — outra instância renova o acesso; rode de novo.'];
  }
  if (err instanceof Error) return [`❌ ${err.name}`, `   ${err.message}`];
  return [`❌ erro não-Error (${typeof err})`];
}

/**
 * Whether a failure happened BEFORE anything could have been arranged — one
 * predicate for the script's failure path. Every other failure under `--live`
 * may follow a landed `ship_order`.
 */
export function ehRecusaAntesDoEnvioEtiqueta(err: unknown): boolean {
  return err instanceof ArgumentoInvalidoError;
}
