import { describe, expect, it } from 'vitest';
import { historicoCustoMeta, historicoPrecoMeta } from './historicos';

describe('legacy produto price/cost history metadata', () => {
  it('keeps both imported-history collections server-owned and client read-only', () => {
    expect(historicoPrecoMeta.serverOwned).toBe(true);
    expect(historicoCustoMeta.serverOwned).toBe(true);
  });
});

