import { createConfiguredApi, readServerConfig } from "./server.js";

const config = readServerConfig();
const app = await createConfiguredApi(config);
await app.listen({ host: config.host, port: config.port });

