---
"@delfrance/nfe-app": patch
"@delfrance/schemas": minor
---

A duplicate EPEC of our own stored bytes means "already registered" — never `rejeitada` (#1675).

When an EPEC send's reply was lost, the resend of the SAME signed bytes is answered by the Ambiente Nacional with 573 (duplicidade de evento, NT 2014.001 rule 3P15-10) or 485 (duplicidade de numeração do EPEC, rule 3P12-10). That was written `rejeitada`, so the next emit regenerated over the bytes the registered EPEC summarises and the pós-EPEC transmission answered 467 — an orphaned EPEC.

- **apps/nfe** (`disposicaoDoEpec`): stored bytes + 485/573 → estado `'p'` WITHOUT `xml_epec_proc` (SEFAZ's cStat kept, the reason appended), so the pós-EPEC transmission authorizes it once the outage ends; fresh bytes + 485/573 → `error` naming the manual conciliation (the EPEC on record describes other data); every other rejection → `rejeitada` as before. A superseded run's registered 135/136 reply fills in that protocol, fill-only. The manual verify and `consultarPedido` no longer consult a `'p'` doc (the home SEFAZ answers 217 until the AN shares the EPEC, and that 217 would free a número the EPEC holds).
- **@delfrance/schemas**: `nfeImprimivel(nota)` — `aprovada`, or `'p'` WITH `xml_epec_proc`: the one rule apps/web and the DANFE route share for "a DANFE can be printed now". apps/web's checkout, the pedidos list's DANFE menu and the per-NF-e page use it, and a `'p'` 485/573 result shows a yellow "EPEC já registrado — protocolo não recuperado" notice.
