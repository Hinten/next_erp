/**
 * The testable half of `scripts/importar-devolucao.ts` (#1525, step 17) — the
 * argument parser and the usage text.
 *
 * ⚠️ **It lives here rather than in the script because `scripts/` is outside
 * this app's vitest `include`** (`{app,lib,functions}/**\/*.test.ts`), so logic
 * written in a script file can never be tested — the `importarPedidoCli.ts` /
 * `etiquetaCli.ts` shape. The parser is where the CLI's two refusals live —
 * `--live` (the import has ONE writer, reconcile R-19) and a `return_sn` outside
 * the shared predicate — and both used to sit untested in the script.
 *
 * ⚠️ **Script-only, imported by no route, no sweep and no bundle.** Nothing here
 * reads the environment, a clock or Firestore, and nothing here calls Shopee.
 * The transcript's token rule is not here either: it is `tokenParaLog.ts`, the
 * ONE rule the importer's log line, the push diary and the script all read.
 */
import { ehReturnSnShopee } from '@delfrance/schemas';

import { ArgumentoInvalidoError } from '../pedidos/importarPedidoCli';

/** The malformed-command-line class — one class for every CLI of this app. */
export { ArgumentoInvalidoError };

/**
 * ⚠️ No `--` separator in any documented invocation: pnpm forwards the literal
 * token INTO the script, which parses `process.argv` itself.
 * `packages/config-eslint/rules/pnpm-run-args.test.js` fails CI on the spelling
 * that carries one — including inside this string.
 */
export const USO_IMPORTAR_DEVOLUCAO = `
Ensaia a importação de UMA devolução da Shopee (step 17) — SÓ dry-run.

  pnpm --filter @delfrance/shopee-app importar:devolucao \\
    --integracao <integracaoId> --return-sn <returnSn> [opções]

Obrigatórios
  --integracao <id>   documento da integração Shopee (ex.: int-1)
  --return-sn <sn>    a devolução da Shopee, alfanumérica (ex.: 2609100000000001)

Opções
  --order-sn <sn>     a order que a entrega diria; sem ela, vale a do detalhe
  --dry-run           o ÚNICO modo, e redundante
  --project <id>      sobrescreve FIREBASE_PROJECT_ID antes de abrir o admin
  --json              imprime o mesmo resumo redigido em JSON no stdout
                      (o cabeçalho vai para o stderr)
  --help, -h          mostra esta ajuda e sai com 0, sem abrir o Firestore
                      nem chamar a Shopee

Não existe --live: a importação tem UM escritor, o braço do code 29. O ensaio
CHAMA a Shopee (um get_return_detail) e lê o Firestore — não grava nada nem
enfileira nada. Ver apps/shopee/scripts/README.md §17.
`.trim();

export interface ArgsImportarDevolucao {
  readonly integracaoId: string;
  readonly returnSn: string;
  /** `null` ⇒ the detail's own `order_sn` names the pedido. */
  readonly orderSn: string | null;
  readonly json: boolean;
  /** `null` keeps whatever the environment resolves. */
  readonly projectId: string | null;
}

export type ComandoImportarDevolucao =
  | { readonly kind: 'ajuda' }
  | { readonly kind: 'ensaiar'; readonly args: ArgsImportarDevolucao };

/** Why `--live` is refused — named, so the operator learns there is no write. */
export const MSG_LIVE_NAO_EXISTE =
  '--live não existe neste CLI: a importação de devolução tem UM escritor, o braço do ' +
  'code 29 (push, varredura de 6 h ou a ação do vendedor). Este ensaio só lê.';

/** The `return_sn` refusal — it names the flag and the shape, never the value. */
export const MSG_RETURN_SN_FORA_DO_FORMATO = '--return-sn fora do formato [A-Za-z0-9]{1,64}.';

/**
 * A flag's value, inline (`--flag=value`) or the next argument. Trimmed — a
 * shell argument, not a wire value — and refused when empty or when it is the
 * NEXT flag, so a value-less flag can never swallow its neighbour.
 */
function valorDe(nome: string, inline: string | undefined, proximo: string | undefined): string {
  const bruto = (inline ?? proximo)?.trim();
  if (bruto == null || bruto.length === 0 || bruto.startsWith('--')) {
    throw new ArgumentoInvalidoError(`--${nome} exige um valor.`);
  }
  return bruto;
}

/**
 * Parse the command line. Pure — no environment, no clock.
 *
 * The `importar:pedido` parser's shape: `--help` first (so it answers even
 * beside a bad flag), the `--` separator refused, `--flag=value` accepted, an
 * unknown flag refused.
 *
 * ⚠️ `--live` is REFUSED with a reason ({@link MSG_LIVE_NAO_EXISTE}) rather than
 * reported as unknown — an operator who types it expects a write, and must
 * learn there is none.
 *
 * ⚠️ The `return_sn` goes through `ehReturnSnShopee` — the ONE shape predicate
 * (`packages/schemas/src/devolucaoShopee.ts`) the routes, the push parser and
 * the web read — BEFORE anything is opened, and is then carried VERBATIM:
 * an alphanumeric one is not a digits-only one with noise.
 *
 * @throws ArgumentoInvalidoError on any malformed command line.
 */
export function parseArgs(argv: readonly string[]): ComandoImportarDevolucao {
  if (argv.some((a) => a === '--help' || a === '-h')) return { kind: 'ajuda' };

  let integracaoId: string | undefined;
  let returnSn: string | undefined;
  let orderSn: string | undefined;
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
        integracaoId = valorDe('integracao', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--return-sn':
        returnSn = valorDe('return-sn', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--order-sn':
        orderSn = valorDe('order-sn', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--project':
        projectId = valorDe('project', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--dry-run':
        break;
      case '--json':
        json = true;
        break;
      case '--live':
        throw new ArgumentoInvalidoError(MSG_LIVE_NAO_EXISTE);
      default:
        throw new ArgumentoInvalidoError(`Opção desconhecida: ${arg}`);
    }
  }

  if (integracaoId == null) {
    throw new ArgumentoInvalidoError('--integracao <integracaoId> é obrigatório.');
  }
  if (returnSn == null) throw new ArgumentoInvalidoError('--return-sn <returnSn> é obrigatório.');
  if (!ehReturnSnShopee(returnSn)) throw new ArgumentoInvalidoError(MSG_RETURN_SN_FORA_DO_FORMATO);

  return {
    kind: 'ensaiar',
    args: {
      integracaoId,
      returnSn,
      orderSn: orderSn ?? null,
      json,
      projectId: projectId ?? null,
    },
  };
}
