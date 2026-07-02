import { runCli } from "./index.js";

runCli().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "CLI failed"}\n`);
  process.exitCode = 1;
});

