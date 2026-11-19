// Side-effect import that scrubs ambient Metal env before a module snapshots it (scripts/mcp-server.ts reads
// DUSK_URL / DUSK_PORT at evaluation). Import order is the contract: keep it above the module under test.
import { isAmbientDuskKey } from "./dusk-env.ts";

for (const key of Object.keys(process.env)) {
  if (isAmbientDuskKey(key)) delete process.env[key];
}
