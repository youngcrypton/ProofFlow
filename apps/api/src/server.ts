import { validateProductionEnvironment, validateProductionRuntime } from "./production-config";
import { prepareProductionStorage } from "./runtime-storage";

validateProductionEnvironment();
await prepareProductionStorage();
await validateProductionRuntime();

const [{ SqliteRepository }, { createApp }, { logStructured }] = await Promise.all([
  import("./sqlite-repository"),
  import("./index"),
  import("./observability")
]);

const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.HOST ?? "0.0.0.0";
const repository = new SqliteRepository(process.env.PROOFFLOW_DB_PATH ?? "./data/proofflow.sqlite");
const app = createApp(repository);

logStructured({ event: "server_startup", port, hostname, healthPath: "/health", routes: ["GET /health", "GET /metrics", "GET /api/v1/*"] });

export default {
  port,
  hostname,
  fetch: app.fetch
};
