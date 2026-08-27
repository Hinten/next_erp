/**
 * #1087 §7 — **did the order import everything, and is the money right?**
 *
 * ⚠️ **`pedido.valorCobrado` has TWO owners, and reconciling against the wrong
 * one manufactures findings.** That mistake cost an hour on the 2026-08-27 run,
 * so the layout below exists to make it unrepeatable:
 *
 *  - **Formula A — the create-time seed** (`orderMapping.ts`,
 *    `mlOrderToPedidoCoreFields`): `Σ transaction_amount + Σ shipping_cost −
 *    Σ coupon_amount`, written ONCE by `orderPedidoTx.ts` and, on a **pack**,
 *    computed from `orders[0]` ALONE.
 *  - **Formula B — the frete conference takes ownership** (`orderImport.ts`,
 *    `applyFreteStep`): `Σ itemSubtotal + freteInicial.valorCobrado`. From the
 *    first shipment payload onward this is what is stored, and it is the
 *    legacy meaning of the field — `Pedido.total`, *"valor final cobrado no
 *    pedido"*, i.e. **what the customer owes us, freight included**.
 *
 * So A and B are NOT expected to agree, and a mismatch between them is not a
 * defect. They coincide only when the freight rode the order's own payments.
 * They diverge — correctly — on a **pack**, where Mercado Livre bills shipping
 * once on the SHIPMENT: each order's payment then carries `shipping_cost: 0`,
 * the freight arrives as an approved `GET /shipments/{id}/payments` entry, and
 * `Σ paid_amount` (order-scoped) structurally cannot see it.
 *
 * ⚠️ **Which one is the owner is decided by the frete block, and the verdict
 * follows the owner.** With no `freteInicial` the conference has not run, A is
 * still the owner, and judging by B would be short by exactly the freight — a
 * phantom on a healthy pedido. So this script judges A before the conference
 * and the canonical `derivePedidoFreteTotals` after it, plus the `pago`
 * threshold in both cases; the formula that is not the owner is printed for
 * context only.
 *
 * ⚠️ The row this script reconciles against post-conference is the **canonical
 * derive**, `Σ itemSubtotal − descontoTotal + frete` — which `applyFreteStep`
 * now shares. It used to omit the coupon term, so a pedido written by the old
 * code can still be off by exactly the coupon; the script names that gap rather
 * than calling it a finding.
 *
 * ⚠️ `descontoTotal` gets NO verdict on a pack: it is written once at create
 * from `orders[0]` alone, while the sum here spans every order in the mirror.
 *
 * The line-level formulas are still worth eyeballing:
 *
 *   precoDeVenda    = unit_price + Σ discounts[].amounts.full     ← a PLUS
 *   descontoTotal   = Σ payments[].coupon_amount                  ← order level
 *   descontoUnitario= Σ order_items[].discounts[].amounts.full    ← line level
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
import { STATUS_PAGAMENTO, flattenPedidoItens, type ItemDoPedido } from '@delfrance/schemas';

import {
  auditarDescontoTotal,
  auditarValorCobrado,
  type VeredictoValorCobrado,
} from '../lib/marketplace/pedidos/pedidoMoneyAudit';
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

/** One-column rendering of an audited verdict. */
function vereditoValorCobrado(v: VeredictoValorCobrado): string {
  switch (v.tipo) {
    case 'ausente':
      return '✗ ausente';
    case 'confere':
      return '  confere';
    case 'diferenca-conhecida':
      return '~ conhecida';
    case 'achado':
      return '≠ DIVERGE';
  }
}

/** True when two reais figures agree to the cent. */
function bate(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

/**
 * The pedido's frete block, narrowed to the three money fields the totals read.
 * Raw Firestore data — read defensively, exactly like every other row here.
 */
function freteDoPedido(pedido: Record<string, unknown>): {
  valorCobrado: number | null;
  custoCalculado: number | null;
  custoFinal: number | null;
} | null {
  const frete = pedido.freteInicial as Record<string, unknown> | null | undefined;
  if (frete == null) return null;
  const numeroOuNulo = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  return {
    valorCobrado: numeroOuNulo(frete.valorCobrado),
    custoCalculado: numeroOuNulo(frete.custoCalculado),
    custoFinal: numeroOuNulo(frete.custoFinal),
  };
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
  /** Per-order coupon totals — `descontoTotal` only ever holds ONE order's. */
  const cupomPorOrdem = new Map<string, number>();

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
      cupomPorOrdem.set(d.id, roundReais((cupomPorOrdem.get(d.id) ?? 0) + num(p.coupon_amount)));
      log(
        `  order=${d.id}  transaction_amount=${money(num(p.transaction_amount))}` +
          `  shipping_cost=${money(num(p.shipping_cost))}` +
          `  coupon_amount=${money(num(p.coupon_amount))}` +
          `  status=${fmt(p.status)}`,
      );
    }
  }

  /* ---- the frete block: what we CHARGE for shipping, and what it COSTS ---- */

  const freteMoney = freteDoPedido(pedido);
  const freteCobrado = freteMoney?.valorCobrado ?? 0;

  log('');
  log('## Frete — o bloco `freteInicial` (a fonte do valor cobrado de frete)');
  if (freteMoney == null) {
    log('  (sem freteInicial — a conferência do envio ainda não rodou)');
  } else {
    log(
      `  valorCobrado=${money(freteMoney.valorCobrado)}   ← Σ shipping_payments aprovados` +
        `  |  custoCalculado=${money(freteMoney.custoCalculado)}  custoFinal=${money(freteMoney.custoFinal)}` +
        '   ← o que o envio CUSTA',
    );
  }

  /* ------------------------ the two reconciliations ------------------------ */

  const itensDoPedido = flattenPedidoItens(
    (pedido.itens ?? {}) as Record<string, ItemDoPedido[]>,
  ) as ItemDoPedido[];
  const descontoTotal = num(pedido.descontoTotal);
  const ehPack = orderSnaps.size > 1;

  // ⚠️ The decisions live in `lib/marketplace/pedidos/pedidoMoneyAudit.ts`, and
  // deliberately not here: `scripts/` is outside this app's vitest `include`, so
  // logic written in this file can never be tested. Everything below is
  // rendering.
  const auditoria = auditarValorCobrado({
    valorCobradoArmazenado: pedido.valorCobrado,
    itens: itensDoPedido,
    descontoTotal,
    frete: freteMoney,
    totalTransacoes,
    totalShippingCost: totalFrete,
    totalCupom,
  });

  log('');
  log(
    auditoria.dono === 'conferencia'
      ? '## Dinheiro — o derive canônico `derivePedidoFreteTotals` (o DONO, pós-conferência)'
      : '## Dinheiro — a fórmula A ainda é a DONA (o frete não chegou; sem conferência)',
  );

  if (auditoria.dono === 'conferencia') {
    log('   `valorCobrado` = Σ itemSubtotal − descontoTotal + freteInicial.valorCobrado');
    log(
      `  Σ itemSubtotal                 ${money(auditoria.canonico - freteCobrado + descontoTotal)}`,
    );
    log(`  descontoTotal                − ${money(descontoTotal)}`);
    log(`  freteInicial.valorCobrado    + ${money(freteCobrado)}`);
  } else {
    log('   `valorCobrado` = Σ transaction_amount + Σ shipping_cost − Σ coupon_amount');
    log(`  Σ transaction_amount           ${money(totalTransacoes)}`);
    log(`  Σ shipping_cost              + ${money(totalFrete)}`);
    log(`  Σ coupon_amount              − ${money(totalCupom)}`);
  }
  log(`  ${'-'.repeat(46)}`);
  log(
    `  valorCobrado   armazenado=${money(pedido.valorCobrado as number | null)}` +
      `  recalculado=${money(auditoria.esperado)}   ${vereditoValorCobrado(auditoria.veredicto)}`,
  );

  const v = auditoria.veredicto;
  if (v.tipo === 'diferenca-conhecida') {
    log(
      `     ⚠️ a diferença é EXATAMENTE o descontoTotal (${money(v.descontoTotal)}) — conhecido: ` +
        '`applyFreteStep` não subtrai o cupom, ao contrário de `derivePedidoFreteTotals`. ' +
        'Quem financia o cupom do ML decide qual está certo (LIVE-TEST §7.1, passo 6.3).',
    );
  } else if (v.tipo === 'achado') {
    log(
      `     ❌ diferença de ${money(v.gap)} — isto sim é um achado. Registre em LIVE-TEST.md §7.1.`,
    );
  }

  if (auditoria.dono === 'semente') {
    if (ehPack) {
      log(
        '     ⚠️ num PACK a semente foi gravada com `orders[0]` SOZINHO, e a soma acima percorre ' +
          'TODAS as ordens — confira o veredito contra UMA ordem, não contra o pack.',
      );
    }
    log(
      `     Quando a conferência do envio rodar, o valor passa a ser ${money(auditoria.canonico)} ` +
        '+ o frete do envio. Nada a fazer até lá.',
    );
  }

  /* ---- descontoTotal: judged only where the writer and the sum agree ------ */

  const cupom = auditarDescontoTotal({
    descontoTotalArmazenado: pedido.descontoTotal,
    totalCupom,
    ehPack,
  });
  if (cupom.tipo === 'sem-veredito-pack') {
    log(
      `  descontoTotal  armazenado=${money(pedido.descontoTotal as number | null)}` +
        `  Σ do pack=${money(cupom.somaDoPack)}   (sem veredito — ver abaixo)`,
    );
    log(
      `     cupom por ordem: ${
        cupomPorOrdem.size > 0
          ? [...cupomPorOrdem].map(([id, valor]) => `${id}=${money(valor)}`).join('  ')
          : '(nenhum)'
      }`,
    );
    log(
      '     `descontoTotal` é gravado UMA vez, na criação, a partir de `orders[0]` sozinho ' +
        '(`orderPedidoTx`), e nunca é recalculado — bater com UMA ordem só é o esperado.',
    );
  } else {
    log(
      `  descontoTotal  armazenado=${money(pedido.descontoTotal as number | null)}` +
        `  recalculado=${money(roundReais(totalCupom))}   ` +
        `${cupom.tipo === 'confere' ? '  confere' : cupom.tipo === 'ausente' ? '✗ ausente' : '≠ DIVERGE'}`,
    );
  }

  if (auditoria.dono === 'conferencia') {
    log('');
    log('## Fórmula A — a SEMENTE de criação, só para contexto (NÃO é um veredito)');
    log(`  Σ transaction_amount           ${money(totalTransacoes)}`);
    log(`  Σ shipping_cost              + ${money(totalFrete)}`);
    log(`  Σ coupon_amount              − ${money(totalCupom)}`);
    log(`  ${'-'.repeat(46)}`);
    log(`  semente (fórmula A)            ${money(auditoria.semente)}`);
    log(
      `  Só se esperava que batesse com o armazenado ANTES da conferência do envio rodar — e, ` +
        'num PACK, ela foi calculada com `orders[0]` SOZINHO.',
    );
  }

  log('');
  log('  ⚠️ O QUE O COMPRADOR PAGOU × O QUE COBRAMOS:');
  log(`     ML total_amount = ${money(mlTotalAmount)}   (Σ dos itens, por ordem)`);
  log(
    `     ML paid_amount  = ${temPaidAmount ? money(mlPaidAmount) : 'ausente'}   ← por ORDEM: não ` +
      'enxerga um pagamento de frete feito no ENVIO',
  );
  log(`     nosso valorCobrado = ${money(pedido.valorCobrado as number | null)}`);
  if (temPaidAmount && typeof pedido.valorCobrado === 'number') {
    const delta = roundReais((pedido.valorCobrado as number) - mlPaidAmount);
    if (bate(delta, 0)) {
      log('     ✅ IGUAIS — o frete veio nos pagamentos da própria ordem.');
    } else if (bate(delta, freteCobrado)) {
      log(
        `     ✅ a diferença é EXATAMENTE o frete (${money(freteCobrado)}) — esperado: o Mercado ` +
          'Livre cobra o frete UMA vez, no envio, então `shipping_cost` fica 0 em cada ordem e ' +
          'o pagamento aparece em `GET /shipments/{id}/payments`. É a forma normal de um PACK.',
      );
    } else {
      log(
        `     ❌ diferença de ${money(delta)}, que não é 0 nem o frete (${money(freteCobrado)}) — ` +
          'isto sim é um achado. Registre em LIVE-TEST.md §7.1.',
      );
    }
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
  let totalAprovado = 0;
  for (const d of pagSnaps.docs) {
    const p = d.data() as Record<string, unknown>;
    const aprovado = p.status_pagamento === STATUS_PAGAMENTO.aprovado;
    if (aprovado) totalAprovado += num(p.valor);
    log(
      `  id=${d.id}  valor=${money(p.valor as number | null)}  tarifas=${money(p.tarifas as number | null)}` +
        // The field is `status_pagamento`; a bare `status` was always undefined.
        `  parcelas=${fmt(p.parcelas)}  status_pagamento=${fmt(p.status_pagamento)}` +
        `${aprovado ? ' (aprovado)' : ''}  forma=${fmt(p.forma_de_pagamento)}`,
    );
  }
  totalAprovado = roundReais(totalAprovado);

  // The actual `pago` gate on both ML paths: `totalAprovado >= valorCobrado`,
  // APPROVED-ONLY (#791/O13) — stricter than the null-tolerant
  // `sumPagamentosPagos` the web footer and the generic reconcile use, so this
  // number can be lower than the "Vlr. Pago" on screen.
  log('');
  log('## Limiar do `pago` — Σ pagamentos APROVADOS × valorCobrado');
  log(`  Σ aprovados    ${money(totalAprovado)}`);
  log(`  valorCobrado   ${money(pedido.valorCobrado as number | null)}`);
  if (typeof pedido.valorCobrado === 'number') {
    const falta = roundReais((pedido.valorCobrado as number) - totalAprovado);
    log(
      falta > 0.005
        ? `  ✗ faltam ${money(falta)} — o pedido NÃO pode avançar para \`pago\``
        : `  ✔ coberto${falta < -0.005 ? ` (troco de ${money(-falta)})` : ' exatamente'}`,
    );
  } else {
    log('  ✗ valorCobrado ausente — o avanço exige um valor não-nulo (#791)');
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
