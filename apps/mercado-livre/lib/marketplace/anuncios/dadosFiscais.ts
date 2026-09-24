/**
 * **Register each SKU's fiscal data with ML's Faturador** (#745) — the IO half
 * of `dadosFiscaisPayload.ts`. Two callers, one code path: the end of every
 * publish, and the "Enviar dados fiscais" route, which re-sends from the STORED
 * links without republishing (after an imposto edit, say).
 *
 * ML's Faturador issues the NF-e itself — mandatory under Mercado Envios Full,
 * optional elsewhere — and can do so only from per-SKU fiscal data linked to
 * each listing. Nothing about sending it requires the conta to have opted in to
 * the Faturador (ML's docs order it the other way: the fiscal data is loaded,
 * THEN the opt-in lets ML invoice), so this runs for every conta.
 *
 * ## Per target, in order
 *
 *  1. no SKU ⇒ `omitido`; a SKU already handled this run ⇒ `omitido` (ML keys
 *     the record by SKU, so a second produto would overwrite the first);
 *  2. the `Imposto` through the NF-e's own cascade, bound to the conta's
 *     operação — the one every ML order importer stamps on the pedido;
 *  3. the body (pure; a missing NCM, a non-Simples imposto or an unclassifiable
 *     CFOP is an `omitido` naming the reason);
 *  4. upsert: `PUT /items/fiscal_information/{sku}`, and `POST` only when ML
 *     answers the SKU is unknown — a SKU registered by hand in ML's panel is
 *     simply replaced;
 *  5. link SKU ↔ item, SKIPPED while the link doc already records this exact
 *     pair (a republish does not re-link);
 *  6. `can_invoice`, best-effort: a failed read records `null`, never `false`;
 *  7. stamp the outcome on the link doc.
 *
 * ## Failure semantics
 *
 * Best-effort toward ML: by the time this runs the listing is already correct,
 * so no ML refusal fails a publish. A `MercadoLivreError` on one SKU is recorded
 * on that SKU's link and the next SKU still goes; any other error rethrows
 * (root `CLAUDE.md` rule 6 — a Firestore failure or a bug is not ML's refusal).
 * A refusal of the CONTA itself (401 reauth, 403) stops the calls for the rest
 * of the run and records that one reason on every remaining SKU, instead of N
 * identical round trips.
 *
 * ## Races (root `CLAUDE.md` rule 7)
 *
 * Tier 0. The `dadosFiscais*` fields have this one writer, every value written
 * is derived from the calls THIS run just made, and the patch touches nothing
 * else — so a concurrent publish of the same produto writes its own equally
 * true outcome, and the loser of the stored-pair check merely re-links.
 * `mergeIfExists`, never an upsert: a link deleted meanwhile is not resurrected
 * as a ghost carrying only these keys.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  MercadoLivreError,
  MercadoLivreHttpError,
  MercadoLivreReauthRequiredError,
  type MercadoLivreApi,
  type MlFiscalInformationBody,
} from '@delfrance/integrations-mercado-livre';
import {
  MOTIVO_LEITURA_IMPOSTO,
  criarLeitorDeImpostoPorOperacao,
  type LeitorDeImpostoPorOperacao,
  type MotivoLeituraImposto,
} from '@delfrance/data/admin/imposto';
import {
  produtoMercadoLivreLinkCollection,
  variacaoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';
import { ESTADO_DADOS_FISCAIS_ML, type EstadoDadosFiscaisMl } from '@delfrance/schemas';

import { MOTIVO_DADOS_FISCAIS, montarDadosFiscais } from './dadosFiscaisPayload';

/** The produto fields the fiscal record reads. */
export interface ProdutoFiscal {
  readonly sku?: string | null;
  readonly nome?: string | null;
  readonly gtin?: string | null;
  readonly pesoBrutoKg?: number | null;
  readonly pesoLiquidoKg?: number | null;
  readonly custo?: number | null;
}

/** Which link doc carries this SKU's outcome. */
export interface LinkFiscal {
  readonly colecao: 'produtoMercadoLivre' | 'variacaoMercadoLivre';
  /** The produto the link lives UNDER — the child, for a variation link. */
  readonly produtoId: string;
  readonly docId: string;
}

/** One SKU to register: a simple item, a legacy variation or a UP member. */
export interface AlvoFiscal {
  /**
   * Whose `Imposto` is resolved — the CHILD for a variation, exactly as the
   * nota does: an ML order line binds to the child produto.
   */
  readonly produtoId: string;
  readonly produto: ProdutoFiscal;
  /** Weight and cost fall back to the pai's when the child has none. */
  readonly pai: ProdutoFiscal | null;
  /** The listing title ML echoed; the produto name when absent. */
  readonly titulo: string | null;
  readonly itemId: string;
  /** Legacy `variations[]` only; null for a simple item or a UP member. */
  readonly variationId: number | string | null;
  readonly link: LinkFiscal;
  /** The SKU ↔ item pair the link doc already records (`dadosFiscaisSku`/`ItemId`). */
  readonly registrado: {
    readonly sku: string | null;
    readonly itemId: string | null;
    /** The legacy variation id, as text — see {@link variacaoComoTexto}. */
    readonly variationId: string | null;
  };
}

export interface ResumoDadosFiscais {
  enviados: number;
  omitidos: Array<{ produtoId: string; sku: string | null; motivo: string }>;
  erros: Array<{ produtoId: string; sku: string; mensagem: string }>;
}

export interface DepsDadosFiscais {
  readonly db: Firestore;
  readonly api: MercadoLivreApi;
  /**
   * The conta's `operacaoOuterRef` — the operação every ML order importer
   * stamps on the pedido, and therefore the one the nota resolves through.
   */
  readonly operacaoOuterRef: string | null;
  /** Test seam — defaults to the shared leitor bound to `operacaoOuterRef`. */
  readonly leitor?: LeitorDeImpostoPorOperacao;
  /** Injectable clock for the `dadosFiscaisEm` stamp. */
  readonly nowMs?: () => number;
}

/** Longest ML message persisted on a link — ML's validation bodies can list many fields. */
const MAX_MENSAGEM = 500;

export function resumoVazio(): ResumoDadosFiscais {
  return { enviados: 0, omitidos: [], erros: [] };
}

/**
 * The SKU ↔ item pair a stored link doc already records as linked — read off
 * the RAW doc, so a link that predates #745 simply has none.
 */
export function registradoFiscal(
  raw: Readonly<Record<string, unknown>> | null | undefined,
): AlvoFiscal['registrado'] {
  return {
    sku: typeof raw?.dadosFiscaisSku === 'string' ? raw.dadosFiscaisSku : null,
    itemId: typeof raw?.dadosFiscaisItemId === 'string' ? raw.dadosFiscaisItemId : null,
    variationId:
      typeof raw?.dadosFiscaisVariationId === 'string' ? raw.dadosFiscaisVariationId : null,
  };
}

export async function enviarDadosFiscais(
  deps: DepsDadosFiscais,
  alvos: readonly AlvoFiscal[],
): Promise<ResumoDadosFiscais> {
  const { db, api } = deps;
  const operacaoOuterRef = deps.operacaoOuterRef?.trim() || null;
  // A conta with no operação is a fact about the CONTA, not about any SKU:
  // stamping it on every link would record N copies of one setting, so it is
  // reported in the summary alone — zero reads, zero writes, zero ML calls.
  if (operacaoOuterRef == null) return resumoSemOperacao(alvos);
  const leitor = deps.leitor ?? criarLeitorDeImpostoPorOperacao({ db, operacaoOuterRef });
  const agora = deps.nowMs ?? Date.now;
  const resumo = resumoVazio();
  const skusVistos = new Set<string>();
  /** Set once ML refuses the CONTA — every remaining SKU records it, uncalled. */
  let recusaDaConta: string | null = null;

  const carimbar = (
    alvo: AlvoFiscal,
    estado: EstadoDadosFiscaisMl,
    motivo: string | null,
    extra: Record<string, unknown> = {},
  ) =>
    carimbarLink(db, alvo.link, {
      dadosFiscaisEstado: estado,
      dadosFiscaisMotivo: motivo,
      dadosFiscaisEm: agora(),
      ...extra,
    });

  const omitir = async (alvo: AlvoFiscal, sku: string | null, motivo: string) => {
    resumo.omitidos.push({ produtoId: alvo.produtoId, sku, motivo });
    await carimbar(alvo, ESTADO_DADOS_FISCAIS_ML.omitido, motivo);
  };

  for (const alvo of alvos) {
    const sku = alvo.produto.sku?.trim() || null;
    if (sku == null) {
      await omitir(alvo, null, MOTIVO_DADOS_FISCAIS.semSku);
      continue;
    }
    if (skusVistos.has(sku)) {
      await omitir(alvo, sku, MOTIVO_DADOS_FISCAIS.skuDuplicado);
      continue;
    }
    skusVistos.add(sku);

    if (recusaDaConta != null) {
      resumo.erros.push({ produtoId: alvo.produtoId, sku, mensagem: recusaDaConta });
      await carimbar(alvo, ESTADO_DADOS_FISCAIS_ML.erro, recusaDaConta);
      continue;
    }

    const leitura = await leitor.ler(alvo.produtoId);
    if (leitura.imposto == null) {
      await omitir(alvo, sku, motivoDaLeitura(leitura.motivo));
      continue;
    }

    const montado = montarDadosFiscais({
      sku,
      titulo: alvo.titulo?.trim() || alvo.produto.nome?.trim() || sku,
      imposto: leitura.imposto,
      operacao: leitura.operacao,
      gtin: alvo.produto.gtin ?? null,
      pesoBrutoKg: alvo.produto.pesoBrutoKg ?? alvo.pai?.pesoBrutoKg ?? null,
      pesoLiquidoKg: alvo.produto.pesoLiquidoKg ?? alvo.pai?.pesoLiquidoKg ?? null,
      custo: alvo.produto.custo ?? alvo.pai?.custo ?? null,
    });
    if (!montado.ok) {
      await omitir(alvo, sku, montado.motivo);
      continue;
    }

    try {
      await registrarSku(api, montado.body);
      // ⚠️ The VARIATION is part of the key, not just SKU + item: a legacy
      // variation ML recreated (a #831 partial PUT deleted it, the next publish
      // re-added it) keeps both and gets a new id, and a skip keyed on the pair
      // would leave ML's link naming the dead one for every run after.
      const jaVinculado =
        alvo.registrado.sku === sku &&
        alvo.registrado.itemId === alvo.itemId &&
        alvo.registrado.variationId === variacaoComoTexto(alvo.variationId);
      if (!jaVinculado) {
        await api.linkFiscalInformationItem({
          sku,
          itemId: alvo.itemId,
          variationId: alvo.variationId,
        });
      }
    } catch (err) {
      if (!(err instanceof MercadoLivreError)) throw err;
      const mensagem = mensagemDoErro(err);
      if (ehRecusaDaConta(err)) recusaDaConta = mensagem;
      console.warn('[mercado-livre] dados fiscais recusados', {
        produtoId: alvo.produtoId,
        itemId: alvo.itemId,
        mensagem,
      });
      resumo.erros.push({ produtoId: alvo.produtoId, sku, mensagem });
      await carimbar(alvo, ESTADO_DADOS_FISCAIS_ML.erro, mensagem);
      continue;
    }

    const podeFaturar = await lerPodeFaturar(api, alvo);
    resumo.enviados += 1;
    await carimbar(alvo, ESTADO_DADOS_FISCAIS_ML.enviado, null, {
      dadosFiscaisSku: sku,
      dadosFiscaisItemId: alvo.itemId,
      dadosFiscaisVariationId: variacaoComoTexto(alvo.variationId),
      podeFaturar,
    });
  }

  return resumo;
}

/** Every target `omitido` for want of an operação — see the guard at the top of the run. */
function resumoSemOperacao(alvos: readonly AlvoFiscal[]): ResumoDadosFiscais {
  return {
    enviados: 0,
    omitidos: alvos.map((a) => ({
      produtoId: a.produtoId,
      sku: a.produto.sku?.trim() || null,
      motivo: MOTIVO_DADOS_FISCAIS.semOperacao,
    })),
    erros: [],
  };
}

/**
 * A legacy variation id as the text the link doc stores. ML hands it as a
 * number and the stored links hold a number, so it is normalised once here and
 * the skip key never compares `555` against `'555'`.
 */
function variacaoComoTexto(variationId: number | string | null): string | null {
  return variationId == null ? null : String(variationId);
}

/** PUT first (a re-send is the common case); POST only when ML does not know the SKU. */
async function registrarSku(api: MercadoLivreApi, body: MlFiscalInformationBody): Promise<void> {
  const { sku, ...semSku } = body;
  try {
    await api.updateFiscalInformation(sku, semSku);
  } catch (err) {
    if (!skuDesconhecido(err)) throw err;
    await api.createFiscalInformation(body);
  }
}

/**
 * Does this error say "ML has no record of this SKU"? The GET is documented as
 * a 404; the link endpoint answers the same fact as a 400 with code `10086`, so
 * both are read here. Which one the PUT really uses is a settle-live item.
 */
function skuDesconhecido(err: unknown): boolean {
  if (!(err instanceof MercadoLivreHttpError)) return false;
  if (err.status === 404) return true;
  return err.status === 400 && codigosDoCorpo(err.body).includes('10086');
}

function ehRecusaDaConta(err: MercadoLivreError): boolean {
  if (err instanceof MercadoLivreReauthRequiredError) return true;
  return err instanceof MercadoLivreHttpError && err.status === 403;
}

async function lerPodeFaturar(api: MercadoLivreApi, alvo: AlvoFiscal): Promise<boolean | null> {
  try {
    const r = await api.getCanInvoice(alvo.itemId, alvo.variationId);
    return typeof r.status === 'boolean' ? r.status : null;
  } catch (err) {
    if (!(err instanceof MercadoLivreError)) throw err;
    return null;
  }
}

async function carimbarLink(
  db: Firestore,
  link: LinkFiscal,
  patch: Record<string, unknown>,
): Promise<void> {
  if (link.colecao === 'produtoMercadoLivre') {
    await produtoMercadoLivreLinkCollection.mergeIfExists(
      db,
      { produtoId: link.produtoId },
      link.docId,
      patch,
    );
  } else {
    await variacaoMercadoLivreLinkCollection.mergeIfExists(
      db,
      { produtoId: link.produtoId },
      link.docId,
      patch,
    );
  }
}

function motivoDaLeitura(motivo: MotivoLeituraImposto): string {
  switch (motivo) {
    case MOTIVO_LEITURA_IMPOSTO.semOperacao:
      return MOTIVO_DADOS_FISCAIS.semOperacao;
    case MOTIVO_LEITURA_IMPOSTO.operacaoInexistente:
      return MOTIVO_DADOS_FISCAIS.operacaoInexistente;
    case MOTIVO_LEITURA_IMPOSTO.semImposto:
      return MOTIVO_DADOS_FISCAIS.semImposto;
  }
}

/**
 * ML's own words, which name the field it rejected
 * (`{ message, error_code, fields: [{ field, message }] }`) — `err.message`
 * alone is just `ML 400: …`. Fiscal bodies carry no credential, and the result
 * is capped so a long field list cannot bloat the link doc.
 */
function mensagemDoErro(err: MercadoLivreError): string {
  if (!(err instanceof MercadoLivreHttpError)) return err.message.slice(0, MAX_MENSAGEM);
  const partes: string[] = [];
  const corpo = err.body;
  if (ehObjeto(corpo)) {
    if (typeof corpo.message === 'string') partes.push(corpo.message);
    if (Array.isArray(corpo.fields)) {
      for (const f of corpo.fields) {
        if (!ehObjeto(f) || typeof f.message !== 'string') continue;
        partes.push(typeof f.field === 'string' ? `${f.field}: ${f.message}` : f.message);
      }
    }
  }
  const texto = partes.length > 0 ? `ML ${err.status}: ${partes.join('; ')}` : err.message;
  return texto.slice(0, MAX_MENSAGEM);
}

function codigosDoCorpo(corpo: unknown): string[] {
  if (!ehObjeto(corpo)) return [];
  const codigos: string[] = [];
  if (corpo.error_code != null) codigos.push(String(corpo.error_code));
  if (Array.isArray(corpo.fields)) {
    for (const f of corpo.fields) {
      if (ehObjeto(f) && f.error_code != null) codigos.push(String(f.error_code));
    }
  }
  return codigos;
}

function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
