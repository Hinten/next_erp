/**
 * The one flag that suspends every live suite blocked by NT 2026.007's LCC-RFB
 * cadastral validation.
 *
 * ⚠️ **NT 2026.007 v1.00 (Julho/2026), §5.10 "Banco de Dados: Validação
 * Cadastro LCC-RFB"** added a family of MANDATORY rejections — "Regra de
 * validação para todas as SEFAZ Autorizadoras" — that look each participant's
 * CNPJ up in the **LCC-RFB**, a national copy of the Receita Federal's CNPJ
 * register synchronised to the SEFAZs. Implantação teste **01/09/2026**,
 * produção **03/11/2026**.
 *
 * | RV | cStat | Rejeição |
 * |---|---|---|
 * | 12C02-10 | 178 | CNPJ do emitente não cadastrado na Receita Federal |
 * | 12C02-20 | 179 | CNPJ do emitente com situação irregular na Receita Federal |
 * | 12C21-20 | 180 | CRT do emitente diverge do cadastro na Receita Federal |
 * | **12E02-10** | **181** | **CNPJ do destinatário não cadastrado na Receita Federal** |
 * | 12E02-20 | 182 | CNPJ do Destinatário com situação irregular na Receita Federal |
 * | 12F02-10/-20 | 183/184 | Local de Retirada — não cadastrado / situação irregular |
 * | 12G02-10/-20 | 185/186 | Local de Entrega — não cadastrado / situação irregular |
 *
 * `buildHomologacaoFixture` emits destinatário CNPJ `99999999000191`. It is
 * DV-valid, and it is the CNPJ the OLDER optional rejection 597 ("NF-e emitida
 * em ambiente de homologação com CNPJ do destinatário diferente de
 * 99999999000191") demands — but it does not exist in the RFB register, so RV
 * 12E02-10 rejects it with **181**. The two rules contradict each other and
 * reconciling them is SEFAZ's to do, not ours.
 *
 * ⚠️ **There is no placeholder CNPJ that works.** The rule queries the real
 * cadastro, so this is not a matter of picking a better fake. Do not "fix" a
 * blocked suite by swapping in another invented CNPJ — it earns 181 too, and
 * every attempt spends SEFAZ quota against a rate-limited endpoint.
 *
 * ⚠️ 178–186 sit in the **152–200 gap that every published cStat table still
 * shows as empty** (`nfephp-org/sped-nfe`, `mazinsw/nfe-api`, …), which is why
 * the code looked unrecognisable when it first arrived. The NT is the only
 * source; it is vendored at
 * `.claude/skills/nfe/references/sources/nt/2026/`, and the family is
 * catalogued in the `nfe` skill's `references/cstat-rejeicoes.md`.
 *
 * ⚠️ This blocks **only** the CNPJ destinatário. RV 12E02-10 is conditioned on
 * "Se informado CNPJ do Destinatário (tag: E02)", so a **CPF** destinatário
 * (tag E03) is outside the rule entirely — which is why
 * `apps/nfe/test/lib/nfe/{orchestrator,epec}.homologacao.test.ts`, which build
 * their own pessoa-física destinatário, keep passing. That is the proposed fix
 * in #1612; it was not applied here because the shared fixture serves three
 * suites and the swap would drop live coverage of the `pessoaJuridica`
 * destinatário branch. LCC-RFB also does NOT cover `transporta`, the payment
 * PSP or `infIntermed`, so the fixture's other three `99999999000191` values
 * are fine.
 *
 * TO LIFT THE BLOCK: set this to `false` and run the live lane via
 * `workflow_dispatch`. Nothing else here needs touching — the three suites read
 * this one flag.
 *
 * @see https://github.com/Hinten/next_erp/issues/1612
 * @see https://github.com/Hinten/next_erp/issues/1471 — the earlier bare `178`, same family
 */
export const LCC_RFB_BLOQUEADO = true;

/**
 * Why the suite is suspended, in the test title itself.
 *
 * ⚠️ The reason belongs in the NAME, not only in a comment: a skipped test
 * prints its name and nothing else, and a reporter line reading
 * "skipped: duplicidade recovery" tells a future reader nothing about whether
 * the skip is still warranted. "CI green" here means "the suite passed", so a
 * suspension that cannot explain itself is the silent-pass class the whole lane
 * design exists to prevent (root `CLAUDE.md`).
 */
export const LCC_RFB_MOTIVO =
  'BLOQUEADO: SEFAZ rejeita o destinatário do fixture com cStat=181 ' +
  '(NT 2026.007 RV 12E02-10 — CNPJ não cadastrado na Receita Federal, LCC-RFB) — ver #1612';
