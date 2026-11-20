declare module 'cloudflare:node' {
  export function httpServerHandler(
    serverOrOptions: any
  ): {
    fetch: (request: any, env?: any, ctx?: any) => Promise<any>;
  };
}
