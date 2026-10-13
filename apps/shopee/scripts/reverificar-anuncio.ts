/**
 * Re-verify ONE Shopee listing from the command line — how the ERP learns that a
 * listing was deleted in Seller Centre (#1527, step 19).
 *
 *   pnpm --filter @delfrance/shopee-app reverificar:anuncio \
 *     --integracao int-1 --produto prod-1 --link link-antigo
 *
 * ## Why this exists
 *
 * No Shopee push reports a SELLER delete, and the stock and price senders never
 * write `estadoAnuncio`. After a "converter em kit nativo" (L8) the old ordinary
 * listing keeps selling, and keeps receiving stock and price, until Lucas deletes
 * it in Seller Centre — and the ERP only learns of that deletion when somebody
 * re-verifies the listing. Step 21's screen will have a button; until then, this
 * is it.
 *
 * ⚠️ **Dev-only, and never run by an agent.** It reads Shopee and WRITES the
 * reading — the link's status fields, the model marks of THIS listing, and (on a
 * native kit read `removido`) the kit's recipe aviso — against the project the
 * environment points at.
 *
 * ## One mode
 *
 * It calls `reverificarAnuncioShopee` exactly as the `reverificar-anuncio` route
 * does — same body shape, same single clock read, same increment — and prints
 * what it reported. There is no dry run: the command never sends anything TO
 * Shopee, and what it writes is the reading itself (see
 * `lib/shopee/anuncios/reverificarAnuncioCli.ts`, which refuses `--dry-run` and
 * `--live` with a sentence).
 *
 * ## What it prints
 *
 * Everything goes through `reverificarAnuncioCli.ts`, whose summary is an
 * ALLOW-LIST built by name: ids, slugs, counts and booleans — the violation rows
 * appear as a COUNT, never their provider prose. The re-verify's own completion
 * line (`console.info`) is rerouted to STDERR, so under `--json` the stdout stays
 * one parseable document.
 *
 * ## Exit codes
 *
 * `0` on any reading, `removido` included. `1` when the produto has no link on
 * this conta, when the link was never published, on a bad command line, and on a
 * throw — described by CLASS plus Shopee's `code`/`path`, never a payload.
 */
import {
  USO_REVERIFICAR_ANUNCIO,
  codigoDeSaida,
  descreverErroReverificacao,
  lerArgsReverificar,
  renderizarReverificacao,
  resumoDaReverificacao,
} from '../lib/shopee/anuncios/reverificarAnuncioCli';

/** stdout — the report, and nothing else. */
function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

/** stderr — the preamble, the warnings and every library line. */
function aviso(message: string): void {
  console.error(message);
}

async function main(): Promise<void> {
  const comando = lerArgsReverificar(process.argv.slice(2));
  if (comando.kind === 'ajuda') {
    log(USO_REVERIFICAR_ANUNCIO);
    return;
  }
  const { integracaoId, produtoId, linkDocId, json, projectId } = comando.args;

  // Every library line to STDERR — the re-verify's completion line included.
  // eslint-disable-next-line no-console -- rerouting, not printing
  console.info = console.error;
  // eslint-disable-next-line no-console -- rerouting, not printing
  console.log = console.error;

  // ⚠️ The dynamic imports keep `--help` free of the environment and of
  // Firestore, and keep `--project` effective — the admin app resolves its
  // project id once, at first use.
  if (projectId != null) process.env.FIREBASE_PROJECT_ID = projectId;

  const { getAdminApp, getAdminFirestore } = await import('../lib/firebase/admin');
  const { FieldValue } = await import('firebase-admin/firestore');
  const { loadShopeeContext } = await import('../lib/shopee/core/shopee');
  const { reverificarAnuncioShopee } = await import('../lib/shopee/anuncios/reverificarAnuncio');

  /* ------------------------------ the preamble ----------------------------- */

  aviso('[shopee/reverificar:anuncio] LÊ a Shopee e GRAVA a leitura — nada é enviado à Shopee');
  // `getAdminApp()` resolves credentials and the project id locally; it opens no
  // connection.
  const app = getAdminApp();
  aviso(`  projeto ......... ${app.options.projectId ?? '(não resolvido)'}`);
  aviso(`  database ........ ${process.env.FIREBASE_DATABASE_ID ?? 'default'}`);
  // ⚠️ The RAW value: only exactly `1` is the sandbox; `''`, `true` and `0` are
  // PRODUCTION.
  const sandboxBruto = process.env.SHOPEE_SANDBOX;
  aviso(
    `  SHOPEE_SANDBOX .. ${sandboxBruto == null ? '(não definido)' : sandboxBruto.length === 0 ? '(vazio)' : sandboxBruto}`,
  );
  aviso(`  integracao ...... ${integracaoId}`);
  aviso(`  produto ......... ${produtoId}`);
  aviso(`  vínculo ......... ${linkDocId ?? '(o anúncio vivo desta conta)'}`);

  const db = getAdminFirestore();

  // The same seam the route reaches, loaded HERE for its guards: a missing conta,
  // a conta that is not Shopee, or a missing partner id/key fails before Shopee.
  const ctx = await loadShopeeContext(db, integracaoId);
  aviso(`  ambiente Shopee . ${ctx.config.sandbox ? 'SANDBOX' : 'PRODUÇÃO'}`);
  aviso(
    `  loja (shop_id) .. ${ctx.conta.shop_id == null ? '(nenhuma)' : String(ctx.conta.shop_id)}`,
  );
  aviso('');
  if (ctx.conta.shop_id == null) {
    aviso(
      '❌ A conta está conectada por CONTA PRINCIPAL e não tem shop_id, então nenhuma ' +
        'chamada pode ser assinada. Reconecte escolhendo a loja.',
    );
    process.exitCode = 1;
    return;
  }

  // ⚠️ ONE clock read for the whole run, handed DOWN — exactly as the route does.
  const nowMs = Date.now();

  const res = await reverificarAnuncioShopee(
    db,
    { integracaoId, produtoId, linkDocId },
    {
      clientFor: () => Promise.resolve(ctx.createShopClient()),
      increment: (by: number) => FieldValue.increment(by),
      nowMs,
    },
  );

  if (res === null) {
    aviso(
      `❌ Nenhum anúncio desta conta para o produto ${produtoId}` +
        (linkDocId === null ? '.' : ` sob o vínculo ${linkDocId}.`) +
        ' Nada foi lido na Shopee.',
    );
    process.exitCode = codigoDeSaida(res);
    return;
  }

  if (json) {
    log(JSON.stringify({ integracaoId, resumo: resumoDaReverificacao(res) }, null, 2));
  } else {
    log('== REVERIFICAÇÃO — o que a Shopee respondeu agora ==');
    log('');
    for (const linha of renderizarReverificacao(res)) log(linha);
  }
  if (codigoDeSaida(res) !== 0) {
    aviso('');
    aviso(`❌ O vínculo ${res.linkDocId} nunca foi publicado na Shopee — nada a reverificar.`);
    process.exitCode = 1;
  }
}

await main().catch((err: unknown) => {
  // By CLASS plus Shopee's code/path — the whole table is unit-tested.
  for (const linha of descreverErroReverificacao(err)) aviso(linha);
  process.exitCode = 1;
});
