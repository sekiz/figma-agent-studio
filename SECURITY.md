# Security policy

## Threat model

figma-agent-studio runs a WebSocket bridge on the user's machine. Browsers don't apply CORS to WebSockets, so without protection any website a designer visits could try to drive their Figma canvas through `ws://localhost:3055`.

Mitigations:

1. **Loopback only.** The bridge binds to `127.0.0.1`.
2. **Origin allow-list.** Only the plugin iframe (origin `null`), non-browser clients (no `Origin` header) and `https://*.figma.com` are accepted. Any other page gets HTTP 401 at the handshake.
3. **Pairing codes.** An agent must present the 8-character code the plugin shows (31-symbol alphabet, about 8.5×10¹¹ combinations). A connection is closed after 5 failed attempts.
4. **No remote services.** The only outbound request is the optional, read-only call to `api.figma.com` for library component metadata, using a token the user provides.

`FIGMA_ACCESS_TOKEN` is read from the environment and never logged or sent anywhere except `api.figma.com`.

## Reporting a vulnerability

Please **don't** open a public issue. Use GitHub's *Report a vulnerability* (private security advisory) on this repository. We aim to respond within 7 days.
