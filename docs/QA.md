# Real-canvas QA checklist

The automated tests run against a strict fake of the Figma Plugin API. This checklist is the pass in the **real Figma desktop app** that has to happen before a release is called stable. It takes about 20 minutes.

## Setup (5 min)

1. Install the plugin: download `agent-studio-figma-plugin-<version>.zip` from Releases (or run `pnpm build`). In Figma desktop choose *Plugins → Development → Import plugin from manifest…* and pick `manifest.json`.
2. Add the MCP server to Claude Code: `claude mcp add figma-studio -- npx -y @figma-studio/mcp-server`. For a local build, use `node <repo>/packages/mcp-server/dist/index.js`.
3. Open a **new, empty design file**. Run the plugin, then click **Create demo screen + design system**.
   - [ ] A "Landing — Desktop" frame (1440 wide) and a "Demo Design System" frame appear, and the landing frame is selected.
   - [ ] *Local variables* shows a "Demo Tokens" collection (colors, spacing, radius).
4. In Claude Code, say: `Connect to Figma with code XXXX-XXXX` (use the code from the plugin window).
   - [ ] The agent replies "Paired with … in "<file name>"".

## 1. Multi-surface: `/figma-studio:adapt_screen`

- [ ] Four frames appear to the right of the source: iOS 393, Android 412, TV 1920, Tablet 834.
- [ ] iOS and Android use the demo **navigation components** (instances, not plain frames).
- [ ] The TV top tabs and the tablet sidebar are reported as **decisions**, and fuchsia `[DS-AUDIT-FLAG]` cards sit above those frames.
- [ ] iOS: the feature cards are stacked in one column, with a 59pt top spacer and a 34pt bottom spacer.
- [ ] Tablet: the cards sit in 2 columns, with a 320 sidebar placeholder on the left.
- [ ] TV: an 80px margin on every edge, the cards in a single clipped row, and a white focus ring on the first card.
- [ ] Android: the cards have no drop shadows.
- [ ] Nothing overflows its frame. Use `figma_preview` on one frame if unsure.
- Answer **A** for one decision and **C** for the other:
  - [ ] A: a component appears on a "🧩 DS Proposals" page, and the placeholder becomes an instance of it.
  - [ ] C: the placeholder is renamed `[WIREFRAME] …`.
  - [ ] Both flags disappear.
- [ ] Ask "undo that": the last operation's layers are removed.

## 2. RTL: `/figma-studio:localize_rtl ar`

- [ ] A "— RTL (ar)" frame appears. Header, breadcrumb and footer rows are reversed and right-aligned.
- [ ] The breadcrumb chevron is swapped to **Icon/Chevron/Right**, an instance and not a flipped vector.
- [ ] `+90 555 123 4567` and `www.example.com` stay LTR and untranslated.
- [ ] The Arabic copy is written into the text layers and renders right-to-left without clipping.

## 3. Audit: `/figma-studio:audit_and_fix`

- [ ] Reported: hardcoded color on "Promo Banner", off-grid padding (13) on "Promo Banner", and contrast failure on "Terms apply".
- [ ] After the fix, the "Promo Banner" fill is **bound** to `color/brand` (the variable icon shows in the fill row) and looks identical.

## 4. Handoff: `/figma-studio:dev_handoff swiftui` (select the iOS frame first)

- [ ] A section "[HANDOFF] … - iOS" appears below the frame. It contains a token table, yellow notes and a dark code card.
- [ ] Table rows include `color/surface` with `Color("surface")`.

## 5. Robustness

- [ ] Close the plugin mid-session, run any tool, and get a clear "re-open the plugin" message. Re-open the plugin and the next call works without re-pairing.
- [ ] Select two frames and run the audit. The agent asks which one to use.
- [ ] A ~2,000-layer page transposes without Figma freezing. The UI keeps rendering and the plugin log shows progress.

## Reporting

For any unchecked box, open an issue with:

- a screenshot,
- the tool output (paste the agent's tool result),
- your Figma desktop version.
