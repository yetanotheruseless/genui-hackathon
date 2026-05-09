/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_STAR_SYSTEMS_URL?: string;
  readonly VITE_BACKEND_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
