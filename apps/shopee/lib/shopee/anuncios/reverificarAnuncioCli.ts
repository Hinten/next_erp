/**
 * The pure half of `scripts/reverificar-anuncio.ts` (#1527, step 19) — argument
 * parsing, the allow-list summary of ONE re-verify result, its renderer, the exit
 * code and the error describer.
 *
 * ## Why this CLI exists
 *
 * **No Shopee push reports a SELLER delete** (`pushAnuncio.ts`'s codes 16 and 27
 * are a violation and a failed schedule; nothing fires when the seller deletes a
 * listing in Seller Centre), and the stock and price senders never write
 * `estadoAnuncio`. So after a "converter em kit nativo" (L8) the OLD ordinary
 * listing stays live — and keeps receiving stock and price from steps 12/13 —
 * until Lucas deletes it by hand; and the ERP learns the deletion ONLY when
 * someone re-verifies that listing. This command is that someone, from a
 * terminal: `--link <old>` names the old listing, Shopee answers `SELLER_DELETE`,
 * the link folds to `removido`, and steps 12/13 skip it as `anuncio-removido`.
 * On a native kit the same run re-evaluates the kit's recipe aviso.
 *
 * ⚠️ **It adds no logic.** It calls `reverificarAnuncioShopee` — the very function
 * behind `POST /api/marketplace/shopee/reverificar-anuncio` — with the route's
 * own body shape (`integracaoId`, `produtoId`, `linkDocId?`), and renders what it
 * returns. With no `--link` the re-verify picks the LIVE listing
 * (`resolverLinkVivoPorProduto`: the active native kit first).
 *
 * ⚠️ **No `--dry-run` and no `--live` — and both are REFUSED, not ignored.** The
 * re-verify is a READ of Shopee (it never sends anything there); what it writes is
 * the reading itself, and a dry run of "store what Shopee says" would need a
 * second, write-free copy of the handler — exactly the drift this module refuses
 * to own. A habit flag carried over from the other CLIs gets a sentence saying so
 * instead of silently meaning something.
 *
 * ⚠️ **It lives here rather than in the script because `scripts/` is outside
 * this app's vitest `include`**, the `publicarAnuncioCli.ts` reasoning verbatim.
 * Nothing here reads `process.env`, a clock, Firestore or Shopee; the result
 * type is imported as a TYPE and erased.
 *
 * ## The summary is an ALLOW-LIST
 *
 * {@link ResumoReverificacao} is built field by field. The re-verify result
 * carries the violation ROWS, whose `violation_reason`/`suggestion` are provider
 * PROSE (on the wire-fixture redaction denylist), and a terminal transcript gets
 * pasted into issues — so the CLI prints their COUNT and nothing else. The ROUTE
 * returns the rows to an authenticated operator; this transcript is not that.
 *
 * Ver apps/shopee/scripts/README.md.
 */
import { ArgumentoInvalidoError, descreverErro } from '../pedidos/importarPedidoCli';
import { naoDocId } from './corpoPublicacao';
import type { ResultadoReverificacao } from './reverificarAnuncio';

export { ArgumentoInvalidoError };

/* -------------------------------------------------------------------------- */
/*                                  arguments                                  */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ No `--` separator in any documented invocation: pnpm forwards the literal
 * token INTO the script, which parses `process.argv` itself.
 * `packages/config-eslint/rules/pnpm-run-args.test.js` fails CI on the spelling
 * that carries one — including inside this string.
 */
export const USO_REVERIFICAR_ANUNCIO = `
Reverifica UM anúncio na Shopee e grava o que a Shopee responde AGORA — o mesmo
caminho da rota reverificar-anuncio.

  pnpm --filter @delfrance/shopee-app reverificar:anuncio \\
    --integracao <integracaoId> --produto <produtoId> [--link <linkDocId>]

Obrigatórios
  --integracao <id>   documento da integração Shopee (ex.: int-1)
  --produto <id>      o produto do ERP dono do vínculo prodshopee

Opções
  --link <docId>      o vínculo prodshopee a reverificar. Sem ele vale o anúncio
                      VIVO: o kit nativo ativo, senão um anúncio que não foi
                      removido nem substituído, senão o primeiro. Use --link
                      para confirmar que um anúncio ANTIGO (substituído) foi
                      apagado no Seller Centre: nenhum push da Shopee avisa uma
                      exclusão feita pelo vendedor.
  --project <id>      sobrescreve FIREBASE_PROJECT_ID antes de abrir o admin.
  --json              imprime o mesmo resumo redigido em JSON no stdout
                      (o cabeçalho e as linhas de log vão para o stderr).
  --help, -h          mostra esta ajuda e sai com 0, sem abrir o Firestore
                      nem chamar a Shopee.

Não há --dry-run nem --live: a reverificação só LÊ a Shopee
(get_item_base_info, get_model_list, get_item_violation_info) e nunca envia
nada para lá. O que ela grava no Firestore é a própria leitura — item_status,
estadoAnuncio, deboost, violações, as marcas de modelo ausente DESTE anúncio e,
num kit nativo lido removido, o aviso de receita do kit. Rodar de novo é
seguro: uma leitura igual não grava nada no vínculo.
Sai com 1 quando o produto não tem vínculo nesta conta, quando o vínculo nunca
foi publicado e em qualquer erro.
Ver apps/shopee/scripts/README.md.
`.trim();

export interface ArgsReverificarAnuncio {
  readonly integracaoId: string;
  readonly produtoId: string;
  /** `null` ⇒ the re-verify picks the LIVE listing (`resolverLinkVivoPorProduto`). */
  readonly linkDocId: string | null;
  readonly json: boolean;
  /** `null` keeps whatever the environment resolves. */
  readonly projectId: string | null;
}

export type ComandoReverificarAnuncio =
  | { readonly kind: 'ajuda' }
  | { readonly kind: 'reverificar'; readonly args: ArgsReverificarAnuncio };

/** `--dry-run` / `--live` arrived: this command has no modes. */
export const MSG_SEM_MODO =
  'reverificar:anuncio não tem --dry-run nem --live: ele só LÊ a Shopee e grava a leitura ' +
  '(veja --help).';

function valorDe(nome: string, inline: string | undefined, proximo: string | undefined): string {
  const bruto = (inline ?? proximo)?.trim();
  if (bruto == null || bruto.length === 0 || bruto.startsWith('--')) {
    throw new ArgumentoInvalidoError(`--${nome} exige um valor.`);
  }
  return bruto;
}

/**
 * A doc id, checked with {@link naoDocId} — `./corpoPublicacao`'s export, the
 * SAME predicate the routes read their bodies with (`publicarAnuncioCli.ts`'s
 * reason for not keeping a local copy).
 */
function docIdDe(nome: string, inline: string | undefined, proximo: string | undefined): string {
  const valor = valorDe(nome, inline, proximo);
  if (naoDocId(valor)) {
    throw new ArgumentoInvalidoError(
      `--${nome} ${valor} não é um id de documento: "/", "." e ".." endereçam outro caminho.`,
    );
  }
  return valor;
}

/**
 * Parse the command line. Pure — it reads no environment and no clock.
 *
 * ⚠️ `--help` is answered BEFORE anything is validated, so `--help` on its own
 * exits 0 instead of complaining about the two required flags.
 */
export function lerArgsReverificar(argv: readonly string[]): ComandoReverificarAnuncio {
  if (argv.some((a) => a === '--help' || a === '-h')) return { kind: 'ajuda' };

  let integracaoId: string | undefined;
  let produtoId: string | undefined;
  let linkDocId: string | undefined;
  let projectId: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--') {
      throw new ArgumentoInvalidoError(
        'Separador "--" recebido como argumento: o pnpm repassa esse token para o script. ' +
          'Remova-o e passe as flags direto (veja --help).',
      );
    }
    const igual = arg.indexOf('=');
    const nome = igual === -1 ? arg : arg.slice(0, igual);
    const inline = igual === -1 ? undefined : arg.slice(igual + 1);
    switch (nome) {
      case '--integracao':
        integracaoId = docIdDe('integracao', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--produto':
        produtoId = docIdDe('produto', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--link':
        linkDocId = docIdDe('link', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--project':
        projectId = valorDe('project', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--json':
        json = true;
        break;
      case '--dry-run':
      case '--live':
        throw new ArgumentoInvalidoError(MSG_SEM_MODO);
      default:
        throw new ArgumentoInvalidoError(`Opção desconhecida: ${arg}`);
    }
  }

  if (integracaoId == null) {
    throw new ArgumentoInvalidoError('--integracao <integracaoId> é obrigatório.');
  }
  if (produtoId == null) throw new ArgumentoInvalidoError('--produto <produtoId> é obrigatório.');

  return {
    kind: 'reverificar',
    args: {
      integracaoId,
      produtoId,
      linkDocId: linkDocId ?? null,
      json,
      projectId: projectId ?? null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                            the redacted summary                             */
/* -------------------------------------------------------------------------- */

/**
 * What the CLI prints, built BY NAME from a re-verify result. Thirteen fields —
 * a test pins the set, so a field added here has to be looked at.
 *
 * ⚠️ `violacoes` is a COUNT: the rows carry provider prose.
 */
export interface ResumoReverificacao {
  readonly acao: string;
  readonly produtoId: string;
  readonly linkDocId: string;
  readonly itemId: number | null;
  readonly estadoAnuncio: string;
  readonly itemStatus: string | null;
  readonly deboost: boolean;
  readonly violacoes: number;
  readonly violacoesLidas: boolean;
  readonly modelos: {
    readonly total: number;
    readonly atualizados: number;
    readonly ausentes: number;
  } | null;
  readonly avisoResolvido: boolean;
  readonly avisoReceitaKit: string | null;
  readonly chamadasShopee: number;
}

export function resumoDaReverificacao(res: ResultadoReverificacao): ResumoReverificacao {
  return {
    acao: res.acao,
    produtoId: res.produtoId,
    linkDocId: res.linkDocId,
    itemId: res.itemId,
    estadoAnuncio: res.estadoAnuncio,
    itemStatus: res.itemStatus,
    deboost: res.deboost,
    violacoes: res.violacoes.length,
    violacoesLidas: res.violacoesLidas,
    modelos:
      res.modelos === null
        ? null
        : {
            total: res.modelos.total,
            atualizados: res.modelos.atualizados,
            ausentes: res.modelos.ausentes,
          },
    avisoResolvido: res.avisoResolvido,
    avisoReceitaKit: res.avisoReceitaKit,
    chamadasShopee: res.chamadasShopee,
  };
}

/** The pt-BR reading of the step-19 recipe-aviso decision. */
function frasesDoAvisoDeReceita(decisao: ResultadoReverificacao['avisoReceitaKit']): string {
  switch (decisao) {
    case null:
      return '— (não se aplica: não é um kit nativo lido removido)';
    case 'nada':
      return 'nenhum kit nativo deste produto vende mais — se estava aberto, foi resolvido (sem-kit-ativo)';
    case 'resolvido':
      return 'resolvido — o kit que continua vendendo tem a receita do ERP';
    case 'aberto':
      return 'ABERTO — um kit que continua vendendo ainda tem a receita antiga';
  }
}

function simNao(valor: boolean): string {
  return valor ? 'sim' : 'não';
}

/** The human rendering. Every line comes from {@link resumoDaReverificacao}. */
export function renderizarReverificacao(res: ResultadoReverificacao): string[] {
  const r = resumoDaReverificacao(res);
  const linhas = [
    `  ação ............. ${r.acao}`,
    `  produto .......... ${r.produtoId}`,
    `  vínculo .......... ${r.linkDocId}`,
    `  item_id .......... ${r.itemId === null ? '—' : String(r.itemId)}`,
    `  estadoAnuncio .... ${r.estadoAnuncio}`,
    `  item_status ...... ${r.itemStatus ?? '— (nada foi lido)'}`,
    `  deboost .......... ${simNao(r.deboost)}`,
    `  violações ........ ${String(r.violacoes)} (lidas agora: ${simNao(r.violacoesLidas)})`,
    `  modelos .......... ${
      r.modelos === null
        ? '— (sem perna de modelos)'
        : `${String(r.modelos.total)} na Shopee · ${String(r.modelos.atualizados)} atualizados · ` +
          `${String(r.modelos.ausentes)} marcados ausentes (só os DESTE anúncio)`
    }`,
    `  aviso do anúncio . ${r.avisoResolvido ? 'resolvido agora' : 'sem mudança'}`,
    `  aviso de receita . ${frasesDoAvisoDeReceita(res.avisoReceitaKit)}`,
    `  chamadas Shopee .. ${String(r.chamadasShopee)}`,
  ];
  if (r.estadoAnuncio === 'removido') {
    linhas.push(
      '',
      'O anúncio está REMOVIDO na Shopee: os passos 12/13 deixam de enviar estoque e preço',
      'para ele (anuncio-removido). O vínculo continua guardado, para os pedidos antigos.',
    );
  }
  return linhas;
}

/* -------------------------------------------------------------------------- */
/*                              exit code + errors                             */
/* -------------------------------------------------------------------------- */

/**
 * The exit code, mirroring the route's 2xx/non-2xx line: `1` when the produto
 * has no link on this conta (the route's 404) or the link was never published
 * (the route's 409); `0` on any reading — `removido` included, which is the
 * answer this command most often exists to get.
 */
export function codigoDeSaida(res: ResultadoReverificacao | null): 0 | 1 {
  if (res === null) return 1;
  return res.acao === 'ignorado-sem-item-id' ? 1 : 0;
}

/** A throw, by CLASS plus Shopee's `code`/`path` — never a payload. */
export function descreverErroReverificacao(err: unknown): string[] {
  if (err instanceof ArgumentoInvalidoError) {
    return [`❌ ${err.message}`, '', USO_REVERIFICAR_ANUNCIO];
  }
  return descreverErro(err);
}
