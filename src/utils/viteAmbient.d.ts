interface ImportMetaEnv {
  readonly MODE?: string;
  readonly DEV?: boolean;
  readonly PROD?: boolean;
  readonly VITEST?: boolean | string;
}

interface ImportMeta {
  readonly env?: ImportMetaEnv;
}

declare module 'hls.js/dist/hls.light.mjs' {
  const HlsLight: typeof import('hls.js').default;
  export default HlsLight;
}
