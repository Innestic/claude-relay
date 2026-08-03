import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { makeLogger } from "../logger";
import { getToolSchemas, type ToolSchema } from "./tool-schemas";
import type { ToolResult } from "./tools";

const log = makeLogger("channel");

type ToolDispatcher = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

export function createMcpServer(
    capabilities: Record<string, unknown>,
    instructions: string,
): { server: Server; toolSchemas: ToolSchema[] } {
    const server = new Server(
        { name: "relay-channel", version: "0.1.5" },
        { capabilities, instructions },
    );
    const toolSchemas = getToolSchemas();
    return { server, toolSchemas };
}

export function wireToolHandlers(
    server: Server,
    toolSchemas: ToolSchema[],
    dispatch: ToolDispatcher,
): ToolDispatcher {
    const callTool: ToolDispatcher = async (toolName, args) => {
        const started = Date.now();
        log.debug("tool_call", { tool: toolName, args });
        try {
            const result = await dispatch(toolName, args);
            let code: string | undefined;
            if (result.isError) {
                try {
                    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
                        code?: string;
                    };
                    code = payload.code;
                } catch {
                    code = "unknown";
                }
            }
            log.debug("tool_result", {
                tool: toolName,
                ok: !result.isError,
                code,
                duration_ms: Date.now() - started,
            });
            return result;
        } catch (e) {
            log.error("tool_call_err", {
                tool: toolName,
                err: e instanceof Error ? e.message : String(e),
                duration_ms: Date.now() - started,
            });
            throw e;
        }
    };

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolSchemas }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const toolName = request.params.name;
        const args = (request.params.arguments ?? {}) as Record<string, unknown>;
        return callTool(toolName, args);
    });
    return callTool;
}
