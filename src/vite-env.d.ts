/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_OAUTH_CLIENT_ID?: string;
  readonly VITE_OAUTH_SCOPE?: string;
}

/** Set by vite.config.ts: package.json's version and the commit the build was made from. */
declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;
