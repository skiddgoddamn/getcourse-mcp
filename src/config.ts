import { readFileSync, existsSync } from "node:fs";

export interface GcConfig {
  /** Base account URL, e.g. https://your-account.getcourse.ru (no trailing slash). */
  baseUrl: string;
  /** CDP endpoint of a logged-in Chromium/Yandex browser. */
  cdpUrl: string;
}

/** Minimal .env loader (no dependency): fills process.env for keys not already set. */
function loadDotenv(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GcConfig {
  loadDotenv();
  const base = env.GETCOURSE_BASE_URL;
  if (!base) {
    throw new Error(
      "GETCOURSE_BASE_URL не задан (например https://your-account.getcourse.ru). Укажите в .env или окружении.",
    );
  }
  return {
    baseUrl: base.replace(/\/+$/, ""),
    cdpUrl: env.GETCOURSE_CDP_URL || "http://127.0.0.1:9222",
  };
}
