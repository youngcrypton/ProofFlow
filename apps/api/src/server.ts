import { SqliteRepository } from "./sqlite-repository";
import { createApp } from "./index";

const repository = new SqliteRepository(process.env.PROOFFLOW_DB_PATH ?? "./data/proofflow.sqlite");
const app = createApp(repository);

export default {
  port: Number(process.env.PORT ?? 8787),
  fetch: app.fetch
};
