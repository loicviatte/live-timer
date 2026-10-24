# Live timer

Speaker timer for live streams: an iPad (huge countdown), a TV (countdown + YouTube live chat + polls +
live duration) and an admin page, all synced over the local network. No dependencies: just Node.js.

**Using it?** Read [`READ ME FIRST.txt`](READ%20ME%20FIRST.txt): install Node.js, double-click **Start Timer**.

## Layout

- `Start Timer.command` — double-click launcher (keeps the Mac awake, restarts the server after an update)
- `app/server.js` — HTTP + Server-Sent Events server (timer state, controls, settings)
- `app/youtube-chat.js` — reads the YouTube live chat, polls and live duration (no API key)
- `app/updater.js` — live updates from this GitHub repository
- `app/public/` — iPad (`/`), TV (`/tv`) and admin (`/admin`) pages
- `app/settings.json`, `app/runtime-state.json` — this Mac's settings and current countdown (not in git)
- `tests/` — automated tests

## Live updates

Every Mac running the timer checks this repository every 5 minutes. When `main` has a new commit, the admin
shows **Update available → Install now**. Installing downloads that exact commit, checks that the code parses,
swaps the files (keeping `settings.json` and the running countdown), and restarts the server in ~2 s; every
screen reloads by itself. Publishing an update = pushing to `main`, so **run the tests before pushing**.

## Tests

```
node --test tests/*.test.js
```

Server stress tests (malformed requests, 200 screens, 600 simultaneous clicks, crash/restart mid-countdown),
YouTube chat reader tests against a fake YouTube (reconnects, timeouts, moderation, both poll formats), a chat
endurance test (thousands of polling cycles with every kind of failure: every message must arrive exactly once),
the screen timer (hours of simulated countdown, connection loss, clock jumps) and live updates (fake GitHub).

`tests/fixtures/fake-youtube.js` can be loaded into the real server
(`NODE_OPTIONS="--require ./tests/fixtures/fake-youtube.js"`) for an end-to-end soak with an endless chaotic chat.
