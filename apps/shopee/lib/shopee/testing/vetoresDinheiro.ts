/**
 * Money vectors for the order import's money model (`pedidos/dinheiroShopee.ts`)
 * — test-only, imported by no `src` file (the `fakeDb.ts` precedent).
 *
 * The four `REAIS` vectors are the AMOUNTS of four real BR orders Lucas replayed
 * on 2026-11-24 (one line each, quantity 1, no seller or Shopee discount, no PIX
 * or payment promotion, `buyer_paid_shipping_fee: 0`). Amounts only: every id,
 * `order_sn`, SKU and name here is synthetic, and no buyer field exists at all.
 * The synthetic vectors cover the arms the four real ones never reach.
 */
import {
  shopeeEscrowDetailPayloadSchema,
  shopeeOrderDetailRowSchema,
  type ShopeeEscrowDetail,
  type ShopeeOrderDetailRow,
} from '@delfrance/integrations-shopee';

/** One order's money, one line. */
export interface VetorDinheiroShopee {
  readonly nome: string;
  readonly quantidade: number;
  /** The line's `original_price` and `discounted_price` — escrow LINE totals. */
  readonly original: number;
  readonly discounted: number;
  readonly voucherShopee: number;
  readonly voucherSeller: number;
  readonly coin: number;
  readonly sellerDiscount: number;
  readonly pixDiscount: number;
  readonly buyerPaidShipping: number;
  readonly buyerTotal: number;
  readonly escrowAmount: number;
  readonly estimado: number;
  readonly actualDetalhe: number;
  readonly actualEscrow: number;
  readonly commission: number;
  readonly service: number;
  readonly netCommission: number | null;
  readonly netService: number | null;
  readonly ads: number;
  readonly protecao: number;
  readonly coins: number;
  readonly voucherFromShopee: number;
}

const BASE: VetorDinheiroShopee = {
  nome: 'base',
  quantidade: 1,
  original: 100,
  discounted: 100,
  voucherShopee: 0,
  voucherSeller: 0,
  coin: 0,
  sellerDiscount: 0,
  pixDiscount: 0,
  buyerPaidShipping: 0,
  buyerTotal: 100,
  escrowAmount: 80,
  estimado: 9,
  actualDetalhe: 9,
  actualEscrow: 9,
  commission: 12,
  service: 8,
  netCommission: null,
  netService: null,
  ads: 0,
  protecao: 0,
  coins: 0,
  voucherFromShopee: 0,
};

/** A synthetic vector: {@link BASE} with the fields that matter overridden. */
export function vetor(over: Partial<VetorDinheiroShopee>): VetorDinheiroShopee {
  return { ...BASE, ...over };
}

/** The four real BR orders' amounts, and what the fix must produce on each. */
export const VETORES_REAIS_BR: readonly (VetorDinheiroShopee & {
  readonly esperado: { readonly descontoUnitario: number; readonly tarifas: number };
})[] = [
  {
    ...vetor({
      nome: 'real-1 (cartão, frete grátis)',
      original: 78.84,
      discounted: 78.84,
      buyerTotal: 78.84,
      escrowAmount: 54.64,
      estimado: 9.62,
      actualDetalhe: 0,
      actualEscrow: 9.62,
      commission: 14.66,
      service: 9.54,
      netCommission: 14.66,
      netService: 9.54,
    }),
    esperado: { descontoUnitario: 0, tarifas: 24.2 },
  },
  {
    ...vetor({
      nome: 'real-2 (PIX, frete grátis)',
      original: 37.71,
      discounted: 37.71,
      buyerTotal: 37.71,
      escrowAmount: 22.65,
      estimado: 10.83,
      actualDetalhe: 10.83,
      actualEscrow: 10.83,
      commission: 7.01,
      service: 6.92,
      ads: 1.13,
    }),
    esperado: { descontoUnitario: 0, tarifas: 15.06 },
  },
  {
    ...vetor({
      nome: 'real-3 (PIX, voucher Shopee 2,64)',
      original: 53.87,
      discounted: 53.87,
      voucherShopee: 2.64,
      buyerTotal: 51.23,
      escrowAmount: 33.8,
      estimado: 7.18,
      actualDetalhe: 7.18,
      actualEscrow: 7.18,
      commission: 10.02,
      service: 7.94,
      netCommission: 8.2,
      netService: 7.12,
      ads: 1.62,
      protecao: 0.49,
      voucherFromShopee: 2.64,
    }),
    esperado: { descontoUnitario: 2.64, tarifas: 17.43 },
  },
  {
    ...vetor({
      nome: 'real-4 (PIX, voucher Shopee 6,30 + moedas 0,03)',
      original: 78.84,
      discounted: 78.84,
      voucherShopee: 6.3,
      coin: 0.03,
      buyerTotal: 72.51,
      escrowAmount: 51.78,
      estimado: 8.39,
      actualDetalhe: 8.39,
      actualEscrow: 8.39,
      commission: 14.66,
      service: 9.54,
      netCommission: 9.84,
      netService: 8.06,
      ads: 2.37,
      protecao: 0.49,
      coins: 0.03,
      voucherFromShopee: 6.3,
    }),
    esperado: { descontoUnitario: 6.33, tarifas: 20.73 },
  },
];

const ITEM_ID = 900001;
const MODEL_ID = 0;

/** The `get_order_detail` row of a vector (synthetic ids, BR, paid). */
export function detalheDoVetor(
  v: VetorDinheiroShopee,
  over: Record<string, unknown> = {},
): ShopeeOrderDetailRow {
  return shopeeOrderDetailRowSchema.parse({
    order_sn: 'VETOR0000000001',
    order_status: 'READY_TO_SHIP',
    region: 'BR',
    currency: 'BRL',
    pay_time: 1_788_973_353,
    update_time: 1_788_973_354,
    total_amount: v.buyerTotal,
    estimated_shipping_fee: v.estimado,
    actual_shipping_fee: v.actualDetalhe,
    payment_method: 'Pix',
    item_list: [
      {
        item_id: ITEM_ID,
        model_id: MODEL_ID,
        model_quantity_purchased: v.quantidade,
        model_original_price: v.original / v.quantidade,
        model_discounted_price: v.discounted / v.quantidade,
      },
    ],
    ...over,
  });
}

/** The `get_escrow_detail` payload of a vector. */
export function escrowDoVetor(
  v: VetorDinheiroShopee,
  over: Record<string, unknown> = {},
): ShopeeEscrowDetail {
  return shopeeEscrowDetailPayloadSchema.parse({
    order_sn: 'VETOR0000000001',
    order_income: {
      buyer_total_amount: v.buyerTotal,
      escrow_amount: v.escrowAmount,
      escrow_amount_after_adjustment: v.escrowAmount,
      buyer_paid_shipping_fee: v.buyerPaidShipping,
      estimated_shipping_fee: v.estimado,
      actual_shipping_fee: v.actualEscrow,
      commission_fee: v.commission,
      service_fee: v.service,
      seller_transaction_fee: 0,
      ...(v.netCommission === null ? {} : { net_commission_fee: v.netCommission }),
      ...(v.netService === null ? {} : { net_service_fee: v.netService }),
      ads_escrow_top_up_fee_or_technical_support_fee: v.ads,
      shipping_seller_protection_fee_amount: v.protecao,
      coins: v.coins,
      voucher_from_shopee: v.voucherFromShopee,
      voucher_from_seller: v.voucherSeller,
      pix_discount: v.pixDiscount,
      payment_promotion: 0,
      buyer_payment_method: 'Pix',
      items: [
        {
          item_id: ITEM_ID,
          model_id: MODEL_ID,
          quantity_purchased: v.quantidade,
          original_price: v.original,
          discounted_price: v.discounted,
          seller_discount: v.sellerDiscount,
          shopee_discount: 0,
          discount_from_coin: v.coin,
          discount_from_voucher_shopee: v.voucherShopee,
          discount_from_voucher_seller: v.voucherSeller,
        },
      ],
    },
    ...over,
  });
}
