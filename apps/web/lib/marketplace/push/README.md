# Produto-scoped marketplace pushes

The produtos table's **"Enviar preços"**, **"Enviar estoque"** and **"Pausar
anúncios"** buttons are the same machine with a different payload. The legacy app had them as two nearly
identical dialogs — `EnviarPrecoDialog`
(`.old/lib/produtos/pages/produtoTableView.dart:466-1136`) and
`EnviarEstoqueDialog` (`.old/lib/produtos/pages/enviarEstoqueDialog.dart`) — each
walking the selection, then each produto's `marketplace` entries, dispatching to
whichever channel each one named. This directory is that walk, written once.

- `types.ts` — `PushRowBase` (what every result row shares), `PushAlvo`,
  `PushIntegracao`, `PushDeps` (the per-channel clients), and `buildProviderMap`.
- `run.ts` — `enviarParaMarketplaces`: the fan-out, the single chunked
  integração read, the cancel checks and the incremental `onProgress`.
- `PushProgressDialog.tsx` — the non-dismissible progress dialog, one live row
  per listing, Cancelar → Fechar.

The three operations bind to it in `../estoque/`, `../preco/` and
`../anuncioStatus/`.

⚠️ **`../anuncioStatus/` is the one whose payload is not a value but a
DIRECTION** (`acao: 'pausar' | 'reativar'`), so it has no per-run option at all —
`opcaoInicial={null}`, `renderOpcao={() => null}`. It is also the only one whose
row carries what the channel CONFIRMED (`statusFinal`) rather than what was sent:
Mercado Livre refuses to reactivate a zero-stock listing and answers `paused` on
a 200, and a row reading "Pausado" over that would be a green lie. The bulk
action is deliberately **pause-only**; reactivating lives in the produto's
Mercado Livre tab, where the operator sees the listing they are putting back on
air.

## What is NOT shared, and why

**The provider contract.** Each operation keeps its own `types.ts` / `registry.ts`
with its own method name (`enviarEstoque` / `enviarPreco` / `definirStatus`) and
its own per-run input (`reenviarComErro` / `baixarPreco` / `acao`). Collapsing
those into one `push(input)` with an opaque `opcao` would save about sixteen
lines and cost every call site its readable name — and the input is not
incidental, it is the thing the operator ticks (or, for the status one, the
button they pressed).

**The skip vocabulary.** Each channel backend owns the operator-facing pt-BR
`mensagem` per listing, and the providers pass it through verbatim. The stock
and status codes are kebab (`anuncio-em-erro`, `sem-anuncio`,
`anuncio-cancelado`, `ja-pausado`) and the price codes are UPPER_SNAKE
(`PRECO_ANTIGO_MAIOR`, `PRECO_NAO_MODIFICAVEL`) because the price ones are the
same codes the account-wide job persists in its `skips` list. That
is deliberate, and nothing in this layer reads them.

## Why the ROW unit is the listing, not the produto

A produto can carry several live anúncios on **one** conta — the stock sweep's
link join deliberately has no `limit(1)`, and rendering only the first one once
hid a latched sibling completely (#781). So the legacy one-row-per-(produto,
integração) shape is deliberately widened here.

## Adding a channel

Per operation: **a backend route**, **a provider file**, **one row in
`buildProviderMap`**. You never touch `run.ts`, the dialog, the produtos page or
the other channels' providers. The per-operation READMEs spell it out
(`../estoque/README.md`, `../preco/README.md`).

The dialog's only per-operation knob is `rotuloSucesso` — the wording of the
`enviado` outcome ("Enviado" / "Pausado"). The outcome VOCABULARY itself stays
fixed: every channel backend answers in the same four `PushOutcome` values and
the badge colours mean the same thing whatever the operation.

`resolve*PushProvider` falls back on its own — any tipo without an exact provider
goes to that operation's `unsupportedChannel`, which claims **no** tipos
precisely so registering a real channel never means editing the placeholder.

## Where the tests are

`run.ts` is pinned by `../estoque/enviarEstoqueRun.test.ts` — dedup, the
whole-selection dispatch, the per-conta row keys, both cancel checks. It runs
against the shared code path through the estoque binding, so it is not duplicated
under `../preco/`; that suite pins only what the price binding itself decides.
