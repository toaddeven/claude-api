/**
 * Express HTTP Server
 *
 * Provides OpenAI-compatible API endpoints backed by Claude Code CLI.
 */

import express from "express";
import { createServer, type Server } from "http";
import { handleChatCompletions, handleModels, handleHealth } from "./routes.js";
import { concurrencyMiddleware } from "./queue.js";

let serverInstance: Server | null = null;

function createApp(): express.Application {
  const app = express();

  app.use(express.json({ limit: "10mb" }));

  // Debug request logging
  app.use((req, _res, next) => {
    if (process.env.DEBUG) {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    }
    next();
  });

  // CORS for local development
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    next();
  });

  app.options("*", (_req, res) => {
    res.sendStatus(200);
  });

  // Routes
  app.get("/health", handleHealth);
  app.get("/v1/models", handleModels);
  app.post("/v1/chat/completions", concurrencyMiddleware, handleChatCompletions);

  // 404
  app.use((_req, res) => {
    res.status(404).json({
      error: { message: "Not found", type: "invalid_request_error", code: "not_found" },
    });
  });

  // 500
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[Server Error]:", err.message);
    res.status(500).json({
      error: { message: err.message, type: "server_error", code: null },
    });
  });

  return app;
}

export interface ServerConfig {
  port: number;
  host?: string;
}

export async function startServer(config: ServerConfig): Promise<Server> {
  const { port, host = "127.0.0.1" } = config;

  if (serverInstance) {
    console.log("[Server] Already running");
    return serverInstance;
  }

  const app = createApp();

  return new Promise((resolve, reject) => {
    serverInstance = createServer(app);

    serverInstance.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use`));
      } else {
        reject(err);
      }
    });

    serverInstance.listen(port, host, () => {
      console.log(`[Server] Running at http://${host}:${port}`);
      console.log(`[Server] Chat endpoint: http://${host}:${port}/v1/chat/completions`);
      resolve(serverInstance!);
    });
  });
}

export async function stopServer(): Promise<void> {
  if (!serverInstance) return;

  return new Promise((resolve, reject) => {
    serverInstance!.close((err) => {
      if (err) {
        reject(err);
      } else {
        console.log("[Server] Stopped");
        serverInstance = null;
        resolve();
      }
    });
  });
}

export function getServer(): Server | null {
  return serverInstance;
}
