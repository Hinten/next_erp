# `lib/marketplace/contaJobs` — fanning one job across selected contas

A channel's bulk job actions ("Importar todos os anúncios", "Atualizar preços")
all have the same shape: the operator ticks several accounts of one channel,
each account gets its own independent job, and the panel shows one card per
account. Only two things differ per channel — **how a job is started** and
**which throwables that channel's client considers its own**. Both are injected.

| File                    | What it is                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`              | `ContaRef`, `contaRefFromRow`, `ContaJobOutcome`, `FanOutResult`, and the `JobErrorDescription` **port**                              |
| `startJobsForContas.ts` | the React-free fan-out — `Promise.allSettled`, input order preserved                                                                  |
| `useContaJobFan.ts`     | the ledger + in-flight flag on top of it                                                                                              |
| `envioPrecoCsv.ts`      | the "Atualizar preços" CSV — builder, filename, header, `MAX_PAGINAS_RELATORIO_PRECO`; typed on the relatório row both channels store |

The shared card chrome is React, so it lives beside the other cross-route
components in `apps/web/components/contaJobs/`:

| File                        | What it is                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `JobCardShell.tsx`          | `JobCardShell`, `ContaJobErrorCard`, and the `ErrosDoCliente` **port** a cancellable card passes with `onCancel` |
| `PriceSyncEntryList.tsx`    | the skip/failure sample with its "+N mais" tail, over `AmostraDeJob`                                             |
| `BaixarRelatorioButton.tsx` | "Baixar CSV" with its page counter                                                                               |
| `ContasSelecionadas.tsx`    | the start dialogs' list of the contas a run will touch                                                           |

## Adding a channel

1. Write a `describe<Job>StartError(err): JobErrorDescription | null` next to
   that channel's client, narrowing on its own error classes. Return `null` for
   anything else — root `CLAUDE.md` rule 6.
   Mercado Livre's lives in `canais/mercado-livre/_components/mercadoLivreJobErrors.ts`.
   Shopee's (#1529) in `canais/shopee/_components/shopeeJobErrors.ts`, with `ERROS_DO_CLIENTE_SHOPEE`.
2. In the action hook: `const fan = useContaJobFan(describe<Job>StartError);`
   then `await fan.run(contas, (contaId) => client.start<Job>(contaId))`.
3. Render `fan.entries` with `components/contaJobs/*`, passing the channel's
   own `ErrosDoCliente` with every `onCancel` (Mercado Livre's is
   `ERROS_DO_CLIENTE_ML`, beside its describers). The cards, the panel, the
   hooks and the download hook stay per-channel; only the machinery above and
   that chrome are shared.

## Two invariants, both with a test

- ⚠️ **Commit the outcomes, THEN rethrow.** A throwable `describeError` did not
  recognise reaches the caller, but only after `entries` is set: a started job's
  `jobId` is the only handle the UI has on it, and losing it strands a run with
  no progress view. `useContaJobFan.test.ts` pins the ordering (and fails if the
  two lines are swapped).
- ⚠️ **A conta whose start fails must not cost the others theirs.** That is why
  the fan-out is `Promise.allSettled` and why `startJobsForContas` is a plain
  async function rather than a hook — the contract is testable without React.
  It is also why the whole thing is total: `useActionRunner.execute` awaits
  `ActionConfig.run` with no `try`/`catch`, so a rejection there is an unhandled
  promise rejection.

## Why it lives here

It was written inside `canais/mercado-livre/_components/` (#816) and moved out
in **#1430**. Nothing in it was ever Mercado Livre specific — `ContaRef` is
`{ id, nome }` and the only schema type is the shared `Integracao` — but an
`app/` folder is private to its route, so a second channel could only have
forked it. That fork is the failure mode the `marketplace-integration` skill
names: _register, do not copy_.

**#1529** moved the next layer the same way, for Shopee's cards: the CSV
builder and the card chrome above. Each was a MOVE, name and behaviour
unchanged. Where a moved piece still named Mercado Livre it was parameterised
instead — `ErrosDoCliente` for the two hard-coded client classes, `AmostraDeJob`
for ML's skip type, a plain `status: string` in the CSV resumo, and the page cap
exported as `MAX_PAGINAS_RELATORIO_PRECO` — and each keeps Mercado Livre's
output byte-identical, which its unedited tests pin.
