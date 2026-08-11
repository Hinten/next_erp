import { describe, expect, it } from 'vitest';

import { linkFixture } from './linkFixture';
import { listingFormSchema, toFormValues, toPatchValues } from './listingForm';
import { rawChannelValue } from './listingFields';

function values(over: Record<string, unknown> = {}) {
  return listingFormSchema.parse({
    title: 'Camiseta',
    descricao: '',
    condition: 'new',
    channels: 'marketplace',
    category_id: 'MLB31447',
    listing_type_id: 'gold_special',
    tarifaFrete: null,
    crossdocking: null,
    video_id: '',
    ...over,
  });
}

describe('toFormValues', () => {
  it('turns every nullable doc field into something an input can hold', () => {
    const form = toFormValues(linkFixture({ descricao: null, video_id: null }));
    expect(form.descricao).toBe('');
    expect(form.video_id).toBe('');
    expect(form.title).toBe('Camiseta Básica');
    expect(form.channels).toBe('marketplace');
  });

  it('carries an unmodelled channels array through verbatim', () => {
    const form = toFormValues(linkFixture({ channels: ['marketplace', 'xpto'] }));
    expect(form.channels).toBe(rawChannelValue(['marketplace', 'xpto']));
  });

  it('defaults an empty channels array to marketplace', () => {
    expect(toFormValues(linkFixture({ channels: [] })).channels).toBe('marketplace');
  });

  it('treats any non-used condition as new', () => {
    expect(toFormValues(linkFixture({ condition: 'used' })).condition).toBe('used');
    expect(toFormValues(linkFixture({ condition: 'new' })).condition).toBe('new');
  });
});

describe('toPatchValues', () => {
  it('expands the preset back into the stored array', () => {
    expect(toPatchValues(values({ channels: 'todos' })).channels).toEqual([
      'marketplace',
      'mshops',
    ]);
  });

  it('restores an unmodelled channels array unchanged', () => {
    const raw = rawChannelValue(['marketplace', 'xpto']);
    expect(toPatchValues(values({ channels: raw })).channels).toEqual(['marketplace', 'xpto']);
  });

  it('turns a cleared text input into null, not an empty string', () => {
    // ML reads '' as a real value: an empty `video_id` asks it to attach a video
    // with no id rather than to remove the video.
    const patch = toPatchValues(values({ video_id: '', descricao: '   ' }));
    expect(patch.video_id).toBeNull();
    expect(patch.descricao).toBeNull();
  });

  it('trims the title', () => {
    expect(toPatchValues(values({ title: '  Camiseta  ' })).title).toBe('Camiseta');
  });

  it('maps an unset category to null, not an empty string', () => {
    // A draft may be saved before its category is chosen; `''` would be a real
    // value ML then rejects, and would defeat the "categoria não definida"
    // check that keeps Publicar disabled.
    expect(toPatchValues(values({ category_id: '' })).category_id).toBeNull();
    expect(toPatchValues(values({ category_id: 'MLB31447' })).category_id).toBe('MLB31447');
  });

  it('keeps numeric nulls as null rather than zero', () => {
    const patch = toPatchValues(values({ tarifaFrete: null, crossdocking: null }));
    expect(patch.tarifaFrete).toBeNull();
    expect(patch.crossdocking).toBeNull();
    const filled = toPatchValues(values({ tarifaFrete: 0, crossdocking: 0 }));
    expect(filled.tarifaFrete).toBe(0);
    expect(filled.crossdocking).toBe(0);
  });
});

describe('listingFormSchema', () => {
  it('refuses a blank title', () => {
    expect(listingFormSchema.safeParse({ ...values(), title: '   ' }).success).toBe(false);
  });

  it('refuses a fractional crossdocking', () => {
    expect(listingFormSchema.safeParse({ ...values(), crossdocking: 1.5 }).success).toBe(false);
  });

  it('refuses a negative tarifa', () => {
    expect(listingFormSchema.safeParse({ ...values(), tarifaFrete: -1 }).success).toBe(false);
  });

  it('accepts a title longer than the ML limit', () => {
    // The 60-char cap is an input `maxLength`, not a validation rule: a stored
    // title that already exceeds it must not block an unrelated edit on the
    // same form — this screen is the only place it can be shortened.
    expect(listingFormSchema.safeParse({ ...values(), title: 'x'.repeat(120) }).success).toBe(true);
  });
});
