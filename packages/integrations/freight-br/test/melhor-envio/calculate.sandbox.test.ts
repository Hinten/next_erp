/**
 * Live Melhor Envio **sandbox** smoke test — the read-only half of the F5.4
 * live lane. It exercises the real `sandbox.melhorenvio.com.br` API with a
 * connected account's access token: `GET /me`, `GET /me/balance`, and a
 * `POST /me/shipment/calculate` quote. All three are READ-ONLY — no cart
 * insert, no checkout, no generate — so the test never spends wallet balance
 * nor creates a label.
 *
 * Gating mirrors the NF-e homologação suites: the suite `describe.skip`s
 * locally when `MELHOR_ENVIO_SANDBOX_TOKEN` is absent, but THROWS in CI
 * (`CI=true`) so a missing secret can't masquerade as a green run. The
 * `ci-freight.yml` `freight-live` job is itself gated behind
 * `vars.FREIGHT_CI_LIVE_ENABLED` / `workflow_dispatch`, so normal PRs (and
 * fork PRs that can't read secrets) never reach here.
 *
 * The `.sandbox.test.ts` suffix keeps it OUT of the offline lane (which
 * excludes that glob); the live job invokes it by name.
 *
 * Token upkeep: ME sandbox access tokens last ~30 days. When this lane starts
 * returning 401, re-mint the token (the OAuth connect flow on a sandbox
 * account, or a stored refresh token) and update the
 * `MELHOR_ENVIO_SANDBOX_TOKEN` secret. See the `freight-integrations` skill.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { createMelhorEnvioApi } from '../../src/melhor-envio/api';
import { buildCalculatePayload } from '../../src/melhor-envio/calculate';
import { isErroredOption } from '../../src/melhor-envio/types';
import { melhorEnvioBaseUrl } from '../../src/melhor-envio/oauth';

// This package is browser-safe (no `@types/node`), so read env through a typed
// `globalThis` accessor rather than the untyped `process` global — matching the
// package's `globalThis.fetch` idiom. `process` exists at runtime (vitest's
// node environment), it's only missing from the type lib.
const env: Record<string, string | undefined> =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

const TOKEN = env.MELHOR_ENVIO_SANDBOX_TOKEN?.trim();
const USER_AGENT =
  env.MELHOR_ENVIO_USER_AGENT?.trim() || '@delfrance/erp-next (contato@delfrance.com.br)';

const hasCreds = Boolean(TOKEN);
// Skip locally without a token; THROW in CI so a missing secret fails loud
// instead of silently running nothing (matches the NF-e live lanes).
const describeOrSkip = !hasCreds && !env.CI ? describe.skip : describe;

describeOrSkip('Melhor Envio sandbox (live, read-only)', () => {
  beforeAll(() => {
    if (!hasCreds) {
      throw new Error(
        'MELHOR_ENVIO_SANDBOX_TOKEN is not set — required for the freight-live sandbox lane in CI.',
      );
    }
  });

  function api() {
    return createMelhorEnvioApi({
      baseUrl: melhorEnvioBaseUrl(true), // sandbox.melhorenvio.com.br
      getAccessToken: async () => TOKEN!,
      userAgent: USER_AGENT,
    });
  }

  it('authenticates and resolves the connected account via GET /me', async () => {
    // Resolving without a throw already proves the token authenticates and the
    // response parses against `meSchema`; we don't assert the account identity.
    const me = await api().getMe();
    expect(me).toBeTruthy();
    expect(me.id ?? me.email).toBeTruthy();
  });

  it('reads the wallet balance via GET /me/balance', async () => {
    const bal = await api().getBalance();
    expect(typeof bal.balance).toBe('number');
  });

  it('quotes SP→RJ via POST /me/shipment/calculate', async () => {
    const quotes = await api().calculate(
      buildCalculatePayload({
        fromPostalCode: '01001000', // Praça da Sé, São Paulo
        toPostalCode: '20040002', // Centro, Rio de Janeiro
        volumes: [{ width: 16, height: 5, length: 20, weight: 0.5 }],
      }),
    );
    // ME returns a list of carrier options; each is either quotable (carries a
    // `price` + `company`) or errored (no pricing). We assert connectivity +
    // shape, not specific carriers — those vary by the account's contracts.
    expect(Array.isArray(quotes)).toBe(true);
    expect(quotes.length).toBeGreaterThan(0);
    for (const q of quotes) {
      if (!isErroredOption(q)) expect(q.price).toBeTruthy();
    }
    // The sandbox account must have at least one carrier that quotes SP→RJ —
    // a route every default Correios contract covers. An all-errored response
    // means the account has no usable contracts (a setup problem, not a pass).
    expect(quotes.some((q) => !isErroredOption(q))).toBe(true);
  });
});
