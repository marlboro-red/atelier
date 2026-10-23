import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import fastifyStatic from "@fastify/static";
import { Store } from "./store.js";
import { createApp, createPreviewApp } from "./app.js";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const port = Number(process.env.ATELIER_PORT ?? 4310);
const previewPort = Number(process.env.ATELIER_PREVIEW_PORT ?? port + 1);
const store = new Store(
  process.env.ATELIER_DATA_DIR ?? resolve(homedir(), ".atelier"),
);
const app = createApp(store, previewPort);
const preview = createPreviewApp(store);
const dist = resolve(root, "dist/web");
if (!existsSync(dist))
  throw new Error("Build the workspace first with npm run build");
await app.register(fastifyStatic, { root: dist });
app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith("/api/"))
    return reply.code(404).send({ error: "Endpoint not found" });
  return reply.sendFile("index.html");
});
try {
  await preview.listen({ host: "127.0.0.1", port: previewPort });
  await app.listen({ host: "127.0.0.1", port });
  console.log(
    `\n  Atelier → http://atelier.localhost:${port}\n  Fallback → http://127.0.0.1:${port}\n`,
  );
} catch (e) {
  console.error(e);
  await app.close();
  await preview.close();
  store.close();
  process.exit(1);
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await app.close();
    await preview.close();
    store.close();
    process.exit(0);
  });
