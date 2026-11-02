import { defineConfig, type Plugin } from 'vite';

/** En développement, Vite sert lui-même le relais des positions officielles (api/official sur Vercel). */
function officialRelay(): Plugin {
  let cache: { at: number; body: string } | null = null;
  return {
    name: 'official-relay',
    configureServer(server) {
      server.middlewares.use('/api/official', async (_req, res) => {
        try {
          if (!cache || Date.now() - cache.at > 600_000) {
            const { fetchOfficial } = await server.ssrLoadModule('/src/net/official.ts');
            cache = { at: Date.now(), body: JSON.stringify(await fetchOfficial()) };
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(cache.body);
        } catch (e) {
          res.statusCode = 502;
          res.end(JSON.stringify({ error: String(e) }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [officialRelay()],
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
  build: { chunkSizeWarningLimit: 2500 },
  worker: { format: 'es' },
});
