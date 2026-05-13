# `@delfrance/integrations-nfe`

NFe (Nota Fiscal Eletrônica) plugin. Implements `InvoiceProvider` from `@delfrance/core/plugins`.

## Status

**Scaffold only.** Concrete implementation depends on Phase 0 spike outcomes:

- ADR 0004 — XSD → TypeScript types (which generator)
- ADR 0005 — XML signing (xml-crypto vs xmldsigjs)
- ADR 0006 — SOAP transport (`soap` vs `strong-soap`)
- ADR 0007 — Brazilian NFe package survey (does an existing npm package cover 80%+?)
- ADR 0008 — DANFE PDF rendering

Until the spikes resolve, `createNFeProvider()` returns a stub that throws `NFeNotConfiguredError` on every issue call. Apps register the stub in their `PluginRegistry` knowing this; the UI in `apps/web/(app)/nfe/` shows a banner pointing at this README.

## Wiring (preview)

```ts
import { createNFeProvider } from '@delfrance/integrations-nfe';
import { PluginRegistry } from '@delfrance/core/plugins';

const registry = new PluginRegistry();
registry.registerInvoice(
  createNFeProvider({
    ambiente: 'homologacao',
    uf: 'SP',
    certPath: '/run/secrets/nfe-cert.pfx',
    certPasswordEnvVar: 'NFE_CERT_PASSWORD',
  }),
);
```

## Server-only

This package will gain a `./server` subpath export that holds cert
parsing + SOAP transport. The default entry point stays
client-bundle-safe (types + the registry-shaped factory only).
