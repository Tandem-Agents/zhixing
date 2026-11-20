/** Type declarations for the locked, narrow-patched `tuf-js@5.0.1` vendor bundle. */

export interface TufFetcher {
  downloadBytes(url: string, maxLength: number): Promise<Buffer>;
  downloadFile?<T>(
    url: string,
    maxLength: number,
    handler: (file: string) => Promise<T>,
  ): Promise<T>;
}

export interface TufMetadataStore {
  read(fileName: string): Buffer;
  write(metaDataName: string, bytesData: Buffer): Promise<void>;
}

export interface TufTargetInfo {
  readonly path: string;
  readonly length: number;
  readonly hashes: Readonly<Record<string, string>>;
  readonly custom?: Readonly<Record<string, unknown>>;
}

export interface TufUpdaterConfig {
  readonly maxRootRotations?: number;
  readonly maxDelegations?: number;
  readonly rootMaxLength?: number;
  readonly timestampMaxLength?: number;
  readonly snapshotMaxLength?: number;
  readonly targetsMaxLength?: number;
  readonly prefixTargetsWithHash?: boolean;
}

export interface TufUpdaterOptions {
  readonly metadataDir: string;
  readonly metadataBaseUrl: string;
  readonly targetDir?: string;
  readonly targetBaseUrl?: string;
  readonly fetcher?: TufFetcher;
  readonly metadataStore?: TufMetadataStore;
  readonly config?: TufUpdaterConfig;
}

export declare class Updater {
  constructor(options: TufUpdaterOptions);
  refresh(): Promise<void>;
  getTargetInfo(targetPath: string): Promise<TufTargetInfo | undefined>;
  downloadTarget(
    targetInfo: TufTargetInfo,
    filePath?: string,
    targetBaseUrl?: string,
  ): Promise<string>;
}

export declare class DownloadHTTPError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: number);
}

export declare class ValueError extends Error {}
export declare class RuntimeError extends Error {}
export declare class BadVersionNumberError extends Error {}
export declare class ExpiredMetadataError extends Error {}
export declare class EqualVersionNumberError extends Error {}
export declare class BadHashError extends Error {}
export declare class DownloadLengthMismatchError extends Error {}

export declare function canonicalize(obj: unknown): string;
