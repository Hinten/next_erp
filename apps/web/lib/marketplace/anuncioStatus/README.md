# Marketplace listing status (pause / reactivate)

The produtos table's **"Pausar anúncios"** action, and the produto Mercado Livre
tab's per-listing **"Pausar anúncio" / "Reativar anúncio"** buttons, are a
registry of channel providers keyed by `IntegracaoTipo` — the third operation on
the shared `../push/` rail, beside stock (#819) and price (#804).

- `types.ts` — the `AnuncioStatusProvider` contract and the `AnuncioStatusRow`
  display shape (`statusFinal` + `membros` on top of `../push/types`'
  `PushRowBase`).
- `registry.ts` — `PROVIDERS`, `resolveAnuncioStatusProvider`, and the shared
  entry point `definirStatusParaIntegracao` (which runs the `ativo === false`
  gate).
- `pausarAnunciosRun.ts` — the thin binding onto `../push/run.ts`.
- `providers/*` — one file per channel. Only Mercado Livre today; the rest fall
  through to `unsupportedChannel`, which says so per produto.

## Why this exists

There was no way to stop a sale from inside the ERP. The produto tab offered
Publicar / Republicar / Reverificar and rendered `paused`/`closed` as read-only
labels, and none of the channel backends had a route that moved a listing's
status — so an operator had to leave the app and use the marketplace's own site.

⚠️ It is **not** a delist-on-delete cascade. #476 proposed calling each
marketplace when a produto is deleted here; that was **closed by decision**.
Deleting a produto in the ERP leaves the marketplace untouched, and the
`ProdutoReferencedError` block still refuses to delete a produto that holds a
live link. A listing's lifecycle moves only when a human asks for it, here.

## What is different from the two push operations

**The payload is a DIRECTION, not a value.** `acao: 'pausar' | 'reativar'`, so
there is no per-run option for the operator to tick — `opcaoInicial={null}`,
`renderOpcao={() => null}`.

**The row carries what the channel CONFIRMED.** `statusFinal` is ML's answer,
never the status that was requested: ML refuses to reactivate a zero-stock
listing and answers `paused` + `out_of_stock` on a **200**, so a row reading
"Pausado" over that would be a green lie. The whole backend chain keeps this
property — see `apps/mercado-livre/lib/marketplace/anuncios/anuncioStatus.ts`.

**The bulk action is pause-only.** Reactivating lives in the produto's Mercado
Livre tab, where the operator sees the listing they are putting back on air. The
route takes both directions, so a bulk reactivate is one `acao` away if wanted.

## ⚠️ An ordinary save undoes a pause

`buildItemPayload` / `buildUserProductItemPayload` send `status: 'active'` on
every update — legacy parity, kept deliberately — so "Salvar anúncios" or
"Republicar" reactivates a listing paused here, with no request that says so.

That is a product decision, not an oversight, which makes **saying so** part of
shipping the action. Three places carry the warning and none may be dropped
without replacing it: the pause confirm modal, the success toast, and the
persistent line `ListingStatusStrip` renders while `estado === 'pa'`.

## Eligibility is decided ONCE, in `packages/schemas`

`acaoStatusAnuncio` answers which action a stored link supports. The web tab
renders the button from it and the backend refuses by it — one function, so the
UI can never offer what the server declines. Its rungs are documented and tested
beside the schema: never published, cancelled, **mid-UPtin-migration**,
mid-decision, and the migrated corpus (which carries `estado` and lacks only
`status`).

⚠️ Two of those rungs read `estado` **above** the raw status, and that ordering
is load-bearing. `stampAguardandoMigracao` (`itemsStatusSync.ts`) writes
`estado: 'am'` and `ultimaModificacao` **alone** — its three call sites return
immediately — so a migrating listing keeps a stale `status: 'active'`. ML 404s
any change to a migrating source item, and this module's 404 branch records
`closed`, which drops the produto out of BOTH ML sweeps. Publish, the price
planner and the stock planner all carry the same `'am'` rung.

⚠️ The `estado` branch is an **allow-list** (`p` → pausar, `pa` → reativar,
everything else → null), not a fallthrough. As a deny-list it read `'am'`,
`'v'`, `'ep'`, `'a'`, `'E'` and `'r'` as live.

## Adding a channel

One row in `MARKETPLACE_TIPO_CAPS` answering `pausarAnuncio`, one provider file,
one backend route (`POST /api/marketplace/<canal>/anuncio-status` answering the
same envelope), one row in `buildProviderMap`. You never touch `../push/run.ts`,
the dialog, the produtos page or the other channels.

⚠️ `pausarAnuncio` is its OWN capability, not an inference off
`publicarAnuncio`: several marketplaces expose only a terminal close. Deriving
one from the other is the unverified claim #815 undid.

## The caps row is what decides, not the provider file (#1430)

`resolveAnuncioStatusProvider` asks `MARKETPLACE_TIPO_CAPS` first — via
`suporteAnuncioStatusDoCanal`, which is also what `pausarAnunciosRun.ts`'s
`suportado` and the dialog's pre-run warning read, so the three cannot disagree.
Only then does an exact tipo match serve the request. Everything else gets the
placeholder **carrying the reason**, and the reasons are four different
sentences:

| Caps row says                    | Reason                   | What the operator reads                                     |
| -------------------------------- | ------------------------ | ----------------------------------------------------------- |
| `pausarAnuncio: 'nao'`           | `canal-nao-suportado`    | the provider cannot — building a backend will not change it |
| `pausarAnuncio: 'desconhecido'`  | `canal-nao-pesquisado`   | nobody has read that provider's documentation yet           |
| `'sim'` + `implementado: false`  | `canal-nao-implementado` | the provider can, we have not built the channel             |
| caps say yes, no `PROVIDERS` row | `canal-sem-provider`     | a wiring gap in this screen                                 |

⚠️ This replaced `PROVIDERS[tipo] !== undefined` — "a provider file exists"
answering "does the channel support it". Same substitution the `/canais` badge
already removed (#815, ADR 0015), and it gave all four situations one sentence,
which pointed the operator at _"o site do canal"_ even for a channel that has
no pause endpoint at all.

⚠️ `caps/registriesAlinhadas.test.ts` asserts the table and this registry agree
for **every** tipo. If a channel legitimately lands in the middle — backend
shipped, this screen not wired yet — say so there with a named exception; do not
delete the assertion.
