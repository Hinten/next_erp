/**
 * **The native-kit entry point** (step 19, #1527 — reconcile §2.5.3):
 * `publicarKitShopee` = `prepararKit` (reads) → `planejarKit` (pure) → the
 * arm's applier: `criarKit` (`aplicarKit.ts`) for `kit-criar`, `republicarKit`
 * (`republicarKit.ts`, §2.6) for `kit-atualizar`, and PR 6's `recriarKit` /
 * `converterEmKit` (`recriarKit.ts`, §2.7) for `kit-recriar` /
 * `kit-converter`. It is the kit twin of step
 * 11's `publicarAnuncioShopee`, and like it it owns no decision of its own: the
 * dispatcher (PR 7,
 * `escolherArmaDePublicacao`) picks the arm, `prepararKit` reads, the plan
 * decides, and each applier is an ENSURE sequence (L9) that re-derives what is
 * missing from Shopee reads plus the link docs.
 *
 * The DRY RUN is {@link ensaiarKitShopee}: the same two first steps and NOTHING
 * of the third — no `add_kit_item`, no `update_kit_item`, no Firestore write.
 * It does read (the L6 scan on a create arm, its pages and calls reported by
 * the result) and it does upload the photos when the run would send content,
 * step 11's documented dry-run exception (`montarAnuncio` needs real image ids).
 *
 * ⚠️ No caller in PR 5: the route and the CLI reach this module only through
 * PR 7's dispatcher, so PR 5 is green alone and every test drives an explicit
 * arm.
 */
import { criarResolvedorDePublicacao } from '../anuncios/publicarAnuncio';
import type { ResolvedorDeImagensShopee } from '../anuncios/fotosPublicacao';
import type { PrepararPublicacaoDeps } from '../anuncios/publicarAnuncio';
import { criarKit } from './aplicarKit';
import { planejarKit, type PlanoKit } from './planoKit';
import {
  prepararKit,
  type ArmaDeKit,
  type ContextoKitPreparado,
  type EntradaDeKit,
} from './prepararKit';
import { converterEmKit, recriarKit } from './recriarKit';
import { republicarKit } from './republicarKit';
import type { KitDeps, ResultadoPublicacaoKit } from './resultadoKit';

/**
 * Publish ONE kit produto on ONE conta, on the arm the dispatcher chose.
 *
 * ⚠️ The photo resolver is built HERE (or taken from `deps`, the test seam) and
 * handed to `prepararKit`, which calls it LAST and only when content will be
 * sent — so a refused run never uploads a picture.
 */
export async function publicarKitShopee(
  deps: KitDeps,
  entrada: EntradaDeKit,
  arma: ArmaDeKit,
): Promise<ResultadoPublicacaoKit> {
  const resolvedor =
    deps.resolvedorDeImagens ?? criarResolvedorDePublicacao(deps, entrada.produtoId);
  const contexto = await prepararKit(deps, entrada, arma, resolvedor);
  const plano = planejarKit(contexto, contexto.fotos);
  switch (contexto.arma.arma) {
    case 'kit-criar':
      return await criarKit(deps, contexto, plano);
    case 'kit-atualizar':
      // The republish plans for itself (`planejarKit` is pure): its refusal set
      // and its per-bound-child rows depend on the LIVE binding (§2.6).
      return await republicarKit(deps, contexto, contexto.fotos);
    case 'kit-recriar':
      return await recriarKit(deps, contexto, plano);
    case 'kit-converter':
      return await converterEmKit(deps, contexto, plano);
  }
}

/** What a dry run prints: the context it read and the plan it would apply. */
export interface EnsaioDeKit {
  readonly contexto: ContextoKitPreparado;
  readonly plano: PlanoKit;
}

/**
 * The DRY RUN of a kit arm (the CLI's default mode, PR 7): `prepararKit` +
 * `planejarKit`, and nothing that writes. A phase-A refusal throws exactly as
 * the live run does, before any Shopee call; a phase-B refusal is DATA in
 * `plano.problemas`, so the operator sees every miss in one place.
 */
export async function ensaiarKitShopee(
  deps: PrepararPublicacaoDeps,
  entrada: EntradaDeKit,
  arma: ArmaDeKit,
  resolvedor: ResolvedorDeImagensShopee,
): Promise<EnsaioDeKit> {
  const contexto = await prepararKit(deps, entrada, arma, resolvedor);
  return { contexto, plano: planejarKit(contexto, contexto.fotos) };
}
