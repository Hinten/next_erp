import { db } from './admin';
import { devPedidoIds } from './seed-pedidos-dev';

/**
 * NF-e generator for the pedidos seeded by `seed-pedidos-dev.ts`. Kept
 * separate from the pedido seed on purpose: open `/pedidos` after seeding
 * the pedidos (NF column shows DASH), then run this script and watch the
 * NFCell badges appear / change WITHOUT reloading the page — that proves
 * the per-row `onSnapshot` listener updates on its own.
 *
 * Each pedido gets exactly one NF-e doc at the stable id `<pedidoId>-nfe`,
 * so every run overwrites it (a `set()` on the same doc), which is what
 * fires the snapshot listener in the open page.
 *
 * Usage (from the repo root):
 *   pnpm --filter @delfrance/test-fixtures seed:nfe
 *       → one NF-e per pedido, each at a different estado (covers every
 *         NFCell branch: aprovada, rejeitada, aguardando, error, EPEC +
 *         contingência, gerado, cancelada).
 *   pnpm --filter @delfrance/test-fixtures seed:nfe --estado=a
 *       → ALL NF-es set to estado `a`. Re-run with different codes to
 *         watch every row's badge flip in unison. Valid codes:
 *         0 1 2 3 4 a p n c i e (see `estadoNFeSchema`).
 *   pnpm --filter @delfrance/test-fixtures seed:nfe --clean
 *       → delete every NF-e doc (the pedidos themselves stay).
 *
 * Requires the same env as the other fixtures: `FIREBASE_SERVICE_ACCOUNT`
 * (or `FIREBASE_SERVICE_ACCOUNT_PATH`) and `FIREBASE_PROJECT_ID`.
 */

/** Wire-format estado codes — mirrors `estadoNFeSchema` in @delfrance/schemas. */
const ESTADO_CODES = ['0', '1', '2', '3', '4', 'a', 'p', 'n', 'c', 'i', 'e'];

interface NFeSeed {
  readonly estado: string;
  readonly chave?: string | null;
  readonly xMotivo?: string | null;
  readonly error?: string | null;
  readonly tpEmis?: number;
}

/**
 * Per-pedido estado spread for the default (no `--estado`) run, index-
 * aligned with `devPedidoIds()`. Picks a representative slice of the NF-e
 * state machine so every NFCell branch renders at least once.
 */
const VARIED: NFeSeed[] = [
  { estado: 'a', chave: '3'.repeat(44) }, // aprovada — green
  { estado: 'n', xMotivo: '561 - Inscrição estadual do destinatário inválida' }, // rejeitada — red + tooltip
  { estado: '2' }, // aguardando resposta — yellow
  { estado: 'e', error: 'TLS handshake failed contacting SEFAZ-RS' }, // erro — red
  { estado: 'p', chave: '4'.repeat(44), tpEmis: 9 }, // EPEC aprovado + contingência — outline variant
  { estado: '0' }, // gerado — gray
  { estado: 'c' }, // cancelada — gray
];

/** Build the NF-e seed for the pedido at index `i`, honoring an estado override. */
function nfeFor(i: number, override: string | null): NFeSeed {
  if (!override) return VARIED[i % VARIED.length]!;
  // Uniform mode: keep the chave / xMotivo / error / tpEmis sensible for
  // the chosen estado so the cell's tooltip has something real to show.
  if (override === 'a' || override === 'p') {
    return { estado: override, chave: String((i % 9) + 1).repeat(44) };
  }
  if (override === 'n') {
    return { estado: override, xMotivo: '561 - Inscrição estadual inválida' };
  }
  if (override === 'e') {
    return { estado: override, error: 'Falha de comunicação com a SEFAZ' };
  }
  return { estado: override };
}

async function writeNFe(pedidoId: string, spec: NFeSeed): Promise<void> {
  const now = Date.now();
  await db()
    .collection('pedidos')
    .doc(pedidoId)
    .collection('nfev4')
    .doc(`${pedidoId}-nfe`)
    .set({
      numeracao: 1000,
      serie: 1,
      tpEmis: spec.tpEmis ?? 1,
      estado: spec.estado,
      chave: spec.chave ?? null,
      idLote: null,
      infNFe: null,
      xml_nfe_proc: null,
      xml_epec_proc: null,
      xml_assinado: null,
      nRec: null,
      retries: null,
      cStat: null,
      xMotivo: spec.xMotivo ?? null,
      error: spec.error ?? null,
      timestamp: now,
      ultima_modificacao: new Date(now).toISOString(),
    });
}

export async function seedDevNFe(
  estado: string | null = null,
): Promise<{ written: number; estado: string }> {
  const ids = devPedidoIds();
  for (let i = 0; i < ids.length; i += 1) {
    await writeNFe(ids[i]!, nfeFor(i, estado));
  }
  return { written: ids.length, estado: estado ?? 'varied' };
}

export async function cleanupDevNFe(): Promise<{ deleted: number }> {
  let deleted = 0;
  for (const id of devPedidoIds()) {
    const ref = db().collection('pedidos').doc(id).collection('nfev4').doc(`${id}-nfe`);
    const snap = await ref.get();
    if (snap.exists) {
      await ref.delete();
      deleted += 1;
    }
  }
  return { deleted };
}

/** Parse `--estado=<code>` from argv, validating against the wire codes. */
function parseEstadoFlag(): string | null {
  const arg = process.argv.find((a) => a.startsWith('--estado='));
  if (!arg) return null;
  const code = arg.slice('--estado='.length);
  if (!ESTADO_CODES.includes(code)) {
    throw new Error(`Invalid --estado=${code}. Valid codes: ${ESTADO_CODES.join(' ')}`);
  }
  return code;
}

const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('seed-nfe-dev.ts') ||
  process.argv[1]?.endsWith('seed-nfe-dev.js');

if (isDirectInvocation) {
  const shouldClean = process.argv.includes('--clean');
  let runner: Promise<void>;
  if (shouldClean) {
    runner = cleanupDevNFe().then(({ deleted }) => {
      // eslint-disable-next-line no-console
      console.log(`[seed-nfe-dev] removed ${deleted} NF-e doc(s)`);
    });
  } else {
    let estado: string | null;
    try {
      estado = parseEstadoFlag();
    } catch (err: unknown) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
    runner = seedDevNFe(estado).then(({ written, estado: applied }) => {
      // eslint-disable-next-line no-console
      console.log(
        `[seed-nfe-dev] wrote ${written} NF-e doc(s) (estado: ${applied}); ` +
          `the open /pedidos page should update its NF column live`,
      );
    });
  }
  runner.catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
