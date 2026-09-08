import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Repo invariant: the plugin system was removed, and no part of it may come back.
 *
 *  - **`MarketplaceChannel`** (#815, ADR 0015) — a marketplace is described by
 *    `MARKETPLACE_TIPO_CAPS` and implemented as one App Hosting backend.
 *  - **`PaymentGateway`** (#1429) — all three members threw, `registerPayment`
 *    had one caller (its own test), and the one live consumer was a permanently
 *    disabled button. Payments live in `apps/mercado-pago`.
 *  - **`TaxProvider`, `InvoiceProvider`, `PluginRegistry` and
 *    `@delfrance/plugin-sdk`** (#1444) — the last two contracts and the registry
 *    itself. Neither contract could describe its own domain: `calculate({ amount,
 *    ncm })` carries no CRT, no CST/CSOSN, no origem and no UF pair, while the
 *    real engine (`buildImpostoXml`) emits XSD-valid XML per CST; and
 *    `issue(orderId)` → three statuses cannot express `aguardandoVinculo`, cStat
 *    136 reconciliation, SVC/EPEC contingência, filial, ambiente or série. The one
 *    implementation, `createNFeProvider()`, had zero callers — `apps/web` always
 *    reached `createNFeHttpClient` directly.
 *
 * ## Why this is a test and not a comment
 *
 * Every part of this is invisible when violated. Re-creating
 * `packages/core/src/plugins` with a `MarketplaceChannel` interface typechecks,
 * lints, builds and passes every suite — it just recreates a contract that took
 * one channel port to disprove and that five throw-only scaffold packages existed
 * to satisfy. The same is true of re-exporting `@delfrance/core/marketplace` from
 * core's root barrel (that puts the model in every browser bundle and, worse,
 * makes an unimplemented order model look like a shared surface), and of a second
 * `createNFeProvider()` — dead on arrival, but sitting on a live package's public
 * barrel where it reads as the supported path.
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

const CORE_BARREL = 'packages/core/src/index.ts';
const CORE_SRC = 'packages/core/src';
const NFE_BARREL = 'packages/integrations/nfe/src/index.ts';
const NFE_SRC = 'packages/integrations/nfe/src';
const CAPS = 'packages/schemas/src/shared/marketplace.ts';
const MP_PACKAGE = 'packages/integrations/mercado-pago/src/index.ts';
const PAGAMENTO_SCHEMA = 'packages/schemas/src/pedido/collection/pagamento.ts';

/**
 * ⚠️ These two are `existsSync` targets, NOT `read` targets. #1444 deleted both,
 * and `read` throws on a missing path — this suite used to read them on every
 * run. Each is keyed on the file that makes the thing EXIST: the barrel for a
 * directory, the manifest for a workspace package. Same reasoning as the scaffold
 * list below — a removed package can leave an empty `node_modules/` behind in an
 * existing checkout, which would make a bare directory check red locally and
 * green on a fresh CI clone. `package.json` is what makes it a package.
 */
const CORE_PLUGINS_ENTRY = 'packages/core/src/plugins/index.ts';
const SDK_MANIFEST = 'packages/plugin-sdk/package.json';

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

/**
 * Every `.ts` under a source root, as `[relativePath, contents]`.
 *
 * ⚠️ Scanning a whole directory replaces the per-file reads this suite did before
 * #1444 deleted the files they named, and is strictly stronger: a per-file
 * assertion only catches a re-creation at the ONE path it names, so
 * `src/plugins2/index.ts` — or an interface appended to `src/money/index.ts` —
 * passed. Cheap enough to prefer everywhere: the two roots below are 36 and 51
 * small files, no network, no build.
 */
const tsFilesUnder = (root) => {
  const dir = resolve(repoRoot, root);
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => [f, readFileSync(resolve(dir, f), 'utf8')]);
};

/** The module all five removed contracts lived in. */
const coreSrcFiles = () => tsFilesUnder(CORE_SRC);

/**
 * The NF-e package — the only place that ever implemented one of the contracts.
 *
 * ⚠️ The barrel alone is not enough, and that is a review finding, not a
 * precaution: `createNFeProvider` would most naturally come back **in
 * `http-provider/client.ts`**, beside the `createNFeHttpClient` it wrapped, with
 * only its NAME added to the barrel's existing re-export block. Guarding the
 * barrel catches the second half; scanning the tree catches both.
 */
const nfeSrcFiles = () => tsFilesUnder(NFE_SRC);

/* -------------------------------------------------------------------------- */
/*                      The detectors, and their two controls                 */
/* -------------------------------------------------------------------------- */

/** A `MarketplaceChannel` DECLARATION (not a mention in prose or a comment). */
const declaresMarketplaceChannel = (src) =>
  /^\s*export\s+(?:interface|type|class)\s+MarketplaceChannel\b/m.test(src);

/** A registry member for marketplaces. */
const hasMarketplaceRegistry = (src) =>
  /\bregisterMarketplace\s*\(/.test(src) || /\bmarketplaces\s*=\s*new Map\b/.test(src);

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

/** A `TaxProvider` or `InvoiceProvider` DECLARATION (#1444). */
const declaresPluginContract = (src) =>
  /^\s*export\s+(?:interface|type|class)\s+(?:TaxProvider|InvoiceProvider)\b/m.test(src);

/** The registry class itself, or either of its two remaining register members. */
const hasPluginRegistry = (src) =>
  /^\s*export\s+class\s+PluginRegistry\b/m.test(src) ||
  /\bregisterTax\s*\(/.test(src) ||
  /\bregisterInvoice\s*\(/.test(src);

/**
 * A `TaxProvider` / `InvoiceProvider` NAME crossing a module boundary — either
 * direction, since `import type { InvoiceProvider } from '@delfrance/core/plugins'`
 * is exactly the line the NF-e barrel carried before #1444.
 *
 * ⚠️ Separate from {@link declaresPluginContract}, which matches a DECLARATION
 * only and so lets a re-export through. Same split as
 * {@link declaresMarketplaceChannel} / {@link reExportsMarketplaceChannelSymbol}.
 */
const reExportsPluginContractSymbol = (src) =>
  /^\s*(?:export|import)\s+(?:type\s+)?\{[^}]*\b(?:TaxProvider|InvoiceProvider)\b/m.test(src);

/**
 * The dead NF-e adapter (#1444), in any shape that EXPOSES the name.
 *
 * ⚠️ Needs its own detector: every other declaration regex here alternates over
 * `interface|type|class`, and `createNFeProvider` was a `function`. Folding it
 * into that alternation would have been the smaller diff and would have silently
 * matched nothing.
 *
 * ⚠️ And it must match the name CROSSING A MODULE BOUNDARY, not only a
 * declaration. Review caught this on the first version of the guard, which tested
 * `export function` alone: `packages/integrations/nfe/src/index.ts` is composed
 * ENTIRELY of `export { … } from './x'` blocks — `createNFeProvider` was the only
 * bare declaration it ever held, and this change deleted it. So a
 * declaration-only regex guarded the one shape that file never uses. Verified by
 * mutation: appending `export { createNFeProvider } from './http-provider';` to
 * the barrel left this suite at 23/23 green. The most natural re-creation — put
 * the adapter back in `http-provider/client.ts` beside its counterpart and add
 * the name to the existing re-export block — walked straight past it, and so did
 * `export const`.
 */
const exposesNFeProviderFactory = (src) =>
  /^\s*export\s+(?:async\s+)?(?:function|const|let|var)\s+createNFeProvider\b/m.test(src) ||
  /^\s*(?:export|import)\s+(?:type\s+)?\{[^}]*\bcreateNFeProvider\b/m.test(src);

/** A re-export of the `./plugins` subpath from a barrel. */
const reExportsPlugins = (src) => /(?:export|import)[^;\n]*from\s+'\.\/plugins'/.test(src);

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
    expect(reExportsMarketplace("export * from './marketplace';")).toBe(true);
    expect(
      declaresPaymentGateway(`export interface PaymentGateway {
  id: string;
}`),
    ).toBe(true);
    expect(hasPaymentRegistry('  registerPayment(p: PaymentGateway) {}')).toBe(true);
    expect(hasPaymentRegistry('  private payments = new Map<string, X>();')).toBe(true);
    expect(hasGatewayFactory('export function createMercadoPagoGateway(c) {}')).toBe(true);
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
    // #1444
    expect(declaresPluginContract('export interface TaxProvider { id: string }')).toBe(true);
    expect(declaresPluginContract('export interface InvoiceProvider { id: string }')).toBe(true);
    expect(hasPluginRegistry('export class PluginRegistry {}')).toBe(true);
    expect(hasPluginRegistry('  registerTax(p: TaxProvider) {}')).toBe(true);
    expect(hasPluginRegistry('  registerInvoice(p: InvoiceProvider) {}')).toBe(true);
    expect(
      exposesNFeProviderFactory(
        'export function createNFeProvider(config: NFeHttpClientConfig): InvoiceProvider {',
      ),
    ).toBe(true);
    // ⚠️ The three shapes the declaration-only first version let through. The
    // re-export one is not hypothetical — it was reproduced against the real
    // barrel and the suite stayed green.
    expect(exposesNFeProviderFactory('export const createNFeProvider = (c) => ({ id: 1 });')).toBe(
      true,
    );
    expect(exposesNFeProviderFactory("export { createNFeProvider } from './http-provider';")).toBe(
      true,
    );
    expect(
      exposesNFeProviderFactory(`export {
  createNFeHttpClient,
  createNFeProvider,
} from './http-provider';`),
    ).toBe(true);
    expect(
      reExportsPluginContractSymbol(
        "export type { TaxProvider, InvoiceProvider } from '@delfrance/core/plugins';",
      ),
    ).toBe(true);
    expect(
      reExportsPluginContractSymbol(
        "import type { InvoiceProvider } from '@delfrance/core/plugins';",
      ),
    ).toBe(true);
    expect(reExportsPlugins("export * from './plugins';")).toBe(true);
  });

  it('does NOT flag a known-GOOD source', () => {
    // Prose and doc comments naming the removed contract are expected — every
    // file that dropped it explains why. Only a declaration counts.
    const prose = ' * ⚠️ `MarketplaceChannel` is NOT here, and must not come back (#815).';
    expect(declaresMarketplaceChannel(prose)).toBe(false);
    expect(hasMarketplaceRegistry(prose)).toBe(false);
    expect(reExportsMarketplace("export * from './money';")).toBe(false);
    const paymentProse = ' * ⚠️ `PaymentGateway` was deleted in #1429 and must not come back.';
    expect(declaresPaymentGateway(paymentProse)).toBe(false);
    expect(hasPaymentRegistry(paymentProse)).toBe(false);
    expect(hasGatewayFactory(paymentProse)).toBe(false);
    expect(reExportsMarketplaceChannelSymbol(prose)).toBe(false);
    // #1444 — the same prose tolerance, on the contracts this file now also guards.
    const pluginProse =
      ' * ⚠️ `TaxProvider` / `InvoiceProvider` were deleted in #1444, with `PluginRegistry`.';
    expect(declaresPluginContract(pluginProse)).toBe(false);
    expect(hasPluginRegistry(pluginProse)).toBe(false);
    expect(exposesNFeProviderFactory(' * the throwing `createNFeProvider()` stub')).toBe(false);
    // ⚠️ The widened detector must not swallow the SURVIVING factory next to it in
    // every one of the barrel's re-export blocks. `createNFeHttpClient` is the
    // live NF-e path; flagging it would red CI on correct code.
    expect(
      exposesNFeProviderFactory("export { createNFeHttpClient } from './http-provider';"),
    ).toBe(false);
    expect(reExportsPluginContractSymbol(pluginProse)).toBe(false);
    expect(
      reExportsPluginContractSymbol("export { createNFeHttpClient } from './http-provider';"),
    ).toBe(false);
    expect(reExportsPlugins("export * from './money';")).toBe(false);
    // The removed contracts must not trip EACH OTHER's detectors — these three
    // ran against the same file, so a regex that over-matched would have been
    // read as the wrong invariant failing.
    expect(declaresPaymentGateway('export interface InvoiceProvider { id: string }')).toBe(false);
    expect(declaresPluginContract('export interface PaymentGateway { id: string }')).toBe(false);
    expect(declaresMarketplaceChannel('export interface TaxProvider { id: string }')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('MarketplaceChannel stays deleted (#815)', () => {
  it('nothing under packages/core/src declares one, or registers one', () => {
    for (const [file, src] of coreSrcFiles()) {
      expect(declaresMarketplaceChannel(src), `${file} declares MarketplaceChannel`).toBe(false);
      expect(reExportsMarketplaceChannelSymbol(src), `${file} re-exports MarketplaceChannel`).toBe(
        false,
      );
      expect(hasMarketplaceRegistry(src), `${file} registers a marketplace plugin`).toBe(false);
    }
  });

  it('is reading the model module it thinks it is', () => {
    // Vacuity guard: `read` throws on a missing path, but a moved-and-emptied
    // file would make the assertions above pass for the wrong reason.
    expect(read(MARKETPLACE_MODEL)).toMatch(/export interface ChannelContext/);
  });

  it('the core ROOT barrel does not re-export the ./marketplace subpath', () => {
    expect(reExportsMarketplace(read(CORE_BARREL))).toBe(false);
  });

  it('is reading the barrel it thinks it is', () => {
    // Guards the assertion above from passing because the file moved or emptied.
    //
    // ⚠️ This anchor used to be `export * from './plugins';` — which #1444 then
    // deleted, reddening a test that is not about plugins. Anchored on `./money`
    // now: the oldest, most-imported subpath in the package.
    expect(read(CORE_BARREL)).toMatch(/export \* from '\.\/money';/);
  });

  it('the four remaining throw-only channel scaffolds stay deleted', () => {
    // They existed only to typecheck against the removed contract, and had no
    // importer anywhere. Recreating one is how the contract comes back.
    //
    // ⚠️ `shopee` LEFT this list, and only this list. It is a real package again —
    // fetch-only signing/hosts/wire schemas/typed errors for the Shopee Open
    // Platform, paired with `apps/shopee` — which is the ADR-0015 shape, the
    // opposite of the throw-only scaffold that was deleted. Shrinking the list
    // alone would have reopened the hole this guard exists for, so the shape it
    // graduated INTO is asserted by the sibling test below.
    //
    // ⚠️ Keyed on the MANIFEST, not the directory. A deleted workspace package can
    // leave an empty `node_modules/` behind in an existing checkout, which would
    // make a directory check red locally and green on a fresh CI clone — the
    // worst kind of guard. `package.json` is what makes it a package.
    for (const pkg of ['magalu', 'amazon-sp-api', 'facebook', 'loja-integrada']) {
      expect(
        existsSync(resolve(repoRoot, `packages/integrations/${pkg}/package.json`)),
        `packages/integrations/${pkg} was recreated — see ADR 0015`,
      ).toBe(false);
    }
  });

  it('the re-created shopee package is a library, not a channel plugin', () => {
    // The replacement for shopee's row in the list above. A package that exists
    // again may only exist in the ADR-0015 shape: it describes the PROVIDER's
    // wire protocol and nothing about this ERP's orchestration.
    //
    // ⚠️ Guarded by `existsSync` rather than asserted unconditionally so this
    // file keeps working if the package is ever removed again — but the vacuity
    // check below means an EMPTIED `src/` cannot pass it silently.
    const manifest = resolve(repoRoot, 'packages/integrations/shopee/package.json');
    if (!existsSync(manifest)) return;

    const srcDir = resolve(repoRoot, 'packages/integrations/shopee/src');
    const files = readdirSync(srcDir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.ts'));

    for (const file of files) {
      const src = readFileSync(resolve(srcDir, file), 'utf8');
      expect(declaresMarketplaceChannel(src), `${file} declares MarketplaceChannel`).toBe(false);
      expect(reExportsMarketplaceChannelSymbol(src), `${file} re-exports MarketplaceChannel`).toBe(
        false,
      );
      expect(hasMarketplaceRegistry(src), `${file} registers a marketplace plugin`).toBe(false);
    }

    // Vacuity guard: an empty (or wrongly-rooted) `src/` would make the loop above
    // pass without reading a line — the exact failure mode this file's other
    // anchors exist to close.
    expect(files.length, 'no shopee src files were read').toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */

describe('PaymentGateway stays deleted (#1429)', () => {
  it('nothing under packages/core/src declares one, or registers one', () => {
    for (const [file, src] of coreSrcFiles()) {
      expect(declaresPaymentGateway(src), `${file} declares PaymentGateway`).toBe(false);
      expect(hasPaymentRegistry(src), `${file} registers a payment gateway`).toBe(false);
    }
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

describe('the plugin system itself stays deleted (#1444)', () => {
  it('packages/core/src/plugins does not exist', () => {
    expect(
      existsSync(resolve(repoRoot, CORE_PLUGINS_ENTRY)),
      'the plugin contracts came back — see #1444',
    ).toBe(false);
  });

  it('the @delfrance/plugin-sdk package does not exist', () => {
    // Keyed on the manifest, for the `node_modules/` reason spelled out above.
    expect(
      existsSync(resolve(repoRoot, SDK_MANIFEST)),
      'the plugin SDK came back — see #1444',
    ).toBe(false);
  });

  it('nothing under packages/core/src declares a contract or a registry', () => {
    // ⚠️ The two `existsSync` checks above only cover the paths those files USED
    // to sit at. This is what stops the same three declarations reappearing one
    // directory over, which is the cheaper mistake to make.
    for (const [file, src] of coreSrcFiles()) {
      expect(declaresPluginContract(src), `${file} declares TaxProvider/InvoiceProvider`).toBe(
        false,
      );
      expect(
        reExportsPluginContractSymbol(src),
        `${file} imports or re-exports TaxProvider/InvoiceProvider`,
      ).toBe(false);
      expect(hasPluginRegistry(src), `${file} declares or feeds a PluginRegistry`).toBe(false);
    }
  });

  it('the core ROOT barrel does not re-export a ./plugins subpath', () => {
    // It did, for the whole life of the contracts — which put `PluginRegistry`
    // and `PluginNotRegisteredError`, both runtime CLASSES, into every browser
    // bundle that imports bare `@delfrance/core`. `apps/web` is one.
    expect(reExportsPlugins(read(CORE_BARREL))).toBe(false);
  });

  it('the core package.json advertises no ./plugins subpath', () => {
    expect(read('packages/core/package.json')).not.toMatch(/"\.\/plugins"/);
  });

  it('nothing under the NF-e package re-creates the dead InvoiceProvider adapter', () => {
    // `createNFeProvider` was the ONLY implementation either contract ever had,
    // and it had zero callers. Worse than a dead stub: it compiled, it ran, and
    // it sat on a live package's public `.` entry looking supported, while every
    // real caller goes through `createNFeHttpClient` on the `./http-provider`
    // subpath (which `apps/web`'s no-restricted-imports rule pins it to).
    //
    // ⚠️ Scans the tree, not just the barrel. Review's finding: the adapter comes
    // back most naturally IN `http-provider/client.ts`, with only its name added
    // to the barrel's re-export block — two halves, and the barrel-only check saw
    // neither, because it tested for a declaration shape that file never uses.
    for (const [file, src] of nfeSrcFiles()) {
      expect(exposesNFeProviderFactory(src), `${file} exposes createNFeProvider`).toBe(false);
      expect(declaresPluginContract(src), `${file} declares TaxProvider/InvoiceProvider`).toBe(
        false,
      );
      expect(
        reExportsPluginContractSymbol(src),
        `${file} imports or re-exports TaxProvider/InvoiceProvider`,
      ).toBe(false);
    }
  });

  it('reads a non-empty NF-e src (guards the scan above)', () => {
    expect(nfeSrcFiles().length, 'no NF-e src files were read').toBeGreaterThan(0);
  });

  it('is reading the NF-e barrel it thinks it is', () => {
    // Vacuity guard: an emptied or moved barrel would pass the assertion above
    // without reading a line of the real surface.
    expect(read(NFE_BARREL)).toMatch(/createNFeHttpClient/);
  });

  it('reads a non-empty packages/core/src (guards every scan above)', () => {
    // The three `coreSrcFiles()` loops in this file iterate — a wrongly-rooted or
    // empty directory makes all of them pass without reading anything.
    expect(coreSrcFiles().length, 'no packages/core/src files were read').toBeGreaterThan(0);
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
