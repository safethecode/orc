import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v3";
import type { Store } from "../db/store.ts";
import type { Inbox } from "./inbox.ts";

export function createMcpServer(store: Store, inbox: Inbox): McpServer {
  const server = new McpServer({
    name: "orchestrator",
    version: "0.1.0",
  });

  server.tool(
    "send_message",
    "Send a message to another agent",
    {
      to: z.string(),
      content: z.string(),
      taskRef: z.string().optional(),
    },
    async (args, extra) => {
      const agentName =
        (extra.requestId as string) ?? "unknown";
      const message = inbox.send(agentName, args.to, args.content, args.taskRef);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(message),
          },
        ],
      };
    },
  );

  server.tool(
    "read_inbox",
    "Get unread messages for an agent",
    {
      agentName: z.string(),
    },
    async (args) => {
      const messages = inbox.receive(args.agentName);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(messages),
          },
        ],
      };
    },
  );

  server.tool(
    "get_task_status",
    "Check a task's current status",
    {
      taskId: z.string(),
    },
    async (args) => {
      const task = store.getTask(args.taskId);
      if (!task) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Task ${args.taskId} not found`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(task),
          },
        ],
      };
    },
  );

  server.tool(
    "report_result",
    "Submit a task result",
    {
      taskId: z.string(),
      result: z.string(),
      tokens: z.number().optional(),
      cost: z.number().optional(),
    },
    async (args) => {
      store.updateTask(args.taskId, {
        result: args.result,
        status: "completed",
        completedAt: new Date().toISOString(),
        tokenUsage: args.tokens,
        costUsd: args.cost,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Task ${args.taskId} completed`,
          },
        ],
      };
    },
  );

  server.tool(
    "lock_file",
    "Lock a file for exclusive editing",
    {
      filePath: z.string(),
      agentName: z.string(),
      taskId: z.string(),
    },
    async (args) => {
      const acquired = store.lockFile(
        args.filePath,
        args.agentName,
        args.taskId,
      );
      if (!acquired) {
        const existing = store.isFileLocked(args.filePath);
        return {
          content: [
            {
              type: "text" as const,
              text: `File already locked by ${existing?.agentName ?? "unknown"}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Locked ${args.filePath}`,
          },
        ],
      };
    },
  );

  server.tool(
    "unlock_file",
    "Release a file lock",
    {
      filePath: z.string(),
    },
    async (args) => {
      store.unlockFile(args.filePath);
      return {
        content: [
          {
            type: "text" as const,
            text: `Unlocked ${args.filePath}`,
          },
        ],
      };
    },
  );

  server.tool("list_agents", "List all registered agents", {}, async () => {
    const agents = store.listAgents();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(agents),
        },
      ],
    };
  });

  return server;
}

export async function startMcpServer(
  store: Store,
  inbox: Inbox,
): Promise<McpServer> {
  const server = createMcpServer(store, inbox);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
