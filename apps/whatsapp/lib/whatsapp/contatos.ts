import type { Firestore, Transaction } from 'firebase-admin/firestore';
import {
  clienteCollection,
  conversaCollection,
  mensagemCollection,
  integracaoCollection,
  whatsappIdentidadeCollection,
  whatsappConversaCollection,
} from '@delfrance/data/admin/collections';
import { normalizeTelefoneInternacional, telefoneQueryShapes } from '@delfrance/core/phone';
import { corToEtiquetaArgb } from '@delfrance/core/cor';
import {
  ESTADO_CONVERSA,
  ESTADO_ENVIO,
  ORIGEM_CONVERSA,
  TIPO_MENSAGEM,
  type Cliente,
  type Integracao,
  type WhatsappDestino,
  buildClienteTelefonePatch,
  ClienteTelefoneConflitoError,
} from '@delfrance/schemas';
import { sha256Hex } from './ids';

export interface ContatoWhatsapp {
  integracaoId: string;
  portfolioId: string | null;
  bsuid: string | null;
  telefone: string | null;
  nome: string | null;
  timestamp: number;
}
export interface IdentidadeWhatsapp {
  id: string;
  escopo: string;
  tipo: 'bsuid' | 'telefone';
  valor: string;
}
export interface ContatoResolvido {
  kind: 'resolved';
  clienteId: string;
  conversaId: string;
  nome: string;
  destino: WhatsappDestino;
}
export type ResolucaoContato = ContatoResolvido | { kind: 'pending'; motivo: string };
export class WhatsappVinculoConflitoError extends Error {
  constructor(
    message: string,
    readonly clienteId: string | null = null,
    readonly conversaId: string | null = null,
  ) {
    super(message);
    this.name = 'WhatsappVinculoConflitoError';
  }
}
export function identidadeWhatsappId(escopo: string, tipo: string, valor: string): string {
  return sha256Hex(JSON.stringify([escopo, tipo, valor]));
}
export function conversaWhatsappKey(integracaoId: string, clienteId: string): string {
  return sha256Hex(JSON.stringify([integracaoId, clienteId]));
}
export function vinculoWhatsappId(contato: ContatoWhatsapp): string {
  return identidadeWhatsappId(
    contato.integracaoId,
    contato.bsuid ? 'bsuid' : 'telefone',
    contato.bsuid ?? contato.telefone ?? '',
  );
}
export function identidadesDoContato(contato: ContatoWhatsapp): IdentidadeWhatsapp[] {
  const result: IdentidadeWhatsapp[] = [];
  if (contato.bsuid && contato.portfolioId)
    result.push({
      id: identidadeWhatsappId(contato.portfolioId, 'bsuid', contato.bsuid),
      escopo: contato.portfolioId,
      tipo: 'bsuid',
      valor: contato.bsuid,
    });
  if (contato.telefone)
    result.push({
      id: identidadeWhatsappId(contato.integracaoId, 'telefone', contato.telefone),
      escopo: contato.integracaoId,
      tipo: 'telefone',
      valor: contato.telefone,
    });
  return result;
}
export function nomeIdentificado(nome: string | null | undefined, recebido: string | null): string {
  return !nome || ['anônimo', 'anonimo'].includes(nome.toLowerCase())
    ? recebido || nome || 'Cliente'
    : nome;
}
export function telefoneAtual(cliente: Pick<Cliente, 'telefone'>): string | null {
  return normalizeTelefoneInternacional(cliente.telefone ?? '');
}
export async function clientesPorTelefone(tx: Transaction, db: Firestore, telefone: string) {
  return tx.get(
    clienteCollection
      .ref(db, {})
      .where('telefone', 'in', telefoneQueryShapes('+' + telefone))
      .limit(2),
  );
}

/** Reads the reservation and conversation before returning a write closure. */
export async function prepararConversa(
  tx: Transaction,
  db: Firestore,
  contato: ContatoWhatsapp,
  clienteId: string,
  nome: string,
  conta: Integracao,
  identidade: IdentidadeWhatsapp,
  podeAtualizarDestino: boolean,
  options: { predecessorId?: string; ultimaMensagemEm?: number | null } = {},
) {
  const key = conversaWhatsappKey(contato.integracaoId, clienteId);
  const claimRef = whatsappConversaCollection.docRef(db, {}, key);
  const claim = await tx.get(claimRef);
  const conversaId = claim.exists
    ? String(claim.data()?.conversaId)
    : sha256Hex(JSON.stringify(['whatsapp', contato.integracaoId, clienteId]));
  const conversaRef = conversaCollection.docRef(db, {}, conversaId);
  const snap = await tx.get(conversaRef);
  const current = snap.exists ? conversaCollection.parseRead(snap.data()) : null;
  const previous = current?.whatsappDestino ?? null;
  const changesIdentity = !previous || previous.identidadeId !== identidade.id;
  const identityClock = previous?.ultimaIdentificacaoEm ?? previous?.ultimaMensagemEm ?? -1;
  const newer = !previous || contato.timestamp > identityClock;
  const verifiedTie =
    options.predecessorId === previous?.identidadeId && contato.timestamp === identityClock;
  const messageClock = Object.hasOwn(options, 'ultimaMensagemEm')
    ? (options.ultimaMensagemEm ?? null)
    : contato.timestamp;
  const refreshWindow =
    !options.predecessorId &&
    !changesIdentity &&
    messageClock != null &&
    messageClock > (previous?.ultimaMensagemEm ?? -1);
  const update = !previous || (podeAtualizarDestino && (newer || verifiedTie || refreshWindow));
  const destino: WhatsappDestino = update
    ? {
        tipo: identidade.tipo,
        valor: identidade.valor,
        identidadeId: identidade.id,
        revision: (previous?.revision ?? 0) + (changesIdentity ? 1 : 0),
        ultimaIdentificacaoEm: Math.max(identityClock, contato.timestamp),
        ultimaMensagemEm: options.predecessorId
          ? changesIdentity
            ? null
            : (previous?.ultimaMensagemEm ?? null)
          : !changesIdentity && previous?.ultimaMensagemEm != null
            ? Math.max(previous.ultimaMensagemEm, messageClock ?? -1)
            : messageClock,
      }
    : previous;
  return {
    conversaId,
    destino,
    write() {
      if (!claim.exists)
        tx.create(
          claimRef,
          whatsappConversaCollection.parse({
            integracaoId: contato.integracaoId,
            clienteId,
            conversaId,
          }),
        );
      if (!snap.exists) {
        tx.create(
          conversaRef,
          conversaCollection.parse({
            nome,
            origem: ORIGEM_CONVERSA.whatsapp,
            clienteOuterRef: 'documents/clientes/' + clienteId,
            integracaoOuterRef: 'documents/integracao/' + contato.integracaoId,
            sender_id: null,
            id: conta.phoneNumberId,
            usarioOuterRef: null,
            data_cadastro: contato.timestamp,
            ultima_modificacao: contato.timestamp,
            ultimaModificacaoIntegracao: contato.timestamp,
            prazo_resposta:
              destino.ultimaMensagemEm == null ? null : destino.ultimaMensagemEm + 86400000,
            whatsappDestino: destino,
            cor_etiqueta: corToEtiquetaArgb(conta.cor) ?? 0,
            externalLink:
              destino.tipo === 'telefone'
                ? 'https://api.whatsapp.com/send?phone=' + destino.valor
                : null,
            estadoConversa: ESTADO_CONVERSA.naoRespondido,
            atendido: false,
          }),
        );
        tx.create(
          mensagemCollection.docRef(db, { conversaId }, 'evento_nova'),
          mensagemCollection.parse({
            tipo: TIPO_MENSAGEM.evento,
            estadoEnvio: ESTADO_ENVIO.salva,
            conteudo: 'Nova conversa iniciada por ' + nome + '.',
            timestamp: contato.timestamp,
          }),
        );
      } else if (update || nomeIdentificado(current?.nome, nome) !== current?.nome) {
        tx.update(conversaRef, {
          nome: nomeIdentificado(current?.nome, nome),
          whatsappDestino: destino,
          externalLink:
            destino.tipo === 'telefone'
              ? 'https://api.whatsapp.com/send?phone=' + destino.valor
              : null,
          prazo_resposta:
            destino.ultimaMensagemEm == null ? null : destino.ultimaMensagemEm + 86400000,
        });
      }
    },
  };
}

/** Replay authorization participates in the transaction that would change identity/chat state. */
export type ValidarReplayContato = (
  tx: Transaction,
  planned: { clienteId: string; conversaId: string },
) => Promise<void>;

/** Every identity proof and canonical reservation is read in the winning transaction. */
export async function resolverContatoWhatsapp(
  db: Firestore,
  contato: ContatoWhatsapp,
  validarReplay?: ValidarReplayContato,
  options: { ultimaMensagemEm?: number | null } = {},
): Promise<ResolucaoContato> {
  if (contato.bsuid && !contato.portfolioId)
    return {
      kind: 'pending',
      motivo: 'Configure o portfólio empresarial da integração para identificar este BSUID.',
    };
  const specs = identidadesDoContato(contato);
  if (!specs.length) return { kind: 'pending', motivo: 'Contato sem identidade utilizável.' };
  return db.runTransaction(async (tx) => {
    const contaSnap = await tx.get(integracaoCollection.docRef(db, {}, contato.integracaoId));
    if (!contaSnap.exists) return { kind: 'pending', motivo: 'Integração não encontrada.' };
    const conta = integracaoCollection.parseRead(contaSnap.data());
    if (contato.bsuid && conta.portfolioId !== contato.portfolioId)
      return { kind: 'pending', motivo: 'O portfólio da integração mudou; reprocesse a mensagem.' };
    const snaps = await Promise.all(
      specs.map((spec) => tx.get(whatsappIdentidadeCollection.docRef(db, {}, spec.id))),
    );
    const identities = snaps.map((snap) =>
      snap.exists ? whatsappIdentidadeCollection.parseRead(snap.data()) : null,
    );
    const primaryIdentity = identities[0];
    const ignoredPhoneIds = new Set(
      primaryIdentity?.tipo === 'bsuid' &&
        primaryIdentity.ativa &&
        primaryIdentity.confirmadaManualmente
        ? primaryIdentity.aliasesTelefoneIgnorados
        : [],
    );
    const ignorePhone = (index: number) =>
      specs[index]?.tipo === 'telefone' && ignoredPhoneIds.has(specs[index]!.id);
    const effectiveIdentities = identities.filter((_, index) => !ignorePhone(index));
    const ids = new Set(
      effectiveIdentities
        .filter(
          (identity) =>
            identity && (identity.ativa || (identity.tipo === 'bsuid' && identity.sucessoraId)),
        )
        .map((identity) => identity!.clienteId),
    );
    if (ids.size > 1)
      return { kind: 'pending', motivo: 'Identidades vinculadas a clientes diferentes.' };
    const candidates =
      contato.telefone &&
      !specs.some((spec, index) => spec.tipo === 'telefone' && ignorePhone(index))
        ? await clientesPorTelefone(tx, db, contato.telefone)
        : null;
    // Only the received phone's own confirmation can override its cadastro ambiguity.
    // A reviewed BSUID may ignore the specific phone aliases filtered above, not new ones.
    const phoneManuallyConfirmed = effectiveIdentities.some(
      (identity) =>
        identity?.tipo === 'telefone' && identity.ativa && identity.confirmadaManualmente,
    );
    if (!phoneManuallyConfirmed && candidates && candidates.size > 1)
      return { kind: 'pending', motivo: 'Telefone corresponde a vários clientes.' };
    const candidateId = candidates?.docs[0]?.id ?? null;
    let clienteId = [...ids][0] ?? null;
    if (!phoneManuallyConfirmed && clienteId && candidateId && clienteId !== candidateId)
      return {
        kind: 'pending',
        motivo: 'Telefone e identidade WhatsApp indicam clientes diferentes.',
      };
    clienteId ??= candidateId;
    if (!clienteId)
      return {
        kind: 'pending',
        motivo: 'Nenhum cliente identificado. Escolha um cliente ou confirme um novo cadastro.',
      };
    const clienteSnap = await tx.get(clienteCollection.docRef(db, {}, clienteId));
    if (!clienteSnap.exists)
      return { kind: 'pending', motivo: 'O cliente vinculado não existe mais.' };
    const cliente = clienteCollection.parseRead(clienteSnap.data());
    const nome = nomeIdentificado(cliente.nome, contato.nome);
    const strong = effectiveIdentities.find((identity) => identity?.tipo === 'bsuid');
    for (const identity of effectiveIdentities) {
      if (
        identity?.tipo === 'telefone' &&
        (!identity.ativa || identity.telefoneClienteNoVinculo !== telefoneAtual(cliente))
      ) {
        if (!strong)
          return {
            kind: 'pending',
            motivo:
              'O vínculo deste telefone está inativo ou o cadastro mudou. Confirme o cliente.',
          };
      }
    }
    const primary = specs[0]!;
    const primaryStored = identities[0];
    const prepared = await prepararConversa(
      tx,
      db,
      contato,
      clienteId,
      nome,
      conta,
      primary,
      primaryStored?.ativa !== false,
      options,
    );
    await validarReplay?.(tx, { clienteId, conversaId: prepared.conversaId });
    // No reads after this point.
    if (nome !== cliente.nome && contato.nome)
      tx.update(clienteSnap.ref, { nome, ultimaModificacao: Date.now() });
    specs.forEach((spec, i) => {
      if (primaryStored?.ativa !== false && !ignorePhone(i) && !snaps[i]!.exists)
        tx.create(
          whatsappIdentidadeCollection.docRef(db, {}, spec.id),
          whatsappIdentidadeCollection.parse({
            escopo: spec.escopo,
            tipo: spec.tipo,
            valor: spec.valor,
            clienteId,
            ativa: true,
            sucessoraId: null,
            ultimaTransicaoEm: null,
            telefoneClienteNoVinculo: telefoneAtual(cliente),
          }),
        );
    });
    prepared.write();
    return {
      kind: 'resolved',
      clienteId,
      conversaId: prepared.conversaId,
      nome,
      destino: prepared.destino,
    };
  });
}

/** Provider transitions are conditional on BOTH their event clock and the predecessor. */
export async function aplicarTransicaoWhatsapp(
  db: Firestore,
  contato: ContatoWhatsapp,
  system: { type: string; user_id?: string; previous_user_id?: string; wa_id?: string },
  validarReplay?: ValidarReplayContato,
): Promise<ResolucaoContato> {
  const newPhone = normalizeTelefoneInternacional(system.wa_id ?? '');
  const oldValue = system.previous_user_id ?? contato.bsuid ?? contato.telefone;
  const oldType = system.previous_user_id || contato.bsuid ? 'bsuid' : 'telefone';
  const scope = oldType === 'bsuid' ? contato.portfolioId : contato.integracaoId;
  if (!oldValue || !scope || (!system.user_id && !newPhone))
    return { kind: 'pending', motivo: 'Transição de identidade incompleta; revise o contato.' };
  const nextContato = { ...contato, bsuid: system.user_id ?? null, telefone: newPhone };
  const newSpecs = identidadesDoContato(nextContato);
  if (!newSpecs.length)
    return { kind: 'pending', motivo: 'Configure o portfólio para concluir a transição.' };
  return db.runTransaction(async (tx) => {
    const oldRef = whatsappIdentidadeCollection.docRef(
      db,
      {},
      identidadeWhatsappId(scope, oldType, oldValue),
    );
    const oldSnap = await tx.get(oldRef);
    if (!oldSnap.exists) return { kind: 'pending', motivo: 'Identidade anterior não vinculada.' };
    const old = whatsappIdentidadeCollection.parseRead(oldSnap.data());
    const clienteRef = clienteCollection.docRef(db, {}, old.clienteId);
    const clienteSnap = await tx.get(clienteRef);
    const contaSnap = await tx.get(integracaoCollection.docRef(db, {}, contato.integracaoId));
    if (!clienteSnap.exists || !contaSnap.exists)
      return { kind: 'pending', motivo: 'Cliente ou integração ausente.' };
    const cliente = clienteCollection.parseRead(clienteSnap.data());
    const conta = integracaoCollection.parseRead(contaSnap.data());
    if (oldType === 'bsuid' && conta.portfolioId !== scope)
      return { kind: 'pending', motivo: 'O portfólio da integração mudou; revise a transição.' };
    const newSnaps = await Promise.all(
      newSpecs.map((spec) => tx.get(whatsappIdentidadeCollection.docRef(db, {}, spec.id))),
    );
    if (newSnaps.some((snap) => snap.exists && snap.data()?.clienteId !== old.clienteId))
      return { kind: 'pending', motivo: 'Nova identidade pertence a outro cliente.' };
    if ((old.ultimaTransicaoEm ?? -1) >= contato.timestamp) {
      const claim = await tx.get(
        whatsappConversaCollection.docRef(
          db,
          {},
          conversaWhatsappKey(contato.integracaoId, old.clienteId),
        ),
      );
      if (!claim.exists) return { kind: 'pending', motivo: 'Conversa canônica ausente.' };
      const conv = await tx.get(
        conversaCollection.docRef(db, {}, String(claim.data()?.conversaId)),
      );
      const destino = conversaCollection.parseRead(conv.data()).whatsappDestino;
      if (!destino) return { kind: 'pending', motivo: 'Destino canônico ausente.' };
      return {
        kind: 'resolved',
        clienteId: old.clienteId,
        conversaId: conv.id,
        nome: cliente.nome ?? 'Cliente',
        destino,
      };
    }
    // A different still-active predecessor may point at an identity that already
    // completed a later transition. Its older event cannot rewind that target.
    if (
      newSnaps.some((snap) => {
        if (!snap.exists) return false;
        const target = whatsappIdentidadeCollection.parseRead(snap.data());
        const clock = target.ultimaTransicaoEm ?? -1;
        return clock > contato.timestamp || (clock === contato.timestamp && !target.ativa);
      })
    )
      return {
        kind: 'pending',
        motivo: 'A nova identidade já foi alterada por uma transição posterior. Revise o contato.',
      };
    if (!old.ativa)
      return {
        kind: 'pending',
        motivo: 'A identidade anterior já foi substituída. Revise a ordem das transições.',
      };
    let phonePatch;
    try {
      phonePatch =
        system.type === 'user_changed_user_id' && !newPhone
          ? {}
          : buildClienteTelefonePatch(cliente, {
              tipo: 'whatsapp',
              telefone: newPhone,
              telefoneAnterior: contato.telefone ?? old.telefoneClienteNoVinculo,
            });
    } catch (error) {
      if (!(error instanceof ClienteTelefoneConflitoError)) throw error;
      return { kind: 'pending', motivo: error.message };
    }
    const prepared = await prepararConversa(
      tx,
      db,
      nextContato,
      old.clienteId,
      cliente.nome ?? 'Cliente',
      conta,
      newSpecs[0]!,
      true,
      { predecessorId: oldRef.id },
    );
    const oldPhoneRef = contato.telefone
      ? whatsappIdentidadeCollection.docRef(
          db,
          {},
          identidadeWhatsappId(contato.integracaoId, 'telefone', contato.telefone),
        )
      : null;
    const oldPhone = oldPhoneRef ? await tx.get(oldPhoneRef) : null;
    await validarReplay?.(tx, { clienteId: old.clienteId, conversaId: prepared.conversaId });
    if (Object.keys(phonePatch).length)
      tx.update(clienteRef, { ...phonePatch, ultimaModificacao: Date.now() });
    if (!newSpecs.some((spec) => spec.id === oldRef.id))
      tx.update(oldRef, {
        ativa: false,
        sucessoraId: newSpecs[0]!.id,
        ultimaTransicaoEm: contato.timestamp,
      });
    if (
      oldPhoneRef &&
      oldPhone?.exists &&
      oldPhone.data()?.clienteId === old.clienteId &&
      !newSpecs.some((spec) => spec.id === oldPhoneRef.id)
    )
      tx.update(oldPhoneRef, {
        ativa: false,
        sucessoraId: newSpecs[0]!.id,
        ultimaTransicaoEm: contato.timestamp,
      });
    newSpecs.forEach((spec) =>
      tx.set(
        whatsappIdentidadeCollection.docRef(db, {}, spec.id),
        whatsappIdentidadeCollection.parse({
          escopo: spec.escopo,
          tipo: spec.tipo,
          valor: spec.valor,
          clienteId: old.clienteId,
          ativa: true,
          sucessoraId: null,
          ultimaTransicaoEm: contato.timestamp,
          telefoneClienteNoVinculo: Object.hasOwn(phonePatch, 'telefone')
            ? (phonePatch.telefone as string | null)
            : telefoneAtual(cliente),
          confirmadaManualmente: old.confirmadaManualmente,
          aliasesTelefoneIgnorados:
            spec.tipo === 'bsuid' && system.type === 'user_changed_user_id' && !newPhone
              ? old.aliasesTelefoneIgnorados
              : [],
        }),
      ),
    );
    prepared.write();
    return {
      kind: 'resolved',
      clienteId: old.clienteId,
      conversaId: prepared.conversaId,
      nome: cliente.nome ?? 'Cliente',
      destino: prepared.destino,
    };
  });
}
