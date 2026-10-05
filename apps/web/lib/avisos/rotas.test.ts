import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROTAS_AVISO, TIPO_AVISO, type TipoAviso } from '@delfrance/schemas';
import { MENSAGENS_POR_TIPO } from './mensagens';

/**
 * The test that makes `ROTAS_AVISO` load-bearing rather than decorative.
 *
 * An aviso stores its route on the document, so the route FREEZES at write time:
 * a resolved aviso lives 90 days and an unresolved one stands indefinitely. The
 * producer is a Cloud Function, and no functions codebase has a dependency edge
 * to `apps/web` — so renaming a route here is typechecked against nothing, fails
 * no build, and silently turns every stored deep link into a 404.
 *
 * Routing every producer through the shared builder gives each shape one
 * definition; THIS is what turns a rename from "fails nothing" into "fails a
 * test". Without it the builder is only a convention, and conventions drift
 * toward plausible (#1369).
 */

const webDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const APP_DIR = join(webDir, 'app', '(app)');

/** `/canais/shopee/[id]` → `app/(app)/canais/shopee/[id]`. */
function routeDir(padrao: string): string {
  return join(APP_DIR, ...padrao.split('/').filter(Boolean));
}

describe('ROTAS_AVISO', () => {
  it('every route pattern resolves to a real route directory', () => {
    const ausentes = Object.entries(ROTAS_AVISO)
      .filter(([, rota]) => !existsSync(routeDir(rota.padrao)))
      .map(([nome, rota]) => `${nome} → ${rota.padrao}`);

    expect(
      ausentes,
      'A route an aviso can point at no longer exists in apps/web. Stored avisos ' +
        'carry these paths and would 404 — rename the entry in ROTAS_AVISO ' +
        '(packages/schemas/src/aviso.ts) to match the new route.',
    ).toEqual([]);
  });

  it('every route directory it names has a page', () => {
    // A directory can survive its `page.tsx` (a layout-only folder). The link
    // would still 404, so check the page rather than the folder.
    for (const [nome, rota] of Object.entries(ROTAS_AVISO)) {
      const dir = routeDir(rota.padrao);
      const temPagina = existsSync(join(dir, 'page.tsx')) || existsSync(join(dir, 'page.ts'));
      expect(temPagina, `${nome} (${rota.padrao}) has no page file`).toBe(true);
    }
  });
});

describe('MENSAGENS_POR_TIPO', () => {
  it('covers every tipo — a stored aviso must never render as a blank row', () => {
    const tipos = Object.values(TIPO_AVISO) as TipoAviso[];
    expect(Object.keys(MENSAGENS_POR_TIPO).sort()).toEqual([...tipos].sort());
  });

  it('renders a missing param as a placeholder, never the string "undefined"', () => {
    // A producer that omits a param is a bug, but the operator must not read
    // "expira em undefined dia(s)" while we fix it.
    for (const [tipo, mensagem] of Object.entries(MENSAGENS_POR_TIPO)) {
      const corpo = mensagem.corpo({});
      expect(corpo, tipo).not.toContain('undefined');
      expect(corpo.length, tipo).toBeGreaterThan(0);
    }
  });

  it('interpolates the params it is given', () => {
    const corpo = MENSAGENS_POR_TIPO.shopeeAutorizacaoExpirando.corpo({
      loja: 'Delfrance',
      dias: 29,
    });
    expect(corpo).toContain('Delfrance');
    expect(corpo).toContain('29');
  });
});
