import { describe, expect, it } from 'vitest';

import { linkFixture } from './linkFixture';
import { listingFormSchema, toFormValues, toPatchValues } from './listingForm';
import { OPERATOR_OWNED_KEYS } from './listingPatch';

function values(over: Record<string, unknown> = {}) {
  return listingFormSchema.parse({
    title: 'Camiseta',
    descricao: '',
    category_id: 'MLB31447',
    listing_type_id: 'gold_pro',
    ...over,
  });
}

describe('what the form is allowed to edit', () => {
  // The listing form holds what the OPERATOR decides; the produto holds what
  // the PRODUCT is. `crossdocking` and `video_id` are produto fields, and
  // `channels`/`crossdocking` never reach the ML payload at all — an editable
  // second copy could only diverge from what publish reads.
  it('offers no field the produto already owns', () => {
    const fields = Object.keys(listingFormSchema.shape);
    for (const gone of ['channels', 'crossdocking', 'video_id', 'tarifaFrete', 'condition']) {
      expect(fields).not.toContain(gone);
    }
  });

  it('keeps those keys out of the patch allow-list too', () => {
    // Leaving them in OPERATOR_OWNED_KEYS would let a stale form value ride a
    // save even with no control on screen.
    for (const gone of ['channels', 'crossdocking', 'video_id', 'tarifaFrete', 'condition']) {
      expect(OPERATOR_OWNED_KEYS).not.toContain(gone);
    }
  });
});

describe('toFormValues', () => {
  it('turns every nullable doc field into something an input can hold', () => {
    const form = toFormValues(linkFixture({ descricao: null }));
    expect(form.descricao).toBe('');
    expect(form.title).toBe('Camiseta Básica');
    expect(form.category_id).toBe('MLB31447');
  });

  it('presents an unset category as an empty string', () => {
    expect(toFormValues(linkFixture({ category_id: null })).category_id).toBe('');
  });
});

describe('toPatchValues', () => {
  it('turns a cleared text input into null, not an empty string', () => {
    // ML reads '' as a real value rather than an absence.
    expect(toPatchValues(values({ descricao: '   ' })).descricao).toBeNull();
  });

  it('trims the title', () => {
    expect(toPatchValues(values({ title: '  Camiseta  ' })).title).toBe('Camiseta');
  });

  it('maps an unset category to null, not an empty string', () => {
    // `''` would be a real value ML rejects, and would defeat the
    // "categoria não definida" check that keeps Publicar disabled.
    expect(toPatchValues(values({ category_id: '' })).category_id).toBeNull();
    expect(toPatchValues(values({ category_id: 'MLB31447' })).category_id).toBe('MLB31447');
  });

  it('writes only keys the allow-list covers', () => {
    for (const key of Object.keys(toPatchValues(values()))) {
      expect(OPERATOR_OWNED_KEYS).toContain(key);
    }
  });
});

describe('listingFormSchema', () => {
  it('refuses a blank title', () => {
    expect(listingFormSchema.safeParse({ ...values(), title: '   ' }).success).toBe(false);
  });

  it('accepts a title longer than the ML limit', () => {
    // The 60-char cap is an input `maxLength`, not a validation rule: a stored
    // title that already exceeds it must not block an unrelated edit on the
    // same form — this screen is the only place it can be shortened.
    expect(listingFormSchema.safeParse({ ...values(), title: 'x'.repeat(120) }).success).toBe(true);
  });

  it('lets a draft be saved before its category is chosen', () => {
    expect(listingFormSchema.safeParse({ ...values(), category_id: '' }).success).toBe(true);
  });
});
