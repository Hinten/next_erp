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
 * ## The create lease (#1912)
 *
 * `add_kit_item` is not idempotent, so every CREATE arm (`kit-criar`,
 * `kit-recriar`, `kit-converter`) runs under the single-flight lease of
 * `criacaoKitEmCurso.ts`, taken HERE before `prepararKit` reads a single link:
 * a second run of the same (conta, kit produto) — another tab, another
 * operator, the CLI — answers 409 `SHOPEE_KIT_CRIACAO_EM_ANDAMENTO` with zero
 * Shopee calls, and a run that comes after another's release reads that run's
 * link and resumes as `completar`. The lease is released here whenever the run
 * is still `tomada` (it knows nothing was sent: a refusal, a `nao-criado`,
 * a `completar`, a scan cut); the applier keeps it after an `incerto` and
 * releases it right after a created kit's link write. `kit-atualizar` never
 * sends `add_kit_item` and takes none.
 *
 * The lease needs the LIVE clock (`deps.aoVivo`), which the route and
 * `publicar:anuncio --live` always supply; a create arm without it is a
 * composition-root defect, refused before any write — never a fallback to
 * `nowMs`, which would make the send gate vacuous.
 */
import { criarResolvedorDePublicacao } from '../anuncios/publicarAnuncio';
import {
  conflitoKitExpirado,
  liberarReserva,
  podeContinuarNaReserva,
  reservarCriacaoDeKit,
} from './criacaoKitEmCurso';
import { BuscaForaDoPrazoShopeeError } from './localizarKitPorSku';
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

  if (arma.arma === 'kit-atualizar') {
    // A republish never sends `add_kit_item` and never scans (L10(4)): no lease.
    const contexto = await prepararKit(deps, entrada, arma, resolvedor, {
      podeContinuar: semPrazo,
    });
    // The republish plans for itself (`planejarKit` is pure): its refusal set
    // and its per-bound-child rows depend on the LIVE binding (§2.6).
    return await republicarKit(deps, contexto, contexto.fotos);
  }

  const controles = deps.aoVivo;
  if (controles === undefined) {
    throw new Error(
      `[shopee/kits] ${arma.arma} sem deps.aoVivo: a reserva da criação exige o relógio ao vivo`,
    );
  }
  const reserva = await reservarCriacaoDeKit(
    deps.db,
    { integracaoId: deps.integracaoId, produtoId: entrada.produtoId, arma: arma.arma },
    controles,
  );
  try {
    const contexto = await prepararKit(deps, entrada, arma, resolvedor, {
      podeContinuar: podeContinuarNaReserva(reserva),
    });
    const plano = planejarKit(contexto, contexto.fotos);
    switch (arma.arma) {
      case 'kit-criar':
        return await criarKit(deps, contexto, plano, reserva);
      case 'kit-recriar':
        return await recriarKit(deps, contexto, plano, reserva);
      case 'kit-converter':
        return await converterEmKit(deps, contexto, plano, reserva);
      default: {
        const nunca: never = arma;
        throw new Error(`[shopee/kits] braço de criação desconhecido: ${JSON.stringify(nunca)}`);
      }
    }
  } catch (err) {
    // The scan reached the lease's (or the request's) deadline: nothing was
    // decided and nothing sent — the lease's own 409, never a Shopee error.
    if (err instanceof BuscaForaDoPrazoShopeeError) {
      throw conflitoKitExpirado('a busca de kit duplicado não coube no prazo desta publicação');
    }
    throw err;
  } finally {
    // Still `tomada` ⇒ this run KNOWS it sent nothing: hand the lease back.
    if (reserva.fase === 'tomada') await liberarReserva(deps.db, reserva);
  }
}

/**
 * "No deadline" — the scan checkpoint of a run that holds no create lease: a
 * republish (which never scans) and the DRY RUN (which never sends). Explicit,
 * never an omitted option, so a live create can never reach the scan without
 * its lease's checkpoint.
 */
const semPrazo = (): boolean => true;

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
  // No lease (nothing is sent), so no deadline: the CLI's dry run may walk a
  // large shop to the end.
  const contexto = await prepararKit(deps, entrada, arma, resolvedor, { podeContinuar: semPrazo });
  return { contexto, plano: planejarKit(contexto, contexto.fotos) };
}
