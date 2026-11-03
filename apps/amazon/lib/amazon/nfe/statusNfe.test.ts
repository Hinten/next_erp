/**
 * The status reader (step 14, PR 14-b): one test per row of its table, the
 * near misses that must NOT read as a known status, the committed C2 and
 * sandbox bodies, the refused-read classifier, and the vocabulary seam (the
 * order-level UPPER_SNAKE constants never reach a Delivery comparison).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AmazonAuthError,
  AmazonConfigError,
  AmazonHttpError,
  AmazonNetworkError,
  AmazonNotFoundError,
  AmazonSchemaError,
  AmazonThrottleError,
  AmazonTimeoutError,
  type ContextoRequisicaoAmazon,
  type RespostaStatusNotaFiscal,
  STATUS_FATURAMENTO_PEDIDO_AMAZON,
  STATUS_FATURA_ENTREGA_AMAZON,
  STATUS_FATURA_ITEM_AMAZON,
  respostaStatusNotaFiscalSchema,
} from '@delfrance/integrations-amazon-sp-api';
import { describe, expect, it } from 'vitest';

import { CODIGOS_ERRO_AMAZON } from '../core/redacao';
import { DIRETORIO_WIRE_AMAZON, lerFixtureAmazon } from '../fixtures/wireCorpus';
import { INVOICE_STATUS_AMAZON } from '../frete/estadoFreteAmazon';
import {
  CODIGO_ENTIDADE_NAO_ENCONTRADA_AMAZON,
  LEITURA_STATUS_NFE_AMAZON,
  type LeituraStatusNfe,
  VALOR_STATUS_OUTRO,
  leituraDaFalhaDeStatusNfeAmazon,
  lerStatusNfeAmazon,
} from './statusNfe';
import { LEITURA_ANTES_NFE_AMAZON } from './tarefaNfe';

const AQUI = fileURLToPath(new URL('.', import.meta.url));

/** A body, through the package's own tolerant schema (what the caller hands in). */
function corpo(c: Record<string, unknown>): RespostaStatusNotaFiscal {
  return respostaStatusNotaFiscalSchema.parse(c);
}

const linhas = (...status: (string | null)[]) =>
  status.map((s, i) =>
    s === null ? { id: `inv-${String(i)}` } : { id: `inv-${String(i)}`, status: s },
  );

const tipo = (c: Record<string, unknown>) => lerStatusNfeAmazon(corpo(c)).tipo;

describe('lerStatusNfeAmazon — one test per row', () => {
  it('absent / NotFound / absent, [] or every row NotFound ⇒ sem-nota', () => {
    expect(tipo({ invoiceStatus: 'NotFound' })).toBe('sem-nota');
    expect(tipo({ invoiceStatus: 'NotFound', invoices: [] })).toBe('sem-nota');
    expect(tipo({ invoiceStatus: 'NotFound', invoices: linhas('NotFound', 'NotFound') })).toBe(
      'sem-nota',
    );
  });

  it('absent / absent / absent or [] ⇒ sem-nota (nothing says otherwise)', () => {
    expect(tipo({})).toBe('sem-nota');
    expect(tipo({ invoices: [] })).toBe('sem-nota');
    expect(tipo({ amazonOrderId: '171-9876543-2109876' })).toBe('sem-nota');
  });

  it('Processing / any / any ⇒ processando', () => {
    expect(tipo({ orderInvoicingStatus: 'Processing' })).toBe('processando');
    expect(
      tipo({
        orderInvoicingStatus: 'Processing',
        invoiceStatus: 'Accepted',
        invoices: linhas('Accepted'),
      }),
    ).toBe('processando');
  });

  it('absent / Processing / any ⇒ processando', () => {
    expect(tipo({ invoiceStatus: 'Processing' })).toBe('processando');
    expect(tipo({ invoiceStatus: 'Processing', invoices: linhas('Rejected') })).toBe('processando');
  });

  it('Accepted / Accepted or absent / non-empty, every row Accepted ⇒ aceita', () => {
    expect(
      tipo({
        orderInvoicingStatus: 'Accepted',
        invoiceStatus: 'Accepted',
        invoices: linhas('Accepted', 'Accepted'),
      }),
    ).toBe('aceita');
    expect(tipo({ orderInvoicingStatus: 'Accepted', invoices: linhas('Accepted') })).toBe('aceita');
  });

  it('absent / Accepted / absent, or every row Accepted ⇒ aceita', () => {
    expect(tipo({ invoiceStatus: 'Accepted' })).toBe('aceita');
    expect(tipo({ invoiceStatus: 'Accepted', invoices: linhas('Accepted') })).toBe('aceita');
  });

  it('Rejected / any / any ⇒ recusada', () => {
    expect(tipo({ orderInvoicingStatus: 'Rejected' })).toBe('recusada');
    expect(
      tipo({
        orderInvoicingStatus: 'Rejected',
        invoiceStatus: 'Accepted',
        invoices: linhas('Accepted'),
      }),
    ).toBe('recusada');
  });

  it('absent / Errored / any ⇒ recusada', () => {
    expect(tipo({ invoiceStatus: 'Errored' })).toBe('recusada');
    expect(tipo({ invoiceStatus: 'Errored', invoices: linhas('Rejected') })).toBe('recusada');
  });

  it('★ PartiallyAccepted + some row Processing ⇒ processando ([Rejected, Processing]: keep climbing)', () => {
    expect(
      tipo({
        orderInvoicingStatus: 'PartiallyAccepted',
        invoices: linhas('Rejected', 'Processing'),
      }),
    ).toBe('processando');
  });

  it('★ PartiallyAccepted + no row Processing, some Accepted ⇒ aceita-com-recusa ([Rejected, Accepted])', () => {
    expect(
      tipo({ orderInvoicingStatus: 'PartiallyAccepted', invoices: linhas('Rejected', 'Accepted') }),
    ).toBe('aceita-com-recusa');
  });

  it('NEAR-MISS: PartiallyAccepted + [Rejected], [] or absent ⇒ parcial', () => {
    expect(tipo({ orderInvoicingStatus: 'PartiallyAccepted', invoices: linhas('Rejected') })).toBe(
      'parcial',
    );
    expect(tipo({ orderInvoicingStatus: 'PartiallyAccepted', invoices: [] })).toBe('parcial');
    expect(tipo({ orderInvoicingStatus: 'PartiallyAccepted' })).toBe('parcial');
  });
});

describe('lerStatusNfeAmazon — what is NOT a known status', () => {
  it.each(['ACCEPTED', 'accepted', 'Accepted ', ' Accepted', 'Errored', 'NotFound', ''])(
    '★ orderInvoicingStatus %j (a case fold, a stray space, another field’s vocabulary) ⇒ indeterminado',
    (valor) => {
      const l = lerStatusNfeAmazon(
        corpo({
          orderInvoicingStatus: valor,
          invoiceStatus: 'Accepted',
          invoices: linhas('Accepted'),
        }),
      );
      expect(l.tipo).toBe('indeterminado');
      if (l.tipo !== 'indeterminado') return;
      expect(l.campo).toBe('orderInvoicingStatus');
    },
  );

  it.each(['ACCEPTED', 'accepted', 'Accepted ', 'Rejected', 'PartiallyAccepted'])(
    '★ invoiceStatus %j ⇒ indeterminado',
    (valor) => {
      expect(tipo({ invoiceStatus: valor })).toBe('indeterminado');
    },
  );

  it.each(['ACCEPTED', 'accepted', 'Errored', 'PartiallyAccepted', null])(
    '★ an invoices[] row %j ⇒ indeterminado',
    (valor) => {
      expect(tipo({ invoiceStatus: 'Accepted', invoices: linhas('Accepted', valor) })).toBe(
        'indeterminado',
      );
    },
  );

  it('★ valor is CLOSED: a known constant as spelled, else <outro> — never the raw text', () => {
    const conhecido = lerStatusNfeAmazon(corpo({ orderInvoicingStatus: 'Errored' }));
    expect(conhecido).toEqual({
      tipo: 'indeterminado',
      campo: 'orderInvoicingStatus',
      valor: 'Errored',
    });
    const estranho = lerStatusNfeAmazon(corpo({ orderInvoicingStatus: 'ACCEPTED' }));
    expect(estranho).toEqual({
      tipo: 'indeterminado',
      campo: 'orderInvoicingStatus',
      valor: VALOR_STATUS_OUTRO,
    });
    const segredo = lerStatusNfeAmazon(corpo({ invoiceStatus: 'texto 12345678901234567890' }));
    expect(JSON.stringify(segredo)).not.toContain('12345678901234567890');
  });

  it('★ mutation 3: Accepted with a row still Processing is indeterminado, never aceita', () => {
    expect(
      tipo({
        orderInvoicingStatus: 'Accepted',
        invoiceStatus: 'Accepted',
        invoices: linhas('Accepted', 'Processing'),
      }),
    ).toBe('indeterminado');
    // …and so is an Accepted aggregate with NO row to derive it from, or a contradicting invoice.
    expect(tipo({ orderInvoicingStatus: 'Accepted', invoiceStatus: 'Accepted' })).toBe(
      'indeterminado',
    );
    expect(
      tipo({
        orderInvoicingStatus: 'Accepted',
        invoiceStatus: 'Processing',
        invoices: linhas('Accepted'),
      }),
    ).toBe('indeterminado');
    expect(tipo({ invoiceStatus: 'Accepted', invoices: linhas('Accepted', 'Processing') })).toBe(
      'indeterminado',
    );
  });

  it('★ mutation 2: orderInvoicingStatus is read BEFORE invoiceStatus', () => {
    expect(
      tipo({
        orderInvoicingStatus: 'Rejected',
        invoiceStatus: 'Accepted',
        invoices: linhas('Accepted'),
      }),
    ).toBe('recusada');
    expect(
      tipo({
        orderInvoicingStatus: 'PartiallyAccepted',
        invoiceStatus: 'Errored',
        invoices: linhas('Rejected', 'Processing'),
      }),
    ).toBe('processando');
    expect(tipo({ orderInvoicingStatus: 'Processing', invoiceStatus: 'Errored' })).toBe(
      'processando',
    );
  });

  it('absent aggregate with rows but no invoice status, or NotFound beside an Accepted row ⇒ indeterminado', () => {
    expect(tipo({ invoices: linhas('Accepted') })).toBe('indeterminado');
    expect(tipo({ invoiceStatus: 'NotFound', invoices: linhas('Accepted') })).toBe('indeterminado');
  });
});

describe('lerStatusNfeAmazon — a 2xx with errors', () => {
  it('★ mutation 22: a non-empty errors list ⇒ indeterminado, whatever else the body says', () => {
    expect(tipo({ errors: [{ code: 'InvalidInput' }] })).toBe('indeterminado');
    expect(
      tipo({
        errors: [{ code: 'InternalFailure' }],
        orderInvoicingStatus: 'Accepted',
        invoiceStatus: 'Accepted',
        invoices: linhas('Accepted'),
      }),
    ).toBe('indeterminado');
    expect(lerStatusNfeAmazon(corpo({ errors: [{}] }))).toEqual({
      tipo: 'indeterminado',
      campo: 'errors',
      valor: null,
    });
  });

  it('NEAR-MISS: errors [] or null goes on to the table', () => {
    expect(tipo({ errors: [] })).toBe('sem-nota');
    expect(tipo({ errors: null })).toBe('sem-nota');
    expect(tipo({ errors: [], invoiceStatus: 'Accepted' })).toBe('aceita');
  });
});

describe('lerStatusNfeAmazon — the committed bodies', () => {
  function corpoDaFixture(nome: string): RespostaStatusNotaFiscal {
    const leitura = lerFixtureAmazon(readFileSync(join(DIRETORIO_WIRE_AMAZON, nome), 'utf8'));
    if (!leitura.ok) throw new Error(`${nome} não é um envelope válido`);
    return respostaStatusNotaFiscalSchema.parse(leitura.data.resposta.corpo);
  }

  it('★ capture C2 (the one real status read) ⇒ aceita', () => {
    expect(lerStatusNfeAmazon(corpoDaFixture('c2-status-aceita.json')).tipo).toBe('aceita');
  });

  it('★ the model’s sandbox body ⇒ aceita', () => {
    expect(lerStatusNfeAmazon(corpoDaFixture('sb-invoice-status.json')).tipo).toBe('aceita');
  });
});

describe('leituraDaFalhaDeStatusNfeAmazon — a refused status read', () => {
  const SP: ContextoRequisicaoAmazon = {
    destino: 'sp-api',
    operacao: 'getInvoiceStatus',
    metodo: 'GET',
    caminho: '/delivery/2022-07-01/invoice/status',
    correlationId: 'corr-1',
    requestIdAmazon: null,
    refCredencial: 'ref.1',
  };
  const http = (status: number, codigosErro: readonly string[] = []) =>
    new AmazonHttpError({ ...SP, status, codigosErro });

  it('★ a 404 on a proved order reads sem-nota (decision 7’s provisional default; a capture may flip it)', () => {
    expect(
      leituraDaFalhaDeStatusNfeAmazon(new AmazonNotFoundError({ ...SP, status: 404 })),
    ).toEqual({
      tipo: 'sem-nota',
    });
  });

  it('★ a 400 EntityNotFound reads sem-nota; NEAR-MISS a 400 InvalidInput is indeterminado', () => {
    // The LITERAL wire code (the submit 400 sandbox's), never the module's own
    // constant: a misspelt constant would read every such 400 `indeterminado`.
    expect(CODIGO_ENTIDADE_NAO_ENCONTRADA_AMAZON).toBe('EntityNotFound');
    expect(leituraDaFalhaDeStatusNfeAmazon(http(400, ['EntityNotFound']))).toEqual({
      tipo: 'sem-nota',
    });
    // NEAR-MISS: `NotFound` is in the same closed code set, and is not this answer.
    expect(leituraDaFalhaDeStatusNfeAmazon(http(400, ['NotFound']))?.tipo).toBe('indeterminado');
    expect(leituraDaFalhaDeStatusNfeAmazon(http(400, ['InvalidInput']))).toEqual({
      tipo: 'indeterminado',
      campo: 'resposta',
      valor: null,
    });
    // An EntityNotFound on another status is not the 400 the default is about.
    expect(leituraDaFalhaDeStatusNfeAmazon(http(422, ['EntityNotFound']))?.tipo).toBe(
      'indeterminado',
    );
  });

  it('a 2xx off its schema is indeterminado', () => {
    const err = new AmazonSchemaError({ ...SP, status: 200, motivo: 'formato', campos: [] });
    expect(leituraDaFalhaDeStatusNfeAmazon(err)?.tipo).toBe('indeterminado');
  });

  it.each<[string, () => unknown]>([
    ['a 401', () => new AmazonAuthError({ ...SP, status: 401, codigoLwa: null })],
    ['a 403', () => new AmazonAuthError({ ...SP, status: 403, codigoLwa: null })],
    ['a 429', () => new AmazonThrottleError({ ...SP, status: 429, limiteTaxa: null })],
    ['a 500', () => http(500)],
    ['a 503 with EntityNotFound', () => http(503, ['EntityNotFound'])],
    ['a cut connection', () => new AmazonNetworkError(SP, new Error('reset'))],
    ['a timeout', () => new AmazonTimeoutError({ ...SP, prazoMs: 20_000 }, new Error('t'))],
    [
      'a refused input',
      () => new AmazonConfigError('pedido', { operacao: 'x', refCredencial: null }),
    ],
    ['a TypeError', () => new TypeError('bug')],
    ['a string', () => 'x'],
  ])('%s is NOT a reading (null: the caller’s)', (_r, falha) => {
    expect(leituraDaFalhaDeStatusNfeAmazon(falha())).toBeNull();
  });

  it('EntityNotFound is a code the log’s closed set already knows', () => {
    expect(CODIGOS_ERRO_AMAZON.has(CODIGO_ENTIDADE_NAO_ENCONTRADA_AMAZON)).toBe(true);
  });
});

describe('the vocabularies', () => {
  it('sem-nota and recusada are spelled by tarefaNfe.ts (one spelling for both modules)', () => {
    expect(LEITURA_STATUS_NFE_AMAZON.semNota).toBe(LEITURA_ANTES_NFE_AMAZON.semNota);
    expect(LEITURA_STATUS_NFE_AMAZON.recusada).toBe(LEITURA_ANTES_NFE_AMAZON.recusada);
    const todas: LeituraStatusNfe['tipo'][] = Object.values(LEITURA_STATUS_NFE_AMAZON);
    expect(new Set(todas).size).toBe(7);
  });

  it('★ mutation 4: no order-level (UPPER_SNAKE) value is a Delivery constant', () => {
    const entrega = new Set<string>([
      ...Object.values(STATUS_FATURAMENTO_PEDIDO_AMAZON),
      ...Object.values(STATUS_FATURA_ENTREGA_AMAZON),
      ...Object.values(STATUS_FATURA_ITEM_AMAZON),
    ]);
    for (const v of Object.values(INVOICE_STATUS_AMAZON)) expect(entrega.has(v), v).toBe(false);
    // Anti-vacuity: both tables were read.
    expect(entrega.size).toBeGreaterThanOrEqual(6);
    expect(Object.values(INVOICE_STATUS_AMAZON).length).toBe(5);
  });

  it('★ under nfe/**, ONLY gatesPedidoNfe.ts imports INVOICE_STATUS_AMAZON (production files, any import shape)', () => {
    const IMPORTA =
      /\b(?:import|export)\s*(?:type\s+)?\{[^}]*\bINVOICE_STATUS_AMAZON\b[^}]*\}\s*from/;
    const arquivos = readdirSync(AQUI).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const importam = arquivos
      .filter((f) => IMPORTA.test(readFileSync(join(AQUI, f), 'utf8')))
      .sort();
    expect(importam).toEqual(['gatesPedidoNfe.ts']);
    // Anti-vacuity: the scan read the status reader itself, and the pattern sees a
    // multi-line import and a renamed one.
    expect(arquivos).toEqual(expect.arrayContaining(['statusNfe.ts', 'decisaoNfe.ts']));
    expect(
      IMPORTA.test("import {\n  X,\n  INVOICE_STATUS_AMAZON as Y,\n} from '../frete/x';"),
    ).toBe(true);
    expect(IMPORTA.test('// never INVOICE_STATUS_AMAZON here')).toBe(false);
  });
});
