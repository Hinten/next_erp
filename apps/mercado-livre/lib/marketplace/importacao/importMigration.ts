import type {
  DocumentSnapshot,
  Firestore,
  QueryDocumentSnapshot,
  Transaction,
} from 'firebase-admin/firestore';
import { sha256Hex } from '@delfrance/data/admin';
import {
  migracaoUptinMercadoLivreCollection as operations,
  produtoCollection,
  produtoMercadoLivreLinkCollection,
  variacaoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';
import {
  ESTADO_PUBLICACAO_ML,
  toOuterRef,
  type MigracaoUptinVariacao as Variation,
} from '@delfrance/schemas';
import {
  estadoFromMlStatus,
  idLocalMercadoLivre,
  itemSchema,
  ML_MULTIGET_MAX_IDS,
  MercadoLivreError,
  MercadoLivreHttpError,
  MercadoLivreReauthRequiredError,
  skuFromAttributes,
  skuPaiFromAttributes,
  UPTIN_DESTINATION_TAG,
  UPTIN_PENDING_TAG,
  UPTIN_SOURCE_TAG,
  type MercadoLivreApi,
  type MlItem,
} from '@delfrance/integrations-mercado-livre';
import { randomUUID } from 'node:crypto';

import { naoDocId, refMatchesIntegracao } from '../core/linkRefs';
import { foldFamilyCategoria, foldFamilyStatus } from '../anuncios/upFamilyStatus';
import { consultarModeracoes } from '../anuncios/moderacoes';

export class UptinError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

export interface UptinMigrationDeps {
  db: Firestore;
  api: Pick<
    MercadoLivreApi,
    | 'getItem'
    | 'getItemsByIds'
    | 'getLastModeration'
    | 'getMigrationLiveListing'
    | 'validateUptin'
    | 'startUptin'
  >;
  integracaoId: string;
  sellerUserId: number | null;
}

export interface UptinSourceLink {
  produtoId: string;
  linkDocId: string;
}

export type UptinOutcome = 'iniciada' | 'pendente' | 'incerta' | 'concluida';

const itemIdPattern = /^MLB\d+$/;
const waiting = ESTADO_PUBLICACAO_ML.aguardandoMigracao;
export const UPTIN_CHECK_DELAY_SECONDS = 300;

function operationRef(deps: Pick<UptinMigrationDeps, 'db' | 'integracaoId'>, itemId: string) {
  return operations.docRef(deps.db, {}, sha256Hex(`${deps.integracaoId}|${itemId}`));
}

export async function hasUptinOperation(db: Firestore, integracaoId: string, itemId: string) {
  return (await operationRef({ db, integracaoId }, itemId).get()).exists;
}

function sourceRef(db: Firestore, target: UptinSourceLink) {
  return produtoMercadoLivreLinkCollection.docRef(
    db,
    { produtoId: target.produtoId },
    target.linkDocId,
  );
}

function sourceVariations(db: Firestore, path: string) {
  return variacaoMercadoLivreLinkCollection
    .groupQuery(db)
    .where('produtoMercadoLivreOuterRef', 'in', [path, toOuterRef(path)]);
}

function ownedLegacy(
  raw: Record<string, unknown> | undefined,
  integracaoId: string,
  itemId: string,
) {
  return (
    raw?.id === itemId &&
    raw.isUserProductModel !== true &&
    refMatchesIntegracao(raw.contaOuterRef, integracaoId)
  );
}

function variationId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? value : null;
}

function exactMapping(
  item: MlItem,
  links: readonly DocumentSnapshot[],
  integracaoId: string,
  expectedIds?: readonly string[],
): Variation[] {
  const ids = expectedIds ?? (item.variations ?? []).map((row) => variationId(row.id));
  const byId = new Map<string, Variation[]>();
  for (const snap of links) {
    const raw = snap.data();
    const id = variationId(raw?.id);
    const produtoId = snap.ref.parent.parent?.id;
    if (
      id == null ||
      !produtoId ||
      raw?.itemId ||
      (raw?.contaOuterRef != null && !refMatchesIntegracao(raw.contaOuterRef, integracaoId))
    )
      continue;
    const candidates = byId.get(id) ?? [];
    candidates.push({ id, produtoId, linkDocId: snap.id });
    byId.set(id, candidates);
  }
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new UptinError('O Mercado Livre não informou uma lista válida de variações de origem.');
  }
  const mapped = ids.map((id) => {
    const candidates = id == null ? undefined : byId.get(id);
    if (candidates?.length !== 1) {
      throw new UptinError(
        `Vincule a variação ${id ?? 'sem identificador'} a um único produto no ERP.`,
      );
    }
    return candidates[0]!;
  });
  if (new Set(mapped.map((row) => row.produtoId)).size !== mapped.length) {
    throw new UptinError('Há mais de uma variação do anúncio vinculada ao mesmo produto no ERP.');
  }
  return mapped;
}

async function verifyProducts(
  tx: Transaction,
  db: Firestore,
  parentId: string,
  rows: readonly Variation[],
) {
  const products = await tx.getAll(
    ...[parentId, ...rows.map((row) => row.produtoId)].map((id) =>
      produtoCollection.docRef(db, {}, id),
    ),
  );
  if (
    !products[0]?.exists ||
    products[0].data()?.paiId ||
    products.slice(1).some((snap) => snap.data()?.paiId !== parentId)
  ) {
    throw new UptinError(
      'Os produtos vinculados às variações mudaram. Revise os vínculos do anúncio.',
    );
  }
}

async function verifyUniqueSource(
  tx: Transaction,
  db: Firestore,
  integracaoId: string,
  itemId: string,
  path: string,
) {
  const matches = await tx.get(
    produtoMercadoLivreLinkCollection.groupQuery(db).where('id', '==', itemId),
  );
  if (
    matches.docs.some(
      (doc) =>
        doc.ref.path !== path && refMatchesIntegracao(doc.data().contaOuterRef, integracaoId),
    )
  ) {
    throw new UptinError(
      'O anúncio de origem tem mais de um vínculo nesta conta. Revise os vínculos no ERP.',
    );
  }
}

function verifySeller(deps: UptinMigrationDeps, itemId: string, item: MlItem) {
  if (item.id !== itemId || deps.sellerUserId == null || item.seller_id !== deps.sellerUserId) {
    throw new UptinError('O anúncio não pertence ao vendedor conectado a esta conta.');
  }
}

async function releaseClaim(
  deps: UptinMigrationDeps,
  target: UptinSourceLink,
  itemId: string,
  attempt: string,
  onlyBeforeDispatch = false,
) {
  const opRef = operationRef(deps, itemId);
  const ref = sourceRef(deps.db, target);
  await deps.db.runTransaction(async (tx) => {
    const [op, source] = await tx.getAll(opRef, ref);
    if (!op?.exists) return;
    const claim = operations.parse(op.data());
    if (claim.completed || claim.attempt !== attempt || (onlyBeforeDispatch && claim.dispatching))
      return;
    const raw = source?.data();
    if (ownedLegacy(raw, deps.integracaoId, itemId) && raw?.estado === waiting) {
      tx.update(ref, {
        estado: claim.previousState ?? ESTADO_PUBLICACAO_ML.publicado,
        ultimaModificacao: Date.now(),
      });
    }
    tx.delete(opRef);
  });
}

export async function startUptinMigration(
  deps: UptinMigrationDeps,
  itemId: string,
  target: UptinSourceLink,
  armCheck: () => Promise<void>,
): Promise<UptinOutcome> {
  const { db, api, integracaoId, sellerUserId } = deps;
  const ref = sourceRef(db, target);
  const opRef = operationRef(deps, itemId);
  const source = (await ref.get()).data();
  if (!ownedLegacy(source, integracaoId, itemId))
    throw new UptinError('O vínculo do anúncio mudou. Atualize a página.');
  if (source?.estado === waiting) return 'pendente';
  const item = await api.getItem(itemId);
  verifySeller(deps, itemId, item);
  if (item.tags?.includes(UPTIN_SOURCE_TAG) || item.tags?.includes(UPTIN_PENDING_TAG)) {
    return handleUptinMigration(deps, itemId, target, item);
  }
  if (
    !itemIdPattern.test(itemId) ||
    item.family_name != null ||
    item.status === 'closed' ||
    !item.variations?.length
  ) {
    throw new UptinError('A migração exige um anúncio legado publicado com variações.');
  }
  const eligibility = await api.validateUptin(itemId);
  if (!eligibility.is_valid) {
    const causes = eligibility.cause?.map((cause) => cause.message).join(' ');
    throw new UptinError(
      `Anúncio inelegível para migração UPtin.${causes ? ` ${causes}` : ''}`,
      422,
    );
  }

  const attempt = randomUUID();
  const claimedAt = Date.now();
  const claimed = await db.runTransaction(async (tx) => {
    const [op, current] = await tx.getAll(opRef, ref);
    if (op?.exists) {
      if (operations.parse(op.data()).completed) {
        throw new UptinError(
          'A migração deste anúncio já foi concluída. Atualize os vínculos do produto.',
        );
      }
      return false;
    }
    const raw = current?.data();
    if (!ownedLegacy(raw, integracaoId, itemId))
      throw new UptinError('O vínculo do anúncio mudou. Atualize a página.');
    if (raw?.estado === waiting) return false;
    await verifyUniqueSource(tx, db, integracaoId, itemId, ref.path);
    const links = await tx.get(sourceVariations(db, ref.path));
    const variations = exactMapping(item, links.docs, integracaoId);
    await verifyProducts(tx, db, target.produtoId, variations);
    tx.create(
      opRef,
      operations.parse({
        ...target,
        sellerUserId,
        attempt,
        claimedAt,
        dispatching: false,
        previousState: raw?.estado ?? null,
        variations,
      }),
    );
    tx.update(ref, { estado: waiting, ultimaModificacao: Date.now() });
    return true;
  });
  if (!claimed) return 'pendente';

  // If the backstop cannot be armed, the POST has yet to leave this process.
  let armed = false;
  try {
    await armCheck();
    armed = true;
  } finally {
    if (!armed) await releaseClaim(deps, target, itemId, attempt, true);
  }
  // A process can die while arming recovery. Mark the attempt before sending
  // so a recheck may release only a claim that never reached dispatch.
  const dispatch = await db.runTransaction(async (tx) => {
    const [op, current] = await tx.getAll(opRef, ref);
    const raw = current?.data();
    if (!op?.exists || !ownedLegacy(raw, integracaoId, itemId) || raw?.estado !== waiting)
      return false;
    const claim = operations.parse(op.data());
    if (claim.completed || claim.attempt !== attempt || claim.dispatching) return false;
    tx.update(opRef, { dispatching: true });
    return true;
  });
  if (!dispatch) return 'pendente';
  try {
    await api.startUptin(itemId);
    return 'iniciada';
  } catch (err) {
    if (
      err instanceof MercadoLivreReauthRequiredError ||
      (err instanceof MercadoLivreHttpError && [400, 401, 403, 422, 429].includes(err.status))
    ) {
      // An external start can win between validation and the POST. Keep the
      // claim on ambiguous conflicts and consult the provider before releasing.
      if (!(err instanceof MercadoLivreReauthRequiredError)) {
        const result = await handleUptinMigration(deps, itemId, target);
        if (result !== 'incerta') return result;
      }
      await releaseClaim(deps, target, itemId, attempt);
      throw err;
    }
    if (err instanceof MercadoLivreError) {
      console.warn('[mercado-livre] UPtin: confirmação da solicitação indisponível', {
        integracaoId,
        itemId,
        error: err.name,
        ...(err instanceof MercadoLivreHttpError ? { status: err.status } : {}),
      });
      return 'incerta';
    }
    throw err;
  }
}

async function stampWaiting(deps: UptinMigrationDeps, target: UptinSourceLink, itemId: string) {
  const ref = sourceRef(deps.db, target);
  await deps.db.runTransaction(async (tx) => {
    const raw = (await tx.get(ref)).data();
    if (ownedLegacy(raw, deps.integracaoId, itemId) && raw?.estado !== waiting) {
      tx.update(ref, { estado: waiting, ultimaModificacao: Date.now() });
    }
  });
}

export async function handleUptinMigration(
  deps: UptinMigrationDeps,
  itemId: string,
  target: UptinSourceLink,
  observedItem?: MlItem,
): Promise<UptinOutcome> {
  const { db, api, integracaoId, sellerUserId } = deps;
  const ref = sourceRef(db, target);
  const opRef = operationRef(deps, itemId);
  const source = (await ref.get()).data();
  if (source == null) {
    const claim = await opRef.get();
    if (claim.exists && operations.parse(claim.data()).completed) return 'concluida';
    throw new UptinError('O vínculo de origem não está mais no ERP. Atualize a página.', 404);
  }
  if (!ownedLegacy(source, integracaoId, itemId))
    throw new UptinError('O vínculo do anúncio mudou. Atualize a página.');
  const item = observedItem ?? (await api.getItem(itemId));
  verifySeller(deps, itemId, item);
  const isSource = item.tags?.includes(UPTIN_SOURCE_TAG) === true;
  if (isSource) await stampWaiting(deps, target, itemId);
  if (!isSource) {
    const claimSnap = await opRef.get();
    if (claimSnap.exists) {
      const claim = operations.parse(claimSnap.data());
      if (!claim.dispatching && Date.now() - claim.claimedAt >= UPTIN_CHECK_DELAY_SECONDS * 1000) {
        await releaseClaim(deps, target, itemId, claim.attempt, true);
        return 'incerta';
      }
    }
  }
  let report;
  try {
    report = await api.getMigrationLiveListing(itemId);
  } catch (err) {
    if (err instanceof MercadoLivreHttpError && err.status === 404 && !isSource) {
      // Flutter-era waiting links carry no claim. An open, untagged source
      // with no provider migration can return to its observed status.
      await db.runTransaction(async (tx) => {
        const [current, op] = await tx.getAll(ref, opRef);
        const raw = current?.data();
        if (
          op?.exists ||
          !ownedLegacy(raw, integracaoId, itemId) ||
          raw?.estado !== waiting ||
          item.tags?.includes(UPTIN_PENDING_TAG) ||
          !item.status ||
          item.status === 'closed'
        )
          return;
        tx.update(ref, {
          estado: estadoFromMlStatus(item.status, item.sub_status ?? null),
          status: item.status,
          sub_status: item.sub_status ?? null,
          ultimaModificacao: Date.now(),
        });
      });
      return 'incerta';
    }
    throw err;
  }
  if (report.item_id != null && report.item_id !== itemId) {
    throw new UptinError('O Mercado Livre retornou o status de outro anúncio.');
  }
  if (report.activation_completed == null || item.status !== 'closed' || !isSource) {
    if (item.status === 'closed' && isSource) {
      throw new UptinError(
        'O anúncio de origem foi encerrado, mas o Mercado Livre ainda não confirmou a ativação das variações.',
      );
    }
    return isSource || report.date_created || report.new_items.length ? 'pendente' : 'incerta';
  }

  const replacements = new Map<string, string>();
  const newIds = new Set<string>();
  for (const row of report.new_items) {
    const oldId = variationId(row.variation_id);
    const newId = row.new_item_id;
    if (
      oldId == null ||
      typeof newId !== 'string' ||
      !itemIdPattern.test(newId) ||
      newId === itemId ||
      replacements.has(oldId) ||
      newIds.has(newId)
    ) {
      throw new UptinError(
        'O Mercado Livre retornou vínculos de migração incompletos ou duplicados.',
      );
    }
    replacements.set(oldId, newId);
    newIds.add(newId);
  }
  if (!newIds.size) throw new UptinError('O Mercado Livre ainda não informou os novos anúncios.');

  const ids = [...newIds];
  const items = new Map<string, MlItem>();
  for (let offset = 0; offset < ids.length; offset += ML_MULTIGET_MAX_IDS) {
    const batch = ids.slice(offset, offset + ML_MULTIGET_MAX_IDS);
    const response = await api.getItemsByIds(batch, [
      'id',
      'seller_id',
      'family_id',
      'family_name',
      'user_product_id',
      'status',
      'sub_status',
      'category_id',
      'tags',
      'attributes',
      'attribute_combinations',
    ]);
    for (const entry of response) {
      const result = itemSchema.safeParse(entry.body);
      if (
        entry.code !== 200 ||
        !result.success ||
        !batch.includes(result.data.id) ||
        items.has(result.data.id)
      ) {
        throw new UptinError(
          'O Mercado Livre não confirmou todos os novos anúncios. Verifique novamente.',
        );
      }
      const member = result.data;
      verifySeller(deps, member.id, member);
      if (
        !member.family_name ||
        !member.user_product_id ||
        !member.status ||
        !member.tags?.includes(UPTIN_DESTINATION_TAG) ||
        member.tags.includes(UPTIN_PENDING_TAG) ||
        (member.family_id != null && !/^\d+$/.test(String(member.family_id)))
      ) {
        throw new UptinError(
          `O Mercado Livre ainda não confirmou a família do anúncio ${member.id}.`,
        );
      }
      items.set(member.id, member);
    }
  }
  if (items.size !== ids.length)
    throw new UptinError('O Mercado Livre não retornou todos os novos anúncios.');

  const moderations = new Map(
    await Promise.all(
      [...items.values()].map(
        async (member) =>
          [
            member.id,
            await consultarModeracoes(api, member.id, member.status, member.sub_status),
          ] as const,
      ),
    ),
  );
  const now = Date.now();
  await db.runTransaction(async (tx) => {
    const [current, op] = await tx.getAll(ref, opRef);
    const raw = current?.data();
    if (raw == null) {
      if (op?.exists && operations.parse(op.data()).completed) return;
      throw new UptinError('O vínculo de origem foi removido durante a migração.');
    }
    if (!ownedLegacy(raw, integracaoId, itemId))
      throw new UptinError('O vínculo do anúncio mudou durante a migração.');
    const claim = op?.exists ? operations.parse(op.data()) : null;
    if (
      claim &&
      (claim.produtoId !== target.produtoId ||
        claim.linkDocId !== target.linkDocId ||
        claim.sellerUserId !== sellerUserId)
    ) {
      throw new UptinError('A solicitação de migração pertence a outro vínculo ou vendedor.');
    }
    await verifyUniqueSource(tx, db, integracaoId, itemId, ref.path);
    const sourceLinks = await tx.get(sourceVariations(db, ref.path));
    const sourceByPath = new Map(sourceLinks.docs.map((doc) => [doc.ref.path, doc.data()]));
    const expectedIds =
      claim?.variations.map((row) => row.id) ??
      (item.variations?.length ? undefined : [...replacements.keys()]);
    const mapped = exactMapping(item, sourceLinks.docs, integracaoId, expectedIds);
    const reportedSourceIds = (item.variations ?? []).map((row) => variationId(row.id));
    const mappedById = new Map(mapped.map((row) => [row.id, row]));
    const mappedPaths = new Set(mapped.map((row) => `${row.produtoId}/${row.linkDocId}`));
    if (
      mapped.length !== replacements.size ||
      mapped.some((row) => !replacements.has(row.id)) ||
      reportedSourceIds.some((id) => id == null || !mappedById.has(id)) ||
      claim?.variations.some((row) => {
        const current = mappedById.get(row.id);
        return current?.produtoId !== row.produtoId || current.linkDocId !== row.linkDocId;
      }) ||
      sourceLinks.docs.some(
        (snap) =>
          snap.data().itemId ||
          (snap.data().contaOuterRef != null &&
            !refMatchesIntegracao(snap.data().contaOuterRef, integracaoId)) ||
          (snap.data().id != null &&
            !mappedPaths.has(`${snap.ref.parent.parent?.id}/${snap.id}`) &&
            snap.data().status !== 'closed'),
      )
    ) {
      throw new UptinError(
        'A lista de variações do anúncio mudou ou a migração está incompleta. Revise os vínculos.',
      );
    }
    await verifyProducts(tx, db, target.produtoId, mapped);

    const families = new Map<string, { member: MlItem; row: Variation }[]>();
    for (const row of mapped) {
      const member = items.get(replacements.get(row.id)!)!;
      const familyId = String(member.family_id ?? member.id);
      const members = families.get(familyId) ?? [];
      members.push({ member, row });
      families.set(familyId, members);
    }
    const foundMembers = new Map<string, QueryDocumentSnapshot[]>();
    for (let offset = 0; offset < ids.length; offset += ML_MULTIGET_MAX_IDS) {
      const query = variacaoMercadoLivreLinkCollection
        .groupQuery(db)
        .where('itemId', 'in', ids.slice(offset, offset + ML_MULTIGET_MAX_IDS));
      for (const doc of (await tx.get(query)).docs) {
        const id: unknown = doc.data().itemId;
        if (typeof id !== 'string') continue;
        const matches = foundMembers.get(id) ?? [];
        matches.push(doc);
        foundMembers.set(id, matches);
      }
    }
    const destinations = [];
    for (const [familyId, members] of families) {
      const query = produtoMercadoLivreLinkCollection.groupQuery(db).where('id', '==', familyId);
      const matches = (await tx.get(query)).docs.filter((doc) =>
        refMatchesIntegracao(doc.data().contaOuterRef, integracaoId),
      );
      const existing = matches[0];
      if (
        matches.length > 1 ||
        (existing &&
          (existing.ref.parent.parent?.id !== target.produtoId ||
            existing.data().isUserProductModel !== true))
      ) {
        throw new UptinError(`A família ${familyId} já está vinculada a outro anúncio no ERP.`);
      }
      const parent =
        existing?.ref ??
        produtoMercadoLivreLinkCollection.docRef(
          db,
          { produtoId: target.produtoId },
          `100000000000000000${familyId}`,
        );
      if (!existing && (await tx.get(parent)).exists)
        throw new UptinError(`Conflito no vínculo da família ${familyId}.`);
      const allMembers = existing ? (await tx.get(sourceVariations(db, parent.path))).docs : [];
      const existingPaths = new Set(allMembers.map((doc) => doc.ref.path));
      const memberWrites = [];
      for (const { member, row } of members) {
        const matches = foundMembers.get(member.id) ?? [];
        const memberLink = matches[0];
        if (
          matches.length > 1 ||
          (memberLink &&
            (!existingPaths.has(memberLink.ref.path) ||
              (memberLink.data().contaOuterRef != null &&
                !refMatchesIntegracao(memberLink.data().contaOuterRef, integracaoId)) ||
              memberLink.ref.parent.parent?.id !== row.produtoId)) ||
          allMembers.some(
            (doc) =>
              doc.ref.parent.parent?.id === row.produtoId && doc.ref.path !== memberLink?.ref.path,
          )
        ) {
          throw new UptinError(
            `O novo anúncio ${member.id} já possui um vínculo incompatível no ERP.`,
          );
        }
        const memberRef =
          memberLink?.ref ??
          variacaoMercadoLivreLinkCollection.docRef(
            db,
            { produtoId: row.produtoId },
            idLocalMercadoLivre(parent.id, member.id),
          );
        if (!memberLink && (await tx.get(memberRef)).exists)
          throw new UptinError(`Conflito no vínculo da variação ${member.id}.`);
        const old = sourceByPath.get(
          variacaoMercadoLivreLinkCollection.docPath({ produtoId: row.produtoId }, row.linkDocId),
        );
        memberWrites.push({
          ref: memberRef,
          data: {
            ...old,
            ...memberLink?.data(),
            id: null,
            itemId: member.id,
            userProductId: member.user_product_id,
            contaOuterRef: toOuterRef(`integracao/${integracaoId}`),
            produtoMercadoLivreOuterRef: toOuterRef(parent.path),
            produtoVariacaoOuterRef: toOuterRef(`produtos/${row.produtoId}`),
            sku: skuFromAttributes(member.attributes) ?? old?.sku ?? null,
            skuPaiAtributo: skuPaiFromAttributes(member.attributes) != null,
            attributes: member.attribute_combinations ?? old?.attributes ?? null,
            category_id: member.category_id ?? null,
            status: member.status ?? null,
            sub_status: member.sub_status ?? null,
            moderacoes: moderations.get(member.id) ?? null,
            estado: null,
            errors: null,
            causas: null,
          },
        });
      }
      const updated = new Set(memberWrites.map((write) => write.ref.path));
      const facts = [
        ...allMembers.filter((doc) => !updated.has(doc.ref.path)).map((doc) => doc.data()),
        ...memberWrites.map((write) => write.data),
      ];
      const folded = foldFamilyStatus(
        facts.map((fact) => ({
          status: fact.status ?? null,
          subStatus: fact.sub_status ?? null,
          moderacoes: fact.moderacoes ?? null,
        })),
      );
      const category = foldFamilyCategoria(
        facts.map((fact) => ({
          status: fact.status ?? null,
          subStatus: fact.sub_status ?? null,
          categoria: fact.category_id ?? null,
        })),
      );
      if (!folded)
        throw new UptinError(
          `O Mercado Livre ainda não confirmou o estado da família ${familyId}.`,
        );
      destinations.push({
        parent,
        memberWrites,
        data: {
          ...raw,
          ...existing?.data(),
          contaOuterRef: toOuterRef(`integracao/${integracaoId}`),
          id: familyId,
          title: members[0]!.member.family_name,
          category_id: category ?? existing?.data().category_id ?? raw.category_id ?? null,
          isUserProductModel: true,
          ...(families.size > 1 ? { uptinSomenteMembros: true } : {}),
          userProductId: null,
          precoPublicado: null,
          estado: estadoFromMlStatus(folded.status, folded.subStatus),
          status: folded.status,
          sub_status: folded.subStatus,
          moderacoes: folded.moderacoes,
          errors: null,
          causas: null,
          ultimaModificacao: now,
        },
      });
    }

    for (const destination of destinations) {
      tx.set(destination.parent, produtoMercadoLivreLinkCollection.parse(destination.data));
      for (const member of destination.memberWrites) {
        tx.set(member.ref, variacaoMercadoLivreLinkCollection.parse(member.data));
      }
    }
    for (const oldLink of sourceLinks.docs) tx.delete(oldLink.ref);
    tx.delete(ref);
    tx.set(
      opRef,
      operations.parse({
        ...target,
        sellerUserId,
        previousState: null,
        attempt: claim?.attempt ?? '',
        claimedAt: claim?.claimedAt ?? now,
        dispatching: true,
        completed: true,
        variations: [],
      }),
    );
  });
  return 'concluida';
}

export function isUptinTarget(
  target: UptinSourceLink & { integracaoId: string; itemId: unknown },
): target is UptinSourceLink & { integracaoId: string; itemId: string } {
  return (
    !naoDocId(target.integracaoId) &&
    !naoDocId(target.produtoId) &&
    !naoDocId(target.linkDocId) &&
    typeof target.itemId === 'string' &&
    itemIdPattern.test(target.itemId)
  );
}
