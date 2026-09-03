# `lib/marketplace/caps` — what a channel supports, and why not

One question, asked in one place: **can this channel do this row action, and if
not, which of the reasons applies?** `MARKETPLACE_TIPO_CAPS`
(`packages/schemas/src/shared/marketplace.ts`, ADR 0015) is the answer; this
folder is how `apps/web` reads it.

| File                           | What it is                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `suporteCanal.ts`              | `motivoDaCapacidade` (the precedence), `vereditoCanal`, `capsPermitem`, and the message catalogue |
| `AvisoCanaisNaoSuportados.tsx` | the pre-run warning on the confirm step of the three push dialogs                                 |
| `registriesAlinhadas.test.ts`  | the drift test — the table and the three registries must agree for every tipo                     |

## The precedence

`motivoDaCapacidade(suporte, implementado)` is the whole rule, and it is a pure
function of two facts so it can be exercised exhaustively:

| Order | Condition                    | Reason                                                            |
| ----- | ---------------------------- | ----------------------------------------------------------------- |
| 1     | `suporte === 'nao'`          | `canal-nao-suportado` — permanent; a backend will not change it   |
| 2     | `suporte === 'desconhecido'` | `canal-nao-pesquisado` — nobody has read the docs                 |
| 3     | `!implementado`              | `canal-nao-implementado` — the provider can, we have not built it |
| —     | otherwise                    | supported, as far as the table is concerned                       |

`vereditoCanal` adds the fourth: caps clear it but no provider claims the tipo →
`canal-sem-provider`, a wiring gap rather than a capability one.

⚠️ Arms 1 and 3 are **unreachable through the live table today** — the one
implemented channel answers `'sim'` to all three actions and every unbuilt one
answers `'desconhecido'`. That is exactly why the rule is extracted: a branch
you cannot reach from the data is a branch nobody has checked, and Phase 0 on a
second channel makes both reachable at once.

## What replaced what

Before #1430 each registry answered with `PROVIDERS[tipo] !== undefined` — "a
provider file exists" standing in for "the channel supports it". That is the
substitution the `/canais` badge had already removed once (#815): _"has a
package" is not "works"_. It also collapsed four situations into one hardcoded
sentence, and that sentence told the operator to _"use o aplicativo antigo"_ —
wrong for three of the four, and expiring at the cutover, since there is no dual
run (root `CLAUDE.md` rule 8).

## Rules for changing this

- ⚠️ **No cycles.** `suporteCanal.ts` takes the provider map as an argument
  because every registry imports it. Never import a registry from here.
- ⚠️ **One catalogue.** The pre-run warning and the result row both call
  `mensagemNaoSuportado`, so they cannot drift into disagreeing about the same
  channel. Every sentence names the conta AND the channel — "não suportado"
  alone is not actionable, which `registry.test.ts` pins.
- ⚠️ **Warn, never block.** A selection legitimately spans supported and
  unsupported channels, and the run still emits one row per skipped listing.
  Refusing the run would throw away the report the operator came for.
- ⚠️ **`AvisoCanaisNaoSuportados` branches on `IntegracoesStatus`.** An empty
  `byId` means loading, `permission-denied`, or genuinely empty, and warning off
  a failed read would report a permissions problem as a capability one.
