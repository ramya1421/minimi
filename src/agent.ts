/**
 * agent.ts — the core agent loop
 *
 * Flow per turn:
 *   1. Resolve date references in the user message (deterministic, pre-model)
 *   2. Build system prompt with current date, ledger, and any prior context
 *   3. Stream a model response; the model may invoke web_search server-side
 *   4. Stream tokens to the client via SSE as they arrive
 *   5. Persist the exchange and update the ledger (fire-and-forget)
 *
 * The web search tool (type "web_search_20250305") is executed server-side
 * by Anthropic. We define it in the tools array; the model decides when to
 * call it, runs it internally, and streams results + text back.
 * We never call a search API ourselves.
 *
 * Streaming event shape for server-side search:
 *   content_block_start  { type: "server_tool_use", name: "web_search" }
 *     → model is initiating a search
 *   content_block_start  { type: "web_search_tool_result" }
 *     → results have arrived; the model will now compose its answer
 *   content_block_delta  { type: "text_delta" }
 *     → answer text tokens; stream to client
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  WebSearchTool20250305,
  ToolUnion,
  ServerToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type { Response } from "express";
import { buildSystemPrompt } from "./prompt";
import type { SearchRecord } from "./search";
import {
  saveMessage,
  saveLedgerEntry,
  buildLedgerBlock,
  buildPriorContextBlock,
  getThreadHistory,
} from "./memory";
import { primaryDateRange, hasPastDateReference } from "./dates";

// ── constants ─────────────────────────────────────────────────────────────────

// Cap on stream iterations; each iteration may include multiple server-side
// tool calls. In practice one stream handles all searches in a turn.
const MAX_STREAM_ROUNDS = 4;

// ── Anthropic client ──────────────────────────────────────────────────────────

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ── server-side web search tool definition ────────────────────────────────────

const WEB_SEARCH_TOOL: WebSearchTool20250305 = {
  type: "web_search_20250305",
  name: "web_search",
};

// ── types ─────────────────────────────────────────────────────────────────────

export interface TurnRequest {
  userId: string;
  threadId: string;
  userMessage: string;
  /** User's IANA timezone, e.g. "Asia/Kolkata" */
  timezone: string;
  /** User's local ISO timestamp */
  clientNow: string;
  /** Express response object — SSE events are written here */
  res: Response;
}

// ── SSE helpers ───────────────────────────────────────────────────────────────

function sseEvent(res: Response, event: string, data: unknown): void {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ── main entry point ──────────────────────────────────────────────────────────

export async function runTurn(req: TurnRequest): Promise<void> {
  const turnStart = Date.now();
  const { userId, threadId, userMessage, timezone, clientNow, res } = req;

  const userNow = new Date(clientNow);

  // ── 1. Pre-model date resolution ──────────────────────────────────────────
  // Deterministic, synchronous, never a tool. Runs before the model is called.

  let priorContextBlock: string | null = null;

  if (hasPastDateReference(userMessage, userNow)) {
    const range = primaryDateRange(userMessage, userNow);
    if (range) {
      sseEvent(res, "status", {
        text: `Looking up conversation from "${range.label}"…`,
      });
      priorContextBlock = buildPriorContextBlock(userId, range);
      if (!priorContextBlock) {
        // No records found — tell the model so it can say so honestly
        priorContextBlock =
          `## Prior conversation lookup\n` +
          `No messages found for the referenced date ("${range.label}"). ` +
          `Be transparent about this — do not invent prior messages.`;
      }
    }
  }

  // ── 2. System prompt ──────────────────────────────────────────────────────

  const ledgerBlock = buildLedgerBlock(userId);
  const systemPrompt = buildSystemPrompt({
    userNow: clientNow,
    timezone,
    ledgerBlock,
    priorContextBlock,
  });

  // ── 3. Conversation history ───────────────────────────────────────────────

  const history = getThreadHistory(threadId);

  const messages: Anthropic.MessageParam[] = [
    ...history.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    { role: "user" as const, content: userMessage },
  ];

  // Persist the new user message immediately
  saveMessage({
    userId,
    threadId,
    role: "user",
    content: userMessage,
    createdAt: new Date().toISOString(),
  });

  // ── 4. Streaming model call ───────────────────────────────────────────────

  const searches: SearchRecord[] = [];
  let fullAssistantText = "";
  let searchStartedAt = 0;

  try {
    for (let round = 0; round < MAX_STREAM_ROUNDS; round++) {
      const roundStart = Date.now();

      const stream = anthropic.messages.stream({
        model: "claude-opus-4-5",
        max_tokens: 4096,
        // Cache the (large) system prompt across turns to reduce latency
        system: [
          {
            type: "text",
            text: systemPrompt,
            cache_control: { type: "ephemeral" },
          },
        ] as Anthropic.TextBlockParam[],
        tools: [WEB_SEARCH_TOOL] as ToolUnion[],
        messages,
      });

      for await (const event of stream) {
        switch (event.type) {
          case "content_block_start": {
            const block = event.content_block;

            if (block.type === "server_tool_use" && block.name === "web_search") {
              // Model is initiating a web search
              const serverBlock = block as ServerToolUseBlock;
              const query =
                typeof serverBlock.input === "object" &&
                  serverBlock.input !== null &&
                  "query" in serverBlock.input
                  ? String((serverBlock.input as { query: unknown }).query)
                  : "web search";

              searchStartedAt = Date.now();
              sseEvent(res, "status", { text: `Searching: ${query}` });
              sseEvent(res, "searching", { queries: [query] });
              searches.push({ query, resultCount: 0, durationMs: 0 });
            }

            if (block.type === "web_search_tool_result") {
              // Results are back; update the last search record's duration
              if (searches.length > 0 && searchStartedAt > 0) {
                searches[searches.length - 1].durationMs = Date.now() - searchStartedAt;
              }
              sseEvent(res, "status", { text: "Composing answer…" });
            }
            break;
          }

          case "content_block_delta": {
            if (event.delta.type === "text_delta") {
              fullAssistantText += event.delta.text;
              sseEvent(res, "token", { text: event.delta.text });
            }
            break;
          }

          case "message_start":
          case "message_delta":
          case "message_stop":
            break;
        }
      }

      const finalMsg = await stream.finalMessage();
      console.log(
        `[agent] round=${round + 1} stop=${finalMsg.stop_reason} ` +
        `searches=${searches.length} ms=${Date.now() - roundStart}`
      );

      // With server-side tools the model always stops at end_turn after
      // completing its searches. We only loop if it somehow asks for more.
      if (finalMsg.stop_reason !== "tool_use") break;

      // Defensive: if the model somehow requests client-side tool use,
      // append the content and loop (shouldn't occur with web_search_20250305)
      messages.push({ role: "assistant" as const, content: finalMsg.content });
    }
  } catch (err: unknown) {
    const msg =
      err instanceof Error ? err.message : "Unknown error during generation";
    console.error("[agent] stream error:", msg);
    sseEvent(res, "error", { text: `Something went wrong: ${msg}` });
  }

  // ── 5. Persist and update ledger ──────────────────────────────────────────

  if (fullAssistantText) {
    const now = new Date().toISOString();
    saveMessage({
      userId,
      threadId,
      role: "assistant",
      content: fullAssistantText,
      createdAt: now,
    });

    // Fire-and-forget: extract topic+claims and save to ledger
    // Does not block the response
    extractAndSaveLedgerEntry(
      userId,
      threadId,
      userMessage,
      fullAssistantText,
      now
    ).catch((e) => console.error("[ledger]", e));
  }

  // ── 6. Done event ─────────────────────────────────────────────────────────

  sseEvent(res, "done", {
    searches,
    totalMs: Date.now() - turnStart,
  });

  console.log(
    `[agent] done userId=${userId} threadId=${threadId} ` +
    `totalMs=${Date.now() - turnStart}`
  );
}

// ── ledger extraction ─────────────────────────────────────────────────────────

/**
 * Extract topic and key claims from the assistant's answer and save to the
 * ledger. Runs after the response is sent; does not add perceived latency.
 *
 * Uses a small fast model to keep this cheap.
 */
async function extractAndSaveLedgerEntry(
  userId: string,
  threadId: string,
  userMessage: string,
  assistantAnswer: string,
  createdAt: string
): Promise<void> {
  if (assistantAnswer.length < 50) return;

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 300,
    system:
      "Extract a one-line topic summary and up to 5 key factual claims from this Q&A. " +
      'Return ONLY valid JSON: { "topic": "...", "claims": ["...", ...] }. ' +
      "Claims must be short, factual sentences. Omit conversational filler.",
    messages: [
      {
        role: "user",
        content: `User: ${userMessage}\n\nAssistant: ${assistantAnswer}`,
      },
    ],
  });

  const raw =
    response.content[0].type === "text" ? response.content[0].text : "";

  try {
    const cleaned = raw
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    const parsed = JSON.parse(cleaned) as {
      topic?: string;
      claims?: string[];
    };
    saveLedgerEntry({
      userId,
      threadId,
      createdAt,
      topic: parsed.topic ?? "(no topic)",
      claims: Array.isArray(parsed.claims) ? parsed.claims : [],
    });
  } catch {
    console.error("[ledger] parse failed:", raw.slice(0, 100));
  }
}
