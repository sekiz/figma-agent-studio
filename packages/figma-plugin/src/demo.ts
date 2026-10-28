import { makeText, stack } from "./render.js";

/**
 * One-click demo: a 1440px landing page plus a tiny design system, so anyone can try every tool
 * without their own file. Gaps and issues are deliberate:
 * - iOS and Android navigation exist; TV tabs and the tablet sidebar don't (→ missing-component decisions)
 * - one hardcoded brand fill, one low-contrast caption, one off-grid padding (→ audit findings)
 * - a phone number, a URL and a back chevron (→ RTL shielding and icon swap)
 */

const hex = (h: string): RGB => ({ r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255 });
const solid = (c: RGB): SolidPaint => ({ type: "SOLID", color: c });

interface Tokens {
  surface: Variable;
  onSurface: Variable;
  brand: Variable;
  onBrand: Variable;
  container: Variable;
  muted: Variable;
}

function bound(paint: SolidPaint, v: Variable): SolidPaint {
  return figma.variables.setBoundVariableForPaint(paint, "color", v);
}

async function tokens(): Promise<{ t: Tokens; spacing: Variable[] }> {
  const col = figma.variables.createVariableCollection("Demo Tokens");
  const mode = col.modes[0]!.modeId;
  const color = (name: string, value: string, scopes: VariableScope[]) => {
    const v = figma.variables.createVariable(name, col, "COLOR");
    v.setValueForMode(mode, hex(value));
    v.scopes = scopes;
    return v;
  };
  const t: Tokens = {
    surface: color("color/surface", "#FFFFFF", ["FRAME_FILL", "SHAPE_FILL"]),
    onSurface: color("color/on-surface", "#0F172A", ["TEXT_FILL", "SHAPE_FILL"]),
    brand: color("color/brand", "#4F46E5", ["ALL_FILLS"]),
    onBrand: color("color/on-brand", "#FFFFFF", ["TEXT_FILL"]),
    container: color("color/surface-container", "#F1F5F9", ["FRAME_FILL"]),
    muted: color("color/on-surface-muted", "#475569", ["TEXT_FILL"]),
  };
  const spacing = [8, 16, 24, 32].map((value) => {
    const v = figma.variables.createVariable(`spacing/${value / 4}`, col, "FLOAT");
    v.setValueForMode(mode, value);
    v.scopes = ["GAP"];
    return v;
  });
  const radius = figma.variables.createVariable("radius/md", col, "FLOAT");
  radius.setValueForMode(mode, 12);
  radius.scopes = ["CORNER_RADIUS"];
  return { t, spacing };
}

async function text(chars: string, size: number, style: string, fill: SolidPaint): Promise<TextNode> {
  const node = await makeText(chars, { size, style });
  node.name = chars.slice(0, 40);
  node.fills = [fill];
  return node;
}

async function bar(name: string, width: number, height: number, t: Tokens, labels: string[], title?: string): Promise<ComponentNode> {
  const c = figma.createComponent();
  c.name = name;
  c.layoutMode = "HORIZONTAL";
  c.resize(width, height);
  c.primaryAxisSizingMode = "FIXED";
  c.counterAxisSizingMode = "FIXED";
  c.paddingLeft = c.paddingRight = 16;
  c.counterAxisAlignItems = title ? "MAX" : "CENTER";
  c.primaryAxisAlignItems = title ? "MIN" : "SPACE_BETWEEN";
  c.paddingBottom = title ? 8 : 0;
  c.fills = [bound(solid(hex("#FFFFFF")), t.surface)];
  if (title) c.appendChild(await text(title, height >= 90 ? 34 : 22, "Bold", bound(solid(hex("#0F172A")), t.onSurface)));
  for (const label of labels) {
    const tab = stack(label, "VERTICAL", 4);
    tab.counterAxisAlignItems = "CENTER";
    const icon = figma.createEllipse();
    icon.name = "Icon";
    icon.resize(24, 24);
    icon.fills = [bound(solid(hex("#475569")), t.muted)];
    tab.appendChild(icon);
    tab.appendChild(await text(label, 11, "Medium", bound(solid(hex("#475569")), t.muted)));
    c.appendChild(tab);
  }
  return c;
}

async function chevron(name: string, t: Tokens, pointsLeft: boolean): Promise<ComponentNode> {
  const c = figma.createComponent();
  c.name = name;
  c.resize(24, 24);
  c.fills = [];
  const v = figma.createVector();
  v.vectorPaths = [{ windingRule: "NONZERO", data: pointsLeft ? "M 15 5 L 8 12 L 15 19" : "M 9 5 L 16 12 L 9 19" }];
  v.strokes = [bound(solid(hex("#0F172A")), t.onSurface)];
  v.strokeWeight = 2;
  c.appendChild(v);
  return c;
}

export async function seedDemo(): Promise<{ frameId: string; libraryId: string }> {
  const { t, spacing } = await tokens();
  const [s8, s16, s24, s32] = spacing as [Variable, Variable, Variable, Variable];
  const page = figma.currentPage;
  const origin = page.children.reduce((x, n) => Math.max(x, n.x + n.width), 0) + (page.children.length ? 400 : 0);

  // ---------------------------------------------------------------- mini design system
  const library = stack("Demo Design System", "HORIZONTAL", 48, 48);
  library.layoutWrap = "WRAP";
  library.counterAxisSpacing = 48;
  library.primaryAxisSizingMode = "FIXED";
  library.resize(1440, 100);
  library.counterAxisSizingMode = "AUTO";
  library.fills = [solid(hex("#F8FAFC"))];
  page.appendChild(library);

  const button = figma.createComponent();
  button.name = "Button/Primary";
  button.layoutMode = "HORIZONTAL";
  button.primaryAxisSizingMode = "AUTO";
  button.counterAxisSizingMode = "AUTO";
  button.paddingLeft = button.paddingRight = 20;
  button.paddingTop = button.paddingBottom = 10;
  button.cornerRadius = 12;
  button.fills = [bound(solid(hex("#4F46E5")), t.brand)];
  button.appendChild(await text("Get started", 15, "Medium", bound(solid(hex("#FFFFFF")), t.onBrand)));
  const left = await chevron("Icon/Chevron/Left", t, true);
  const right = await chevron("Icon/Chevron/Right", t, false);
  const components = [
    button,
    left,
    right,
    await bar("Navigation/Bar/Top/iOS", 393, 96, t, [], "Title"),
    await bar("Navigation/Bar/Bottom/iOS", 393, 49, t, ["Home", "Search", "Library", "Profile"]),
    await bar("Navigation/Bar/Top/Android", 412, 64, t, [], "Title"),
    await bar("Navigation/Bar/Bottom/Android", 412, 80, t, ["Home", "Search", "Library", "Profile"]),
  ];
  components.forEach((c) => library.appendChild(c));

  // ---------------------------------------------------------------- landing page (1440)
  const root = stack("Landing — Desktop", "VERTICAL", 64);
  root.counterAxisSizingMode = "FIXED";
  root.resize(1440, 100);
  root.primaryAxisSizingMode = "AUTO";
  root.paddingBottom = 64;
  root.fills = [bound(solid(hex("#FFFFFF")), t.surface)];
  page.appendChild(root);
  const fill = (n: SceneNode) => ((n as FrameNode).layoutSizingHorizontal = "FILL");

  const header = stack("Header", "HORIZONTAL", 32);
  header.primaryAxisAlignItems = "SPACE_BETWEEN";
  header.counterAxisAlignItems = "CENTER";
  header.paddingLeft = header.paddingRight = 80;
  header.paddingTop = header.paddingBottom = 20;
  root.appendChild(header);
  fill(header);
  const brand = await text("Acme", 22, "Bold", bound(solid(hex("#0F172A")), t.onSurface));
  brand.name = "Logo";
  header.appendChild(brand);
  const links = stack("Links", "HORIZONTAL", 32);
  for (const l of ["Product", "Pricing", "Docs", "Company"]) links.appendChild(await text(l, 16, "Regular", bound(solid(hex("#475569")), t.muted)));
  header.appendChild(links);
  header.appendChild(button.createInstance());
  header.setBoundVariable("itemSpacing", s32);

  const crumb = stack("Breadcrumb", "HORIZONTAL", 8);
  crumb.counterAxisAlignItems = "CENTER";
  crumb.paddingLeft = crumb.paddingRight = 80;
  const back = left.createInstance();
  back.name = "chevron-left";
  crumb.appendChild(back);
  crumb.appendChild(await text("Back to all products", 14, "Medium", bound(solid(hex("#475569")), t.muted)));
  root.appendChild(crumb);
  fill(crumb);

  const hero = stack("Hero", "HORIZONTAL", 48);
  hero.paddingLeft = hero.paddingRight = 80;
  hero.counterAxisAlignItems = "CENTER";
  root.appendChild(hero);
  fill(hero);
  const copy = stack("Copy", "VERTICAL", 24);
  copy.counterAxisSizingMode = "FIXED";
  copy.resize(600, 100);
  copy.primaryAxisSizingMode = "AUTO";
  copy.setBoundVariable("itemSpacing", s24);
  const headline = await text("Ship every screen to every device", 56, "Bold", bound(solid(hex("#0F172A")), t.onSurface));
  const body = await text("Adapt, localize, audit and hand off designs in minutes — with your own design system.", 18, "Regular", bound(solid(hex("#475569")), t.muted));
  for (const n of [headline, body]) {
    copy.appendChild(n);
    n.layoutSizingHorizontal = "FILL";
  }
  const cta = button.createInstance();
  cta.name = "CTA Button";
  copy.appendChild(cta);
  hero.appendChild(copy);
  const image = figma.createRectangle();
  image.name = "Hero Image";
  image.resize(640, 400);
  image.cornerRadius = 24;
  image.fills = [bound(solid(hex("#F1F5F9")), t.container)];
  hero.appendChild(image);

  const grid = stack("Feature Cards", "HORIZONTAL", 32);
  grid.paddingLeft = grid.paddingRight = 80;
  root.appendChild(grid);
  fill(grid);
  const features = ["Multi-surface", "RTL mirroring", "Token audit", "Dev handoff"];
  for (const [i, title] of features.entries()) {
    const card = stack(`Card ${i + 1}`, "VERTICAL", 12, 24);
    card.cornerRadius = 16;
    card.fills = [bound(solid(hex("#FFFFFF")), t.surface)];
    card.effects = [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.08 }, offset: { x: 0, y: 4 }, radius: 16, spread: 0, visible: true, blendMode: "NORMAL" }];
    card.appendChild(await text(title, 24, "Bold", bound(solid(hex("#0F172A")), t.onSurface)));
    const desc = await text("One call adapts layout, tokens and components.", 16, "Regular", bound(solid(hex("#475569")), t.muted));
    card.appendChild(desc);
    grid.appendChild(card);
    card.layoutSizingHorizontal = "FILL";
    desc.layoutSizingHorizontal = "FILL";
    card.setBoundVariable("itemSpacing", s8);
  }
  // Deliberate audit findings: a hardcoded brand fill that equals color/brand, and off-grid padding.
  const promo = stack("Promo Banner", "HORIZONTAL", 16);
  promo.paddingLeft = promo.paddingRight = 13;
  promo.paddingTop = promo.paddingBottom = 16;
  promo.fills = [solid(hex("#4F46E5"))];
  promo.appendChild(await text("Launch week: 30% off annual plans", 16, "Medium", solid(hex("#FFFFFF"))));
  const promoRow = stack("Promo", "HORIZONTAL", 0);
  promoRow.paddingLeft = promoRow.paddingRight = 80;
  promoRow.appendChild(promo);
  root.appendChild(promoRow);
  fill(promoRow);

  const footer = stack("Footer", "HORIZONTAL", 24);
  footer.paddingLeft = footer.paddingRight = 80;
  footer.paddingTop = 32;
  footer.counterAxisAlignItems = "CENTER";
  root.appendChild(footer);
  fill(footer);
  footer.appendChild(await text("© 2026 Acme Inc.", 14, "Regular", bound(solid(hex("#475569")), t.muted)));
  footer.appendChild(await text("+90 555 123 4567", 14, "Regular", bound(solid(hex("#475569")), t.muted)));
  footer.appendChild(await text("www.example.com", 14, "Regular", bound(solid(hex("#475569")), t.muted)));
  // Deliberate contrast failure (#CBD5E1 on white ≈ 1.5:1).
  footer.appendChild(await text("Terms apply", 12, "Regular", solid(hex("#CBD5E1"))));

  root.x = origin;
  root.y = 0;
  library.x = origin;
  library.y = -library.height - 200;
  page.selection = [root];
  figma.viewport.scrollAndZoomIntoView([root, library]);
  figma.commitUndo();
  return { frameId: root.id, libraryId: library.id };
}
