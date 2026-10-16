import { describe, expect, it } from 'vitest';
import {
  AmazonConfigError,
  MAX_USER_AGENT,
  criarClienteSpApi,
} from '@delfrance/integrations-amazon-sp-api';

import { AGENTE_USUARIO_AMAZON } from './agente';

describe('AGENTE_USUARIO_AMAZON', () => {
  it('is accepted by the package (printable ASCII, no edge spaces, within the limit)', () => {
    expect(AGENTE_USUARIO_AMAZON.length).toBeLessThanOrEqual(MAX_USER_AGENT);
    expect(() =>
      criarClienteSpApi({
        obterCredencial: () => ({ accessToken: 'x', ref: 'r' }),
        userAgent: AGENTE_USUARIO_AMAZON,
        fetch: () => Promise.reject(new Error('nunca chamado')),
      }),
    ).not.toThrow(AmazonConfigError);
  });

  it('follows Amazon’s `AppId/Version (Language=…)` shape and names no store or brand', () => {
    expect(AGENTE_USUARIO_AMAZON).toMatch(/^[a-z-]+\/\d+\.\d+ \(Language=TypeScript\)$/);
    expect(AGENTE_USUARIO_AMAZON.toLowerCase()).not.toMatch(/amazon|delfrance|loja|store/);
  });
});
