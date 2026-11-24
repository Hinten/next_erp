/**
 * The listings flows' closed set: the valves' batch flows, by value, and a
 * module that loads nothing.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { FLUXOS_COM_LOTE, FLUXO_AMAZON } from '../core/valvulas';
import { FLUXO_LISTING_AMAZON } from './fluxoListing';

describe('the listings flows', () => {
  it('are the valves’ batch flows, by value and in order: one name reaches the valve, the feed lease and the shared modules', () => {
    expect(Object.values(FLUXO_LISTING_AMAZON)).toEqual([...FLUXOS_COM_LOTE]);
  });

  it('each key is its own slug', () => {
    for (const [chave, fluxo] of Object.entries(FLUXO_LISTING_AMAZON)) expect(fluxo).toBe(chave);
  });

  it('NEAR-MISS: a write flow that sends no listing value (the NF-e, the scheduling) is not one', () => {
    const fluxos: readonly string[] = Object.values(FLUXO_LISTING_AMAZON);
    expect(fluxos).not.toContain(FLUXO_AMAZON.nfe);
    expect(fluxos).not.toContain(FLUXO_AMAZON.agendamento);
  });

  it('the module loads nothing: a flow can be named from any closure', () => {
    const fonte = readFileSync(new URL('./fluxoListing.ts', import.meta.url), 'utf8');
    expect(fonte).not.toMatch(/\bimport\b|\brequire\(/);
  });
});
