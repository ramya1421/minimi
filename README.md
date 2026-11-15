# Search Agent

A web-search chat agent with temporal memory. Ask it about current pricing, recent news, or follow up on past conversations.

## Setup

```bash
cp .env.example .env        # add your API key
npm install
npm run dev                 # open http://localhost:3000
```

## Eval

```bash
npm run eval
```

Runs ~12 scripted scenarios against the date resolver, memory layer, and system prompt builder. No live API calls for most tests.
