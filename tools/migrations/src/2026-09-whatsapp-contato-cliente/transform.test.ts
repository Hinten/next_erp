import { describe, expect, it } from 'vitest';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import {
  fingerprint,
  hash,
  phoneIdentityId,
  planWhatsappMigration,
  providerMessageId,
  registryId,
  rewriteReferences,
  type MigrationDecisions,
  type Raw,
  type SourceDocument,
} from './transform';

const A = '5511999998888';
const B = '14155552671';
const T = 1_780_000_000_000;
const doc = (path: string, data: Raw): SourceDocument => ({ path, data });
const conversa = (phone = A, extra: Raw = {}): Raw => ({
  origem: 'whatsapp',
  integracaoOuterRef: 'documents/integracao/conta',
  clienteOuterRef: 'documents/clientes/c',
  sender_id: `5511888888888_${phone}`,
  estadoConversa: 0,
  usuarios: ['operador'],
  atendido: false,
  data_cadastro: T,
  ultima_modificacao: T,
  ...extra,
});
const mensagem = (extra: Raw = {}): Raw => ({
  tipo: 'c',
  estadoEnvio: 7,
  conteudo: 'oi',
  timestamp: T,
  ...extra,
});
const base = [
  doc('clientes/c', { nome: 'Cliente', telefone: A }),
  doc('integracao/conta', { tipo: INTEGRACAO_TIPO.whatsapp }),
];
const plan = (docs: SourceDocument[], decisions?: MigrationDecisions) =>
  planWhatsappMigration('p', [...base, ...docs], decisions);
const written = (result: ReturnType<typeof plan>, path: string) =>
  result.writes.find((w) => w.path === path)?.after;

describe('WhatsApp migration plan', () => {
  it('rejects missing, unproven or different-channel integration types without migrating their chats', () => {
    for (const fields of [
      {},
      { tipo: '6' },
      { tipo: 'whatsapp' },
      { tipo: INTEGRACAO_TIPO.mercadoLivre },
    ]) {
      const result = planWhatsappMigration('p', [
        doc('clientes/c', {}),
        doc('integracao/conta', fields),
        doc('chat/a', conversa()),
      ]);
      expect(result.conflicts[0]?.reason).toContain('tipo WhatsApp');
      expect(result.writes).toEqual([]);
      expect(result.deletes).toEqual([]);
    }
  });
  it('system events advance only the identity clock and cannot extend the customer reply window', () => {
    const result = plan([
      doc('chat/a', conversa()),
      doc('chat/a/mensagem/text', mensagem({ timestamp: T })),
      doc('chat/a/mensagem/system', mensagem({ tipo: 'e', timestamp: T + 1000 })),
    ]);
    expect(result.conflicts).toEqual([]);
    expect(written(result, 'chat/a')).toMatchObject({
      whatsappDestino: { ultimaMensagemEm: T, ultimaIdentificacaoEm: T + 1000 },
      prazo_resposta: T + 86400000,
    });
    const onlyEvent = plan([
      doc('chat/a', conversa()),
      doc('chat/a/mensagem/system', mensagem({ tipo: 'e' })),
    ]);
    expect(written(onlyEvent, 'chat/a')).toMatchObject({
      whatsappDestino: { ultimaMensagemEm: null, ultimaIdentificacaoEm: T },
      prazo_resposta: null,
    });
  });
  it('preserves exact identity equality boundaries', () => {
    expect(fingerprint({ a: 1, b: 'x' })).toBe(fingerprint({ b: 'x', a: 1 }));
    expect(fingerprint({ text: '01' })).not.toBe(fingerprint({ text: '1' }));
    expect(fingerprint({ text: '90,5' })).not.toBe(fingerprint({ text: '90,50' }));
    expect(fingerprint({ value: null })).not.toBe(fingerprint({}));
  });
  it('chooses smallest existing chat, preserves unknown trees and deep links', () => {
    const result = plan([
      doc('chat/z', conversa()),
      doc('chat/a', conversa()),
      doc(
        'chat/z/mensagem/old',
        mensagem({ mid: 'wamid.1', anexoStorage: 'arquivos/file', custom: { keep: 1 } }),
      ),
      doc('chat/z/unknown/doc/nested/child', { opaque: ['x', 2] }),
      doc(
        'chat/a/mensagem/reply',
        mensagem({ context: { mensagemOuterRef: 'documents/chat/z/mensagem/old' } }),
      ),
    ]);
    const id = providerMessageId('conta', 'wamid.1');
    expect(result.conflicts).toEqual([]);
    expect(written(result, `whatsappConversas/${registryId('conta', 'c')}`)?.conversaId).toBe('a');
    expect(written(result, `chat/a/mensagem/${id}`)).toMatchObject({
      anexoStorage: 'arquivos/file',
      custom: { keep: 1 },
    });
    expect(written(result, 'chat/a/unknown/doc/nested/child')).toEqual({ opaque: ['x', 2] });
    expect(written(result, 'chat/a/mensagem/reply')?.context).toEqual({
      mensagemOuterRef: `documents/chat/a/mensagem/${id}`,
    });
    expect(written(result, 'whatsappConversaAliases/z/mensagens/old')).toEqual({
      conversaId: 'a',
      mensagemId: id,
    });
    expect(result.deletes).toContain('chat/z');
    expect(result.deletes).not.toContain('chat/a');
  });
  it('deduplicates same wamid, but keeps equal-looking no-mid messages', () => {
    const result = plan([
      doc('chat/a', conversa()),
      doc('chat/z', conversa()),
      doc('chat/a/mensagem/m', mensagem({ mid: 'wamid.same' })),
      doc('chat/z/mensagem/m', mensagem({ mid: 'wamid.same' })),
      doc('chat/a/mensagem/evento_nova', mensagem({ tipo: 'e', mid: null })),
      doc('chat/z/mensagem/evento_nova', mensagem({ tipo: 'e', mid: null })),
    ]);
    expect(result.conflicts).toEqual([]);
    expect(result.writes.filter((w) => /^chat\/a\/mensagem\//.test(w.path))).toHaveLength(3);
    expect(result.paths['chat/z/mensagem/evento_nova']).toBe(
      `chat/a/mensagem/migrado_${hash('chat/z/mensagem/evento_nova')}`,
    );
  });
  it('does not guess cliente from phone, but accepts bare legacy user links', () => {
    const missing = plan([doc('chat/a', conversa(A, { clienteOuterRef: null }))]);
    expect(missing.pending).toHaveLength(1);
    const linked = planWhatsappMigration('p', [
      doc('integracao/conta', { tipo: INTEGRACAO_TIPO.whatsapp }),
      doc('clientes/c', { userCliente: 'user/u' }),
      doc('chat/a', conversa(A, { clienteOuterRef: null, usarioOuterRef: 'documents/user/u' })),
    ]);
    expect(linked.pending).toEqual([]);
    expect(written(linked, 'chat/a')?.clienteOuterRef).toBe('documents/clientes/c');
    expect(written(linked, 'clientes/c')).toMatchObject({ telefoneGerenciado: true });
    expect(written(linked, 'clientes/c')?.telefone).toBeUndefined();
  });
  it('requires explicit operator state and endpoint decisions, preserving international DDI', () => {
    const docs = [
      doc('chat/a', conversa()),
      doc('chat/z', conversa(B, { estadoConversa: 2 })),
      doc('chat/z/mensagem/m', mensagem({ timestamp: T + 1000 })),
    ];
    expect(plan(docs).conflicts).toHaveLength(2);
    const result = plan(docs, { estado: { a: 'a' }, destino: { a: 'z' } });
    expect(result.conflicts).toEqual([]);
    expect(written(result, 'chat/a')?.whatsappDestino).toMatchObject({
      valor: B,
      ultimaMensagemEm: T + 1000,
    });
    expect(written(result, `whatsappIdentidades/${phoneIdentityId('conta', A)}`)).toMatchObject({
      ativa: true,
    });
    expect(written(result, `whatsappIdentidades/${phoneIdentityId('conta', B)}`)).toMatchObject({
      ativa: true,
      telefoneClienteNoVinculo: A,
    });
  });
  it('never guesses which of two legacy claimants is the cliente', () => {
    const result = plan([
      doc('clientes/x', { userCliente: 'usuarios/u' }),
      doc('clientes/y', { userCliente: 'documents/usuarios/u' }),
      doc('chat/a', conversa(A, { clienteOuterRef: null, usarioOuterRef: 'usuarios/u' })),
    ]);
    expect(result.pending[0]?.reason).toContain('ambíguo');
    expect(result.writes).toHaveLength(0);
  });
  it('keeps the inbound sender identity distinct from the chosen merged destination', () => {
    const result = plan(
      [
        doc('chat/a', conversa(A)),
        doc('chat/z', conversa(B)),
        doc('chat/a/mensagem/from-a', mensagem()),
        doc('chat/z/mensagem/from-b', mensagem()),
        doc('chat/a/mensagem/out', mensagem({ estadoEnvio: 3, mid: 'out' })),
      ],
      { destino: { a: 'z' } },
    );
    expect(result.conflicts).toEqual([]);
    expect(written(result, 'chat/a/mensagem/from-a')?.whatsappIdentidadeId).toBe(
      phoneIdentityId('conta', A),
    );
    expect(written(result, 'chat/a/mensagem/from-b')?.whatsappIdentidadeId).toBe(
      phoneIdentityId('conta', B),
    );
    expect(
      written(result, `chat/a/mensagem/${providerMessageId('conta', 'out')}`)?.whatsappIdentidadeId,
    ).toBeNull();
  });
  it('only creates clients on explicit stable decisions', () => {
    const result = plan([doc('chat/a', conversa(A, { clienteOuterRef: null }))], {
      clientes: { a: { novo: { decisionId: 'approved-1', fields: { nome: 'Ana', telefone: A } } } },
    });
    const id = hash(JSON.stringify(['whatsapp-migration-cliente', 'approved-1']));
    expect(written(result, `clientes/${id}`)?.nome).toBe('Ana');
    expect(written(result, 'chat/a')?.clienteOuterRef).toBe(`documents/clientes/${id}`);
    expect(
      written(result, `whatsappIdentidades/${phoneIdentityId('conta', A)}`)?.confirmadaManualmente,
    ).toBe(true);
  });
  it('same wamid differing content blocks; no numeric/name fold erases edits', () => {
    const result = plan([
      doc('chat/a', conversa()),
      doc('chat/z', conversa()),
      doc('chat/a/mensagem/a', mensagem({ mid: 'same', conteudo: '01' })),
      doc('chat/z/mensagem/b', mensagem({ mid: 'same', conteudo: '1' })),
    ]);
    expect(result.conflicts.some((c) => c.reason.includes('conteudo'))).toBe(true);
  });
  it('unknown subtree conflict blocks and an operator author is preserved', () => {
    const result = plan([
      doc('chat/a', conversa()),
      doc('chat/z', conversa()),
      doc('chat/a/legacy/x', { value: 1 }),
      doc('chat/z/legacy/x', { value: 2 }),
      doc('chat/z/mensagem/out', mensagem({ mid: 'sent', estadoEnvio: 3, user_id: 'operator' })),
    ]);
    expect(result.conflicts.some((c) => c.reason.includes('Subcoleção'))).toBe(true);
    expect(written(result, `chat/a/mensagem/${providerMessageId('conta', 'sent')}`)).toMatchObject({
      user_id: 'operator',
    });
    expect(
      written(result, `chat/a/mensagem/${providerMessageId('conta', 'sent')}`)
        ?.clienteMensagemOuterRef,
    ).toBeUndefined();
  });
  it('ref rewriting touches only exact references, including native reference encoding', () => {
    const paths = { 'chat/a/mensagem/x': 'chat/b/mensagem/y' };
    expect(
      rewriteReferences(
        {
          ref: 'documents/chat/a/mensagem/x',
          text: 'see chat/a/mensagem/x please',
          native: { $whatsappMigrationValue: 'reference', path: 'chat/a/mensagem/x' },
        },
        paths,
      ),
    ).toEqual({
      ref: 'documents/chat/b/mensagem/y',
      text: 'see chat/a/mensagem/x please',
      native: { $whatsappMigrationValue: 'reference', path: 'chat/b/mensagem/y' },
    });
  });
  it('does not auto-send an imported pending outbound', () => {
    const result = plan([
      doc('chat/a', conversa()),
      doc('chat/a/mensagem/p', mensagem({ estadoEnvio: 2 })),
    ]);
    expect(result.conflicts[0]?.reason).toContain('Envio pendente');
  });

  it('a fresh inventory after migration is a no-op and preserves per-phone history', () => {
    const original = [
      ...base,
      doc('chat/a', conversa()),
      doc('chat/z', conversa(B)),
      doc('chat/a/mensagem/one', mensagem({ mid: 'wa.a', timestamp: T + 5000 })),
      doc('chat/z/mensagem/two', mensagem({ mid: 'wa.b', timestamp: T + 1000 })),
    ];
    const first = planWhatsappMigration('p', original, { destino: { a: 'z' } });
    expect(first.conflicts).toEqual([]);
    const stored = new Map(original.map((d) => [d.path, d.data]));
    for (const write of first.writes) stored.set(write.path, write.after);
    for (const path of first.deletes) stored.delete(path);
    const second = planWhatsappMigration(
      'p',
      [...stored].map(([path, data]) => ({ path, data })),
    );
    expect(second.conflicts).toEqual([]);
    expect(second.writes).toEqual([]);
    expect(second.deletes).toEqual([]);
    expect(stored.get('chat/a')?.whatsappDestino).toMatchObject({
      valor: B,
      ultimaMensagemEm: T + 1000,
    });
    expect(
      stored.get(`chat/a/mensagem/${providerMessageId('conta', 'wa.a')}`)?.whatsappDestino,
    ).toMatchObject({ valor: A });
  });
});
