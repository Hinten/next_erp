/**
 * Rehearse the Shopee RETURN import (#1525, step 17) from the command line —
 * DRY-RUN ONLY.
 *
 *   pnpm --filter @delfrance/shopee-app importar:devolucao --integracao int-1 --return-sn 2609100000000001
 *
 * ## Why this exists
 *
 * The code-29 arm normally runs unattended: a `push 32` (or the 6-hourly
 * poller's synthetic code 29, or the action route's post-click refresh) →
 * Cloud Tasks → `importarDevolucaoShopee` → ONE `get_return_detail` → the
 * incidente transaction → the aviso. The SG sandbox has no Returns module
 * (`guide 644`), so the first BR return this channel ever sees would otherwise
 * be imported unobserved. This script is the instrument for the questions only
 * a BR shop answers (the master plan's settle-live register 231–247): what the
 * success envelope's `error` really is per op (231), whether `update_time` is
 * there and moves (233), the logistics token spellings (236, 240, 241) — and it
 * shows, before anything is written, the decision a live delivery WOULD take
 * on the stored incidente and the aviso it WOULD raise or resolve. The steps
 * 5/7/14 parity: every write-capable path of this channel has a rehearsal.
 *
 * ⚠️ **Dev-only, and never run by an agent** (root `CLAUDE.md` rule 8) — it
 * calls Shopee with a real conta's token.
 *
 * ## Dry run ONLY — there is no `--live` (reconcile R-19)
 *
 * The import has exactly ONE writer, the code-29 arm, and that is the point
 * (root `CLAUDE.md` rule 7: the importer is the single writer of a return's
 * incidente). A live import from a terminal would be a second door for a
 * transaction the push, the poller and the action route already drive — so
 * `--live` is REFUSED, not ignored. To apply a return for real, let the arm do
 * it: the poller re-imports every return updated in its 15-day window.
 *
 * "Writes nothing" holds by what this file CALLS, and the list is short enough
 * to audit: plain `get()`s, ONE `get_return_detail`, and pure functions — the
 * two decisions the live path runs, `preverIncidenteDevolucaoShopee`
 * (`devolucaoTx.ts`; the transaction runs the same function on its own
 * snapshot) and `preverEfeitoDoAvisoDeDevolucao` (`avisoDevolucao.ts`), plus
 * the id derivations and the code-3 builder. ⚠️ Those two modules also EXPORT
 * the writers (`salvarIncidenteDevolucaoShopee`, `aplicarAvisoDeDevolucao`):
 * this file never names them. `importarDevolucao.ts` — the module that composes
 * the pull, the transaction, the aviso and the enqueue — is never imported, and
 * no task scheduler is ever built. The ONE write it can cause is not its own:
 * like every CLI here, the token store may renew the conta's access token on
 * the way to the Shopee call.
 *
 * ⚠️ **It differs from the handler in ONE order, on purpose.** The handler reads
 * the pedido FIRST and, when it is missing, spends ZERO Shopee calls (it
 * enqueues one synthetic code 3 and defers). This rehearsal always pulls the
 * detail — that pull is the instrument — and then reports what the handler
 * would have done. `--order-sn` is optional for the same reason: without it the
 * detail's own `order_sn` names the pedido.
 *
 * ## What it prints, and what it must never print
 *
 * An ALLOW-LIST: ids (conta, shop, order_sn, return_sn, the derived pedido and
 * incidente ids, the aviso chave), Shopee's TOKENS (statuses, reasons,
 * currency) through `tokenParaLog.ts` — the returns' ONE token rule, which the
 * importer's log line and the push diary read too: anything that is not a plain
 * token prints as `<nao-token>`, never verbatim —, Shopee's error CODE through
 * `codigoSeguro` (`nfe/redacaoNfe.ts`, the app's one code gate), counts, flags,
 * stamps, and the mapped block's amounts. The
 * package's returns schemas STRIP every buyer field before the response reaches
 * this process (`user`, addresses, images, videos, `text_reason`, the reverse
 * tracking number), so there is nothing else to leak — and a transcript gets
 * pasted into issues (the SVC-AN incident is the local precedent).
 *
 * ⚠️ Logic in this file is not unit-tested: `scripts/` is outside the app's
 * vitest `include`. That is why it decides NOTHING itself — every verdict comes
 * from a tested module, the argument parser (with its `--live` and `return_sn`
 * refusals) is `lib/shopee/devolucoes/importarDevolucaoCli.ts`, and what is left
 * here is reads and rendering.
 *
 * ## Units
 *
 * It converts nothing. The ONE clock read (`Date.now()`) feeds only the day
 * stamp of the synthetic code 3 a missing pedido would trigger, through the
 * shared `carimboDoDiaUtcMs`; µs and wire seconds are RENDERED through
 * `rastrearPedidoCli.ts`'s `carimboMicros` / `carimboSegundos` (display only).
 * The µs site list in `apps/shopee/CLAUDE.md` still says eight.
 *
 * ## Exit codes
 *
 * `0` on ANY verdict — `ignorado-sem-pedido`, `ignorado-inexistente`,
 * `ignorado-outro-pedido`, `ignorado-obsoleto` and `ignorado-sem-mudanca` are
 * answers, not failures. `1` on a bad command line (prints this usage), a
 * conta with no `shop_id`, or a throw — described by CLASS plus Shopee's
 * `code`/`path`, never a payload and never Shopee's own sentence.
 */
import { ShopeeApiError } from '@delfrance/integrations-shopee';

import type { DevolucaoShopeeArmazenada } from '../lib/shopee/devolucoes/devolucaoMapping';
import {
  ArgumentoInvalidoError,
  USO_IMPORTAR_DEVOLUCAO,
  parseArgs,
} from '../lib/shopee/devolucoes/importarDevolucaoCli';
import { tokenParaLog } from '../lib/shopee/devolucoes/tokenParaLog';
import { carimboMicros, carimboSegundos } from '../lib/shopee/pedidos/rastrearPedidoCli';

/* -------------------------------------------------------------------------- */
/*                                  rendering                                  */
/* -------------------------------------------------------------------------- */

/**
 * A scalar for the transcript: a number or a boolean verbatim, a string through
 * the returns' ONE token rule (`tokenParaLog.ts` — a token verbatim, anything
 * else `<nao-token>`). Every field this script prints is a scalar, and the type
 * says so: an object cannot reach the transcript at all. ⚠️ Not for an error
 * CODE — that goes through `codigoSeguro` (`nfe/redacaoNfe.ts`).
 */
function escalar(
  v: string | number | boolean | null | undefined,
): string | number | boolean | null {
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return tokenParaLog(v);
}

function tela(v: string | number | boolean | null | undefined): string {
  const e = escalar(v);
  return e === null ? '—' : String(e);
}

/**
 * The block's scalar fields, in the interface's order — an ALLOW-LIST, so a
 * field added to the block later is not printed until someone adds it here.
 */
const CAMPOS_DO_BLOCO = [
  'status',
  'solucao',
  'motivo',
  'motivoReavaliado',
  'tipoRequisicao',
  'tipoValidacao',
  'tipoReembolso',
  'statusLogistica',
  'statusLogisticaReversa',
  'statusNegociacao',
  'statusProva',
  'statusCompensacao',
  'solucaoOfertada',
  'valorOfertado',
  'contrapropostasRestantes',
  'valorReembolso',
  'valorAntesDesconto',
  'valorCompensacao',
  'moeda',
  'vendedorProvidenciaColeta',
] as const satisfies readonly (keyof DevolucaoShopeeArmazenada)[];

const PRAZOS_DO_BLOCO = [
  'vendedorUs',
  'envioCompradorUs',
  'respostaVendedorUs',
  'provaUs',
  'compensacaoUs',
  'ofertaUs',
] as const satisfies readonly (keyof DevolucaoShopeeArmazenada['prazos'])[];

type BlocoSemRevisao = Omit<DevolucaoShopeeArmazenada, 'revisao'>;

function resumoDoBloco(bloco: BlocoSemRevisao) {
  return {
    campos: Object.fromEntries(CAMPOS_DO_BLOCO.map((c) => [c, escalar(bloco[c])])),
    prazosUs: Object.fromEntries(PRAZOS_DO_BLOCO.map((p) => [p, bloco.prazos[p]])),
    criadaEmUs: bloco.criadaEmUs,
  };
}

/** stdout — the report. */
function log(message: string): void {
  // eslint-disable-next-line no-console -- CLI output
  console.log(message);
}

/**
 * stderr — the preamble and the warnings. Under `--json` the stdout must stay a
 * single parseable document.
 */
function aviso(message: string): void {
  console.error(message);
}

/* -------------------------------------------------------------------------- */
/*                                     main                                    */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const comando = parseArgs(process.argv.slice(2));
  if (comando.kind === 'ajuda') {
    log(USO_IMPORTAR_DEVOLUCAO);
    return;
  }
  const { integracaoId, returnSn, orderSn, json, projectId } = comando.args;

  // ⚠️ The dynamic imports are what make "`--help` touches no environment and
  // no Firestore" STRUCTURAL: nothing below has been loaded on the help path.
  // They also keep `--project` effective — the admin app resolves its project
  // id once, at first use.
  if (projectId != null) process.env.FIREBASE_PROJECT_ID = projectId;

  const { getAdminApp, getAdminFirestore } = await import('../lib/firebase/admin');
  const { loadShopeeContext } = await import('../lib/shopee/core/shopee');
  const { avisoCollection, incidenteCollection, pedidoCollection } =
    await import('@delfrance/data/admin/collections');
  const { makePedidoIdShopee } = await import('../lib/shopee/pedidos/orderIds');
  const { STATUS_DEVOLUCAO_CONHECIDOS, mapearDevolucaoShopee } =
    await import('../lib/shopee/devolucoes/devolucaoMapping');
  const { preverIncidenteDevolucaoShopee } = await import('../lib/shopee/devolucoes/devolucaoTx');
  const { chaveDoAvisoDeDevolucao, preverEfeitoDoAvisoDeDevolucao } =
    await import('../lib/shopee/devolucoes/avisoDevolucao');
  const { idIncidenteDevolucaoShopee } = await import('../lib/shopee/devolucoes/idsDevolucao');
  const { MOTIVO_RECUSA_DEVOLUCAO, classificarRecusaDevolucaoShopee } =
    await import('../lib/shopee/devolucoes/recusaDevolucao');
  const { codigoSeguro } = await import('../lib/shopee/nfe/redacaoNfe');
  const { docIdOf } = await import('../lib/shopee/notificacoes/notificacao');
  const { carimboDoDiaUtcMs, notificacaoSinteticaDePedido } =
    await import('../lib/shopee/notificacoes/notificacaoSintetica');

  /* ------------------------------ the preamble ----------------------------- */

  aviso('[shopee/importar:devolucao] modo: DRY-RUN — não grava nada, não enfileira nada');
  // `getAdminApp()` resolves credentials and the project id locally; it opens
  // no connection.
  const app = getAdminApp();
  aviso(`  projeto ......... ${app.options.projectId ?? '(não resolvido)'}`);
  aviso(`  database ........ ${process.env.FIREBASE_DATABASE_ID ?? 'default'}`);
  // ⚠️ The RAW value: `shopeeSandbox()` is `=== '1'`, so `''`, `true` and `0`
  // are all PRODUCTION. The resolved verdict is the `ambiente Shopee` line.
  const sandboxBruto = process.env.SHOPEE_SANDBOX;
  aviso(
    `  SHOPEE_SANDBOX .. ${sandboxBruto == null ? '(não definido)' : sandboxBruto.length === 0 ? '(vazio)' : sandboxBruto}`,
  );
  aviso(`  integracao ...... ${integracaoId}`);
  aviso(`  return_sn ....... ${returnSn}`);
  aviso(`  order_sn ........ ${orderSn ?? '(o do detalhe)'}`);

  const db = getAdminFirestore();

  // The same seam the arm uses, for its GUARDS: a missing conta, a conta that is
  // not Shopee, or a missing partner id/key fails HERE rather than at Shopee.
  const ctx = await loadShopeeContext(db, integracaoId);
  const shopId = ctx.conta.shop_id;
  aviso(`  ambiente Shopee . ${ctx.config.sandbox ? 'SANDBOX' : 'PRODUÇÃO'}`);
  aviso(`  loja (shop_id) .. ${shopId == null ? '(nenhuma)' : String(shopId)}`);
  if (shopId == null) {
    aviso('');
    aviso(
      '❌ A conta está conectada por CONTA PRINCIPAL e não tem shop_id, então nenhuma ' +
        'chamada pode ser assinada. Reconecte escolhendo a loja.',
    );
    process.exitCode = 1;
    return;
  }
  aviso('');

  /* ------------------------------ the ONE pull ------------------------------ */

  const client = ctx.createShopClient();
  let envelope: Awaited<ReturnType<typeof client.getReturnDetail>>;
  try {
    envelope = await client.getReturnDetail({ returnSn });
  } catch (err) {
    // The handler's own outcome, through its own classifier: only "this return
    // does not exist" is an ANSWER; everything else is a failure, described by
    // class below (rule 6).
    if (
      !(err instanceof ShopeeApiError) ||
      classificarRecusaDevolucaoShopee(err) !== MOTIVO_RECUSA_DEVOLUCAO.devolucaoInexistente
    ) {
      throw err;
    }
    const resumo = {
      modo: 'dry-run',
      integracaoId,
      shopId,
      returnSn,
      acao: 'ignorado-inexistente',
      // Shopee's error CODE through the app's ONE code gate (`codigoSeguro`:
      // trimmed, a dotted code kept, seven digits refused) — the route's and the
      // importer's rule, not the token rule; never its message.
      codigoShopee: codigoSeguro(err.code),
    };
    if (json) {
      log(JSON.stringify(resumo, null, 2));
      return;
    }
    log('== DRY-RUN — nada foi gravado ==');
    log('');
    log(
      `  ação .................... ${resumo.acao} (código ${resumo.codigoShopee ?? 'não informado'})`,
    );
    log(
      '  ⚠️ A Shopee diz que esta devolução não existe nesta loja: uma entrega real ESTACIONARIA.',
    );
    return;
  }

  const detalhe = envelope.response;
  const orderSnAlvo = orderSn ?? detalhe.order_sn;
  const statusConhecido = STATUS_DEVOLUCAO_CONHECIDOS.has(detalhe.status);
  const lido = {
    // ⚠️ JSON-quoted, so `""`, `" "` and `"-"` stay three different answers —
    // the settle-live register's item 231.
    erroEnvelope: JSON.stringify(envelope.error),
    status: escalar(detalhe.status),
    statusConhecido,
    updateTimeS: detalhe.update_time,
    createTimeS: detalhe.create_time,
    orderSn: detalhe.order_sn,
    returnSn: detalhe.return_sn,
  };

  // The handler's integrity check: the detail must describe THIS delivery's
  // order and return, or nothing is written under these ids.
  if (detalhe.order_sn !== orderSnAlvo || detalhe.return_sn !== returnSn) {
    const resumo = { modo: 'dry-run', integracaoId, shopId, acao: 'ignorado-outro-pedido', lido };
    if (json) {
      log(
        JSON.stringify(
          { ...resumo, orderSnInformado: orderSnAlvo, returnSnInformado: returnSn },
          null,
          2,
        ),
      );
      return;
    }
    log('== DRY-RUN — nada foi gravado ==');
    log('');
    log(`  ação .................... ${resumo.acao}`);
    log(`  order_sn informado ...... ${orderSnAlvo} — detalhe: ${detalhe.order_sn}`);
    log(`  return_sn informado ..... ${returnSn} — detalhe: ${detalhe.return_sn}`);
    log('  ⚠️ Uma entrega real ESTACIONARIA sem gravar nada.');
    return;
  }

  /* ---------------------------- ids and the reads --------------------------- */

  const pedidoId = makePedidoIdShopee(integracaoId, orderSnAlvo);
  const incidenteId = idIncidenteDevolucaoShopee(returnSn);
  const mapeada = mapearDevolucaoShopee(detalhe);
  const pedidoExiste = (await pedidoCollection.docRef(db, {}, pedidoId).get()).exists;

  // The run's ONE clock read — only for the day stamp a missing pedido's
  // synthetic code 3 would carry (`carimboDoDiaUtcMs`, the handler's bound).
  const nowMs = Date.now();
  const code3 = pedidoExiste
    ? null
    : docIdOf(
        notificacaoSinteticaDePedido({
          shopId,
          orderSn: orderSnAlvo,
          nowMs: carimboDoDiaUtcMs(nowMs),
          origem: 'devolucao',
        }),
      );

  let decisao: {
    acao: string;
    camposQueGravaria: string[];
    incidenteExiste: boolean;
    revisaoAntes: number | null;
    revisaoDepois: number | null;
    claimStatusAntes: string | null;
    claimStatusDepois: string | null;
    relogioArmazenadoUs: number | null;
    mudouAviso: boolean;
  } | null = null;
  let avisoPrevisto: {
    /** OUR id — printed verbatim (it carries `:` segments, never a token). */
    chave: string;
    efeito: 'nenhum' | 'abrir' | 'resolver';
    /** ERP vocabulary (`PENDENCIA_RECLAMACAO` / `RESOLUCAO_AVISO_DEVOLUCAO`), verbatim. */
    pendencia: string | null;
    resolucao: string | null;
    prazoUs: number | null;
    /** Shopee's status token — masked like every other token. */
    motivo: string | number | boolean | null;
    relogioEvento: number | null;
    armazenado: {
      relogioEvento: number | null;
      resolvidoEmUs: number | null;
      ocorrencias: number;
    } | null;
  } | null = null;

  if (pedidoExiste) {
    const snap = await incidenteCollection.docRef(db, { pedidoId }, incidenteId).get();
    // RAW, exactly as the transaction reads it (`devolucaoTx.ts`).
    const raw = snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : undefined;
    const previsao = preverIncidenteDevolucaoShopee(raw, mapeada);
    const relogio = raw?.relogioProvedorUs;
    decisao = {
      acao: previsao.acao,
      camposQueGravaria: previsao.patch === null ? [] : Object.keys(previsao.patch).sort(),
      incidenteExiste: snap.exists,
      revisaoAntes: previsao.anterior?.bloco?.revisao ?? null,
      revisaoDepois: previsao.confirmado.bloco?.revisao ?? null,
      claimStatusAntes: previsao.anterior?.claimStatus ?? null,
      claimStatusDepois: previsao.confirmado.claimStatus,
      relogioArmazenadoUs: typeof relogio === 'number' ? relogio : null,
      mudouAviso: previsao.mudouAviso,
    };

    const efeito = preverEfeitoDoAvisoDeDevolucao(previsao, mapeada.relogioProvedorUs);
    const chave = chaveDoAvisoDeDevolucao(integracaoId, returnSn);
    // The stored row is DATA for the reader to compare against — this script
    // does not re-implement the event-clock guard (`escreverAviso` /
    // `resolverAviso` own it).
    const armazenado = (await avisoCollection.docRef(db, {}, chave).get()).data();
    avisoPrevisto = {
      chave,
      efeito: efeito.efeito,
      pendencia: efeito.efeito === 'abrir' ? efeito.pendencia : null,
      resolucao: efeito.efeito === 'resolver' ? efeito.resolucao : null,
      prazoUs: efeito.efeito === 'abrir' ? efeito.prazoUs : null,
      motivo: efeito.efeito === 'abrir' ? escalar(efeito.status) : null,
      relogioEvento: efeito.efeito === 'nenhum' ? null : efeito.relogioEvento,
      armazenado:
        armazenado === undefined
          ? null
          : {
              relogioEvento: armazenado.relogioEvento,
              resolvidoEmUs: armazenado.resolvidoEm,
              ocorrencias: armazenado.ocorrencias,
            },
    };
  }

  const resumo = {
    modo: 'dry-run',
    integracaoId,
    shopId,
    returnSn,
    orderSn: orderSnAlvo,
    pedidoId,
    pedidoExiste,
    incidente: `pedidos/${pedidoId}/incidentes/${incidenteId}`,
    lido,
    mapeado: {
      claimStatus: mapeada.claimStatus,
      relogioProvedorUs: mapeada.relogioProvedorUs,
      timestampUs: mapeada.timestampUs,
      bloco: resumoDoBloco(mapeada.bloco),
    },
    // Without a pedido the handler stops before the transaction: the verdict
    // is the cheap skip's, and the code 3 below is what it would enqueue.
    decisao: decisao ?? { acao: 'ignorado-sem-pedido', code3SinteticoDocId: code3 },
    aviso: avisoPrevisto,
  };

  if (json) {
    log(JSON.stringify(resumo, null, 2));
    return;
  }

  log('== DRY-RUN — nada foi gravado, nada foi enfileirado ==');
  log('');
  log('### get_return_detail');
  log(`  erro do envelope ........ ${lido.erroEnvelope}   (registro 231)`);
  log(
    `  status .................. ${tela(detalhe.status)}${statusConhecido ? '' : '   ⚠️ token DESCONHECIDO'}`,
  );
  log(`  update_time (s) ......... ${carimboSegundos(detalhe.update_time)}`);
  log(`  create_time (s) ......... ${carimboSegundos(detalhe.create_time)}`);
  log(`  order_sn ................ ${detalhe.order_sn}`);
  log('');
  log('### identidade');
  log(`  pedidoId ................ ${pedidoId}`);
  log(`  pedido existe? .......... ${pedidoExiste ? 'sim' : 'NÃO'}`);
  log(`  incidente ............... ${resumo.incidente}`);
  log('');
  log('### mapeado (devolucaoShopee)');
  log(`  claimStatus ............. ${mapeada.claimStatus}`);
  log(`  relogioProvedorUs ....... ${carimboMicros(mapeada.relogioProvedorUs)}`);
  log(`  timestamp (criação) ..... ${carimboMicros(mapeada.timestampUs)}`);
  for (const campo of CAMPOS_DO_BLOCO) {
    log(`  ${campo.padEnd(23, ' ')} ${tela(mapeada.bloco[campo])}`);
  }
  for (const prazo of PRAZOS_DO_BLOCO) {
    log(`  ${`prazos.${prazo}`.padEnd(23, ' ')} ${carimboMicros(mapeada.bloco.prazos[prazo])}`);
  }
  log('');

  if (decisao === null) {
    log('### decisão');
    log('  ação .................... ignorado-sem-pedido');
    log('  ⚠️ Sem pedido, uma entrega real ADIARIA (devolucao-adiada) e enfileiraria UM');
    log(`     code 3 sintético: ${code3 ?? '(sem id derivável)'}`);
    log('     Este ensaio não enfileirou nada.');
    return;
  }

  log('### decisão (preverIncidenteDevolucaoShopee — a mesma da transação)');
  log(`  ação .................... ${decisao.acao}`);
  log(`  incidente existe? ....... ${decisao.incidenteExiste ? 'sim' : 'não'}`);
  log(
    `  campos que gravaria ..... ${decisao.camposQueGravaria.length === 0 ? '(nenhum)' : decisao.camposQueGravaria.join(', ')}`,
  );
  log(`  revisao ................. ${tela(decisao.revisaoAntes)} → ${tela(decisao.revisaoDepois)}`);
  log(
    `  claimStatus ............. ${tela(decisao.claimStatusAntes)} → ${tela(decisao.claimStatusDepois)}`,
  );
  log(`  relógio armazenado ...... ${carimboMicros(decisao.relogioArmazenadoUs)}`);
  log(`  mudouAviso .............. ${decisao.mudouAviso ? 'sim' : 'não'}`);
  log('');
  log('### aviso (preverEfeitoDoAvisoDeDevolucao)');
  if (avisoPrevisto === null) return;
  const a = avisoPrevisto;
  log(`  chave ................... ${a.chave}`);
  log(`  efeito .................. ${a.efeito}`);
  if (a.efeito === 'abrir') {
    log(`  pendência ............... ${a.pendencia ?? '—'}`);
    log(`  prazo ................... ${carimboMicros(a.prazoUs)}`);
    log(`  motivo (status) ......... ${a.motivo === null ? '—' : String(a.motivo)}`);
  }
  if (a.efeito === 'resolver') log(`  resolução ............... ${a.resolucao ?? '—'}`);
  log(`  relogioEvento ........... ${carimboMicros(a.relogioEvento)}`);
  if (a.armazenado === null) {
    log('  linha armazenada ........ (nenhuma)');
  } else {
    log(`  armazenado: relógio ..... ${carimboMicros(a.armazenado.relogioEvento)}`);
    log(`  armazenado: resolvidoEm . ${carimboMicros(a.armazenado.resolvidoEmUs)}`);
    log(`  armazenado: ocorrências . ${String(a.armazenado.ocorrencias)}`);
  }
  log('');
  // Data for the reader, never a second copy of the guard (`escreverAviso` /
  // `resolverAviso` own it).
  log('  (compare os dois relógios: o aviso descarta um relogioEvento igual ou mais velho)');
}

await main().catch(async (err: unknown) => {
  // A bad command line is answered with THIS command's usage. Everything else
  // goes through a TESTED class table that never prints a Shopee error's
  // `message` — the package carries Shopee's own sentence into it, and a
  // returns refusal may quote the order or the return. That table is the label
  // CLI's (`etiquetaCli.ts`, pinned by `etiquetaCli.test.ts`): class, kind, the
  // code as a token, HTTP status and path, plus fixed sentences for our three
  // credential classes. Delegated, never copied (#1369) — and loaded only here,
  // so the `--help` path still loads nothing beyond the parser.
  // ⚠️ Not `importarPedidoCli.ts`'s `descreverErro`: that one prints
  // `err.message`, Shopee's sentence included.
  if (err instanceof ArgumentoInvalidoError) {
    for (const linha of [`❌ ${err.message}`, '', USO_IMPORTAR_DEVOLUCAO]) aviso(linha);
  } else {
    const { descreverErroEtiqueta } = await import('../lib/shopee/etiqueta/etiquetaCli');
    for (const linha of descreverErroEtiqueta(err)) aviso(linha);
  }
  process.exitCode = 1;
});
