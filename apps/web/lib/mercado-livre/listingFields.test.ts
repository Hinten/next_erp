import { describe, expect, it } from 'vitest';

import { linkFixture } from './linkFixture';
import {
  channelOptions,
  channelsLabel,
  channelsToPreset,
  linkSoldQuantity,
  listingTypeLabel,
  parseRawChannelValue,
  presetToChannels,
  rawChannelValue,
  titleEditability,
} from './listingFields';

describe('channels presets', () => {
  it('recognises each preset regardless of order', () => {
    expect(channelsToPreset(['marketplace'])).toBe('marketplace');
    expect(channelsToPreset(['mshops'])).toBe('mshops');
    expect(channelsToPreset(['mshops', 'marketplace'])).toBe('todos');
  });

  it('returns null for a combination we do not model', () => {
    // ML accepts channel values this app has never heard of, and guessing the
    // "nearest" preset would silently drop one on the next save.
    expect(channelsToPreset(['marketplace', 'mercado_livre_ads'])).toBeNull();
    expect(channelsToPreset([])).toBeNull();
    expect(channelsToPreset(null)).toBeNull();
  });

  it('round-trips a preset to its stored array', () => {
    expect(presetToChannels('todos')).toEqual(['marketplace', 'mshops']);
    expect(presetToChannels('nao-existe')).toBeNull();
  });

  it('keeps an unmodelled value selectable instead of blanking the Select', () => {
    // A Select bound to a value missing from `data` renders empty, and the first
    // interaction would write a preset over the stored combination.
    const current = ['marketplace', 'mercado_livre_ads'];
    const options = channelOptions(current);
    expect(options).toHaveLength(4);
    const extra = options[3]!;
    expect(extra.label).toBe('marketplace, mercado_livre_ads (atual)');
    expect(parseRawChannelValue(extra.value)).toEqual(current);
  });

  it('adds no extra option when the stored value IS a preset', () => {
    expect(channelOptions(['marketplace'])).toHaveLength(3);
    expect(channelOptions(null)).toHaveLength(3);
  });

  it('only decodes its own sentinel', () => {
    expect(parseRawChannelValue('marketplace')).toBeNull();
    expect(parseRawChannelValue(rawChannelValue(['a', 'b']))).toEqual(['a', 'b']);
  });

  it('labels a stored array', () => {
    expect(channelsLabel(['marketplace', 'mshops'])).toBe('Todos');
    expect(channelsLabel(['xpto'])).toBe('xpto');
    expect(channelsLabel([])).toBeNull();
  });
});

describe('listingTypeLabel', () => {
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
