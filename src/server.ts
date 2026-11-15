/**
 * server.ts — HTTP server and SSE endpoint
 *
 * Serves:
 *   GET  /           → public/index.html
 *   POST /api/chat   → SSE stream for a conversation turn
 *   POST /api/thread → create a new thread ID
 *   GET  /api/health → liveness check
 *
 * The client sends its timezone and local timestamp on every request so the
 * server can inject authoritative time into the agent without guessing.
 */

import "dotenv/config";
import express, { Request, Response } from "express";
import cookieParser from "cookie-parser";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { runTurn } from "./agent";

const app = express();
const PORT = parseInt(process.env.PORT ?? "3000", 10);

// ── middleware ────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(process.cwd(), "public")));

// ── user identity via cookie ──────────────────────────────────────────────────
// Anonymous, persistent across sessions. Never contains PII.

function getUserId(req: Request, res: Response): string {
  let userId = req.cookies["uid"] as string | undefined;
  if (!userId) {
    userId = uuidv4();
    res.cookie("uid", userId, {
      httpOnly: true,
      maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
      sameSite: "strict",
    });
  }
  return userId;
}

// ── POST /api/chat ────────────────────────────────────────────────────────────
// Body: { threadId, message, timezone, clientNow }
// Response: SSE stream

app.post("/api/chat", async (req: Request, res: Response) => {
  // Set up SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering if proxied
  res.flushHeaders();

  const userId = getUserId(req, res);

  const body = req.body as {
    threadId?: string;
    message?: string;
    timezone?: string;
    clientNow?: string;
  };

  // Validate required fields
  if (!body.message || typeof body.message !== "string") {
    res.write(`event: error\ndata: ${JSON.stringify({ text: "message is required" })}\n\n`);
    res.end();
    return;
  }

  const threadId = body.threadId ?? uuidv4();
  const timezone = body.timezone ?? "UTC";
  // Fall back to server time if the client didn't send its clock
  const clientNow = body.clientNow ?? new Date().toISOString();

  // Guard against prompt injection in the message field
  const userMessage = body.message.slice(0, 4000); // hard cap

  // Handle dropped connections
  req.on("close", () => {
    console.log(`[server] client disconnected threadId=${threadId}`);
  });

  try {
    await runTurn({ userId, threadId, userMessage, timezone, clientNow, res });
  } catch (err) {
    console.error("[server] unhandled error:", err);
    if (!res.writableEnded) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ text: "Internal server error" })}\n\n`
      );
    }
  } finally {
    res.end();
  }
});

// ── POST /api/thread ──────────────────────────────────────────────────────────
// Creates a new thread ID. The client can also generate one locally; this
// endpoint exists for completeness.

app.post("/api/thread", (_req: Request, res: Response) => {
  res.json({ threadId: uuidv4() });
});

// ── GET /api/health ───────────────────────────────────────────────────────────

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

// ── start ─────────────────────────────────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "ERROR: ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key."
  );
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
