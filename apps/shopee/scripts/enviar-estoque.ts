/**
 * Push the CURRENT ERP stock of hand-picked produtos to their Shopee listings
 * from the command line — the step-12 rehearsal (#1520).
 *
 *   pnpm --filter @delfrance/shopee-app enviar:estoque \
 *     --integracao int-1 --produto prod-1 --produto prod-2
 *
 * ## Why this exists
 *
 * `processShopeeStockSendTask` otherwise reaches Shopee only through the
 * `sendShopeeStock` queue — fed by three cron sweeps — or through the
 * `enviar-estoque` route, i.e. through a screen step 21 has not shipped. So the
 * FIRST quantity this channel ever writes would happen unattended, on a
 * schedule, against listings nobody inspected. This script makes that first
 * write a deliberate, observable act against named produtos — one human, one
 * terminal — before the migration window (root CLAUDE.md rule 8).
 *
 * ⚠️ **Dev-only, and never run by an agent.** In `--live` it writes REAL
 * quantities to REAL listings (`update_stock`) and patches the `prodshopee` /
 * `variashopee` link documents.
 *
 * ## The two modes
 *
 * **`--dry-run` (the DEFAULT)** reads the families, computes the quantities,
 * runs the PLANNER and reads each planned listing's promotion so the `piso`
 * column is real — then prints the plan. It writes nothing to Firestore and
 * calls no write operation, and that is STRUCTURAL rather than a promise: the
 * sender module is not even imported on this path, and the planner reaches no
 * writer at all.
 *
 * **`--live`** calls `enviarEstoqueManualShopee` exactly as the route does —
 * the same single clock read, the same injected elapsed clock, the same
 * `esperar`, one shop-signed client — and prints the envelope it answered.
 *
 * ## ⚠️ The pause is REPORTED, not refused
 *
 * The route refuses a paused conta with a 409 to save provider calls on a
 * screen. Here the state document is read and printed in the preamble and the
 * run PROCEEDS: the handler's refusing scheduler turns a pause into per-listing
 * `nao-tentado` rows carrying `pausadoAte`, which tells the operator more than a
 * single refusal would — and inspecting a paused conta is exactly what a dry run
 * is for. The client is still built AFTER that read, so nothing is minted for a
 * conta that turns out to be paused and the read costs no Shopee call.
 *
 * ## What it prints, and what it must never print
 *
 * Everything is rendered through `lib/shopee/estoque/enviarEstoqueCli.ts`, whose
 * summaries are an ALLOW-LIST built by name. No token, no partner id or key, no
 * raw promotion body, no buyer datum and no `item_name` can travel through it.
 * The produto's own NAME is printed, deliberately — it is the one thing that
 * lets a human tell one row from another. A terminal transcript gets pasted into
 * issues; the SVC-AN incident (a `xMotivo` log that leaked a CNPJ into a public
 * log) is the local precedent.
 *
 * ⚠️ It holds no Shopee id, key, token or shop id — the usage text names `int-1`
 * and the shop id comes from the integração document at runtime.
 *
 * ## Exit codes
 *
 * `0` on ANY envelope, **including one where every listing failed**: a
 * per-listing refusal is DATA, the route answers 200 there, and the two surfaces
 * must not disagree about what a refusal is. `0` likewise on a dry run that
 * plans nothing at all. `1` only on a throw, described by CLASS plus Shopee's
 * `code`/`path` and never a payload; on a bad command line; and on a conta with
 * no `shop_id`, which is printed as an instruction to re-consent rather than as
 * a stack.
 */
import {
  ArgumentoInvalidoError,
  USO_ENVIAR_ESTOQUE,
  descreverErroEnvio,
  lerArgsEnviarEstoque,
  montarPlanoDeEnvio,
  renderizarPlanoDeEnvio,
  renderizarResultadoEnvio,
  resumoDoEnvio,
  resumoDoPlano,
  type EntradaDoPlano,
} from '../lib/shopee/estoque/enviarEstoqueCli';

/** stdout — the report. */
function log(message: string): void {
  // eslint-disable-next-line no-console -- CLI output
  console.log(message);
}

/**
 * stderr — the preamble and the warnings.
 *
 * ⚠️ Why a second stream: under `--json` the stdout must stay a single parseable
 * document, and the mode/project/database preamble still has to reach the human
 * BEFORE anything happens.
 */
function aviso(message: string): void {
  console.error(message);
}

/** `get_item_promotion` takes a bounded list of item ids; cut the reads to fit. */
function lotes<T>(itens: readonly T[], tamanho: number): T[][] {
  const saida: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) saida.push(itens.slice(i, i + tamanho));
  return saida;
}

async function main(): Promise<void> {
  const comando = lerArgsEnviarEstoque(process.argv.slice(2));
  if (comando.kind === 'ajuda') {
    log(USO_ENVIAR_ESTOQUE);
    return;
  }
  const { integracaoId, produtoIds, reenviarComErro, live, json, projectId } = comando.args;

  // ⚠️ The dynamic imports are what make "`--help` touches no environment and no
  // Firestore" STRUCTURAL instead of a claim: nothing below this line has been
  // loaded yet, so no module-level env read, admin singleton or client
  // construction can run on the help path. They also keep `--project` effective
  // — the admin app resolves its project id once, at first use.
  if (projectId != null) process.env.FIREBASE_PROJECT_ID = projectId;

  const { getAdminApp, getAdminFirestore } = await import('../lib/firebase/admin');
  const { SHOPEE_ITEM_PROMOTION_MAX_IDS } = await import('@delfrance/integrations-shopee');
  const { idFromRef } = await import('@delfrance/schemas');
  const { produtoCollection } = await import('@delfrance/data/admin/collections');
  const { loadShopeeContext } = await import('../lib/shopee/core/shopee');
  const { SHOPEE_STOCK_SYNC_FLAG_ENV } = await import('../lib/shopee/estoque/constantesEstoque');
  const {
    CODIGO_GUARDA_ENVIO,
    MENSAGEM_POR_MOTIVO,
    MOTIVO_ESTOQUE_SHOPEE,
    ShopeeEnvioEstoqueGuardError,
  } = await import('../lib/shopee/estoque/errosEstoque');
  const { estaPausada, lerEstadoEstoque } = await import('../lib/shopee/estoque/estadoEstoque');

  /* ------------------------------ the preamble ----------------------------- */

  aviso(
    live
      ? '[shopee/enviar:estoque] modo: LIVE — VAI ESCREVER ESTOQUE DE VERDADE NA SHOPEE'
      : '[shopee/enviar:estoque] modo: DRY-RUN — não envia estoque e não grava vínculo',
  );
  // `getAdminApp()` resolves credentials and the project id locally; it opens no
  // connection. Printing before that would have to guess at the fallback ladder.
  const app = getAdminApp();
  aviso(`  projeto ......... ${app.options.projectId ?? '(não resolvido)'}`);
  aviso(`  database ........ ${process.env.FIREBASE_DATABASE_ID ?? 'default'}`);
  // ⚠️ The RAW value, and a blank one is spelled out rather than printed as an
  // empty string: `shopeeSandbox()` is `=== '1'`, so `''`, `true`, `yes` and `0`
  // are all PRODUCTION. The resolved verdict is the `ambiente Shopee` line below.
  const sandboxBruto = process.env.SHOPEE_SANDBOX;
  aviso(
    `  SHOPEE_SANDBOX .. ${sandboxBruto == null ? '(não definido)' : sandboxBruto.length === 0 ? '(vazio — PRODUÇÃO)' : sandboxBruto}`,
  );
  aviso(`  integracao ...... ${integracaoId}`);
  aviso(`  produtos ........ ${String(produtoIds.length)}: ${produtoIds.join(', ')}`);
  // ⚠️ RAW as well, and the sentence beside it is the point: the manual push
  // passes `ignoreSyncFlag: true`, so this valve does NOT gate this command.
  const valvulaBruta = process.env[SHOPEE_STOCK_SYNC_FLAG_ENV];
  aviso(
    `  ${SHOPEE_STOCK_SYNC_FLAG_ENV} = ${valvulaBruta == null ? '(não definido)' : valvulaBruta.length === 0 ? '(vazio)' : valvulaBruta} — o envio manual IGNORA esta flag`,
  );

  const db = getAdminFirestore();

  // The same seam the route and `oauth:url` use, and for its GUARDS: a missing
  // conta, a conta that is not Shopee, or a missing partner id/key fails HERE
  // rather than at Shopee.
  const ctx = await loadShopeeContext(db, integracaoId);
  const shopId = ctx.conta.shop_id;
  aviso(`  ambiente Shopee . ${ctx.config.sandbox ? 'SANDBOX' : 'PRODUÇÃO'}`);
  aviso(`  loja (shop_id) .. ${shopId == null ? '(nenhuma)' : String(shopId)}`);
  if (shopId == null) {
    // Deliberately not a throw: it is a legitimate conta state (consent given by
    // main account), and the operator's next step is a re-consent, not a stack.
    aviso('');
    aviso(
      '❌ A conta está conectada por CONTA PRINCIPAL e não tem shop_id, então nenhuma ' +
        'chamada pode ser assinada. Reconecte escolhendo a loja.',
    );
    process.exitCode = 1;
    return;
  }
  aviso(`  depósito ........ ${ctx.conta.depositoOuterRef ?? '(nenhum — sem estoque)'}`);

  // ⚠️ ONE clock read for the whole run, handed DOWN — exactly as the route
  // does. Every module under `estoque/` takes the instant as a parameter, so two
  // documents written by one run can never disagree about when it happened. The
  // ELAPSED clock is a SEPARATE, injected reader: the run's deadline must not be
  // measured against the logical instant.
  const nowMs = Date.now();

  // Read BEFORE the client is built: a paused conta must not mint a shop-signed
  // client, and the read itself costs no Shopee call. It is reported, not
  // refused — see the header.
  const estado = await lerEstadoEstoque(db, integracaoId);
  aviso(
    `  pausado ......... ${
      estaPausada(estado, nowMs)
        ? `SIM, até ${new Date(estado.pausadoAte ?? nowMs).toISOString()} — tudo sairá como "não tentado"`
        : 'não'
    }`,
  );
  aviso('');

  // The depósito guard, in BOTH modes and with the module's own class and code:
  // the dry run derives the same `depositoId` the send does, so a conta that
  // cannot answer "how much stock" must refuse identically in both.
  const depositoRef = ctx.conta.depositoOuterRef;
  const depositoId =
    typeof depositoRef === 'string' && depositoRef.trim() !== '' ? idFromRef(depositoRef) : '';
  if (depositoId === '') {
    throw new ShopeeEnvioEstoqueGuardError(
      CODIGO_GUARDA_ENVIO.contaSemDeposito,
      MENSAGEM_POR_MOTIVO[MOTIVO_ESTOQUE_SHOPEE.semDeposito],
    );
  }

  // ONE shop-signed client for the whole run, built after the pause read.
  const client = ctx.createShopClient();

  /* --------------------------------- dry-run -------------------------------- */

  if (!live) {
    const { buscarFamiliasShopeePorIds } = await import('../lib/shopee/estoque/descobertaEstoque');
    const { montarTarefasDeEstoqueShopee } = await import('../lib/shopee/estoque/planoEstoque');
    const { quantidadesDaFamiliaShopee } = await import('../lib/shopee/estoque/quantidadeEstoque');
    const { pisoPorModelo } = await import('../lib/shopee/estoque/reservaPromocao');

    const nomes = new Map<string, string | null>(
      await Promise.all(
        produtoIds.map(async (produtoId): Promise<[string, string | null]> => {
          const snap = await produtoCollection.docRef(db, {}, produtoId).get();
          const bruto = (snap.data() ?? {}) as Record<string, unknown>;
          const nome = bruto['nome'];
          return [produtoId, typeof nome === 'string' && nome.trim() !== '' ? nome : null];
        }),
      ),
    );

    // The by-ids reader carries NO conta term on purpose: that absence is what
    // makes the planner's `conta-fora-do-produto` and `sem-link` rungs fire with
    // an operator-visible line instead of the row silently not coming back.
    const rows = await buscarFamiliasShopeePorIds(db, { integracaoId, depositoId, produtoIds });
    const rowPorAnchor = new Map(rows.map((r) => [r.anchorId, r]));

    const entradas: EntradaDoPlano[] = produtoIds.map((produtoId): EntradaDoPlano => {
      const row = rowPorAnchor.get(produtoId) ?? null;
      return {
        produtoId,
        produtoNome: nomes.get(produtoId) ?? null,
        row,
        plano:
          row === null
            ? null
            : montarTarefasDeEstoqueShopee(row, quantidadesDaFamiliaShopee(row), {
                integracaoId,
                sweepId: `ensaio-${integracaoId}-${String(nowMs)}`,
                sweepComputadoEmMs: nowMs,
                nowMs,
                ignorarRecusa: reenviarComErro,
              }),
      };
    });

    // The ONE Shopee READ of the dry run, and the only one: the reserved floor,
    // for the `piso` column. Nothing on this path writes.
    const itemIds = [
      ...new Set(entradas.flatMap((e) => (e.plano?.tarefas ?? []).map((t) => t.itemId))),
    ];
    const pisoPorItem = new Map<number, ReadonlyMap<number, number>>();
    for (const lote of lotes(itemIds, SHOPEE_ITEM_PROMOTION_MAX_IDS)) {
      const promocoes = await client.getItemPromotion({ itemIds: lote });
      for (const itemId of lote) pisoPorItem.set(itemId, pisoPorModelo(promocoes, itemId));
    }

    const plano = montarPlanoDeEnvio(entradas, { integracaoId, pisoPorItem });

    if (json) {
      log(JSON.stringify({ modo: 'dry-run', integracaoId, plano: resumoDoPlano(plano) }, null, 2));
      return;
    }
    log('== DRY-RUN — nada foi enviado e nenhum vínculo foi gravado ==');
    log('');
    for (const linha of renderizarPlanoDeEnvio(plano)) log(linha);
    return;
  }

  /* ---------------------------------- live ---------------------------------- */

  const { FieldValue } = await import('firebase-admin/firestore');
  const { enviarEstoqueManualShopee } = await import('../lib/shopee/estoque/enviarEstoqueManual');

  const resposta = await enviarEstoqueManualShopee(
    db,
    { integracaoId, produtoIds, reenviarComErro },
    {
      nowMs,
      agora: () => Date.now(),
      esperar: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      conta: ctx.conta as unknown as Readonly<Record<string, unknown>>,
      contaNome: typeof ctx.conta.nome === 'string' ? ctx.conta.nome : null,
      client,
      // Wrapped rather than passed by reference so the sentinel is built at call
      // time by the caller that owns the firebase-admin import.
      increment: (by: number) => FieldValue.increment(by),
    },
  );

  if (json) {
    log(
      JSON.stringify({ modo: 'live', integracaoId, resultado: resumoDoEnvio(resposta) }, null, 2),
    );
    return;
  }

  log('== LIVE — o envio de estoque de verdade ==');
  log('');
  for (const linha of renderizarResultadoEnvio(resposta)) log(linha);
}

await main().catch((err: unknown) => {
  // Narrow enough to be useful and never wide enough to print a payload — the
  // whole table is `descreverErroEnvio`, which is unit-tested.
  for (const linha of descreverErroEnvio(err)) aviso(linha);
  if (!(err instanceof ArgumentoInvalidoError)) {
    aviso('');
    aviso(
      'Nada garante que nada foi escrito: um erro DEPOIS de um update_stock deixa a quantidade no lugar.',
    );
    aviso('Releia com --dry-run (ele não envia estoque) antes de repetir com --live.');
  }
  process.exitCode = 1;
});
