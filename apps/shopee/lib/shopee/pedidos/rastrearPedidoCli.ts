/**
 * The pure half of `scripts/rastrear-pedido.ts` (#1515, step 7, plan §3.0-P P4)
 * — argument parsing, the **redacted** summary shapes, their renderers and the
 * usage text.
 *
 * ⚠️ **It lives here rather than in the script because `scripts/` is outside
 * this app's vitest `include`** (`{app,lib,functions}/**\/*.test.ts`), so logic
 * written in a script file can never be tested. Same reasoning, same shape as
 * `importarPedidoCli.ts` and `liquidarPagamentosCli.ts`. The script keeps the
 * I/O and nothing else.
 *
 * ⚠️ **Script-only, imported by no route, no sweep and no bundle.** Nothing here
 * reads `process.env`, opens a client or touches Firestore, and nothing here
 * holds a converter of its own: the summary carries `updateTimeS`/`shipByDateS`
 * in wire SECONDS verbatim, and the two stamp RENDERERS call µs site 3
 * (`microsDeSegundosShopee`) and `microsToMillis` for DISPLAY only — the
 * `liquidarPagamentosCli.ts` position, which the µs site list in
 * `apps/shopee/CLAUDE.md` describes as "µs only as display".
 *
 * ## The redaction is an ALLOW-LIST, and that is the whole design
 *
 * Neither summary builder below copies an input object. Every field is named and
 * constructed one at a time, so a field that is not listed cannot appear in the
 * output — including one a future schema change adds. A denylist has the
 * opposite property: it protects the fields somebody remembered.
 *
 * The `get_package_detail` row these summaries are built FROM carries
 * `recipient_address` (name, phone, full address, zipcode, geolocation),
 * `driver_info` (name, phone, licence plate, photo), `virtual_contact_number`,
 * `package_query_number` and a prescription block — every one of them
 * deliberately UNDECLARED on `shopeePackageDetailRowSchema`, so they ride
 * `.passthrough()` and are really present in the object this module is handed.
 * None of them has a field here to travel in, and a test drives exactly that
 * row.
 *
 * ⚠️ **`trackingNumber` IS printed, and that is a decision rather than an
 * oversight**: it is `freteInicial.codRastreio`, which `/pedidos` already renders
 * in the clear beside a copy button, it is the ONE value this rehearsal exists to
 * show, and `redact.ts` does not treat a parcel identifier as personal data.
 */
import { microsToMillis } from '@delfrance/core/datetime';
import type { EstadoFrete } from '@delfrance/schemas';
import type { CodigoPushFrete, DiagnosticoPushFrete, FontePacoteShopee } from './fretePushShopee';
import type { AcaoFreteShopee } from './freteTx';
import { ArgumentoInvalidoError, descreverErro } from './importarPedidoCli';
import { microsDeSegundosShopee } from './orderMapping';
import type { LinhaSimuladaRastreio, OrigemPacoteRastreio } from './rastrearPedidoSimulacao';

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
export const USO_RASTREAR_PEDIDO = `
Ensaia o passo 7 (rastreio → freteInicial) de UM pedido da Shopee.

  pnpm --filter @delfrance/shopee-app rastrear:pedido \\
    --integracao <integracaoId> --order-sn <orderSn> [opções]

Obrigatórios
  --integracao <id>   documento da integração Shopee (ex.: int-1)
  --order-sn <sn>     a order da Shopee (ex.: 260910KJBHUJDM)

Opções
  --package <n>       limita a UM package_number (ex.: OFG242672552205937).
                      Sem ele, o conjunto de pacotes é resolvido em três rungs e
                      cada linha diz de onde veio: --package [flag], os volumes
                      guardados no freteInicial [volume], e o
                      get_order_detail.package_list [order_detail].
  --dry-run           lê e prevê, NÃO grava nada. É o PADRÃO.
  --live              GRAVA: roda a transação de frete de verdade, um pacote por
                      vez, exatamente como um push code 4/30/47 faria — e, se o
                      pedido não existir, ENFILEIRA um code 3 sintético.
  --project <id>      sobrescreve FIREBASE_PROJECT_ID antes de abrir o admin.
  --json              imprime o mesmo resumo redigido em JSON no stdout
                      (o cabeçalho vai para o stderr).
  --help, -h          mostra esta ajuda e sai com 0, sem abrir o Firestore
                      nem chamar a Shopee.

O dry-run continua CHAMANDO a Shopee (get_package_detail, e get_order_detail
quando --package não foi informado) e lendo o Firestore — ele não grava, e isso é
estrutural: simularRastreioShopee não tem nenhum escritor nem nenhum enfileirador
no corpo. Ver apps/shopee/scripts/README.md.
`.trim();

export interface ArgsRastrearPedido {
  readonly integracaoId: string;
  readonly orderSn: string;
  /** `null` walks the volume/order_detail rungs. */
  readonly packageNumber: string | null;
  /** `false` — the DRY-RUN default. `--live` is the only way to write. */
  readonly live: boolean;
  readonly json: boolean;
  /** `null` keeps whatever the environment resolves. */
  readonly projectId: string | null;
}

export type ComandoRastrearPedido =
  | { readonly kind: 'ajuda' }
  | { readonly kind: 'rastrear'; readonly args: ArgsRastrearPedido };

function valorDe(nome: string, inline: string | undefined, proximo: string | undefined): string {
  const bruto = (inline ?? proximo)?.trim();
  if (bruto == null || bruto.length === 0 || bruto.startsWith('--')) {
    throw new ArgumentoInvalidoError(`--${nome} exige um valor.`);
  }
  return bruto;
}

/**
 * Parse the command line. Pure — it reads no environment and no clock.
 *
 * ⚠️ `--help` is answered BEFORE anything is validated, so `--help` on its own
 * exits 0 instead of complaining about the two required flags. The script's side
 * of that bargain is to return before its first dynamic import.
 *
 * ⚠️ **Dry-run is the default and `--live` is the only opt-in.** Passing both
 * `--dry-run` and `--live` is a contradiction and is REFUSED rather than
 * resolved by precedence: whichever way a precedence rule fell, half the readers
 * of the command line would expect the other.
 */
export function parseArgsRastrearPedido(argv: readonly string[]): ComandoRastrearPedido {
  if (argv.some((a) => a === '--help' || a === '-h')) return { kind: 'ajuda' };

  let integracaoId: string | undefined;
  let orderSn: string | undefined;
  let packageNumber: string | undefined;
  let projectId: string | undefined;
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
        integracaoId = valorDe('integracao', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--order-sn':
        orderSn = valorDe('order-sn', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--package':
        packageNumber = valorDe('package', inline, argv[i + 1]);
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
  if (orderSn == null) {
    throw new ArgumentoInvalidoError('--order-sn <orderSn> é obrigatório.');
  }
  if (packageNumber != null) {
    // ⚠️ The SAME three refusals `assertPackageDetailParams` makes before it
    // fetches, made HERE so they cost no Firestore read and no Shopee call, and
    // so the operator reads a sentence instead of a ShopeeConfigError. The `-`
    // one is this page's own: `get_package_detail` samples a bare `-` as an
    // ABSENCE, so it is the one string that can never be a package.
    if (packageNumber === '-') {
      throw new ArgumentoInvalidoError(
        '--package recebeu "-", que é o sentinela de AUSÊNCIA da Shopee, não um pacote.',
      );
    }
    if (packageNumber.includes(',')) {
      throw new ArgumentoInvalidoError(
        '--package aceita UM package_number; a vírgula é o separador da chamada em lote.',
      );
    }
  }

  return {
    kind: 'rastrear',
    args: {
      integracaoId,
      orderSn,
      packageNumber: packageNumber ?? null,
      live,
      json,
      projectId: projectId ?? null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                           the rehearsal's diagnostic                        */
/* -------------------------------------------------------------------------- */

/**
 * The `DiagnosticoPushFrete` a `--live` rehearsal hands the handler.
 *
 * ⚠️ **There is no push here, and every claim field says so.** The handler logs
 * this record and writes not one field of it, so a rehearsal that fabricated a
 * status, a tracking number or a clock would put a claim into a task log that no
 * Shopee delivery ever made. Every field except the two the type cannot leave
 * open is `null`, and that pattern — a `code` with no `statusDoPush`, no
 * `trackingNoDoPush`, no `camposMudados` and no `relogioDoPushS` — is how a
 * reader tells a rehearsal line from a real delivery.
 *
 * ⚠️ `code` is `4` because {@link CodigoPushFrete} admits only the three push
 * codes step 7 owns; there is no "no push" member and inventing one would widen
 * a wire type for a dev tool.
 */
export const CODIGO_PUSH_DE_ENSAIO: CodigoPushFrete = 4;

export const DIAGNOSTICO_DE_ENSAIO: DiagnosticoPushFrete = {
  code: CODIGO_PUSH_DE_ENSAIO,
  grafiaDoPedido: 'ordersn',
  trackingNoDoPush: null,
  statusDoPush: null,
  camposMudados: null,
  shipByDateAntigaS: null,
  shipByDateNovaS: null,
  canalAntigo: null,
  canalNovo: null,
  relogioDoPushS: null,
};

/* -------------------------------------------------------------------------- */
/*                            the redacted summary                             */
/* -------------------------------------------------------------------------- */

/**
 * ONE package, reduced to what a rehearsal needs and nothing else.
 *
 * ⚠️ Fourteen fields, and the count is pinned by a test so a field added to the
 * allow-list has to be looked at. Three of them are why the type exists:
 *
 *  - **`camposQueMudariam`** carries field NAMES, never their old or new values;
 *  - **`itensNoPacote`** is a COUNT, never the lines — an item list carries SKUs,
 *    promotion groups and product locations;
 *  - **`fulfillmentStatus`** is the RAW wire token, because the stored
 *    `estadoMarketplace` is the source of truth and `estadoAlvo` only its
 *    projection (#1369) — a rehearsal that printed the projection alone could not
 *    show a table row disagreeing with the wire.
 */
export interface ResumoRastreioShopee {
  readonly packageNumber: string;
  /** Which rung produced this package — `flag`, `volume` or `order_detail`. */
  readonly origem: OrigemPacoteRastreio;
  /** Which wire page the observation came from; `null` when there was none. */
  readonly fonte: FontePacoteShopee | null;
  /** The RAW wire token. */
  readonly fulfillmentStatus: string | null;
  /** What the fold WANTS. `null` when the table does not know the token. */
  readonly estadoAlvo: EstadoFrete | null;
  /** `freteInicial.codRastreio` — printed deliberately; see the module header. */
  readonly trackingNumber: string | null;
  /** Wire SECONDS. */
  readonly shipByDateS: number | null;
  readonly logisticsChannelId: number | null;
  /** Wire SECONDS — the PACKAGE clock. */
  readonly updateTimeS: number | null;
  /** Step 15's duplicate-call guard, printed because a rehearsal precedes it. */
  readonly isShipmentArranged: boolean | null;
  readonly groupShipmentId: number | null;
  /** A COUNT. `null` when no row came back. */
  readonly itensNoPacote: number | null;
  /** `null` when there was no observation to decide from. */
  readonly acao: AcaoFreteShopee | null;
  readonly camposQueMudariam: readonly string[];
}

/** The allow-list itself, exported so a test can pin the field COUNT. */
export const CAMPOS_RESUMO_RASTREIO = [
  'packageNumber',
  'origem',
  'fonte',
  'fulfillmentStatus',
  'estadoAlvo',
  'trackingNumber',
  'shipByDateS',
  'logisticsChannelId',
  'updateTimeS',
  'isShipmentArranged',
  'groupShipmentId',
  'itensNoPacote',
  'acao',
  'camposQueMudariam',
] as const satisfies readonly (keyof ResumoRastreioShopee)[];

/**
 * Build the summary of one simulated package — field by field, never by copying.
 *
 * ⚠️ `estadoAlvo`, `acao` and `camposQueMudariam` are read off the PREDICTION
 * rather than recomputed here: the prediction already ran the one shared fold,
 * and a second derivation in a rehearsal tool is how a rehearsal starts
 * disagreeing with what it rehearses.
 */
export function resumoDoPacoteSimulado(linha: LinhaSimuladaRastreio): ResumoRastreioShopee {
  const row = linha.linha;
  const obs = linha.observado;
  return {
    packageNumber: linha.packageNumber,
    origem: linha.origem,
    fonte: obs?.fonte ?? null,
    fulfillmentStatus: obs?.fulfillmentStatus ?? null,
    estadoAlvo: linha.previsao?.diagnosticos.estadoAlvo ?? null,
    trackingNumber: obs?.trackingNumber ?? null,
    shipByDateS: obs?.shipByDateS ?? null,
    logisticsChannelId: obs?.logisticsChannelId ?? null,
    updateTimeS: obs?.updateTimeS ?? null,
    isShipmentArranged: row?.is_shipment_arranged ?? null,
    groupShipmentId: row?.group_shipment_id ?? null,
    itensNoPacote: row?.item_list?.length ?? null,
    acao: linha.previsao?.acao ?? null,
    camposQueMudariam: linha.previsao?.campos ?? [],
  };
}

/* -------------------------------------------------------------------------- */
/*                      the stored block, after a --live run                   */
/* -------------------------------------------------------------------------- */

/**
 * The stored `freteInicial`, reduced the same way and for the same reason: the
 * block carries `clienteRecebedorOuterReference`, `enderecoFreteOuterReference`
 * and `externalOptionData` — Melhor Envio's untyped bag, rendered raw — and none
 * of the three has a field here to travel in.
 */
export interface ResumoFreteArmazenado {
  readonly estado: string | null;
  readonly codRastreio: string | null;
  readonly externalOptionId: string | null;
  readonly prazoDespachoUs: number | null;
  readonly ultimaModificacaoUs: number | null;
  readonly pacotes: readonly ResumoPacoteArmazenado[];
}

export interface ResumoPacoteArmazenado {
  readonly numero: string | null;
  readonly estado: string | null;
  readonly estadoMarketplace: string | null;
  readonly codRastreio: string | null;
  readonly canalId: string | null;
  readonly prazoDespachoUs: number | null;
  readonly atualizadoEmUs: number | null;
  readonly fonte: string | null;
}

function texto(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function numero(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function objeto(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * ⚠️ Read RAW and tolerantly, never through the schema: the whole point of the
 * re-read is to show what is PHYSICALLY stored, and a parse would hide a legacy
 * row behind its own defaults.
 */
export function resumoDoFreteArmazenado(bruto: unknown): ResumoFreteArmazenado | null {
  const frete = objeto(bruto);
  if (frete === null) return null;
  const pacotesBrutos = Array.isArray(frete.pacotes) ? frete.pacotes : [];
  return {
    estado: texto(frete.estado),
    codRastreio: texto(frete.codRastreio),
    externalOptionId: texto(frete.externalOptionId),
    prazoDespachoUs: numero(frete.prazoDespacho),
    ultimaModificacaoUs: numero(frete.ultimaModificacao),
    pacotes: pacotesBrutos.map((cru): ResumoPacoteArmazenado => {
      const p = objeto(cru);
      return {
        numero: texto(p?.numero),
        estado: texto(p?.estado),
        estadoMarketplace: texto(p?.estadoMarketplace),
        codRastreio: texto(p?.codRastreio),
        canalId: texto(p?.canalId),
        prazoDespachoUs: numero(p?.prazoDespacho),
        atualizadoEmUs: numero(p?.atualizadoEm),
        fonte: texto(p?.fonte),
      };
    }),
  };
}

/* -------------------------------------------------------------------------- */
/*                                 rendering                                   */
/* -------------------------------------------------------------------------- */

function txt(v: string | null): string {
  return v ?? '—';
}

function num(v: number | null): string {
  return v == null ? '—' : String(v);
}

function bool(v: boolean | null): string {
  return v == null ? '—' : v ? 'sim' : 'não';
}

/**
 * Wire SECONDS as `<raw> (<ISO UTC>)`.
 *
 * ⚠️ **UTC, never the ambient zone.** `apps/shopee` is a server surface for
 * `delfrance/no-ambient-timezone`, and the answer must not depend on which
 * machine ran the script.
 *
 * ⚠️ It CALLS µs site 3 (`microsDeSegundosShopee`) rather than multiplying by a
 * thousand here. This module writes nothing, so the arithmetic is display only —
 * but an inline `* 1000` beside a µs field is exactly the undeclared conversion
 * the site list exists to prevent, and routing through the shared converter
 * means a rehearsal renders a stamp the same way the transaction stores it.
 * Never `coerceToMicros`: it classifies by MAGNITUDE and reads `1.7e9` seconds
 * as milliseconds ⇒ 1970.
 */
export function carimboSegundos(s: number | null): string {
  if (s == null) return '—';
  return `${String(s)} (${carimboIso(microsDeSegundosShopee(s))})`;
}

/** A stored µs stamp as `<raw> (<ISO UTC>)`. DISPLAY only. */
export function carimboMicros(us: number | null): string {
  if (us == null) return '—';
  return `${String(us)} (${carimboIso(us)})`;
}

/** µs → an ISO UTC string, or `?` when the number cannot be a date at all. */
function carimboIso(us: number): string {
  const ms = microsToMillis(us);
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return '?';
  return new Date(ms).toISOString();
}

/**
 * The human rendering of one package's summary.
 *
 * ⚠️ It never throws on an all-`null` record: a package Shopee answered nothing
 * about is exactly the case an operator is running this for, and a renderer that
 * died on it would hide the `motivo` that explains it.
 */
export function renderResumoRastreio(r: ResumoRastreioShopee, motivo: string | null): string[] {
  const linhas: string[] = [];
  linhas.push(`  package_number .......... ${r.packageNumber}  [${r.origem}]`);
  if (motivo !== null) {
    linhas.push(`    pacote .............. NÃO LIDO — ${motivo}`);
    return linhas;
  }
  linhas.push(`    fonte ............... ${txt(r.fonte)}`);
  linhas.push(
    `    fulfillment_status .. ${txt(r.fulfillmentStatus)}   → estado alvo: ${txt(r.estadoAlvo)}`,
  );
  linhas.push(`    tracking_number ..... ${txt(r.trackingNumber)}`);
  linhas.push(`    ship_by_date ........ ${carimboSegundos(r.shipByDateS)}`);
  linhas.push(`    update_time ......... ${carimboSegundos(r.updateTimeS)}`);
  linhas.push(
    `    canal / grupo ....... ${num(r.logisticsChannelId)} / ${num(r.groupShipmentId)}` +
      `   shipment_arranged=${bool(r.isShipmentArranged)}`,
  );
  linhas.push(`    itens no pacote ..... ${num(r.itensNoPacote)}`);
  linhas.push(`    ação ................ ${txt(r.acao)}`);
  linhas.push(
    `    campos que mudariam . ${r.camposQueMudariam.length === 0 ? '(nenhum)' : r.camposQueMudariam.join(', ')}`,
  );
  return linhas;
}

/** The human rendering of the stored block, after a `--live` re-read. */
export function renderFreteArmazenado(r: ResumoFreteArmazenado | null): string[] {
  if (r === null) return ['  (o pedido não tem freteInicial)'];
  const linhas: string[] = [];
  linhas.push(`  estado .................. ${txt(r.estado)}`);
  linhas.push(`  codRastreio ............. ${txt(r.codRastreio)}`);
  linhas.push(`  externalOptionId ........ ${txt(r.externalOptionId)}`);
  linhas.push(`  prazoDespacho ........... ${carimboMicros(r.prazoDespachoUs)}`);
  linhas.push(`  ultimaModificacao ....... ${carimboMicros(r.ultimaModificacaoUs)}`);
  linhas.push(`  pacotes (${String(r.pacotes.length)})`);
  for (const p of r.pacotes) {
    linhas.push(`    ${txt(p.numero)}  [${txt(p.fonte)}]`);
    linhas.push(
      `      estado ............ ${txt(p.estado)}   (marketplace: ${txt(p.estadoMarketplace)})`,
    );
    linhas.push(`      codRastreio ....... ${txt(p.codRastreio)}   canal=${txt(p.canalId)}`);
    linhas.push(`      prazo / atualizado  ${carimboMicros(p.prazoDespachoUs)}`);
    linhas.push(`                          ${carimboMicros(p.atualizadoEmUs)}`);
  }
  return linhas;
}

/* -------------------------------------------------------------------------- */
/*                                   errors                                    */
/* -------------------------------------------------------------------------- */

/**
 * One failure, described by CLASS plus the fields that identify it.
 *
 * ⚠️ The Shopee half is `importarPedidoCli.ts`'s {@link descreverErro},
 * IMPORTED rather than re-implemented — the three CLIs face the same error
 * taxonomy and a third copy of that table is how one of them starts printing a
 * payload. Only the ARGUMENT arm is this module's, because the usage text it has
 * to print is this module's.
 */
export function descreverErroRastreio(err: unknown): string[] {
  if (err instanceof ArgumentoInvalidoError) {
    return [`❌ ${err.message}`, '', USO_RASTREAR_PEDIDO];
  }
  return descreverErro(err);
}
