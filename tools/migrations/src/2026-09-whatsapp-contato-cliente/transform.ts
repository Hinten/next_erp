import { createHash } from 'node:crypto';
import { normalizeTelefoneInternacional } from '@delfrance/core/phone';
import { coerceToMillis } from '@delfrance/core/datetime';
import {
  ORIGEM_CONVERSA,
  ESTADO_ENVIO,
  TIPO_MENSAGEM,
  INTEGRACAO_TIPO,
  integracaoTipoSchema,
  clienteSchema,
  parseRef,
} from '@delfrance/schemas';

/** All data arrives losslessly encoded by codec.ts. Unknown fields stay opaque. */
export type Raw = Record<string, unknown>;
export interface SourceDocument {
  path: string;
  data: Raw;
}
export interface MigrationConflict {
  path: string;
  reason: string;
}
export interface ClienteDecision {
  /** Explicitly picked existing cliente; never inferred from a display name. */
  clienteId?: string;
  /** Explicit new cliente, shared by every conversa naming this decision. */
  novo?: { decisionId: string; fields: Raw };
}
export interface MigrationDecisions {
  clientes?: Record<string, ClienteDecision>;
  /** canonical chat id -> source chat id for the coherent operator state. */
  estado?: Record<string, string>;
  /** canonical chat id -> source chat id for the CURRENT reply endpoint. */
  destino?: Record<string, string>;
  /** Complete raw override for a conflicted destination doc, human reviewed. */
  documentos?: Record<string, Raw>;
  /** Retirement is explicit; selecting a reply endpoint never retires another. */
  identidades?: Record<string, { ativa: boolean; sucessoraId: string | null }>;
  telefones?: Record<string, { principal?: string; historicos?: string[] }>;
}
export interface PlannedWrite {
  path: string;
  before: Raw | null;
  after: Raw;
}
export interface WhatsappMigrationPlan {
  version: 1;
  projectId: string;
  sources: SourceDocument[];
  writes: PlannedWrite[];
  deletes: string[];
  conflicts: MigrationConflict[];
  pending: MigrationConflict[];
  paths: Record<string, string>;
}

export class WhatsappMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhatsappMigrationError';
  }
}

/** Strict structural equality: '01' != '1', null != absent, arrays keep order. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Raw)[key])}`)
      .join(',')}}`;
  }
  throw new WhatsappMigrationError('Valor não codificado no manifesto.');
}

export function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
export function fingerprint(value: unknown): string {
  return hash(stableJson(value));
}
export const registryId = (integracaoId: string, clienteId: string): string =>
  hash(JSON.stringify([integracaoId, clienteId]));
export const phoneIdentityId = (integracaoId: string, telefone: string): string =>
  hash(JSON.stringify([integracaoId, 'telefone', telefone]));
export const providerMessageId = (integracaoId: string, mid: string): string =>
  hash(`documents/integracao/${integracaoId}-${mid}`);

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;
const ms = (value: unknown): number | null => coerceToMillis(value);

export function refId(value: unknown, collections: readonly string[]): string | null {
  if (typeof value !== 'string') return null;
  const parsed = parseRef(value);
  return collections.includes(parsed.collection) && parsed.id !== '' ? parsed.id : null;
}

/** Provider phone is already international. Never apply a BR country-code guess. */
export function phoneFromConversa(data: Raw): string | null {
  const sender = text(data.sender_id);
  if (sender == null) return null;
  const phone = sender.slice(sender.indexOf('_') + 1);
  return sender.includes('_') ? normalizeTelefoneInternacional(phone) : null;
}

const OPERATOR_FIELDS = [
  'estadoConversa',
  'usuarios',
  'atendido',
  'cor_etiqueta',
  'respostaBloqueada',
  'pedidoOuterRef',
  'incidenteOuterRef',
  'produtoOuterRef',
] as const;
const IDENTITY_FIELDS = new Set([
  'clienteOuterRef',
  'usarioOuterRef',
  'sender_id',
  'externalLink',
  'id',
  'integracaoOuterRef',
  'nome',
  'urlAvatar',
  'data_cadastro',
  'ultima_modificacao',
  'ultimaModificacaoIntegracao',
  'prazo_resposta',
  'whatsappDestino',
  'mensagensId',
  'mensagensIdMap',
  ...OPERATOR_FIELDS,
]);

function equal(a: unknown, b: unknown): boolean {
  return a === undefined || b === undefined ? a === b : stableJson(a) === stableJson(b);
}

/** No broad normalisation: exact whole-path strings and native DocumentReferences only. */
export function rewriteReferences(
  value: unknown,
  paths: Readonly<Record<string, string>>,
): unknown {
  if (typeof value === 'string') {
    const prefix = value.startsWith('documents/') ? 'documents/' : '';
    const raw = prefix ? value.slice(prefix.length) : value;
    return paths[raw] ? `${prefix}${paths[raw]}` : value;
  }
  if (Array.isArray(value)) return value.map((v) => rewriteReferences(v, paths));
  if (value !== null && typeof value === 'object') {
    const out: Raw = {};
    for (const [key, v] of Object.entries(value)) out[key] = rewriteReferences(v, paths);
    return out;
  }
  return value;
}

/** Same wamid can merge delivery metadata, never differing message content. */
function mergeMessage(a: Raw, b: Raw, path: string, conflicts: MigrationConflict[]): Raw {
  const mutable = new Set(['estadoEnvio', 'lastExternalUpdateDateTime', 'visualizado', 'errors']);
  const out = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (mutable.has(key)) continue;
    if (out[key] === undefined) out[key] = value;
    else if (!equal(out[key], value))
      conflicts.push({ path, reason: `Mesmo mid, conteúdo divergente: ${key}` });
  }
  const aClock = ms(a.lastExternalUpdateDateTime);
  const bClock = ms(b.lastExternalUpdateDateTime);
  if (!equal(a.estadoEnvio, b.estadoEnvio)) {
    if (aClock === bClock || aClock === null || bClock === null) {
      conflicts.push({
        path,
        reason: 'Mesmo mid, estado de entrega sem relógio que resolva o conflito',
      });
    } else if (bClock > aClock) out.estadoEnvio = b.estadoEnvio;
  }
  for (const field of ['lastExternalUpdateDateTime', 'visualizado']) {
    const values = [ms(a[field]), ms(b[field])].filter((v): v is number => v !== null);
    if (values.length) out[field] = Math.max(...values);
  }
  const errors = [
    ...(Array.isArray(a.errors) ? a.errors : []),
    ...(Array.isArray(b.errors) ? b.errors : []),
  ];
  if (errors.length) out.errors = [...new Map(errors.map((e) => [stableJson(e), e])).values()];
  return out;
}

interface Group {
  integracaoId: string;
  clienteId: string;
  conversas: SourceDocument[];
}

/**
 * The only automatic cliente associations use persisted explicit refs or a unique
 * legacy userCliente link. Phone-only candidates are reported for human linkage.
 * A reviewed decision is the sole way to mint a cliente during this migration.
 */
export function planWhatsappMigration(
  projectId: string,
  documents: readonly SourceDocument[],
  decisions: MigrationDecisions = {},
): WhatsappMigrationPlan {
  const existing = new Map(documents.map((d) => [d.path, d.data]));
  const targets = new Map<string, Raw>();
  const conflicts: MigrationConflict[] = [];
  const pending: MigrationConflict[] = [];
  const paths: Record<string, string> = {};
  const groups = new Map<string, Group>();
  const del = new Set<string>();
  const clientes = documents.filter((d) => /^clientes\/[^/]+$/.test(d.path));
  const chats = documents.filter(
    (d) => /^chat\/[^/]+$/.test(d.path) && d.data.origem === ORIGEM_CONVERSA.whatsapp,
  );
  for (const [clienteId, choice] of Object.entries(decisions.telefones ?? {})) {
    const path = `clientes/${clienteId}`;
    const before = existing.get(path);
    if (!before)
      throw new WhatsappMigrationError(`Decisão de telefone para cliente inexistente: ${path}`);
    const after = { ...before };
    if (choice.principal !== undefined) {
      const principal = normalizeTelefoneInternacional(choice.principal);
      if (!principal) throw new WhatsappMigrationError(`Telefone principal inválido: ${path}`);
      after.telefone = principal;
    }
    if (choice.historicos) {
      const previous = Array.isArray(before.telefonesAdicionais) ? before.telefonesAdicionais : [];
      const historical = choice.historicos.map(normalizeTelefoneInternacional);
      if (historical.includes(null))
        throw new WhatsappMigrationError(`Telefone histórico inválido: ${path}`);
      after.telefonesAdicionais = [...new Set([...previous, ...historical])];
    }
    after.telefoneGerenciado = true;
    targets.set(path, after);
  }
  for (const conversa of chats) {
    const chatId = conversa.path.split('/')[1]!;
    const integration = refId(conversa.data.integracaoOuterRef, ['integracao']);
    if (integration == null || !existing.has(`integracao/${integration}`)) {
      conflicts.push({ path: conversa.path, reason: 'Integração ausente ou inválida' });
      continue;
    }
    const integrationType = integracaoTipoSchema.safeParse(
      existing.get(`integracao/${integration}`)?.tipo,
    );
    if (!integrationType.success || integrationType.data !== INTEGRACAO_TIPO.whatsapp) {
      conflicts.push({
        path: conversa.path,
        reason: 'Integração sem tipo WhatsApp comprovado; revisar a conta e sua referência',
      });
      continue;
    }
    const decision = decisions.clientes?.[chatId];
    let clienteId = decision?.clienteId ?? refId(conversa.data.clienteOuterRef, ['clientes']);
    if (decision?.novo) {
      clienteId = hash(JSON.stringify(['whatsapp-migration-cliente', decision.novo.decisionId]));
      const parsed = clienteSchema.safeParse(decision.novo.fields);
      if (!parsed.success) {
        conflicts.push({
          path: conversa.path,
          reason: 'Campos do novo cliente não satisfazem clienteSchema',
        });
        continue;
      }
      const targetPath = `clientes/${clienteId}`;
      if (targets.has(targetPath) && !equal(targets.get(targetPath), parsed.data)) {
        conflicts.push({ path: targetPath, reason: 'decisionId reutilizado com dados diferentes' });
      }
      targets.set(targetPath, parsed.data);
    }
    if (clienteId == null) {
      const usuarioId = refId(conversa.data.usarioOuterRef, ['usuarios', 'user']);
      const claims =
        usuarioId == null
          ? []
          : clientes.filter((c) => refId(c.data.userCliente, ['usuarios', 'user']) === usuarioId);
      if (claims.length === 1) clienteId = claims[0]!.path.split('/')[1]!;
      else {
        pending.push({
          path: conversa.path,
          reason:
            claims.length > 1
              ? `Vínculo legado ambíguo: ${claims.map((c) => c.path).join(', ')}`
              : 'Sem vínculo comprovado; selecionar cliente ou novo cliente explicitamente',
        });
        continue;
      }
    }
    if (!existing.has(`clientes/${clienteId}`) && !targets.has(`clientes/${clienteId}`)) {
      conflicts.push({ path: conversa.path, reason: `Cliente inexistente: ${clienteId}` });
      continue;
    }
    const key = registryId(integration, clienteId);
    const group = groups.get(key) ?? { integracaoId: integration, clienteId, conversas: [] };
    group.conversas.push(conversa);
    groups.set(key, group);
  }

  for (const [key, group] of groups) {
    const clientePath = `clientes/${group.clienteId}`;
    targets.set(clientePath, {
      ...(targets.get(clientePath) ?? existing.get(clientePath)!),
      telefoneGerenciado: true,
    });
    group.conversas.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const canonical = group.conversas[0]!;
    const canonicalId = canonical.path.split('/')[1]!;
    const stateSourceId = decisions.estado?.[canonicalId];
    const stateSource =
      group.conversas.find((c) => c.path === `chat/${stateSourceId}`) ?? canonical;
    if (stateSourceId && stateSource.path !== `chat/${stateSourceId}`) {
      conflicts.push({ path: canonical.path, reason: 'Origem do estado não pertence ao grupo' });
    }
    if (
      !stateSourceId &&
      group.conversas.some((c) => OPERATOR_FIELDS.some((f) => !equal(c.data[f], canonical.data[f])))
    ) {
      conflicts.push({
        path: canonical.path,
        reason: 'Estados operacionais divergentes; selecionar estado[canonicalId]',
      });
    }
    const destinationSourceId = decisions.destino?.[canonicalId];
    const phoneSet = new Set(group.conversas.map((c) => phoneFromConversa(c.data)));
    const destinationSource =
      group.conversas.find((c) => c.path === `chat/${destinationSourceId}`) ?? canonical;
    if (
      (phoneSet.size > 1 && !destinationSourceId) ||
      (destinationSourceId && destinationSource.path !== `chat/${destinationSourceId}`)
    ) {
      conflicts.push({
        path: canonical.path,
        reason: 'Selecionar explicitamente destino[canonicalId] para números diferentes',
      });
    }
    const phone = phoneFromConversa(destinationSource.data);
    if (phone == null)
      conflicts.push({
        path: canonical.path,
        reason: 'Destino telefônico inválido; não adivinhar BSUID a partir de sender_id',
      });
    const root = { ...canonical.data };
    for (const c of group.conversas) {
      paths[c.path] = canonical.path;
      if (c.path !== canonical.path) del.add(c.path);
      for (const [field, value] of Object.entries(c.data)) {
        if (IDENTITY_FIELDS.has(field)) continue;
        if (root[field] === undefined) root[field] = value;
        else if (!equal(root[field], value))
          conflicts.push({ path: canonical.path, reason: `Campo não combinável: ${field}` });
      }
    }
    for (const f of OPERATOR_FIELDS) {
      if (stateSource.data[f] !== undefined) root[f] = stateSource.data[f];
      else delete root[f];
    }
    for (const f of [
      'sender_id',
      'externalLink',
      'id',
      'ultimaModificacaoIntegracao',
      'prazo_resposta',
    ]) {
      if (destinationSource.data[f] !== undefined) root[f] = destinationSource.data[f];
      else delete root[f];
    }
    for (const f of ['data_cadastro', 'ultima_modificacao']) {
      const values = group.conversas
        .map((c) => ms(c.data[f]))
        .filter((v): v is number => v !== null);
      if (values.length)
        root[f] = f === 'data_cadastro' ? Math.min(...values) : Math.max(...values);
    }
    root.clienteOuterRef = `documents/clientes/${group.clienteId}`;
    root.integracaoOuterRef = `documents/integracao/${group.integracaoId}`;

    const groupDocuments = documents.filter((d) =>
      group.conversas.some((c) => d.path.startsWith(`${c.path}/`)),
    );
    const messages = groupDocuments.filter((d) => /^chat\/[^/]+\/mensagem\/[^/]+$/.test(d.path));
    const used = new Map<string, SourceDocument>();
    for (const message of messages.sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
      const mid = text(message.data.mid);
      const oldId = message.path.split('/')[3]!;
      let newId = mid ? providerMessageId(group.integracaoId, mid) : oldId;
      let destination = `${canonical.path}/mensagem/${newId}`;
      if (!mid && used.has(destination)) {
        newId = `migrado_${hash(message.path)}`;
        destination = `${canonical.path}/mensagem/${newId}`;
      }
      const prior = used.get(destination);
      if (prior && text(prior.data.mid) !== mid) {
        conflicts.push({ path: destination, reason: 'Colisão de ID entre mensagens distintas' });
      }
      paths[message.path] = destination;
      if (message.path !== destination) del.add(message.path);
      used.set(destination, message);
      const data = { ...message.data };
      const ownerPath = message.path.split('/').slice(0, 2).join('/');
      const ownerPhone = phoneFromConversa(existing.get(ownerPath)!);
      if (ownerPhone && data.whatsappDestino == null)
        data.whatsappDestino = {
          tipo: 'telefone',
          valor: ownerPhone,
          identidadeId: phoneIdentityId(group.integracaoId, ownerPhone),
          revision: 1,
          ultimaMensagemEm: null,
        };
      if (data.estadoEnvio === ESTADO_ENVIO.recebido) {
        data.clienteMensagemOuterRef = `documents/clientes/${group.clienteId}`;
        const snapshot = data.whatsappDestino;
        const snapshotIdentity =
          snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
            ? text((snapshot as Raw).identidadeId)
            : null;
        data.whatsappIdentidadeId =
          text(data.whatsappIdentidadeId) ??
          snapshotIdentity ??
          (ownerPhone ? phoneIdentityId(group.integracaoId, ownerPhone) : null);
      } else {
        data.whatsappIdentidadeId = null;
      }
      // Historical pending sends must be deliberately resolved before consumers resume.
      if (
        !mid &&
        (data.estadoEnvio === ESTADO_ENVIO.salva || data.estadoEnvio === ESTADO_ENVIO.enviando) &&
        data.tipo !== 'e' &&
        data.tipo !== '!'
      ) {
        conflicts.push({
          path: destination,
          reason: 'Envio pendente sem mid; reconciliar antes da migração',
        });
      }
      const accumulated = targets.get(destination);
      targets.set(
        destination,
        accumulated && mid ? mergeMessage(accumulated, data, destination, conflicts) : data,
      );
      if (mid)
        targets.set(`whatsappMensagens/${providerMessageId(group.integracaoId, mid)}`, {
          integracaoId: group.integracaoId,
          conversaId: canonicalId,
          mensagemId: newId,
        });
    }
    const ids: string[] = [];
    const idMap: Raw = {};
    for (const c of group.conversas) {
      const remapId = (id: string): string =>
        paths[`${c.path}/mensagem/${id}`]?.split('/')[3] ?? id;
      if (Array.isArray(c.data.mensagensId))
        for (const id of c.data.mensagensId) {
          if (typeof id !== 'string')
            conflicts.push({
              path: canonical.path,
              reason: 'mensagensId contém valor não textual',
            });
          else ids.push(remapId(id));
        }
      if (
        c.data.mensagensIdMap !== null &&
        typeof c.data.mensagensIdMap === 'object' &&
        !Array.isArray(c.data.mensagensIdMap)
      ) {
        for (const [id, value] of Object.entries(c.data.mensagensIdMap)) {
          const mapped = remapId(id);
          if (mapped in idMap && !equal(idMap[mapped], value))
            conflicts.push({
              path: canonical.path,
              reason: `mensagensIdMap divergente: ${mapped}`,
            });
          else idMap[mapped] = value;
        }
      }
    }
    if (ids.length) root.mensagensId = [...new Set(ids)];
    if (Object.keys(idMap).length) root.mensagensIdMap = idMap;
    // Copy arbitrary descendants, including subcollections beneath mensagem.
    for (const doc of groupDocuments.filter((d) => !messages.includes(d))) {
      const ancestor = Object.keys(paths)
        .filter((p) => doc.path.startsWith(`${p}/`))
        .sort((a, b) => b.length - a.length)[0]!;
      const dest = `${paths[ancestor]}${doc.path.slice(ancestor.length)}`;
      paths[doc.path] = dest;
      if (doc.path !== dest) del.add(doc.path);
      const previous = targets.get(dest);
      if (previous && !equal(previous, doc.data))
        conflicts.push({
          path: dest,
          reason: 'Subcoleção desconhecida com documentos divergentes',
        });
      else targets.set(dest, doc.data);
    }
    // Seed every phone identity. Historical extra numbers must not resolve automatically.
    for (const c of group.conversas) {
      const cPhone = phoneFromConversa(c.data);
      if (!cPhone) {
        conflicts.push({ path: c.path, reason: 'Telefone legado inválido' });
        continue;
      }
      const identityId = phoneIdentityId(group.integracaoId, cPhone);
      const identityPath = `whatsappIdentidades/${identityId}`;
      const identityDecision = decisions.identidades?.[identityId];
      const manuallyConfirmed =
        Boolean(decisions.clientes?.[c.path.split('/')[1]!] || identityDecision) ||
        existing.get(identityPath)?.confirmadaManualmente === true ||
        targets.get(identityPath)?.confirmadaManualmente === true;
      const cliente =
        targets.get(`clientes/${group.clienteId}`) ?? existing.get(`clientes/${group.clienteId}`)!;
      const clientePhone = text(cliente.telefone);
      const identity = {
        escopo: group.integracaoId,
        tipo: 'telefone',
        valor: cPhone,
        clienteId: group.clienteId,
        confirmadaManualmente: manuallyConfirmed,
        ativa: identityDecision?.ativa ?? true,
        sucessoraId: identityDecision?.sucessoraId ?? null,
        ultimaTransicaoEm: null,
        telefoneClienteNoVinculo: clientePhone
          ? normalizeTelefoneInternacional(clientePhone)
          : null,
      };
      if (cPhone === phone && !identity.ativa)
        conflicts.push({
          path: canonical.path,
          reason: 'Destino escolhido aponta para identidade aposentada',
        });
      const previous = targets.get(identityPath);
      if (previous && !equal(previous.clienteId, identity.clienteId)) {
        conflicts.push({
          path: identityPath,
          reason: 'Telefone reivindicado por clientes diferentes',
        });
      } else targets.set(identityPath, identity);
    }
    if (phone) {
      const endpointMessages = messages.filter((d) => {
        const snapshot = d.data.whatsappDestino;
        const messagePhone =
          snapshot && typeof snapshot === 'object'
            ? text((snapshot as Raw).valor)
            : phoneFromConversa(existing.get(d.path.split('/').slice(0, 2).join('/'))!);
        return messagePhone === phone && d.data.estadoEnvio === ESTADO_ENVIO.recebido;
      });
      const identifiedTimes = endpointMessages
        .map((d) => ms(d.data.timestamp))
        .filter((v): v is number => v !== null);
      const incomingTimes = endpointMessages
        .filter((d) => d.data.tipo !== TIPO_MENSAGEM.evento && d.data.tipo !== TIPO_MENSAGEM.erro)
        .map((d) => ms(d.data.timestamp))
        .filter((v): v is number => v !== null);
      const previousDestination = root.whatsappDestino;
      const previousIdentityClock =
        previousDestination &&
        typeof previousDestination === 'object' &&
        (previousDestination as Raw).valor === phone
          ? ms((previousDestination as Raw).ultimaIdentificacaoEm)
          : null;
      if (previousIdentityClock != null) identifiedTimes.push(previousIdentityClock);
      const revision =
        previousDestination &&
        typeof previousDestination === 'object' &&
        (previousDestination as Raw).valor === phone
          ? (previousDestination as Raw).revision
          : 1;
      root.whatsappDestino = {
        tipo: 'telefone',
        valor: phone,
        identidadeId: phoneIdentityId(group.integracaoId, phone),
        revision,
        ultimaMensagemEm: incomingTimes.length ? Math.max(...incomingTimes) : null,
        ultimaIdentificacaoEm: identifiedTimes.length ? Math.max(...identifiedTimes) : null,
      };
      root.prazo_resposta = incomingTimes.length ? Math.max(...incomingTimes) + 86400000 : null;
    }
    targets.set(canonical.path, root);
    targets.set(`whatsappConversas/${key}`, {
      integracaoId: group.integracaoId,
      clienteId: group.clienteId,
      conversaId: canonicalId,
    });
    for (const c of group.conversas) {
      const oldChatId = c.path.split('/')[1]!;
      const movedMessages = messages.filter(
        (m) => m.path.startsWith(`${c.path}/`) && paths[m.path] !== m.path,
      );
      if (c.path !== canonical.path || movedMessages.length) {
        targets.set(`whatsappConversaAliases/${oldChatId}`, {
          conversaId: canonicalId,
          integracaoId: group.integracaoId,
          clienteId: group.clienteId,
        });
        for (const message of movedMessages)
          targets.set(
            `whatsappConversaAliases/${oldChatId}/mensagens/${message.path.split('/')[3]!}`,
            {
              conversaId: canonicalId,
              mensagemId: paths[message.path]!.split('/')[3]!,
            },
          );
      }
    }
  }

  // Rewrite refs also in unaffected channels' chat docs, never inspect credentials.
  for (const doc of documents.filter((d) => d.path.startsWith('chat/') && !del.has(d.path))) {
    if (!targets.has(doc.path)) {
      const data = rewriteReferences(doc.data, paths) as Raw;
      if (!equal(data, doc.data)) targets.set(doc.path, data);
    }
  }
  for (const [path, data] of targets) targets.set(path, rewriteReferences(data, paths) as Raw);
  // Explicit whole-document conflict decisions never alter the chosen routing keys.
  for (const [path, data] of Object.entries(decisions.documentos ?? {})) {
    if (!targets.has(path))
      throw new WhatsappMigrationError(`Override sem documento planejado: ${path}`);
    const protectedKeys = [
      'clienteId',
      'integracaoId',
      'conversaId',
      'clienteOuterRef',
      'integracaoOuterRef',
      'mid',
      'whatsappDestino',
      'whatsappIdentidadeId',
      'confirmadaManualmente',
      'sender_id',
    ];
    if (protectedKeys.some((f) => !equal(data[f], targets.get(path)![f]))) {
      throw new WhatsappMigrationError(`Override altera identidade protegida: ${path}`);
    }
    targets.set(path, data);
    for (let i = conflicts.length - 1; i >= 0; i--)
      if (conflicts[i]!.path === path) conflicts.splice(i, 1);
  }
  const writes = [...targets.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'en'))
    .flatMap(([path, after]) => {
      const before = existing.get(path) ?? null;
      if (before && equal(before, after)) return [];
      // Registry ownership is not something a migration may silently replace.
      if (before && path.startsWith('whatsapp') && !equal(before, after)) {
        conflicts.push({ path, reason: 'Registro WhatsApp já existe com valor diferente' });
      }
      return [{ path, before, after }];
    });
  // A target path can also be a source path after a rename collision. Never delete it.
  for (const path of targets.keys()) del.delete(path);
  return {
    version: 1,
    projectId,
    sources: [...documents],
    writes,
    deletes: [...del].sort(),
    conflicts,
    pending,
    paths,
  };
}
