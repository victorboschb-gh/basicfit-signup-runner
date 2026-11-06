import type { MailMessage } from "./types.ts";

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&#0*38;/g, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

export function extractLinks(message: MailMessage): string[] {
  const found: string[] = [];
  const html = decodeEntities(message.html);

  for (const match of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const href = match[1]?.trim();
    if (href) found.push(href);
  }

  const textAndHtml = `${decodeEntities(message.text)}\n${html}`;
  for (const match of textAndHtml.matchAll(/https?:\/\/[^\s"'<>)\]}]+/gi)) {
    found.push(match[0].replace(/[.,;:!?]+$/, ""));
  }

  const unique: string[] = [];
  for (const link of found) {
    if (!/^https?:\/\//i.test(link)) continue;
    if (!unique.includes(link)) unique.push(link);
  }
  return unique;
}

export function scorePasswordLink(url: string): number {
  let score = 0;
  const lower = url.toLowerCase();
  if (lower.includes("basic-fit.com")) score += 10;
  if (lower.includes("login.basic-fit.com")) score += 10;
  if (/(password|passwort|contrasen|wachtwoord|mot-de-passe)/.test(lower)) score += 8;
  if (/(token|code|key|reset|set|create|register|verify)/.test(lower)) score += 3;
  if (lower.includes("unsubscribe") || lower.includes("baja") || lower.includes("privacy")) score -= 20;
  if (lower.includes("facebook") || lower.includes("instagram") || lower.includes("youtube")) score -= 20;
  return score;
}

export function pickPasswordLink(message: MailMessage): string | null {
  const links = extractLinks(message);
  if (links.length === 0) return null;
  const ranked = [...links].sort((a, b) => scorePasswordLink(b) - scorePasswordLink(a));
  return ranked[0] ?? null;
}
