/**
 * The pure half of `scripts/liquidar-pagamentos.ts` (#1514, step 6) — argument
 * parsing, the **redacted** summary shape, its renderer and the usage text.
 *
 * ⚠️ **It lives here rather than in the script because `scripts/` is outside
 * this app's vitest `include`** (`{app,lib,functions}/**\/*.test.ts`), so logic
 * written in a script file can never be tested. Same reasoning, same shape as
 * `importarPedidoCli.ts` one file over. The script keeps the I/O and nothing
 * else.
 *
 * ⚠️ **Script-only, imported by no route, no sweep and no bundle.** Nothing here
 * reads `process.env`, opens a client or touches Firestore.
 *
 * ## The redaction is an ALLOW-LIST, and that is the whole design
 *
 * {@link resumoDaLinhaSimulada} copies no input object. Every field of
 * {@link ResumoLiquidacaoShopee} is named and constructed one at a time, so a
 * field that is not listed cannot appear in the output — including one a future
 * schema change adds, and including everything a Shopee buyer authored. A
 * denylist has the opposite property: it protects the fields somebody
 * remembered.
 *
 * The escrow body this summary is built FROM carries ~100 money fields plus
 * `buyer_payment_info`; what crosses into the summary is four numbers, the eight
 * named fee columns and the field NAMES that would change.
 */
import { formatReais } from '@delfrance/core/money';
import { microsToMillis, parseIsoToMillis } from '@delfrance/core/datetime';
import type { MarketplacePagamentoTaxas } from '@delfrance/schemas';

import { ArgumentoInvalidoError, descreverErro } from './importarPedidoCli';
import type { AcaoLiquidacaoShopee } from './liquidarPagamento';
import type { LinhaSimuladaShopee } from './liquidacaoSweep';

export { ArgumentoInvalidoError };

/* -------------------------------------------------------------------------- */
/*                                  arguments                                  */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ No `--` separator in any documented invocation: pnpm forwards the literal
 * token INTO the script and every CLI in this repo parses `process.argv` itself,
 * so the separator would be read as an argument.
 * `packages/config-eslint/rules/pnpm-run-args.test.js` fails CI on the spelling
 * that carries one — including inside this string.
 */
export const USO_LIQUIDAR_PAGAMENTOS = `
Ensaia a varredura semanal de liquidação (escrow) da Shopee, de UMA integração.

  pnpm --filter @delfrance/shopee-app liquidar:pagamentos \\
    --integracao <integracaoId> [opções]

Obrigatório
  --integracao <id>   documento da integração Shopee (ex.: int-1)

Janela (os dois juntos, ou nenhum)
  --de YYYY-MM-DD     início da janela de escrow_release_time
  --ate YYYY-MM-DD    fim da janela
                      ⚠️ As duas datas são lidas como MEIA-NOITE UTC, nunca no
                      fuso da máquina: "--ate 2026-09-08" NÃO inclui o dia 8.
                      Sem elas, a janela é a que o próximo tick usaria (cursor
                      gravado, ou 30 dias para trás numa conta sem cursor).

Uma order só
  --order-sn <sn>     inspeciona UMA order (ex.: 220810QSK8S7BX).
                      Incompatível com --de/--ate e com --live: a listagem de
                      escrow é consultada POR JANELA e não tem forma por id, de
                      modo que esse caminho não conhece payout_amount nem
                      escrow_release_time — gravar por ele apagaria um carimbo
                      de liberação já guardado.

Opções
  --dry-run           lê e compara, NÃO grava nada. É o PADRÃO.
  --live              GRAVA: roda a varredura de verdade nessa integração.
  --cursor            permite gravar o documento de cursor (liquidacaoShopee).
                      Só faz sentido com --live; sem ele o cursor não é escrito.
  --project <id>      sobrescreve FIREBASE_PROJECT_ID antes de abrir o admin.
  --json              imprime o mesmo resumo redigido em JSON no stdout
                      (o cabeçalho vai para o stderr).
  --help, -h          mostra esta ajuda e sai com 0, sem abrir o Firestore
                      nem chamar a Shopee.

O dry-run continua CHAMANDO a Shopee (get_escrow_list + get_escrow_detail por
linha) e lendo o Firestore — ele não grava. Ver apps/shopee/scripts/README.md.
`.trim();

export interface ArgsLiquidarPagamentos {
  readonly integracaoId: string;
  /** Both bounds in MS (UTC midnight), or `null` for "the window the tick would use". */
  readonly janela: { readonly deMs: number; readonly ateMs: number } | null;
  /** ONE order, inspect-only. Never set together with `janela` or `live`. */
  readonly orderSn: string | null;
  /** `false` — the DRY-RUN default. `--live` is the only way to write. */
  readonly live: boolean;
  /** Whether the cursor document may be written. Always `false` in dry-run. */
  readonly cursor: boolean;
  readonly json: boolean;
  /** `null` keeps whatever the environment resolves. */
  readonly projectId: string | null;
}

export type ComandoLiquidarPagamentos =
  | { readonly kind: 'ajuda' }
  | { readonly kind: 'liquidar'; readonly args: ArgsLiquidarPagamentos };

function valorDe(nome: string, inline: string | undefined, proximo: string | undefined): string {
  const bruto = (inline ?? proximo)?.trim();
  if (bruto == null || bruto.length === 0 || bruto.startsWith('--')) {
    throw new ArgumentoInvalidoError(`--${nome} exige um valor.`);
  }
  return bruto;
}

/**
 * A `YYYY-MM-DD` date as MILLISECONDS at **UTC midnight**.
 *
 * ⚠️ `parseIsoToMillis` (`@delfrance/core/datetime`) resolves a date-only string
 * against UTC EXPLICITLY. Never `new Date(str)` or `Date.parse` — both are
 * lossy, and `delfrance/no-lossy-date-parse` bans them; and never a local-zone
 * reading, because `apps/shopee` is a server surface for
 * `delfrance/no-ambient-timezone` and the window a rehearsal asks for must not
 * depend on which machine ran it.
 */
function dataDe(nome: string, bruto: string): number {
  const ms = parseIsoToMillis(bruto);
  if (ms == null) {
    throw new ArgumentoInvalidoError(`--${nome} precisa ser uma data ISO (YYYY-MM-DD): ${bruto}`);
  }
  return ms;
}

/**
 * Parse the command line. Pure — it reads no environment and no clock.
 *
 * ⚠️ `--help` is answered BEFORE anything is validated, so `--help` on its own
 * exits 0 instead of complaining about the required flag. The script's side of
 * that bargain is to return before it opens the admin app.
 *
 * ⚠️ **Dry-run is the default and `--live` is the only opt-in.** Passing both
 * `--dry-run` and `--live` is a contradiction and is REFUSED rather than
 * resolved by precedence: whichever way a precedence rule fell, half the readers
 * of the command line would expect the other.
 */
export function parseArgsLiquidarPagamentos(argv: readonly string[]): ComandoLiquidarPagamentos {
  if (argv.some((a) => a === '--help' || a === '-h')) return { kind: 'ajuda' };

  let integracaoId: string | undefined;
  let de: string | undefined;
  let ate: string | undefined;
  let orderSn: string | undefined;
  let projectId: string | undefined;
  let live = false;
  let dryRunExplicito = false;
  let cursor = false;
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
        integracaoId = valorDe('integracao', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--de':
        de = valorDe('de', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--ate':
        ate = valorDe('ate', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--order-sn':
        orderSn = valorDe('order-sn', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--project':
        projectId = valorDe('project', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--live':
        live = true;
        break;
      case '--dry-run':
        dryRunExplicito = true;
        break;
      case '--cursor':
        cursor = true;
        break;
      case '--json':
        json = true;
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
  if ((de == null) !== (ate == null)) {
    throw new ArgumentoInvalidoError('--de e --ate andam juntos: passe os dois, ou nenhum.');
  }
  if (orderSn != null && de != null) {
    throw new ArgumentoInvalidoError('--order-sn não combina com --de/--ate: escolha um.');
  }
  if (orderSn != null && live) {
    // ⚠️ NOT a limitation of the script. `get_escrow_list` is queried BY window
    // and has no by-id form, so a single-order path cannot learn
    // `payout_amount` or `escrow_release_time` — and a settlement written with
    // both null would ERASE a release stamp an earlier tick had recorded.
    throw new ArgumentoInvalidoError(
      '--order-sn é só para inspeção (--dry-run): a listagem de escrow é por JANELA e não ' +
        'devolve payout_amount nem escrow_release_time para UMA order, então gravar por esse ' +
        'caminho apagaria a liquidação já guardada. Rode --live com --de/--ate.',
    );
  }
  if (cursor && !live) {
    throw new ArgumentoInvalidoError('--cursor só faz sentido com --live (o dry-run não grava).');
  }

  const janela =
    de == null || ate == null ? null : { deMs: dataDe('de', de), ateMs: dataDe('ate', ate) };
  if (janela !== null && janela.ateMs < janela.deMs) {
    throw new ArgumentoInvalidoError('--de não pode ser depois de --ate.');
  }

  return {
    kind: 'liquidar',
    args: {
      integracaoId,
      janela,
      orderSn: orderSn ?? null,
      live,
      cursor,
      json,
      projectId: projectId ?? null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                            the redacted summary                             */
/* -------------------------------------------------------------------------- */

/**
 * ONE escrow row, reduced to what a rehearsal needs and nothing else.
 *
 * ⚠️ **Thirteen fields, and the count is pinned by a test.** Three of them are
 * the reason the type exists at all:
 *
 *  - **`camposQueMudariam`** carries field NAMES, never their old or new values;
 *  - **`taxas`** is the eight named fee COLUMNS — numbers the seller is charged,
 *    which is the whole point of the rehearsal — and carries no buyer field;
 *  - the escrow body it is built from also holds `buyer_payment_info` and ~90
 *    other keys, and **none of them has a field here to travel in.**
 */
export interface ResumoLiquidacaoShopee {
  readonly orderSn: string;
  readonly pedidoId: string;
  readonly pagamentoId: string;
  readonly existePedido: boolean;
  readonly existePagamento: boolean;
  /** `get_escrow_list.payout_amount` RAW — the unit is unresolved. */
  readonly payoutAmount: number | null;
  readonly escrowAmount: number | null;
  readonly escrowAmountAfterAdjustment: number | null;
  /** The clamped figure `pagamento.tarifas` would take. */
  readonly tarifas: number | null;
  readonly taxas: MarketplacePagamentoTaxas | null;
  readonly escrowReleaseTimeUs: number | null;
  /** `null` when the escrow could not be read — see the renderer's `motivo` line. */
  readonly acao: AcaoLiquidacaoShopee | null;
  readonly camposQueMudariam: readonly string[];
}

/** The allow-list itself, exported so a test can pin the field COUNT. */
export const CAMPOS_RESUMO_LIQUIDACAO = [
  'orderSn',
  'pedidoId',
  'pagamentoId',
  'existePedido',
  'existePagamento',
  'payoutAmount',
  'escrowAmount',
  'escrowAmountAfterAdjustment',
  'tarifas',
  'taxas',
  'escrowReleaseTimeUs',
  'acao',
  'camposQueMudariam',
] as const satisfies readonly (keyof ResumoLiquidacaoShopee)[];

/**
 * Build the summary of one simulated row — field by field, never by copying.
 *
 * ⚠️ `tarifas` and `taxas` are read off the PREDICTED patch rather than
 * recomputed here: the prediction already ran the one shared fold, and a second
 * derivation in a rehearsal tool is how a rehearsal starts disagreeing with what
 * it rehearses.
 */
export function resumoDaLinhaSimulada(linha: LinhaSimuladaShopee): ResumoLiquidacaoShopee {
  const oi = linha.escrow?.order_income ?? null;
  const patch = linha.previsao?.patch ?? null;
  const marketplace = patch === null ? null : patch.marketplace;
  const taxas =
    typeof marketplace === 'object' && marketplace !== null && !Array.isArray(marketplace)
      ? ((marketplace as { taxas?: MarketplacePagamentoTaxas | null }).taxas ?? null)
      : null;
  const tarifas = patch === null ? null : patch.tarifas;
  return {
    orderSn: linha.orderSn,
    pedidoId: linha.pedidoId,
    pagamentoId: linha.pagamentoId,
    existePedido: linha.existePedido,
    existePagamento: linha.existePagamento,
    payoutAmount: linha.payoutAmount,
    escrowAmount: oi?.escrow_amount ?? null,
    escrowAmountAfterAdjustment: oi?.escrow_amount_after_adjustment ?? null,
    tarifas: typeof tarifas === 'number' ? tarifas : null,
    taxas,
    escrowReleaseTimeUs: linha.previsao?.escrowReleaseTimeUs ?? null,
    acao: linha.previsao?.acao ?? null,
    camposQueMudariam: linha.previsao?.campos ?? [],
  };
}

/* -------------------------------------------------------------------------- */
/*                                 rendering                                   */
/* -------------------------------------------------------------------------- */

function txt(v: string | null): string {
  return v ?? '—';
}

function dinheiro(v: number | null): string {
  return v == null ? '—' : formatReais(v);
}

/**
 * A µs stamp as `<raw> (<ISO UTC>)`.
 *
 * ⚠️ **UTC, never the ambient zone.** `apps/shopee` is a server surface for
 * `delfrance/no-ambient-timezone`, and the answer must not depend on which
 * machine ran the script.
 */
function carimbo(us: number | null): string {
  if (us == null) return '—';
  const ms = microsToMillis(us);
  if (!Number.isFinite(ms)) return String(us);
  return `${String(us)} (${new Date(ms).toISOString()})`;
}

/** A ms stamp as `<raw> (<ISO UTC>)`. Same rule as {@link carimbo}. */
export function carimboMs(ms: number | null): string {
  if (ms == null) return '—';
  return `${String(ms)} (${new Date(ms).toISOString()})`;
}

/** The human rendering of one row's summary. */
export function renderResumoLiquidacao(r: ResumoLiquidacaoShopee, motivo: string | null): string[] {
  const linhas: string[] = [];
  linhas.push(`  order_sn ................ ${r.orderSn}`);
  linhas.push(
    `    pedidoId .............. ${r.pedidoId}  (${r.existePedido ? 'existe' : 'AUSENTE'})`,
  );
  linhas.push(
    `    pagamentoId ........... ${r.pagamentoId}  (${r.existePagamento ? 'existe' : 'AUSENTE'})`,
  );
  if (motivo !== null) {
    linhas.push(`    escrow ................ NÃO LIDO — ${motivo}`);
    return linhas;
  }
  linhas.push(
    `    payout / escrow ....... ${dinheiro(r.payoutAmount)} / ${dinheiro(r.escrowAmount)}` +
      `  (após ajuste: ${dinheiro(r.escrowAmountAfterAdjustment)})`,
  );
  linhas.push(`    tarifas ............... ${dinheiro(r.tarifas)}`);
  if (r.taxas !== null) {
    linhas.push(
      `      comissão/serviço .... ${dinheiro(r.taxas.comissao)} / ${dinheiro(r.taxas.servico)}`,
    );
    linhas.push(
      `      transação/campanha .. ${dinheiro(r.taxas.transacaoVendedor)} / ${dinheiro(r.taxas.campanha)}`,
    );
    linhas.push(
      `      frete/processamento . ${dinheiro(r.taxas.protecaoFrete)} / ${dinheiro(r.taxas.processamento)}`,
    );
    linhas.push(
      `      ajustes/devoluções .. ${dinheiro(r.taxas.ajustes)} / ${dinheiro(r.taxas.devolucoes)}`,
    );
  }
  linhas.push(`    liberação do escrow ... ${carimbo(r.escrowReleaseTimeUs)}`);
  linhas.push(`    ação .................. ${txt(r.acao)}`);
  linhas.push(
    `    campos que mudariam ... ${r.camposQueMudariam.length === 0 ? '(nenhum)' : r.camposQueMudariam.join(', ')}`,
  );
  return linhas;
}

/* -------------------------------------------------------------------------- */
/*                                   errors                                    */
/* -------------------------------------------------------------------------- */

/**
 * One failure, described by CLASS plus the fields that identify it.
 *
 * ⚠️ The Shopee half is `importarPedidoCli.ts`'s {@link descreverErro},
 * IMPORTED rather than re-implemented — the two CLIs face the same error
 * taxonomy and a second copy of that table is how one of them starts printing a
 * payload. Only the ARGUMENT arm is this module's, because the usage text it
 * has to print is this module's.
 */
export function descreverErroLiquidacao(err: unknown): string[] {
  if (err instanceof ArgumentoInvalidoError) {
    return [`❌ ${err.message}`, '', USO_LIQUIDAR_PAGAMENTOS];
  }
  return descreverErro(err);
}
