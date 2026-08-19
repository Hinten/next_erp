/**
 * #1087 §7 — **did the order import everything, and is the money right?**
 *
 * `orderMapping.ts` and `orderPaymentMapping.ts` were ported verbatim from the
 * Flutter app and have never been checked against a real Mercado Livre order.
 * The formulas are not obviously right:
 *
 *   valorCobrado    = Σ transaction_amount + Σ shipping_cost − Σ coupon_amount
 *   precoDeVenda    = unit_price + Σ discounts[].amounts.full     ← a PLUS
 *   descontoTotal   = Σ payments[].coupon_amount                  ← order level
 *   descontoUnitario= Σ order_items[].discounts[].amounts.full    ← line level
 *
 * If ML's `transaction_amount` already includes shipping, or is already net of
 * the coupon, the first line double-counts. This script settles it by putting
 * the recomputed value next to ML's own `paid_amount` — the amount the buyer
 * actually paid — which the import already mirrors to
 * `pedidos/{pedidoId}/orderML/{orderId}`.
 *
 *   pnpm --filter @delfrance/mercado-livre-app inspect:pedido \
 *     --project <id> --pedidoId <id>
 *
 *   # …plus the raw ML order body, for the fixture capture in #1087 §9
 *   pnpm --filter @delfrance/mercado-livre-app inspect:pedido \
 *     --project <id> --pedidoId <id> --json
 *
 * ⚠️ **Strictly read-only.** It calls no Mercado Livre endpoint at all — every
 * input is already in Firestore, because the import mirrors the raw order body
 * on the way through. So it holds no token, refreshes nothing, and cannot
 * disturb the credential the deployed backend is using.
 *
 * ⚠️ `--project` is REQUIRED and never inferred.
 */
import type { QueryDocumentSnapshot } from 'firebase-admin/firestore';
import {
  orderMLCollection,
  pagamentoCollection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';
import { formatReais, roundReais } from '@delfrance/core/money';

import { getAdminFirestore } from '../lib/firebase/admin';

function log(message: string): void {
  // eslint-disable-next-line no-console -- CLI output
  console.log(message);
}

class InspectArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InspectArgError';
  }
}

interface Args {
  projectId: string;
  pedidoId: string;
  json: boolean;
}

function valueOf(name: string, inline: string | undefined, next: string | undefined): string {
  const raw = inline ?? next;
  if (raw == null || raw.startsWith('--')) {
    throw new InspectArgError(`--${name} exige um valor.`);
  }
  return raw;
}

function parseArgs(argv: readonly string[]): Args {
  let projectId: string | undefined;
  let pedidoId: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    switch (name) {
      case 'project':
        projectId = valueOf(name, inline, argv[i + 1]);
        break;
      case 'pedidoId':
        pedidoId = valueOf(name, inline, argv[i + 1]);
        break;
      case 'json':
        json = true;
        break;
      default:
        throw new InspectArgError(`Opção desconhecida: --${name}`);
    }
  }

  if (!projectId?.trim()) throw new InspectArgError('--project é obrigatório.');
  if (!pedidoId?.trim()) throw new InspectArgError('--pedidoId é obrigatório.');

  return { projectId: projectId.trim(), pedidoId: pedidoId.trim(), json };
}

/* --------------------------------- helpers --------------------------------- */

function fmt(v: unknown): string {
  if (v === undefined) return '—';
  if (v === null) return 'null';
  if (typeof v === 'string') return v.length > 56 ? `${v.slice(0, 53)}…` : v;
  return JSON.stringify(v);
}

function money(v: number | null | undefined): string {
  return v == null ? 'null' : formatReais(v);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function rows(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

/** `Σ discounts[].amounts.full` for one order line — the mapper's own reduce. */
function lineDiscount(line: Record<string, unknown>): number {
  return rows(line.discounts).reduce((sum, d) => {
    const amounts = d.amounts as Record<string, unknown> | null | undefined;
    return sum + num(amounts?.full);
  }, 0);
}

/** Compare a stored value against the recomputed one; `≠` marks a mismatch. */
function verdict(stored: unknown, esperado: number): string {
  if (typeof stored !== 'number') return '✗ ausente';
  return Math.abs(stored - esperado) < 0.005 ? '  confere' : '≠ DIVERGE';
}

/* ----------------------------------- main ---------------------------------- */

async function main(): Promise<void> {
  const { projectId, pedidoId, json } = parseArgs(process.argv.slice(2));
  process.env.FIREBASE_PROJECT_ID = projectId;

  const db = getAdminFirestore();

  const pedidoSnap = await pedidoCollection.docRef(db, {}, pedidoId).get();
  if (!pedidoSnap.exists) {
    log(`❌ pedido ${pedidoId} não existe.`);
    process.exitCode = 1;
    return;
  }
  const pedido = (pedidoSnap.data() ?? {}) as Record<string, unknown>;

  const orderSnaps = await orderMLCollection.ref(db, { pedidoId }).get();
  if (orderSnaps.empty) {
    log(`❌ pedido ${pedidoId} não tem espelho orderML — não veio do Mercado Livre.`);
    process.exitCode = 1;
    return;
  }

  log(`[inspect:pedido] project=${projectId} pedido=${pedidoId}`);
  log(
    `  numero=${fmt(pedido.numero)}  estado=${fmt(pedido.estado)}  ` +
      `orders=${orderSnaps.size}${orderSnaps.size > 1 ? ' (pack)' : ''}`,
  );

  if (json) {
    log('');
    log('## RAW — espelho orderML  (capture isto como fixture, #1087 §9)');
    log(
      JSON.stringify(
        orderSnaps.docs.map((d: QueryDocumentSnapshot) => d.data()),
        null,
        2,
      ),
    );
  }

  /* ------------------------------ the money map ----------------------------- */

  let totalTransacoes = 0;
  let totalFrete = 0;
  let totalCupom = 0;
  let mlPaidAmount = 0;
  let mlTotalAmount = 0;
  let temPaidAmount = false;

  log('');
  log('## Pagamentos da ordem — as entradas da conta');
  for (const d of orderSnaps.docs) {
    const order = d.data() as Record<string, unknown>;
    if (typeof order.paid_amount === 'number') {
      mlPaidAmount += order.paid_amount;
      temPaidAmount = true;
    }
    mlTotalAmount += num(order.total_amount);

    for (const p of rows(order.payments)) {
      totalTransacoes += num(p.transaction_amount);
      totalFrete += num(p.shipping_cost);
      totalCupom += num(p.coupon_amount);
      log(
        `  order=${d.id}  transaction_amount=${money(num(p.transaction_amount))}` +
          `  shipping_cost=${money(num(p.shipping_cost))}` +
          `  coupon_amount=${money(num(p.coupon_amount))}` +
          `  status=${fmt(p.status)}`,
      );
    }
  }

  const valorCobradoEsperado = roundReais(totalTransacoes + totalFrete - totalCupom);

  log('');
  log('## Dinheiro — armazenado × recalculado × o que o Mercado Livre diz');
  log(`  Σ transaction_amount           ${money(totalTransacoes)}`);
  log(`  Σ shipping_cost              + ${money(totalFrete)}`);
  log(`  Σ coupon_amount              − ${money(totalCupom)}`);
  log(`  ${'-'.repeat(46)}`);
  log(
    `  valorCobrado   armazenado=${money(pedido.valorCobrado as number | null)}` +
      `  recalculado=${money(valorCobradoEsperado)}   ${verdict(pedido.valorCobrado, valorCobradoEsperado)}`,
  );
  log(
    `  descontoTotal  armazenado=${money(pedido.descontoTotal as number | null)}` +
      `  recalculado=${money(roundReais(totalCupom))}   ${verdict(pedido.descontoTotal, roundReais(totalCupom))}`,
  );
  log(
    `  valorFrete     armazenado=${money(pedido.valorFreteInicial as number | null)}` +
      `  recalculado=${money(roundReais(totalFrete))}   ${verdict(pedido.valorFreteInicial, roundReais(totalFrete))}`,
  );

  log('');
  log('  ⚠️ A PERGUNTA QUE ESTE SCRIPT EXISTE PARA RESPONDER:');
  log(`     ML total_amount = ${money(mlTotalAmount)}`);
  log(
    `     ML paid_amount  = ${temPaidAmount ? money(mlPaidAmount) : 'ausente'}   ← o que o comprador pagou`,
  );
  log(`     nosso valorCobrado = ${money(pedido.valorCobrado as number | null)}`);
  if (temPaidAmount && typeof pedido.valorCobrado === 'number') {
    const delta = roundReais(pedido.valorCobrado - mlPaidAmount);
    log(
      delta === 0
        ? '     ✅ IGUAIS — a fórmula herdada do Flutter está correta para este pedido.'
        : `     ❌ DIFERENÇA de ${money(delta)} — a fórmula soma frete e subtrai cupom por cima ` +
            'de um transaction_amount que talvez já os contenha. Registre isto em LIVE-TEST.md §7.1.',
    );
  }

  /* --------------------------------- itens --------------------------------- */

  const itensMap = (pedido.itens ?? {}) as Record<string, unknown>;
  const itens = Object.values(itensMap).flatMap((v) => rows(v));
  log('');
  log(`## Itens do pedido — ${itens.length} linha(s)`);
  for (const item of itens) {
    log(
      `  ordem=${fmt(item.ordem)}  sku=${fmt(item.sku)}  mktplaceId=${fmt(item.mktplaceId)}` +
        `  qtd=${fmt(item.quantidade)}  precoDeVenda=${money(item.precoDeVenda as number | null)}` +
        `  descontoUnitario=${money(item.descontoUnitario as number | null)}` +
        `  produtoUid=${fmt(item.produtoUid)}`,
    );
    if (item.produtoUid == null) {
      log('    ✗ linha SEM produto vinculado — deve existir um incidente explicando por quê');
    }
  }

  log('');
  log('## Linhas da ordem no ML — a origem de cada preço');
  for (const d of orderSnaps.docs) {
    for (const line of rows((d.data() as Record<string, unknown>).order_items)) {
      const desconto = lineDiscount(line);
      const unit = num(line.unit_price);
      const it = line.item as Record<string, unknown> | null | undefined;
      log(
        `  order=${d.id}  item=${fmt(it?.id)}  variation=${fmt(it?.variation_id)}` +
          `  seller_sku=${fmt(it?.seller_sku)}  quantity=${fmt(line.quantity)}`,
      );
      log(
        `    unit_price=${money(unit)}  Σdiscounts.full=${money(desconto)}` +
          `  ⇒ precoDeVenda esperado=${money(roundReais(unit + desconto))}` +
          `  (full_unit_price=${fmt(line.full_unit_price)})`,
      );
      if (desconto < 0) {
        log(
          '    ⚠️ desconto NEGATIVO — a fórmula SOMA discounts.full, então o sinal inverte o resultado.',
        );
      }
    }
  }

  /* ------------------------------- pagamentos ------------------------------ */

  const pagSnaps = await pagamentoCollection.ref(db, { pedidoId }).get();
  log('');
  log(`## Pagamentos gravados — ${pagSnaps.size}`);
  for (const d of pagSnaps.docs) {
    const p = d.data() as Record<string, unknown>;
    log(
      `  id=${d.id}  valor=${money(p.valor as number | null)}  tarifas=${money(p.tarifas as number | null)}` +
        `  parcelas=${fmt(p.parcelas)}  status=${fmt(p.status)}  forma=${fmt(p.forma_de_pagamento)}`,
    );
  }

  /* ------------------------- why the pedido may be stuck -------------------- */

  log('');
  log('## Pré-requisitos do estado `pago`');
  const frete = pedido.freteInicial as Record<string, unknown> | null;
  const check = (ok: boolean, label: string) => log(`  ${ok ? '✔' : '✗'} ${label}`);
  check(
    pedido.estado === 'emProcessamento' || pedido.estado === 'pago',
    `estado = ${fmt(pedido.estado)}`,
  );
  check(pedido.clientePedidoOuterRef != null, 'cliente vinculado');
  check(pedido.enderecoFiscalOuterRef != null, 'endereço fiscal');
  check(frete != null, 'freteInicial');
  if (frete != null) {
    log(
      `    externalId=${fmt(frete.externalId)}  codRastreio=${fmt(frete.codRastreio)}` +
        `  estado=${fmt(frete.estado)}  prazoDespacho=${fmt(frete.prazoDespacho)}`,
    );
  }
  log('  Um ✗ acima é exatamente por que o pedido não avança — ver LIVE-TEST.md §7.1.');
}

await main();
