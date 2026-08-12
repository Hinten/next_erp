import { describe, expect, it } from 'vitest';

import { linkFixture } from './linkFixture';
import {
  DEFAULT_LISTING_TYPE,
  LISTING_TYPE_OPTIONS,
  linkSoldQuantity,
  listingTypeLabel,
  titleEditability,
} from './listingFields';

describe('listing types', () => {
  it('defaults a new listing to Premium', () => {
    // Premium is what the operation actually sells on; Clássico was only ever
    // the default because it happened to be first in the array.
    expect(DEFAULT_LISTING_TYPE).toBe('gold_pro');
    expect(LISTING_TYPE_OPTIONS[0].value).toBe(DEFAULT_LISTING_TYPE);
  });

  it('names the known types and passes through the rest', () => {
    expect(listingTypeLabel('gold_special')).toBe('Clássico');
    expect(listingTypeLabel('free')).toBe('free');
    expect(listingTypeLabel(null)).toBeNull();
  });
});

describe('linkSoldQuantity', () => {
  it('reads either spelling', () => {
    expect(linkSoldQuantity(linkFixture({ soldQuantity: 3 } as never))).toBe(3);
    expect(linkSoldQuantity(linkFixture({ sold_quantity: 5 } as never))).toBe(5);
  });

  it('is null when absent or not a number', () => {
    expect(linkSoldQuantity(linkFixture())).toBeNull();
    expect(linkSoldQuantity(linkFixture({ soldQuantity: '4' } as never))).toBeNull();
  });
});

describe('titleEditability', () => {
  it('always allows editing a draft that was never published', () => {
    expect(titleEditability(linkFixture({ id: null })).editable).toBe(true);
  });

  it('blocks a listing that already sold', () => {
    const rule = titleEditability(linkFixture({ soldQuantity: 1 } as never));
    expect(rule.editable).toBe(false);
    expect(rule.reason).toMatch(/já teve vendas/);
  });

  it('allows editing when the sold quantity is unknown', () => {
    // The count is a derived cache the Flutter app strips on every save, so
    // "unknown" is the normal state. Treating it as "sold" would freeze the
    // field on nearly every listing; a wrong guess only costs an ML rejection.
    expect(titleEditability(linkFixture({ id: 'MLB1' })).editable).toBe(true);
  });

  it('allows editing a PAUSED listing', () => {
    // Guarding on `status === 'active'` would lock the field exactly when the
    // operator is trying to fix the title that caused the pause.
    expect(titleEditability(linkFixture({ status: 'paused' })).editable).toBe(true);
  });

  it('blocks a closed listing', () => {
    const rule = titleEditability(linkFixture({ status: 'closed' }));
    expect(rule.editable).toBe(false);
    expect(rule.reason).toMatch(/encerrado/);
  });

  it('reports zero sales as editable', () => {
    expect(titleEditability(linkFixture({ soldQuantity: 0 } as never)).editable).toBe(true);
  });
});
