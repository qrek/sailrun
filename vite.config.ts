import { defineConfig, type Plugin } from 'vite';

/** En développement, Vite sert lui-même le relais des positions officielles (api/official sur Vercel). */
function officialRelay(): Plugin {
  const cache = new Map<string, { at: number; body: string }>();
  return {
    name: 'official-relay',
    configureServer(server) {
      server.middlewares.use('/api/official', async (req, res) => {
        try {
          // ?tracks : les trajectoires depuis le départ de la Route du Rhum
          const kind = req.url?.includes('tracks') ? 'tracks' : 'live';
          let hit = cache.get(kind);
          if (!hit || Date.now() - hit.at > 600_000) {
            const o = await server.ssrLoadModule('/src/net/official.ts');
            const { RACE_START_UTC } = await server.ssrLoadModule('/api/wind.ts');
            hit = { at: Date.now(), body: JSON.stringify(kind === 'tracks' ? await o.fetchOfficialTracks(RACE_START_UTC) : await o.fetchOfficial()) };
            cache.set(kind, hit);
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(hit.body);
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
