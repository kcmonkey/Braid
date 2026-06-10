## Reuse your signed-in Claude subscription

Braid calls Claude Code through `@anthropic-ai/claude-agent-sdk` and **directly reuses the subscription credentials already signed in on your machine** — no API key to enter in the extension.

**You only need two things:**

- ✅ Signed in to your **Claude subscription account** (Pro / Max / Team / Enterprise) via `claude login`.
- ⛔ `ANTHROPIC_API_KEY` is **not set** in your environment.

> Once `ANTHROPIC_API_KEY` is set, the SDK switches to **metered API billing** instead of your subscription. This is the most common pitfall for subscription users.

If you *do* want to use the metered API (rather than your subscription), just keep `ANTHROPIC_API_KEY` — the self-check in the next step is only a reminder and won't force any change.
