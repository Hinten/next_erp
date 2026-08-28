/**
 * #1348 — does `SELLER_PACKAGE_*` want the unit in the value, or not?
 *
 * Three sources disagree, and the doc contradicts ITSELF:
 *
 *  - ML's FAQ *Itens — Atributos de envio e dimensões* (updated 2026-08-14) says
 *    in one answer «As dimensões devem ser enviadas como valores numéricos **com
 *    unidades**», and four answers later «devem ser enviados como **strings
 *    numéricos puros, sem texto de unidade** no valor. Por exemplo, enviar "69" e
 *    não "69cm" ou "69 cm"».
 *  - A live ML error we captured says the opposite of the second:
 *    `item.attribute.invalid.format.seller.package.dimensions` — *"only integers
 *    are accepted for dimensions and weight, with 'cm' as the unit for dimensions
 *    and 'g' as the unit for weight"*.
 *  - Production agrees with the error message: `attrPackageDimensions` sends
 *    `"12 cm"` and publishes succeed today.
 *
 * So this cannot be settled by reading. It is settled by sending both forms and
 * looking at what ML STORED.
 *
 *     pnpm --filter @delfrance/mercado-livre-app probe:package-format -- \
 *       --project <id> --integracaoId <id> --itemId MLB000000000
 *     # ...and then, once the plan looks right, actually send them:
 *       --project <id> --integracaoId <id> --itemId MLB000000000 --executar
 *
 * ⚠️ **The read-back is the point, not the status code.** A 200 that silently
 * DROPS the attribute is the failure mode a status check alone misses — it is
 * exactly how a produto can be "published successfully" with no package on it.
 * Every variant is therefore re-read with `GET /items` and reported by what
 * survived, never by whether the `PUT` was accepted.
 *
 * ⚠️ **It never creates a listing.** `--itemId` is required and must already
 * exist: Mercado Livre has no sandbox, a test user is a real production account,
 * and there are **10 of them per real account, forever** (`LIVE-TEST.md` §0). Use
 * the app's own "Anúncio de teste" button to make one — that path already encodes
 * the title/category rules ML imposes — and point this at it. Spending a listing
 * is the operator's decision, not this script's.
 *
 * ⚠️ **It restores the original attributes on the way out**, including after a
 * failure, so the listing is left as it was found.
 *
 * `--project` is REQUIRED and never inferred — same discipline as
 * `tools/migrations` and `census-up-single.ts` — so a stray `FIREBASE_PROJECT_ID`
 * cannot point it at production by accident. It additionally REFUSES a conta that
 * is not a test account unless `--forcar` is passed.
 */
import {
  MercadoLivreError,
  MercadoLivreHttpError,
  type MlAttribute,
  type MlItem,
  type MlItemAttribute,
  attrPackageDimensions,
  createMercadoLivreApi,
} from '@delfrance/integrations-mercado-livre';

import { getAdminFirestore } from '../lib/firebase/admin';
import { isContaDeTeste } from '../lib/marketplace/conta/anuncioTeste';
import { loadMercadoLivreContext } from '../lib/marketplace/core/mercadoLivre';

/** The four ids under test. Publish derives all of them from the produto. */
const IDS_PACOTE = [
  'SELLER_PACKAGE_HEIGHT',
  'SELLER_PACKAGE_LENGTH',
  'SELLER_PACKAGE_WIDTH',
  'SELLER_PACKAGE_WEIGHT',
] as const;

/**
 * The package under test. Whole numbers on purpose — `dimensoesDoPacote`
 * guarantees whole cm and whole g upstream, so a fractional value would be
 * probing a case production cannot produce.
 *
 * The three axes are DISTINCT so the read-back cannot hide a permutation.
 */
const PACOTE = { alturaCm: 12, larguraCm: 23, profundidadeCm: 34, pesoG: 1539 } as const;

function log(message: string): void {
  // eslint-disable-next-line no-console -- CLI output
  console.log(message);
}

class ProbeArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeArgError';
  }
}

interface Args {
  projectId: string;
  integracaoId: string;
  itemId: string;
  executar: boolean;
  forcar: boolean;
}

function valueOf(name: string, inline: string | undefined, next: string | undefined): string {
  const raw = inline ?? next;
  if (raw == null || raw.startsWith('--')) throw new ProbeArgError(`--${name} exige um valor.`);
  return raw;
}

function parseArgs(argv: readonly string[]): Args {
  let projectId: string | undefined;
  let integracaoId: string | undefined;
  let itemId: string | undefined;
  let executar = false;
  let forcar = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    switch (name) {
      case 'project':
        projectId = valueOf(name, inline, argv[i + 1]);
        break;
      case 'integracaoId':
        integracaoId = valueOf(name, inline, argv[i + 1]);
        break;
      case 'itemId':
        itemId = valueOf(name, inline, argv[i + 1]);
        break;
      case 'executar':
        executar = true;
        break;
      case 'forcar':
        forcar = true;
        break;
      default:
        throw new ProbeArgError(`Opção desconhecida: --${name}`);
    }
  }

  if (!projectId?.trim()) throw new ProbeArgError('--project é obrigatório.');
  if (!integracaoId?.trim()) throw new ProbeArgError('--integracaoId é obrigatório.');
  if (!itemId?.trim()) {
    throw new ProbeArgError(
      '--itemId é obrigatório. Este probe NUNCA cria um anúncio: use o botão ' +
        '"Anúncio de teste" do app e aponte para o anúncio criado.',
    );
  }

  return {
    projectId: projectId.trim(),
    integracaoId: integracaoId.trim(),
    itemId: itemId.trim(),
    executar,
    forcar,
  };
}

/* -------------------------------- the variants ------------------------------ */

interface Variante {
  nome: string;
  /** What the variant is trying to settle, printed above its result. */
  pergunta: string;
  attributes: MlAttribute[];
  /** `sale_terms` to send alongside, when the variant is about that claim. */
  saleTerms?: Array<Record<string, unknown>>;
}

/** `"12"` — the FAQ's second answer: pure numerals, weight in whole grams. */
function pacoteNumerico(): MlAttribute[] {
  return [
    { id: 'SELLER_PACKAGE_HEIGHT', value_name: String(PACOTE.alturaCm) },
    { id: 'SELLER_PACKAGE_LENGTH', value_name: String(PACOTE.larguraCm) },
    { id: 'SELLER_PACKAGE_WIDTH', value_name: String(PACOTE.profundidadeCm) },
    { id: 'SELLER_PACKAGE_WEIGHT', value_name: String(PACOTE.pesoG) },
  ];
}

const VARIANTES: readonly Variante[] = [
  {
    nome: 'atual',
    pergunta: 'O formato que produção usa hoje ainda é aceito, e o que o ML guarda?',
    // The real factory, so the variant cannot drift from what publish sends.
    attributes: attrPackageDimensions(PACOTE),
  },
  {
    nome: 'numerico',
    pergunta: 'O ML aceita numerais puros ("12"), como diz a FAQ de 14/08/2026?',
    attributes: pacoteNumerico(),
  },
  {
    nome: 'numerico+prazo',
    pergunta:
      'A FAQ diz que MANUFACTURING_TIME ausente BLOQUEIA a publicação. ' +
      'Nunca enviamos sale_terms e publicamos assim mesmo — isto confirma ou derruba.',
    attributes: pacoteNumerico(),
    saleTerms: [{ id: 'MANUFACTURING_TIME', value_name: '1 dias' }],
  },
];

/* -------------------------------- the read-back ----------------------------- */

interface Guardado {
  id: string;
  presente: boolean;
  valueName: string | null;
  unitId: string | null;
  /** From wherever ML put the struct — see `structDaMedida` in importItem.ts. */
  struct: string | null;
}

function lerPacote(item: MlItem): Guardado[] {
  const attrs: readonly MlItemAttribute[] = item.attributes ?? [];
  return IDS_PACOTE.map((id) => {
    const a = attrs.find((x) => x.id === id);
    if (a == null) return { id, presente: false, valueName: null, unitId: null, struct: null };
    const s = a.value_struct ?? a.values?.[0]?.struct ?? null;
    return {
      id,
      presente: true,
      valueName: a.value_name ?? null,
      unitId: a.unit_id ?? null,
      struct: s == null ? null : `${String(s.number ?? '?')} ${String(s.unit ?? '')}`.trim(),
    };
  });
}

function imprimirPacote(rotulo: string, linhas: Guardado[]): void {
  log(`  ${rotulo}`);
  for (const l of linhas) {
    if (!l.presente) {
      log(`    ${l.id.padEnd(24)} ⛔ AUSENTE — o ML descartou o atributo`);
      continue;
    }
    log(
      `    ${l.id.padEnd(24)} value_name=${JSON.stringify(l.valueName)}` +
        `  unit_id=${JSON.stringify(l.unitId)}  struct=${JSON.stringify(l.struct)}`,
    );
  }
}

/* ----------------------------------- main ---------------------------------- */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  process.env.FIREBASE_PROJECT_ID = args.projectId;

  const db = getAdminFirestore();
  const ctx = await loadMercadoLivreContext(db, args.integracaoId);
  const channelCtx = await ctx.resolveChannelContext();
  const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });

  const nickname = typeof ctx.conta.nickname === 'string' ? ctx.conta.nickname : null;
  log(
    `[probe:package-format] project=${args.projectId} integracao=${args.integracaoId} ` +
      `item=${args.itemId} conta=${nickname ?? '(sem nickname)'}`,
  );

  // ⚠️ `isContaDeTeste` only WARNS in the UI (a mis-selected conta publishes for
  // real). A script that rewrites attributes on a listing must be stricter.
  if (!isContaDeTeste(nickname) && !args.forcar) {
    log('');
    log(`❌ A conta "${nickname ?? '?'}" não parece ser de teste.`);
    log('   Este probe REESCREVE os atributos de pacote do anúncio. Rode-o em um');
    log('   usuário de teste, ou passe --forcar se souber exatamente o que faz.');
    process.exitCode = 1;
    return;
  }

  const original = await api.getItem(args.itemId);
  log('');
  log(`  título: ${original.title ?? '(sem título)'}`);
  log(`  status: ${original.status ?? '?'}   categoria: ${original.category_id ?? '?'}`);
  imprimirPacote('estado ORIGINAL (será restaurado no fim):', lerPacote(original));

  // Restoring means re-sending what was there. An id ML never stored cannot be
  // "restored" to absent through this endpoint, so it is reported rather than
  // silently treated as if it round-tripped.
  const paraRestaurar: MlAttribute[] = (original.attributes ?? [])
    .filter((a): a is MlItemAttribute & { id: string } => typeof a.id === 'string')
    .filter((a) => (IDS_PACOTE as readonly string[]).includes(a.id))
    .map((a) => ({ id: a.id, value_name: a.value_name ?? null, unit_id: a.unit_id ?? null }));

  log('');
  for (const v of VARIANTES) {
    log(`── variante "${v.nome}" ─────────────────────────────────────────`);
    log(`   pergunta: ${v.pergunta}`);
    const payload: Record<string, unknown> = { attributes: v.attributes };
    if (v.saleTerms != null) payload.sale_terms = v.saleTerms;
    log(`   PUT /items/${args.itemId}  ${JSON.stringify(payload)}`);
    if (!args.executar) {
      log('   (dry-run — nada foi enviado; passe --executar)');
      log('');
      continue;
    }
    try {
      await api.updateItem(args.itemId, payload);
      log('   ✅ PUT aceito');
    } catch (err) {
      // A REFUSAL is a result, not a failure of the probe: it is half of what
      // this run exists to learn. Anything that is not an ML error still throws.
      if (!(err instanceof MercadoLivreError)) throw err;
      const detalhe =
        err instanceof MercadoLivreHttpError
          ? `ML ${String(err.status)} ${JSON.stringify(err.body)}`
          : err.message;
      log(`   ⛔ PUT recusado: ${detalhe}`);
      log('');
      continue;
    }
    // ⚠️ Never trust the 200. Re-read and report what SURVIVED.
    imprimirPacote('o que o ML guardou:', lerPacote(await api.getItem(args.itemId)));
    log('');
  }

  if (args.executar && paraRestaurar.length > 0) {
    log('── restaurando o estado original ───────────────────────────');
    await api.updateItem(args.itemId, { attributes: paraRestaurar });
    imprimirPacote('depois de restaurar:', lerPacote(await api.getItem(args.itemId)));
  } else if (args.executar) {
    log('⚠️ O anúncio não tinha nenhum SELLER_PACKAGE_* — nada a restaurar, e os');
    log('   valores da ÚLTIMA variante ficaram no anúncio. Corrija-os à mão.');
  }

  log('');
  log('Escreva o veredito em apps/mercado-livre/LIVE-TEST.md (seção #1348) e no');
  log('docblock de attrPackageDimensions — a FAQ se contradiz, então a única coisa');
  log('que resolve a questão para o próximo leitor é esta medição, com a data.');
}

await main();
