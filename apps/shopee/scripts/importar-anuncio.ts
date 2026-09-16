/**
 * Import ONE Shopee listing into the ERP catalogue from the command line — the
 * step-9 rehearsal (#1517).
 *
 *   pnpm --filter @delfrance/shopee-app importar:anuncio \
 *     --integracao int-1 --item 2500139861
 *
 * ## Why this exists
 *
 * `importarAnuncioShopee` otherwise reaches Firestore only through the
 * mass-import job — a Cloud Tasks drain that walks a whole catalogue. So the
 * first produto this channel ever writes would happen unattended, in bulk,
 * against whatever the scan returned. This script makes that first write a
 * deliberate, observable act against ONE named listing — one human, one
 * terminal — before the migration window (root CLAUDE.md rule 8).
 *
 * ⚠️ **Dev-only, and never run by an agent.** In `--live` it writes real
 * documents: a `produtos` (plus one per variation), `grupoDeVariacoes`,
 * `categorias`, `prodshopee` + `variashopee` links, `estoque` rows and
 * `arquivos` for every picture.
 *
 * ## The two modes
 *
 * **`--dry-run` (the DEFAULT)** reads the listing (`get_item_base_info`, then
 * `get_model_list` OR `get_kit_item_info`), resolves the cascade and PLANS —
 * then prints the plan. It writes nothing, and that is structural rather than a
 * promise: it calls `prepararImportacaoShopee` (or, for a kit,
 * `prepararImportacaoKitShopee`), whose bodies contain no writer at all.
 *
 * **`--live`** calls `importarAnuncioShopee` / `importarKitShopee` exactly as
 * the route and the job do — same deps, same two memos, same single clock read —
 * and then reads the produto back.
 *
 * ⚠️ **Both modes reach Shopee.** A dry run is not offline; it spends the same
 * calls and, in the sandbox, is subject to the same rate limits.
 *
 * ## What it prints, and what it must never print
 *
 * Everything is rendered through
 * `lib/shopee/produtos/importarAnuncioCli.ts`, whose summaries are an
 * ALLOW-LIST: the listing's description has no field to travel in (only a
 * character count), `tax_info` appears as its KEYS and never its values, and the
 * pictures appear as counts and never as URLs. The listing TITLE is printed, on
 * purpose — it is the produto's name and the one thing this rehearsal exists to
 * show. A terminal transcript gets pasted into issues; the SVC-AN incident (a
 * `xMotivo` log that leaked a CNPJ into a public log) is the local precedent.
 *
 * ⚠️ It holds no Shopee id, key, token or shop id — the usage text names `int-1`
 * and a documentation `item_id`, and the shop id comes from the integração
 * document at runtime.
 *
 * ## Exit codes
 *
 * `0` on ANY plan, **including a blocked one**: `kit-componente-nao-vinculado`
 * on a first catalogue pass, `item-deletado`, `sem-nome` and
 * `item-nao-encontrado` are ANSWERS, not failures, and a blocked kit still
 * prints its component table so the operator can see which component is
 * missing. `1` only on a throw, described by CLASS plus Shopee's `code`/`path`
 * and never a payload.
 */
import {
  ArgumentoInvalidoError,
  USO_IMPORTAR_ANUNCIO,
  descreverBloqueio,
  descreverErroImportacao,
  parseArgsImportarAnuncio,
  renderComponentesKit,
  renderProdutoArmazenado,
  resumirPlano,
  resumirResultado,
  resumirPlanoJson,
  resumoDoProdutoArmazenado,
  resumoDosComponentesKit,
} from '../lib/shopee/produtos/importarAnuncioCli';

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
  const comando = parseArgsImportarAnuncio(process.argv.slice(2));
  if (comando.kind === 'ajuda') {
    log(USO_IMPORTAR_ANUNCIO);
    return;
  }
  const { integracaoId, itemId, live, json, projectId } = comando.args;

  // ⚠️ The dynamic imports are what make "`--help` touches no environment and no
  // Firestore" STRUCTURAL instead of a claim: nothing below this line has been
  // loaded yet, so no module-level env read, admin singleton or client
  // construction can run on the help path. They also keep `--project` effective
  // — the admin app resolves its project id once, at first use.
  if (projectId != null) process.env.FIREBASE_PROJECT_ID = projectId;

  const { getAdminApp, getAdminFirestore, tryGetAdminBucket } =
    await import('../lib/firebase/admin');
  const { loadShopeeContext } = await import('../lib/shopee/core/shopee');
  const { ShopeeImportBlockedError } = await import('../lib/shopee/produtos/errosImportacao');
  const { ehKitDe } = await import('../lib/shopee/produtos/itemLido');
  const { lerAnuncioShopee } = await import('../lib/shopee/produtos/lerAnuncio');
  const { importarAnuncioShopee, prepararImportacaoShopee } =
    await import('../lib/shopee/produtos/importarAnuncio');
  const { importarKitShopee, prepararImportacaoKitShopee, resolverComponentesDoKit } =
    await import('../lib/shopee/produtos/kitShopee');
  const { criarMemoDeCategorias } = await import('../lib/shopee/produtos/categoriaShopee');
  const { criarMemoDeGrupos } = await import('../lib/shopee/produtos/taxonomiaShopee');
  const { produtoCollection } = await import('@delfrance/data/admin/collections');
  const { importacaoShopeeOptionsSchema } = await import('@delfrance/schemas');

  /* ------------------------------ the preamble ----------------------------- */

  aviso(
    live
      ? '[shopee/importar:anuncio] modo: LIVE — VAI GRAVAR'
      : '[shopee/importar:anuncio] modo: DRY-RUN — não grava nada',
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
  aviso(`  item_id ......... ${String(itemId)}`);

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
  aviso(
    `  tabela promo .... ${ctx.conta.tabelaPromocionalOuterRef ?? '(nenhuma)'}   (NUNCA escrita — #803)`,
  );
  aviso(`  depósito ........ ${ctx.conta.depositoOuterRef ?? '(nenhum — sem estoque)'}`);
  aviso('');

  // ⚠️ ONE clock read for the whole run, handed DOWN on the deps — exactly as
  // the route and the job do. Every module under `produtos/` takes the instant
  // as a parameter, so two documents written by one import can never disagree
  // about when it happened.
  const nowMs = Date.now();
  const options = importacaoShopeeOptionsSchema.parse({});

  const client = ctx.createShopClient();
  const entrada = await lerAnuncioShopee(client, itemId);
  const ehKit = ehKitDe(entrada.base);

  // An unresolvable bucket NAME degrades to "skip photos", never to a failed
  // import — `tryGetAdminBucket` is a null-return, so a genuine Storage failure
  // still propagates.
  const bucket = tryGetAdminBucket();
  // ⚠️ THE TWO MEMOS, both explicit — the same assembly the route performs. The
  // importer's deps carry no Shopee client, so the category tree is the one wire
  // read it still needs, and an ABSENT `categorias` is not an error: the
  // categoria leg is silently SKIPPED with one log line, which is exactly what
  // makes a silently uncategorised produto look like a correct import.
  const deps = {
    db,
    integracaoId: ctx.integracaoId,
    tabelaNormalOuterRef: ctx.conta.tabelaNormalOuterRef,
    tabelaPromocionalOuterRef: ctx.conta.tabelaPromocionalOuterRef,
    depositoOuterRef: ctx.conta.depositoOuterRef,
    ...(bucket !== null ? { bucket } : {}),
    options,
    nowMs,
    grupos: criarMemoDeGrupos(db),
    categorias: criarMemoDeCategorias(client, ctx.integracaoId),
  };

  /* --------------------------------- dry-run -------------------------------- */

  if (!live) {
    try {
      if (ehKit) {
        const preparo = await prepararImportacaoKitShopee(deps, entrada);
        if (json) {
          log(
            JSON.stringify(
              {
                modo: 'dry-run',
                integracaoId,
                itemId,
                ehKit,
                resumo: resumirPlanoJson(preparo.plano, preparo.anuncio, preparo.componentes),
              },
              null,
              2,
            ),
          );
          return;
        }
        log('== DRY-RUN — nada foi gravado (KIT) ==');
        log('');
        for (const linha of resumirPlano(preparo.plano, preparo.anuncio, preparo.componentes)) {
          log(linha);
        }
        return;
      }

      const plano = await prepararImportacaoShopee(deps, entrada);
      if (json) {
        log(
          JSON.stringify(
            {
              modo: 'dry-run',
              integracaoId,
              itemId,
              ehKit,
              resumo: resumirPlanoJson(plano, entrada),
            },
            null,
            2,
          ),
        );
        return;
      }
      log('== DRY-RUN — nada foi gravado ==');
      log('');
      for (const linha of resumirPlano(plano, entrada)) log(linha);
      return;
    } catch (err) {
      if (!(err instanceof ShopeeImportBlockedError)) throw err;
      // ⚠️ A refusal is an ANSWER: exit 0. For a KIT it is usually
      // `kit-componente-nao-vinculado`, and the component table is the whole
      // point of printing it — `resolverComponentesDoKit` reads only and never
      // throws, so the table of a refused kit is still printable.
      const componentes =
        ehKit && entrada.kit !== null
          ? await resolverComponentesDoKit(db, ctx.integracaoId, entrada.kit)
          : [];
      const tabela = resumoDosComponentesKit(componentes);
      if (json) {
        log(
          JSON.stringify(
            {
              modo: 'dry-run',
              integracaoId,
              itemId,
              ehKit,
              bloqueado: { motivo: err.motivo, mensagem: err.mensagem, itemId: err.itemId },
              componentes: tabela,
            },
            null,
            2,
          ),
        );
        return;
      }
      log('== DRY-RUN — o importador RECUSA este anúncio ==');
      log('');
      for (const linha of descreverBloqueio(err)) log(linha);
      if (tabela.length > 0) {
        log('');
        log('### kit — componentes');
        for (const linha of renderComponentesKit(tabela)) log(linha);
      }
      return;
    }
  }

  /* ---------------------------------- live ---------------------------------- */

  const res = ehKit
    ? await importarKitShopee(deps, entrada)
    : await importarAnuncioShopee(deps, entrada);

  const snap = await produtoCollection.docRef(db, {}, res.produtoId).get();
  const armazenado = resumoDoProdutoArmazenado(
    res.produtoId,
    snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : null,
  );

  if (json) {
    log(
      JSON.stringify(
        {
          modo: 'live',
          integracaoId,
          itemId,
          ehKit,
          // Built by NAME: the result type is ours, and echoing it whole is how a
          // field added for the job's bookkeeping starts leaving through a
          // surface nobody reviewed.
          resultado: {
            produtoId: res.produtoId,
            criado: res.criado,
            nome: res.nome,
            variacoes: res.variacoes,
            fotos: res.fotos,
            ...(res.kit !== undefined ? { kit: res.kit } : {}),
          },
          produto: armazenado,
        },
        null,
        2,
      ),
    );
    return;
  }

  log('== LIVE — o importador de verdade ==');
  log('');
  for (const linha of resumirResultado(res)) log(linha);
  log('');
  for (const linha of renderProdutoArmazenado(armazenado)) log(linha);
}

await main().catch((err: unknown) => {
  // Narrow enough to be useful and never wide enough to print a payload — the
  // whole table is `descreverErroImportacao`, which is unit-tested.
  for (const linha of descreverErroImportacao(err)) aviso(linha);
  if (!(err instanceof ArgumentoInvalidoError)) {
    aviso('');
    aviso(
      'Nada garante que nada foi gravado: um erro DEPOIS de uma escrita deixa o documento no lugar.',
    );
    aviso('Releia com --dry-run (ele não grava) antes de repetir com --live.');
  }
  process.exitCode = 1;
});
