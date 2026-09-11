/**
 * The pure half of `scripts/importar-pedido.ts` — argument parsing, the
 * **redacted** summary shape, its renderer and the error describer.
 *
 * ⚠️ **It lives here rather than in the script because `scripts/` is outside
 * this app's vitest `include`** (`vitest.config.ts`:
 * `{app,lib,functions}/**\/*.test.ts`), so logic written in a script file can
 * never be tested. Same reasoning, same shape as
 * `apps/mercado-livre/lib/marketplace/pedidos/pedidoMoneyAudit.ts`, which its
 * own `inspect-pedido.ts` says out loud. The script keeps the I/O and nothing
 * else.
 *
 * ⚠️ **Script-only, imported by no route, no sweep and no bundle** — the
 * `lib/shopee/testing/fakeDb.ts` and `lib/shopee/fixtures/` precedent. Nothing
 * here reads `process.env`, opens a client or touches Firestore.
 *
 * ## The redaction is an ALLOW-LIST, and that is the whole design
 *
 * Neither summary builder below copies an input object. Every field of
 * {@link ResumoPedidoShopee} is named and constructed one at a time, so a field
 * that is not listed cannot appear in the output — including a field a future
 * schema change adds to the pedido, and including everything a Shopee buyer
 * authored. A denylist would have the opposite property: it protects the fields
 * somebody remembered.
 *
 * Three fields deserve their own sentence:
 *
 *  - **`observacoesInternas` is reduced to its LENGTH.** It is composed from
 *    the seller's own `note` and the BUYER's `message_to_seller`, and a buyer
 *    who types their address into the message box is not a hypothetical. The
 *    character count is enough to answer "did the field arrive".
 *  - **`capturaComprador` rides VERBATIM**, because it structurally cannot
 *    carry a value: `comprador.ts` writes `<campo>:<veredito>` pairs — field
 *    NAMES and verdicts — and never the value it judged.
 *  - **`nomeDeVenda` is omitted from the item rows** although it is not buyer
 *    data. The importer's own one-line log excludes the product title for the
 *    same reason (a log stream and a terminal transcript both get pasted into
 *    issues), and `sku` + `mktplaceId` identify the line unambiguously.
 */
import { formatReais } from '@delfrance/core/money';
import { microsToMillis } from '@delfrance/core/datetime';
import {
  FORMA_PAGAMENTO_LABELS,
  STATUS_PAGAMENTO_LABELS,
  type FormaPagamento,
  type StatusPagamento,
} from '@delfrance/schemas';
import {
  ShopeeApiError,
  ShopeeError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
} from '@delfrance/integrations-shopee';

import type { PedidoMapeadoShopee } from './orderMapping';
import { ALVO_STATUS_PAGAMENTO_SHOPEE, type PagamentosMapeadosShopee } from './pagamentoMapping';

/* -------------------------------------------------------------------------- */
/*                                  arguments                                  */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ No `--` separator in any documented invocation: pnpm forwards the literal
 * token INTO the script and every CLI in this repo parses `process.argv`
 * itself, so the separator would be read as an argument.
 * `packages/config-eslint/rules/pnpm-run-args.test.js` fails CI on the spelling
 * that carries one — including inside this string.
 */
export const USO_IMPORTAR_PEDIDO = `
Importa UMA order da Shopee para um pedido do ERP, pelo caminho real do step 5.

  pnpm --filter @delfrance/shopee-app importar:pedido \\
    --integracao <integracaoId> --order-sn <orderSn> [opções]

Obrigatórios
  --integracao <id>   documento da integração Shopee (ex.: int-1)
  --order-sn <sn>     a order da Shopee (ex.: 220810QSK8S7BX)

Opções
  --dry-run           lê e mapeia, NÃO grava nada. É o PADRÃO.
  --live              GRAVA: roda o importador de verdade (pedido, cliente,
                      endereço e incidentes), depois relê o pedido.
  --project <id>      sobrescreve FIREBASE_PROJECT_ID antes de abrir o admin.
  --json              imprime o mesmo resumo redigido em JSON no stdout
                      (o cabeçalho vai para o stderr).
  --help, -h          mostra esta ajuda e sai com 0, sem abrir o Firestore
                      nem chamar a Shopee.

O dry-run continua CHAMANDO a Shopee (get_order_detail + get_escrow_detail) e
lendo o Firestore — ele não grava. Ver apps/shopee/scripts/README.md.
`.trim();

/** A malformed command line. Never a Shopee or a Firestore failure. */
export class ArgumentoInvalidoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgumentoInvalidoError';
  }
}

export interface ArgsImportarPedido {
  readonly integracaoId: string;
  readonly orderSn: string;
  /** `false` — the DRY-RUN default. `--live` is the only way to write. */
  readonly live: boolean;
  readonly json: boolean;
  /** `null` keeps whatever the environment resolves. */
  readonly projectId: string | null;
}

export type ComandoImportarPedido =
  | { readonly kind: 'ajuda' }
  | { readonly kind: 'importar'; readonly args: ArgsImportarPedido };

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
 * exits 0 instead of complaining about the two required flags. The script's
 * side of that bargain is to return before it opens the admin app.
 *
 * ⚠️ **Dry-run is the default and `--live` is the only opt-in.** Passing both
 * `--dry-run` and `--live` is a contradiction and is REFUSED rather than
 * resolved by precedence: whichever way a precedence rule fell, half the
 * readers of the command line would expect the other.
 */
export function parseArgsImportarPedido(argv: readonly string[]): ComandoImportarPedido {
  if (argv.some((a) => a === '--help' || a === '-h')) return { kind: 'ajuda' };

  let integracaoId: string | undefined;
  let orderSn: string | undefined;
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
  if (orderSn == null) throw new ArgumentoInvalidoError('--order-sn <orderSn> é obrigatório.');

  return {
    kind: 'importar',
    args: { integracaoId, orderSn, live, json, projectId: projectId ?? null },
  };
}

/* -------------------------------------------------------------------------- */
/*                            the redacted summary                             */
/* -------------------------------------------------------------------------- */

export interface LinhaResumoShopee {
  readonly ordem: number | null;
  readonly mktplaceId: string | null;
  readonly produtoUid: string | null;
  readonly sku: string | null;
  readonly gtin: string | null;
  readonly precoDeVenda: number | null;
  readonly descontoUnitario: number | null;
  readonly quantidade: number | null;
}

export interface VolumeResumoShopee {
  readonly numero: string | null;
  readonly pesoBrutoKg: number | null;
}

export interface FreteResumoShopee {
  readonly estado: string | null;
  readonly modalidade: string | null;
  readonly integradora: string | null;
  readonly externalId: string | null;
  readonly externalOptionId: string | null;
  readonly valorCobrado: number | null;
  readonly custoCalculado: number | null;
  readonly custoFinal: number | null;
  readonly codRastreio: string | null;
  readonly prazoDespachoUs: number | null;
  readonly dataPrevisaoEntregaUs: number | null;
  readonly ultimaModificacaoUs: number | null;
  readonly volumes: readonly VolumeResumoShopee[];
}

/** One pedido, reduced to what a rehearsal needs and nothing a buyer authored. */
export interface ResumoPedidoShopee {
  /** `mapeado` = what a write WOULD store; `armazenado` = what is stored. */
  readonly origem: 'mapeado' | 'armazenado';
  readonly pedidoId: string;
  readonly numero: string | null;
  readonly orderStatus: string | null;
  /** `mapeado` only — the estado the ladder targets, or why it refuses one. */
  readonly alvoEstado: string | null;
  /** `armazenado` only — the estado the document holds. */
  readonly estadoArmazenado: string | null;
  readonly lastMarketplaceUpdateUs: number | null;
  readonly timestampUs: number | null;
  readonly marketplace: {
    readonly tipo: string | null;
    readonly status: string | null;
    readonly statusEmUs: number | null;
    readonly pendingTerms: readonly string[] | null;
    readonly completedScenario: string | null;
    readonly cancelReason: string | null;
    readonly cancelBy: string | null;
  };
  readonly capturaComprador: {
    readonly estado: string | null;
    readonly statusObservado: string | null;
    readonly camposRecusados: readonly string[];
    readonly camposRecusadosExtra: readonly string[];
  };
  readonly erro: string | null;
  readonly valorCobrado: number | null;
  readonly descontoTotal: number | null;
  /** REDACTED: the character count, never the text. */
  readonly observacoesInternasChars: number | null;
  readonly integracaoPedidoOuterRef: string | null;
  readonly listaDePrecosOuterRef: string | null;
  readonly operacaoPedidoOuterRef: string | null;
  readonly clientePedidoOuterRef: string | null;
  readonly enderecoFiscalOuterRef: string | null;
  readonly ehSaida: boolean | null;
  readonly bloquearEmissaoNFe: boolean | null;
  readonly frete: FreteResumoShopee | null;
  readonly itens: readonly LinhaResumoShopee[];
}

/**
 * One pagamento, reduced the same ALLOW-LIST way (#1514, step 6).
 *
 * ⚠️ Three fields of the `cartao` block are the reason this type exists at all,
 * and all three are BOOLEANS:
 *
 *  - **`temCnpjInstituicao`, never the digits.** It is
 *    `payment_info[].payment_processor_register` — the payment processor's CNPJ.
 *    The importer's own log excludes it and a terminal transcript is pasted into
 *    issues exactly like a log stream is.
 *  - **`temCAut`, never the code.** `transaction_id` is the card authorization
 *    code; it reaches the signed XML and nowhere else.
 *  - **`temCartao`, never the block** — printing the map would carry both of the
 *    above by accident, which is the failure mode an allow-list exists to make
 *    impossible.
 *
 * `bandeira` DOES ride verbatim: it is a two-character CATALOGUE code
 * (`'01'`…`'99'`) from a closed enum, not a value anybody authored.
 */
export interface PagamentoResumoShopee {
  readonly docId: string;
  /** The `id` FIELD — `order_sn` on the primary, `<order_sn>-<n>` on a sibling. */
  readonly idCampo: string | null;
  readonly formaCodigo: number | null;
  readonly formaLabel: string | null;
  readonly statusCodigo: number | null;
  readonly statusLabel: string | null;
  readonly valor: number | null;
  readonly parcelas: number | null;
  readonly aVista: boolean | null;
  readonly tarifas: number | null;
  /** Forma 99 only — `Shopee: <método>`, and the NF-e's `xPag`. */
  readonly descricaoPagamento: string | null;
  readonly temCartao: boolean;
  readonly bandeira: string | null;
  readonly temCnpjInstituicao: boolean;
  readonly temCAut: boolean;
  readonly dataAprovacaoUs: number | null;
  readonly dataCancelamentoUs: number | null;
  /** Whether the weekly settlement sweep has already stamped this payment. */
  readonly temLiquidacao: boolean;
  /** The PRE-CLAMP `tarifas`, out of the `marketplace` diary. */
  readonly tarifasBrutas: number | null;
}

/* ------------------------------ raw readers ------------------------------- */

function texto(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function numero(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function booleano(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function textos(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function objeto(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/* ---------------------------- from the mapping ---------------------------- */

/** What `--dry-run` prints: the four write groups a live run would apply. */
export function resumoDoPedidoMapeado(
  pedidoId: string,
  mapeado: PedidoMapeadoShopee,
): ResumoPedidoShopee {
  const { sempre, dados, preencherUmaVez, criacao, alvo } = mapeado;
  return {
    origem: 'mapeado',
    pedidoId,
    numero: mapeado.numero,
    orderStatus: mapeado.orderStatus,
    alvoEstado: alvo.tipo === 'estado' ? alvo.estado : `(${alvo.tipo})`,
    estadoArmazenado: null,
    // The mapper writes ONE watermark for the document, and `orderPedidoTx`
    // asserts `marketplace.statusEm` equals it — so naming it twice here is a
    // rendering convenience, never a second source.
    lastMarketplaceUpdateUs: sempre.marketplace.statusEm,
    timestampUs: preencherUmaVez.timestamp,
    marketplace: {
      tipo: sempre.marketplace.tipo,
      status: sempre.marketplace.status,
      statusEmUs: sempre.marketplace.statusEm,
      pendingTerms: sempre.marketplace.pendingTerms,
      completedScenario: sempre.marketplace.completedScenario,
      cancelReason: sempre.marketplace.cancelReason,
      cancelBy: sempre.marketplace.cancelBy,
    },
    capturaComprador: {
      estado: sempre.capturaComprador.estado,
      statusObservado: sempre.capturaComprador.statusObservado,
      camposRecusados: sempre.capturaComprador.camposRecusados,
      camposRecusadosExtra: sempre.capturaComprador.camposRecusadosExtra,
    },
    erro: sempre.erro.tipo === 'definir' ? sempre.erro.mensagem : '(limpar-se-nosso)',
    valorCobrado: dados.valorCobrado,
    descontoTotal: dados.descontoTotal,
    observacoesInternasChars: dados.observacoesInternas?.length ?? null,
    integracaoPedidoOuterRef: preencherUmaVez.integracaoPedidoOuterRef,
    listaDePrecosOuterRef: preencherUmaVez.listaDePrecosOuterRef,
    operacaoPedidoOuterRef: preencherUmaVez.operacaoPedidoOuterRef,
    clientePedidoOuterRef: preencherUmaVez.clientePedidoOuterRef,
    enderecoFiscalOuterRef: preencherUmaVez.enderecoFiscalOuterRef,
    ehSaida: criacao.ehSaida,
    bloquearEmissaoNFe: criacao.bloquearEmissaoNFe,
    frete: {
      estado: dados.freteInicial.estado,
      modalidade: dados.freteInicial.modalidade,
      integradora: dados.freteInicial.externalOptionIntegracao,
      externalId: dados.freteInicial.externalId,
      externalOptionId: dados.freteInicial.externalOptionId,
      valorCobrado: dados.freteInicial.valorCobrado,
      custoCalculado: dados.freteInicial.custoCalculado,
      custoFinal: dados.freteInicial.custoFinal,
      codRastreio: dados.freteInicial.codRastreio,
      prazoDespachoUs: dados.freteInicial.prazoDespacho,
      dataPrevisaoEntregaUs: dados.freteInicial.dataPrevisaoEntrega,
      ultimaModificacaoUs: dados.freteInicial.ultimaModificacao,
      volumes: (dados.freteInicial.volumes ?? []).map((v) => ({
        numero: v.numero,
        pesoBrutoKg: v.pesoBruto,
      })),
    },
    itens: dados.itens.map((item) => ({
      ordem: item.ordem,
      mktplaceId: item.mktplaceId,
      produtoUid: item.produtoUid,
      sku: item.sku,
      gtin: item.gtin,
      precoDeVenda: item.precoDeVenda,
      descontoUnitario: item.descontoUnitario,
      quantidade: item.quantidade,
    })),
  };
}

/**
 * The pagamento set a live run WOULD write, straight off the pure mapper.
 *
 * ⚠️ `statusCodigo` is the LADDER'S TARGET, not a verdict: what actually lands
 * depends on what the document already holds, and only the transaction knows
 * that. `dataCancelamentoUs` and `temLiquidacao` are therefore always `null` /
 * `false` here — neither is knowable before the write.
 */
export function resumoDosPagamentosMapeados(
  mapeados: PagamentosMapeadosShopee,
): PagamentoResumoShopee[] {
  return mapeados.docs.map((m) => {
    const alvo = m.sempre.alvoStatus;
    const status = alvo.tipo === ALVO_STATUS_PAGAMENTO_SHOPEE.status ? alvo.status : null;
    return {
      docId: m.docId,
      idCampo: m.preencherUmaVez.id,
      formaCodigo: m.dados.forma_de_pagamento,
      formaLabel: FORMA_PAGAMENTO_LABELS[m.dados.forma_de_pagamento] ?? null,
      statusCodigo: status,
      statusLabel: status == null ? null : (STATUS_PAGAMENTO_LABELS[status] ?? null),
      valor: m.dados.valor,
      parcelas: m.dados.parcelas,
      aVista: m.dados.aVista,
      tarifas: m.sempre.tarifas ?? null,
      descricaoPagamento: m.dados.descricaoPagamento,
      temCartao: m.dados.cartao !== undefined,
      bandeira: m.dados.cartao?.bandeira ?? null,
      temCnpjInstituicao: m.dados.cartao?.cnpj_instituicao != null,
      temCAut: m.dados.cartao?.cAut != null,
      dataAprovacaoUs: m.datas.dataAprovacao ?? null,
      dataCancelamentoUs: null,
      temLiquidacao: false,
      tarifasBrutas: m.sempre.marketplace?.tarifasBrutas ?? null,
    };
  });
}

/**
 * The same summary read back from what Firestore actually holds — raw data, so
 * every field goes through a defensive reader and a document missing every key
 * still renders.
 *
 * ⚠️ It lists EVERY document in the subcollection, including a migrated legacy
 * `<order_sn>-desconto` sibling this importer never writes: the NF-e sums the
 * whole collection, so a rehearsal that hid the siblings would hide the only
 * thing that can put Σ pagante off the nota.
 */
export function resumoDosPagamentosArmazenados(
  docs: readonly { readonly id: string; readonly data: Record<string, unknown> }[],
): PagamentoResumoShopee[] {
  return docs.map(({ id, data }) => {
    const cartao = objeto(data.cartao);
    const marketplace = objeto(data.marketplace);
    const forma = numero(data.forma_de_pagamento);
    const status = numero(data.status_pagamento);
    return {
      docId: id,
      idCampo: texto(data.id),
      formaCodigo: forma,
      formaLabel: forma == null ? null : (FORMA_PAGAMENTO_LABELS[forma as FormaPagamento] ?? null),
      statusCodigo: status,
      statusLabel:
        status == null ? null : (STATUS_PAGAMENTO_LABELS[status as StatusPagamento] ?? null),
      valor: numero(data.valor),
      parcelas: numero(data.parcelas),
      aVista: booleano(data.aVista),
      tarifas: numero(data.tarifas),
      descricaoPagamento: texto(data.descricaoPagamento),
      temCartao: cartao !== null,
      bandeira: cartao === null ? null : texto(cartao.bandeira),
      temCnpjInstituicao: cartao !== null && texto(cartao.cnpj_instituicao) !== null,
      temCAut: cartao !== null && texto(cartao.cAut) !== null,
      dataAprovacaoUs: numero(data.dataAprovacao),
      dataCancelamentoUs: numero(data.dataCancelamento),
      temLiquidacao: objeto(data.liquidacao) !== null,
      tarifasBrutas: marketplace === null ? null : numero(marketplace.tarifasBrutas),
    };
  });
}

/* --------------------------- from the stored doc --------------------------- */

/**
 * The same summary, read back from what Firestore actually holds after a live
 * run — raw data, so every field goes through a defensive reader.
 *
 * ⚠️ It reads the STORED shape, not the mapped one: `itens` is a map keyed by
 * `produtoUid` (with the unbound lines under `NONE`) rather than a flat array.
 */
export function resumoDoPedidoArmazenado(
  pedidoId: string,
  doc: Record<string, unknown>,
): ResumoPedidoShopee {
  const marketplace = objeto(doc.marketplace) ?? {};
  const captura = objeto(doc.capturaComprador) ?? {};
  const frete = objeto(doc.freteInicial);

  return {
    origem: 'armazenado',
    pedidoId,
    numero: texto(doc.numero),
    orderStatus: texto(marketplace.status),
    alvoEstado: null,
    estadoArmazenado: texto(doc.estado),
    lastMarketplaceUpdateUs: numero(doc.lastMarketplaceUpdate),
    timestampUs: numero(doc.timestamp),
    marketplace: {
      tipo: texto(marketplace.tipo),
      status: texto(marketplace.status),
      statusEmUs: numero(marketplace.statusEm),
      pendingTerms: marketplace.pendingTerms == null ? null : textos(marketplace.pendingTerms),
      completedScenario: texto(marketplace.completedScenario),
      cancelReason: texto(marketplace.cancelReason),
      cancelBy: texto(marketplace.cancelBy),
    },
    capturaComprador: {
      estado: texto(captura.estado),
      statusObservado: texto(captura.statusObservado),
      camposRecusados: textos(captura.camposRecusados),
      camposRecusadosExtra: textos(captura.camposRecusadosExtra),
    },
    erro: texto(doc.error),
    valorCobrado: numero(doc.valorCobrado),
    descontoTotal: numero(doc.descontoTotal),
    observacoesInternasChars: texto(doc.observacoesInternas)?.length ?? null,
    integracaoPedidoOuterRef: texto(doc.integracaoPedidoOuterRef),
    listaDePrecosOuterRef: texto(doc.listaDePrecosOuterRef),
    operacaoPedidoOuterRef: texto(doc.operacaoPedidoOuterRef),
    clientePedidoOuterRef: texto(doc.clientePedidoOuterRef),
    enderecoFiscalOuterRef: texto(doc.enderecoFiscalOuterRef),
    ehSaida: booleano(doc.ehSaida),
    bloquearEmissaoNFe: booleano(doc.bloquearEmissaoNFe),
    frete:
      frete === null
        ? null
        : {
            estado: texto(frete.estado),
            modalidade: texto(frete.modalidade),
            integradora: texto(frete.externalOptionIntegracao),
            externalId: texto(frete.externalId),
            externalOptionId: texto(frete.externalOptionId),
            valorCobrado: numero(frete.valorCobrado),
            custoCalculado: numero(frete.custoCalculado),
            custoFinal: numero(frete.custoFinal),
            codRastreio: texto(frete.codRastreio),
            prazoDespachoUs: numero(frete.prazoDespacho),
            dataPrevisaoEntregaUs: numero(frete.dataPrevisaoEntrega),
            ultimaModificacaoUs: numero(frete.ultimaModificacao),
            volumes: (Array.isArray(frete.volumes) ? frete.volumes : []).map((v) => {
              const vol = objeto(v) ?? {};
              return { numero: texto(vol.numero), pesoBrutoKg: numero(vol.pesoBruto) };
            }),
          },
    itens: linhasDoArmazenado(doc.itens),
  };
}

/** The stored `itens` map, flattened and reduced. Defensive at every level. */
function linhasDoArmazenado(v: unknown): LinhaResumoShopee[] {
  const mapa = objeto(v);
  if (mapa === null) return [];
  const linhas: LinhaResumoShopee[] = [];
  for (const [chave, lista] of Object.entries(mapa)) {
    if (!Array.isArray(lista)) continue;
    for (const bruto of lista) {
      const item = objeto(bruto);
      if (item === null) continue;
      linhas.push({
        ordem: numero(item.ordem),
        mktplaceId: texto(item.mktplaceId),
        // The map key IS the produtoUid; `NONE` is the unbound bucket.
        produtoUid: texto(item.produtoUid) ?? (chave === 'NONE' ? null : chave),
        sku: texto(item.sku),
        gtin: texto(item.gtin),
        precoDeVenda: numero(item.precoDeVenda),
        descontoUnitario: numero(item.descontoUnitario),
        quantidade: numero(item.quantidade),
      });
    }
  }
  return linhas.sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0));
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

function qtd(v: number | null): string {
  return v == null ? '—' : String(v);
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

/**
 * The human rendering of a summary. Section headers name the WRITE GROUP each
 * field belongs to, which is true of the stored document as well — those groups
 * are what wrote it.
 */
export function renderResumoPedido(
  r: ResumoPedidoShopee,
  /**
   * The pagamentos (#1514, step 6). OMIT it and no `### pagamentos` section is
   * rendered at all — an empty ARRAY is a different fact (this order maps to no
   * payment) and does get its own section saying so.
   */
  pagamentos?: readonly PagamentoResumoShopee[],
): string[] {
  const linhas: string[] = [];
  linhas.push(
    r.origem === 'mapeado'
      ? '## O que uma gravação escreveria (nada foi gravado)'
      : '## O que está gravado no Firestore',
  );
  linhas.push(`  pedidoId ................ ${r.pedidoId}`);
  linhas.push(`  numero (order_sn) ....... ${txt(r.numero)}`);
  linhas.push(
    r.origem === 'mapeado'
      ? `  estado alvo ............. ${txt(r.alvoEstado)}`
      : `  estado .................. ${txt(r.estadoArmazenado)}`,
  );
  linhas.push(`  lastMarketplaceUpdate ... ${carimbo(r.lastMarketplaceUpdateUs)}`);

  linhas.push('');
  linhas.push('### grupo `sempre` — toda entrega aceita');
  linhas.push(`  marketplace.tipo ........ ${txt(r.marketplace.tipo)}`);
  linhas.push(`  marketplace.status ...... ${txt(r.marketplace.status)}`);
  linhas.push(`  marketplace.statusEm .... ${carimbo(r.marketplace.statusEmUs)}`);
  linhas.push(
    `  pendingTerms ............ ${r.marketplace.pendingTerms == null ? 'null (a Shopee não mandou o campo)' : JSON.stringify(r.marketplace.pendingTerms)}`,
  );
  linhas.push(`  completedScenario ....... ${txt(r.marketplace.completedScenario)}`);
  linhas.push(
    `  cancelReason / cancelBy . ${txt(r.marketplace.cancelReason)} / ${txt(r.marketplace.cancelBy)}`,
  );
  linhas.push(`  capturaComprador ........ ${txt(r.capturaComprador.estado)}`);
  linhas.push(`    statusObservado ....... ${txt(r.capturaComprador.statusObservado)}`);
  linhas.push(
    `    camposRecusados ....... ${r.capturaComprador.camposRecusados.length === 0 ? '(nenhum)' : r.capturaComprador.camposRecusados.join(', ')}`,
  );
  linhas.push(
    `    camposRecusadosExtra .. ${r.capturaComprador.camposRecusadosExtra.length === 0 ? '(nenhum)' : r.capturaComprador.camposRecusadosExtra.join(', ')}`,
  );
  linhas.push(`  error ................... ${txt(r.erro)}`);

  linhas.push('');
  linhas.push('### grupo `dados` — enquanto o operador não editou o pedido');
  linhas.push(`  valorCobrado ............ ${dinheiro(r.valorCobrado)}`);
  linhas.push(
    `  descontoTotal ........... ${dinheiro(r.descontoTotal)}   (a Shopee não tem desconto de pedido)`,
  );
  linhas.push(
    `  observacoesInternas ..... ${r.observacoesInternasChars == null ? 'null' : `«REDIGIDO — ${String(r.observacoesInternasChars)} caractere(s)»`}`,
  );

  linhas.push('');
  linhas.push('### bloco `freteInicial`');
  if (r.frete === null) {
    linhas.push('  (sem freteInicial)');
  } else {
    const f = r.frete;
    linhas.push(`  estado / modalidade ..... ${txt(f.estado)} / ${txt(f.modalidade)}`);
    linhas.push(`  integradora ............. ${txt(f.integradora)}`);
    linhas.push(`  externalId .............. ${txt(f.externalId)}   (package_number)`);
    linhas.push(`  externalOptionId ........ ${txt(f.externalOptionId)}   (logistics_channel_id)`);
    linhas.push(
      `  valorCobrado ............ ${dinheiro(f.valorCobrado)}   ← o que o comprador pagou`,
    );
    linhas.push(`  custoCalculado .......... ${dinheiro(f.custoCalculado)}`);
    linhas.push(`  custoFinal .............. ${dinheiro(f.custoFinal)}`);
    linhas.push(`  codRastreio ............. ${txt(f.codRastreio)}   (o step 7 é o dono)`);
    linhas.push(`  prazoDespacho ........... ${carimbo(f.prazoDespachoUs)}`);
    linhas.push(`  dataPrevisaoEntrega ..... ${carimbo(f.dataPrevisaoEntregaUs)}`);
    linhas.push(`  ultimaModificacao ....... ${carimbo(f.ultimaModificacaoUs)}`);
    if (f.volumes.length === 0) {
      linhas.push('  volumes ................. (nenhum)');
    } else {
      for (const v of f.volumes) {
        linhas.push(
          `  volume .................. ${txt(v.numero)}  pesoBruto=${qtd(v.pesoBrutoKg)} kg`,
        );
      }
    }
  }

  linhas.push('');
  linhas.push(`### itens (${String(r.itens.length)})`);
  if (r.itens.length === 0) {
    linhas.push('  (nenhum)');
  } else {
    linhas.push(
      '  ordem  produtoUid            sku                  qtd    preço      desconto   mktplaceId',
    );
    for (const i of r.itens) {
      linhas.push(
        `  ${String(i.ordem ?? '—').padEnd(6)} ${txt(i.produtoUid).padEnd(20)} ${txt(i.sku).padEnd(20)} ` +
          `${qtd(i.quantidade).padEnd(6)} ${dinheiro(i.precoDeVenda).padEnd(10)} ` +
          `${dinheiro(i.descontoUnitario).padEnd(10)} ${txt(i.mktplaceId)}`,
      );
    }
    linhas.push('  (o nome de venda é omitido de propósito — ver o cabeçalho do módulo)');
  }

  if (pagamentos !== undefined) {
    linhas.push('');
    linhas.push(`### pagamentos (${String(pagamentos.length)})`);
    if (pagamentos.length === 0) {
      linhas.push(
        r.origem === 'mapeado'
          ? '  (nenhum — a order não tem `pay_time` utilizável, então nada seria criado)'
          : '  (nenhum gravado)',
      );
    } else {
      for (const p of pagamentos) {
        linhas.push(`  docId ................... ${p.docId}`);
        linhas.push(`    id (campo) ............ ${txt(p.idCampo)}`);
        linhas.push(
          `    forma ................. ${p.formaCodigo == null ? '—' : String(p.formaCodigo)} ${txt(p.formaLabel)}`,
        );
        linhas.push(
          `    status ................ ${p.statusCodigo == null ? '—' : String(p.statusCodigo)} ${txt(p.statusLabel)}` +
            (r.origem === 'mapeado' ? '   (ALVO — a escada decide contra o gravado)' : ''),
        );
        linhas.push(
          `    valor ................. ${dinheiro(p.valor)}   parcelas=${qtd(p.parcelas)} aVista=${p.aVista == null ? '—' : String(p.aVista)}`,
        );
        linhas.push(
          `    tarifas ............... ${dinheiro(p.tarifas)}   bruto=${dinheiro(p.tarifasBrutas)}`,
        );
        linhas.push(`    descricaoPagamento .... ${txt(p.descricaoPagamento)}`);
        // ⚠️ Booleans, never the CNPJ and never the authorization code.
        linhas.push(
          `    cartao ................ ${p.temCartao ? 'sim' : 'não'}  bandeira=${txt(p.bandeira)}` +
            `  cnpj_instituicao=${p.temCnpjInstituicao ? 'presente' : '—'}  cAut=${p.temCAut ? 'presente' : '—'}`,
        );
        linhas.push(`    dataAprovacao ......... ${carimbo(p.dataAprovacaoUs)}`);
        linhas.push(`    dataCancelamento ...... ${carimbo(p.dataCancelamentoUs)}`);
        linhas.push(`    liquidação ............ ${p.temLiquidacao ? 'já liquidado' : 'pendente'}`);
      }
      linhas.push('  (o CNPJ do processador e o código de autorização são omitidos de propósito)');
    }
  }

  linhas.push('');
  linhas.push('### grupo `preencher-uma-vez` + criação');
  linhas.push(`  timestamp ............... ${carimbo(r.timestampUs)}`);
  linhas.push(`  integracaoPedidoOuterRef  ${txt(r.integracaoPedidoOuterRef)}`);
  linhas.push(`  listaDePrecosOuterRef ... ${txt(r.listaDePrecosOuterRef)}`);
  linhas.push(`  operacaoPedidoOuterRef .. ${txt(r.operacaoPedidoOuterRef)}`);
  linhas.push(`  clientePedidoOuterRef ... ${txt(r.clientePedidoOuterRef)}`);
  linhas.push(`  enderecoFiscalOuterRef .. ${txt(r.enderecoFiscalOuterRef)}`);
  linhas.push(
    `  ehSaida / bloquearNFe ... ${r.ehSaida == null ? '—' : String(r.ehSaida)} / ${r.bloquearEmissaoNFe == null ? 'null' : String(r.bloquearEmissaoNFe)}`,
  );
  if (r.origem === 'mapeado') {
    linhas.push('');
    linhas.push(
      '  ⚠️ Em dry-run o comprador NÃO é resolvido (isso seria uma escrita), então os dois',
    );
    linhas.push(
      '     outerRefs acima saem nulos mesmo numa order que a gravação de verdade vincularia.',
    );
    linhas.push('     Quem responde por isso é o veredito `capturaComprador` acima.');
  }
  return linhas;
}

/* -------------------------------------------------------------------------- */
/*                                   errors                                    */
/* -------------------------------------------------------------------------- */

/**
 * One failure, described by CLASS plus the fields that identify it — and never
 * a payload.
 *
 * ⚠️ Every Shopee `message` in the package is built from paths, codes and
 * statuses (`call.ts` says why: an aborted fetch's own message can echo the
 * request URL, which carries `access_token`), so printing it is safe while
 * printing a body never would be. `ShopeeNetworkError.cause` is deliberately
 * NOT printed for exactly that reason.
 *
 * ⚠️ The subclasses come FIRST: `ShopeeReauthRequiredError` and
 * `ShopeeRateLimitError` both extend `ShopeeApiError`.
 */
export function descreverErro(err: unknown): string[] {
  if (err instanceof ArgumentoInvalidoError) {
    return [`❌ ${err.message}`, '', USO_IMPORTAR_PEDIDO];
  }
  if (err instanceof ShopeeReauthRequiredError) {
    return [
      `❌ ShopeeReauthRequiredError — a autorização da loja acabou.`,
      `   code=${err.code} httpStatus=${String(err.httpStatus)} path=${err.path}`,
      `   ${err.message}`,
      '   Reconecte a conta (o painel /canais/shopee/<id>, ou o script oauth:url).',
    ];
  }
  if (err instanceof ShopeeRateLimitError) {
    return [
      `❌ ShopeeRateLimitError (${err.kind})`,
      `   code=${err.code} httpStatus=${String(err.httpStatus)} path=${err.path}` +
        ` retryAfter=${err.retryAfterSeconds == null ? '—' : String(err.retryAfterSeconds)}s`,
      `   ${err.message}`,
    ];
  }
  if (err instanceof ShopeeApiError) {
    return [
      `❌ ShopeeApiError (${err.kind})`,
      `   code=${err.code} httpStatus=${String(err.httpStatus)} path=${err.path}` +
        ` requestId=${err.requestId ?? '—'}`,
      `   ${err.message}`,
    ];
  }
  if (err instanceof ShopeeSchemaError) {
    return [
      '❌ ShopeeSchemaError — a resposta não bate com o schema.',
      `   httpStatus=${String(err.httpStatus)} path=${err.path}`,
      `   campos: ${err.campos.length === 0 ? '(nenhum)' : err.campos.join(', ')}`,
      `   ${err.message}`,
    ];
  }
  if (err instanceof ShopeeHttpError) {
    return [
      '❌ ShopeeHttpError',
      `   httpStatus=${String(err.httpStatus)} path=${err.path}`,
      `   ${err.message}`,
    ];
  }
  if (err instanceof ShopeeNetworkError) {
    // `cause` can echo the request URL, which carries the access token.
    return ['❌ ShopeeNetworkError', `   ${err.message}`];
  }
  if (err instanceof ShopeeError) {
    return [`❌ ${err.name}`, `   ${err.message}`];
  }
  if (err instanceof Error) {
    return [`❌ ${err.name}`, `   ${err.message}`];
  }
  return [`❌ erro não-Error: ${String(err)}`];
}
