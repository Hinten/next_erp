---
"@delfrance/integrations-nfe": patch
---

`isStuckEnviando` reads the stored `ultima_modificacao` through `coerceToMillis` (a ms or µs number, an ISO string or a `Date`) instead of `Date.parse`, so the backstop sweep's 5-minute stuck timeout applies again (#1653).

`nfeSchema` stores that field as a ms number, and so does the legacy Flutter corpus. The sweep hands the raw value to `isStuckEnviando`, where `Date.parse` turned the number into NaN and NaN counted as stuck. So every in-flight doc without a `proximaConsultaEm` of its own (the persist-before-send anchor, the chave-less batch placeholder, #512's `enviando` dispositions) was consulted on the next sweep tick, even while its send was still in flight. Such a doc now waits `DEFAULT_STUCK_TIMEOUT_MS` from its last write, and the manual route's `timeoutMs` still overrides it. `MaybeStuckNFe.ultima_modificacao` is now `unknown`, the raw stored value. A missing or unreadable stamp still counts as stuck, now through an explicit branch rather than NaN.
