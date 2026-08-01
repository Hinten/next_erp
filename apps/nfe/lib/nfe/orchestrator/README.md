# Signed XML lifecycle

Every `nfev4` doc carries three XML fields — `xml_assinado`, `xml_nfe_proc`,
`xml_epec_proc` — and at most one of `xml_assinado` / `xml_nfe_proc` is ever
non-null at a time (apps/nfe/CLAUDE.md rule 1 / issue #128: the anti-loss
anchor is replaced, never dropped, by `swapAnchorForProc` in `audit.ts`).
This table is the map from `estado` to what each field holds — read it before
touching any code under `orchestrator/` that persists an nfev4 doc.

| estado                                          | `xml_assinado`                                                                                                  | `xml_nfe_proc`                                                 |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `enviando` / `aguardandoResposta` / `rejeitada` | signed `<NFe>`                                                                                                  | `null`                                                         |
| `'p'` (epecAprovado)                            | signed `<NFe>` (pós-EPEC resend reads it)                                                                       | `null` (`xml_epec_proc` holds the EPEC evento's procEventoNFe) |
| `aprovada`                                      | `null`                                                                                                          | `<nfeProc>` (embeds the signed NFe)                            |
| `cancelada` / `numeracaoInutilizada` / `error`  | whatever the doc carried when it reached that estado — cancelamento/inutilização/error never touch these fields | same                                                           |

The swap from row 1 to row 3 happens in exactly one place —
`buildProcForAuthorizedOutcome` (the digest-safe `<nfeProc>` guard, #396) plus
`swapAnchorForProc` (the atomic anchor-clear) in `audit.ts` — shared by every
site that can reach an `'autorizada'` outcome: `applyAutorizadoOutcome`
(`emitir.ts`), `reconcileByRecibo` (`reconcile.ts`), `consultarChavePersistida`
(`consultar.ts`) and the backstop sweep's consSit branch
(`../handlers/runProcessarPendentes.ts`). Each site differs only in how it
knows the protocol still belongs to the signed bytes it holds (a
`finalChave === chave` compare, a `!chaveSwapped` flag, or a `chNFe` field
match) — that single boolean is the only thing each call site supplies.
