import { LEGAL_FIELDS, type LegalConfig } from '@/lib/config';

export function LegalIdentity({ config }: { config: LegalConfig }) {
  const fields = LEGAL_FIELDS.filter(({ key }) => config.values[key] !== null);
  const missing = LEGAL_FIELDS.filter(({ key }) => config.values[key] === null);
  if (fields.length === 0 && !config.showMissing) return null;

  return (
    <aside className="legal-identity" aria-label="Responsável e contato">
      {fields.length > 0 && (
        <dl>
          {fields.map(({ key, label }) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd>
                {key === 'LEGAL_PRIVACY_EMAIL' ? (
                  <a href={`mailto:${config.values[key]}`}>{config.values[key]}</a>
                ) : (
                  config.values[key]
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {config.showMissing && missing.length > 0 && (
        <div className="config-notice" role="note">
          <p>Configuração de desenvolvimento: informe as seguintes variáveis de ambiente:</p>
          <ul>
            {missing.map(({ key, label }) => (
              <li key={key}>
                <code>{key}</code> — {label.toLowerCase()}
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}
