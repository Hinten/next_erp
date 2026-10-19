import { describe, expect, it } from 'vitest';

import { PLACEHOLDERS_DOCUMENTO_AMAZON } from '../core/redacao';
import { criarListaDeNomes, piiScan } from '../fixtures/piiScan';
import { gerarCnpj, gerarCpf, pontuarCnpj, pontuarCpf } from '../testing/documentos';
import { getOrderBr, searchOrdersBr } from '../testing/sandboxBr';
import {
  type CapturaAmazon,
  capturaParaFixture,
  contarInteirosInseguros,
} from './capturaParaFixture';
import { FORMATO_FALSO_PEDIDO, TAMANHO_DO_SAL, criarFalsificadorAmazon } from './falsificacao';

const b = (t: string) => new TextEncoder().encode(t);
const CPF = gerarCpf('529982247');
const CNPJ = gerarCnpj('000001234567');
const LISTA = criarListaDeNomes(['Termo Ficticio Zeta']);
const MTIME = Date.UTC(2026, 9, 19);
const GET_ORDER = '/orders/2026-01-01/orders/123-4567890-1234567';
const BULK = '/easyShip/2022-03-23/packages/bulk';
const falsificador = () => criarFalsificadorAmazon(new Uint8Array(TAMANHO_DO_SAL).fill(1));

function captura(
  linha1: string,
  corpo: unknown,
  extra: Partial<CapturaAmazon> = {},
  linhas = ['credencial: token-legado-curl', 'papeis: dtc,tax-invoicing'],
): CapturaAmazon {
  return {
    sidecar: b(`${[linha1, ...linhas].join('\n')}\n`),
    corpo:
      corpo instanceof Uint8Array
        ? corpo
        : b(typeof corpo === 'string' ? corpo : JSON.stringify(corpo)),
    corpoModificadoEmMs: MTIME,
    requisicao: null,
    zip: null,
    ...extra,
  };
}

const converter = (c: CapturaAmazon) => capturaParaFixture(c, LISTA, falsificador());

function ok(c: CapturaAmazon) {
  const r = converter(c);
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.achados)}`);
  return r;
}

const ordem = (sku: string) => {
  const corpo = getOrderBr();
  const itens = corpo.order.orderItems as { product: Record<string, unknown> }[];
  if (itens[0] !== undefined) itens[0].product.sellerSku = sku;
  return corpo;
};

describe('one pair → one envelope', () => {
  it('a clean BR order: faked ids, the request line redacted, both scan layers clean', () => {
    const r = ok(captura(`GET ${GET_ORDER}?includedData=BUYER,RECIPIENT 200`, getOrderBr()));
    const req = r.envelope.requisicao;
    expect(
      req.tipo === 'http' && FORMATO_FALSO_PEDIDO.test(req.caminho.split('/').pop() ?? ''),
    ).toBe(true);
    expect(req.tipo === 'http' ? req.query : null).toEqual([['includedData', 'BUYER,RECIPIENT']]);
    expect(r.envelope).toMatchObject({
      credencial: 'token-legado-curl',
      papeis: ['dtc', 'tax-invoicing'],
      capturadoEm: '2026-10-19',
      resposta: { status: 200, politica: 'estrutural', forma: 'json' },
      anexos: { zip: null },
    });
    expect(piiScan(r.envelope, LISTA)).toEqual([]);
    expect(r.texto).toBe(`${JSON.stringify(r.envelope, null, 2)}\n`);
    // The raw order id and the raw SKU are nowhere in the fixture.
    expect(r.texto).not.toContain('123-4567890-1234567');
    expect(r.texto).not.toContain('ECHO-DOT');
  });

  it('the same capture under the same salt gives the same bytes (a re-run is a no-op)', () => {
    const c = captura(`GET ${GET_ORDER} 200`, getOrderBr());
    expect(converter(c)).toEqual(converter(c));
  });

  it('★ a DV-valid SKU is a FINDING, never silently faked', () => {
    const r = converter(captura(`GET ${GET_ORDER} 200`, ordem(CPF)));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.achados).toContainEqual({
      onde: 'resposta.corpo.order.orderItems.*.product.sellerSku',
      tipo: 'cpf',
    });
    expect(JSON.stringify(r)).not.toContain(CPF);
  });

  it('near-miss: a clean SKU is faked by design and is no finding', () => {
    expect(converter(captura(`GET ${GET_ORDER} 200`, ordem('CAMISA-AZUL-G'))).ok).toBe(true);
  });

  it('★ a carrier outside the fixture label vocabulary (a courier named as the carrier) is a FINDING; near-miss: Correios is kept', () => {
    const comTransportadora = (carrier: string) => {
      const corpo = getOrderBr();
      corpo.order.packages = [{ carrier }];
      return corpo;
    };
    const r = converter(
      captura(`GET ${GET_ORDER} 200`, comTransportadora('Fulano de Tal Entregas')),
    );
    expect(r.ok ? [] : r.achados).toEqual([
      { onde: 'resposta.corpo.order.packages.*.carrier', tipo: 'rotulo-fora-do-vocabulario' },
    ]);
    expect(JSON.stringify(r)).not.toContain('Fulano');
    expect(ok(captura(`GET ${GET_ORDER} 200`, comTransportadora('Correios'))).texto).toContain(
      '"carrier": "Correios"',
    );
  });

  it('★ a 16+-digit integer JSON.parse already altered refuses the pair', () => {
    const r = converter(
      captura(`GET ${GET_ORDER} 200`, '{"order":{"orderId":12345678901234567890}}'),
    );
    expect(r.ok ? [] : r.achados).toEqual([
      { onde: '.json', tipo: 'inteiro-alterado-pelo-parse (1)' },
    ]);
    expect(
      contarInteirosInseguros('{"a":9007199254740993,"b":"12345678901234567890","c":1.5e300}'),
    ).toBe(1);
    // Near-miss: a safe 16-digit integer survives the round trip.
    expect(contarInteirosInseguros('{"a":1234567890123456}')).toBe(0);
  });

  it('★ UTF-16 (with and without a BOM) and invalid UTF-8 bodies are refused', () => {
    const utf16 = new Uint8Array([0xff, 0xfe, 0x7b, 0x00, 0x7d, 0x00]);
    expect(converter(captura(`GET ${GET_ORDER} 200`, utf16)).ok).toBe(false);
    expect(
      converter(captura(`GET ${GET_ORDER} 200`, new Uint8Array([0x7b, 0x00, 0x7d, 0x00]))).ok,
    ).toBe(false);
    const r = converter(
      captura(`GET ${GET_ORDER} 200`, new Uint8Array([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d])),
    );
    expect(r.ok ? [] : r.achados).toEqual([{ onde: '.json', tipo: 'utf8-invalido' }]);
  });

  it('an empty body is `vazio`, an error body takes the error walk', () => {
    expect(ok(captura(`GET ${GET_ORDER} 200`, '')).envelope.resposta).toMatchObject({
      forma: 'vazio',
      corpo: null,
    });
    const erro = ok(
      captura(`GET ${GET_ORDER} 400`, {
        errors: [{ code: 'InvalidInput', message: 'Pedido 123 de Fulana', details: 'x' }],
      }),
    );
    expect(erro.envelope.resposta.corpo).toEqual({
      errors: [{ code: 'InvalidInput', message: 'REDACTED', details: 'REDACTED' }],
    });
  });

  it('a refused sidecar names line and kind only, and stops the pair', () => {
    const r = converter(captura(`GET https://api.amazon.com/auth/o2/token 200`, {}));
    expect(r).toEqual({ ok: false, achados: [{ onde: '.txt:1', tipo: 'host' }], resumo: null });
  });
});

describe('★ shape-preserving documents', () => {
  const comRegistros = (numeros: readonly string[]) => {
    const corpo = searchOrdersBr();
    const pedido = corpo.orders[0] as { tax: { taxRegistrations: Record<string, unknown>[] } };
    pedido.tax.taxRegistrations = numeros.map((n) => ({
      entityType: 'BUYER',
      taxRegistrationType: 'CPF',
      taxRegistrationNumber: n,
    }));
    return corpo;
  };

  it('a punctuated CPF, a bare 8-digit root and a 10-digit VAT keep their shape', () => {
    const r = ok(
      captura(
        'GET /orders/2026-01-01/orders 200',
        comRegistros([pontuarCpf(CPF), '12345678', '1234567890']),
      ),
    );
    const regs = (
      r.envelope.resposta.corpo as {
        orders: { tax: { taxRegistrations: { taxRegistrationNumber: string }[] } }[];
      }
    ).orders[0]?.tax.taxRegistrations.map((x) => x.taxRegistrationNumber);
    expect(regs).toEqual([
      PLACEHOLDERS_DOCUMENTO_AMAZON.cpfPontuado,
      PLACEHOLDERS_DOCUMENTO_AMAZON.cnpjRaiz8,
      '0000000000',
    ]);
  });

  it('near-miss: a punctuated and a bare CNPJ map to their two distinct placeholders', () => {
    const r = ok(
      captura('GET /orders/2026-01-01/orders 200', comRegistros([pontuarCnpj(CNPJ), CNPJ])),
    );
    const regs = (
      r.envelope.resposta.corpo as {
        orders: { tax: { taxRegistrations: { taxRegistrationNumber: string }[] } }[];
      }
    ).orders[0]?.tax.taxRegistrations.map((x) => x.taxRegistrationNumber);
    expect(regs).toEqual([
      PLACEHOLDERS_DOCUMENTO_AMAZON.cnpjPontuado,
      PLACEHOLDERS_DOCUMENTO_AMAZON.cnpj14,
    ]);
  });

  it('the dry-run leaf table prints the document SHAPE class only, never the value', () => {
    const r = ok(captura('GET /orders/2026-01-01/orders 200', comRegistros([pontuarCpf(CPF)])));
    const linhas = r.resumo.folhas.filter((l) => l.caminho.endsWith('taxRegistrationNumber'));
    expect(linhas.map((l) => l.detalhe)).toEqual(['~ cpfPontuado']);
    expect(JSON.stringify(r.resumo)).not.toContain(CPF.slice(0, 3) + '.');
  });
});

describe('the attachments (C3)', () => {
  const BULK_REQ = {
    marketplaceId: 'A2Q3Y263D00KWC',
    orderScheduleDetailsList: [
      {
        amazonOrderId: '123-4567890-1234567',
        packageDetails: {
          packageItems: [{ orderItemId: '12345678901234', orderItemSerialNumbers: ['SERIE-1'] }],
          packageTimeSlot: {
            slotId: 'SLOT1',
            startTime: '2026-10-20T10:00:00Z',
            handoverMethod: 'PICKUP',
          },
          packageIdentifier: 'minha-caixa-1',
        },
      },
    ],
    labelFormat: 'ZPL',
  };
  const RESPOSTA = {
    scheduledPackages: [{ scheduledPackageId: { amazonOrderId: '123-4567890-1234567' } }],
  };
  const copia = ['credencial: copia-do-legado', 'papeis: dtc'];

  it('.req.json goes through the bulk request table: ids faked (joined), denied keys redacted, the rest kept', () => {
    const r = ok(
      captura(`POST ${BULK} 200`, RESPOSTA, { requisicao: b(JSON.stringify(BULK_REQ)) }, copia),
    );
    const req = r.envelope.requisicao;
    const corpo = (req.tipo === 'http' ? req.corpo : null) as typeof BULK_REQ;
    const pedido = corpo.orderScheduleDetailsList[0];
    expect(corpo.marketplaceId).toBe('A2Q3Y263D00KWC');
    expect(corpo.labelFormat).toBe('ZPL');
    expect(pedido?.packageDetails.packageTimeSlot.handoverMethod).toBe('PICKUP');
    expect(pedido?.packageDetails.packageIdentifier).toBe('REDACTED');
    expect(pedido?.packageDetails.packageItems[0]?.orderItemSerialNumbers).toEqual(['REDACTED']);
    // The same order id joins the response's, through the one id map.
    const resposta = r.envelope.resposta.corpo as typeof RESPOSTA;
    expect(pedido?.amazonOrderId).toBe(
      resposta.scheduledPackages[0]?.scheduledPackageId.amazonOrderId,
    );
    expect(FORMATO_FALSO_PEDIDO.test(pedido?.amazonOrderId ?? '')).toBe(true);
    expect(piiScan(r.envelope, LISTA)).toEqual([]);
  });

  it('★ a .req.json value the request table keeps but the profile had to fake is a FINDING; near-miss: labelFormat ZPL is none', () => {
    const comFormato = (labelFormat: string) =>
      captura(
        `POST ${BULK} 200`,
        RESPOSTA,
        { requisicao: b(JSON.stringify({ ...BULK_REQ, labelFormat })) },
        copia,
      );
    // An AWS-key-shaped value passes the enum predicate and trips the regex layer.
    const r = converter(comFormato('AKIAABCDEFGHIJKLMNOP'));
    expect(r.ok ? [] : r.achados).toEqual([
      { onde: 'requisicao.corpo', tipo: 'valor-mantido-falsificado' },
    ]);
    expect(JSON.stringify(r)).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(converter(comFormato('ZPL')).ok).toBe(true);
  });

  it('.zip.txt becomes the layout: names shape-faked, sizes kept', () => {
    const r = ok(
      captura(`POST ${BULK} 200`, RESPOSTA, { zip: b('2048 123-4567890-1234567.zpl\n') }, copia),
    );
    const resposta = r.envelope.resposta.corpo as typeof RESPOSTA;
    expect(r.envelope.anexos.zip).toEqual({
      entradas: [
        {
          nome: `${resposta.scheduledPackages[0]?.scheduledPackageId.amazonOrderId ?? ''}.zpl`,
          bytes: 2048,
        },
      ],
    });
  });

  it('an attachment beside anything but a POST bulk is refused', () => {
    const r = converter(captura(`GET ${GET_ORDER} 200`, getOrderBr(), { requisicao: b('{}') }));
    expect(r.ok ? [] : r.achados).toEqual([{ onde: '.req.json', tipo: 'anexo-indevido' }]);
  });
});

describe('ORDER_CHANGE', () => {
  const NOTIFICACAO = {
    NotificationType: 'ORDER_CHANGE',
    Payload: {
      OrderChangeNotification: {
        SellerId: 'AZXCVBNMASDFG1',
        AmazonOrderId: '123-4567890-1234567',
        Summary: { DestinationPostalCode: '01234-567', OrderStatus: 'Unshipped' },
      },
    },
  };
  const doc = ['credencial: documentacao-aws', 'papeis: nao-se-aplica'];

  it('the SQS body: seller id `<sellerId>`, postal code redacted, no status', () => {
    const r = ok(captura('NOTIFICACAO ORDER_CHANGE sqs', NOTIFICACAO, {}, doc));
    expect(r.envelope.resposta.status).toBeNull();
    expect(r.texto).toContain('"SellerId": "<sellerId>"');
    expect(r.texto).not.toContain('AZXCVBNMASDFG1');
    expect(r.texto).not.toContain('01234-567');
  });

  it('the Pipe record: its `body` string is parsed and walked, and its integers checked', () => {
    const registro = [
      { messageId: '12345678-1234-1234-1234-123456789012', body: JSON.stringify(NOTIFICACAO) },
    ];
    const r = ok(captura('NOTIFICACAO ORDER_CHANGE pipe', registro, {}, doc));
    const corpo = r.envelope.resposta.corpo as { body: string }[];
    expect(corpo[0]?.body).toContain('<sellerId>');
    expect(corpo[0]?.body).not.toContain('AZXCVBNMASDFG1');
    expect(piiScan(r.envelope, LISTA)).toEqual([]);
    const inseguro = [{ body: '{"Payload":{"x":12345678901234567890}}' }];
    const recusa = converter(captura('NOTIFICACAO ORDER_CHANGE pipe', inseguro, {}, doc));
    expect(recusa.ok ? [] : recusa.achados).toEqual([
      { onde: '.json', tipo: 'inteiro-alterado-pelo-parse (1)' },
    ]);
  });
});
