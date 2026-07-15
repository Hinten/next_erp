/**
 * The Admin-SDK "create-first" Arquivo uploader now lives in the shared
 * `@delfrance/storage/admin` module (#449 extracted the copy that originally
 * shipped here for the ML photo import, #439). This thin re-export keeps the ML
 * call sites (`import.ts`, `importPhotos.ts`) importing from `./arquivoUpload`
 * unchanged.
 */
export {
  putArquivoAdmin,
  type Bucket,
  type PutArquivoAdminArgs,
  type PutArquivoAdminResult,
} from '@delfrance/storage/admin';
