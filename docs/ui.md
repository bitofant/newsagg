# UI (`ui/`) and HTTP server (`src/server/`)

SvelteKit SPA + Tailwind CSS, served as static files by the Fastify backend. Real-time push via SSE.

## Front page

- Mobile-responsive single-column layout per user, up to 100 topics.
- Icons via `lucide-svelte` (tree-shakeable SVG, styled via Tailwind `currentColor`).
- Per-card vertical button column (right-aligned): read/unread (`CircleCheck`/`Circle`), thumbs up (`ThumbsUp`), thumbs down (`ThumbsDown`), unmerge (`Split`).
- "Mark above as read" dividers between cards: clicking marks all topics above as read (and topics below as unread); read state persisted via `POST /api/readtopics` (atomic full replace). Single-topic toggles use `PUT /api/readtopics/:topicId { read }` (delta).
- Read topics shown below unread section at reduced opacity.
- SSE subscription for live front-page updates: `GET /api/events?token=<jwt>` sends `frontpage` events when a new front page is generated; UI auto-refreshes via `EventSource` with exponential backoff reconnect.
- **Bullets rendering**: when a topic is in long-form mode, both the front-page card and the topic detail page render `newInfo` (with an amber "NEW:" prefix) followed by `bullets` as a single `<ul>` below the summary paragraph. Same shape on both views; cards may grow taller for active topics, intentionally accepted.
- Inline source expander: click "N sources" on a card to expand article list with titles (linked to original), source names, relative timestamps; lazy-loaded via `GET /api/topics/:topicId/articles`.
- Per-article ungroup button (`Unlink2` icon) in inline source list and detail page: removes article from topic and re-classifies it via `POST /api/topics/:topicId/articles/:articleId/ungroup`.

## Topic detail page (`/topics/:topicId`)

Clicking the title/summary area of a card navigates to a polished, hero-style view (larger typography, roomier `max-w-2xl` layout, labelled action buttons). Loads bundled topic metadata + articles + read state via `GET /api/topics/:topicId`. Shareable URL. Same vote / read / ungroup actions as the card. Empty topics (after ungroup) redirect to `/`.

## Unmerge overlay

Per-topic unmerge button on both card and detail page opens an absolutely-positioned overlay with four phases:

- `confirm` — split-pane: 60%-opacity green thumbs-up to commit / red thumbs-down to cancel, with "Split topic?" headline.
- `pending` — yellow background + spinning `Loader2`.
- `done` — green background listing the new topic titles, tap-to-dismiss → refreshes the front page or routes back to `/`.
- `error` — red background with the error message.

Flow uses long-polling: POST kicks off, then `pollUnmergeResult` repeatedly with `wait=30`. While the overlay is in pending/done/error state, SSE-driven page replacements are held in `pendingFreshPage` and applied on dismiss so the card the user is looking at doesn't disappear under the overlay. (The card column is getting crowded — TODO for a future overflow-menu redesign.)

## Other pages

- **`/login`, `/register`** — auth flow (bcrypt + JWT).
- **`/settings`** — PATCH `/api/preferences` accepts `manualPreferences` only (sending `preferenceProfile` returns 400). The generated profile is shown read-only.
- **`/status`** (no auth, not linked from nav): LLM metrics (busy %, req/min, tok/s over `ai.statusWindowMs`), consolidator buffer depth + processing flag + estimated backlog duration, aggregator queue length + active workers, topic/article counts, a Deployable card (build time from mtime of `dist/server/index.js` + process uptime), per-user list with interval / last-front-page age / overdue status / 14-day signal count. All relative times tick every second. Auto-refreshes every 5s; a `RefreshIndicator` ring next to the title visualizes the poll cycle (blue fills 0→100% over 2s while in-flight, orange if still pending after 2s, then green/red on response and drains over the remainder of the cycle). State changes push fresh DOM nodes that fade in over the prior one's fade-out, so transitions never get re-targeted mid-flight. Data source: `GET /api/status`.

## Design decisions

### adapter-static over adapter-node (2026-04-10)
Switched SvelteKit from `adapter-node` to `adapter-static` with SPA fallback (`fallback: 'index.html'`). The UI is a pure SPA with no server-side load functions — all data comes via API calls. adapter-node produces a Node.js SSR server which can't be served by `@fastify/static`; adapter-static produces plain HTML/JS/CSS files that Fastify serves directly. Root `+layout.ts` exports `prerender = false` and `ssr = false`.

### Card design: floating, borderless, rounded (2026-04-14)
Topic cards use shadow-based separation (no borders), large border radius (`rounded-xl`), and a subtle hover lift effect (`hover:shadow-lg hover:-translate-y-0.5`). Page background is warm stone (`stone-50`/`stone-950`) so white cards appear to float. Rationale: modern "material" aesthetic — cards as floating paper rather than bordered boxes. Keep this direction when adding new card-like UI elements.

### Status endpoint over CLI script, no auth (2026-04-16)
Pipeline health is exposed via `GET /api/status` and a `/status` UI page, not a `npm run check` CLI script. Rationale: the most useful signals — consolidator `buffer.length`, aggregator `queue.length` and `activeWorkers` — are in-memory state inside the running process, not queryable from SQLite. A standalone script would only see the DB side. The endpoint is unauthenticated because (a) this is a personal/hobby deployment, (b) it exposes no user-generated content, only counters and email addresses that the user already controls, and (c) it needs to be trivially curl-able. If the project ever becomes multi-tenant, gate the endpoint and stop emitting emails.

### Unmerge endpoint is async + long-poll (2026-04-28)
`POST /api/topics/:id/unmerge` returns immediately after kicking off the LLM work in a fire-and-forget IIFE; the client then long-polls `GET /api/topics/:id/unmerge-result?wait=30`. Job state lives in an in-memory `Map<topicId, UnmergeJob>` in the server with a 5-minute TTL after completion. Rationale: the LLM split call can take 5-30s (or up to the request timeout of 5 min for an unhealthy backend); holding a synchronous HTTP request open that long is fragile (proxies, connection drops, mobile networks) and gives the UI no opportunity to show a meaningful in-progress state. The async pattern lets the UI show a yellow "splitting…" overlay with a spinner while polling, and a green "split into: X, Y" overlay on success. The poll endpoint is gated behind auth and returns 404 if no job is registered for the topic id (so polls for nonexistent jobs fail fast). Long-poll wait is server-clamped to 60 seconds; the client uses 30. Job state is intentionally NOT persisted to SQLite — a process restart loses in-flight jobs, but the user can just retry, and the consolidator's actual write side either committed or didn't (the LLM call isn't transactional, but topic creation and front-page rewrites happen at the end of the function in tight succession). Rejected alternative: synchronous endpoint with the spinner driven purely by `fetch` in-flight time — works but couples UI feedback granularity to network behavior, and any proxy 60s read timeout breaks the flow silently.
