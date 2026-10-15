---
"@delfrance/data": patch
"@delfrance/integrations-mercado-pago": patch
---

Date strings are parsed as ISO-8601 through `@delfrance/core/datetime` instead of `Date.parse` (#1704). `asMillis` (`admin/notifications/coerce`) gives the same instant for every offset shape providers send and reads an offset-less ISO string as UTC regardless of the process timezone; engine-lenient text that is not an ISO instant (RFC-2822 dates, impossible dates such as `2025-02-30`) now coerces to `null`, and a bare four-digit string falls through to the numeric-string branch instead of being read as a year. The Mercado Pago payment mapper keeps any sub-millisecond digits in the pagamento's microsecond fields instead of truncating to milliseconds; Mercado Pago's own millisecond timestamps map exactly as before.
