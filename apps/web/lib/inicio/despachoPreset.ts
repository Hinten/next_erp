import {
  DESPACHO_METRICAS,
  inicioDespachoPredicado,
  parseInicioDespacho,
} from '@delfrance/schemas';
import type { TablePresetFilter } from '@delfrance/ui';

export function despachoInicioPreset(channelName: (id: string) => string): TablePresetFilter {
  return {
    key: 'inicioDespacho',
    label: 'Despacho',
    formatValue: (raw) => {
      const value = parseInicioDespacho(raw);
      if (!value) return 'Filtro inválido';
      const date = (us: number) => new Date(us / 1000).toLocaleDateString('pt-BR');
      return `${channelName(value.canalId)} · ${DESPACHO_METRICAS[value.metrica]} · ${date(value.inicioUs)} a ${date(value.fimUs)}`;
    },
    resolve: (filter) => {
      const value = filter.op === 'eq' ? parseInicioDespacho(filter.value) : null;
      return value
        ? {
            predicate: inicioDespachoPredicado(value),
            orderBy: { field: 'freteInicial.prazoDespacho', direction: 'desc' },
          }
        : { error: 'O filtro de despacho é inválido. Remova-o para consultar os pedidos.' };
    },
  };
}
