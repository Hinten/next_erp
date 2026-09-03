import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Repo invariant: TWO plugin contracts were removed and neither may come back.
 *
 *  - **`MarketplaceChannel`** (#815, ADR 0015) — a marketplace is described by
 *    `MARKETPLACE_TIPO_CAPS` and implemented as one App Hosting backend.
 *  - **`PaymentGateway`** (#1429) — all three members threw, `registerPayment`
 *    had one caller (its own test), and the one live consumer was a permanently
 *    disabled button. Payments live in `apps/mercado-pago`.
 *
 * ## Why this is a test and not a comment
 *
 * Every part of this is invisible when violated. Re-adding a `MarketplaceChannel`
 * interface to `packages/core/src/plugins` typechecks, lints, builds and passes
 * every suite — it just recreates a contract that took one channel port to
 * disprove and that five throw-only scaffold packages existed to satisfy. The
 * same is true of a `'marketplace'` plugin kind in the SDK (it advertises a kind
 * nothing can register) and of re-exporting `@delfrance/core/marketplace` from
 * core's root barrel (that puts the model in every browser bundle, and, worse,
 * makes an unimplemented order model look like a shared surface).
 *
 * ⚠️ No capability table replaced the payment contract, deliberately:
 * `TIPO_INTEGRACAO_PGTO` is `z.literal(1)`, so a `Record` over it would be a
 * one-row table whose compile-error guarantee can never fire. The procedure for a
 * second provider (including when to add that table) is the docstring on
 * `tipoIntegracaoPgtoSchema` in `@delfrance/schemas`.
 *
 * The precedent is `ai-root-entry-browser-safe.test.js` and
 * `apphosting-next-pinned.test.js`: an invariant that is stated, true today, and
 * silent when broken. #815's own history is the argument — the docs guide kept
 * instructing plugin authors to implement four throwing members for months
 * because nothing failed.
 *
 * ⚠️ The `./marketplace` barrel rule cannot be checked the way `./cep`,
 * `./region` and `./wire` are checked inside `packages/core`. Those compare
 * runtime namespaces; the marketplace module is **types-only**, so its namespace
 * is empty and the comparison would pass for any content. It has to read source,
 * and `packages/core` has no `@types/node`. Hence this file.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

const read = (rel) => readFileSync(resolve(repoRoot, rel), 'utf8');

const CORE_PLUGINS = 'packages/core/src/plugins/index.ts';
const CORE_BARREL = 'packages/core/src/index.ts';
const SDK_INDEX = 'packages/plugin-sdk/src/index.ts';
const CAPS = 'packages/schemas/src/shared/marketplace.ts';
const MP_PACKAGE = 'packages/integrations/mercado-pago/src/index.ts';
const PAGAMENTO_SCHEMA = 'packages/schemas/src/pedido/collection/pagamento.ts';
/**
 * ⚠️ The file this guard was blind to until review caught it, and the one most
 * at risk: its own header opens with "There is deliberately **no
 * `MarketplaceChannel` interface here**, and adding one back is the mistake this
 * module exists to prevent." A guard that scans everywhere EXCEPT the module
 * whose docstring states the rule is decoration — appending an interface here
 * left this suite at 10/10 with typecheck and lint green, which is exactly the
 * silent-when-broken condition the file was written to close.
 */
const MARKETPLACE_MODEL = 'packages/core/src/marketplace/index.ts';

/* -------------------------------------------------------------------------- */
/*                      The detectors, and their two controls                 */
/* -------------------------------------------------------------------------- */

/** A `MarketplaceChannel` DECLARATION (not a mention in prose or a comment). */
const declaresMarketplaceChannel = (src) =>
  /^\s*export\s+(?:interface|type|class)\s+MarketplaceChannel\b/m.test(src);

/** A registry member for marketplaces. */
const hasMarketplaceRegistry = (src) =>
  /\bregisterMarketplace\s*\(/.test(src) || /\bmarketplaces\s*=\s*new Map\b/.test(src);

/** `'marketplace'` listed as a plugin manifest kind. */
const advertisesMarketplaceKind = (src) => /kinds\s*:\s*ReadonlyArray<[^>]*'marketplace'/.test(src);

/** A re-export of the `./marketplace` subpath from a barrel. */
const reExportsMarketplace = (src) => /(?:export|import)[^;\n]*from\s+'\.\/marketplace'/.test(src);

/**
 * The `MarketplaceChannel` NAME crossing a module boundary in a specifier list —
 * `export type { MarketplaceChannel } from '…'`.
 *
 * ⚠️ Separate from {@link declaresMarketplaceChannel}, which matches a
 * DECLARATION only and so let a re-export through; and separate from
 * {@link reExportsMarketplace}, which keys on the relative `./marketplace`
 * specifier that a package-path re-export (`@delfrance/core/marketplace`) never
 * carries. Anchored at a statement start, so the prose in every header that
 * names the removed contract does not trip it.
 */
const reExportsMarketplaceChannelSymbol = (src) =>
  /^\s*(?:export|import)\s+(?:type\s+)?\{[^}]*\bMarketplaceChannel\b/m.test(src);

/** A `PaymentGateway` DECLARATION (not a mention in prose or a comment). */
const declaresPaymentGateway = (src) =>
  /^\s*export\s+(?:interface|type|class)\s+PaymentGateway\b/m.test(src);

/** A registry member for payments, or the deleted Mercado Pago gateway factory. */
const hasPaymentRegistry = (src) =>
  /\bregisterPayment\s*\(/.test(src) || /\bpayments\s*=\s*new Map\b/.test(src);

const hasGatewayFactory = (src) => /\bcreateMercadoPagoGateway\s*\(/.test(src);

/** `'payment'` listed as a plugin manifest kind. */
const advertisesPaymentKind = (src) => /kinds\s*:\s*ReadonlyArray<[^>]*'payment'/.test(src);

describe('the detectors themselves', () => {
  // ⚠️ A checker needs BOTH controls: known-bad must fail, known-good must pass.
  // Without the known-bad half, a typo in a regex makes every assertion below
  // pass vacuously — which is the exact way a guard becomes decoration.
  it('flags a known-BAD source', () => {
    expect(
      declaresMarketplaceChannel('export interface MarketplaceChannel {\n  id: string;\n}'),
    ).toBe(true);
    expect(hasMarketplaceRegistry('  registerMarketplace(p: MarketplaceChannel) {}')).toBe(true);
    expect(hasMarketplaceRegistry('  private marketplaces = new Map<string, X>();')).toBe(true);
    expect(
      advertisesMarketplaceKind("  kinds: ReadonlyArray<'tax' | 'invoice' | 'marketplace'>;"),
    ).toBe(true);
    expect(reExportsMarketplace("export * from './marketplace';")).toBe(true);
    expect(
      declaresPaymentGateway(`export interface PaymentGateway {
  id: string;
}`),
    ).toBe(true);
    expect(hasPaymentRegistry('  registerPayment(p: PaymentGateway) {}')).toBe(true);
    expect(hasPaymentRegistry('  private payments = new Map<string, X>();')).toBe(true);
    expect(hasGatewayFactory('export function createMercadoPagoGateway(c) {}')).toBe(true);
    expect(advertisesPaymentKind("  kinds: ReadonlyArray<'tax' | 'payment'>;")).toBe(true);
    expect(
      reExportsMarketplaceChannelSymbol(
        "export type { MarketplaceChannel } from '@delfrance/core/marketplace';",
      ),
    ).toBe(true);
    // A specifier list broken across lines - the shape prettier produces for a
    // long re-export, and the one a line-anchored regex could easily miss.
    expect(
      reExportsMarketplaceChannelSymbol(`export type {
  MarketplaceChannel,
} from './x';`),
    ).toBe(true);
  });

  it('does NOT flag a known-GOOD source', () => {
    // Prose and doc comments naming the removed contract are expected — every
    // file that dropped it explains why. Only a declaration counts.
    const prose = ' * ⚠️ `MarketplaceChannel` is NOT here, and must not come back (#815).';
    expect(declaresMarketplaceChannel(prose)).toBe(false);
    expect(hasMarketplaceRegistry(prose)).toBe(false);
    expect(
      advertisesMarketplaceKind("  kinds: ReadonlyArray<'tax' | 'invoice' | 'payment'>;"),
    ).toBe(false);
    expect(reExportsMarketplace("export * from './money';")).toBe(false);
    const paymentProse = ' * ⚠️ `PaymentGateway` was deleted in #1429 and must not come back.';
    expect(declaresPaymentGateway(paymentProse)).toBe(false);
    expect(hasPaymentRegistry(paymentProse)).toBe(false);
    expect(hasGatewayFactory(paymentProse)).toBe(false);
    // The surviving contracts must NOT trip the payment detector.
    expect(declaresPaymentGateway('export interface InvoiceProvider { id: string }')).toBe(false);
    expect(advertisesPaymentKind("  kinds: ReadonlyArray<'tax' | 'invoice'>;")).toBe(false);
    expect(reExportsMarketplaceChannelSymbol(prose)).toBe(false);
    expect(
      reExportsMarketplaceChannelSymbol(
        "export type { TaxProvider, InvoiceProvider } from '@delfrance/core/plugins';",
      ),
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('MarketplaceChannel stays deleted (#815)', () => {
  it('packages/core/src/plugins declares no MarketplaceChannel', () => {
    expect(declaresMarketplaceChannel(read(CORE_PLUGINS))).toBe(false);
  });

  it('PluginRegistry has no marketplace kind', () => {
    expect(hasMarketplaceRegistry(read(CORE_PLUGINS))).toBe(false);
  });

  it('the plugin SDK advertises no marketplace plugin kind', () => {
    const src = read(SDK_INDEX);
    expect(advertisesMarketplaceKind(src)).toBe(false);
    expect(declaresMarketplaceChannel(src)).toBe(false);
    // ⚠️ The SDK can bring the name back WITHOUT declaring it: a one-line
    // `export type { MarketplaceChannel } from '@delfrance/core/marketplace';`
    // re-advertises the contract to every third-party plugin author.
    expect(reExportsMarketplaceChannelSymbol(src)).toBe(false);
  });

  it('the marketplace MODEL module declares no MarketplaceChannel either', () => {
    // The file whose own header forbids exactly this. See MARKETPLACE_MODEL above.
    const src = read(MARKETPLACE_MODEL);
    expect(declaresMarketplaceChannel(src)).toBe(false);
    expect(reExportsMarketplaceChannelSymbol(src)).toBe(false);
    expect(hasMarketplaceRegistry(src)).toBe(false);
  });

  it('is reading the model module it thinks it is', () => {
    // Vacuity guard: `read` throws on a missing path, but a moved-and-emptied
    // file would make the three assertions above pass for the wrong reason.
    expect(read(MARKETPLACE_MODEL)).toMatch(/export interface ChannelContext/);
  });

  it('the core ROOT barrel does not re-export the ./marketplace subpath', () => {
    expect(reExportsMarketplace(read(CORE_BARREL))).toBe(false);
  });

  it('is reading the barrel it thinks it is', () => {
    // Guards the assertion above from passing because the file moved or emptied.
    expect(read(CORE_BARREL)).toMatch(/export \* from '\.\/plugins';/);
  });

  it('the five throw-only channel scaffolds stay deleted', () => {
    // They existed only to typecheck against the removed contract, and had no
    // importer anywhere. Recreating one is how the contract comes back.
    //
    // ⚠️ Keyed on the MANIFEST, not the directory. A deleted workspace package can
    // leave an empty `node_modules/` behind in an existing checkout, which would
    // make a directory check red locally and green on a fresh CI clone — the
    // worst kind of guard. `package.json` is what makes it a package.
    for (const pkg of ['shopee', 'magalu', 'amazon-sp-api', 'facebook', 'loja-integrada']) {
      expect(
        existsSync(resolve(repoRoot, `packages/integrations/${pkg}/package.json`)),
        `packages/integrations/${pkg} was recreated — see ADR 0015`,
      ).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('PaymentGateway stays deleted (#1429)', () => {
  it('packages/core/src/plugins declares no PaymentGateway', () => {
    expect(declaresPaymentGateway(read(CORE_PLUGINS))).toBe(false);
  });

  it('PluginRegistry has no payment kind', () => {
    expect(hasPaymentRegistry(read(CORE_PLUGINS))).toBe(false);
  });

  it('the plugin SDK neither declares, re-exports nor advertises it', () => {
    const src = read(SDK_INDEX);
    expect(declaresPaymentGateway(src)).toBe(false);
    expect(advertisesPaymentKind(src)).toBe(false);
    // A re-export brings the name back without declaring it — the hole review
    // caught for MarketplaceChannel in #1423.
    expect(/^\s*(?:export|import)\s+(?:type\s+)?\{[^}]*\bPaymentGateway\b/m.test(src)).toBe(false);
  });

  it('the Mercado Pago package exposes no gateway factory', () => {
    const src = read(MP_PACKAGE);
    expect(hasGatewayFactory(src)).toBe(false);
    expect(declaresPaymentGateway(src)).toBe(false);
  });

  it('is reading the Mercado Pago package it thinks it is', () => {
    // Vacuity guard: the real exports must still be there, or the assertions
    // above would pass against an emptied file.
    expect(read(MP_PACKAGE)).toMatch(/export \* from '\.\/mapping\/payment';/);
  });

  it("apps/web's empty payment registry stays deleted", () => {
    expect(
      existsSync(resolve(repoRoot, 'apps/web/lib/plugins/paymentRegistry.ts')),
      'the empty PluginRegistry came back — see #1429',
    ).toBe(false);
  });

  it('the tipo enum documents the real procedure, not the deleted plugin path', () => {
    // ⚠️ The load-bearing half of #1429. Deleting the contract is worth little if
    // the schema keeps telling the next author to implement one.
    //
    // Asserted POSITIVELY on purpose. A negative on the old sentence looked
    // stronger and was worse: the replacement docstring QUOTES that sentence to
    // explain what changed, and no regex separates a prescription from a
    // quotation of one. A wholesale revert drops all three markers below, which
    // is the case actually worth catching.
    const src = read(PAGAMENTO_SCHEMA);
    expect(src).toMatch(/#1429/);
    expect(src).toMatch(/apps\/<provider>/);
    expect(src).toMatch(/PAGAMENTO_TIPO_CAPS/);
  });
});

/* -------------------------------------------------------------------------- */

describe('MARKETPLACE_TIPO_CAPS stays wired to reality', () => {
  const capsSrc = read(CAPS);

  /** Rows whose `channel` is named and whose `implementado` is true. */
  const implementedChannels = [
    ...capsSrc.matchAll(/channel:\s*'([^']+)',\s*\n\s*implementado:\s*true/g),
  ].map((m) => m[1]);

  it('finds at least one implemented row (guards the assertions below)', () => {
    expect(implementedChannels).toContain('mercado-livre');
  });

  it('every implemented channel has a real apps/<channel> backend', () => {
    // ⚠️ This is the assertion that cannot live in packages/schemas: a test there
    // asserting about `apps/` runs only when schemas is in scope. Here it rides
    // config-eslint, which every lane's graph reaches.
    for (const channel of implementedChannels) {
      expect(
        existsSync(resolve(repoRoot, `apps/${channel}`)),
        `MARKETPLACE_TIPO_CAPS marks '${channel}' implementado, but apps/${channel} does not exist`,
      ).toBe(true);
    }
  });
});
