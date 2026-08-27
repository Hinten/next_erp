import { describe, expect, it } from 'vitest';
import type { ColumnFilterValue, FilterableField } from '../schema/types';
import {
  SEARCH_CHIP_KEY,
  buildFilterChips,
  describeFilter,
  subcollectionLookupFormatter,
} from './describeFilter';

function field(key: string, kind: FilterableField['kind'], extra?: Partial<FilterableField>) {
  return { key, kind, label: key, ...extra } as FilterableField;
}

const NOME = field('nome', 'string', { label: 'Nome' });
const PRECO = field('preco', 'currency', { label: 'Preço' });
const ATIVO = field('ativo', 'boolean', { label: 'Ativo' });
const TIPO = field('tipo', 'enum', {
  label: 'Tipo',
  enumValues: [
    { value: '0', label: 'Pessoa Física' },
    { value: '1', label: 'Pessoa Jurídica' },
  ],
});
const QUANDO = field('quando', 'datetime', { label: 'Criação', dateUnit: 'ms' });
const CANAIS = field('canais', 'string', { label: 'Canais de venda' });

function d(label: string, filter: ColumnFilterValue, f: FilterableField) {
  return describeFilter(label, filter, f);
}

describe('describeFilter', () => {
  it('phrases a text contains filter the way the input labels it', () => {
    expect(d('Nome', { op: 'contains', value: 'ana' }, NOME)).toBe('Nome contém "ana"');
  });

  it('phrases a prefix filter', () => {
    expect(d('Nome', { op: 'startsWith', value: 'ana' }, NOME)).toBe('Nome começa com "ana"');
  });

  it('uses the enum OPTION label, not the stored code', () => {
    // `tipo: '0'` is what Firestore holds; "Pessoa Física" is what the operator
    // picked and the only form they would recognise.
    expect(d('Tipo', { op: 'eq', value: '0' }, TIPO)).toBe('Tipo: Pessoa Física');
  });

  it('falls back to the raw value for an enum code with no option', () => {
    expect(d('Tipo', { op: 'eq', value: '9' }, TIPO)).toBe('Tipo: 9');
  });

  it.each([
    [true, 'Ativo: Sim'],
    [false, 'Ativo: Não'],
  ])('renders the boolean %s', (value, expected) => {
    expect(d('Ativo', { op: 'eq', value }, ATIVO)).toBe(expected);
  });

  it.each([
    ['gte', 'Preço ≥ 10.5'],
    ['lte', 'Preço ≤ 10.5'],
    ['gt', 'Preço > 10.5'],
    ['lt', 'Preço < 10.5'],
  ])('renders the numeric op %s as its symbol', (op, expected) => {
    expect(d('Preço', { op: op as ColumnFilterValue['op'], value: 10.5 }, PRECO)).toBe(expected);
  });

  it('renders numeric equality with a colon rather than a bare =', () => {
    expect(d('Preço', { op: 'eq', value: 10.5 }, PRECO)).toBe('Preço: 10.5');
  });

  it('renders a datetime bound in Brazilian format with its direction', () => {
    const at = new Date(2026, 7, 27, 14, 5, 0).getTime();
    expect(d('Criação', { op: 'gte', value: at }, QUANDO)).toBe(
      'Criação: a partir de 27/08/2026 14:05',
    );
    expect(d('Criação', { op: 'lte', value: at }, QUANDO)).toBe('Criação: até 27/08/2026 14:05');
  });

  it('counts an unlabelled candidate list instead of printing raw ids', () => {
    // The produtos "Canais de venda" filter carries bare integração ids; a row
    // of Firestore ids would be worse than no chip.
    expect(d('Canais de venda', { op: 'array-contains-any', value: ['a', 'b'] }, CANAIS)).toBe(
      'Canais de venda: 2 selecionados',
    );
    expect(d('Canais de venda', { op: 'array-contains-any', value: ['a'] }, CANAIS)).toBe(
      'Canais de venda: 1 selecionado',
    );
  });

  it('labels a candidate list when the virtual column declared its options', () => {
    const withOptions = field('canais', 'string', {
      label: 'Canais de venda',
      enumValues: [
        { value: 'ml', label: 'Mercado Livre' },
        { value: 'wa', label: 'WhatsApp' },
      ],
    });
    expect(
      d('Canais de venda', { op: 'array-contains-any', value: ['ml', 'wa'] }, withOptions),
    ).toBe('Canais de venda: Mercado Livre, WhatsApp');
  });

  it('decodes the subcollection-lookup value instead of printing its encoding', () => {
    // Without the formatter this reads `NF: numeracao:1234`.
    const formatter = subcollectionLookupFormatter([
      { value: 'numeracao', label: 'Número' },
      { value: 'chave', label: 'Chave' },
    ]);
    expect(
      describeFilter('NF', { op: 'eq', value: 'numeracao:1234' }, field('nf', 'string'), {
        formatValue: formatter,
      }),
    ).toBe('NF: Número 1234');
  });

  it('leaves an unrecognised lookup encoding verbatim rather than mangling it', () => {
    const formatter = subcollectionLookupFormatter([{ value: 'numeracao', label: 'Número' }]);
    expect(formatter('nocolon')).toBe('nocolon');
    expect(formatter('outro:9')).toBe('outro 9');
  });
});

describe('buildFilterChips', () => {
  const FIELDS = [NOME, PRECO, TIPO];

  it('orders the search term first, then the fields', () => {
    const chips = buildFilterChips({
      filters: { tipo: { op: 'eq', value: '0' }, nome: { op: 'contains', value: 'ana' } },
      fields: FIELDS,
      search: 'camiseta',
    });
    expect(chips.map((c) => c.key)).toEqual([SEARCH_CHIP_KEY, 'nome', 'tipo']);
    expect(chips[0]!.text).toBe('Busca: "camiseta"');
  });

  it('is empty when nothing narrows the list', () => {
    expect(buildFilterChips({ filters: {}, fields: FIELDS, search: '' })).toEqual([]);
  });

  it('prefers the displayed label over the descriptor label', () => {
    // produtos relabels `publicado` to "Status"; a chip reading "Publicado"
    // would disagree with the column header it refers to.
    const chips = buildFilterChips({
      filters: { nome: { op: 'contains', value: 'ana' } },
      fields: FIELDS,
      labelFor: (f) => (f.key === 'nome' ? 'Nome do produto' : f.label),
    });
    expect(chips[0]!.text).toBe('Nome do produto contém "ana"');
  });

  it('skips a filter whose field has no descriptor', () => {
    // The same filter is dropped by `parseFiltersFromParams`, so it is not
    // narrowing anything — an unlabellable chip would only mislead.
    const chips = buildFilterChips({
      filters: { fantasma: { op: 'eq', value: 'x' } },
      fields: FIELDS,
    });
    expect(chips).toEqual([]);
  });

  it('emits ONE chip when a virtual filter field shadows a schema key', () => {
    // `fields` is [...descriptors, ...virtualFilterFields] and the collision is
    // routine: /pedidos collides on valorCobrado, timestamp, dtImpressao and
    // clientePedidoOuterRef; /produtos on integracoesComProduto. Two chips
    // shared one React key, and the schema-labelled one names a column that is
    // hidden or replaced — so it points at a column that is not on screen.
    const schemaField = field('valorCobrado', 'currency', { label: 'Valor cobrado' });
    const virtualField = field('valorCobrado', 'currency', { label: 'Valor' });
    const chips = buildFilterChips({
      filters: { valorCobrado: { op: 'gte', value: 100 } },
      fields: [schemaField, virtualField],
    });
    expect(chips).toHaveLength(1);
    // The virtual column's label wins — it is the one the operator clicked,
    // and it matches the precedence `parseFiltersFromParams` already applies.
    expect(chips[0]!.text).toBe('Valor ≥ 100');
  });

  it('emits no duplicate chip keys, whatever the field list contains', () => {
    // Duplicate keys are a React warning AND, when the labels happen to match,
    // two byte-identical chips — the Playwright strict-mode hazard again.
    const chips = buildFilterChips({
      filters: {
        cliente: { op: 'eq', value: 'x' },
        nome: { op: 'contains', value: 'ana' },
      },
      fields: [
        field('cliente', 'string', { label: 'Cliente' }),
        NOME,
        field('cliente', 'string', { label: 'Cliente' }),
      ],
      search: 'termo',
    });
    expect(new Set(chips.map((c) => c.key)).size).toBe(chips.length);
    expect(new Set(chips.map((c) => c.text)).size).toBe(chips.length);
  });

  it('keeps schema order when a shadowed field is deduped', () => {
    const chips = buildFilterChips({
      filters: { nome: { op: 'contains', value: 'a' }, preco: { op: 'gte', value: 1 } },
      fields: [NOME, PRECO, field('preco', 'currency', { label: 'Vlr' })],
    });
    expect(chips.map((c) => c.key)).toEqual(['nome', 'preco']);
  });

  it('never emits a chip whose whole text is just a column label', () => {
    // Guards the Playwright strict-mode hazard: `clickColumnSort` is
    // getByText(label, { exact: true }), so a chip equal to a header label
    // resolves to two nodes and reds every sort spec.
    const chips = buildFilterChips({
      filters: {
        nome: { op: 'contains', value: 'ana' },
        preco: { op: 'gte', value: 1 },
        tipo: { op: 'eq', value: '0' },
      },
      fields: FIELDS,
      search: 'x',
    });
    const labels = new Set(FIELDS.map((f) => f.label));
    for (const chip of chips) expect(labels.has(chip.text)).toBe(false);
  });
});
