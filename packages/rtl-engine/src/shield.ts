/**
 * Shielding: content that must stay Left-to-Right inside an RTL layout.
 * Shielded text keeps its alignment and is never sent for translation; shielded containers keep
 * their child order (a progress bar fills from the same edge, a code block stays a code block).
 */

const PHONE = /^\+?[\d\s().-]{7,}$/;
const URL_OR_EMAIL = /(https?:\/\/|www\.)\S+|^[\w.+-]+@[\w-]+\.[\w.]+$|^[\w-]+(\.[\w-]+)*\.(com|net|org|io|dev|app|co|ai|gov|edu)(\/\S*)?$/i;
const NUMERIC = /^[\s+\-−±]*[$€£¥₺₹₽₪﷼]?\s*[\d\s.,:/%+\-−×x]*\d[\d\s.,:/%]*\s*[$€£¥₺₹₽₪﷼%]?\s*$/;
const CODE = /[{}]|;\s*$|=>|\(\)|`|^\s*<\/?[A-Za-z][\w.-]*(\s[^>]*)?\/?>|^\s*(const|let|var|import|function|def|class)\s+[\w{[]/;

const SHIELD_NAME = /\b(progress|slider|chart|graph|media|player|video|code|snippet|terminal|map|timeline|logo|brand|qr|barcode|keypad|numpad|phone|url|email|equation|math)\b/i;

export type ShieldReason = "phone" | "url" | "number" | "code" | "name";

export function shieldText(characters: string, nodeName = ""): ShieldReason | null {
  const s = characters.trim();
  if (SHIELD_NAME.test(nodeName)) return "name";
  if (s.length === 0) return null;
  if (URL_OR_EMAIL.test(s)) return "url";
  if (PHONE.test(s) && /\d{3}/.test(s.replace(/\D/g, ""))) return "phone";
  if (NUMERIC.test(s)) return "number";
  if (CODE.test(s)) return "code";
  return null;
}

export function shieldContainer(name: string): boolean {
  return SHIELD_NAME.test(name);
}

// ---------------------------------------------------------------------------
// Directional icons
// ---------------------------------------------------------------------------

const DIRECTIONAL =
  /(arrow|chevron|caret|triangle|angle)[\s_/-]*(left|right|forward|back|next|prev|previous|start|end)|\b(back|forward|next|previous|prev)[\s_/-]*(button|btn|icon|arrow)?\b|\b(undo|redo|reply|reply[\s_-]?all|send|logout|log[\s_-]?out|login|log[\s_-]?in|exit|enter|import|export|open[\s_-]?in[\s_-]?new|external[\s_-]?link|list[\s_-]?bullet|format[\s_-]?indent|text[\s_-]?direction)\b/i;

/** Icons that look directional but must never be mirrored (media transport, checkmarks, clocks, brands). */
const NEVER_FLIP = /\b(play|pause|stop|rewind|fast[\s_-]?forward|skip|media|check|checkmark|tick|logo|brand|clock|time|timer|history|refresh|sync|search|shuffle|repeat)\b/i;

export function isDirectionalIcon(name: string): boolean {
  return DIRECTIONAL.test(name) && !NEVER_FLIP.test(name);
}
