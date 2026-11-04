import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { PRAZO_LI_MS } from '@delfrance/integrations-loja-integrada';
import { MAX_PAGINAS_CATALOGO_LI } from '@delfrance/schemas';

import { RITMO_LEITURA_LI_MS } from './core/ritmo';
import { CONCORRENCIA_REDRIVE_LI, LIMITE_REDRIVE_LI } from './notificacoes/notificacao';

/**
 * The credential routes must fit inside this backend's request ceiling.
 *
 * Each of `PUT …/credencial` and `PUT …/credencial/validade` makes exactly ONE
 * Loja Integrada call — the validating GET, bounded by `PRAZO_LI_MS.leitura` —
 * plus a handful of Firestore reads and writes, and then, after the token is
 * written, ONE re-drive of the conta's deferred notifications
 * (`redriveAposSalvarTokenLi`): a query and up to `LIMITE_REDRIVE_LI` (500)
 * single-document updates, `CONCORRENCIA_REDRIVE_LI` at a time. A request that
 * could outlive the ceiling is cut by the PLATFORM's 504, with the outcome
 * unknown and nothing in our code to say whether the token was stored. So the
 * call's budget, plus a margin for the handful of Firestore operations and a
 * cold start, plus the re-drive's write ROUNDS at a conservative per-round
 * cost, must sit below the SMALLEST `timeoutSeconds` pinned in
 * `apphosting*.yaml`, or below App Hosting's default when none is. A serial
 * re-drive (500 rounds) would not fit a 60 s pin; the bounded one does.
 *
 * ⚠️ The INVERSE of `packages/config-eslint/rules/http-client-timeout-ceiling.test.js`,
 * which needs the LARGEST ceiling (a client deadline must outlast it). Here the
 * conservative reading is the smallest pinned value: lowering `timeoutSeconds`
 * below the call must turn this red. A copy of the
 * `apps/melhor-envio/lib/freight/prazos.test.ts` reader — apps have no
 * dependency edge to each other.
 */
const TETO_APP_HOSTING_PADRAO_S = 300;
const MARGEM_MS = 30_000;
/**
 * One round of the re-drive: its query, or one batch of concurrent single-doc
 * updates. Conservative for an in-region Admin SDK RPC — a budget, not a measurement.
 */
const RODADA_FIRESTORE_MS = 250;
/** The re-drive's worst case: the query plus every write round of a full page. */
const REDRIVE_MS =
  (1 + Math.ceil(LIMITE_REDRIVE_LI / CONCORRENCIA_REDRIVE_LI)) * RODADA_FIRESTORE_MS;
const APP_DIR = path.resolve(__dirname, '../..');
const TIMEOUT_SECONDS_LINHA = /^\s*timeoutSeconds\s*:\s*(\d+)\s*(?:#.*)?$/;

/**
 * The pedidos routes (step 15) and the core each delegates to, with how many order-detail reads
 * (`buscarPedidoLi(`) and context loads (`loadLojaIntegradaContext(`) each file makes. The paid
 * re-check makes exactly ONE read, through ONE context (so it is switched and paced); the label
 * routing makes none. The route files themselves make none: the cores do. Nor does the shared
 * read-failure mapper the paid re-check hands its failures to: it answers a failure and parks,
 * and a "confirming" read there would be a second paced read no other row here would see.
 */
const ROTAS_DE_PEDIDOS: readonly (readonly [string, number, number])[] = [
  ['app/api/marketplace/loja-integrada/pedidos/[pedidoId]/pagamento/route.ts', 0, 0],
  ['lib/lojaIntegrada/pedidos/conferenciaPagamento.ts', 1, 1],
  ['lib/lojaIntegrada/core/falhaDeLeituraLi.ts', 0, 0],
  ['app/api/marketplace/loja-integrada/pedidos/[pedidoId]/rota-etiqueta/route.ts', 0, 0],
  ['lib/lojaIntegrada/pedidos/rotaEtiqueta.ts', 0, 0],
];

/**
 * The catalogue routes (step 10) and the core they delegate to, with how many context loads
 * (`loadLojaIntegradaContext(`) each file makes. The route files make none and read nothing: the
 * core makes ONE context load and names each package catalogue GET exactly once (the one list or
 * detail a request reads), and the cache module makes no read at all.
 */
const ROTAS_DO_CATALOGO: readonly (readonly [string, number])[] = [
  ['app/api/marketplace/loja-integrada/conta/[id]/categorias/route.ts', 0],
  ['app/api/marketplace/loja-integrada/conta/[id]/marcas/route.ts', 0],
  ['app/api/marketplace/loja-integrada/conta/[id]/grades/route.ts', 0],
  ['app/api/marketplace/loja-integrada/conta/[id]/grades/[gradeId]/route.ts', 0],
  ['lib/lojaIntegrada/catalogo/catalogo.ts', 1],
  ['lib/lojaIntegrada/catalogo/cache.ts', 0],
];

/** The core of the catalogue routes: the one file that may name the package's catalogue GETs. */
const NUCLEO_DO_CATALOGO = 'lib/lojaIntegrada/catalogo/catalogo.ts';

/** The package's catalogue GETs, each named once by the core and by nothing else here. */
const LEITURAS_DO_CATALOGO = [
  'listarCategoriasLi(',
  'listarMarcasLi(',
  'listarGradesLi(',
  'buscarGradeLi(',
] as const;

/** The three conta routes, and how many validating calls and re-drives each may make. */
const ROTAS: readonly (readonly [string, number, number])[] = [
  ['app/api/marketplace/loja-integrada/conta/[id]/route.ts', 0, 0],
  ['app/api/marketplace/loja-integrada/conta/[id]/credencial/route.ts', 1, 1],
  ['app/api/marketplace/loja-integrada/conta/[id]/credencial/validade/route.ts', 1, 1],
];

/**
 * Every `timeoutSeconds` pinned in these YAML texts, plus every line that
 * mentions the key but cannot be read as one — fail closed, so
 * `timeoutSeconds: "900"` or a flow mapping is reported instead of silently
 * falling back to the default.
 */
function pinsDeTimeout(textos: string[]): { pinados: number[]; ilegiveis: string[] } {
  const pinados: number[] = [];
  const ilegiveis: string[] = [];
  for (const texto of textos) {
    for (const linha of texto.split(/\r?\n/)) {
      if (!/timeoutSeconds/.test(linha.replace(/#.*$/, ''))) continue;
      const m = TIMEOUT_SECONDS_LINHA.exec(linha);
      if (m === null) ilegiveis.push(linha.trim());
      else pinados.push(Number(m[1]));
    }
  }
  return { pinados, ilegiveis };
}

function configDoBackend(): { arquivos: string[]; pinados: number[]; ilegiveis: string[] } {
  const arquivos = readdirSync(APP_DIR).filter((f) => /^apphosting.*\.yaml$/.test(f));
  return {
    arquivos,
    ...pinsDeTimeout(arquivos.map((f) => readFileSync(path.join(APP_DIR, f), 'utf8'))),
  };
}

function contar(texto: string, agulha: string): number {
  return texto.split(agulha).length - 1;
}

describe('the credential routes fit inside the backend ceiling', () => {
  it('reads the backend config (anti-vacuity)', () => {
    const { arquivos, ilegiveis } = configDoBackend();
    expect(arquivos).toContain('apphosting.yaml');
    // Fail CLOSED: a pin the parser cannot read must not silently fall back to 300 s.
    expect(ilegiveis).toEqual([]);
  });

  it('PRAZO_LI_MS.leitura + margin + the re-drive ≤ the smallest ceiling', () => {
    const { pinados } = configDoBackend();
    const tetoS = pinados.length > 0 ? Math.min(...pinados) : TETO_APP_HOSTING_PADRAO_S;
    expect(PRAZO_LI_MS.leitura).toBeGreaterThan(0);
    expect(CONCORRENCIA_REDRIVE_LI).toBeGreaterThan(1);
    expect(PRAZO_LI_MS.leitura + MARGEM_MS + REDRIVE_MS).toBeLessThanOrEqual(tetoS * 1000);
  });

  it('each route makes at most the one validating call and the one re-drive the budget counts', () => {
    for (const [rota, chamadas, redrives] of ROTAS) {
      const fonte = readFileSync(path.join(APP_DIR, rota), 'utf8');
      expect(contar(fonte, 'validarPersonalToken('), rota).toBe(chamadas);
      expect(contar(fonte, 'redriveAposSalvarTokenLi('), rota).toBe(redrives);
      // Never the unwrapped re-drive, which takes its own page size.
      expect(fonte, rota).not.toContain('redrivePedidosAdiadosDaConta(');
      // No other way out to Loja Integrada: no context client, no raw fetch.
      expect(fonte, rota).not.toMatch(/criarClienteLeituraLi|loadLojaIntegradaContext|fetch\(/);
    }
  });

  // No pin exists in this app's yaml today, so the parsing branch above never
  // runs on the real files — pin the parser on synthetic text instead.
  it('the reader parses a pin, ignores a comment, and fails closed on an unreadable one', () => {
    expect(pinsDeTimeout(['runConfig:\n  cpu: 1\n  timeoutSeconds: 60 # curto\n'])).toEqual({
      pinados: [60],
      ilegiveis: [],
    });
    expect(pinsDeTimeout(['# No `timeoutSeconds` — the default\n'])).toEqual({
      pinados: [],
      ilegiveis: [],
    });
    expect(pinsDeTimeout(['runConfig:\n  timeoutSeconds: "300"\n']).ilegiveis).toEqual([
      'timeoutSeconds: "300"',
    ]);
    // A pin this small is exactly what this test exists to reject.
    expect(PRAZO_LI_MS.leitura + MARGEM_MS).toBeGreaterThan(30 * 1000);
    // A 60 s pin fits the BOUNDED re-drive, and would not fit a serial one.
    expect(PRAZO_LI_MS.leitura + MARGEM_MS + REDRIVE_MS).toBeLessThanOrEqual(60 * 1000);
    const serialMs = (1 + LIMITE_REDRIVE_LI) * RODADA_FIRESTORE_MS;
    expect(PRAZO_LI_MS.leitura + MARGEM_MS + serialMs).toBeGreaterThan(60 * 1000);
  });
});

/**
 * The pedidos routes (step 15). The paid re-check makes ONE order-detail read through a context:
 * the pacer's wait (outside the call's deadline, `core/ritmo.ts`), then the call bounded by
 * `PRAZO_LI_MS.leitura`, plus a handful of Firestore reads (the pedido, the conta, the credential
 * twice, the mirror) and, on a 401, the park's few writes — all inside the margin. The label
 * routing makes no Loja Integrada call at all.
 */
describe('the pedidos routes fit inside the backend ceiling', () => {
  it('the pacer + PRAZO_LI_MS.leitura + margin ≤ the smallest ceiling', () => {
    const { pinados } = configDoBackend();
    const tetoS = pinados.length > 0 ? Math.min(...pinados) : TETO_APP_HOSTING_PADRAO_S;
    expect(RITMO_LEITURA_LI_MS).toBeGreaterThan(0);
    expect(RITMO_LEITURA_LI_MS + PRAZO_LI_MS.leitura + MARGEM_MS).toBeLessThanOrEqual(tetoS * 1000);
  });

  it('the paid re-check makes exactly ONE order-detail read, through ONE context; nothing else reaches Loja Integrada', () => {
    for (const [arquivo, leituras, contextos] of ROTAS_DE_PEDIDOS) {
      const fonte = readFileSync(path.join(APP_DIR, arquivo), 'utf8');
      expect(contar(fonte, 'buscarPedidoLi('), arquivo).toBe(leituras);
      expect(contar(fonte, 'loadLojaIntegradaContext('), arquivo).toBe(contextos);
      // No other way out: no raw fetch, no client of its own, no other package read.
      expect(fonte, arquivo).not.toMatch(
        /criarClienteLeituraLi|validarPersonalToken|listarHistoricoSituacaoLi|buscarProdutoPorIdExternoLi|paginarLi|\.get\(\s*\{\s*operacao|fetch\(/,
      );
    }
  });
});

/**
 * The catalogue routes (step 10). A list read is at most `MAX_PAGINAS_CATALOGO_LI` paced pages,
 * each the pacer's wait (outside the call's deadline, `core/ritmo.ts`) plus one call bounded by
 * `PRAZO_LI_MS.leitura`; a grade detail is one such page. The context's handful of Firestore reads
 * (the conta, the credential once per page) and, on a 401, the park's few writes sit inside the
 * margin. The shared load never takes the caller's signal, so a closed tab does not shorten it:
 * the whole worst case must fit the ceiling.
 */
describe('the catalogue routes fit inside the backend ceiling', () => {
  it('MAX_PAGINAS_CATALOGO_LI × (the pacer + PRAZO_LI_MS.leitura) + margin ≤ the smallest ceiling', () => {
    const { pinados } = configDoBackend();
    const tetoS = pinados.length > 0 ? Math.min(...pinados) : TETO_APP_HOSTING_PADRAO_S;
    expect(MAX_PAGINAS_CATALOGO_LI).toBeGreaterThan(1);
    const porPaginaMs = RITMO_LEITURA_LI_MS + PRAZO_LI_MS.leitura;
    expect(MAX_PAGINAS_CATALOGO_LI * porPaginaMs + MARGEM_MS).toBeLessThanOrEqual(tetoS * 1000);
    // Today's numbers: 10 × (2 s + 20 s) + 30 s = 250 s under the 300 s default.
    expect(MAX_PAGINAS_CATALOGO_LI * porPaginaMs + MARGEM_MS).toBe(250_000);
  });

  it('the route files read nothing; the core makes ONE context load and names each catalogue GET once; nothing else reaches Loja Integrada', () => {
    for (const [arquivo, contextos] of ROTAS_DO_CATALOGO) {
      const fonte = readFileSync(path.join(APP_DIR, arquivo), 'utf8');
      expect(contar(fonte, 'loadLojaIntegradaContext('), arquivo).toBe(contextos);
      for (const leitura of LEITURAS_DO_CATALOGO) {
        expect(contar(fonte, leitura), `${arquivo}: ${leitura}`).toBe(
          arquivo === NUCLEO_DO_CATALOGO ? 1 : 0,
        );
      }
      // No other way out: no raw fetch, no client of its own, no pager, no other package read.
      expect(fonte, arquivo).not.toMatch(
        /criarClienteLeituraLi|validarPersonalToken|paginarLi|buscarPedidoLi|listarHistoricoSituacaoLi|buscarProdutoPorIdExternoLi|\.get\(\s*\{\s*operacao|fetch\(/,
      );
    }
    // Complete: every route under the conta folder is a catalogue route or a conta route above,
    // so a new read route cannot skip both lists.
    const pastaDaConta = 'app/api/marketplace/loja-integrada/conta/[id]';
    const naPasta = readdirSync(path.join(APP_DIR, pastaDaConta), { recursive: true })
      .map((f) => `${pastaDaConta}/${String(f).replaceAll('\\', '/')}`)
      .filter((f) => f.endsWith('/route.ts'));
    const doCatalogo = new Set(ROTAS_DO_CATALOGO.map(([a]) => a));
    const daConta = new Set(ROTAS.map(([a]) => a));
    expect(naPasta.filter((f) => !doCatalogo.has(f) && !daConta.has(f))).toEqual([]);
    expect(naPasta.filter((f) => doCatalogo.has(f))).toHaveLength(4);
    expect(naPasta.filter((f) => daConta.has(f))).toHaveLength(3);
    // Anti-vacuity: each route delegates to the core, exactly once.
    for (const [arquivo] of ROTAS_DO_CATALOGO.filter(([a]) => a.startsWith('app/'))) {
      const fonte = readFileSync(path.join(APP_DIR, arquivo), 'utf8');
      expect(contar(fonte, 'lerCatalogoLi('), arquivo).toBe(1);
    }
  });
});
