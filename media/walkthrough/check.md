## Confirm the path works in one click

Click **Run environment check** on the left, and the extension will:

1. Check whether `ANTHROPIC_API_KEY` is set (subscription users should clear it).
2. Send a tiny test request to confirm it can reach Claude.

A result pops up after a few seconds:

- **Subscription auth works ✅** — all set, move on to the next step.
- **API key detected ⚠️** — currently on metered billing; to use your subscription, clear that variable and restart VS Code, then retry.
- **Connection failed ✗** — usually you haven't run `claude login` yet; sign in and retry. See the "Output → Braid" panel for details.
