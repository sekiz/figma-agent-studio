import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/**
 * Workflow prompts. MCP clients expose them as slash commands (Claude Code: /figma-studio:adapt_screen).
 * Each one is a short runbook: goal, steps in tool order, guardrails, and the report format,
 * so a run costs as few turns as possible and ends with a summary the designer can act on.
 */

const SHARED_RULES = `Rules:
- Work on the designer's current selection unless they named a layer. If the selection isn't exactly one frame, ask which one.
- If a tool says the session isn't paired, ask for the code shown in the Agent Studio plugin and call figma_connect, then continue.
- Use the high-level tools; never rebuild layouts with low-level edits.
- Never pick an option for a missing design-system component yourself. Put each decision to the designer exactly as reported (A synthesize / B adapt variant / C wireframe) and wait for the answer, unless they already told you a default.
- Keep tool results at detail="concise" unless you need the full list.
- If a warning hints at a broken layout (overflow, clipped text, non-Auto-Layout source), look at that one frame with figma_preview before reporting it.
- If the designer rejects a result, figma_undo removes what you created.
- Reply in the designer's language. Keep the final report brief: what was created (frame ids), what needs their attention, and the next step you recommend.`;

const user = (text: string): GetPromptResult => ({ messages: [{ role: "user", content: { type: "text", text } }] });

const SURFACES = ["ios", "android_m3", "smart_tv_10ft", "tablet"];

function parseSurfaces(raw: string | undefined): string[] {
  if (!raw?.trim()) return SURFACES;
  const aliases: Record<string, string> = { android: "android_m3", m3: "android_m3", tv: "smart_tv_10ft", ipad: "tablet", iphone: "ios" };
  const picked = raw
    .toLowerCase()
    .split(/[\s,]+/)
    .map((s) => aliases[s] ?? s)
    .filter((s) => SURFACES.includes(s));
  return picked.length ? [...new Set(picked)] : SURFACES;
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "adapt_screen",
    {
      title: "Adapt a screen to other devices",
      description: "Turns the selected desktop frame into iOS, Android, TV and/or tablet frames using the design system.",
      argsSchema: { surfaces: z.string().optional().describe("e.g. 'ios, android, tv' (default: all four)") },
    },
    ({ surfaces }) =>
      user(`Adapt the selected Figma frame for: ${parseSurfaces(surfaces).join(", ")}.

Steps:
1. Call figma_transpose_surface once with all target surfaces.
2. If it reports DECISIONS NEEDED, list them for me in one short message (one line per decision with options A/B/C) and wait. Then call figma_resolve_missing_component for each answer.
3. Summarise the generated frames and any warnings worth acting on (for example "source isn't Auto-Layout" or missing fonts), and suggest one next step such as a handoff or an audit.

${SHARED_RULES}`),
  );

  server.registerPrompt(
    "localize_rtl",
    {
      title: "Localize a screen to RTL",
      description: "Mirrors the selected frame to Right-to-Left and translates its copy into Arabic or Hebrew.",
      argsSchema: { language: z.string().optional().describe("ar (Arabic, default) or he (Hebrew)") },
    },
    ({ language }) => {
      const lang = language?.toLowerCase().startsWith("he") ? "he" : "ar";
      const name = lang === "he" ? "Hebrew" : "Arabic";
      return user(`Create an RTL ${name} version of the selected Figma frame.

Steps:
1. Call figma_mirror_rtl with targetLanguage="${lang}" (keep the LTR original: createDuplicate=true).
2. Translate every returned \`id|text\` line into natural, concise ${name} product UI copy:
   - Match the tone and length of the source, since buttons and labels must still fit.
   - Keep numbers, placeholders ({name}, %s), brand names and product names unchanged.
   - Use the conventional ${name} UI terms (for example the platform's standard words for Settings, Sign in, Cancel).
3. Send all translations in one figma_apply_text call.
4. Report the RTL frame id, what was kept LTR, and any instances that need a Direction=RTL variant.

${SHARED_RULES}`);
    },
  );

  server.registerPrompt(
    "audit_and_fix",
    {
      title: "Audit against the design system",
      description: "Scores the selected frame against the design system, fixes exact token matches and lists what needs a designer.",
    },
    () =>
      user(`Audit the selected Figma frame against our design system.

Steps:
1. Call figma_audit_design_system (concise).
2. If it reports safe token bindings, tell me how many, then apply them with autoFixSafeTokens=true. Those bindings are exact value matches, so they don't change the visual result.
3. Report the score before and after, then the remaining issues grouped by priority:
   (1) WCAG contrast failures: give the ratio and a suggested accessible token or color direction,
   (2) detached components: suggest which component to restore,
   (3) off-palette colors and off-grid spacing.
   Include layer ids so I can find each one.

${SHARED_RULES}`),
  );

  server.registerPrompt(
    "dev_handoff",
    {
      title: "Generate developer handoff",
      description: "Creates the [HANDOFF] section (token ledger, responsive notes, code scaffold) for the selected frame.",
      argsSchema: { stack: z.string().optional().describe("react_tailwind | swiftui | jetpack_compose | react_native (default: picked from the frame's platform)") },
    },
    ({ stack }) =>
      user(`Generate a developer handoff for the selected Figma frame${stack ? ` using the ${stack} stack` : ""}.

Steps:
1. ${stack ? `Use targetStack="${stack}".` : `Pick targetStack from the frame: iOS → swiftui, Android → jetpack_compose, otherwise react_tailwind. Use figma_inspect only if the platform isn't clear from the frame name.`}
2. Call figma_generate_dev_handoff (concise). Request detail="detailed" only if I ask for the code in chat.
3. Report the section that was created and flag any hardcoded colors in the ledger, since engineers will need tokens for them.

${SHARED_RULES}`),
  );

  server.registerPrompt(
    "ship_all_platforms",
    {
      title: "Full multi-platform pipeline",
      description: "Audit → fix tokens → adapt to every surface → resolve missing components → handoff per platform.",
      argsSchema: { surfaces: z.string().optional().describe("Default: ios, android, tv, tablet") },
    },
    ({ surfaces }) => {
      const list = parseSurfaces(surfaces);
      return user(`Run the full DesignOps pipeline on the selected Figma frame for: ${list.join(", ")}.

Steps (stop and ask me only where noted):
1. Audit: call figma_audit_design_system with autoFixSafeTokens=true, so the source is token-clean before it's copied ${list.length} times.
2. Adapt: call figma_transpose_surface once with all surfaces.
3. Decisions: if any are reported, ask me once, grouped in a single message, then resolve them all.
4. Handoff: for each generated frame, call figma_generate_dev_handoff with its native stack (ios → swiftui, android_m3 → jetpack_compose, tablet → swiftui, smart_tv_10ft → react_tailwind).
5. Final report as a short table: surface | frame id | DS components used | open issues.

${SHARED_RULES}`);
    },
  );
}
