import { main } from "./channel/index";
import { watchParent } from "./channel/parent-watch";
import { initLogger } from "./logger";

initLogger({ console: true });

function shutdown(): void {
    process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Claude Code never signals us on exit, and the MCP stdio transport ignores
// stdin EOF, so without this the channel is leaked on every session exit.
watchParent({ onOrphaned: shutdown });

main().catch((err: unknown) => {
    process.stderr.write(`relay: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
});
