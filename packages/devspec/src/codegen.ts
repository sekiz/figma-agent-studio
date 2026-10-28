import { rgbaToHex, type DsIndex, type DsVariable, type NodeSnapshot, type Rgba } from "@figma-studio/shared-types";
import { camel, kebab, nativeToken, tailwindRadius, tailwindSpacing, tokenLeaf, type TargetStack } from "./tokens.js";

/**
 * Deterministic code scaffolds. They mirror the Auto-Layout structure (stacks, spacing, padding,
 * colors and component instances) so engineers start from the right skeleton — not production code.
 */

export interface CodegenOptions {
  maxDepth?: number;
  maxLines?: number;
}

interface Ctx {
  vars: Map<string, DsVariable>;
  stack: TargetStack;
  lines: string[];
  maxDepth: number;
  maxLines: number;
  truncated: boolean;
}

const pascal = (s: string) => {
  const c = camel(s);
  return c.charAt(0).toUpperCase() + c.slice(1) || "Component";
};
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const escJsx = (s: string) => s.replace(/[{}<>]/g, (ch) => `{"${ch}"}`).replace(/\n/g, " ");
const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function fillOf(n: NodeSnapshot, ctx: Ctx): { variable?: DsVariable; hex?: string } | null {
  const p = (n.fills ?? []).filter((f) => f.visible && f.type === "SOLID" && f.color).pop();
  if (!p) return null;
  const variable = p.boundVariableId ? ctx.vars.get(p.boundVariableId) : undefined;
  return { variable, hex: rgbaToHex(p.color as Rgba) };
}

function numberToken(n: NodeSnapshot, field: string, ctx: Ctx): DsVariable | undefined {
  const id = n.boundVariables?.[field];
  return id ? ctx.vars.get(id) : undefined;
}

function emit(ctx: Ctx, depth: number, line: string): void {
  if (ctx.lines.length >= ctx.maxLines) {
    ctx.truncated = true;
    return;
  }
  ctx.lines.push(`${"  ".repeat(depth)}${line}`);
}

const visibleChildren = (n: NodeSnapshot) => (n.children ?? []).filter((c) => c.visible);
const isStack = (n: NodeSnapshot) => n.layoutMode === "HORIZONTAL" || n.layoutMode === "VERTICAL";

// ---------------------------------------------------------------------------
// React + Tailwind v4
// ---------------------------------------------------------------------------

function tw(n: NodeSnapshot, ctx: Ctx, parentRow: boolean): string {
  const cls: string[] = [];
  if (isStack(n)) {
    cls.push("flex", n.layoutMode === "VERTICAL" ? "flex-col" : "flex-row");
    if (n.layoutWrap === "WRAP") cls.push("flex-wrap");
    const gapVar = numberToken(n, "itemSpacing", ctx);
    if (n.primaryAxisAlignItems === "SPACE_BETWEEN") cls.push("justify-between");
    else if (n.itemSpacing) cls.push(gapVar ? `gap-${kebab(tokenLeaf(gapVar.name))}` : tailwindSpacing(n.itemSpacing, "gap"));
    const pad = (v: number | undefined, p: string) => (v ? cls.push(tailwindSpacing(v, p)) : undefined);
    if (n.paddingLeft === n.paddingRight) pad(n.paddingLeft, "px");
    else (pad(n.paddingLeft, "pl"), pad(n.paddingRight, "pr"));
    if (n.paddingTop === n.paddingBottom) pad(n.paddingTop, "py");
    else (pad(n.paddingTop, "pt"), pad(n.paddingBottom, "pb"));
    const align = { MIN: "start", CENTER: "center", MAX: "end", BASELINE: "baseline", SPACE_BETWEEN: "between", SPACE_EVENLY: "evenly", SPACE_AROUND: "around" } as const;
    if (n.counterAxisAlignItems && n.counterAxisAlignItems !== "MIN") cls.push(`items-${align[n.counterAxisAlignItems]}`);
    if (n.primaryAxisAlignItems && n.primaryAxisAlignItems !== "MIN" && n.primaryAxisAlignItems !== "SPACE_BETWEEN") cls.push(`justify-${align[n.primaryAxisAlignItems]}`);
  }
  if (n.layoutSizingHorizontal === "FILL") cls.push(parentRow ? "flex-1" : "w-full");
  else if (n.layoutSizingHorizontal === "FIXED" && n.type !== "TEXT") cls.push(`w-[${Math.round(n.width)}px]`);
  if (!isStack(n) && n.type !== "TEXT") cls.push(`h-[${Math.round(n.height)}px]`);
  const fill = n.type === "TEXT" ? null : fillOf(n, ctx);
  if (fill) cls.push(fill.variable ? `bg-${kebab(tokenLeaf(fill.variable.name))}` : `bg-[${fill.hex}]`);
  if (n.cornerRadius) cls.push(tailwindRadius(n.cornerRadius));
  if (n.type === "TEXT") {
    if (n.fontSize) cls.push(`text-[${n.fontSize}px]`);
    if (n.fontWeight && n.fontWeight >= 600) cls.push(n.fontWeight >= 700 ? "font-bold" : "font-semibold");
    const tf = fillOf(n, ctx);
    if (tf) cls.push(tf.variable ? `text-${kebab(tokenLeaf(tf.variable.name))}` : `text-[${tf.hex}]`);
    if (n.textAlignHorizontal === "CENTER") cls.push("text-center");
    if (n.textAlignHorizontal === "RIGHT") cls.push("text-right");
  }
  return cls.join(" ");
}

function reactNode(n: NodeSnapshot, ctx: Ctx, depth: number, parentRow: boolean): void {
  if (n.type === "INSTANCE") return emit(ctx, depth, `<${pascal(n.component?.componentSetName ?? n.component?.mainComponentName ?? n.name)} />`);
  const cls = tw(n, ctx, parentRow);
  if (n.type === "TEXT") return emit(ctx, depth, `<p className="${cls}">${escJsx(short(n.characters ?? ""))}</p>`);
  const kids = visibleChildren(n);
  if (kids.length === 0 || depth >= ctx.maxDepth) return emit(ctx, depth, `<div className="${cls}" />${kids.length ? ` {/* ${kids.length} children */}` : ""}`);
  emit(ctx, depth, `<div className="${cls}"> {/* ${n.name} */}`);
  kids.forEach((c) => reactNode(c, ctx, depth + 1, n.layoutMode === "HORIZONTAL"));
  emit(ctx, depth, "</div>");
}

// ---------------------------------------------------------------------------
// SwiftUI
// ---------------------------------------------------------------------------

function swiftNode(n: NodeSnapshot, ctx: Ctx, depth: number): void {
  if (n.type === "INSTANCE") return emit(ctx, depth, `${pascal(n.component?.componentSetName ?? n.component?.mainComponentName ?? n.name)}()`);
  if (n.type === "TEXT") {
    const weight = n.fontWeight && n.fontWeight >= 600 ? (n.fontWeight >= 700 ? ", weight: .bold" : ", weight: .semibold") : "";
    emit(ctx, depth, `Text("${esc(short(n.characters ?? ""))}")`);
    emit(ctx, depth + 1, `.font(.system(size: ${n.fontSize ?? 17}${weight}))`);
    return;
  }
  const kids = visibleChildren(n);
  const fill = fillOf(n, ctx);
  const modifiers: string[] = [];
  const pad = (edge: string, v: number | undefined) => (v ? modifiers.push(`.padding(${edge}${v})`) : undefined);
  if (isStack(n)) {
    if (n.paddingLeft === n.paddingRight) pad(".horizontal, ", n.paddingLeft);
    else (pad(".leading, ", n.paddingLeft), pad(".trailing, ", n.paddingRight));
    if (n.paddingTop === n.paddingBottom) pad(".vertical, ", n.paddingTop);
    else (pad(".top, ", n.paddingTop), pad(".bottom, ", n.paddingBottom));
  }
  if (n.layoutSizingHorizontal === "FILL") modifiers.push(".frame(maxWidth: .infinity, alignment: .leading)");
  else if (!isStack(n)) modifiers.push(`.frame(width: ${Math.round(n.width)}, height: ${Math.round(n.height)})`);
  if (fill) modifiers.push(`.background(${fill.variable ? nativeToken(fill.variable, "swiftui") : `Color(hex: "${fill.hex}")`})`);
  if (n.cornerRadius) modifiers.push(`.clipShape(RoundedRectangle(cornerRadius: ${n.cornerRadius}))`);

  if (!isStack(n) || kids.length === 0 || depth >= ctx.maxDepth) {
    emit(ctx, depth, kids.length && depth >= ctx.maxDepth ? `${pascal(n.name)}() // ${kids.length} children` : "Rectangle().fill(.clear)");
  } else {
    const v = n.layoutMode === "VERTICAL";
    const align = v ? (n.counterAxisAlignItems === "CENTER" ? ".center" : n.counterAxisAlignItems === "MAX" ? ".trailing" : ".leading") : ".center";
    const spacing = n.primaryAxisAlignItems === "SPACE_BETWEEN" ? 0 : n.itemSpacing ?? 0;
    emit(ctx, depth, `${v ? "VStack" : "HStack"}(alignment: ${align}, spacing: ${spacing}) { // ${n.name}`);
    kids.forEach((c, i) => {
      if (i > 0 && n.primaryAxisAlignItems === "SPACE_BETWEEN") emit(ctx, depth + 1, "Spacer()");
      swiftNode(c, ctx, depth + 1);
    });
    emit(ctx, depth, "}");
  }
  modifiers.forEach((m) => emit(ctx, depth + 1, m));
}

// ---------------------------------------------------------------------------
// Jetpack Compose
// ---------------------------------------------------------------------------

function composeNode(n: NodeSnapshot, ctx: Ctx, depth: number): void {
  if (n.type === "INSTANCE") return emit(ctx, depth, `${pascal(n.component?.componentSetName ?? n.component?.mainComponentName ?? n.name)}()`);
  if (n.type === "TEXT") {
    const weight = n.fontWeight && n.fontWeight >= 600 ? `, fontWeight = FontWeight.${n.fontWeight >= 700 ? "Bold" : "SemiBold"}` : "";
    return emit(ctx, depth, `Text("${esc(short(n.characters ?? ""))}", fontSize = ${n.fontSize ?? 16}.sp${weight})`);
  }
  const mods: string[] = [];
  if (n.layoutSizingHorizontal === "FILL") mods.push(".fillMaxWidth()");
  else if (!isStack(n)) mods.push(`.size(${Math.round(n.width)}.dp, ${Math.round(n.height)}.dp)`);
  const fill = fillOf(n, ctx);
  if (fill) {
    const color = fill.variable ? nativeToken(fill.variable, "jetpack_compose") : `Color(0xFF${fill.hex!.slice(1)})`;
    mods.push(n.cornerRadius ? `.background(${color}, RoundedCornerShape(${n.cornerRadius}.dp))` : `.background(${color})`);
  }
  if (isStack(n) && (n.paddingLeft || n.paddingTop || n.paddingRight || n.paddingBottom)) {
    mods.push(`.padding(start = ${n.paddingLeft ?? 0}.dp, top = ${n.paddingTop ?? 0}.dp, end = ${n.paddingRight ?? 0}.dp, bottom = ${n.paddingBottom ?? 0}.dp)`);
  }
  const modifier = mods.length ? `modifier = Modifier${mods.join("")}` : "";
  const kids = visibleChildren(n);
  if (!isStack(n) || kids.length === 0 || depth >= ctx.maxDepth) {
    emit(ctx, depth, `Box(${modifier})${kids.length ? ` // ${n.name}: ${kids.length} children` : ""}`);
    return;
  }
  const v = n.layoutMode === "VERTICAL";
  const arrangement =
    n.primaryAxisAlignItems === "SPACE_BETWEEN" ? `Arrangement.SpaceBetween` : `Arrangement.spacedBy(${n.itemSpacing ?? 0}.dp)`;
  const args = [modifier, `${v ? "verticalArrangement" : "horizontalArrangement"} = ${arrangement}`].filter(Boolean).join(", ");
  emit(ctx, depth, `${v ? "Column" : "Row"}(${args}) { // ${n.name}`);
  kids.forEach((c) => composeNode(c, ctx, depth + 1));
  emit(ctx, depth, "}");
}

// ---------------------------------------------------------------------------
// React Native
// ---------------------------------------------------------------------------

function rnNode(n: NodeSnapshot, ctx: Ctx, depth: number): void {
  if (n.type === "INSTANCE") return emit(ctx, depth, `<${pascal(n.component?.componentSetName ?? n.component?.mainComponentName ?? n.name)} />`);
  if (n.type === "TEXT") {
    const weight = n.fontWeight && n.fontWeight >= 600 ? `, fontWeight: '${n.fontWeight}'` : "";
    return emit(ctx, depth, `<Text style={{ fontSize: ${n.fontSize ?? 16}${weight} }}>${escJsx(short(n.characters ?? ""))}</Text>`);
  }
  const style: string[] = [];
  if (isStack(n)) {
    style.push(`flexDirection: '${n.layoutMode === "VERTICAL" ? "column" : "row"}'`);
    if (n.primaryAxisAlignItems === "SPACE_BETWEEN") style.push("justifyContent: 'space-between'");
    else if (n.itemSpacing) style.push(`gap: ${n.itemSpacing}`);
    if (n.paddingLeft) style.push(`paddingLeft: ${n.paddingLeft}`);
    if (n.paddingRight) style.push(`paddingRight: ${n.paddingRight}`);
    if (n.paddingTop) style.push(`paddingTop: ${n.paddingTop}`);
    if (n.paddingBottom) style.push(`paddingBottom: ${n.paddingBottom}`);
  } else {
    style.push(`width: ${Math.round(n.width)}`, `height: ${Math.round(n.height)}`);
  }
  if (n.layoutSizingHorizontal === "FILL") style.push("alignSelf: 'stretch'");
  const fill = fillOf(n, ctx);
  if (fill) style.push(`backgroundColor: ${fill.variable ? `theme.colors.${camel(tokenLeaf(fill.variable.name))}` : `'${fill.hex}'`}`);
  if (n.cornerRadius) style.push(`borderRadius: ${n.cornerRadius}`);
  const kids = visibleChildren(n);
  const open = `<View style={{ ${style.join(", ")} }}`;
  if (kids.length === 0 || depth >= ctx.maxDepth) return emit(ctx, depth, `${open} />`);
  emit(ctx, depth, `${open}> {/* ${n.name} */}`);
  kids.forEach((c) => rnNode(c, ctx, depth + 1));
  emit(ctx, depth, "</View>");
}

export function generateCode(root: NodeSnapshot, index: DsIndex, stack: TargetStack, options: CodegenOptions = {}): { language: string; text: string } {
  const ctx: Ctx = {
    vars: new Map(index.variables.map((v) => [v.id, v])),
    stack,
    lines: [],
    maxDepth: options.maxDepth ?? 5,
    maxLines: options.maxLines ?? 80,
    truncated: false,
  };
  const name = pascal(root.name.replace(/—.*$/, "").trim() || "Screen");
  switch (stack) {
    case "react_tailwind":
      ctx.lines.push(`export function ${name}() {`, "  return (");
      reactNode(root, ctx, 2, false);
      ctx.lines.push("  );", "}");
      break;
    case "swiftui":
      ctx.lines.push(`struct ${name}: View {`, "  var body: some View {");
      swiftNode(root, ctx, 2);
      ctx.lines.push("  }", "}");
      break;
    case "jetpack_compose":
      ctx.lines.push("@Composable", `fun ${name}() {`);
      composeNode(root, ctx, 1);
      ctx.lines.push("}");
      break;
    case "react_native":
      ctx.lines.push(`export function ${name}() {`, "  return (");
      rnNode(root, ctx, 2);
      ctx.lines.push("  );", "}");
      break;
  }
  if (ctx.truncated) ctx.lines.push(stack === "swiftui" || stack === "jetpack_compose" ? "// … truncated" : "/* … truncated */");
  const language = { react_tailwind: "tsx", swiftui: "swift", jetpack_compose: "kotlin", react_native: "tsx" }[stack];
  return { language, text: ctx.lines.join("\n") };
}
