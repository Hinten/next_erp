/**
 * The Vitest env pin (`packages/integrations/nfe/vitest.config.ts`).
 *
 * The config hoists the repo-root `.env` / `.env.local` and the shell env into the
 * test env; the pin then writes `NFE_AMBIENTE` and `NFE_ALLOW_PRODUCAO` AFTER those
 * spreads. These cases deliberately use NO `vi.stubEnv` — they assert the ambient
 * env every other test in this package runs under, so a `.env.local` carrying
 * `NFE_ALLOW_PRODUCAO=true` cannot open a produção socket from any Vitest run here.
 */
import { describe, expect, it } from 'vitest';

import {
  assertSafeEndpointForTransport,
  assertSafeTpAmbForTransport,
  NFeProductionGuardError,
} from '../../src/safety/index';
import { getEndpoints } from '../../src/endpoints/index';

describe('vitest env pin — homologação only', () => {
  it('pins NFE_AMBIENTE to homologação and NFE_ALLOW_PRODUCAO to the empty string', () => {
    expect(process.env.NFE_AMBIENTE).toBe('homologacao');
    // `''`, not merely "not 'true'": CI never sets the key, so an absent pin
    // (undefined) must fail here too.
    expect(process.env.NFE_ALLOW_PRODUCAO).toBe('');
  });

  it("the label guard refuses tpAmb='1' under the ambient env", () => {
    expect(() => assertSafeTpAmbForTransport('1')).toThrow(NFeProductionGuardError);
    expect(() => assertSafeTpAmbForTransport('1')).toThrow(/NFE_ALLOW_PRODUCAO/);
  });

  it('the endpoint guard refuses a produção URL under the ambient env, whatever the label', () => {
    const url = getEndpoints('SP', 'producao').NfeAutorizacao;
    expect(() => assertSafeEndpointForTransport(url, '1')).toThrow(NFeProductionGuardError);
    expect(() => assertSafeEndpointForTransport(url, '2')).toThrow(NFeProductionGuardError);
  });
});
