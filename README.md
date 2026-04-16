# newsagg

A personal news aggregator that uses local LLMs to classify RSS articles into topics, track ongoing stories, and generate a personalized front page.

This is a hobby project born out of curiosity: how well can LLMs handle data classification and aggregation tasks? The answer, at least with [Gemma 4 31B (Q4_K_M)](https://ollama.com/library/gemma4:31b-it-q4_K_M) running locally via Ollama, turns out to be: surprisingly well.

## How it works

1. **Grab** — polls RSS feeds for new articles
2. **Consolidate** — an LLM matches each article to existing topics (or creates new ones), detects when a story has substantial new developments, and generates topic summaries
3. **Aggregate** — builds a personalized front page per user, optionally ranking topics by relevance using an LLM-generated preference profile
4. **Profile** — learns what you care about from thumbs up/down votes and generates a preference description the LLM can reason about

Articles can belong to multiple topics. Topics accumulate over time with summaries that update as stories develop. Users mark topics as read and they disappear from the front page.

### LLM usage

Every box marked LLM is a separate call to Ollama. All responses are JSON (except summaries and preference profiles which are plain text).

```mermaid
sequenceDiagram
    participant RSS as RSS Feeds
    participant G as Grabber
    participant C as Consolidator
    participant LLM as Ollama (LLM)
    participant DB as SQLite
    participant A as Aggregator
    participant P as Profiler
    participant UI as Browser

    Note over G,C: Article ingestion (every 5s batch)
    RSS->>G: new articles
    G->>C: enqueue(article)
    C->>DB: already seen this URL?
    DB-->>C: no

    Note over C,LLM: 1. Topic matching (per page of 50 topics)
    C->>DB: fetch topic page
    C->>LLM: match articles to topics
    LLM-->>C: [{article: 0, topicIds: [5, 12]}, ...]

    alt no topic match
        Note over C,LLM: 2. New topic creation
        C->>LLM: generate title + description
        LLM-->>C: {title, description}
        C->>DB: create topic + save article
    else matched existing topic(s)
        C->>DB: save article, link to topic(s)
        Note over C,LLM: 3. Article assessment
        C->>LLM: is this substantial? concluded?
        LLM-->>C: {isSubstantial, isConcluded}
        opt substantial or 2+ articles without summary
            Note over C,LLM: 4. Topic summary generation
            C->>LLM: summarize topic from recent articles
            LLM-->>C: "2-3 sentence summary"
            C->>DB: update topic summary
        end
    end
    C->>DB: enqueue signals for all users

    Note over A,LLM: Front page generation (per user, on interval)
    A->>DB: read 14-day signal window + read topics
    A->>DB: build sections from topic data

    opt user has preference profile
        Note over A,LLM: 5. Relevance scoring
        A->>LLM: rate topic relevance (1-5) given profile
        LLM-->>A: [4, 2, 5, 1, ...]
        Note over A: re-sort sections by relevance
    end
    A->>DB: save front page
    A-->>UI: SSE: new front page

    Note over P,LLM: Preference profiling (15min after last vote)
    UI->>P: user voted on article
    Note over P: debounce 15 min
    P->>DB: fetch vote history with context
    Note over P,LLM: 6. Profile generation
    P->>LLM: generate preference description from votes
    LLM-->>P: "You are interested in..."
    P->>DB: save preference profile
```

## Stack

- **Runtime**: Node.js (v22.5+)
- **Language**: TypeScript
- **LLM**: [Ollama](https://ollama.com/) via OpenAI-compatible API (any model that can output JSON)
- **Database**: SQLite via `node:sqlite` (zero external dependencies)
- **HTTP**: Fastify
- **Frontend**: SvelteKit (static SPA) + Tailwind CSS v4
- **Real-time**: Server-Sent Events for live front page updates

Single process, single SQLite file, no message queues, no external databases. Ollama is the only dependency outside of Node.js.

## Setup

### Prerequisites

- Node.js 22.5+
- [Ollama](https://ollama.com/) with a model pulled (e.g. `ollama pull gemma4:31b-it-q4_K_M`)

### Install and run

```bash
npm install
cd ui && npm install && cd ..

# Create your config from the template
cp config.example.json config.json
# Edit config.json — at minimum, set your RSS feeds and Ollama model

# Development
npm run dev          # backend with hot reload
cd ui && npm run dev # frontend dev server (proxies API to backend)

# Production
npm run build
npm start
```

### Production ops

```bash
./start.sh    # daemonize (nohup), logs to newsagg.log
./stop.sh     # stop via pidfile
./rebuild.sh  # build UI + compile backend
./restart.sh  # stop + rebuild + start
```

### First use

Set `"registrationEnabled": true` in `config.json`, start the app, and register a user. You can disable registration after.

## Configuration

All config lives in `config.json` (gitignored). See [`config.example.json`](config.example.json) for the template.

| Key | Description |
|-----|-------------|
| `feeds` | Array of RSS feed URLs |
| `ai.url` | Ollama API URL (default: `http://localhost:11434/v1`) |
| `ai.model` | Model name as shown in `ollama list` |
| `ai.maxContextTokens` | Max input tokens for prompt sizing |
| `aggregator.intervalMs` | How often to regenerate front pages per user |
| `aggregator.workers` | Concurrent front page generation workers |
| `server.port` | HTTP port |
| `server.registrationEnabled` | Allow new user registration |

## License

MIT
