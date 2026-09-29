/**
 * The testable half of `scripts/enviar-nfe.ts` (#1522, step 14) — argument
 * parsing, the per-pedido run in both modes, the renderers (a table and an
 * allow-list JSON), the error describer and the usage text.
 *
 * ⚠️ **It lives here rather than in the script because `scripts/` is outside
 * this app's vitest `include`** (`{app,lib,functions}/**\/*.test.ts`) — step 12's
 * `estoque/enviarEstoqueCli.ts` reasoning and step 13's `precos/enviarPrecoCli.ts`
 * shape. The script keeps the environment, the dynamic imports, the one clock
 * and the one wait, and nothing else.
 *
 * ⚠️ **Script-only, imported by no route, no job and no bundle.** Nothing here
 * reads an environment variable or a clock (`deps.agora` / `deps.esperar` are the
 * script's), and the two handler entry points are INJECTED: this module names
 * `processarNfe.ts` for its TYPES only, so the dry path cannot reach the upload
 * even by accident (a test pins the raw text).
 *
 * ## The two modes
 *
 * **`--dry-run` (the DEFAULT)** runs `simularEnvioNfeShopee` per pedido: the
 * handler's own prefix — the Firestore reads and ONE `get_order_detail` — and
 * the pre-read's verdict. It uploads nothing, writes nothing and enqueues
 * nothing: its deps carry no scheduler, no increment sentinel and no upload
 * entry point at all.
 *
 * **`--live`** runs `processarNfeShopee` IN THIS PROCESS, exactly as the queue's
 * FIRST attempt would (`retryCount` 0), with a RECORDING scheduler: a recheck, a
 * SERPRO wait or a rate-limit pause the queue WOULD have scheduled is captured
 * and printed, never enqueued — a developer's credential is not one of the two
 * identities the queue's enqueuer binding trusts, and a CLI that enqueued would
 * be a third. The operator re-runs later. At attempt 0 a transient failure
 * THROWS (the queue would retry it), so the command exits 1 and nothing is
 * finalized or stamped for the absence of an answer.
 *
 * ⚠️ **A fresh approval is REFUSED under `--live`** (`aguardando-serpro`): Shopee
 * checks the note against the federal record, which lags the SEFAZ
 * authorization, and an upload inside that window spends a certain refusal whose
 * wire text is unverified. The wait is `atrasoSerproS` over the slot's own
 * `data_autorizacao`, judged only for a slot the shared LEVEL predicate calls
 * ready AND whose instant is known — any other slot gets the handler's own
 * answer instead (an unknown instant would otherwise be refused on every run).
 *
 * ## The slot
 *
 * `--nfe <id>` names the `nfev4` document (only with exactly one `--pedido`).
 * Without it, the pedido's `nfev4` documents are LISTED (a handful, no index) and
 * `escolherNfeParaEnvioShopee` — the rule the route and step 15 share — picks
 * one, or answers why none goes.
 *
 * ## What it prints, and what it must never print
 *
 * Pedido ids (a digest), the NF-e slot id, the outcome and motivo slugs, the
 * motivo's `mensagemDoMotivoNfe` sentence, byte counts, the SERPRO wait, and the
 * note Shopee holds as a VERDICT — `chave: confere | difere | ausente` — never as
 * a value. Never the key, a CNPJ/CPF/IE, the XML, the upload filename, the order
 * number (it IS Shopee's order id), a token or Shopee's raw text; a Shopee
 * excerpt only for the members of `MOTIVOS_COM_EXCERTO`, re-run through
 * `resumirTextoDaShopee` here (idempotent on its own output). Every builder below
 * is an ALLOW-LIST: fields are named one at a time, no input object is copied.
 *
 * Ver apps/shopee/scripts/README.md §15.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { coerceToMillis } from '@delfrance/core/datetime';
import { nfev4Collection } from '@delfrance/data/admin/collections';
import {
  SHOPEE_UPLOAD_INVOICE_DOC_MAX_BYTES,
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
} from '@delfrance/integrations-shopee';
import { decideNfeUploadDispatch } from '@delfrance/schemas';

import { naoDocId } from '../anuncios/corpoPublicacao';
import { ArgumentoInvalidoError } from '../pedidos/importarPedidoCli';
import type { MotivoCarimbo } from './carimboFreteNfe';
import { atrasoSerproS } from './constantesNfe';
import {
  DESFECHO_NFE_SHOPEE,
  MOTIVOS_COM_EXCERTO,
  MOTIVO_NFE_SHOPEE,
  mensagemDoMotivoNfe,
  type DesfechoNfeShopee,
  type MotivoNfeShopee,
} from './errosNfe';
import type { NotaNaShopee, StatusNotaShopee } from './notaNaShopee';
import { escolherNfeParaEnvioShopee } from './pedidoNfe';
import type { DepsNfeShopee, ResultadoNfeShopee, SimulacaoNfeShopee } from './processarNfe';
import { resumirTextoDaShopee } from './redacaoNfe';
import {
  FASE_NFE_SHOPEE,
  type AgendadorNfeShopee,
  type FaseNfeShopee,
  type TarefaNfeShopee,
} from './tarefaNfe';

export { ArgumentoInvalidoError };

/* -------------------------------------------------------------------------- */
/*                                  arguments                                  */
/* -------------------------------------------------------------------------- */

/**
 * The most pedidos one run may carry, counted AFTER deduplication — the
 * codebase's manual-push cap (`enviar-estoque` / `enviar-precos`). Above it the
 * command is REFUSED, never truncated.
 */
export const SHOPEE_ENVIO_NFE_MAX_PEDIDOS = 50;

/**
 * The pause between two pedidos, in MILLISECONDS. The queue's own rate limit
 * (one dispatch per second) does not apply in-process, so the run paces itself
 * the same way. The wait is the SCRIPT's (`deps.esperar`).
 */
export const PAUSA_ENTRE_PEDIDOS_MS = 1_000;

/**
 * ⚠️ No `--` separator in any documented invocation: pnpm forwards the literal
 * token INTO the script, which parses its own argv.
 * `packages/config-eslint/rules/pnpm-run-args.test.js` fails CI on the spelling
 * that carries one — including inside this string.
 *
 * ⚠️ It names no shop, no order number and no credential: the conta each pedido
 * belongs to is PROVED from the pedido document at runtime.
 */
export const USO_ENVIAR_NFE = `
Envia à Shopee a NF-e aprovada de pedidos Shopee escolhidos a mão (upload_invoice_doc).

  pnpm --filter @delfrance/shopee-app enviar:nfe \\
    --pedido <pedidoId> [--pedido <pedidoId> ...]

Obrigatório
  --pedido <id>        o DOCUMENTO do pedido (o id do Firestore — nunca o número
                       do pedido na Shopee). REPITA a flag para cada pedido: não
                       existe lista separada por vírgula, porque a vírgula é um
                       caractere legal num id de documento.

Opções
  --nfe <id>           o documento da NF-e em pedidos/<id>/nfev4 (ex.: s1). Só com
                       UM --pedido. Sem ela, a regra de escolha do envio decide
                       qual NF-e do pedido vai para a Shopee.
  --dry-run            lê, decide e imprime, sem enviar, gravar nem enfileirar
                       nada. É o PADRÃO.
  --live               ENVIA DE VERDADE o XML à Shopee, e o envio pode abrir ou
                       fechar o aviso do pedido e marcar o frete com erro.
  --project <id>       sobrescreve FIREBASE_PROJECT_ID antes de abrir o admin.
  --json               imprime o mesmo resumo redigido em JSON no stdout
                       (o cabeçalho vai para o stderr).
  --help, -h           mostra esta ajuda e sai com 0, sem abrir o Firestore
                       nem chamar a Shopee.

No máximo ${String(SHOPEE_ENVIO_NFE_MAX_PEDIDOS)} pedidos por execução, contados DEPOIS de tirar os repetidos.

O dry-run lê o Firestore e CHAMA a Shopee (um get_order_detail por pedido) — ele
não envia o XML, não grava nada e não enfileira nada.
O --live roda o envio NESTE processo, como a primeira tentativa da fila, mas NUNCA
enfileira: uma reverificação, uma espera ou uma pausa que a fila agendaria é
IMPRESSA, e você roda o comando de novo depois.
Uma NF-e aprovada há menos de 6 minutos é RECUSADA no --live (aguardando-serpro):
a Shopee confere a nota no cadastro federal, que se atualiza depois da SEFAZ.
Uma recusa POR PEDIDO é uma RESPOSTA: o comando sai com 0. Só um erro que derruba
a execução inteira sai com 1.
Ver apps/shopee/scripts/README.md.
`.trim();

export interface ArgsEnviarNfe {
  /** DEDUPED, in the order the flags were given. Never empty, never above the cap. */
  readonly pedidoIds: readonly string[];
  /** The explicit slot; `null` ⇒ the slot rule decides per pedido. */
  readonly nfeId: string | null;
  /** `false` — the DRY-RUN default. `--live` is the only way to upload. */
  readonly live: boolean;
  readonly json: boolean;
  /** `null` keeps whatever the environment resolves. */
  readonly projectId: string | null;
}

export type ComandoEnviarNfe =
  | { readonly kind: 'ajuda' }
  | { readonly kind: 'enviar'; readonly args: ArgsEnviarNfe };

/** `--pedido` was never given. */
export const MSG_PEDIDO_OBRIGATORIO =
  '--pedido <pedidoId> é obrigatório (repita a flag para enviar vários).';

/** More pedidos than one run may carry, counted AFTER deduplication. */
export const MSG_EXCEDE_LIMITE = `--pedido foi passado mais de ${String(
  SHOPEE_ENVIO_NFE_MAX_PEDIDOS,
)} vezes (sem contar repetidos). Divida em execuções menores.`;

/** `--nfe` beside more than one pedido — a slot id means one pedido's document. */
export const MSG_NFE_EXIGE_UM_PEDIDO =
  '--nfe só vale com exatamente UM --pedido: o id da NF-e é um documento DAQUELE pedido.';

function valorDe(nome: string, inline: string | undefined, proximo: string | undefined): string {
  const bruto = (inline ?? proximo)?.trim();
  if (bruto == null || bruto.length === 0 || bruto.startsWith('--')) {
    throw new ArgumentoInvalidoError(`--${nome} exige um valor.`);
  }
  return bruto;
}

/**
 * A doc id: trimmed, then checked with {@link naoDocId} — the predicate the
 * channel's routes read their bodies with, imported rather than re-spelled.
 */
function docIdDe(nome: string, inline: string | undefined, proximo: string | undefined): string {
  const valor = valorDe(nome, inline, proximo);
  if (naoDocId(valor)) {
    throw new ArgumentoInvalidoError(
      `--${nome} ${valor} não é um id de documento: "/", "." e ".." endereçam outro caminho.`,
    );
  }
  return valor;
}

/**
 * A switch takes no value. ⚠️ Refused rather than ignored: `--live=0` read as
 * "the flag is present" would upload.
 */
function semValor(nome: string, inline: string | undefined): true {
  if (inline !== undefined) {
    throw new ArgumentoInvalidoError(
      `${nome} não aceita valor (recebido "${nome}=${inline}"): a presença da flag já é o valor.`,
    );
  }
  return true;
}

/**
 * Parse the command line. Pure — it reads no environment and no clock.
 *
 * - `--help` is answered BEFORE anything is validated.
 * - **Dry-run is the default and `--live` the only opt-in**; both at once is a
 *   contradiction and is REFUSED, never resolved by precedence.
 * - `--pedido` is REPEATABLE, deduplicated by EXACT (trimmed) id in flag order.
 * - More than {@link SHOPEE_ENVIO_NFE_MAX_PEDIDOS} distinct pedidos is REFUSED.
 * - `--nfe` only beside exactly ONE distinct pedido, and only once.
 */
export function lerArgumentosEnviarNfe(argv: readonly string[]): ComandoEnviarNfe {
  if (argv.some((a) => a === '--help' || a === '-h')) return { kind: 'ajuda' };

  let projectId: string | undefined;
  let nfeId: string | undefined;
  const pedidoIds: string[] = [];
  const vistos = new Set<string>();
  let live = false;
  let dryRunExplicito = false;
  let json = false;

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
    switch (nome) {
      case '--pedido': {
        const pedidoId = docIdDe('pedido', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        if (!vistos.has(pedidoId)) {
          vistos.add(pedidoId);
          pedidoIds.push(pedidoId);
        }
        break;
      }
      case '--nfe':
        if (nfeId !== undefined) {
          throw new ArgumentoInvalidoError('--nfe só pode aparecer uma vez.');
        }
        nfeId = docIdDe('nfe', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--project':
        projectId = valorDe('project', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--live':
        live = semValor(nome, inline);
        break;
      case '--dry-run':
        dryRunExplicito = semValor(nome, inline);
        break;
      case '--json':
        json = semValor(nome, inline);
        break;
      default:
        throw new ArgumentoInvalidoError(`Opção desconhecida: ${arg}`);
    }
  }

  if (live && dryRunExplicito) {
    throw new ArgumentoInvalidoError('--live e --dry-run são contraditórios; escolha um.');
  }
  if (pedidoIds.length === 0) throw new ArgumentoInvalidoError(MSG_PEDIDO_OBRIGATORIO);
  if (pedidoIds.length > SHOPEE_ENVIO_NFE_MAX_PEDIDOS) {
    throw new ArgumentoInvalidoError(MSG_EXCEDE_LIMITE);
  }
  if (nfeId !== undefined && pedidoIds.length !== 1) {
    throw new ArgumentoInvalidoError(MSG_NFE_EXIGE_UM_PEDIDO);
  }

  return {
    kind: 'enviar',
    args: { pedidoIds, nfeId: nfeId ?? null, live, json, projectId: projectId ?? null },
  };
}

/* -------------------------------------------------------------------------- */
/*                                  the rows                                   */
/* -------------------------------------------------------------------------- */

/** The note Shopee holds, as a VERDICT against ours — never as a value. */
export type SituacaoDaChave = 'confere' | 'difere' | 'ausente';

export const SITUACAO_DA_CHAVE = {
  confere: 'confere',
  difere: 'difere',
  ausente: 'ausente',
} as const satisfies Record<string, SituacaoDaChave>;

/**
 * The pre-read's verdict → the printed situation. `nao-br` and "not read" are
 * `null`: nothing about a key was learned.
 */
function situacaoDaChave(veredito: NotaNaShopee['veredito'] | null): SituacaoDaChave | null {
  switch (veredito) {
    case 'nossa':
      return SITUACAO_DA_CHAVE.confere;
    case 'outra':
      return SITUACAO_DA_CHAVE.difere;
    case 'sem-nota':
      return SITUACAO_DA_CHAVE.ausente;
    case 'nao-br':
    case null:
      return null;
  }
}

/** An enqueue the queue WOULD have made — captured, never sent. */
export interface AgendamentoNaoFeito {
  readonly fase: FaseNfeShopee;
  /** `null` = "dispatch now" (no delay was asked). */
  readonly atrasoS: number | null;
}

/** What the outcome did (`--live`) or would do (`--dry-run`). */
export interface EfeitosNfeCli {
  readonly aviso: boolean;
  readonly carimbo: boolean;
  readonly resolucao: boolean;
  readonly reverificacao: boolean;
}

const SEM_EFEITOS: EfeitosNfeCli = {
  aviso: false,
  carimbo: false,
  resolucao: false,
  reverificacao: false,
};

/** One pedido of the run. */
export interface LinhaEnviarNfe {
  readonly pedidoId: string;
  /** The slot sent (or judged); `null` when the slot rule found none. */
  readonly nfeId: string | null;
  readonly desfecho: DesfechoNfeShopee;
  readonly motivo: MotivoNfeShopee | null;
  /** `mensagemDoMotivoNfe(motivo)`; `null` exactly when `motivo` is. */
  readonly mensagem: string | null;
  /** The pre-read's verdict on the key Shopee holds; `null` when not learned (always under `--live`). */
  readonly chave: SituacaoDaChave | null;
  readonly statusDaNota: StatusNotaShopee | null;
  /** UTF-8 bytes of our proc, when it was read. */
  readonly bytesDoXml: number | null;
  /** Seconds of SERPRO wait still due; `null` when the slot or its authorization instant is unknown. */
  readonly atrasoSerproS: number | null;
  /** The upload replaces (or would replace) a CANCELLED sibling NF-e's key. */
  readonly substituicao: boolean;
  /** `--dry-run` only: whether the upload would be sent now. `null` under `--live`. */
  readonly enviaria: boolean | null;
  readonly efeitos: EfeitosNfeCli;
  /** `--live` only: the frete stamp's own answer, when the motivo stamps. */
  readonly carimbo: MotivoCarimbo | null;
  /** `--live` only: what the queue WOULD have scheduled. Empty under `--dry-run`. */
  readonly naoEnfileirado: readonly AgendamentoNaoFeito[];
  /** Shopee's error code, only when it is a token. */
  readonly codigo: string | null;
  /** The sanitized excerpt — only for the members of `MOTIVOS_COM_EXCERTO`. */
  readonly excerto: string | null;
}

export interface RelatorioEnviarNfe {
  readonly live: boolean;
  readonly nfeExplicita: string | null;
  /** The DEDUPED request size. */
  readonly solicitados: number;
  readonly linhas: readonly LinhaEnviarNfe[];
}

/** The excerpt, only where the vocabulary allows one — sanitized again. */
function excertoPermitido(motivo: MotivoNfeShopee | null, excerto: string | null): string | null {
  if (motivo === null || !MOTIVOS_COM_EXCERTO.has(motivo)) return null;
  return resumirTextoDaShopee(excerto);
}

function mensagemOuNull(motivo: MotivoNfeShopee | null): string | null {
  return motivo === null ? null : mensagemDoMotivoNfe(motivo);
}

/** UTF-8 bytes of the stored proc — the unit the package's ceiling is measured in. */
function bytesDoProc(raw: Record<string, unknown> | null): number | null {
  const xml = raw?.xml_nfe_proc;
  return typeof xml === 'string' ? new TextEncoder().encode(xml).byteLength : null;
}

/** A line decided BEFORE the handler: the slot rule, or the SERPRO wait. */
function linhaDaRecusa(
  pedidoId: string,
  nfeId: string | null,
  desfecho: DesfechoNfeShopee,
  motivo: MotivoNfeShopee,
  extra: { readonly bytesDoXml?: number | null; readonly atrasoSerproS?: number | null } = {},
): LinhaEnviarNfe {
  return {
    pedidoId,
    nfeId,
    desfecho,
    motivo,
    mensagem: mensagemDoMotivoNfe(motivo),
    chave: null,
    statusDaNota: null,
    bytesDoXml: extra.bytesDoXml ?? null,
    atrasoSerproS: extra.atrasoSerproS ?? null,
    substituicao: false,
    enviaria: null,
    efeitos: SEM_EFEITOS,
    carimbo: null,
    naoEnfileirado: [],
    codigo: null,
    excerto: null,
  };
}

/* -------------------------------------------------------------------------- */
/*                                the slot                                     */
/* -------------------------------------------------------------------------- */

type Slot =
  | { readonly nfeId: string; readonly raw: Record<string, unknown> | null }
  | { readonly motivo: MotivoNfeShopee };

/**
 * The explicit `--nfe` document (raw `null` when absent — the handler answers
 * `nfe-nao-encontrada`), or the slot rule over the pedido's LISTED documents.
 */
async function resolverSlot(db: Firestore, pedidoId: string, nfeId: string | null): Promise<Slot> {
  if (nfeId !== null) {
    const snap = await nfev4Collection.docRef(db, { pedidoId }, nfeId).get();
    return {
      nfeId,
      raw: snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : null,
    };
  }
  const lista = await nfev4Collection.ref(db, { pedidoId }).get();
  const docs = lista.docs.map((doc) => ({
    id: doc.id,
    raw: (doc.data() ?? {}) as Record<string, unknown>,
  }));
  const escolha = escolherNfeParaEnvioShopee(docs);
  if (!('nfeId' in escolha)) return { motivo: escolha.motivo };
  return { nfeId: escolha.nfeId, raw: docs.find((d) => d.id === escolha.nfeId)?.raw ?? null };
}

/**
 * The slot's authorization instant, only when it is KNOWN.
 *
 * ⚠️ An unknown instant is not "now" here. `atrasoSerproS` reads it as the FULL
 * wait, which is right for a queue — it waits once, then sends — but a refusal
 * keyed on that answer would refuse the same slot on EVERY run, for ever, and
 * `data_autorizacao` is nullable both in the schema and in the legacy corpus the
 * cutover re-drive exists for. So the `--live` refusal, and the dry run's
 * "`--live` would refuse" note, need a known instant; without one the line's
 * wait prints `—` and the handler answers as it would from the queue.
 */
function autorizadaEmMs(raw: Record<string, unknown> | null): number | null {
  return raw === null ? null : coerceToMillis(raw.data_autorizacao);
}

/** The payload, BUILT BY NAME — the upload phase, every counter at zero. */
function tarefaDe(pedidoId: string, nfeId: string): TarefaNfeShopee {
  return {
    pedidoId,
    nfeId,
    fase: FASE_NFE_SHOPEE.envio,
    adiamentosSerpro: 0,
    pausas: 0,
    reverificacoes: 0,
  };
}

/* -------------------------------------------------------------------------- */
/*                                  the runs                                   */
/* -------------------------------------------------------------------------- */

/** What both modes receive from the script. */
interface DepsComunsNfeCli {
  readonly db: Firestore;
  /** The clock, read ONCE per pedido, in MILLISECONDS. */
  readonly agora: () => number;
  /** The pacing wait between two pedidos. */
  readonly esperar: (ms: number) => Promise<void>;
  /** The conta's SHOP client; absent ⇒ the handler's own default. */
  readonly resolveClient?: DepsNfeShopee['resolveClient'];
  /** Called as each pedido concludes — the script keeps them for a failure report. */
  readonly aoConcluir?: (linha: LinhaEnviarNfe) => void;
}

/** The dry run's deps: the simulation, and NOTHING that can write, upload or enqueue. */
export interface DepsEnsaioNfeCli extends DepsComunsNfeCli {
  readonly simular: (
    deps: Pick<DepsNfeShopee, 'db' | 'nowMs' | 'resolveClient'>,
    payload: unknown,
  ) => Promise<SimulacaoNfeShopee>;
}

/** The live run's deps: the handler and the increment sentinel. The scheduler is built HERE. */
export interface DepsEnvioNfeCli extends DepsComunsNfeCli {
  readonly processar: (
    deps: DepsNfeShopee,
    payload: unknown,
    retryCount: number,
  ) => Promise<ResultadoNfeShopee>;
  readonly increment: DepsNfeShopee['increment'];
}

export type ArgsDaExecucaoNfe = Pick<ArgsEnviarNfe, 'pedidoIds' | 'nfeId'>;

/**
 * The RECORDING scheduler: every enqueue the handler asks for is captured by
 * name (phase and delay) and never sent anywhere.
 */
export function criarAgendadorGravador(): {
  readonly agendador: AgendadorNfeShopee;
  readonly gravados: AgendamentoNaoFeito[];
} {
  const gravados: AgendamentoNaoFeito[] = [];
  const agendador: AgendadorNfeShopee = {
    enqueue: (payload, opts) => {
      gravados.push({ fase: payload.fase, atrasoS: opts?.scheduleDelaySeconds ?? null });
      return Promise.resolve();
    },
  };
  return { agendador, gravados };
}

/** Sequential, paced, one line per pedido in request order. */
async function paraCadaPedido(
  args: ArgsDaExecucaoNfe,
  deps: DepsComunsNfeCli,
  umPedido: (pedidoId: string) => Promise<LinhaEnviarNfe>,
): Promise<LinhaEnviarNfe[]> {
  const linhas: LinhaEnviarNfe[] = [];
  for (const [i, pedidoId] of args.pedidoIds.entries()) {
    if (i > 0) await deps.esperar(PAUSA_ENTRE_PEDIDOS_MS);
    const linha = await umPedido(pedidoId);
    linhas.push(linha);
    deps.aoConcluir?.(linha);
  }
  return linhas;
}

/**
 * **The dry run.** Per pedido: the slot, then `simularEnvioNfeShopee`. Writes
 * nothing and cannot: its deps hold no writer, no scheduler and no uploader.
 */
export async function ensaiarEnvioNfe(
  args: ArgsDaExecucaoNfe,
  deps: DepsEnsaioNfeCli,
): Promise<RelatorioEnviarNfe> {
  const linhas = await paraCadaPedido(args, deps, async (pedidoId) => {
    const slot = await resolverSlot(deps.db, pedidoId, args.nfeId);
    if ('motivo' in slot) {
      return linhaDaRecusa(pedidoId, null, DESFECHO_NFE_SHOPEE.descartado, slot.motivo);
    }
    const s = await deps.simular(
      { db: deps.db, nowMs: deps.agora(), resolveClient: deps.resolveClient },
      tarefaDe(pedidoId, slot.nfeId),
    );
    return {
      pedidoId,
      nfeId: slot.nfeId,
      desfecho: s.desfecho,
      motivo: s.motivo,
      mensagem: mensagemOuNull(s.motivo),
      chave: situacaoDaChave(s.notaNaShopee),
      statusDaNota: s.statusDaNota,
      bytesDoXml: s.bytesDoXml,
      // Unknown instant ⇒ `null`, never the simulation's full wait (see `autorizadaEmMs`).
      atrasoSerproS: autorizadaEmMs(slot.raw) === null ? null : s.atrasoSerproS,
      substituicao: s.substituicao,
      enviaria: s.enviaria,
      efeitos: {
        aviso: s.avisaria,
        carimbo: s.carimbaria,
        resolucao: s.resolveria,
        reverificacao: s.reverificaria,
      },
      carimbo: null,
      naoEnfileirado: [],
      codigo: s.codigo,
      excerto: excertoPermitido(s.motivo, s.excerto),
    };
  });
  return { live: false, nfeExplicita: args.nfeId, solicitados: args.pedidoIds.length, linhas };
}

/**
 * **The live run.** Per pedido: the slot, the SERPRO refusal, then
 * `processarNfeShopee` at attempt 0 with a FRESH recording scheduler. A transient
 * failure THROWS out of here (exit 1) — the lines already concluded reached
 * `deps.aoConcluir` first.
 */
export async function enviarNfeAoVivo(
  args: ArgsDaExecucaoNfe,
  deps: DepsEnvioNfeCli,
): Promise<RelatorioEnviarNfe> {
  const linhas = await paraCadaPedido(args, deps, async (pedidoId) => {
    const nowMs = deps.agora();
    const slot = await resolverSlot(deps.db, pedidoId, args.nfeId);
    if ('motivo' in slot) {
      return linhaDaRecusa(pedidoId, null, DESFECHO_NFE_SHOPEE.descartado, slot.motivo);
    }
    const bytesDoXml = bytesDoProc(slot.raw);
    // The wait is judged only for a slot the shared LEVEL predicate calls ready
    // and whose authorization instant is KNOWN; any other slot gets the handler's
    // own answer.
    const pronta =
      slot.raw !== null && decideNfeUploadDispatch(undefined, slot.raw).action === 'enqueue';
    const autorizadaMs = autorizadaEmMs(slot.raw);
    const espera = autorizadaMs === null ? null : atrasoSerproS(autorizadaMs, nowMs);
    if (pronta && espera !== null && espera > 0) {
      return linhaDaRecusa(
        pedidoId,
        slot.nfeId,
        DESFECHO_NFE_SHOPEE.adiado,
        MOTIVO_NFE_SHOPEE.aguardandoSerpro,
        { bytesDoXml, atrasoSerproS: espera },
      );
    }

    const gravador = criarAgendadorGravador();
    const r = await deps.processar(
      {
        db: deps.db,
        scheduler: gravador.agendador,
        nowMs,
        increment: deps.increment,
        // Nothing is enqueued, so a pause's jitter would only blur the printed delay.
        jitterSec: () => 0,
        resolveClient: deps.resolveClient,
      },
      tarefaDe(pedidoId, slot.nfeId),
      0,
    );
    const naoEnfileirado = [...gravador.gravados];
    return {
      pedidoId,
      nfeId: slot.nfeId,
      desfecho: r.desfecho,
      motivo: r.motivo,
      mensagem: mensagemOuNull(r.motivo),
      chave: null,
      statusDaNota: null,
      bytesDoXml,
      atrasoSerproS: espera,
      substituicao: r.substituicao,
      enviaria: null,
      efeitos: {
        aviso: r.avisado,
        carimbo: r.carimbo === 'carimbado',
        resolucao: r.resolvido,
        reverificacao: naoEnfileirado.some((a) => a.fase === FASE_NFE_SHOPEE.reverificacao),
      },
      carimbo: r.carimbo,
      naoEnfileirado,
      codigo: null,
      excerto: null,
    };
  });
  return { live: true, nfeExplicita: args.nfeId, solicitados: args.pedidoIds.length, linhas };
}

/* -------------------------------------------------------------------------- */
/*                                the renderers                                */
/* -------------------------------------------------------------------------- */

const TRACO = '—';

function rotulo(nome: string, valor: string): string {
  return `  ${nome.padEnd(20, '.')} ${valor}`;
}

/** What separates two adjacent cells of the table. Never empty. */
const ENTRE_COLUNAS = '  ';

/** A cell's width in CODE POINTS. */
function larguraDe(celula: string): number {
  return [...celula].length;
}

/**
 * This module's table layout: every column but the last padded to its widest
 * rendered cell, the last free text, the line right-trimmed. Sized from the
 * VALUES — a pedido id is a 64-hex digest. The stock and price CLIs each keep
 * their own private layout; this one is pinned by this module's own tests.
 */
function alinharTabela(recuo: string, linhas: readonly (readonly string[])[]): string[] {
  const larguras: number[] = [];
  for (const linha of linhas) {
    linha.forEach((celula, i) => {
      if (i < linha.length - 1) larguras[i] = Math.max(larguras[i] ?? 0, larguraDe(celula));
    });
  }
  return linhas.map((linha) => {
    const celulas = linha.map((celula, i) =>
      i < linha.length - 1 ? celula + ' '.repeat((larguras[i] ?? 0) - larguraDe(celula)) : celula,
    );
    return `${recuo}${celulas.join(ENTRE_COLUNAS)}`.trimEnd();
  });
}

const CABECALHO_DA_TABELA = ['pedido', 'nfe', 'desfecho', 'motivo', 'chave', 'bytes', 'serpro'];

function numeroOuTraco(n: number | null, sufixo = ''): string {
  return n === null ? TRACO : `${String(n)}${sufixo}`;
}

function celulasDaLinha(l: LinhaEnviarNfe): string[] {
  return [
    l.pedidoId,
    l.nfeId ?? TRACO,
    l.desfecho,
    l.motivo ?? TRACO,
    l.chave ?? TRACO,
    numeroOuTraco(l.bytesDoXml),
    numeroOuTraco(l.atrasoSerproS, ' s'),
  ];
}

function simNao(v: boolean): string {
  return v ? 'sim' : 'não';
}

function descreverAgendamento(a: AgendamentoNaoFeito): string {
  return `${a.fase} ${a.atrasoS === null ? 'imediata' : `em ${String(a.atrasoS)} s`}`;
}

/** One pedido's block — every value read off the line, nothing recomputed. */
export function renderizarLinhaEnviarNfe(
  l: LinhaEnviarNfe,
  indice: number,
  total: number,
  live: boolean,
): string[] {
  const linhas = [`### pedido ${String(indice + 1)}/${String(total)} — ${l.pedidoId}`];
  linhas.push(rotulo('nfe ', l.nfeId ?? `${TRACO} (nenhuma NF-e do pedido vai para a Shopee)`));
  linhas.push(
    rotulo(
      'desfecho ',
      l.motivo === null ? l.desfecho : `${l.desfecho} — ${l.motivo}: ${l.mensagem ?? ''}`,
    ),
  );
  linhas.push(
    rotulo(
      'nota na Shopee ',
      `chave: ${l.chave ?? TRACO}${l.statusDaNota === null ? '' : ` · status: ${l.statusDaNota}`}`,
    ),
  );
  linhas.push(
    rotulo(
      'XML ',
      l.bytesDoXml === null
        ? TRACO
        : `${String(l.bytesDoXml)} bytes (limite ${String(SHOPEE_UPLOAD_INVOICE_DOC_MAX_BYTES)})`,
    ),
  );
  // The dry run's note: an upload it WOULD send now is one `--live` refuses
  // until the wait is over (under `--live` the refusal is the line's own motivo).
  const recusariaPorSerpro = l.enviaria === true && (l.atrasoSerproS ?? 0) > 0;
  linhas.push(
    rotulo(
      'espera SERPRO ',
      l.atrasoSerproS === null
        ? TRACO
        : `${String(l.atrasoSerproS)} s${
            recusariaPorSerpro
              ? ` — o --live recusaria agora (${MOTIVO_NFE_SHOPEE.aguardandoSerpro}); rode depois`
              : ''
          }`,
    ),
  );
  if (l.enviaria !== null) linhas.push(rotulo('enviaria ', simNao(l.enviaria)));
  if (l.substituicao) {
    linhas.push(rotulo('substituição ', 'sim — a Shopee tem a chave de uma NF-e CANCELADA'));
  }
  linhas.push(
    rotulo(
      live ? 'efeitos ' : 'efeitos previstos ',
      `aviso: ${simNao(l.efeitos.aviso)} · frete com erro: ${simNao(l.efeitos.carimbo)} · ` +
        `aviso resolvido: ${simNao(l.efeitos.resolucao)} · reverificação: ${simNao(
          l.efeitos.reverificacao,
        )}`,
    ),
  );
  if (l.carimbo !== null) linhas.push(rotulo('carimbo do frete ', l.carimbo));
  if (l.codigo !== null) linhas.push(rotulo('código Shopee ', l.codigo));
  if (l.excerto !== null) linhas.push(rotulo('trecho da Shopee ', l.excerto));
  for (const a of l.naoEnfileirado) {
    linhas.push(
      rotulo(
        'NÃO enfileirado ',
        `${descreverAgendamento(a)} — a fila agendaria; rode enviar:nfe --live de novo depois`,
      ),
    );
  }
  return linhas;
}

/** Outcome → count, over EVERY outcome (zeros present: an absent key reads as an arm that never existed). */
function totaisPorDesfecho(r: RelatorioEnviarNfe): Record<DesfechoNfeShopee, number> {
  const totais = Object.fromEntries(
    Object.values(DESFECHO_NFE_SHOPEE).map((d) => [d, 0]),
  ) as Record<DesfechoNfeShopee, number>;
  for (const l of r.linhas) totais[l.desfecho] += 1;
  return totais;
}

/** The table report: header, the one-row-per-pedido table, then one block per pedido. */
export function renderizarRelatorioEnviarNfe(r: RelatorioEnviarNfe): string[] {
  const linhas: string[] = [
    r.live
      ? '== LIVE — o envio de verdade, nesta máquina; NADA foi enfileirado =='
      : '== DRY-RUN — nada foi enviado, gravado nem enfileirado ==',
    '',
    rotulo('solicitados ', String(r.solicitados)),
    rotulo(
      'nfe ',
      r.nfeExplicita === null ? 'regra de escolha, por pedido' : `${r.nfeExplicita} (--nfe)`,
    ),
  ];
  const totais = totaisPorDesfecho(r);
  for (const d of Object.values(DESFECHO_NFE_SHOPEE)) {
    if (totais[d] > 0) linhas.push(rotulo(`${d} `, String(totais[d])));
  }
  linhas.push('');
  linhas.push(`### pedidos (${String(r.linhas.length)})`);
  linhas.push(...alinharTabela('  ', [CABECALHO_DA_TABELA, ...r.linhas.map(celulasDaLinha)]));
  r.linhas.forEach((l, i) => {
    linhas.push('');
    linhas.push(...renderizarLinhaEnviarNfe(l, i, r.linhas.length, r.live));
  });
  return linhas;
}

/** The `--json` document. An ALLOW-LIST, built by name at every level. */
export function resumoDoEnvioNfe(r: RelatorioEnviarNfe): Record<string, unknown> {
  return {
    modo: r.live ? 'live' : 'dry-run',
    solicitados: r.solicitados,
    nfeExplicita: r.nfeExplicita,
    totais: totaisPorDesfecho(r),
    pedidos: r.linhas.map((l) => ({
      pedidoId: l.pedidoId,
      nfeId: l.nfeId,
      desfecho: l.desfecho,
      motivo: l.motivo,
      mensagem: l.mensagem,
      chave: l.chave,
      statusDaNota: l.statusDaNota,
      bytesDoXml: l.bytesDoXml,
      atrasoSerproS: l.atrasoSerproS,
      substituicao: l.substituicao,
      enviaria: l.enviaria,
      efeitos: {
        aviso: l.efeitos.aviso,
        carimbo: l.efeitos.carimbo,
        resolucao: l.efeitos.resolucao,
        reverificacao: l.efeitos.reverificacao,
      },
      carimbo: l.carimbo,
      naoEnfileirado: l.naoEnfileirado.map((a) => ({ fase: a.fase, atrasoS: a.atrasoS })),
      codigo: l.codigo,
      excerto: l.excerto,
    })),
  };
}

/** The whole `--json` stdout: ONE document, nothing before it. */
export function renderizarJsonEnviarNfe(r: RelatorioEnviarNfe): string {
  return JSON.stringify(resumoDoEnvioNfe(r), null, 2);
}

/* -------------------------------------------------------------------------- */
/*                                   errors                                    */
/* -------------------------------------------------------------------------- */

/** A Shopee error code as printable text — a token, never free text. */
const CODIGO_TOKEN = /^[a-z][a-z0-9_.]*$/i;

function codigoImprimivel(code: string): string {
  const aparado = code.trim();
  return CODIGO_TOKEN.test(aparado) ? aparado : '(não é um código)';
}

/**
 * One failure, by CLASS plus the fields that identify it.
 *
 * ⚠️ **Never a Shopee error's `message`.** The package carries Shopee's own
 * sentence into it on purpose, and a refusal of THIS upload may quote the key or
 * a party's document — so this describer prints the class, the kind, the code
 * (as a token), the HTTP status and the path, and nothing Shopee wrote. That is
 * why it does not delegate to the shared describer the other CLIs use.
 * `ShopeeConfigError` is ours (it names a variable) and prints its message.
 */
export function descreverErroEnviarNfe(err: unknown): string[] {
  if (err instanceof ArgumentoInvalidoError) {
    return [`❌ ${err.message}`, '', USO_ENVIAR_NFE];
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
      '   (a mensagem da Shopee não é impressa: ela pode citar a chave ou um documento)',
    ];
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
  if (err instanceof Error) return [`❌ ${err.name}`, `   ${err.message}`];
  return [`❌ erro não-Error (${typeof err})`];
}

/**
 * Whether a failure happened BEFORE anything could have been uploaded or written
 * — one predicate for the script's failure path and nothing else to disagree
 * with. Every other failure under `--live` may follow a landed upload.
 */
export function ehRecusaAntesDoEnvioNfe(err: unknown): boolean {
  return err instanceof ArgumentoInvalidoError;
}
