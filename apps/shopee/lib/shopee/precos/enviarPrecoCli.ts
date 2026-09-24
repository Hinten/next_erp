/**
 * The pure half of `scripts/enviar-precos.ts` (#1521, step 13) — argument
 * parsing, the DRY-RUN rehearsal, its renderers, the `--live` envelope
 * renderer, the conta-verdict renderer and the usage text.
 *
 * ⚠️ **It lives here rather than in the script because `scripts/` is outside
 * this app's vitest `include`** (`{app,lib,functions}/**\/*.test.ts`), so logic
 * written in a script file can never be tested — step 12's
 * `estoque/enviarEstoqueCli.ts` reasoning, and its shape. The script keeps the
 * I/O and nothing else.
 *
 * ⚠️ **Script-only, imported by no route, no job and no bundle.** Nothing here
 * reads an environment variable, opens a client, touches Firestore or reads a
 * clock. {@link ensaiarEnvioDePreco} is the one async function, and every read
 * it makes goes through a reader the SCRIPT injects — which is also this
 * folder's own discipline: the clock and the I/O are parameters under
 * `lib/shopee/precos/`.
 *
 * ## The two modes, and why the dry run cannot send by accident
 *
 * **`--dry-run` (the DEFAULT)** resolves each requested produto to its family
 * anchor, discovers the families, plans and prices every listing, reads each
 * one fresh (ONE batched `get_item_base_info` for the whole run, plus one
 * `get_model_list` per has-model listing) and asks `decidirEnvioDePreco` — the
 * SAME pure function the live sender obeys (contract S8) — what it would do.
 * It is structurally incapable of sending: this module imports the sender and
 * the manual run for their TYPES only (a test pins that over the raw text), and
 * the decision module imports neither the write op nor the link writer.
 *
 * **`--live`** calls `enviarPrecoManualShopee` — the route's own run, with the
 * conta context the verdict approved — and renders the envelope it answers.
 *
 * ⚠️ **A dry run is NOT a cheaper `--live`.** The gate ladder runs in both
 * modes, but a promotion lock, the category band, the per-model `failure_list`
 * and the echo check only exist once Shopee has been asked. A clean rehearsal is
 * "nothing we can see refuses this", never "this will land".
 *
 * ## ⚠️ The dry run's rungs around the decision are the sender's, and a test holds them together
 *
 * Two rungs sit OUTSIDE `decidirEnvioDePreco` in the live path: G0 (no model has
 * a target price ⇒ nothing is read) and G1 (the listing is absent from the base
 * read ⇒ `anuncio-inexistente`). The child → anchor resolution and the
 * `produtosSemEnvio` rules sit in the manual run. None of them can be imported
 * on the dry path without importing the sender, so they are re-stated here —
 * and `enviarPrecoCli.test.ts` runs the REAL live run (real sender, a double
 * client) and this rehearsal over the SAME inputs and requires the same row
 * set. A comment claiming the two agree is the smell the root `CLAUDE.md`
 * names; that test is the thing that can actually disagree.
 *
 * ## What it prints, and what it must never print
 *
 * Every builder below is an ALLOW-LIST: no input object is ever copied, each
 * field is named and constructed one at a time. Never printed: a token, the
 * partner id or key, a raw Shopee body, a buyer datum, and the listing's
 * `item_name`. The produto's own NAME is printed — it is the one thing that lets
 * a human tell one row from another. Shopee's refusal `codigo` is printed
 * verbatim (it is a catalogue value); every sentence beside it is
 * `mensagemDoMotivoDePreco`'s, i.e. ours.
 *
 * Prices are printed through ONE formatter, `pt-BR` with exactly two decimals
 * and NO currency symbol: the conta's currency is printed once in the header,
 * because on the SG sandbox shop it is `SGD` and an `R$` beside a Singapore
 * dollar figure is exactly the confusion this sync is built against.
 *
 * Every table goes through ONE layout, {@link alinharTabela} — this module's
 * own widest-cell layout, the same approach as the stock CLI's (whose function
 * is private to that module): each column is sized from the cells it actually
 * renders, because a Shopee-imported produto's id is 64 hex characters and no
 * fixed width chosen for a short id survives it.
 *
 * Ver apps/shopee/scripts/README.md §14.
 */
import { ENVIO_PRECO_RESULTADO } from '@delfrance/schemas';

import { naoDocId } from '../anuncios/corpoPublicacao';
import { ArgumentoInvalidoError, descreverErro } from '../pedidos/importarPedidoCli';
import { SHOPEE_ENVIO_PRECO_MAX_PRODUTOS } from './constantesPreco';
import { decidirEnvioDePreco, type LinhaModeloPreco } from './decisaoPreco';
import type {
  EnvioPrecoListing,
  EnvioPrecoResponse,
  EnvioPrecoSemEnvio,
} from './enviarPrecoManual';
import {
  CODIGO_GUARDA_PRECO,
  MOTIVO_PRECO_SHOPEE,
  STATUS_POR_CODIGO_DE_GUARDA_PRECO,
  ShopeeEnvioPrecoGuardError,
  mensagemDoMotivoDePreco,
  type CodigoGuardaPreco,
  type MotivoPrecoShopee,
} from './errosPreco';
import type { LeituraDePreco } from './leituraPreco';
import {
  montarItensDePreco,
  precificarItem,
  precosDaFamilia,
  type FamiliaDePreco,
  type ItemDePreco,
} from './planoPreco';
import type { ContextoContaPreco, VereditoContaPreco } from './regiaoPreco';

export { ArgumentoInvalidoError };

/* -------------------------------------------------------------------------- */
/*                                  arguments                                  */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ No `--` separator in any documented invocation: pnpm forwards the literal
 * token INTO the script and every CLI in this repo parses its own argv, so the
 * separator would be read as an argument.
 * `packages/config-eslint/rules/pnpm-run-args.test.js` fails CI on the spelling
 * that carries one — including inside this string.
 *
 * ⚠️ It names no shop, no partner id and no credential. The store this run
 * signs for is read from the integração document at runtime and printed by the
 * script's preamble.
 */
export const USO_ENVIAR_PRECOS = `
Envia o preço ATUAL da tabela normal de produtos escolhidos a mão para os anúncios da Shopee.

  pnpm --filter @delfrance/shopee-app enviar:precos \\
    --integracao <integracaoId> --produto <produtoId> [--produto <produtoId> ...]

Obrigatórios
  --integracao <id>    documento da integração Shopee (ex.: int-1)
  --produto <id>       um produto da família — a âncora ou uma variação (a
                       variação resolve para a sua âncora). REPITA a flag para
                       cada produto: não existe lista separada por vírgula,
                       porque a vírgula é um caractere legal num id de documento.

Opções
  --baixar-preco       AUTORIZA reduzir o preço. Sem ela, um preço menor que o
                       atual (ou um preço atual ilegível) NÃO é enviado.
  --dry-run            lê, decide e imprime, sem enviar nada. É o PADRÃO.
  --live               ENVIA DE VERDADE o preço e grava os vínculos.
  --project <id>       sobrescreve FIREBASE_PROJECT_ID antes de abrir o admin.
  --json               imprime o mesmo resumo redigido em JSON no stdout
                       (o cabeçalho vai para o stderr).
  --help, -h           mostra esta ajuda e sai com 0, sem abrir o Firestore
                       nem chamar a Shopee.

No máximo ${String(SHOPEE_ENVIO_PRECO_MAX_PRODUTOS)} produtos por execução, contados DEPOIS de tirar os repetidos.

O dry-run lê o Firestore e CHAMA a Shopee (get_shop_info, get_item_base_info em
lote e get_model_list por anúncio com variações) — ele não escreve no Firestore
e não chega ao remetente: o caminho do ensaio não tem nenhum.
Uma conta que o ERP não precifica (loja fora do Brasil, cross-border, banida,
sem tabela normal, sem credencial) é RECUSADA antes de qualquer anúncio, nos
dois modos: o comando imprime a recusa e sai com 0, igual à resposta da rota.
Uma recusa POR ANÚNCIO é uma RESPOSTA, não uma falha da execução: mesmo com todos
os anúncios recusados o comando sai com 0. Só um erro que derruba a execução
inteira sai com 1.
Ver apps/shopee/scripts/README.md.
`.trim();

export interface ArgsEnviarPrecos {
  readonly integracaoId: string;
  /** DEDUPED, in the order the flags were given. Never empty. */
  readonly produtoIds: readonly string[];
  /** `true` ⇒ the decrease guard is OFF. Absent ⇒ `false`, the route's default. */
  readonly baixarPreco: boolean;
  /** `false` — the DRY-RUN default. `--live` is the only way to send. */
  readonly live: boolean;
  readonly json: boolean;
  /** `null` keeps whatever the environment resolves. */
  readonly projectId: string | null;
}

export type ComandoEnviarPrecos =
  | { readonly kind: 'ajuda' }
  | { readonly kind: 'enviar'; readonly args: ArgsEnviarPrecos };

/** `--produto` was never given. */
export const MSG_PRODUTO_OBRIGATORIO =
  '--produto <produtoId> é obrigatório (repita a flag para enviar vários).';

/** More produtos than one run may carry, counted AFTER deduplication. */
export const MSG_EXCEDE_LIMITE = `--produto foi passado mais de ${String(
  SHOPEE_ENVIO_PRECO_MAX_PRODUTOS,
)} vezes (sem contar repetidos). Divida em execuções menores.`;

function valorDe(nome: string, inline: string | undefined, proximo: string | undefined): string {
  const bruto = (inline ?? proximo)?.trim();
  if (bruto == null || bruto.length === 0 || bruto.startsWith('--')) {
    throw new ArgumentoInvalidoError(`--${nome} exige um valor.`);
  }
  return bruto;
}

/**
 * A doc id: trimmed, then checked with {@link naoDocId} — the SAME predicate the
 * `enviar-precos` route reads its body with, imported rather than re-spelled
 * (step 11's lesson: a local copy refused `''` and `/` but not `..`, which
 * `.doc('..')` RESOLVES instead of refusing).
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
 * A switch takes no value. ⚠️ Refused rather than ignored: `--baixar-preco=false`
 * read as "the flag is present" would AUTHORISE the one thing its author meant to
 * forbid, and `--live=0` would send.
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
 * ⚠️ `--help` is answered BEFORE anything is validated, so `--help` on its own
 * exits 0 instead of complaining about the two required flags.
 *
 * ⚠️ **Dry-run is the default and `--live` is the only opt-in.** Passing both
 * is a contradiction and is REFUSED rather than resolved by precedence: here the
 * wrong reading writes a price to a real marketplace.
 *
 * ⚠️ `--produto` is REPEATABLE and there is no comma-separated form, because a
 * comma is a legal character in a Firestore document id.
 */
export function lerArgsEnviarPrecos(argv: readonly string[]): ComandoEnviarPrecos {
  if (argv.some((a) => a === '--help' || a === '-h')) return { kind: 'ajuda' };

  let integracaoId: string | undefined;
  let projectId: string | undefined;
  const produtoIds: string[] = [];
  const vistos = new Set<string>();
  let baixarPreco = false;
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
      case '--integracao':
        integracaoId = docIdDe('integracao', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--produto': {
        const produtoId = docIdDe('produto', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        // DEDUPED here, in flag order — the route dedupes the same way, and
        // the envelope's accounting is a set equality against this list.
        if (!vistos.has(produtoId)) {
          vistos.add(produtoId);
          produtoIds.push(produtoId);
        }
        break;
      }
      case '--project':
        projectId = valorDe('project', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--baixar-preco':
        baixarPreco = semValor(nome, inline);
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
  if (integracaoId == null) {
    throw new ArgumentoInvalidoError('--integracao <integracaoId> é obrigatório.');
  }
  if (produtoIds.length === 0) throw new ArgumentoInvalidoError(MSG_PRODUTO_OBRIGATORIO);
  // ⚠️ REFUSED with the CLI's own argument error, never truncated and never left
  // to the run: above the cap `enviarPrecoManualShopee` raises a config-class
  // error — the wrong sentence for a human who typed one flag too many.
  if (produtoIds.length > SHOPEE_ENVIO_PRECO_MAX_PRODUTOS) {
    throw new ArgumentoInvalidoError(MSG_EXCEDE_LIMITE);
  }

  return {
    kind: 'enviar',
    args: { integracaoId, produtoIds, baixarPreco, live, json, projectId: projectId ?? null },
  };
}

/* -------------------------------------------------------------------------- */
/*                                 the dry run                                 */
/* -------------------------------------------------------------------------- */

/** What the live run WOULD do with one model — the sender's three row outcomes, in the conditional. */
export type DecisaoDoEnsaio = 'enviaria' | 'pularia' | 'recusaria';

export const DECISAO_DO_ENSAIO = {
  enviaria: 'enviaria',
  pularia: 'pularia',
  recusaria: 'recusaria',
} as const satisfies Record<string, DecisaoDoEnsaio>;

/** The row outcome → its conditional. TOTAL over the three row outcomes. */
const DECISAO_POR_RESULTADO: Readonly<Record<LinhaModeloPreco['resultado'], DecisaoDoEnsaio>> = {
  [ENVIO_PRECO_RESULTADO.enviado]: DECISAO_DO_ENSAIO.enviaria,
  [ENVIO_PRECO_RESULTADO.pulado]: DECISAO_DO_ENSAIO.pularia,
  [ENVIO_PRECO_RESULTADO.falha]: DECISAO_DO_ENSAIO.recusaria,
};

/** One model of one listing the rehearsal read. */
export interface ModeloDoEnsaio {
  /** `0` is the NO-MODEL listing's single entry — a real value, never "absent". */
  readonly modelId: number;
  /** The CHILD whose price this model carries; `null` on a no-model listing. */
  readonly variacaoProdutoId: string | null;
  /** Shopee's shelf price now, as the fresh read saw it; `null` when unreadable, absent or never read. */
  readonly precoAnterior: number | null;
  /** The tabela price the ERP would send; `null` when the tabela has none. */
  readonly precoAlvo: number | null;
  readonly decisao: DecisaoDoEnsaio;
  /** `null` exactly on an `enviaria` row. */
  readonly motivo: MotivoPrecoShopee | null;
  /** RENDERED pt-BR; `null` on an `enviaria` row (the clean sentence is past tense, and nothing was sent). */
  readonly mensagem: string | null;
}

/** One listing the rehearsal read and decided. */
export interface AnuncioDoEnsaio {
  /** The family ANCHOR. */
  readonly produtoId: string;
  readonly produtoNome: string | null;
  readonly anuncioId: string;
  readonly linkDocId: string;
  readonly semModelos: boolean;
  /** The item's verdict. */
  readonly decisao: DecisaoDoEnsaio;
  /** The item's motivo; `null` on `enviaria`. */
  readonly motivo: MotivoPrecoShopee | null;
  readonly mensagem: string | null;
  /** How many models the ONE `update_price` would carry (the body is the diff). */
  readonly modelosNoCorpo: number;
  readonly modelos: readonly ModeloDoEnsaio[];
}

/** A listing (or family) the PLAN refuses before any read. */
export interface PuloDoEnsaio {
  readonly produtoId: string;
  readonly produtoNome: string | null;
  readonly anuncioId: string | null;
  readonly linkDocId: string | null;
  /** How many models the line folds; `0` for a listing-level line. */
  readonly modelos: number;
  readonly motivo: MotivoPrecoShopee;
  readonly mensagem: string;
}

/** A requested produto that reaches no listing at all. */
export interface SemEnvioDoEnsaio {
  /** The REQUESTED id, verbatim — a child stays a child here. */
  readonly produtoId: string;
  readonly produtoNome: string | null;
  readonly motivo: MotivoPrecoShopee;
  readonly mensagem: string;
}

export interface EnsaioDePreco {
  readonly integracaoId: string;
  readonly regiao: string;
  readonly moeda: string;
  readonly multiplo: number;
  readonly baixarPreco: boolean;
  /** The DEDUPED request size. */
  readonly solicitados: number;
  /** Distinct family anchors discovery returned. */
  readonly familias: number;
  readonly anuncios: readonly AnuncioDoEnsaio[];
  readonly pulos: readonly PuloDoEnsaio[];
  readonly produtosSemEnvio: readonly SemEnvioDoEnsaio[];
  /** MODEL rows per decision, over {@link anuncios}. */
  readonly totais: {
    readonly enviaria: number;
    readonly pularia: number;
    readonly recusaria: number;
  };
}

/** A fresh read, as the rehearsal needs it — `lerItemParaPreco`'s answer fits it. */
export type LeituraDoEnsaio =
  | { readonly ausente: true }
  | { readonly ausente: false; readonly leitura: LeituraDePreco };

/**
 * The three reads the rehearsal needs, INJECTED by the script — which is what
 * keeps this module free of Firestore and of a client.
 */
export interface LeitoresDoEnsaio {
  /** The produtos by id, masked to `campos`; an absent id is absent from the map. */
  readonly lerProdutos: (
    ids: readonly string[],
    campos: readonly string[],
  ) => Promise<ReadonlyMap<string, Readonly<Record<string, unknown>> | undefined>>;
  /** `lerFamiliasDePrecoPorIds`, bound to the database. */
  readonly lerFamilias: (
    anchorIds: readonly string[],
  ) => Promise<ReadonlyMap<string, FamiliaDePreco>>;
  /**
   * Built ONCE, over every planned item, before the first read — the batched
   * base reader's contract (one `get_item_base_info` per 50 listings, not one
   * per listing). Never called when nothing was planned.
   */
  readonly criarLeitorDeItens: (
    itemIds: readonly number[],
  ) => (itemId: number) => Promise<LeituraDoEnsaio>;
}

export interface ArgsDoEnsaio {
  readonly integracaoId: string;
  readonly produtoIds: readonly string[];
  readonly baixarPreco: boolean;
}

/** What the rehearsal needs from the conta the verdict approved. */
export type ContaDoEnsaio = Pick<
  ContextoContaPreco,
  'regiao' | 'moeda' | 'multiplo' | 'tabelaNormalId'
>;

/** A stored `nome`, when usable. */
function nomeDe(dados: Readonly<Record<string, unknown>> | undefined): string | null {
  const nome = dados?.['nome'];
  return typeof nome === 'string' && nome.trim() !== '' ? nome : null;
}

/** A stored `paiId`, when it names a document — the route's own id rule. */
function paiDe(dados: Readonly<Record<string, unknown>> | undefined): string | null {
  const pai = dados?.['paiId'];
  return naoDocId(pai) ? null : (pai as string);
}

function mensagemOuNull(motivo: MotivoPrecoShopee | null): string | null {
  return motivo === null ? null : mensagemDoMotivoDePreco(motivo);
}

function modeloDaLinha(item: ItemDePreco, linha: LinhaModeloPreco): ModeloDoEnsaio {
  return {
    modelId: linha.modelId,
    variacaoProdutoId: linha.produtoId === item.produtoId ? null : linha.produtoId,
    precoAnterior: linha.precoAnterior,
    precoAlvo: linha.precoAlvo,
    decisao: DECISAO_POR_RESULTADO[linha.resultado],
    motivo: linha.motivo,
    mensagem: mensagemOuNull(linha.motivo),
  };
}

/** Every alvo, one row each, with one outcome — the sender's G0/G1 row shape. */
function todasAsLinhas(
  item: ItemDePreco,
  decisao: DecisaoDoEnsaio,
  motivo: MotivoPrecoShopee,
): ModeloDoEnsaio[] {
  return item.alvos.map((alvo) => ({
    modelId: alvo.modelId,
    variacaoProdutoId: alvo.produtoId === item.produtoId ? null : alvo.produtoId,
    precoAnterior: null,
    precoAlvo: alvo.precoAlvo,
    decisao,
    motivo,
    mensagem: mensagemDoMotivoDePreco(motivo),
  }));
}

/**
 * ONE item's rehearsal verdict — PURE. `leitura` is `null` exactly when G0
 * fired and nothing was read.
 *
 * G0 and G1 are the sender's own rungs (see the module header for why they are
 * re-stated here and what holds them to the sender); G2–G8 are
 * `decidirEnvioDePreco`, called, never re-derived.
 */
export function decidirItemDoEnsaio(
  item: ItemDePreco,
  leitura: LeituraDoEnsaio | null,
  conta: Pick<ContaDoEnsaio, 'moeda' | 'multiplo'>,
  produtoNome: string | null,
  baixarPreco: boolean,
): AnuncioDoEnsaio {
  const base = {
    produtoId: item.produtoId,
    produtoNome,
    anuncioId: String(item.itemId),
    linkDocId: item.linkDocId,
    semModelos: item.semModelos,
  };

  // G0 — nothing priced ⇒ nothing read.
  if (leitura === null || !item.alvos.some((alvo) => alvo.precoAlvo !== null)) {
    const motivo = MOTIVO_PRECO_SHOPEE.precoNaoEncontrado;
    return {
      ...base,
      decisao: DECISAO_DO_ENSAIO.pularia,
      motivo,
      mensagem: mensagemDoMotivoDePreco(motivo),
      modelosNoCorpo: 0,
      modelos: todasAsLinhas(item, DECISAO_DO_ENSAIO.pularia, motivo),
    };
  }

  // G1 — absent from the base read.
  if (leitura.ausente) {
    const motivo = MOTIVO_PRECO_SHOPEE.anuncioInexistente;
    return {
      ...base,
      decisao: DECISAO_DO_ENSAIO.recusaria,
      motivo,
      mensagem: mensagemDoMotivoDePreco(motivo),
      modelosNoCorpo: 0,
      modelos: todasAsLinhas(item, DECISAO_DO_ENSAIO.recusaria, motivo),
    };
  }

  // G2–G8 — the live sender's own decision (S8).
  const decisao = decidirEnvioDePreco(
    item,
    leitura.leitura,
    { moeda: conta.moeda, multiplo: conta.multiplo },
    { baixarPreco },
  );
  const modelos = decisao.linhas.map((linha) => modeloDaLinha(item, linha));
  if (decisao.tipo === 'enviar') {
    return {
      ...base,
      decisao: DECISAO_DO_ENSAIO.enviaria,
      motivo: null,
      mensagem: null,
      modelosNoCorpo: decisao.priceList.length,
      modelos,
    };
  }
  return {
    ...base,
    decisao: decisao.tipo === 'pular' ? DECISAO_DO_ENSAIO.pularia : DECISAO_DO_ENSAIO.recusaria,
    motivo: decisao.motivo,
    mensagem: mensagemDoMotivoDePreco(decisao.motivo),
    modelosNoCorpo: 0,
    modelos,
  };
}

/** One planned item waiting for its read, in the rehearsal's order. */
interface ItemPendente {
  readonly item: ItemDePreco;
  readonly produtoNome: string | null;
}

/**
 * **The dry run.** Resolve → discover → plan and price → ONE batched base
 * reader → read each listing in order → decide. It WRITES nothing and cannot:
 * its only effects are the three injected reads.
 *
 * The listings are read one after another, never in parallel — a rehearsal
 * spends the same per-APPLICATION quota as the live sync, and nothing here is
 * racing a deadline.
 */
export async function ensaiarEnvioDePreco(
  args: ArgsDoEnsaio,
  conta: ContaDoEnsaio,
  leitores: LeitoresDoEnsaio,
): Promise<EnsaioDePreco> {
  const solicitados = [...new Set(args.produtoIds)];
  const semEnvioPorId = new Map<string, SemEnvioDoEnsaio>();

  const pedidos =
    solicitados.length === 0
      ? new Map<string, Readonly<Record<string, unknown>> | undefined>()
      : await leitores.lerProdutos(solicitados, ['nome', 'paiId']);
  const semEnvio = (id: string, motivo: MotivoPrecoShopee): void => {
    semEnvioPorId.set(id, {
      produtoId: id,
      produtoNome: nomeDe(pedidos.get(id)),
      motivo,
      mensagem: mensagemDoMotivoDePreco(motivo),
    });
  };

  // A requested CHILD resolves to its ANCHOR; anchors deduplicated AFTER
  // resolution, in first-seen request order.
  const anchorDe = new Map<string, string>();
  const anchors: string[] = [];
  for (const id of solicitados) {
    if (!pedidos.has(id)) {
      semEnvio(id, MOTIVO_PRECO_SHOPEE.produtoNaoEncontrado);
      continue;
    }
    const anchor = paiDe(pedidos.get(id)) ?? id;
    anchorDe.set(id, anchor);
    if (!anchors.includes(anchor)) anchors.push(anchor);
  }

  const naoPedidos = anchors.filter((a) => !pedidos.has(a));
  const nomesDeAnchors =
    naoPedidos.length === 0
      ? new Map<string, Readonly<Record<string, unknown>> | undefined>()
      : await leitores.lerProdutos(naoPedidos, ['nome']);
  const nomeDoAnchor = (anchor: string): string | null =>
    nomeDe(pedidos.get(anchor) ?? nomesDeAnchors.get(anchor));

  const familias =
    anchors.length === 0 ? new Map<string, FamiliaDePreco>() : await leitores.lerFamilias(anchors);
  const pedidosDoAnchor = (anchor: string): string[] =>
    solicitados.filter((id) => anchorDe.get(id) === anchor);

  const pulos: PuloDoEnsaio[] = [];
  const pendentes: ItemPendente[] = [];
  for (const anchor of anchors) {
    const familia = familias.get(anchor);
    if (familia === undefined) {
      for (const id of pedidosDoAnchor(anchor)) {
        semEnvio(id, MOTIVO_PRECO_SHOPEE.produtoNaoEncontrado);
      }
      continue;
    }
    const plano = montarItensDePreco(familia, args.integracaoId);
    const semListagem =
      plano.itens.length === 0 &&
      plano.pulos.length > 0 &&
      plano.pulos.every((p) => p.motivo === MOTIVO_PRECO_SHOPEE.semLink);
    if (semListagem) {
      for (const id of pedidosDoAnchor(anchor)) semEnvio(id, MOTIVO_PRECO_SHOPEE.semLink);
      continue;
    }
    const nome = nomeDoAnchor(anchor);
    for (const pulo of plano.pulos) {
      pulos.push({
        produtoId: pulo.produtoId,
        produtoNome: nome,
        anuncioId: pulo.itemId === null ? null : String(pulo.itemId),
        linkDocId: pulo.linkDocId,
        modelos: pulo.modelos.length,
        motivo: pulo.motivo,
        mensagem: mensagemDoMotivoDePreco(pulo.motivo),
      });
    }
    const precos = precosDaFamilia(familia);
    for (const planejado of plano.itens) {
      pendentes.push({
        item: precificarItem(planejado, precos, conta.tabelaNormalId),
        produtoNome: nome,
      });
    }
  }

  // ONE reader over EVERY planned item, built before the first read.
  const lerItem =
    pendentes.length === 0
      ? null
      : leitores.criarLeitorDeItens(pendentes.map((p) => p.item.itemId));
  const anuncios: AnuncioDoEnsaio[] = [];
  for (const { item, produtoNome } of pendentes) {
    // G0 before the read: an unpriced listing costs no call.
    const leitura =
      lerItem === null || !item.alvos.some((alvo) => alvo.precoAlvo !== null)
        ? null
        : await lerItem(item.itemId);
    anuncios.push(decidirItemDoEnsaio(item, leitura, conta, produtoNome, args.baixarPreco));
  }

  const contar = (d: DecisaoDoEnsaio): number =>
    anuncios.reduce((soma, a) => soma + a.modelos.filter((m) => m.decisao === d).length, 0);

  return {
    integracaoId: args.integracaoId,
    regiao: conta.regiao,
    moeda: conta.moeda,
    multiplo: conta.multiplo,
    baixarPreco: args.baixarPreco,
    solicitados: solicitados.length,
    familias: familias.size,
    anuncios,
    pulos,
    produtosSemEnvio: solicitados.flatMap((id) => {
      const s = semEnvioPorId.get(id);
      return s === undefined ? [] : [s];
    }),
    totais: {
      enviaria: contar(DECISAO_DO_ENSAIO.enviaria),
      pularia: contar(DECISAO_DO_ENSAIO.pularia),
      recusaria: contar(DECISAO_DO_ENSAIO.recusaria),
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                                the renderers                                */
/* -------------------------------------------------------------------------- */

const TRACO = '—';

/**
 * The ONE price formatter: `pt-BR`, exactly two decimals, NO currency symbol
 * (the header names the currency once — see the module header). `null` ⇒ `—`.
 */
const FORMATO_PRECO = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatarPreco(valor: number | null): string {
  return valor === null ? TRACO : FORMATO_PRECO.format(valor);
}

function rotulo(nome: string, valor: string): string {
  return `  ${nome.padEnd(20, '.')} ${valor}`;
}

/** What separates two adjacent cells of every table below. Never empty. */
const ENTRE_COLUNAS = '  ';

/** A cell's width in CODE POINTS, so a name outside the BMP is not counted twice. */
function larguraDe(celula: string): number {
  return [...celula].length;
}

/**
 * The ONE layout every table here goes through: each column but the last is
 * padded to the widest cell actually rendered in it (a header row counts like
 * any other), adjacent cells are separated by {@link ENTRE_COLUNAS}, the last
 * column is free text and never padded, and the line is right-trimmed.
 *
 * ⚠️ Sized from the VALUES, never from a fixed width — a step-9 produto id is
 * 64 hex characters. This is the stock CLI's approach written again for this
 * module (that function is private to its own), not a copy that claims to
 * agree with it: each module's tests pin its own tables.
 *
 * Layout only: it prints exactly the cells it is handed, so the allow-list of
 * what may be printed stays with the callers that build those cells.
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

/** The header row of every model table: `anterior · alvo · decisão · motivo`. */
const CABECALHO_DO_MODELO = ['model_id', 'variação', 'anterior', 'alvo', 'decisão', 'motivo'];

function celulasDoModeloDoEnsaio(m: ModeloDoEnsaio): string[] {
  return [
    String(m.modelId),
    m.variacaoProdutoId ?? TRACO,
    formatarPreco(m.precoAnterior),
    formatarPreco(m.precoAlvo),
    m.decisao,
    m.motivo ?? TRACO,
  ];
}

/** The dry-run report. Every value is read off the rehearsal — nothing is recomputed. */
export function renderizarEnsaio(ensaio: EnsaioDePreco): string[] {
  const linhas: string[] = [
    rotulo('integração ', ensaio.integracaoId),
    rotulo('região ', ensaio.regiao),
    rotulo('moeda ', `${ensaio.moeda} (todos os preços abaixo nesta moeda)`),
    rotulo('razão máxima ', `${String(ensaio.multiplo)}× entre variações de um anúncio`),
    rotulo('baixar preço ', ensaio.baixarPreco ? 'AUTORIZADO' : 'não — um preço menor é pulado'),
    rotulo('solicitados ', String(ensaio.solicitados)),
    rotulo('famílias lidas ', String(ensaio.familias)),
    rotulo('anúncios lidos ', String(ensaio.anuncios.length)),
    rotulo('enviaria ', `${String(ensaio.totais.enviaria)} modelo(s)`),
    rotulo('pularia ', `${String(ensaio.totais.pularia)} modelo(s)`),
    rotulo('recusaria ', `${String(ensaio.totais.recusaria)} modelo(s)`),
    '',
  ];

  if (ensaio.anuncios.length === 0) linhas.push('### anúncios: NENHUM — nada seria enviado');
  ensaio.anuncios.forEach((a, i) => {
    linhas.push(`### anúncio ${String(i + 1)}/${String(ensaio.anuncios.length)} — ${a.produtoId}`);
    linhas.push(rotulo('produto ', `${a.produtoId} (${a.produtoNome ?? 'sem nome'})`));
    linhas.push(rotulo('anúncio ', a.anuncioId));
    linhas.push(rotulo('vínculo ', a.linkDocId));
    linhas.push(rotulo('variações ', a.semModelos ? 'não (anúncio simples)' : 'sim'));
    linhas.push(
      rotulo(
        'decisão ',
        a.motivo === null
          ? `${a.decisao} — ${String(a.modelosNoCorpo)} modelo(s) no update_price`
          : `${a.decisao} — ${a.motivo}: ${a.mensagem ?? ''}`,
      ),
    );
    linhas.push(`  modelos (${String(a.modelos.length)}):`);
    linhas.push(
      ...alinharTabela('    ', [CABECALHO_DO_MODELO, ...a.modelos.map(celulasDoModeloDoEnsaio)]),
    );
    linhas.push('');
  });

  linhas.push(
    ensaio.pulos.length === 0
      ? '### pulos do plano: NENHUM'
      : `### pulos do plano (${String(ensaio.pulos.length)}) — não seriam lidos nem enviados`,
  );
  linhas.push(
    ...alinharTabela(
      '  ',
      ensaio.pulos.map((p) => [
        p.produtoId,
        p.anuncioId ?? TRACO,
        p.motivo,
        `${p.mensagem}${p.modelos === 0 ? '' : ` modelos=${String(p.modelos)}`}`,
      ]),
    ),
  );
  linhas.push('');
  linhas.push(
    ensaio.produtosSemEnvio.length === 0
      ? '### produtos sem envio: NENHUM'
      : `### produtos sem envio (${String(ensaio.produtosSemEnvio.length)})`,
  );
  linhas.push(
    ...alinharTabela(
      '  ',
      ensaio.produtosSemEnvio.map((p) => [
        p.produtoId,
        p.produtoNome ?? 'sem nome',
        p.motivo,
        p.mensagem,
      ]),
    ),
  );
  return linhas;
}

/** The `--json` document for a dry run. An ALLOW-LIST, built by name at every level. */
export function resumoDoEnsaio(ensaio: EnsaioDePreco): Record<string, unknown> {
  return {
    integracaoId: ensaio.integracaoId,
    regiao: ensaio.regiao,
    moeda: ensaio.moeda,
    multiplo: ensaio.multiplo,
    baixarPreco: ensaio.baixarPreco,
    solicitados: ensaio.solicitados,
    familias: ensaio.familias,
    totais: {
      enviaria: ensaio.totais.enviaria,
      pularia: ensaio.totais.pularia,
      recusaria: ensaio.totais.recusaria,
    },
    anuncios: ensaio.anuncios.map((a) => ({
      produtoId: a.produtoId,
      produtoNome: a.produtoNome,
      anuncioId: a.anuncioId,
      linkDocId: a.linkDocId,
      semModelos: a.semModelos,
      decisao: a.decisao,
      motivo: a.motivo,
      mensagem: a.mensagem,
      modelosNoCorpo: a.modelosNoCorpo,
      modelos: a.modelos.map((m) => ({
        modelId: m.modelId,
        variacaoProdutoId: m.variacaoProdutoId,
        precoAnterior: m.precoAnterior,
        precoAlvo: m.precoAlvo,
        decisao: m.decisao,
        motivo: m.motivo,
        mensagem: m.mensagem,
      })),
    })),
    pulos: ensaio.pulos.map((p) => ({
      produtoId: p.produtoId,
      produtoNome: p.produtoNome,
      anuncioId: p.anuncioId,
      linkDocId: p.linkDocId,
      modelos: p.modelos,
      motivo: p.motivo,
      mensagem: p.mensagem,
    })),
    produtosSemEnvio: ensaio.produtosSemEnvio.map((p) => ({
      produtoId: p.produtoId,
      produtoNome: p.produtoNome,
      motivo: p.motivo,
      mensagem: p.mensagem,
    })),
  };
}

/**
 * The cells of one `--live` row — ONE MODEL. The last cell is free text:
 * Shopee's verbatim code (when it answered one) and the rendered sentence.
 */
function celulasDaLinhaEnviada(l: EnvioPrecoListing): string[] {
  return [
    l.produtoId,
    l.produtoNome ?? 'sem nome',
    l.anuncioId ?? TRACO,
    l.variacaoProdutoId ?? TRACO,
    l.outcome,
    formatarPreco(l.precoAnterior),
    formatarPreco(l.preco),
    l.motivo ?? 'limpo',
    l.codigo === null ? l.mensagem : `[${l.codigo}] ${l.mensagem}`,
  ];
}

const CABECALHO_DA_LINHA_ENVIADA = [
  'produto',
  'nome',
  'anúncio',
  'variação',
  'resultado',
  'anterior',
  'enviado',
  'motivo',
  'mensagem',
];

function celulasDeSemEnvio(p: EnvioPrecoSemEnvio): string[] {
  return [p.produtoId, p.produtoNome ?? 'sem nome', p.motivo, p.mensagem];
}

/**
 * The `--live` report.
 *
 * ⚠️ It re-words nothing: `mensagem` arrived rendered on every row, and the
 * counts are the envelope's own `resumo` — which counts ROWS (models), so a
 * three-model listing contributes three.
 */
export function renderizarResultadoEnvioPreco(resposta: EnvioPrecoResponse): string[] {
  const linhas: string[] = [
    rotulo('integração ', resposta.integracaoId),
    rotulo('conta ', resposta.contaNome ?? TRACO),
    rotulo('solicitados ', String(resposta.solicitados)),
    rotulo('famílias ', String(resposta.familias)),
    rotulo('enviados ', String(resposta.resumo.enviados)),
    rotulo('pulados ', String(resposta.resumo.pulados)),
    rotulo('falhas ', String(resposta.resumo.falhas)),
    rotulo('não tentados ', String(resposta.resumo.naoTentados)),
    rotulo('pausado até ', resposta.pausadoAte ?? TRACO),
    '',
    `### linhas (${String(resposta.listings.length)}) — uma por modelo`,
  ];
  if (resposta.listings.length > 0) {
    linhas.push(
      ...alinharTabela('  ', [
        CABECALHO_DA_LINHA_ENVIADA,
        ...resposta.listings.map(celulasDaLinhaEnviada),
      ]),
    );
  }
  linhas.push('');
  linhas.push(
    resposta.produtosSemEnvio.length === 0
      ? '### produtos sem envio: NENHUM'
      : `### produtos sem envio (${String(resposta.produtosSemEnvio.length)})`,
  );
  linhas.push(...alinharTabela('  ', resposta.produtosSemEnvio.map(celulasDeSemEnvio)));
  return linhas;
}

/** The `--json` document for `--live`. An ALLOW-LIST, built by name at EVERY level. */
export function resumoDoEnvioPreco(resposta: EnvioPrecoResponse): Record<string, unknown> {
  return {
    canal: resposta.canal,
    integracaoId: resposta.integracaoId,
    contaNome: resposta.contaNome,
    solicitados: resposta.solicitados,
    familias: resposta.familias,
    resumo: {
      enviados: resposta.resumo.enviados,
      pulados: resposta.resumo.pulados,
      falhas: resposta.resumo.falhas,
      naoTentados: resposta.resumo.naoTentados,
    },
    listings: resposta.listings.map((l) => ({
      produtoId: l.produtoId,
      produtoNome: l.produtoNome,
      variacaoProdutoId: l.variacaoProdutoId,
      anuncioId: l.anuncioId,
      linkDocId: l.linkDocId,
      outcome: l.outcome,
      motivo: l.motivo,
      mensagem: l.mensagem,
      preco: l.preco,
      precoAnterior: l.precoAnterior,
      codigo: l.codigo,
    })),
    produtosSemEnvio: resposta.produtosSemEnvio.map((p) => ({
      produtoId: p.produtoId,
      produtoNome: p.produtoNome,
      motivo: p.motivo,
      mensagem: p.mensagem,
    })),
    pausadoAte: resposta.pausadoAte,
  };
}

/* -------------------------------------------------------------------------- */
/*                              the conta verdict                              */
/* -------------------------------------------------------------------------- */

/** A refused verdict. */
export type RecusaDaConta = Extract<VereditoContaPreco, { readonly ok: false }>;

/**
 * The code the ROUTE answers for this refusal — the SAME table the route maps
 * through, so the terminal and the web dialog name one refusal the same way:
 * `sem-tabela-normal` is the route's 400, every other verdict refusal its 422.
 */
export function codigoDaRecusaDaConta(recusa: Pick<RecusaDaConta, 'motivo'>): CodigoGuardaPreco {
  return recusa.motivo === MOTIVO_PRECO_SHOPEE.semTabelaNormal
    ? CODIGO_GUARDA_PRECO.contaSemTabelaNormal
    : CODIGO_GUARDA_PRECO.contaRecusada;
}

/**
 * A refused conta, printed — BOTH modes stop here, before any listing, and the
 * command exits 0: the route answers this refusal as a response, and the two
 * surfaces must not disagree about what a refusal is.
 *
 * `erro` (the class and message of a credential failure) is printed: this is
 * the operator's own terminal, and the package builds every message from paths,
 * codes and statuses, never a body.
 */
export function descreverRecusaDaConta(recusa: RecusaDaConta): string[] {
  const codigo = codigoDaRecusaDaConta(recusa);
  const linhas = [
    `❌ conta RECUSADA para preço — a rota responderia ${String(
      STATUS_POR_CODIGO_DE_GUARDA_PRECO[codigo],
    )} ${codigo}`,
    rotulo('motivo ', recusa.motivo),
    rotulo('mensagem ', mensagemDoMotivoDePreco(recusa.motivo)),
  ];
  if (recusa.regiao !== null) linhas.push(rotulo('região ', recusa.regiao));
  if (recusa.erro !== null) linhas.push(rotulo('erro ', recusa.erro));
  linhas.push('  Nada foi lido nem enviado: a recusa é anterior a qualquer anúncio.');
  return linhas;
}

/** The `--json` document for a refused conta. An ALLOW-LIST. */
export function resumoDaRecusaDaConta(recusa: RecusaDaConta): Record<string, unknown> {
  const codigo = codigoDaRecusaDaConta(recusa);
  return {
    code: codigo,
    status: STATUS_POR_CODIGO_DE_GUARDA_PRECO[codigo],
    motivo: recusa.motivo,
    mensagem: mensagemDoMotivoDePreco(recusa.motivo),
    regiao: recusa.regiao,
  };
}

/* -------------------------------------------------------------------------- */
/*                                   errors                                    */
/* -------------------------------------------------------------------------- */

/**
 * One failure, described by CLASS plus the fields that identify it — never a
 * payload. The Shopee half is `pedidos/importarPedidoCli.ts`'s
 * {@link descreverErro}, IMPORTED: the CLIs of this app face one error taxonomy.
 *
 * ⚠️ The guard's `extra` is deliberately NOT printed: it is an untyped bag, and
 * a future key would travel here with nobody having decided it was printable.
 */
export function descreverErroEnvioPreco(err: unknown): string[] {
  if (err instanceof ArgumentoInvalidoError) {
    return [`❌ ${err.message}`, '', USO_ENVIAR_PRECOS];
  }
  if (err instanceof ShopeeEnvioPrecoGuardError) {
    return [
      `❌ ShopeeEnvioPrecoGuardError (${err.code})`,
      `   ${err.message}`,
      '   Nada foi enviado: a recusa é anterior a qualquer chamada de escrita à Shopee.',
    ];
  }
  return descreverErro(err);
}

/**
 * Whether a failure happened BEFORE any price could have been written — one
 * predicate for the script's `catch` and {@link descreverErroEnvioPreco}, so
 * the two cannot contradict each other about the same failure. Everything else,
 * every Shopee class included, may have landed an `update_price`.
 */
export function ehRecusaAntesDoEnvioDePreco(err: unknown): boolean {
  return err instanceof ArgumentoInvalidoError || err instanceof ShopeeEnvioPrecoGuardError;
}
