/**
 * Publish ONE ERP produto as a Shopee listing from the command line — the
 * step-11 rehearsal (#1519), and since step 19 (#1527) the way the first NATIVE
 * Shopee kits get created.
 *
 *   pnpm --filter @delfrance/shopee-app publicar:anuncio \
 *     --integracao int-1 --produto prod-1
 *
 * ## Why this exists
 *
 * The publish otherwise reaches Shopee only through the `publicar` route, i.e.
 * through a screen step 21 has not shipped. So the FIRST listing this channel
 * ever creates would happen through a UI nobody has used, against a produto
 * nobody inspected. This script makes that first write a deliberate, observable
 * act against ONE named produto — one human, one terminal — before the migration
 * window (root CLAUDE.md rule 8).
 *
 * ⚠️ **Dev-only, and never run by an agent.** In `--live` it creates a REAL
 * listing on the REAL marketplace (`add_item`, the tier/model leg, the re-list
 * dance — or, for a kit, `add_kit_item` / `update_kit_item` / the recriar's
 * `delete_item`) and writes the `prodshopee` / `variashopee` links.
 *
 * ## ONE entry point, so the dry run and `--live` address ONE listing
 *
 * Both modes go through `anuncios/publicarShopee.ts` (step 19, L10-R1): the
 * dispatcher reads the produto and the conta's links once and picks the arm —
 * step 11's item arm on a link IT chose, or a native-kit arm (criar, atualizar,
 * recriar, converter). The dry run calls `ensaiarPublicacaoShopee` and `--live`
 * calls `publicarShopee`; neither this script nor the dry run ever hands the
 * raw `--link` to a resolver of its own, because `resolverLinkPorProduto` stays
 * step 11's LEXICAL pick over every link — a removed native kit and a superseded
 * listing included — and would re-aim the publish at a listing the dispatcher
 * deliberately skipped.
 *
 * ## The two modes
 *
 * **`--dry-run` (the DEFAULT)** — the item arm reads the produto, its children,
 * its grupos and the stored link, reads `get_item_limit`, the category tree and
 * `get_channel_list`, resolves the pictures and PLANS; a kit arm reads the kit
 * produto, its children and the components, the target kit when there is one,
 * the kit bands and the channels, runs the duplicate-SKU scan on a CREATE arm
 * only (L10(4)) and PLANS. Then it prints the plan. It writes nothing to
 * Firestore and creates no listing, and that is structural rather than a
 * promise: neither read half has a writer in its body.
 *
 * ⚠️ **The pictures DO go up, in both modes** — for a kit only when the run
 * would SEND content (a create, or a republish with nothing refused).
 * `montarAnuncio` needs real `image_id`s to build a body at all — an empty list
 * is the `sem-fotos` refusal — so a dry run pays for its uploads. It pays ONCE:
 * every id lands in `arquivos.externalIds` and the next publish reuses it.
 *
 * **`--live`** calls `publicarShopee` exactly as the route does — same deps,
 * same single clock read, same `esperar`, the same `FieldValue.increment` the
 * kit's recipe aviso raises through — and prints what it reported.
 *
 * ## What it prints, and what it must never print
 *
 * Everything is rendered through `lib/shopee/anuncios/publicarAnuncioCli.ts`,
 * whose summaries are an ALLOW-LIST: the description has no field to travel in
 * (only a character count), the pictures appear as counts and never as ids or
 * URLs, and no attribute VALUE name is printed. The listing TITLE is printed, on
 * purpose — it is the produto's name and the one thing this rehearsal exists to
 * show. `tax_info` is printed with its VALUES, deliberately and unlike
 * `importar:anuncio`; the reason is argued in that module's header. A terminal
 * transcript gets pasted into issues; the SVC-AN incident (a `xMotivo` log that
 * leaked a CNPJ into a public log) is the local precedent.
 *
 * ⚠️ It holds no Shopee id, key, token or shop id — the usage text names `int-1`
 * and the shop id comes from the integração document at runtime.
 *
 * ## Exit codes
 *
 * `0` on ANY plan, **including a blocked one**: `sem-peso`, `sem-fotos` and
 * `atributo-obrigatorio` are ANSWERS, not failures, and the whole point of the
 * dry run is to read them. `1` only on a throw, described by CLASS plus
 * Shopee's `code`/`path` and never a payload.
 * ⚠️ In `--live` the same refusal is NOT caught: it takes the error path and
 * exits 1 like any other throw, exactly as `importar-anuncio.ts` does.
 * ⚠️ The dispatcher's refusals (`produto-e-filho`, `vinculos-ambiguos`,
 * `vinculo-substituido`, the converter's, `opcao-de-kit-em-anuncio-comum`, …)
 * and a kit CREATE arm's phase-A refusal (`kit-sem-sku`, `sem-peso`, …) exit 1
 * in BOTH modes, and it is not an inconsistency: they are thrown before a plan
 * exists, so there is no plan to print. Every refusal that survives into a plan
 * is printed and answers 0.
 * ⚠️ A kit `--live` whose `add_kit_item` outcome is UNCERTAIN (`incerto`, the
 * route's 202) exits 1 too: nothing was written, and the summary prints the
 * exact command to re-run once the wait it names has passed.
 */
import {
  ArgumentoInvalidoError,
  USO_PUBLICAR_ANUNCIO,
  descreverErroPublicacao,
  lerArgsPublicar,
  renderizarEnsaioDeKit,
  renderizarPlano,
  renderizarResultado,
  renderizarResultadoKit,
  resumoDaPublicacao,
  resumoDoEnsaioDeKit,
  resumoDoResultado,
  resumoDoResultadoKit,
} from '../lib/shopee/anuncios/publicarAnuncioCli';
// ⚠️ TYPE-ONLY, and structurally so: a VALUE import of the publisher would pull
// `firebase-admin/firestore` and the collection handles into the `--help` path,
// which the dynamic imports below keep free of every heavy module.
import type { KitDeps } from '../lib/shopee/kits/resultadoKit';

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

async function main(): Promise<void> {
  const comando = lerArgsPublicar(process.argv.slice(2));
  if (comando.kind === 'ajuda') {
    log(USO_PUBLICAR_ANUNCIO);
    return;
  }
  const {
    integracaoId,
    produtoId,
    linkDocId,
    categoryId,
    status,
    live,
    json,
    projectId,
    principal,
    recriar,
    converterEmKit,
  } = comando.args;

  // ⚠️ The dynamic imports are what make "`--help` touches no environment and no
  // Firestore" STRUCTURAL instead of a claim: nothing below this line has been
  // loaded yet, so no module-level env read, admin singleton or client
  // construction can run on the help path. They also keep `--project` effective
  // — the admin app resolves its project id once, at first use.
  if (projectId != null) process.env.FIREBASE_PROJECT_ID = projectId;

  const { getAdminApp, getAdminFirestore } = await import('../lib/firebase/admin');
  const { FieldValue } = await import('firebase-admin/firestore');
  const { createShopeePartnerClient } = await import('@delfrance/integrations-shopee');
  const { loadShopeeContext } = await import('../lib/shopee/core/shopee');
  const { taxonomiaCtx } = await import('../lib/shopee/taxonomia/cache');
  const { caminhoDaCategoriaDoAnuncio, criarMemoDeCategorias } =
    await import('../lib/shopee/produtos/categoriaShopee');
  const { criarResolvedorDePublicacao, planejarPublicacao, resolverFotosDaPublicacao } =
    await import('../lib/shopee/anuncios/publicarAnuncio');
  const { ensaiarPublicacaoShopee, publicarShopee } =
    await import('../lib/shopee/anuncios/publicarShopee');

  /* ------------------------------ the preamble ----------------------------- */

  aviso(
    live
      ? '[shopee/publicar:anuncio] modo: LIVE — VAI CRIAR/ATUALIZAR UM ANÚNCIO DE VERDADE'
      : '[shopee/publicar:anuncio] modo: DRY-RUN — não cria anúncio e não grava vínculo',
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
    `  SHOPEE_SANDBOX .. ${sandboxBruto == null ? '(não definido)' : sandboxBruto.length === 0 ? '(vazio)' : sandboxBruto}`,
  );
  aviso(`  integracao ...... ${integracaoId}`);
  aviso(`  produto ......... ${produtoId}`);
  aviso(`  vínculo ......... ${linkDocId ?? '(o ERP escolhe)'}`);
  aviso(`  categoria ....... ${categoryId == null ? '(a do vínculo)' : String(categoryId)}`);
  aviso(`  item_status ..... ${status}`);
  aviso(`  principal ....... ${principal ?? '(nenhum)'}`);
  aviso(
    `  ação de kit ..... ${recriar ? '--recriar' : converterEmKit ? '--converter-em-kit' : '(nenhuma)'}`,
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
  aviso(`  tabela normal ... ${ctx.conta.tabelaNormalOuterRef ?? '(nenhuma — sem preço)'}`);
  aviso(`  depósito ........ ${ctx.conta.depositoOuterRef ?? '(nenhum — sem estoque)'}`);
  aviso(`  operação ........ ${ctx.conta.operacaoOuterRef ?? '(nenhuma — tax_info omitido)'}`);
  aviso('');

  // ⚠️ ONE clock read for the whole run, handed DOWN on the deps — exactly as
  // the route does. Every module under `anuncios/` and `kits/` takes the instant
  // as a parameter, so two documents written by one publish can never disagree
  // about when it happened.
  const nowMs = Date.now();

  // ONE shop-signed client: `taxonomiaCtx` builds it and the publisher reuses
  // THAT one, so the taxonomy reads and the write calls cannot end up signed by
  // two different clients.
  const taxonomia = taxonomiaCtx(ctx);
  const client = taxonomia.client;

  const deps: KitDeps = {
    db,
    client,
    // C8: the PARTNER client as a factory, used for exactly one thing — binding
    // the Public-signed `upload_image`. Lazy, so a publish that refuses before
    // any picture never constructs one.
    partnerClient: () =>
      createShopeePartnerClient({
        partnerId: ctx.config.partnerId,
        partnerKey: ctx.config.partnerKey,
        hosts: ctx.config.hosts,
      }),
    integracaoId: ctx.integracaoId,
    tabelaNormalOuterRef: ctx.conta.tabelaNormalOuterRef,
    depositoOuterRef: ctx.conta.depositoOuterRef,
    operacaoOuterRef: ctx.conta.operacaoOuterRef,
    nowMs,
    // The folder's ONE wait, supplied HERE: nothing under `anuncios/` constructs
    // a timer, which is what keeps every module in it drivable without a fake
    // clock.
    esperar: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    taxonomia,
    categorias: criarMemoDeCategorias(client, ctx.integracaoId),
    // Step 19: the kit's recipe aviso (`reavaliarAvisoDeReceitaKit`) can RAISE,
    // and a raise bumps `ocorrencias` through this — the route wires the same.
    increment: (by: number) => FieldValue.increment(by),
  };
  // ⚠️ `hostEmulador` is deliberately OMITTED rather than passed as null:
  // nothing in this app writes an emulator-hosted `arquivo.url`.

  const entrada = {
    produtoId,
    linkDocId,
    categoryId,
    statusPedido: status,
    principal,
    recriar,
    converterEmKit,
  };
  // What the kit summaries re-render into every command they print, plus the
  // RESOLVED environment (the SG sandbox prices in SGD inside a BRL field).
  const opcoesKit = { integracaoId, projectId, sandbox: ctx.config.sandbox };

  /* --------------------------------- dry-run -------------------------------- */

  if (!live) {
    // ⚠️ ONE resolver for the whole run — its `arquivos.externalIds` memo has to
    // span the item pass and every tier-1 option pass.
    const resolvedor = criarResolvedorDePublicacao(deps, produtoId);
    // ⚠️ The dispatcher picks the listing — the SAME pick `--live` makes. A
    // dispatcher refusal THROWS (zero Shopee calls) and exits 1 below.
    const ensaio = await ensaiarPublicacaoShopee(deps, entrada, resolvedor);
    if (ensaio === null) {
      aviso('');
      aviso(
        `❌ Produto ${produtoId} não encontrado, ou o vínculo pedido não é desta conta. ` +
          'Nada foi lido além disso.',
      );
      process.exitCode = 1;
      return;
    }

    if (ensaio.tipo === 'kit') {
      if (json) {
        log(
          JSON.stringify(
            {
              modo: 'dry-run',
              tipo: 'kit',
              integracaoId,
              produtoId,
              resumo: resumoDoEnsaioDeKit(ensaio.ensaio, opcoesKit),
            },
            null,
            2,
          ),
        );
        return;
      }
      log(
        ensaio.ensaio.plano.problemas.length === 0
          ? '== DRY-RUN (kit nativo) — nenhum kit foi criado e nenhum vínculo foi gravado =='
          : '== DRY-RUN (kit nativo) — o publicador RECUSA este kit ==',
      );
      log('');
      for (const linha of renderizarEnsaioDeKit(ensaio.ensaio, opcoesKit)) log(linha);
      return;
    }

    const contexto = ensaio.contexto;
    // ⚠️ THIS UPLOADS. See the header: the plan cannot exist without real
    // image_ids, and the cost is paid once.
    const fotos = await resolverFotosDaPublicacao(contexto);
    const plano = planejarPublicacao(contexto, fotos);
    const categoria = await caminhoDaCategoriaDoAnuncio(
      deps.categorias,
      plano.item.criar.category_id,
    );
    const ensaioDoItem = { ...contexto, categoria };

    if (json) {
      log(
        JSON.stringify(
          {
            modo: 'dry-run',
            tipo: 'item',
            integracaoId,
            produtoId,
            resumo: resumoDaPublicacao(plano, ensaioDoItem),
          },
          null,
          2,
        ),
      );
      return;
    }
    log(
      // A refused tabela photo stops the publish exactly like a problema does.
      plano.problemas.length === 0 && plano.recusaTabelaDeMedidas === null
        ? '== DRY-RUN — nenhum anúncio foi criado e nenhum vínculo foi gravado =='
        : '== DRY-RUN — o publicador RECUSA este produto ==',
    );
    log('');
    for (const linha of renderizarPlano(plano, ensaioDoItem)) log(linha);
    return;
  }

  /* ---------------------------------- live ---------------------------------- */

  const res = await publicarShopee(deps, entrada);
  if (res === null) {
    aviso('');
    aviso(
      `❌ Produto ${produtoId} não encontrado, ou o vínculo pedido não é desta conta. ` +
        'Nada foi enviado.',
    );
    process.exitCode = 1;
    return;
  }

  if (res.tipo === 'kit') {
    // ⚠️ An uncertain create wrote NOTHING and is not done: the summary prints
    // the exact command to re-run, and the exit code says "not finished".
    if (res.resultado.desfecho === 'incerto') process.exitCode = 1;
    if (json) {
      log(
        JSON.stringify(
          {
            modo: 'live',
            tipo: 'kit',
            integracaoId,
            resultado: resumoDoResultadoKit(res.resultado, opcoesKit),
          },
          null,
          2,
        ),
      );
      return;
    }
    log('== LIVE (kit nativo) — o publicador de verdade ==');
    log('');
    for (const linha of renderizarResultadoKit(res.resultado, opcoesKit)) log(linha);
    return;
  }

  if (json) {
    log(
      JSON.stringify(
        { modo: 'live', tipo: 'item', integracaoId, resultado: resumoDoResultado(res.resultado) },
        null,
        2,
      ),
    );
    return;
  }

  log('== LIVE — o publicador de verdade ==');
  log('');
  for (const linha of renderizarResultado(res.resultado)) log(linha);
}

await main().catch((err: unknown) => {
  // Narrow enough to be useful and never wide enough to print a payload — the
  // whole table is `descreverErroPublicacao`, which is unit-tested.
  for (const linha of descreverErroPublicacao(err)) aviso(linha);
  if (!(err instanceof ArgumentoInvalidoError)) {
    aviso('');
    aviso(
      'Nada garante que nada foi criado: um erro DEPOIS do add_item (ou do add_kit_item) ' +
        'deixa o anúncio no lugar.',
    );
    aviso('Releia com --dry-run (ele não cria anúncio) antes de repetir com --live.');
  }
  process.exitCode = 1;
});
