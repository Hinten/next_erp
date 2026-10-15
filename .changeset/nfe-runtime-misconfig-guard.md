---
"@delfrance/nfe-app": patch
---

Every NF-e route answers 503 only for a misconfigured deploy — a bad `NFE_AMBIENTE`, an unreadable TLS chain, or an `NFE_UF` with no wired SEFAZ endpoints — through one shared `isNFeRuntimeMisconfig` guard. Any other failure while booting the runtime is a bug and now surfaces as a 500 instead of being masked as "runtime not ready"; `/api/health` does the same. `verificar` used to narrow on `NFeRuntimeConfigError` alone, so a bad `NFE_UF` escaped there as an opaque 500; it now answers 503 like the rest. The orchestrator's single-argument `console.debug` markers are allowed by the app's ESLint config, as its Rule A comment always claimed (#1704).
