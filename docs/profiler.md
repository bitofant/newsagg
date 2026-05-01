# Profiler (`src/profiler/`)

User preference profile generation. Debounced background process that converts manual prefs + vote history into the markdown `preference_profile` consumed by the aggregator.

- Debounced trigger: both `onVote(userId)` and `onManualProfileChange(userId)` reset a shared 15-minute timer per user (last-write-wins).
- When the timer fires: reads `users.manual_preferences` + vote history with article/topic context, asks LLM to write a bullet-only "preferences program" with `## Follow` / `## Skip` sections framed at the **class** level (e.g. "Ukraine war and Russia-NATO escalation", not "Donbas battle"; "Shifts of power in European politics", not "Hungarian elections"). Manual preferences are preserved verbatim where they fit; the class-level abstraction applies to vote-inferred bullets only.
- Skips generation only when manual preferences are empty AND votes < 3 (a manual edit alone is enough signal to generate).
- Stores result in `users.preference_profile`. The manual input is `users.manual_preferences` and is never written by the profiler.
- Uses `reasoningEffort: 'high'` (rare, debounced — not on a hot path).

## Design decisions

### Preferences program: bullet-only, class-level (2026-04-28)
The generated `preference_profile` was reshaped from free-form ~400-word second-person prose into a bullet-only markdown "preferences program" with two sections, `## Follow` and `## Skip`, ~10 bullets each. Bullets must express a **class** of interest, not a specific instance — "Ukraine war and Russia-NATO escalation", not "Donbas battle"; "Shifts of power in European politics", not "Hungarian elections". The prompt enforces this with explicit GOOD/BAD examples (mirroring the long-form-summary bullet style enforcement in the consolidator). Hard preferences from the manual field are preserved verbatim where they fit; the class-level rule applies only to vote-inferred bullets. Rationale: prose summaries latched onto the literal articles voted on, so once a story cooled the profile kept biasing the relevance scorer toward dead specifics; a paragraph format also let the LLM vary phrasing run-over-run, producing scoring drift even when user signal hadn't changed. The aggregator's relevance-scoring prompt was unchanged — bullet input drops in cleanly. Existing `preference_profile` values get overwritten at next debounced regeneration.
