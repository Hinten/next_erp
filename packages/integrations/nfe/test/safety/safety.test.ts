import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAnEndpoints,
  getEndpoints,
  getSvcEndpoints,
  sefazHostsFor,
  supportedUFs,
} from '../../src/endpoints/index';
import {
  assertSafeEndpointForTransport,
  assertSafeTpAmb,
  assertSafeTpAmbForTransport,
  NFeProductionGuardError,
  producaoOnlySefazHosts,
  tpAmbFromAmbiente,
} from '../../src/safety/index';

describe('assertSafeTpAmb', () => {
  beforeEach(() => {
    // Vitest sets NODE_ENV='test' by default. The guard's "test passthrough"
    // branch is exercised in its own test below; here we want to verify the
    // explicit-opt-in branch in isolation, so we mask the NODE_ENV signal.
    vi.stubEnv('NODE_ENV', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows tpAmb='2' (homologação) unconditionally", () => {
    expect(() => assertSafeTpAmb('2')).not.toThrow();
  });

  it("rejects tpAmb='1' (produção) by default", () => {
    expect(() => assertSafeTpAmb('1')).toThrow(NFeProductionGuardError);
  });

  it("allows tpAmb='1' when NFE_ALLOW_PRODUCAO=true", () => {
    vi.stubEnv('NFE_ALLOW_PRODUCAO', 'true');
    expect(() => assertSafeTpAmb('1')).not.toThrow();
  });

  it("rejects tpAmb='1' when NFE_ALLOW_PRODUCAO is any other value", () => {
    for (const v of ['1', 'yes', 'TRUE', '']) {
      vi.stubEnv('NFE_ALLOW_PRODUCAO', v);
      expect(() => assertSafeTpAmb('1')).toThrow(NFeProductionGuardError);
    }
  });

  it("allows tpAmb='1' when NODE_ENV='test' (Vitest passthrough)", () => {
    vi.stubEnv('NODE_ENV', 'test');
    expect(() => assertSafeTpAmb('1')).not.toThrow();
  });

  it('error message points at the right env var', () => {
    try {
      assertSafeTpAmb('1');
    } catch (err) {
      expect(err).toBeInstanceOf(NFeProductionGuardError);
      expect((err as Error).message).toContain('NFE_ALLOW_PRODUCAO');
      expect((err as Error).message).toContain("tpAmb='1'");
    }
  });
});

/**
 * The transport-boundary guard. Everything here is about ONE difference from
 * `assertSafeTpAmb`: there is no `NODE_ENV='test'` escape.
 *
 * ⚠️ These tests deliberately do NOT stub `NODE_ENV`. Vitest sets it to `'test'`,
 * and that ambient value IS the condition under test — the `nfe-live` CI job runs
 * the live homologação suites through Vitest against the real SEFAZ endpoints, so
 * for the whole of that job `NODE_ENV='test'` holds while real requests go out. A
 * test that masked it would be asserting against an environment CI never has.
 */
describe('assertSafeTpAmbForTransport', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows tpAmb='2' (homologação) unconditionally", () => {
    expect(() => assertSafeTpAmbForTransport('2')).not.toThrow();
  });

  it("rejects tpAmb='1' under Vitest, where assertSafeTpAmb would let it through", () => {
    // The regression, stated as a comparison so the difference cannot be optimised
    // away by "simplifying" one into the other.
    expect(process.env.NODE_ENV).toBe('test');
    expect(() => assertSafeTpAmb('1')).not.toThrow();
    expect(() => assertSafeTpAmbForTransport('1')).toThrow(NFeProductionGuardError);
  });

  it("still allows tpAmb='1' when NFE_ALLOW_PRODUCAO=true", () => {
    vi.stubEnv('NFE_ALLOW_PRODUCAO', 'true');
    expect(() => assertSafeTpAmbForTransport('1')).not.toThrow();
  });

  it("rejects tpAmb='1' when NFE_ALLOW_PRODUCAO is any other value", () => {
    for (const v of ['1', 'yes', 'TRUE', 'false', '']) {
      vi.stubEnv('NFE_ALLOW_PRODUCAO', v);
      expect(() => assertSafeTpAmbForTransport('1'), `NFE_ALLOW_PRODUCAO=${v}`).toThrow(
        NFeProductionGuardError,
      );
    }
  });

  it('says out loud that NODE_ENV=test does not clear it', () => {
    // The error is the only place a confused caller will look.
    try {
      assertSafeTpAmbForTransport('1');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NFeProductionGuardError);
      expect((err as Error).message).toContain('NFE_ALLOW_PRODUCAO');
      expect((err as Error).message).toContain('NODE_ENV=test');
    }
  });
});

/**
 * The destination guard. `SefazCall.tpAmb` and `SefazCall.url` are independent
 * fields, so the label guard above passes `{ tpAmb: '2', url: <produção> }`.
 *
 * ⚠️ Like the label guard's tests, these do NOT stub `NODE_ENV` — Vitest's ambient
 * `'test'` is the condition the live CI suites run under.
 */
describe('assertSafeEndpointForTransport', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Every (label, URL) pair the endpoint tables hold for one ambiente. */
  function tableUrls(ambiente: 'producao' | 'homologacao'): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    const add = (tag: string, table: object) => {
      for (const [service, url] of Object.entries(table)) {
        if (typeof url === 'string') out.push([`${tag}.${service}`, url]);
      }
    };
    for (const uf of supportedUFs()) add(uf, getEndpoints(uf, ambiente));
    add('SVC-AN', getSvcEndpoints('svc-an', ambiente));
    add('SVC-RS', getSvcEndpoints('svc-rs', ambiente));
    add('AN', getAnEndpoints(ambiente));
    return out;
  }

  const hostOf = (url: string) => new URL(url).hostname.toLowerCase();

  it('pins the hosts that serve BOTH ambientes — a new one must be a conscious decision', () => {
    const homologacao = sefazHostsFor('homologacao');
    const shared = [...sefazHostsFor('producao')].filter((h) => homologacao.has(h)).sort();
    // RS points Consulta Cadastro at the same URL for both ambientes; only the
    // tpAmb label can tell them apart there, so the host guard must stand aside.
    expect(shared).toEqual(['cad.svrs.rs.gov.br']);
    expect(producaoOnlySefazHosts().has('cad.svrs.rs.gov.br')).toBe(false);
  });

  it('treats every other produção host as produção-only (anti-vacuity)', () => {
    const producaoOnly = producaoOnlySefazHosts();
    expect(producaoOnly.size).toBeGreaterThan(10);
    for (const [where, url] of tableUrls('producao')) {
      if (hostOf(url) === 'cad.svrs.rs.gov.br') continue;
      expect(producaoOnly.has(hostOf(url)), where).toBe(true);
    }
  });

  it("refuses tpAmb='2' on every produção-only URL, even with NFE_ALLOW_PRODUCAO=true", () => {
    vi.stubEnv('NFE_ALLOW_PRODUCAO', 'true');
    let checked = 0;
    for (const [where, url] of tableUrls('producao')) {
      if (!producaoOnlySefazHosts().has(hostOf(url))) continue;
      expect(() => assertSafeEndpointForTransport(url, '2'), where).toThrow(
        /label and the URL disagree/,
      );
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("refuses tpAmb='1' on every produção-only URL without the opt-in, under NODE_ENV=test", () => {
    expect(process.env.NODE_ENV).toBe('test');
    for (const v of ['1', 'yes', 'TRUE', 'false', '']) {
      vi.stubEnv('NFE_ALLOW_PRODUCAO', v);
      for (const [where, url] of tableUrls('producao')) {
        if (!producaoOnlySefazHosts().has(hostOf(url))) continue;
        expect(() => assertSafeEndpointForTransport(url, '1'), `${where} ${v}`).toThrow(
          NFeProductionGuardError,
        );
      }
    }
  });

  it("allows tpAmb='1' on a produção-only URL only with NFE_ALLOW_PRODUCAO=true", () => {
    vi.stubEnv('NFE_ALLOW_PRODUCAO', 'true');
    const url = getEndpoints('SP', 'producao').NfeAutorizacao;
    expect(() => assertSafeEndpointForTransport(url, '1')).not.toThrow();
  });

  it('near-miss: every homologação URL passes with the homologação label', () => {
    // Includes the shared RS Consulta Cadastro URL — the one byte-identical to its
    // produção twin — which is exactly why the host set is a DIFFERENCE.
    const urls = tableUrls('homologacao');
    expect(urls.length).toBeGreaterThan(50);
    for (const [where, url] of urls) {
      expect(() => assertSafeEndpointForTransport(url, '2'), where).not.toThrow();
    }
  });

  it('cannot be dodged by host case or a trailing root dot', () => {
    for (const url of [
      'https://NFE.FAZENDA.SP.GOV.BR/ws/nfeautorizacao4.asmx',
      'https://nfe.fazenda.sp.gov.br./ws/nfeautorizacao4.asmx',
      'https://nfe.fazenda.sp.gov.br:443/ws/some-unlisted-service.asmx',
    ]) {
      expect(() => assertSafeEndpointForTransport(url, '2'), url).toThrow(NFeProductionGuardError);
    }
  });

  it('leaves non-SEFAZ destinations (test fakes, garbage) to the label guard', () => {
    for (const url of [
      'https://example/svc',
      'https://sefaz.example.invalid/NfeAutorizacao',
      'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx',
      'not a url',
      '',
    ]) {
      expect(() => assertSafeEndpointForTransport(url, '2'), url).not.toThrow();
    }
  });
});

/**
 * Wiring: the SOAP layer must use the TRANSPORT variant at every POST.
 *
 * Without this the two functions above can both be correct while `soap/index.ts`
 * still calls the permissive one, which is exactly the state this change found.
 */
describe('the SOAP layer is wired to the transport guard', () => {
  it('has one transport guard per POST boundary, counted rather than hardcoded', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../../src/soap/index.ts'), 'utf8');

    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
      .join('\n');

    // Everything funnels through `postSoap(`, so its CALL sites are the complete
    // set of boundaries that can put bytes on the wire.
    //
    // ⚠️ Two exclusions, both load-bearing. The lookbehind drops the DEFINITION
    // (`async function postSoap(`) — without it the count is 3 against 2 guards,
    // which is how this assertion first failed. And `postSoap\(` cannot match
    // `postSoapValidated(`, since the paren must follow immediately; that wrapper
    // is a call site in its own right and is counted once, correctly.
    const posts = (code.match(/(?<!function )postSoap\(/g) ?? []).length;
    const guards = (code.match(/assertSafeTpAmbForTransport\(/g) ?? []).length;

    // Anti-vacuity: a regex that stopped matching would make the equality below
    // trivially true at 0 === 0.
    expect(posts, 'found no postSoap() call sites — this scanner has rotted').toBeGreaterThan(0);

    // Derived, not hardcoded. A hardcoded 2 reds on CORRECT code the moment a
    // third boundary is added WITH a guard, and — worse — stays green when a third
    // is added WITHOUT one. Tying the two counts together catches both.
    expect(
      guards,
      `${posts} postSoap() call site(s) but ${guards} assertSafeTpAmbForTransport() call(s). ` +
        'Every boundary that can reach SEFAZ must be guarded immediately before the POST.',
    ).toBe(posts);

    // The label guard alone trusts `call.tpAmb`, which is independent of `call.url`
    // — so every boundary also judges the destination. Same derived count.
    const endpointGuards = (code.match(/assertSafeEndpointForTransport\(/g) ?? []).length;
    expect(
      endpointGuards,
      `${posts} postSoap() call site(s) but ${endpointGuards} assertSafeEndpointForTransport() ` +
        'call(s). A tpAmb label cannot prove where the bytes go; guard the URL at every boundary.',
    ).toBe(posts);

    // ...and none of them may use the permissive variant, whose NODE_ENV='test'
    // passthrough is a no-op under the live suites. `assertSafeTpAmb\(` cannot
    // match the transport name, since that one has `ForTransport` before the paren.
    expect(code, 'the generator-boundary guard is not valid at transport').not.toMatch(
      /assertSafeTpAmb\(/,
    );
  });
});

/**
 * The generator boundary the safety module's docstring has always claimed.
 *
 * ⚠️ It was never wired: before this change `assertSafeTpAmb` had ZERO production
 * call sites — only its own definition and this test file — while
 * `apps/nfe/apphosting.yaml`, `apps/nfe/CLAUDE.md` and the package README all named
 * it as the guard on the emission path. The doc and the code disagreed, which is the
 * same drift that let the transport hole survive.
 */
describe('the generator is wired to the produção guard', () => {
  it('calls assertSafeTpAmb in generateNFe', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../../src/generator/index.ts'), 'utf8');
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
      .join('\n');

    expect(code).toMatch(/assertSafeTpAmb\(tpAmbFromAmbiente\(/);
    // The permissive variant is the right one here: nothing in the generator opens
    // a socket, and its own tests build produção XML deliberately.
    expect(code, 'the transport guard would break the generator produção tests').not.toMatch(
      /assertSafeTpAmbForTransport\(/,
    );
  });
});

describe('tpAmbFromAmbiente', () => {
  it("maps 'producao' → '1'", () => {
    expect(tpAmbFromAmbiente('producao')).toBe('1');
  });

  it("maps 'homologacao' → '2'", () => {
    expect(tpAmbFromAmbiente('homologacao')).toBe('2');
  });
});
