'use client';

import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import { CanalCapsPanel } from '../_components/CanalCapsPanel';

export default function CanalShopeePage() {
  return (
    <CanalCapsPanel
      tipo={INTEGRACAO_TIPO.shopee}
      titulo="Shopee"
      descricao="Contas e configurações da integração com a Shopee."
    />
  );
}
