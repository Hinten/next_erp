/** Thrown by the upload helpers on a bad input or a failed fetch. */
export class StorageUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageUploadError';
  }
}
