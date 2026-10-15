import { afterEach, describe, expect, it } from 'vitest';
import { inicioDespachoHref } from '@delfrance/schemas';
import {
  encodeTableState,
  resolveInitialTableState,
  listViewMemoryKey,
  writeListViewMemory,
} from '@delfrance/ui';
import { despachoInicioPreset } from './despachoPreset';

const value = { canalId: 'a', metrica: 'faltam' as const, inicioUs: 1000, fimUs: 2000 };
const fields = [
  { key: 'inicioDespacho', label: 'Despacho', kind: 'string' as const, preset: true },
];
afterEach(() => sessionStorage.clear());
describe('dispatch presets', () => {
  it('round-trips the concrete indexed filter and readable chip', () => {
    const params = new URL(inicioDespachoHref(value), 'https://example.com').searchParams;
    const filters = resolveInitialTableState({
      searchParams: params,
      fields,
      ownsSearch: false,
      memoryKey: null,
    }).filters;
    expect(
      new URLSearchParams(encodeTableState(filters, undefined, '', 1)).get('inicioDespacho'),
    ).toBe(params.get('inicioDespacho'));
    const preset = despachoInicioPreset(() => 'Balcão');
    expect(preset.formatValue(filters.inicioDespacho!.value)).toContain('Balcão · Faltam');
    expect(preset.resolve(filters.inicioDespacho!)).toHaveProperty('predicate');
  });
  it('the URL wins over stale table memory, including malformed presets', () => {
    const key = listViewMemoryKey('/pedidos', 'pedidos');
    writeListViewMemory(key, {
      qs: new URL(
        inicioDespachoHref({ ...value, canalId: 'stale' }),
        'https://example.com',
      ).search.slice(1),
      scroll: 90,
    });
    const initial = (searchParams: URLSearchParams) =>
      resolveInitialTableState({ searchParams, fields, ownsSearch: false, memoryKey: key });
    expect(
      initial(new URL(inicioDespachoHref(value), 'https://example.com').searchParams).filters
        .inicioDespacho!.value,
    ).toBe(JSON.stringify(value));
    const bad = initial(new URLSearchParams('inicioDespacho=malformed'));
    expect(despachoInicioPreset(() => '').resolve(bad.filters.inicioDespacho!)).toHaveProperty(
      'error',
    );
    writeListViewMemory(key, { qs: '', scroll: 0 });
    expect(initial(new URLSearchParams()).filters).toEqual({});
  });
});
