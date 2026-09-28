---
"@delfrance/core": minor
"@delfrance/integrations-freight-br": minor
"@delfrance/integrations-nfe": minor
---

Bound the freight-br and NF-e browser HTTP clients with per-endpoint deadlines (#1094).

`@delfrance/core/wire` gains `abrirPrazo` — an `AbortController` + `setTimeout` deadline that aborts with a `TimeoutError` reason (never an `AbortError`, which callers read as an operator cancel), links an optional caller signal, and answers `motivoDeTempoEsgotado()` so a rejection is classified by asking the deadline rather than by its realm-dependent class (`'prazo'` when it fired, `'gateway'` when the request had been in flight at least `LIMIAR_FALHA_TARDIA_MS`) — and `ehTempoEsgotadoNoGateway`, which reads a 504 as the platform's only when its body is not our coded envelope.

`FreightHttpClient` and `NFeHttpClient` now give every method a tier in the new `FREIGHT_NIVEL_POR_OPERACAO` / `NFE_NIVEL_POR_OPERACAO` exports (typed `satisfies Record<keyof Client, …>`, so a new method cannot ship without one), whose budget comes from `FREIGHT_PRAZO_MS` / `NFE_PRAZO_MS`. No route observes a client abort, so `longo` (360 s) covers every method whose repeat could duplicate an effect — an emission, a CC-e, a label purchase — and never fires before the platform's own 504. The body read now sits inside the window and the error mapping. A timeout, a readable gateway 504, or a network failure that arrives after the request has been in flight past `LIMIAR_FALHA_TARDIA_MS` (30 s — how a cross-origin browser sees the platform's 504, which carries no CORS headers) is a new `FreightTimeoutError` / `NFeTimeoutError`: a subclass of the network error, so existing catch sites keep working, carrying `origem`, `timeoutMs`, `operacao` and pt-BR copy that says whether a repeat is safe. `isRetryableNFeHttpError` returns `false` for it.
