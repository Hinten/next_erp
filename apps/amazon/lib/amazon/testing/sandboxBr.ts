/**
 * The models' BR sandbox cases for `getOrder` and `searchOrders`
 * (`orders_2026-01-01.json`; `node .master_plans/amazon/evidence/amazon-doc.mjs
 * sandbox getOrder orders` → 200 static[0], `… searchOrders orders` → 200
 * static[2]), transcribed KEY FOR KEY — **for tests only**: nothing outside a
 * `*.test.ts` imports this.
 *
 * ⚠️ PLACEHOLDERS ONLY (the repository is public). Every personal value is a
 * same-shape fake: names, e-mails, addresses, phones, postal codes, the
 * purchase-order number, the authorization code. The ids, ASINs, SKUs, titles
 * and the merchant's legal name are fakes too. The ONE document the case holds
 * as DV-valid (the acquirer's punctuated CNPJ) is made at RUN time
 * (`documentos.ts`), so no valid document is ever committed; the marketplace's
 * 8-digit CNPJ root and the buyer's 10-digit VAT keep their SHAPE only.
 * Amazon's own public values stay: the BR marketplace id, `Amazon.com.br`,
 * enums, dates and amounts.
 *
 * `redacao.test.ts` pins that each transcription has EXACTLY the leaf paths
 * the leaf inventory lists for the case (`exemplosBr`), so the structure stays
 * at parity with the model while every value is ours.
 */
import { gerarCnpj, pontuarCnpj } from './documentos';

/** `getOrder` 200 static[0]: a PRIME consumer order, with a gift message. */
export function getOrderBr(): { order: Record<string, unknown> } {
  return {
    order: {
      orderId: '123-4567890-1234567',
      orderAliases: [{ aliasId: 'BR-PEDIDO-TESTE-0003', aliasType: 'SELLER_ORDER_ID' }],
      createdTime: '2024-12-24T20:30:00Z',
      lastUpdatedTime: '2024-12-25T08:15:00Z',
      programs: ['PRIME'],
      salesChannel: {
        channelName: 'AMAZON',
        marketplaceId: 'A2Q3Y263D00KWC',
        marketplaceName: 'Amazon.com.br',
      },
      buyer: {
        buyerName: 'Compradora Ficticia Um',
        buyerEmail: 'compradora-ficticia@example.invalid',
      },
      recipient: {
        deliveryAddress: {
          name: 'Compradora Ficticia Um',
          addressLine1: 'Rua Ficticia, 100',
          addressLine2: 'Apartamento 10',
          addressLine3: '',
          city: 'Cidade Ficticia',
          districtOrCounty: '',
          stateOrRegion: 'SP',
          municipality: '',
          postalCode: '01000-000',
          countryCode: 'BR',
          phone: '+55 11 90000-0000',
          extendedFields: {
            streetName: 'Rua Ficticia',
            streetNumber: '100',
            complement: 'Apartamento 10',
            neighborhood: 'Bairro Ficticio',
          },
          addressType: 'RESIDENTIAL',
        },
      },
      proceeds: { grandTotal: { amount: '299.90', currencyCode: 'BRL' } },
      fulfillment: {
        fulfillmentStatus: 'UNSHIPPED',
        fulfilledBy: 'MERCHANT',
        fulfillmentServiceLevel: 'STANDARD',
        shipByWindow: {
          earliestDateTime: '2024-12-26T00:00:00Z',
          latestDateTime: '2024-12-27T23:59:59Z',
        },
        deliverByWindow: {
          earliestDateTime: '2024-12-28T00:00:00Z',
          latestDateTime: '2024-12-31T23:59:59Z',
        },
        labelPrintingWindow: { earliestDateTime: '2024-12-26T17:00:00Z' },
      },
      orderItems: [
        {
          // 14 digits that do NOT pass the CNPJ check (`redacao.test.ts` asserts it).
          orderItemId: '10000000000001',
          quantityOrdered: 1,
          product: {
            asin: 'B0TESTE001',
            title: 'Produto Ficticio de Teste',
            sellerSku: 'SKU-TESTE-0001',
            condition: { conditionType: 'NEW', conditionSubtype: 'NEW', conditionNote: '' },
            price: { unitPrice: { amount: '299.90', currencyCode: 'BRL' } },
          },
          proceeds: {
            proceedsTotal: { amount: '299.90', currencyCode: 'BRL' },
            breakdowns: [{ type: 'ITEM', subtotal: { amount: '299.90', currencyCode: 'BRL' } }],
          },
          promotion: { breakdowns: [{ promotionId: 'BR-PROMO-TESTE-01' }] },
          fulfillment: {
            quantityFulfilled: 0,
            quantityUnfulfilled: 1,
            packing: {
              giftOption: {
                giftMessage: 'Mensagem ficticia de presente',
                giftWrapLevel: 'STANDARD',
              },
            },
          },
        },
      ],
    },
  };
}

/**
 * `searchOrders` 200 static[2]: an AMAZON_BUSINESS order paid by card, with the
 * buyer's VAT, the marketplace's CNPJ root and the acquirer's CNPJ.
 */
export function searchOrdersBr(): { orders: Record<string, unknown>[]; createdBefore: string } {
  return {
    orders: [
      {
        orderId: '123-4567890-7654321',
        orderAliases: [{ aliasId: 'BR-PEDIDO-TESTE-0001', aliasType: 'SELLER_ORDER_ID' }],
        createdTime: '2024-12-22T15:30:00Z',
        lastUpdatedTime: '2024-12-23T10:00:00Z',
        programs: ['AMAZON_BUSINESS', 'DELIVERY_BY_AMAZON'],
        salesChannel: {
          channelName: 'AMAZON',
          marketplaceId: 'A2Q3Y263D00KWC',
          marketplaceName: 'Amazon.com.br',
        },
        buyer: {
          buyerName: 'Comprador Ficticio Dois',
          buyerEmail: 'comprador-ficticio@example.invalid',
          buyerCompanyName: 'Empresa Ficticia Ltda',
          buyerPurchaseOrderNumber: 'PO-TESTE-0000',
        },
        recipient: {
          deliveryAddress: {
            name: 'Comprador Ficticio Dois',
            companyName: 'Empresa Ficticia Ltda',
            addressLine1: 'Avenida Ficticia, 1000',
            addressLine2: 'Sala 300',
            city: 'Cidade Ficticia',
            stateOrRegion: 'SP',
            postalCode: '01000-000',
            countryCode: 'BR',
            phone: '+55 11 90000-0001',
            extendedFields: {
              streetName: 'Avenida Ficticia',
              streetNumber: '1000',
              complement: 'Sala 300',
              neighborhood: 'Bairro Ficticio',
            },
            addressType: 'COMMERCIAL',
          },
        },
        proceeds: { grandTotal: { amount: '1599.90', currencyCode: 'BRL' } },
        tax: {
          taxRegistrations: [
            {
              entityType: 'BUYER',
              legalName: 'Empresa Ficticia Ltda',
              taxRegistrationType: 'VAT',
              // The model's shape: 10 bare digits. No pattern catches it; the KEY does.
              taxRegistrationNumber: '9876501234',
            },
            {
              entityType: 'MARKETPLACE',
              taxRegistrationType: 'CNPJ',
              // An 8-digit CNPJ root, the model's shape. The KEY catches it.
              taxRegistrationNumber: '87654321',
            },
            { entityType: 'MERCHANT', legalName: 'Loja Ficticia Ltda' },
          ],
          taxInvoicing: { invoiceStatus: 'PROCESSING' },
        },
        payment: {
          paymentExecutions: [
            {
              paymentMethod: 'CreditCard',
              paymentAmount: { amount: '1599.90', currencyCode: 'BRL' },
              // DV-valid, made at run time (never committed).
              acquirerId: pontuarCnpj(gerarCnpj('987654320001')),
              cardBrand: 'Visa',
              authorizationCode: '000000',
            },
          ],
        },
        fulfillment: {
          fulfillmentStatus: 'UNSHIPPED',
          fulfilledBy: 'MERCHANT',
          fulfillmentServiceLevel: 'STANDARD',
          shipByWindow: {
            earliestDateTime: '2024-12-23T00:00:00Z',
            latestDateTime: '2024-12-24T23:59:59Z',
          },
          deliverByWindow: {
            earliestDateTime: '2024-12-26T00:00:00Z',
            latestDateTime: '2024-12-30T23:59:59Z',
          },
          promiseCalculationInputs: {
            transitTime: {
              details: { carrier: 'Transportadora Ficticia', shippingService: 'SERVICO' },
              dataSource: 'THIRD_PARTY_INTEGRATOR',
            },
          },
        },
        orderItems: [
          {
            orderItemId: '10000000000002',
            quantityOrdered: 1,
            product: {
              asin: 'B0TESTE002',
              title: 'Produto Ficticio Dois',
              sellerSku: 'SKU-TESTE-0002',
              condition: { conditionType: 'NEW', conditionSubtype: 'NEW' },
              price: {
                unitPrice: { amount: '1599.90', currencyCode: 'BRL' },
                priceDesignation: 'BUSINESS_PRICE',
              },
            },
            proceeds: {
              proceedsTotal: { amount: '1599.90', currencyCode: 'BRL' },
              breakdowns: [{ type: 'ITEM', subtotal: { amount: '1599.90', currencyCode: 'BRL' } }],
            },
            fulfillment: { quantityFulfilled: 0, quantityUnfulfilled: 1 },
          },
        ],
      },
    ],
    createdBefore: '2024-12-22T16:00:00Z',
  };
}
