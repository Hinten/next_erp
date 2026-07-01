import { describe, expect, it } from 'vitest';
import { PEDIDO_TABS, TAB_OF_FIELD, summarizePedidoErrors } from './pedidoErrorTabs';

describe('summarizePedidoErrors', () => {
  it('names a single erroring tab', () => {
    const s = summarizePedidoErrors(['integracaoPedidoOuterRef']);
    expect(s.firstTab).toBe('principal');
    expect([...s.errorTabValues]).toEqual(['principal']);
    expect(s.outsideKeys).toEqual([]);
    expect(s.message).toBe('Corrija os campos inválidos na aba "Principal".');
  });

  it('routes the synthetic no-items error (_itensFlat) to the Principal tab', () => {
    const s = summarizePedidoErrors(['_itensFlat']);
    expect(s.firstTab).toBe('principal');
    expect(s.message).toBe('Corrija os campos inválidos na aba "Principal".');
  });

  it('routes regrouped item errors (itens) to the Principal tab', () => {
    const s = summarizePedidoErrors(['itens']);
    expect(s.firstTab).toBe('principal');
  });

  it('routes preview-only tab fields to the tab that shows them', () => {
    // `estado` and `itensDevolvidos` are rendered read-only via PlaceholderTab,
    // so an error on them must mark the right tab, not report "fora do formulário".
    expect(summarizePedidoErrors(['estado']).firstTab).toBe('estado');
    expect(summarizePedidoErrors(['estado']).outsideKeys).toEqual([]);
    expect(summarizePedidoErrors(['itensDevolvidos']).firstTab).toBe('devolucao');
    expect(summarizePedidoErrors(['itensDevolvidos']).message).toBe(
      'Corrija os campos inválidos na aba "Devolução".',
    );
  });

  it('names multiple erroring tabs in display order regardless of input order', () => {
    const s = summarizePedidoErrors(['freteInicial', 'infCpl', 'integracaoPedidoOuterRef']);
    expect(s.firstTab).toBe('principal');
    expect([...s.errorTabValues]).toEqual(['principal', 'fiscal', 'frete']);
    expect(s.message).toBe('Corrija os campos inválidos nas abas: Principal, Fiscal, Frete.');
  });

  it('dedupes multiple errors that live on the same tab', () => {
    const s = summarizePedidoErrors(['integracaoPedidoOuterRef', '_itensFlat', 'descontoTotal']);
    expect([...s.errorTabValues]).toEqual(['principal']);
    expect(s.message).toBe('Corrija os campos inválidos na aba "Principal".');
  });

  it('reports out-of-form keys when nothing maps to a tab', () => {
    // `numero` is a real schema field with no tab UI.
    const s = summarizePedidoErrors(['numero']);
    expect(s.firstTab).toBeUndefined();
    expect(s.outsideKeys).toEqual(['numero']);
    expect(s.message).toBe(
      'Não foi possível salvar: campos inválidos fora do formulário (numero).',
    );
  });

  it('names tab errors and out-of-form keys together', () => {
    const s = summarizePedidoErrors(['infCpl', 'numero']);
    expect(s.firstTab).toBe('fiscal');
    expect(s.outsideKeys).toEqual(['numero']);
    expect(s.message).toBe(
      'Corrija os campos inválidos na aba "Fiscal". Há também campos inválidos fora do formulário (numero).',
    );
  });
});

describe('TAB_OF_FIELD / PEDIDO_TABS integrity', () => {
  it('maps every field to a real tab value', () => {
    const tabValues = new Set(PEDIDO_TABS.map((t) => t.value));
    for (const tab of Object.values(TAB_OF_FIELD)) {
      expect(tabValues.has(tab)).toBe(true);
    }
  });

  it('has unique tab values', () => {
    const values = PEDIDO_TABS.map((t) => t.value);
    expect(new Set(values).size).toBe(values.length);
  });
});
