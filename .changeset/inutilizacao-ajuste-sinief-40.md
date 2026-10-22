---
"@delfrance/schemas": minor
"@delfrance/nfe-app": patch
"@delfrance/integrations-nfe": patch
---

No Pedido de Inutilização for AC, BA or SP filiais from 01/11/2026 (Ajuste SINIEF nº 40/2026, #2030).

The Ajuste adds § 6º to cláusula décima quarta of Ajuste SINIEF 7/05: the Pedido de Inutilização de Número da NF-e "não se aplica aos Estados do Acre, Bahia e São Paulo". It takes effect on 01/11/2026. SEFAZ-SP homologação already answers every pedido with cStat 998 "Serviço Desativado".

- **`@delfrance/schemas`** adds two pure functions. `inutilizacaoSeAplica(uf, instanteMs)` is `false` for AC/BA/SP from 00:00 of 01/11/2026 in that UF's legal time (−05:00 for AC, −03:00 for BA/SP), and `true` otherwise. `motivoInutilizacaoNaoSeAplica(uf)` gives the pt-BR explanation that both surfaces show.
- **`apps/nfe`**: `inutilizarNumeracao` now refuses such a filial right after reading it, with `NFeInutilizacaoNaoSeAplicaError`. Nothing else happens first: no cert decrypt, no nfev4 range scan, no SOAP call, no inutilização record. `POST /api/nfe/inutilizar` answers 422 with `code: 'INUTILIZACAO_NAO_SE_APLICA'`.
- **`@delfrance/integrations-nfe/http-provider`** maps that code to the new `NFeInutilizacaoNaoSeAplicaError`. It does this before the generic 422 branch, so the refusal is never read as a SEFAZ rejection with an unknown cStat. The error is not retryable.
- **`apps/web`'s inutilização screen** explains the Ajuste and disables the form for such a filial. The filial's inutilização history stays visible. (`@delfrance/web` is not versioned by changesets.)

No code path inutilizes automatically, so nothing else changes. In those UFs a número that was never authorized simply stays unused: the Ajuste sets no replacement procedure.
