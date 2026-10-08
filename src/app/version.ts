export const VERSION = __APP_VERSION__;
export const COMMIT = __APP_COMMIT__;

/** What a bug report should quote, e.g. "oinbox 0.1.0-beta.1 (2031ab9)". */
export const versionLabel = (): string => `oinbox ${VERSION} (${COMMIT})`;
