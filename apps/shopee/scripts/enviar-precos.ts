/**
 * Push the CURRENT tabela price of hand-picked produtos to their Shopee
 * listings from the command line — the step-13 rehearsal (#1521).
 *
 *   pnpm --filter @delfrance/shopee-app enviar:precos \
 *     --integracao int-1 --produto prod-1 --produto prod-2
 *
 * ## Why this exists
 *
 * `enviarPrecoManualShopee` otherwise reaches Shopee only through the
 * `enviar-precos` route, i.e. through a screen step 21 has not shipped. This
 * script makes the channel's FIRST `update_price` a deliberate, observable act
 * against named produtos — one human, one terminal — and it is the only place
 * the whole per-model DECISION is printed before anything is sent.
 *
 * ⚠️ **Dev-only, and never run by an agent.** In `--live` it writes REAL prices
 * to REAL listings (`update_price`) and patches the `prodshopee` /
 * `variashopee` link documents.
 *
 * ## The two modes
 *
 * **`--dry-run` (the DEFAULT)** resolves, discovers, plans, prices, reads each
 * listing fresh and asks `decidirEnvioDePreco` — the live sender's own pure
 * decision — then prints per model `anterior · alvo · decisão · motivo`. It
 * writes nothing to Firestore and calls no write operation, and that is
 * STRUCTURAL: the sender and the manual run are not even imported on this path.
 *
 * **`--live`** calls `enviarPrecoManualShopee` exactly as the route does — the
 * same single clock read, the same injected elapsed clock, the same `esperar`,
 * the conta context the verdict approved — and prints the envelope.
 *
 * ## ⚠️ The conta verdict runs FIRST, in both modes, and a refusal exits 0
 *
 * `avaliarContaParaPreco` is the route's rung 13: a shop outside Brazil (unless
 * the sandbox override holds on the RESOLVED sandbox host), a cross-border,
 * banned or frozen shop, a conta without a normal price table, without a
 * `shop_id` or without a usable credential is REFUSED before any listing is
 * read. The route answers that refusal 422 (400 for the missing table) as a
 * RESPONSE; this script prints it and exits 0, for the same reason.
 *
 * ## ⚠️ The pause is REPORTED, not refused
 *
 * The route refuses a conta in a QUOTA pause with a 409 before any provider
 * call. Here the stock sync's state document is read and printed in the
 * preamble, and the run PROCEEDS — step 12's CLI rule: inspecting a paused
 * conta is exactly what a dry run is for, and under `--live` a throttled send
 * comes back as `nao-tentado conta-pausada` rows carrying `pausadoAte`.
 *
 * ## What it prints, and what it must never print
 *
 * Everything is rendered through `lib/shopee/precos/enviarPrecoCli.ts`, whose
 * summaries are an ALLOW-LIST built by name. No token, no partner id or key, no
 * raw Shopee body, no buyer datum and no `item_name` can travel through it.
 *
 * ⚠️ It holds no Shopee id, key, token or shop id — the usage text names `int-1`
 * and the shop comes from the integração document at runtime.
 *
 * ## Exit codes
 *
 * `0` on ANY envelope, **including one where every row failed**, on a dry run
 * that plans nothing, and on a conta the verdict refuses — each of those is an
 * ANSWER. `1` only on a throw (described by CLASS plus Shopee's `code`/`path`,
 * never a payload) and on a bad command line.
 */
import {
  USO_ENVIAR_PRECOS,
  descreverErroEnvioPreco,
  descreverRecusaDaConta,
  ehRecusaAntesDoEnvioDePreco,
  ensaiarEnvioDePreco,
  lerArgsEnviarPrecos,
  renderizarEnsaio,
  renderizarResultadoEnvioPreco,
  resumoDaRecusaDaConta,
  resumoDoEnsaio,
  resumoDoEnvioPreco,
} from '../lib/shopee/precos/enviarPrecoCli';

/** stdout — the report. */
function log(message: string): void {
  // eslint-disable-next-line no-console -- CLI output
  console.log(message);
}

/**
 * stderr — the preamble and the warnings. Under `--json` the stdout must stay a
 * single parseable document, and the preamble still has to reach the human
 * BEFORE anything happens.
 */
function aviso(message: string): void {
  console.error(message);
}

/** A raw env value, spelled out when unset or blank rather than printed as nothing. */
function bruto(valor: string | undefined, vazio: string): string {
  if (valor == null) return '(não definido)';
  return valor.length === 0 ? vazio : valor;
}

async function main(): Promise<void> {
  const comando = lerArgsEnviarPrecos(process.argv.slice(2));
  if (comando.kind === 'ajuda') {
    log(USO_ENVIAR_PRECOS);
    return;
  }
  const { integracaoId, produtoIds, baixarPreco, live, json, projectId } = comando.args;

  // ⚠️ The dynamic imports are what make "`--help` touches no environment and no
  // Firestore" STRUCTURAL: nothing below this line has been loaded yet. They
  // also keep `--project` effective — the admin app resolves its project id
  // once, at first use.
  if (projectId != null) process.env.FIREBASE_PROJECT_ID = projectId;

  const { getAdminApp, getAdminFirestore } = await import('../lib/firebase/admin');
  const { loadShopeeContext } = await import('../lib/shopee/core/shopee');
  const { estaPausada, lerEstadoEstoque } = await import('../lib/shopee/estoque/estadoEstoque');
  const { avaliarContaParaPreco, overrideDeSandboxAtivo } =
    await import('../lib/shopee/precos/regiaoPreco');

  /* ------------------------------ the preamble ----------------------------- */

  aviso(
    live
      ? '[shopee/enviar:precos] modo: LIVE — VAI ESCREVER PREÇO DE VERDADE NA SHOPEE'
      : '[shopee/enviar:precos] modo: DRY-RUN — não envia preço e não grava vínculo',
  );
  // `getAdminApp()` resolves credentials and the project id locally; it opens no
  // connection.
  const app = getAdminApp();
  aviso(`  projeto ......... ${app.options.projectId ?? '(não resolvido)'}`);
  aviso(`  database ........ ${process.env.FIREBASE_DATABASE_ID ?? 'default'}`);
  // ⚠️ The RAW value: `shopeeSandbox()` is `=== '1'`, so `''`, `true` and `0`
  // are all PRODUCTION. The resolved verdict is the `ambiente` line below.
  aviso(`  SHOPEE_SANDBOX .. ${bruto(process.env.SHOPEE_SANDBOX, '(vazio — PRODUÇÃO)')}`);
  aviso(`  integracao ...... ${integracaoId}`);
  aviso(`  produtos ........ ${String(produtoIds.length)}: ${produtoIds.join(', ')}`);
  aviso(
    `  baixar preço .... ${baixarPreco ? 'AUTORIZADO (--baixar-preco)' : 'não — um preço menor é pulado'}`,
  );

  const db = getAdminFirestore();

  // The same seam the route uses, and for its GUARDS: a missing conta, a conta
  // that is not Shopee, or a missing partner id/key fails HERE.
  const ctx = await loadShopeeContext(db, integracaoId);
  aviso(`  ambiente Shopee . ${ctx.config.sandbox ? 'SANDBOX' : 'PRODUÇÃO'}`);
  aviso(`  host da API ..... ${ctx.config.hosts.apiHost}`);
  // ⚠️ The override is BOTH facts — the flag AND the resolved sandbox host —
  // printed through the verdict's own predicate, never re-derived here.
  aviso(
    `  override SG ..... ${overrideDeSandboxAtivo(ctx.config) ? 'ATIVO (sandbox no host de sandbox)' : 'inativo — só loja BR'}`,
  );
  aviso(
    `  loja (shop_id) .. ${ctx.conta.shop_id == null ? '(nenhuma)' : String(ctx.conta.shop_id)}`,
  );
  const tabelaRef: unknown = ctx.conta.tabelaNormalOuterRef;
  aviso(
    `  tabela normal ... ${typeof tabelaRef === 'string' && tabelaRef.trim() !== '' ? tabelaRef : '(nenhuma — a conta será recusada)'}`,
  );

  // ⚠️ ONE clock read for the whole run, handed DOWN — exactly as the route
  // does. The ELAPSED clock is a SEPARATE, injected reader.
  const nowMs = Date.now();

  // Read so the pause can be REPORTED — it gates nothing below.
  const estado = await lerEstadoEstoque(db, integracaoId);
  aviso(
    `  pausado ......... ${
      estaPausada(estado, nowMs)
        ? `SIM (${estado.pausaMotivo ?? 'sem motivo'}), até ${new Date(estado.pausadoAte ?? nowMs).toISOString()} — reportado, não recusado`
        : 'não'
    }`,
  );

  // The route's rung 13, in BOTH modes: a conta the ERP will not price stops
  // here, before any listing is read.
  const veredito = await avaliarContaParaPreco(
    db,
    {
      integracaoId,
      shopId: ctx.conta.shop_id ?? null,
      tabelaNormalOuterRef: ctx.conta.tabelaNormalOuterRef,
    },
    {
      nowMs,
      clientFor: () => Promise.resolve().then(() => ctx.createShopClient()),
      config: ctx.config,
    },
  );
  if (!veredito.ok) {
    aviso('');
    if (json) {
      log(
        JSON.stringify(
          {
            modo: live ? 'live' : 'dry-run',
            integracaoId,
            recusa: resumoDaRecusaDaConta(veredito),
          },
          null,
          2,
        ),
      );
    } else {
      for (const linha of descreverRecusaDaConta(veredito)) log(linha);
    }
    return;
  }
  const contexto = veredito.contexto;
  aviso(
    `  região .......... ${contexto.regiao} (${contexto.moeda}, razão ${String(contexto.multiplo)}×)`,
  );
  aviso('');

  /* --------------------------------- dry-run -------------------------------- */

  if (!live) {
    const { produtoCollection } = await import('@delfrance/data/admin/collections');
    const { lerFamiliasDePrecoPorIds } = await import('../lib/shopee/precos/descobertaPreco');
    const { criarLeitorDeBaseEmLote } = await import('../lib/shopee/precos/leitorDeBase');
    const { lerItemParaPreco } = await import('../lib/shopee/precos/leituraPreco');

    const ensaio = await ensaiarEnvioDePreco({ integracaoId, produtoIds, baixarPreco }, contexto, {
      lerProdutos: async (ids, campos) => {
        const snaps = await db.getAll(...ids.map((id) => produtoCollection.docRef(db, {}, id)), {
          fieldMask: [...campos],
        });
        const lidos = new Map<string, Readonly<Record<string, unknown>> | undefined>();
        for (const snap of snaps) {
          if (snap.exists) lidos.set(snap.id, snap.data() as Record<string, unknown> | undefined);
        }
        return lidos;
      },
      lerFamilias: (anchorIds) => lerFamiliasDePrecoPorIds(db, { anchorIds }),
      criarLeitorDeItens: (itemIds) => {
        // ONE batched base reader for the whole rehearsal, as the live run builds.
        const lerBase = criarLeitorDeBaseEmLote(contexto.client, itemIds);
        return (itemId) => lerItemParaPreco(contexto.client, itemId, lerBase);
      },
    });

    if (json) {
      log(
        JSON.stringify({ modo: 'dry-run', integracaoId, ensaio: resumoDoEnsaio(ensaio) }, null, 2),
      );
      return;
    }
    log('== DRY-RUN — nada foi enviado e nenhum vínculo foi gravado ==');
    log('');
    for (const linha of renderizarEnsaio(ensaio)) log(linha);
    return;
  }

  /* ---------------------------------- live ---------------------------------- */

  const { enviarPrecoManualShopee } = await import('../lib/shopee/precos/enviarPrecoManual');

  const resposta = await enviarPrecoManualShopee(
    db,
    { integracaoId, produtoIds, baixarPreco },
    {
      nowMs,
      agora: () => Date.now(),
      esperar: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      contexto,
      contaNome: typeof ctx.conta.nome === 'string' ? ctx.conta.nome : null,
    },
  );

  if (json) {
    log(
      JSON.stringify(
        { modo: 'live', integracaoId, resultado: resumoDoEnvioPreco(resposta) },
        null,
        2,
      ),
    );
    return;
  }
  log('== LIVE — o envio de preço de verdade ==');
  log('');
  for (const linha of renderizarResultadoEnvioPreco(resposta)) log(linha);
}

await main().catch((err: unknown) => {
  // Narrow enough to be useful and never wide enough to print a payload — the
  // whole table is `descreverErroEnvioPreco`, which is unit-tested.
  for (const linha of descreverErroEnvioPreco(err)) aviso(linha);
  // ONE predicate, shared with the describer: a failure raised before any write
  // must not be followed by "nothing guarantees nothing was written".
  if (!ehRecusaAntesDoEnvioDePreco(err)) {
    aviso('');
    aviso(
      'Nada garante que nada foi escrito: um erro DEPOIS de um update_price deixa o preço no lugar.',
    );
    aviso('Releia com --dry-run (ele não envia preço) antes de repetir com --live.');
  }
  process.exitCode = 1;
});
