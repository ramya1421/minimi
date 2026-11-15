# Design

## 1. How it works

```
Client (browser)
  │  POST /api/chat  { message, threadId, timezone, clientNow }
  ▼
server.ts  ──→  agent.ts
                  │
                  ├─ [1] Date resolver (chrono-node, synchronous, pre-model)
                  │       Parses "last Monday", "3 November", "yesterday" → concrete DateRange
                  │       Retrieves matching messages from SQLite → "Relevant prior conversation" block
                  │
                  ├─ [2] System prompt builder
                  │       Assembles: role + authoritative date/time + tool policy +
                  │       grounding rules + compact ledger of past topics + prior context block
                  │
                  ├─ [3] Streaming model call (web_search_20250305 tool)
                  │       Model decides when to search; Anthropic executes searches server-side
                  │       Tokens and search status events stream back over SSE
                  │
                  └─ [4] Post-turn (fire-and-forget)
                          Save messages to SQLite
                          Extract topic + claims → ledger (small model call, non-blocking)

Client receives SSE events:
  status  →  shown in status line
  searching  →  accumulated for "Searched N queries" disclosure
  token  →  appended to streaming bubble
  done  →  metadata (search count, latency)
```

## 2. Why this design

**Temporal grounding as a pre-step, not a tool.** The model's internal clock is unreliable and varies by training cutoff. Giving the model a "get current date" tool would still let it reason about relative dates incorrectly (e.g. miscounting days). Instead, the client sends its IANA timezone and ISO timestamp on every request. A deterministic resolver (chrono-node) converts phrases like "last Monday" to exact UTC ranges before the model is ever called. The model receives concrete dates, not fuzzy phrases.

**SQLite over a vector DB.** The queries here are time-bounded: "what did I ask on 3 November?" The right data structure is a table with an index on `(userId, createdAt)`. A range query over timestamps is O(log n) and returns exactly the right rows. A vector similarity search would retrieve semantically similar messages, not the ones from the right date. SQLite also needs zero infrastructure and runs in-process, keeping setup to one `npm install`.

**Compact ledger alongside full message history.** Full messages can be large. The ledger is a lightweight table of `(date, topic, claims[])` — typically a few hundred characters per conversation. It is injected into every system prompt so the model always knows what topics have been covered, without requiring a database query on every turn. Full messages are only retrieved when a date range is resolved.

**Native server-side web search.** Using the `web_search_20250305` tool means Anthropic runs the search, cites sources inline, and handles rate limits and result formatting. The alternative — a third-party API (Tavily, Brave, Exa) — requires an extra API key, an extra HTTP hop, and manual citation assembly. The tradeoff: less control over which queries fire and no raw result inspection. For this use case the tradeoff favours simplicity.

**Raw SDK over a framework.** The agent loop is 60 lines of explicit code. Every round, every tool call, every event is visible. A framework like LangChain would add ~400KB of dependencies, abstract away the streaming layer, and make debugging harder without adding anything for a single-tool agent.

**Prompt caching.** The system prompt is marked `cache_control: ephemeral`. On repeated turns in the same session, Anthropic can serve the cached prompt prefix, reducing time-to-first-token.

## 3. Considered and rejected

**Multi-agent / planner-executor split.** A planner agent could decompose "check pricing for 5 CRMs" into 5 sub-tasks and dispatch them. Rejected because the model already issues parallel searches when given the right instruction in the system prompt. A planner adds two extra model calls and a coordination layer with no measurable quality gain for the query types here.

**Vector DB for memory.** Semantic search would let the model find related past conversations even without an explicit date reference. Rejected because the primary use case is date-scoped lookups ("what did I ask on Monday?"), not similarity search. Adding a vector DB (Pinecone, Chroma, pgvector) would triple the infrastructure footprint for a capability that isn't needed. The ledger serves the "topic-based recall" case at negligible cost.

**Second model as reranker/verifier.** A verifier model could score search results for relevance before they reach the main model. Rejected because (a) server-side search already returns ranked results, (b) an extra model call adds ~1–2 seconds of latency, and (c) the main model is already instructed to prefer official sources and flag conflicts. Net gain too small.

**LangChain / LlamaIndex / Vercel AI SDK.** Each adds a large dependency tree and an abstraction layer over model calls and streaming. The Vercel AI SDK is well-designed but optimised for React server components. Plain `express` + raw SDK gives full control over the SSE wire format and the agent loop shape. Rejected on YAGNI grounds.

**Separate fetch tool.** A fetch tool would let the model retrieve full page content from a URL found in search results, useful for pricing pages that render dynamically. Rejected per the hard rules. The compensating behaviour: the model is instructed to include "as of [date]" qualifiers and use official sources when available.

## 4. Known limits

- **Search opacity.** Server-side search doesn't expose raw results. We can't inspect result URLs for quality, deduplicate, or rerank. If the model cites a low-quality source, we can't intercept it.
- **Memory is per-user, not cross-device.** The user ID is a cookie. A user on a different browser or device starts with an empty ledger.
- **Ledger extraction adds a second model call.** It runs fire-and-forget after the response is sent, so it doesn't affect latency — but it does add cost and can fail silently if the model returns malformed JSON.
- **chrono-node misses some phrases.** Expressions like "the week of November 11" or "Q3" are not reliably parsed. The agent falls back to asking the user to clarify.
- **No search result cache.** Identical queries within a session re-execute. For multi-turn re-verification this wastes tokens and time.

## 5. What I'd do with another week

- **Claim-level verification pass.** After re-searching old claims, run a structured diff: extract the old claim, extract the current information, and explicitly label each as `unchanged / changed / couldn't verify` with source and date. Currently this is handled by instruction in the system prompt; a dedicated pass would be more reliable.
- **Source-quality ranker.** Score search result domains (official vendor sites, major news outlets) over aggregator/SEO-spam sites. Inject the ranked subset into context rather than all results.
- **Scheduled re-checks ("watch this").** Let users mark a question for periodic re-verification. A background job re-runs the searches weekly and diffs the answers.
- **LLM-as-judge evals.** Replace the current structural assertions with a small judge model that scores answer quality, citation accuracy, and honesty on a rubric. Much more sensitive to regressions than string matching.
- **Search result TTL cache.** Cache search results (keyed by query + date) for 10–60 minutes. Identical queries within a session reuse the cache. Cuts latency and token cost on multi-step verification flows.
