import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import { loadConfig, type GcConfig } from "./config.js";

/**
 * GetCourse driver.
 *
 * No public API covers per-training/group access management, so we operate the
 * account through a logged-in browser over CDP (like tilda-mcp): the browser
 * carries the session cookie + CSRF automatically. Reads hit the internal admin
 * URLs; the one write (add user to group(s)) drives the bulk "add users" form.
 *
 * Requires a Chromium/Yandex browser started with --remote-debugging-port and
 * an admin logged into the account.
 */

export interface GcSession {
  browser: Browser;
  page: Page;
  cfg: GcConfig;
  close(): Promise<void>;
}

export async function connect(cfg: GcConfig = loadConfig()): Promise<GcSession> {
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(cfg.cdpUrl);
  } catch (e) {
    throw new Error(
      `Не удалось подключиться к браузеру по CDP (${cfg.cdpUrl}). ` +
        `Запустите браузер с --remote-debugging-port=9222 на отдельном профиле и войдите в аккаунт. ` +
        `Детали: ${(e as Error).message}`,
    );
  }
  const ctx = browser.contexts()[0];
  if (!ctx) {
    await browser.close().catch(() => {});
    throw new Error("Нет контекста браузера в CDP-сессии.");
  }
  const host = new URL(cfg.baseUrl).host;
  const page = ctx.pages().find((p) => p.url().includes(host)) || (await ctx.newPage());
  page.on("dialog", (d) => d.accept().catch(() => {}));
  const close = async () => {
    // Detach only; leave the user's browser open.
    await browser.close().catch(() => {});
  };
  return { browser, page, cfg, close };
}

async function goto(s: GcSession, path: string): Promise<void> {
  const url = path.startsWith("http") ? path : `${s.cfg.baseUrl}${path}`;
  await s.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await s.page.waitForTimeout(400);
}

// ── Status ──────────────────────────────────────────────────────────────────

export interface GcStatus {
  loggedIn: boolean;
  account: string | null;
  url: string;
}

/** Verify the browser session is logged into the admin panel. */
export async function status(s: GcSession): Promise<GcStatus> {
  await goto(s, "/teach/control");
  await s.page.waitForTimeout(800);
  const res = await s.page.evaluate(() => {
    const hasLoginForm = !!document.querySelector('input[type="password"]');
    const isTrainingList = /Список тренингов|Тренинги:/i.test(document.body.innerText);
    const footer = (document.body.innerText.match(/id(\d+)\s*\|\s*администратор/i) || [])[0] || null;
    return { hasLoginForm, isTrainingList, footer };
  });
  return {
    loggedIn: !res.hasLoginForm && res.isTrainingList,
    account: res.footer,
    url: s.page.url(),
  };
}

// ── Find user ─────────────────────────────────────────────────────────────────

export interface GcUser {
  id: string | null;
  name: string;
  email: string;
  type: string;
  status: string;
}

/** Find a user by email in the global user list (/pl/user/user). */
export async function findUser(s: GcSession, email: string): Promise<GcUser | null> {
  const q = new URLSearchParams({
    "uc[name]": "",
    "uc[email]": email,
    "uc[type]": "",
    "uc[status]": "null",
    "uc[email_validate]": "0",
    "uc[phone]": "",
  });
  await goto(s, `/pl/user/user?${q.toString()}`);
  await s.page.waitForTimeout(800);
  return s.page.evaluate((em) => {
    const rows = Array.from(document.querySelectorAll("table tbody tr")).filter((tr) =>
      tr.querySelector('a[href*="user/control/user/update/id/"]'),
    );
    const row = rows.find((tr) => ((tr as HTMLElement).innerText || "").includes(em)) || rows[0];
    if (!row) return null;
    const link = Array.from(row.querySelectorAll("a[href]"))
      .map((a) => a.getAttribute("href") || "")
      .find((h) => /user\/control\/user\/update\/id\/(\d+)/.test(h));
    const id = link ? (link.match(/id\/(\d+)/) || [])[1] || null : null;
    const cells = Array.from(row.querySelectorAll("td")).map((c) => ((c as HTMLElement).innerText || "").replace(/\s+/g, " ").trim());
    const emailCell = cells.find((c) => c.includes("@")) || em;
    return {
      id,
      name: cells.find((c) => c && !c.includes("@") && !/^-+$/.test(c)) || "",
      email: emailCell.split(" ")[0],
      type: cells.find((c) => /ученик|администратор|сотрудник/i.test(c)) || "",
      status: cells.find((c) => /Активен|Деактивирован|Забанен|В базе/i.test(c)) || "",
    };
  }, email);
}

// ── Training groups ───────────────────────────────────────────────────────────

export interface GcGroup {
  id: string;
  name: string;
}

/** List the access groups referenced by a training (from its student view sidebar). */
export async function listTrainingGroups(s: GcSession, trainingId: string): Promise<GcGroup[]> {
  await goto(s, `/teach/control/stat/stream/id/${trainingId}`);
  await s.page.waitForTimeout(800);
  return s.page.evaluate(() => {
    const out: { id: string; name: string }[] = [];
    document.querySelectorAll('a[href*="group="]').forEach((a) => {
      const t = (a as HTMLElement).innerText.replace(/\s+/g, " ").trim();
      const m = (a.getAttribute("href") || "").match(/group=(\d+)/);
      if (m && t) out.push({ id: m[1], name: t });
    });
    const seen = new Set<string>();
    return out.filter((g) => (seen.has(g.id) ? false : (seen.add(g.id), true)));
  });
}

// ── Membership check ──────────────────────────────────────────────────────────

export interface GcMembership {
  groupId: string;
  name?: string;
  member: boolean;
}

/**
 * Report whether a user (by email) is a member of the given groups.
 * Authoritative source: the user list filtered by an "in group" rule +
 * the email column — reflects UserGroup membership immediately (the training
 * student list, by contrast, mirrors training access asynchronously).
 */
export async function checkMembership(
  s: GcSession,
  email: string,
  groups: GcGroup[],
): Promise<GcMembership[]> {
  const out: GcMembership[] = [];
  for (const g of groups) {
    const rule = encodeURIComponent(
      JSON.stringify({ type: "user_ingrouprule", inverted: 0, params: { value: { selected_id: Number(g.id) } } }),
    );
    await goto(s, `/pl/user/user?uc[rule_string]=${rule}&uc[email]=${encodeURIComponent(email)}`);
    await s.page.waitForTimeout(600);
    const member = await s.page.evaluate((em) => {
      const rows = Array.from(document.querySelectorAll("table tbody tr")).filter((tr) =>
        tr.querySelector('a[href*="user/control/user/update/id/"]'),
      );
      return rows.some((tr) => ((tr as HTMLElement).innerText || "").includes(em));
    }, email);
    out.push({ groupId: g.id, name: g.name, member });
  }
  return out;
}

// ── Write: add user to group(s) ───────────────────────────────────────────────

export interface AddToGroupsResult {
  ok: boolean;
  step: string;
  message: string;
  buttonsAtConfirm?: string[];
}

/**
 * Add a user (by email) to one or more groups via the bulk "Добавление
 * пользователей" form (/pl/user/user/import?type=text). Existing users are
 * matched by email (no duplicate account created); selected groups are applied.
 *
 * For EXISTING users the "перезаписать данные при совпадении" flag is required,
 * otherwise the group assignment is skipped (the import only carries the email,
 * so no profile data is lost). dryRun=true fills the form and advances to the
 * preview step but does NOT confirm.
 */
export async function addUserToGroups(
  s: GcSession,
  email: string,
  groupIds: string[],
  opts: { sendInvitation?: boolean; dryRun?: boolean; overwriteExisting?: boolean } = {},
): Promise<AddToGroupsResult> {
  const { sendInvitation = false, dryRun = false, overwriteExisting = true } = opts;
  await goto(s, "/pl/user/user/import?type=text");
  await s.page.waitForTimeout(800);

  // 1) emails
  const ta = s.page.locator('textarea[name="string_value"]');
  if (!(await ta.count())) return { ok: false, step: "form", message: "Поле string_value не найдено — форма импорта изменилась." };
  await ta.fill(email);

  // 2) reveal the group selector: tick the "Выбрать группы…" toggle, then select
  await s.page.evaluate(() => {
    const cb = Array.from(document.querySelectorAll('input[type="checkbox"]')).find((c) =>
      /Выбрать группы/i.test((c.closest("label")?.innerText || c.parentElement?.innerText || "")),
    ) as HTMLInputElement | undefined;
    if (cb && !cb.checked) cb.click();
  });
  await s.page.waitForTimeout(600);
  await s.page.selectOption('select[name="group_ids[]"]', groupIds.map((value) => ({ value }))).catch(async () => {
    // fallback: set via DOM + change event
    await s.page.evaluate((ids) => {
      const sel = document.querySelector('select[name="group_ids[]"]') as HTMLSelectElement | null;
      if (sel) {
        Array.from(sel.options).forEach((o) => (o.selected = ids.includes(o.value)));
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        // sync select2 widget, which listens to jQuery events
        const w = window as unknown as { jQuery?: (el: unknown) => { trigger: (e: string) => void } };
        if (w.jQuery) w.jQuery(sel).trigger("change");
      }
    }, groupIds);
  });

  // 3) invitation email off (unless requested)
  if (!sendInvitation) {
    await s.page.evaluate(() => {
      const cb = document.querySelector('input[name="send_invitation_email"]') as HTMLInputElement | null;
      if (cb && cb.checked) cb.click();
    });
  }

  // Verify selection took
  const selected = await s.page.evaluate(() => {
    const sel = document.querySelector('select[name="group_ids[]"]') as HTMLSelectElement | null;
    return sel ? Array.from(sel.selectedOptions).map((o) => o.value) : [];
  });
  const missing = groupIds.filter((g) => !selected.includes(g));
  if (missing.length) return { ok: false, step: "select-groups", message: `Не удалось выбрать группы: ${missing.join(", ")}` };

  // 3) step 1 → "Загрузить" (parse data + show mapping/preview + "Импортировать")
  await s.page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn')).find(
      (b) => ((b as HTMLElement).innerText || (b as HTMLInputElement).value || "").replace(/\s+/g, " ").trim() === "Загрузить",
    ) as HTMLElement | undefined;
    btn?.click();
  });
  await s.page.waitForTimeout(2500);

  const buttons = await s.page.evaluate(() =>
    Array.from(document.querySelectorAll('button, input[type="submit"], a.btn'))
      .map((b) => ((b as HTMLElement).innerText || (b as HTMLInputElement).value || "").replace(/\s+/g, " ").trim())
      .filter((t) => t && t.length < 40),
  );
  const preview = await s.page.evaluate((em) => {
    const hasImport = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn')).some(
      (b) => /Импортировать/i.test((b as HTMLElement).innerText || (b as HTMLInputElement).value || ""),
    );
    return { hasImportBtn: hasImport, showsEmail: document.body.innerText.includes(em) };
  }, email);

  if (!preview.hasImportBtn || !preview.showsEmail) {
    return {
      ok: false,
      step: "preview",
      message: `Предпросмотр не готов (Импортировать=${preview.hasImportBtn}, email виден=${preview.showsEmail}).`,
      buttonsAtConfirm: buttons,
    };
  }

  // required so groups apply to an EXISTING user (import carries email only, no data loss)
  if (overwriteExisting) {
    await s.page.evaluate(() => {
      const cb = Array.from(document.querySelectorAll('input[type="checkbox"]')).find((c) =>
        /перезаписать данные пользоват/i.test((c.closest("label")?.innerText || c.parentElement?.innerText || "")),
      ) as HTMLInputElement | undefined;
      if (cb && !cb.checked) cb.click();
    });
  }

  if (dryRun) {
    return {
      ok: true,
      step: "preview",
      message: `Предпросмотр (dryRun): ${email} → группы ${groupIds.join(", ")}, приглашение=${sendInvitation}, перезапись=${overwriteExisting}. «Импортировать» НЕ нажато.`,
      buttonsAtConfirm: buttons,
    };
  }

  // 4) commit → "Импортировать"
  await s.page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn')).find(
      (b) => /Импортировать/i.test((b as HTMLElement).innerText || (b as HTMLInputElement).value || ""),
    ) as HTMLElement | undefined;
    btn?.click();
  });
  await s.page.waitForTimeout(4000);

  const finalText = await s.page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 300));
  return { ok: true, step: "done", message: `«Импортировать» нажато. Итог: ${finalText}`, buttonsAtConfirm: buttons };
}
