import { describe, expect, it } from 'vitest';
import type { MlClaim, MlClaimMessage, MlClaimReason } from '@delfrance/integrations-mercado-livre';
import {
  ESTADO_ENVIO,
  ORIGEM_CONVERSA,
  ORIGEM_INCIDENTE,
  TIPO_INCIDENTE,
  TIPO_MENSAGEM,
  TIPO_RESOLUCAO,
} from '@delfrance/schemas';

import {
  buildAttachmentMensagem,
  buildClaimMessageMensagem,
  buildConversaFromClaim,
  buildIncidenteFromClaim,
  buildReasonMensagem,
  buildResolucao,
  tipoIncidenteFromClaimType,
  tipoResolucaoFromReason,
} from './claimMapping';

/* --------------------------------- fixture -------------------------------- */
// The verbatim ML claim payload sample from the legacy source
// (`.old/packages/canais_de_venda/mercado_livre/lib/src/models.dart:3762-3825`)
// — the canonical claims test fixture, transcribed field-for-field (the
// `labels` array is elided: neither legacy nor this port maps it).

const CLAIM_SAMPLE = {
  id: 5142940410,
  type: 'returns',
  stage: 'claim',
  status: 'closed',
  parent_id: null,
  client_id: 3728194611110859,
  resource_id: 2000004048276990,
  resource: 'order',
  reason_id: 'PDD9545',
  fulfilled: true,
  players: [
    { role: 'complainant', type: 'buyer', user_id: 301110805, available_actions: [] },
    {
      role: 'respondent',
      type: 'seller',
      user_id: 397242111,
      available_actions: [
        { action: 'recontact', due_date: '2022-10-06T22:33:59.000-04:00', mandatory: false },
      ],
    },
  ],
  resolution: {
    reason: 'item_returned',
    benefited: ['complainant'],
    date_created: '2022-08-24T16:10:18.000-04:00',
    decision: null,
    closed_by: 'mediator',
  },
  site_id: 'MLB',
  date_created: '2022-08-23T20:09:16.000-04:00',
  last_updated: '2022-08-24T16:10:26.000-04:00',
} as unknown as MlClaim;

const REASON_SAMPLE = {
  id: 'PDD9545',
  detail: 'O produto chegou danificado',
  name: 'Produto danificado',
  date_created: '2022-08-23T20:09:16.000-04:00',
  last_updated: '2022-08-24T16:10:26.000-04:00',
} as unknown as MlClaimReason;

function makeClaim(over: Record<string, unknown> = {}): MlClaim {
  return { ...(CLAIM_SAMPLE as unknown as Record<string, unknown>), ...over } as unknown as MlClaim;
}

function makeMessage(over: Record<string, unknown> = {}): MlClaimMessage {
  return {
    sender_role: 'complainant',
    receiver_role: 'respondent',
    stage: 'claim',
    date_created: '2022-08-23T20:30:52.000-04:00',
    message: 'Hola',
    attachments: [],
    ...over,
  } as unknown as MlClaimMessage;
}

// Epoch anchors — every µs value must be EXACTLY 1000× its ms counterpart.
const DATE_CREATED_MS = Date.parse('2022-08-23T20:09:16.000-04:00');
const LAST_UPDATED_MS = Date.parse('2022-08-24T16:10:26.000-04:00');
const RESOLUTION_MS = Date.parse('2022-08-24T16:10:18.000-04:00');
const NOW_US = Date.parse('2026-08-01T00:00:00.000Z') * 1000;

const CONVERSA_CTX = {
  buyerUserId: 301110805,
  clienteOuterRef: 'documents/clientes/cli-1',
  contaId: 'conta_abc123',
  contaCor: 7,
  pedidoId: 'ped-1',
  incidenteId: 'inc-1',
  respostaBloqueada: null,
  // CLAIM_SAMPLE is `status: closed` — ML empties available_actions on close.
  podeResponder: false,
};

/* ------------------------------ enum mappings ------------------------------ */

describe('tipoIncidenteFromClaimType', () => {
  it('accepts BOTH of ML’s return spellings — the reference contradicts itself', () => {
    // ⚠️ The claim-detail field table documents `return`; the search-response
    // example ships `"type": "returns"`. TIPO_INCIDENTE.devolucao is the
    // plural, so the singular used to fall through to `outros` — silently, on
    // every return claim ML spelled that way.
    expect(tipoIncidenteFromClaimType('returns')).toBe(TIPO_INCIDENTE.devolucao);
    expect(tipoIncidenteFromClaimType('return')).toBe(TIPO_INCIDENTE.devolucao);
  });

  it('maps the four documented ML types verbatim (they ARE TipoIncidente wire values)', () => {
    expect(tipoIncidenteFromClaimType('mediations')).toBe(TIPO_INCIDENTE.mediacaoDoMarketplace);
    expect(tipoIncidenteFromClaimType('cancel_purchase')).toBe(
      TIPO_INCIDENTE.cancelamentoPeloComprador,
    );
    expect(tipoIncidenteFromClaimType('returns')).toBe(TIPO_INCIDENTE.devolucao);
    expect(tipoIncidenteFromClaimType('cancel_sale')).toBe(TIPO_INCIDENTE.cancelamentoPeloVendedor);
  });

  it("maps 'change' to troca and everything else (legacy THREW) to outros", () => {
    expect(tipoIncidenteFromClaimType('change')).toBe(TIPO_INCIDENTE.troca);
    expect(tipoIncidenteFromClaimType('service')).toBe(TIPO_INCIDENTE.outros);
    expect(tipoIncidenteFromClaimType('fulfillment')).toBe(TIPO_INCIDENTE.outros);
    expect(tipoIncidenteFromClaimType('ml_case')).toBe(TIPO_INCIDENTE.outros);
    expect(tipoIncidenteFromClaimType(null)).toBe(TIPO_INCIDENTE.outros);
  });
});

describe('tipoResolucaoFromReason', () => {
  it('maps every documented reason family (the #364 fix over hardcoded item_devolvido)', () => {
    expect(tipoResolucaoFromReason('item_returned')).toBe(TIPO_RESOLUCAO.itemDevolvido);
    expect(tipoResolucaoFromReason('product_exchanged')).toBe(TIPO_RESOLUCAO.enviadoOutroItem);
    expect(tipoResolucaoFromReason('item_replaced')).toBe(TIPO_RESOLUCAO.enviadoOutroItem);
    expect(tipoResolucaoFromReason('payment_refunded')).toBe(
      TIPO_RESOLUCAO.pagamentoDevolvidoIntegralmente,
    );
    expect(tipoResolucaoFromReason('refunded')).toBe(
      TIPO_RESOLUCAO.pagamentoDevolvidoIntegralmente,
    );
    expect(tipoResolucaoFromReason('charged_back')).toBe(
      TIPO_RESOLUCAO.pagamentoDevolvidoIntegralmente,
    );
    expect(tipoResolucaoFromReason('partial_refunded')).toBe(
      TIPO_RESOLUCAO.pagamentoDevolvidoParcialmente,
    );
    expect(tipoResolucaoFromReason('partial_refund')).toBe(
      TIPO_RESOLUCAO.pagamentoDevolvidoParcialmente,
    );
    expect(tipoResolucaoFromReason('timeout')).toBe(TIPO_RESOLUCAO.inatividadeDoCliente);
    expect(tipoResolucaoFromReason('expired')).toBe(TIPO_RESOLUCAO.inatividadeDoCliente);
    expect(tipoResolucaoFromReason('complainant_timeout')).toBe(
      TIPO_RESOLUCAO.inatividadeDoCliente,
    );
    expect(tipoResolucaoFromReason('respondent_timeout')).toBe(TIPO_RESOLUCAO.inatividadeDoCliente);
    expect(tipoResolucaoFromReason('closed_by_buyer')).toBe(TIPO_RESOLUCAO.encerradoSemNenhumaAcao);
    expect(tipoResolucaoFromReason('cancelled_by_buyer')).toBe(
      TIPO_RESOLUCAO.encerradoSemNenhumaAcao,
    );
    expect(tipoResolucaoFromReason('buyer_regret')).toBe(TIPO_RESOLUCAO.encerradoSemNenhumaAcao);
    expect(tipoResolucaoFromReason('withdrawn')).toBe(TIPO_RESOLUCAO.encerradoSemNenhumaAcao);
  });

  it('defaults an unknown/null reason to outro', () => {
    expect(tipoResolucaoFromReason('something_new_from_ml')).toBe(TIPO_RESOLUCAO.outro);
    expect(tipoResolucaoFromReason(null)).toBe(TIPO_RESOLUCAO.outro);
  });
});

/* ------------------------------ incidente (µs) ----------------------------- */

describe('buildIncidenteFromClaim', () => {
  it('maps the canonical sample — µs datetimes, raw-resource comentarios (deliberate deviation: legacy wrote the Dart enum toString), status THEN stage', () => {
    const incidente = buildIncidenteFromClaim(CLAIM_SAMPLE, REASON_SAMPLE, NOW_US);
    expect(incidente).toEqual({
      origem: ORIGEM_INCIDENTE.pedidoMercadoLivre,
      tipo: TIPO_INCIDENTE.devolucao,
      motivoDoIncidente: 'O produto chegou danificado',
      comentarios: 'order 2000004048276990(5142940410) - Fechada Reclamação',
      timestamp: DATE_CREATED_MS * 1000,
      ultimaModificacao: LAST_UPDATED_MS * 1000,
      externalId: '5142940410',
      resolucao: {
        data: RESOLUTION_MS * 1000,
        tipo: TIPO_RESOLUCAO.itemDevolvido,
        comentarios: 'mediator: item_returned',
        valor: 0,
        frete: null,
      },
      // Structured claim state (#1322). These used to live ONLY inside the
      // `comentarios` sentence above, where nothing can query them — so the
      // pedido could not tell an open mediation from a closed one without a
      // human reading prose.
      claimStatus: 'closed',
      claimStage: 'claim',
      // The canonical sample IS a delivered-item claim (`fulfilled: true` in
      // ML's own published payload) — which is exactly the case that must
      // classify as a devolução rather than a dispatch block.
      entregue: true,
    });
  });

  describe('structured claim state (#1322)', () => {
    it('carries status, stage and fulfilled through as modelled fields', () => {
      const inc = buildIncidenteFromClaim(
        makeClaim({ status: 'opened', stage: 'dispute', fulfilled: true }),
        undefined,
        NOW_US,
      );
      expect(inc.claimStatus).toBe('opened');
      expect(inc.claimStage).toBe('dispute');
      expect(inc.entregue).toBe(true);
    });

    it('an UNRECOGNISED status/stage stores null rather than failing the import', () => {
      // A claim ML labels with a stage we do not model still has an incidente
      // worth writing — refusing it would trade a missing field for a missing
      // record, which is strictly worse.
      const inc = buildIncidenteFromClaim(
        makeClaim({ status: 'reopened_maybe', stage: 'algo_novo' }),
        undefined,
        NOW_US,
      );
      expect(inc.claimStatus).toBeNull();
      expect(inc.claimStage).toBeNull();
    });

    it('`fulfilled` distinguishes absent from false — only an explicit boolean is kept', () => {
      // ⚠️ `entregue` decides whether the pedido refuses DISPATCH or refuses
      // CONSOLIDATION, so "ML did not say" must not collapse into "not
      // delivered".
      expect(
        buildIncidenteFromClaim(makeClaim({ fulfilled: null }), undefined, NOW_US).entregue,
      ).toBeNull();
      expect(
        buildIncidenteFromClaim(makeClaim({ fulfilled: false }), undefined, NOW_US).entregue,
      ).toBe(false);
    });
  });

  it('µs vs ms crossing: incidente timestamps are EXACTLY 1000× the conversa ms values', () => {
    const incidente = buildIncidenteFromClaim(CLAIM_SAMPLE, REASON_SAMPLE, NOW_US);
    const conversa = buildConversaFromClaim(CLAIM_SAMPLE, CONVERSA_CTX);
    expect(incidente.timestamp).toBe((conversa.data_cadastro as number) * 1000);
    expect(incidente.ultimaModificacao).toBe((conversa.ultima_modificacao as number) * 1000);
  });

  it('falls back through detail → name → the Portuguese unknown-motivo literal', () => {
    const noDetail = { ...REASON_SAMPLE, detail: null } as unknown as MlClaimReason;
    expect(buildIncidenteFromClaim(CLAIM_SAMPLE, noDetail, NOW_US).motivoDoIncidente).toBe(
      'Produto danificado',
    );
    expect(buildIncidenteFromClaim(CLAIM_SAMPLE, undefined, NOW_US).motivoDoIncidente).toBe(
      'Motivo da reclamação desconhecido',
    );
  });

  it('ultimaModificacao falls back to date_created when last_updated is null; unparseable → nowUs', () => {
    const noUpdate = buildIncidenteFromClaim(makeClaim({ last_updated: null }), undefined, NOW_US);
    expect(noUpdate.ultimaModificacao).toBe(DATE_CREATED_MS * 1000);
    const garbage = buildIncidenteFromClaim(
      makeClaim({ date_created: 'not-a-date', last_updated: null }),
      undefined,
      NOW_US,
    );
    expect(garbage.timestamp).toBe(NOW_US);
    expect(garbage.ultimaModificacao).toBe(NOW_US);
  });

  it('unknown status/stage vocabulary falls back to the raw string (never throws)', () => {
    // The fixture must be vocabulary ML does NOT publish. It used to be
    // `stage: 'stale'`, which stopped being unknown the moment STAGE_DISPLAY
    // learned it — the same inert-fixture landmine #813 hit with 'questions'.
    const incidente = buildIncidenteFromClaim(
      makeClaim({ status: 'frozen', stage: 'etapa_que_nao_existe' }),
      undefined,
      NOW_US,
    );
    expect(incidente.comentarios).toBe(
      'order 2000004048276990(5142940410) - frozen etapa_que_nao_existe',
    );
  });

  it('displays the stage ML added for ml_case claims instead of the raw slug', () => {
    const incidente = buildIncidenteFromClaim(
      makeClaim({ status: 'opened', stage: 'stale' }),
      undefined,
      NOW_US,
    );
    expect(incidente.comentarios).toContain('Com o Mercado Livre');
  });
});

describe('buildResolucao', () => {
  it('is null without a resolution', () => {
    expect(buildResolucao(null)).toBeNull();
  });

  it('joins a non-empty decision with "/" after a space', () => {
    const resolucao = buildResolucao({
      reason: 'refunded',
      date_created: '2022-08-24T16:10:18.000-04:00',
      decision: ['refund', 'return'],
      closed_by: 'mediator',
    } as unknown as MlClaim['resolution']);
    expect(resolucao?.comentarios).toBe('mediator: refunded refund/return');
    expect(resolucao?.tipo).toBe(TIPO_RESOLUCAO.pagamentoDevolvidoIntegralmente);
  });

  it("never interpolates a null decision as the literal 'null' (legacy quirk NOT ported)", () => {
    const resolucao = buildResolucao(CLAIM_SAMPLE.resolution);
    expect(resolucao?.comentarios).toBe('mediator: item_returned');
    expect(resolucao?.comentarios).not.toContain('null');
  });

  it('tolerates all-null resolution fields', () => {
    const resolucao = buildResolucao({
      reason: null,
      date_created: null,
      decision: null,
      closed_by: null,
    } as unknown as MlClaim['resolution']);
    expect(resolucao).toEqual({
      data: null,
      tipo: TIPO_RESOLUCAO.outro,
      comentarios: ': ',
      valor: 0,
      frete: null,
    });
  });
});

/* ------------------------------- conversa (ms) ----------------------------- */

describe('buildConversaFromClaim', () => {
  it('maps the canonical sample — ms datetimes, mlclaims origem, legacy nome shape (stage THEN status)', () => {
    const conversa = buildConversaFromClaim(CLAIM_SAMPLE, CONVERSA_CTX);
    expect(conversa).toEqual({
      origem: ORIGEM_CONVERSA.mercadoLivreReclamacoes,
      id: '5142940410',
      nome: 'Pedido 2000004048276990(5142940410) - Reclamação Fechada',
      sender_id: '301110805',
      atendido: true, // status closed
      cor_etiqueta: 7,
      data_cadastro: DATE_CREATED_MS,
      ultima_modificacao: LAST_UPDATED_MS,
      clienteOuterRef: 'documents/clientes/cli-1',
      respostaBloqueada: null,
      ultimaModificacaoIntegracao: LAST_UPDATED_MS,
      integracaoOuterRef: 'documents/integracao/conta_abc123',
      pedidoOuterRef: 'documents/pedidos/ped-1',
      incidenteOuterRef: 'documents/pedidos/ped-1/incidentes/inc-1',
    });
    // estadoConversa NEVER rides the mapped fields — create fills the schema
    // default; update must preserve the operator's triage state.
    expect(conversa).not.toHaveProperty('estadoConversa');
    // #768 — the buyer is a cliente. No usuario is written anywhere.
    expect(conversa).not.toHaveProperty('usarioOuterRef');
    expect(conversa).not.toHaveProperty('user_id');
  });

  it('carries the blocked reason so the composer can explain itself', () => {
    const conversa = buildConversaFromClaim(CLAIM_SAMPLE, {
      ...CONVERSA_CTX,
      respostaBloqueada: 'Reclamação encerrada no Mercado Livre',
    });
    expect(conversa.respostaBloqueada).toBe('Reclamação encerrada no Mercado Livre');
  });

  it('tolerates a claim whose pedido cliente is gone', () => {
    // The ref is nullable end-to-end: losing the cliente must degrade the
    // contact link, never block the claim from importing.
    const conversa = buildConversaFromClaim(CLAIM_SAMPLE, {
      ...CONVERSA_CTX,
      clienteOuterRef: null,
    });
    expect(conversa.clienteOuterRef).toBeNull();
  });

  it('an open claim is not atendido; a null cor defaults to 0; last_updated falls back to date_created', () => {
    const conversa = buildConversaFromClaim(makeClaim({ status: 'opened', last_updated: null }), {
      ...CONVERSA_CTX,
      contaCor: null,
      podeResponder: true,
    });
    expect(conversa.atendido).toBe(false);
    expect(conversa.cor_etiqueta).toBe(0);
    expect(conversa.ultima_modificacao).toBe(DATE_CREATED_MS);
  });
});

/* ------------------------------ mensagens (ms) ----------------------------- */

describe('buildClaimMessageMensagem', () => {
  const DOC_ID = 'digest-abc';
  const MSG_MS = Date.parse('2022-08-23T20:30:52.000-04:00');

  const CTX = { clienteOuterRef: 'documents/clientes/cli-1' };

  it('a BUYER message is recebido and carries the cliente — the #768 direction fix', () => {
    // ⚠️ Legacy stamped `enviado` on every claim message, buyer ones included.
    // It only rendered correctly because the synthetic usuario satisfied
    // MensagemBubble's second test (`user_id === customerUid`); this import
    // writes no user_id, so getting this wrong would show the buyer's own words
    // as ours.
    const mensagem = buildClaimMessageMensagem(makeMessage(), DOC_ID, CTX);
    expect(mensagem).toEqual({
      estadoEnvio: ESTADO_ENVIO.recebido,
      tipo: TIPO_MENSAGEM.comum,
      conteudo: 'Hola',
      mid: DOC_ID,
      midGroup: null,
      data_cadastro: MSG_MS,
      timestamp: MSG_MS, // deliberate deviation: legacy left timestamp null
      clienteMensagemOuterRef: 'documents/clientes/cli-1',
    });
    expect(mensagem).not.toHaveProperty('user_id');
    expect(mensagem).not.toHaveProperty('usarioMensagemOuterRef');
  });

  it('a SELLER message is enviado and carries NO cliente', () => {
    const mensagem = buildClaimMessageMensagem(
      makeMessage({ sender_role: 'respondent', receiver_role: 'complainant' }),
      DOC_ID,
      CTX,
    );
    expect(mensagem.estadoEnvio).toBe(ESTADO_ENVIO.enviado);
    expect(mensagem.clienteMensagemOuterRef).toBeNull();
  });

  it('anything that is not the respondent renders INBOUND', () => {
    // The mediator, and any role ML adds next. Showing someone else's message
    // as ours is a misattribution an operator cannot spot; the reverse is
    // obvious on sight, so the unknown case defaults to inbound.
    for (const role of ['mediator', 'complainant', 'papel_novo', null]) {
      const m = buildClaimMessageMensagem(makeMessage({ sender_role: role }), DOC_ID, CTX);
      expect(m.estadoEnvio, String(role)).toBe(ESTADO_ENVIO.recebido);
    }
  });

  it('is case- and whitespace-insensitive about the role, which comes off the wire', () => {
    const m = buildClaimMessageMensagem(makeMessage({ sender_role: ' Respondent ' }), DOC_ID, CTX);
    expect(m.estadoEnvio).toBe(ESTADO_ENVIO.enviado);
  });

  it('marks OUR moderated/rejected message as erro — ML never delivered it', () => {
    // ML filters the counterparty's moderated messages out of this endpoint but
    // returns ours. Rendering one as `enviado` tells the operator the buyer read
    // something they never received.
    for (const status of ['rejected', 'moderated']) {
      const m = buildClaimMessageMensagem(
        makeMessage({ sender_role: 'respondent', status }),
        DOC_ID,
        CTX,
      );
      expect(m.estadoEnvio, status).toBe(ESTADO_ENVIO.erro);
    }
    // ...but a moderated INBOUND message stays inbound: it reached us.
    const inbound = buildClaimMessageMensagem(
      makeMessage({ sender_role: 'complainant', status: 'rejected' }),
      DOC_ID,
      CTX,
    );
    expect(inbound.estadoEnvio).toBe(ESTADO_ENVIO.recebido);
  });

  it('a message WITH attachments groups on its own doc id', () => {
    const mensagem = buildClaimMessageMensagem(
      makeMessage({ attachments: [{ filename: 'f.jpg' }] }),
      DOC_ID,
      CTX,
    );
    expect(mensagem.midGroup).toBe(DOC_ID);
  });
});

describe('buildReasonMensagem', () => {
  it('is RECEBIDO — the buyer opened the claim — with the RAW reason id as mid', () => {
    // Legacy wrote `salva`, a draft state, for a sentence the BUYER authored.
    const mensagem = buildReasonMensagem({
      reasonId: 'PDD9545',
      claim: CLAIM_SAMPLE,
      reason: REASON_SAMPLE,
      clienteOuterRef: 'documents/clientes/cli-1',
    });
    expect(mensagem).toEqual({
      estadoEnvio: ESTADO_ENVIO.recebido,
      tipo: TIPO_MENSAGEM.comum,
      conteudo: 'O produto chegou danificado',
      mid: 'PDD9545',
      data_cadastro: DATE_CREATED_MS, // reason.date_created (ms)
      timestamp: LAST_UPDATED_MS, // reason.last_updated (ms)
      clienteMensagemOuterRef: 'documents/clientes/cli-1',
    });
    expect(mensagem).not.toHaveProperty('user_id');
    expect(mensagem).not.toHaveProperty('usarioMensagemOuterRef');
  });

  it('falls back to the claim datetimes + unknown-motivo when the reason lookup failed', () => {
    const mensagem = buildReasonMensagem({
      reasonId: 'PDD9545',
      claim: CLAIM_SAMPLE,
      reason: undefined,
      clienteOuterRef: 'documents/clientes/cli-1',
    });
    expect(mensagem.conteudo).toBe('Motivo da reclamação desconhecido');
    expect(mensagem.data_cadastro).toBe(DATE_CREATED_MS);
    expect(mensagem.timestamp).toBe(DATE_CREATED_MS);
  });
});

describe('buildAttachmentMensagem', () => {
  it('keeps tipo comum (legacy quirk — NOT arquivo) and takes the PARENT direction', () => {
    const parent = makeMessage({ attachments: [{ filename: 'foto.jpg' }] });
    const mensagem = buildAttachmentMensagem({
      filename: 'foto.jpg',
      parentMessage: parent,
      parentMessageDocId: 'digest-abc',
      arquivoOuterRef: 'documents/arquivos/arq-1',
      clienteOuterRef: 'documents/clientes/cli-1',
    });
    expect(mensagem).toEqual({
      // The parent is a complainant message, so the photo is the buyer's.
      // Legacy stamped every attachment `salva`, rendering the buyer's photos
      // as unsent drafts of ours.
      estadoEnvio: ESTADO_ENVIO.recebido,
      tipo: TIPO_MENSAGEM.comum,
      mid: 'foto.jpg',
      midGroup: 'digest-abc',
      anexoStorage: 'documents/arquivos/arq-1',
      data_cadastro: Date.parse('2022-08-23T20:30:52.000-04:00'),
      timestamp: Date.parse('2022-08-23T20:30:52.000-04:00'),
      clienteMensagemOuterRef: 'documents/clientes/cli-1',
    });
    expect(mensagem.tipo).not.toBe(TIPO_MENSAGEM.arquivo);
  });

  it('an attachment on OUR message is outbound and carries no cliente', () => {
    const mensagem = buildAttachmentMensagem({
      filename: 'nota.pdf',
      parentMessage: makeMessage({ sender_role: 'respondent' }),
      parentMessageDocId: 'digest-abc',
      arquivoOuterRef: 'documents/arquivos/arq-2',
      clienteOuterRef: 'documents/clientes/cli-1',
    });
    expect(mensagem.estadoEnvio).toBe(ESTADO_ENVIO.enviado);
    expect(mensagem.clienteMensagemOuterRef).toBeNull();
  });
});

describe('atendido follows the ACTIONABILITY, not the claim status', () => {
  it('marks an OPEN claim handled when the seller holds no send action', () => {
    // ⚠️ The gap the status-only rule left: an open claim whose seller can only
    // refund or allow a return is unanswerable, and leaving it `atendido: false`
    // put a blocked thread back in the operator queue carrying a reason but no
    // closure — a composer that explains why it cannot send, in the work list.
    const conversa = buildConversaFromClaim(makeClaim({ status: 'opened' }), {
      ...CONVERSA_CTX,
      podeResponder: false,
      respostaBloqueada: 'Sem envio nesta etapa',
    });
    expect(conversa.atendido).toBe(true);
  });

  it('leaves a CLOSED claim unhandled if ML still offers a send action', () => {
    // The mirror case, and why `status === closed` is not OR-ed in. ML empties
    // `available_actions` on close, so this shape should not occur — but if it
    // does, marking it handled while the composer is live is the contradiction.
    const conversa = buildConversaFromClaim(makeClaim({ status: 'closed' }), {
      ...CONVERSA_CTX,
      podeResponder: true,
    });
    expect(conversa.atendido).toBe(false);
  });
});

describe('an attachment inherits the parent’s DELIVERY, not just its direction', () => {
  it('marks an attachment on a rejected seller message as erro', () => {
    // ⚠️ The parent message already lands `erro` — ML never delivered it. The
    // attachment is part of that same rejected message, so showing it as
    // `enviado` presented one failed delivery as two different outcomes.
    for (const status of ['rejected', 'moderated']) {
      const mensagem = buildAttachmentMensagem({
        filename: 'nota.pdf',
        parentMessage: makeMessage({ sender_role: 'respondent', status }),
        parentMessageDocId: 'digest-abc',
        arquivoOuterRef: 'documents/arquivos/arq-1',
        clienteOuterRef: 'documents/clientes/cli-1',
      });
      expect(mensagem.estadoEnvio, status).toBe(ESTADO_ENVIO.erro);
    }
  });

  it('leaves a delivered seller attachment as enviado', () => {
    const mensagem = buildAttachmentMensagem({
      filename: 'nota.pdf',
      parentMessage: makeMessage({ sender_role: 'respondent', status: 'available' }),
      parentMessageDocId: 'digest-abc',
      arquivoOuterRef: 'documents/arquivos/arq-1',
      clienteOuterRef: 'documents/clientes/cli-1',
    });
    expect(mensagem.estadoEnvio).toBe(ESTADO_ENVIO.enviado);
  });

  it('a rejected INBOUND attachment stays recebido — it reached us', () => {
    const mensagem = buildAttachmentMensagem({
      filename: 'foto.jpg',
      parentMessage: makeMessage({ sender_role: 'complainant', status: 'rejected' }),
      parentMessageDocId: 'digest-abc',
      arquivoOuterRef: 'documents/arquivos/arq-1',
      clienteOuterRef: 'documents/clientes/cli-1',
    });
    expect(mensagem.estadoEnvio).toBe(ESTADO_ENVIO.recebido);
  });
});
