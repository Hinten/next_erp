---
"@delfrance/schemas": patch
"@delfrance/data": patch
"@delfrance/ui": patch
"@delfrance/integrations-nfe": patch
---

Comunicações NF-e screen with pipeline filters, terminal-state guard, and manual SEFAZ re-verification route.

Adds TableView/ObjectView list and detail pages for the enviNfeMsg audit log at `/nfe/comunicacoes`, with filters by NFe chave, NFe number, pedido numero, and pedido id — all running server-side through Firestore pipeline queries. Introduces the "Verificar novamente" action to manually re-run the SEFAZ consultation with copyable result reporting. Fixes a state-machine bug: consultation flows now carry a terminal-state guard (aprovada, cancelada, numeracaoInutilizada are never re-consulted, and a cancelada NF-e can no longer regress to aprovada via the original authorization protNFe), restoring the legacy Flutter guards. Includes the new pipeline ops `array-contains` and `array-contains-any`, the TableView `extraFilters` prop, schema labels and `.describe()` on enviNfeMsg fields, and updated Firestore indexes for the hot queries.
