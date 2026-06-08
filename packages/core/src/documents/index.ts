/**
 * `DocumentProvider` is a plugin contract for jurisdiction-specific identity
 * document validation (CPF/CNPJ in BR, SSN/EIN in US, etc.). Apps register
 * one provider per locale they support; the core stays neutral.
 */
export interface DocumentProvider {
  id: string; // e.g. 'br', 'us'
  validateIndividual(value: string): boolean;
  validateBusiness(value: string): boolean;
  formatIndividual(value: string): string;
  formatBusiness(value: string): string;
}

export class DocumentRegistry {
  private providers = new Map<string, DocumentProvider>();

  register(provider: DocumentProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): DocumentProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new Error(`No DocumentProvider registered for "${id}".`);
    }
    return provider;
  }
}

export { brDocumentProvider, validateCPF, validateCNPJ, formatCPF, formatCNPJ } from './br';
