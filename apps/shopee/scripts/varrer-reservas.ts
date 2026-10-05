/**
 * Rehearse the WEEKLY Shopee stuck-reservation sweep from the command line
 * (#1516, step 8).
 *
 *   pnpm --filter @delfrance/shopee-app varrer:reservas
 *
 * ## Why this exists — it is the load-bearing artefact of step 8
 *
 * The whole step rests on one question nobody can answer from documentation:
 * **does Shopee auto-cancel an unpaid BR order, after how long, and with which
 * `cancel_by`/`cancel_reason`?** The 215-page documentation cache has no
 * payment deadline, no auto-cancel rule and no window; the sandbox cannot
 * produce an aged unpaid order at all (order creation there has no payment
 * step). So the ONLY instrument that exists is a few weeks of DRY-RUN ticks
 * against live data, read week over week — the per-verdict vector plus the
 * three `marketplace.status` cross-tabs, all of which cost ZERO Shopee calls.
 *
 * That rehearsal has to run BEFORE `SHOPEE_PEDIDO_TRAVADO_SWEEP_ENABLED` is
 * ever turned on, which is why `--dry-run` supplies BOTH `forcarDryRun` and
 * `ignorarFlagMestra`: the sweep asserts that pair, so "can rehearse before the
 * flag, can never write before the flag" is structural rather than a promise.
 *
 * ⚠️ **Dev-only, and never run by an agent.** In `--live` it enqueues real
 * Cloud Tasks (a synthetic code-3 re-drive through step 5) and writes real
 * `avisos` documents. It never writes a pedido — the sweep has no writer for
 * one and runs no transaction.
 *
 * ## The two modes
 *
 * **`--dry-run` (the DEFAULT)** reads Firestore AND calls Shopee
 * (`get_order_detail`, batched 50 at a time), decides every verdict on the same
 * side of the boundary a live tick would, and skips exactly two effects: the
 * enqueue and the aviso write/resolve.
 *
 * **`--live`** runs the tick exactly as the schedule does. It supplies neither
 * seam, so `SHOPEE_PEDIDO_TRAVADO_SWEEP_ENABLED=1` is required in the
 * environment — flipping that flag is a human's act (root `CLAUDE.md` rule 8)
 * and a CLI must not be a second door. With the flag off it prints
 * `enabled: false`, names the variable and exits 0.
 *
 * ⚠️ **Both modes reach Shopee** and spend the same rate-limited calls.
 *
 * ## What it prints, and what it must never print
 *
 * Every candidate goes through `lib/shopee/pedidos/varrerReservasCli.ts`, whose
 * summary is an ALLOW-LIST of twelve fields, and the sweep never lets a
 * `get_order_detail` row out in the first place — it requests three optional
 * fields and never `buyer_cancel_reason`. A terminal transcript gets pasted
 * into issues; the SVC-AN incident (a `xMotivo` log that leaked a CNPJ into a
 * public log) is the local precedent.
 *
 * ## Exit codes
 *
 * `0` on ANY verdict — `ainda-nao-pago`, `inexistente` and `nao-verificavel`
 * are answers, not failures, and so is an empty conta list. `1` only on a
 * throw, described by CLASS and never a payload.
 */
import {
  ArgumentoInvalidoError,
  USO_VARRER_RESERVAS,
  descreverErroVarredura,
  documentoVarredura,
  parseArgsVarrerReservas,
  renderResumoVarredura,
  resumoDoCandidato,
  type ResumoReservaTravada,
} from '../lib/shopee/pedidos/varrerReservasCli';

/** stdout — the report. */
function log(message: string): void {
  // eslint-disable-next-line no-console -- CLI output
  console.log(message);
}

/**
 * stderr — the preamble and the warnings.
 *
 * ⚠️ Why a second stream: under `--json` the stdout must stay a single
 * parseable document, and the mode/project/database preamble still has to reach
 * the human BEFORE anything happens.
 */
function aviso(message: string): void {
  console.error(message);
}

/** A raw environment value, with a blank one spelled out rather than printed empty. */
function bruto(nome: string): string {
  const v = process.env[nome];
  if (v == null) return '(não definido)';
  return v.length === 0 ? '(vazio)' : v;
}

async function main(): Promise<void> {
  const args = parseArgsVarrerReservas(process.argv.slice(2));
  if (args.help) {
    log(USO_VARRER_RESERVAS);
    return;
  }
  const { integracaoId, maxIdadeDias, live, json, projectId } = args;

  // ⚠️ The dynamic imports are what make "`--help` touches no environment and
  // no Firestore" STRUCTURAL instead of a claim: nothing below this line has
  // been loaded yet, so no module-level env read, admin singleton or client
  // construction can run on the help path. They also keep `--project`
  // effective — the admin app resolves its project id once, at first use.
  if (projectId != null) process.env.FIREBASE_PROJECT_ID = projectId;
  // The horizon has no deps seam on purpose: `reservaTravadaMaxIdadeDias()` is
  // the ONE reader of the variable, in the tick and in the rehearsal alike, so
  // overriding it here rehearses the same parse the schedule will run.
  if (maxIdadeDias != null) {
    process.env.SHOPEE_PEDIDO_TRAVADO_MAX_IDADE_D = String(maxIdadeDias);
  }

  const { FieldValue } = await import('firebase-admin/firestore');
  const { getAdminApp, getAdminFirestore } = await import('../lib/firebase/admin');
  const { shopeeSandbox } = await import('../lib/shopee/env');
  const { loadShopeeContext } = await import('../lib/shopee/core/shopee');
  const { createShopeeTaskScheduler } = await import('../lib/shopee/shopeeTasks');
  const {
    RESERVA_TRAVADA_DRY_RUN_ENV,
    RESERVA_TRAVADA_FLAG_ENV,
    RESERVA_TRAVADA_MAX_IDADE_ENV,
    runReservaTravadaSweep,
  } = await import('../lib/shopee/pedidos/reservaTravadaSweep');

  /* ------------------------------ the preamble ----------------------------- */

  aviso(
    live
      ? '[shopee/varrer:reservas] modo: LIVE — VAI ENFILEIRAR E ESCREVER AVISOS'
      : '[shopee/varrer:reservas] modo: DRY-RUN — não enfileira e não grava nada',
  );
  const app = getAdminApp();
  aviso(`  projeto ............... ${app.options.projectId ?? '(não resolvido)'}`);
  aviso(`  database .............. ${process.env.FIREBASE_DATABASE_ID ?? 'default'}`);
  // ⚠️ The RAW value, because `shopeeSandbox()` is `=== '1'`: `''`, `true`,
  // `yes` and `0` are all PRODUCTION.
  aviso(`  SHOPEE_SANDBOX ........ ${bruto('SHOPEE_SANDBOX')}`);
  aviso(`  integracao ............ ${integracaoId ?? '(todas as contas ativas)'}`);
  aviso(
    `  horizonte (dias) ...... ${maxIdadeDias == null ? `(do ambiente: ${bruto(RESERVA_TRAVADA_MAX_IDADE_ENV)})` : String(maxIdadeDias)}`,
  );
  // The two flags RAW, and both of them: `--live` honours the master flag, and
  // the environment's own DRY_RUN outranks `--live` (see the warning below).
  aviso(`  ${RESERVA_TRAVADA_FLAG_ENV} = ${bruto(RESERVA_TRAVADA_FLAG_ENV)}`);
  aviso(`  ${RESERVA_TRAVADA_DRY_RUN_ENV} = ${bruto(RESERVA_TRAVADA_DRY_RUN_ENV)}`);

  const db = getAdminFirestore();

  // The Shopee environment. ⚠️ Resolved from a CONTA's context only when the run
  // is scoped to one — an unscoped tick spans every active conta and there is no
  // single answer, so the process-wide verdict is what gets printed instead.
  if (integracaoId != null) {
    // The same seam the sweep uses, and for its GUARDS: a missing conta, a conta
    // that is not Shopee, or a missing partner id/key fails HERE rather than at
    // Shopee.
    const ctx = await loadShopeeContext(db, integracaoId);
    aviso(`  ambiente Shopee ....... ${ctx.config.sandbox ? 'SANDBOX' : 'PRODUÇÃO'}`);
    aviso(
      `  loja (shop_id) ........ ${ctx.conta.shop_id == null ? '(nenhuma — conta principal)' : String(ctx.conta.shop_id)}`,
    );
  } else {
    aviso(`  ambiente Shopee ....... ${shopeeSandbox() ? 'SANDBOX' : 'PRODUÇÃO'}`);
  }

  if (live && process.env[RESERVA_TRAVADA_DRY_RUN_ENV] === '1') {
    aviso('');
    aviso('⚠️ o ambiente força DRY_RUN — nada será gravado');
  }
  aviso('');

  /* -------------------------------- the tick ------------------------------- */

  const linhas: ResumoReservaTravada[] = [];
  const resultado = await runReservaTravadaSweep(db, {
    scheduler: createShopeeTaskScheduler(),
    // ONE clock read for the whole tick — the sweep never re-reads it.
    nowMs: Date.now(),
    // Injected because `packages/data/src/admin/**` may only `import type` from
    // firebase-admin — the aviso counter is a tier-0 FieldValue, so two
    // producers landing together cannot lose each other's bump.
    increment: (by: number) => FieldValue.increment(by),
    logger: console,
    ...(integracaoId == null ? {} : { apenasIntegracoes: [integracaoId] }),
    // ⚠️ The PAIR. The rehearsal must run before the master flag exists in
    // `.env.deploy`, and must be incapable of writing while it does not — the
    // sweep throws `ShopeeConfigError` if these two ever come apart.
    ...(live ? {} : { forcarDryRun: true, ignorarFlagMestra: true }),
    onCandidato: (c) => linhas.push(resumoDoCandidato(c)),
  });

  if (json) {
    log(JSON.stringify(documentoVarredura(resultado, linhas), null, 2));
    return;
  }

  for (const linha of renderResumoVarredura(resultado, linhas)) log(linha);

  if (!resultado.enabled) return;
  if (resultado.contas.length === 0 && integracaoId != null) {
    aviso('');
    aviso(
      `⚠️ Nenhuma conta ATIVA com o id ${integracaoId} — confira --integracao e o campo \`ativo\`. ` +
        'O tick rodou e não examinou nada dessa conta.',
    );
  }
}

await main().catch((err: unknown) => {
  // Narrow enough to be useful and never wide enough to print a payload — the
  // whole table is `descreverErroVarredura`, which is unit-tested.
  for (const linha of descreverErroVarredura(err)) aviso(linha);
  if (!(err instanceof ArgumentoInvalidoError)) {
    aviso('');
    aviso(
      'Um erro no meio do tick não desfaz o que já aconteceu: em --live, avisos já escritos e ' +
        'tarefas já enfileiradas continuam lá.',
    );
    aviso('Releia sem --live (o dry-run é o padrão e não grava) antes de repetir.');
  }
  process.exitCode = 1;
});
