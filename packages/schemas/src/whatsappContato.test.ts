import { describe, expect, it } from 'vitest';
import { mesmoDestinoWhatsapp, whatsappDestinoSchema } from './whatsappContato';

describe('WhatsApp destination revision', () => {
  const base = whatsappDestinoSchema.parse({
    tipo: 'telefone',
    valor: '14155552671',
    identidadeId: 'a',
    revision: 1,
    ultimaMensagemEm: 100,
  });
  it('ignores a refreshed service window for the same approved recipient', () => {
    expect(mesmoDestinoWhatsapp(base, { ...base, ultimaMensagemEm: 200 })).toBe(true);
  });
  it.each([
    { valor: '5514155552671' },
    { identidadeId: 'b' },
    { revision: 2 },
    { tipo: 'bsuid' as const },
  ])('rejects a different recipient or revision: %j', (change) => {
    expect(mesmoDestinoWhatsapp(base, { ...base, ...change })).toBe(false);
  });
  it('does not treat a missing destination as authorization', () => {
    expect(mesmoDestinoWhatsapp(base, null)).toBe(false);
    expect(mesmoDestinoWhatsapp(null, base)).toBe(false);
  });
});
