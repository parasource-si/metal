// the lab server's stand-in Metal, on 127.0.0.1:8799 in the server namespace
import { createBotServer } from "../harness.mjs";

const bot = await createBotServer({ port: 8799 });
console.log(`bot on ${bot.port}`);
process.on("SIGTERM", () => { bot.close(); process.exit(0); });
