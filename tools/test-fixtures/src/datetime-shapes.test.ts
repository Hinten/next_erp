import { describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { z } from 'zod';
import { ALL_DOMAINS } from '@delfrance/schemas';
import {
  KNOWN_ISO_EXCEPTIONS,
  classifyValue,
  collectObservations,
  datetimeFieldsForSchema,
  isIsoDateTimeString,
} from './datetime-shapes';
import { buildReport, renderMarkdown } from './sample-datetime-shapes';

function schemaFor(path: string): z.ZodTypeAny {
  const domain = ALL_DOMAINS.find((d) => d.meta.collectionPath === path);
  if (!domain) throw new Error(`no schema for ${path}`);
  return domain.schema;
}

describe('isIsoDateTimeString', () => {
  it('accepts ISO-8601 datetimes', () => {
    expect(isIsoDateTimeString('2026-01-02T03:04:05.000Z')).toBe(true);
    expect(isIsoDateTimeString('2026-01-02T03:04:05-03:00')).toBe(true);
    expect(isIsoDateTimeString('2026-01-02 03:04')).toBe(true);
  });

  it('rejects non-datetime strings', () => {
    expect(isIsoDateTimeString('hello')).toBe(false);
    expect(isIsoDateTimeString('2026-01-02')).toBe(false); // date only, no time
    expect(isIsoDateTimeString('1700000000000')).toBe(false); // epoch as string digits
  });
});

describe('classifyValue', () => {
  it('classifies each wire shape', () => {
    expect(classifyValue(Timestamp.fromMillis(1_700_000_000_000))).toBe('Timestamp');
    expect(classifyValue(1_700_000_000_000)).toBe('number');
    expect(classifyValue('2026-01-02T03:04:05Z')).toBe('iso-string');
    expect(classifyValue('not-a-date')).toBe('string');
    expect(classifyValue(null)).toBe('null');
    expect(classifyValue(undefined)).toBe('null');
    expect(classifyValue(true)).toBe('other');
  });
});

describe('datetimeFieldsForSchema', () => {
  it('discovers the ms-unit codec fields on clientes', () => {
    const fields = datetimeFieldsForSchema(schemaFor('clientes'));
    const byName = new Map(fields.map((f) => [f.name, f]));
    expect(byName.get('timestamp')).toMatchObject({ format: 'epoch', unit: 'ms' });
    expect(byName.get('ultimaModificacao')).toMatchObject({ format: 'epoch', unit: 'ms' });
  });

  it('discovers the µs-unit codec fields on pedidos', () => {
    const fields = datetimeFieldsForSchema(schemaFor('pedidos'));
    const names = new Set(fields.map((f) => f.name));
    expect(names.has('timestamp')).toBe(true);
    expect(fields.find((f) => f.name === 'timestamp')?.unit).toBe('us');
    expect(names.has('dtImpressao')).toBe(true);
  });

  it('does not surface the z.unknown() cheque passthrough as a datetime field', () => {
    // `pagamento.cheque` is `z.unknown()`, so `bomPara` is NOT schema-declared
    // here — it can only be found by runtime discovery.
    const fields = datetimeFieldsForSchema(schemaFor('pedidos/{pedidoId}/pagamentos'));
    expect(fields.some((f) => f.name === 'bomPara')).toBe(false);
    expect(fields.some((f) => f.name === 'vencimento' && f.unit === 'us')).toBe(true);
  });
});

describe('collectObservations', () => {
  const interesting = new Set<string>(['timestamp', 'ultimaModificacao', ...KNOWN_ISO_EXCEPTIONS]);

  it('reports the runtime shape of declared datetime fields', () => {
    const obs = collectObservations(
      { timestamp: 1_700_000_000_000, ultimaModificacao: null, nome: 'ACME' },
      interesting,
    );
    expect(obs).toContainEqual(expect.objectContaining({ path: 'timestamp', shape: 'number' }));
    expect(obs).toContainEqual(
      expect.objectContaining({ path: 'ultimaModificacao', shape: 'null' }),
    );
    // `nome` is not a datetime field and is not a datetime shape → ignored.
    expect(obs.some((o) => o.name === 'nome')).toBe(false);
  });

  it('discovers a nested ISO string (Cheque.bomPara) even when undeclared', () => {
    const obs = collectObservations(
      { valor: 100, cheque: { banco: '001', bomPara: '2026-05-01T00:00:00Z' } },
      interesting,
    );
    expect(obs).toContainEqual(
      expect.objectContaining({ path: 'cheque.bomPara', shape: 'iso-string' }),
    );
  });

  it('surfaces a Timestamp anywhere it appears', () => {
    const obs = collectObservations(
      { nested: { createdAt: Timestamp.fromMillis(1_700_000_000_000) } },
      new Set<string>(),
    );
    expect(obs).toContainEqual(
      expect.objectContaining({ path: 'nested.createdAt', shape: 'Timestamp' }),
    );
  });

  it('ignores a bare number on an undeclared field', () => {
    const obs = collectObservations({ quantidade: 42 }, interesting);
    expect(obs).toHaveLength(0);
  });

  it('walks arrays and reports datetime shapes inside them', () => {
    const obs = collectObservations(
      { itens: [{ desc: 'x' }, { desc: 'y', quando: '2026-01-01T10:00:00Z' }] },
      new Set<string>(),
    );
    expect(obs).toContainEqual(
      expect.objectContaining({ path: 'itens[1].quando', shape: 'iso-string' }),
    );
  });
});

describe('buildReport / renderMarkdown (pagamentos)', () => {
  const path = 'pedidos/{pedidoId}/pagamentos';
  const docs = [
    // Canonical: µs-int datetimes, no cheque.
    { valor: 100, vencimento: 1_700_000_000_000_000, dataAprovacao: 1_700_000_000_000_000 },
    // Legacy: ISO cheque.bomPara + an absent vencimento.
    { valor: 50, cheque: { banco: '341', bomPara: '2026-05-01T00:00:00Z' } },
  ];

  it('aggregates declared fields, counts absent, and discovers cheque.bomPara', () => {
    const report = buildReport(path, schemaFor(path), docs);
    expect(report.sampled).toBe(2);

    const vencimento = report.fields.find((f) => f.path === 'vencimento');
    expect(vencimento?.expected).toBe('number (µs-int)');
    expect(vencimento?.shapeCounts.get('number')).toBe(1);
    expect(vencimento?.presentDocs).toBe(1); // absent in the second doc

    const bomPara = report.discovered.find((d) => d.path === 'cheque.bomPara');
    expect(bomPara).toMatchObject({ shape: 'iso-string', count: 1 });
  });

  it('renders a Markdown report flagging the ISO exception', () => {
    const report = buildReport(path, schemaFor(path), docs);
    const md = renderMarkdown([report], {
      limit: 5,
      parentScan: 25,
      json: false,
    });
    expect(md).toContain('### ISO-exception check');
    expect(md).toContain('`Cheque.bomPara`: found');
    expect(md).toContain('| `vencimento` | number (µs-int) |');
    expect(md).toContain('| `cheque.bomPara` | iso-string |');
  });
});

describe('buildReport — same-named fields at different paths (pedidos)', () => {
  const path = 'pedidos';
  // `pedidos` has `timestamp`/`ultimaModificacao` BOTH top-level and under
  // `freteInicial`. A doc where the nested copy carries a legacy ISO string
  // while the top-level copy is a canonical µs int must attribute each shape to
  // its own path — matching by leaf name alone would conflate them.
  const docs = [
    {
      timestamp: 1_700_000_000_000_000, // top-level: canonical µs int
      freteInicial: {
        timestamp: '2020-01-01T00:00:00Z', // nested: legacy ISO
        ultimaModificacao: '2020-01-01T00:00:00Z',
      },
    },
  ];

  it('does not conflate top-level vs freteInicial.* datetime fields', () => {
    const report = buildReport(path, schemaFor(path), docs);
    const byPath = new Map(report.fields.map((f) => [f.path, f]));

    // Top-level timestamp: the µs int — number, present.
    expect(byPath.get('timestamp')?.shapeCounts.get('number')).toBe(1);
    expect(byPath.get('timestamp')?.presentDocs).toBe(1);

    // Nested freteInicial.timestamp: the legacy ISO — iso-string, NOT number.
    expect(byPath.get('freteInicial.timestamp')?.shapeCounts.get('iso-string')).toBe(1);
    expect(byPath.get('freteInicial.timestamp')?.shapeCounts.get('number')).toBeUndefined();

    // Top-level ultimaModificacao is absent in this doc (only the nested one set).
    expect(byPath.get('ultimaModificacao')?.presentDocs).toBe(0);

    // The nested ISO strings are attributed to their declared fields, so they
    // must NOT leak into the "discovered" table.
    expect(report.discovered).toHaveLength(0);
  });

  it('renders the ⚠️ legacy-shape flag on a numeric field observed as ISO', () => {
    const report = buildReport(path, schemaFor(path), docs);
    const md = renderMarkdown([report], { limit: 5, parentScan: 25, json: false });
    // freteInicial.timestamp is a declared µs field observed as iso-string → ⚠️.
    const row = md.split('\n').find((l) => l.includes('`freteInicial.timestamp`'));
    expect(row).toBeDefined();
    expect(row).toContain('iso-string×1');
    expect(row).toContain('⚠️');
  });
});
