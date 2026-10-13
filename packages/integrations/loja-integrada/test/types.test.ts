import { describe, expect, it } from 'vitest';

import { liCategoriaSchema, liEnvelopeSchema, liMetaSchema } from '../src/types';
import { categoriaPagina1, categoriaUltimaPagina, metaLimite15 } from './_fixtures/especificacao';

const envelopeCategoria = liEnvelopeSchema(liCategoriaSchema);

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
