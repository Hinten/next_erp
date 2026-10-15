import { describe, expect, it } from 'vitest';

import {
  liCategoriaSchema,
  liEnvelopeSchema,
  liMetaSchema,
  liPedidoBuscaLinhaSchema,
} from '../src/types';
import {
  categoriaPagina1,
  categoriaUltimaPagina,
  metaLimite15,
  pedidoBuscaExemplo,
} from './_fixtures/especificacao';

const envelopeCategoria = liEnvelopeSchema(liCategoriaSchema);
const envelopePedidoBusca = liEnvelopeSchema(liPedidoBuscaLinhaSchema);
const [linha164, linha165] = pedidoBuscaExemplo.objects;

describe('the document examples', () => {
  it('the categoria list example parses', () => {
    const r = envelopeCategoria.safeParse(categoriaPagina1);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.meta).toMatchObject({
      limit: 20,
      offset: 0,
      next: '/api/v1/categoria?limit=20&offset=20',
      previous: null,
      total_count: 55,
    });
    expect(r.data.objects.map((o) => o.id)).toEqual([7645875, 7645904, 7645906]);
    expect(r.data.objects[0]?.categoria_pai).toBeNull();
    expect(r.data.objects[1]?.categoria_pai).toBe('/api/v1/categoria/7645875');
  });

  it('the last-page example parses with next: null', () => {
    const r = envelopeCategoria.safeParse(categoriaUltimaPagina);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.meta.next).toBeNull();
  });

  it('the pedido/search meta (limit 15) parses', () => {
    expect(liMetaSchema.parse(metaLimite15).limit).toBe(15);
  });
});

describe('number tolerance', () => {
  it('`limit: "20"` reads as 20, and so do a quoted offset, total_count and id', () => {
    const meta = liMetaSchema.parse({
      ...categoriaPagina1.meta,
      limit: '20',
      offset: '40',
      total_count: '55',
    });
    expect(meta.limit).toBe(20);
    expect(meta.offset).toBe(40);
    expect(meta.total_count).toBe(55);
    expect(liCategoriaSchema.parse({ ...categoriaPagina1.objects[0], id: '7645875' }).id).toBe(
      7645875,
    );
  });

  it('near-miss: a non-numeric or fractional limit still fails', () => {
    expect(liMetaSchema.safeParse({ ...categoriaPagina1.meta, limit: 'vinte' }).success).toBe(
      false,
    );
    expect(liMetaSchema.safeParse({ ...categoriaPagina1.meta, limit: '20.5' }).success).toBe(false);
    expect(liMetaSchema.safeParse({ ...categoriaPagina1.meta, limit: '' }).success).toBe(false);
  });

  it('total_count may be absent or null', () => {
    const { total_count: _omitido, ...semTotal } = categoriaPagina1.meta;
    expect(liMetaSchema.safeParse(semTotal).success).toBe(true);
    expect(liMetaSchema.safeParse({ ...semTotal, total_count: null }).success).toBe(true);
  });
});

describe('an empty total_count', () => {
  const { total_count: _omitido, ...semTotal } = categoriaPagina1.meta;
  const comTotal = (total_count: unknown) => liMetaSchema.safeParse({ ...semTotal, total_count });

  it("`''` reads as null — never 0, which would announce an empty window", () => {
    const r = comTotal('');
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.total_count).toBeNull();
  });

  it.each([['abc'], ['   '], [' '], ['2.5'], [2.5], ['1,5']])(
    'near-miss: %j is still refused, at meta.total_count',
    (total) => {
      const r = comTotal(total);
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues.map((i) => i.path)).toEqual([['total_count']]);
    },
  );

  it('null and an absent key are unchanged', () => {
    const nulo = comTotal(null);
    expect(nulo.success).toBe(true);
    if (nulo.success) expect(nulo.data.total_count).toBeNull();
    const ausente = liMetaSchema.safeParse(semTotal);
    expect(ausente.success).toBe(true);
    if (ausente.success) expect(ausente.data.total_count).toBeUndefined();
  });

  it.each([[7], ['7'], [0], ['0']])('%j still reads as a number', (total) => {
    const r = comTotal(total);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.total_count).toBe(Number(total));
  });

  it('near-miss: the REQUIRED leaves keep refusing an empty string', () => {
    expect(liMetaSchema.safeParse({ ...categoriaPagina1.meta, offset: '' }).success).toBe(false);
    expect(liCategoriaSchema.safeParse({ ...categoriaPagina1.objects[0], id: '' }).success).toBe(
      false,
    );
  });
});

describe('passthrough', () => {
  it('unknown keys survive on the meta, the envelope and the row', () => {
    const r = envelopeCategoria.parse({
      ...categoriaPagina1,
      extra_envelope: 1,
      meta: { ...categoriaPagina1.meta, extra_meta: 'x' },
    });
    expect(r.extra_envelope).toBe(1);
    expect(r.meta.extra_meta).toBe('x');
    // `descricao`, `seo`, `url` and `id_externo` are not declared, and are kept.
    expect(r.objects[0]).toMatchObject({
      descricao: 'Looks para mulheres modernas.',
      seo: '/api/v1/seo/44626931',
      url: 'https://loja.example/feminino',
      id_externo: null,
    });
  });

  it('a row missing a declared field fails', () => {
    const { nome: _nome, ...semNome } = categoriaPagina1.objects[0];
    expect(liCategoriaSchema.safeParse(semNome).success).toBe(false);
  });
});

describe('the pedido search row', () => {
  it("the document's example parses: both rows, meta.limit read back as 15", () => {
    const r = envelopePedidoBusca.safeParse(pedidoBuscaExemplo);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.meta.limit).toBe(15);
    expect(r.data.meta.total_count).toBe(2);
    expect(r.data.objects.map((o) => o.numero)).toEqual([164, 165]);
    // The stamp is carried through untouched: canonicalising it is the app's job.
    expect(r.data.objects.map((o) => o.data_modificacao)).toEqual([
      '2022-10-31T12:17:58.949670',
      '2022-10-31T12:28:12.653648',
    ]);
  });

  it('a quoted numero reads as the number (one quoting serializer must not cost the page)', () => {
    expect(liPedidoBuscaLinhaSchema.parse({ ...linha164, numero: '164' }).numero).toBe(164);
  });

  it('near-miss: a numero that is not an integer, or absent, fails the row', () => {
    for (const numero of ['164.5', 164.5, 'cento', '', null, '9007199254740992']) {
      expect(
        liPedidoBuscaLinhaSchema.safeParse({ ...linha164, numero }).success,
        String(numero),
      ).toBe(false);
    }
    const { numero: _numero, ...semNumero } = linha164;
    expect(liPedidoBuscaLinhaSchema.safeParse(semNumero).success).toBe(false);
  });

  it('data_modificacao is NOT validated here: any shape, or none, still parses the row', () => {
    for (const data_modificacao of [
      '2022-10-31 12:17:58',
      '2022-10-31T12:17:58Z',
      1667218678,
      null,
      { $date: 'x' },
    ]) {
      const r = liPedidoBuscaLinhaSchema.safeParse({ ...linha165, data_modificacao });
      expect(r.success, JSON.stringify(data_modificacao)).toBe(true);
      if (r.success) expect(r.data.data_modificacao).toEqual(data_modificacao);
    }
    // An ABSENT key too: under a bare `z.unknown()` Zod 4 fails it as `nonoptional`.
    const { data_modificacao: _data, ...semData } = linha165;
    const r = liPedidoBuscaLinhaSchema.safeParse(semData);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.data_modificacao).toBeUndefined();
  });

  it('one odd stamp does not cost the page: the envelope still parses every row', () => {
    const r = envelopePedidoBusca.safeParse({
      ...pedidoBuscaExemplo,
      objects: [{ ...linha164, data_modificacao: 'ontem' }, linha165],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.objects.map((o) => o.numero)).toEqual([164, 165]);
  });

  it('every undeclared field of the row is kept (passthrough)', () => {
    const r = liPedidoBuscaLinhaSchema.parse({ ...linha165, campo_novo: 1 });
    expect(r).toMatchObject({
      situacao: { codigo: 'pedido_cancelado' },
      resource_uri: '/api/v1/pedido/165',
      campo_novo: 1,
    });
  });
});
