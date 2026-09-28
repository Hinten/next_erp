---
"@delfrance/core": minor
"@delfrance/integrations-freight-br": minor
"@delfrance/integrations-nfe": minor
---

Bound the freight-br and NF-e browser HTTP clients with per-endpoint deadlines (#1094).

`@delfrance/core/wire` gains `abrirPrazo` — an `AbortController` + `setTimeout` deadline that aborts with a `TimeoutError` reason (never an `AbortError`, which callers read as an operator cancel), links an optional caller signal, and answers `esgotado()` so a rejection is classified by asking the deadline rather than by its realm-dependent class — and `ehTempoEsgotadoNoGateway`, which reads a 504 as the platform's only when its body is not our coded envelope.

`FreightHttpClient` and `NFeHttpClient` now give every method a `curto`/`longo` budget (`FREIGHT_PRAZO_MS` / `NFE_PRAZO_MS`, typed `satisfies Record<keyof Client, …>` so a new method cannot ship without one). No route observes a client abort, so `longo` (360 s) covers every method whose repeat could duplicate an effect — an emission, a CC-e, a label purchase — and never fires before the platform's own 504. The body read now sits inside the window and the error mapping. A timeout, or a gateway 504, is a new `FreightTimeoutError` / `NFeTimeoutError`: a subclass of the network error, so existing catch sites keep working, carrying `origem`, `timeoutMs`, `operacao` and pt-BR copy that says whether a repeat is safe. `isRetryableNFeHttpError` returns `false` for it.
