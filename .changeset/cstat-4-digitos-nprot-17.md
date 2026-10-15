---
"@delfrance/integrations-nfe": minor
"@delfrance/nfe-app": patch
---

Pin the NT 2025.002 §5.1 widths — `cStat` of 3 or 4 digits, `nProt` of 15 or 17 — and share one `TStat` predicate (#329).

The vendored XSDs already accepted both widths; nothing pinned it. `isCStat` (new export) is the `[0-9]{3,4}` shape the XSD gate enforces, for values that did not come through that gate; `apps/nfe`'s lote-sem-recibo path now uses it instead of a local regex. `classifyCStat` compares exact strings throughout: the certificate range 290–298 was matched numerically, which folded a leading-zero 4-digit value such as `'0290'` onto it — now an exact set. New tests pin the widths on every response root (and the outgoing cancelamento `detEvento`), prove `isCStat` agrees with the XSD facet, measure that a 17-digit protocol fits its box on every DANFE layout, the EPEC boxes and the CC-e PDF, and keep a tripwire on the one width SEFAZ did not widen (`retEvento/infEvento/@Id`). The dev NF-e seed's protocol was 16 digits — a width `TProt` forbids — and is now 15.
