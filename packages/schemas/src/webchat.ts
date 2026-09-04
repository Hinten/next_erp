import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';
import type { CollectionMetadata } from './types';

// Byte 14 — next free byte after `incidenteResolucao` (bits 107-108, byte 13).
// Mirror `PERM.webchat` in `packages/auth/src/permissions.ts`.
const PERM_WEBCHAT_READ = 1n << 112n;
const PERM_WEBCHAT_WRITE = 1n << 113n;
const PERM_WEBCHAT_DELETE = 1n << 114n;

/**
 * Preset trigger-button icons offered by the editor (legacy screen offered
 * exactly 3 FontAwesome presets; this app renders them with `@tabler/icons-react`,
 * the repo's icon set — see `packages/ui`/`apps/web` dependencies).
 */
export const WEBCHAT_ICONE_LABELS = {
  mensagem: 'Balão de mensagem',
  duvida: 'Interrogação',
  suporte: 'Fone de suporte',
} as const;
export const webchatIconeSchema = z.enum(['mensagem', 'duvida', 'suporte']);
export type WebchatIcone = z.infer<typeof webchatIconeSchema>;

/** Widget position on the embedding page. */
export const WEBCHAT_POSICIONAMENTO_LABELS = {
  esquerda: 'Esquerda',
  direita: 'Direita',
} as const;
export const webchatPosicionamentoSchema = z.enum(['esquerda', 'direita']);
export type WebchatPosicionamento = z.infer<typeof webchatPosicionamentoSchema>;

/**
 * Business-hours open/close pair for one weekday — plain wall-clock
 * hour/minute, no epoch anchor. Unlike `horarioWhatsappSchema`
 * (`packages/schemas/src/integracao.ts`), which byte-compatibly reproduces a
 * legacy year-0/local `DateTime` quirk for an already-populated legacy field,
 * `webchat` is a brand-new collection with no existing corpus (root
 * `CLAUDE.md` rule 8) — there is nothing to stay wire-compatible with, so a
 * plain, timezone-free representation is the simpler and equally correct
 * choice for a per-weekday wall-clock window.
 */
export const horarioWebchatSchema = z.object({
  aberturaHora: z.number().int().min(0).max(23),
  aberturaMinuto: z.number().int().min(0).max(59),
  fechamentoHora: z.number().int().min(0).max(23),
  fechamentoMinuto: z.number().int().min(0).max(59),
});
export type HorarioWebchat = z.infer<typeof horarioWebchatSchema>;

/**
 * One weekly business-hours period — legacy `Periodo` (`.old/lib/webchat/models.dart`,
 * per #558's issue body — `Periodo.getHorarioHoje`), mirrored here as one
 * optional {@link horarioWebchatSchema} per weekday, same shape as
 * `periodoWhatsappSchema` (`./integracao.ts`) but kept as its own type since
 * the two legacy classes (`Periodo` vs `Periodo_Whatsapp`) are distinct.
 */
export const periodoWebchatSchema = z.object({
  domingo: horarioWebchatSchema.nullish(),
  segunda: horarioWebchatSchema.nullish(),
  terca: horarioWebchatSchema.nullish(),
  quarta: horarioWebchatSchema.nullish(),
  quinta: horarioWebchatSchema.nullish(),
  sexta: horarioWebchatSchema.nullish(),
  sabado: horarioWebchatSchema.nullish(),
});
export type PeriodoWebchat = z.infer<typeof periodoWebchatSchema>;

/** One quick-inactivity message — up to 3 per widget (#558). */
export const mensagemInatividadeWebchatSchema = z.object({
  mensagem: z.string().min(1).max(500).describe('Mensagem'),
  // Legacy field name `tempo_inatividade`, seconds of inactivity before the
  // message fires; legacy default is 60s.
  tempo_inatividade: z.number().int().min(1).max(3600).default(60).describe('Tempo (segundos)'),
});
export type MensagemInatividadeWebchat = z.infer<typeof mensagemInatividadeWebchatSchema>;

/**
 * Webchat widget configuration — legacy `Webchat`
 * (`.old/lib/webchat/models.dart` + `.old/packages/webchat/lib/src/models.dart`,
 * per #558). Configures the embeddable widget hosted by `apps/webchat`; the
 * "Gerar Script Webchat" TableView action (`apps/web`) turns one doc into the
 * `<script>` embed snippet `apps/webchat/public/loader.js` expects
 * (`data-tenant=<docId>`).
 */
export const webchatSchema = z.object({
  nome: z.string().min(1).max(255).describe('Nome'),
  url: z
    .string()
    .max(500)
    .nullable()
    .default(null)
    .describe('{"label":"URL de destino","hint":"Site onde o widget será embarcado"}'),
  posicionamento: webchatPosicionamentoSchema
    .meta({ labels: WEBCHAT_POSICIONAMENTO_LABELS })
    .default('direita')
    .describe('Posicionamento'),
  icone: webchatIconeSchema
    .meta({ labels: WEBCHAT_ICONE_LABELS })
    .default('mensagem')
    .describe('Ícone'),
  saudacao: z
    .string()
    .max(500)
    .nullable()
    .default(null)
    .describe('{"label":"Saudação","hint":"Mensagem de boas-vindas exibida no cabeçalho"}'),

  // Cores — via ColorInput (Mantine) in the editor.
  corBorda: z.string().max(20).default('#e5e7eb').describe('Cor da borda'),
  corIcone: z.string().max(20).default('#2563eb').describe('Cor do ícone'),
  corCabecalho: z.string().max(20).default('#2563eb').describe('Cor do cabeçalho'),
  corBolhaInatividade: z
    .string()
    .max(20)
    .default('#dc2626')
    .describe('Cor da bolha de inatividade'),
  corCorpoChat: z.string().max(20).default('#ffffff').describe('Cor do corpo do chat'),
  corTextoChat: z.string().max(20).default('#111827').describe('Cor do texto do chat'),

  // Embedded array field (NOT a subcollection) — legacy field name.
  horario_funcionamento: z
    .array(periodoWebchatSchema)
    .nullable()
    .default(null)
    .describe('Horário de funcionamento'),

  // Up to 3 quick-reply chips, hard client-side cap (legacy field name).
  mensagens_padrao: z
    .array(z.string().min(1).max(200))
    .max(3)
    .nullable()
    .default(null)
    .describe('Mensagens padrão'),

  // Up to 3 inactivity messages, hard client-side cap (legacy field name).
  mensagens_inatividade: z
    .array(mensagemInatividadeWebchatSchema)
    .max(3)
    .nullable()
    .default(null)
    .describe('Mensagens de inatividade'),

  timestamp: millisSinceEpoch().nullable().optional(),
  // Update-monitor field — `saveRecord` stamps it on every write; TableView's
  // update-monitor orders by it.
  ultimaModificacao: millisSinceEpoch().nullable().optional(),
});
export type Webchat = z.infer<typeof webchatSchema>;

export const webchatMeta: CollectionMetadata = {
  collectionPath: 'webchat',
  permissions: {
    read: PERM_WEBCHAT_READ,
    write: PERM_WEBCHAT_WRITE,
    delete: PERM_WEBCHAT_DELETE,
  },
  defaultQuery: {
    orderBy: [{ field: 'nome', direction: 'asc' }],
    limit: 50,
    columns: ['nome', 'posicionamento', 'url'],
  },
};

export const webchat = { schema: webchatSchema, meta: webchatMeta };
