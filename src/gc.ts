import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import { loadConfig, type GcConfig } from "./config.js";

/**
 * GetCourse driver.
 *
 * No public API covers per-training/group access management, so we operate the
 * account through a logged-in browser over CDP: the browser carries the session
 * cookie + CSRF automatically. Reads hit the internal admin URLs; the one write
 * (add user to group(s)) drives the bulk "add users" form.
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

/** Resolve a user's numeric id from an email (throws if not found). */
export async function resolveUserId(s: GcSession, email: string): Promise<string> {
  const u = await findUser(s, email);
  if (!u || !u.id) throw new Error(`Пользователь ${email} не найден.`);
  return u.id;
}

// ── User groups via the profile card (checkbox tree) ──────────────────────────
// The user card's "Группы" part is a checkbox tree: name="User[groupIds][]",
// value=<groupId>, checked=membership. Saving persists the checked set. We
// read-modify-write: toggle only the target groups, preserve everything else.

/** Open the card groups tab in "Все группы" mode so every checkbox is rendered. */
async function openGroupsTab(s: GcSession, userId: string): Promise<void> {
  await goto(s, `/user/control/user/update/id/${userId}/part/groups`);
  await s.page.waitForTimeout(800);
  await s.page.evaluate(() => {
    const a = Array.from(document.querySelectorAll("a")).find((e) => /Все группы/i.test((e as HTMLElement).innerText || ""));
    (a as HTMLElement | undefined)?.click();
  });
  await s.page.waitForTimeout(1200);
}

function readCheckedGroups(s: GcSession): Promise<GcGroup[]> {
  return s.page.evaluate(() =>
    Array.from(document.querySelectorAll('input[name="User[groupIds][]"]'))
      .filter((c) => (c as HTMLInputElement).checked)
      .map((c) => ({
        id: (c as HTMLInputElement).value,
        name: ((c as HTMLElement).closest("label")?.innerText || (c as HTMLElement).parentElement?.innerText || "")
          .replace(/\s+/g, " ")
          .trim(),
      })),
  );
}

/** List the groups a user (by id) currently belongs to. */
export async function listUserGroups(s: GcSession, userId: string): Promise<GcGroup[]> {
  await openGroupsTab(s, userId);
  return readCheckedGroups(s);
}

export interface SetGroupsResult {
  ok: boolean;
  message: string;
  before: string[];
  after?: string[];
}

/**
 * Add and/or remove a user from groups via the card checkbox tree.
 * Only the target checkboxes are toggled; all other memberships are preserved.
 * dryRun computes the change without saving.
 */
export async function setUserGroups(
  s: GcSession,
  userId: string,
  opts: { add?: string[]; remove?: string[]; dryRun?: boolean },
): Promise<SetGroupsResult> {
  const add = opts.add ?? [];
  const remove = opts.remove ?? [];
  await openGroupsTab(s, userId);
  const before = (await readCheckedGroups(s)).map((g) => g.id);

  // every target must exist as a checkbox
  const present = await s.page.evaluate(() =>
    Array.from(document.querySelectorAll('input[name="User[groupIds][]"]')).map((c) => (c as HTMLInputElement).value),
  );
  const missing = [...add, ...remove].filter((id) => !present.includes(id));
  if (missing.length) return { ok: false, message: `Группы не найдены на карточке: ${missing.join(", ")}`, before };

  // toggle only targets (inline — no nested named fn, avoids esbuild __name helper)
  await s.page.evaluate(
    ({ add, remove }) => {
      for (const id of add) {
        const c = document.querySelector(`input[name="User[groupIds][]"][value="${id}"]`) as HTMLInputElement | null;
        if (c && !c.checked) c.click();
      }
      for (const id of remove) {
        const c = document.querySelector(`input[name="User[groupIds][]"][value="${id}"]`) as HTMLInputElement | null;
        if (c && c.checked) c.click();
      }
    },
    { add, remove },
  );

  const intended = new Set(before);
  add.forEach((id) => intended.add(id));
  remove.forEach((id) => intended.delete(id));
  const nowChecked = (await readCheckedGroups(s)).map((g) => g.id).sort();
  const want = [...intended].sort();
  if (JSON.stringify(nowChecked) !== JSON.stringify(want)) {
    return { ok: false, message: `Состояние чекбоксов не совпало с ожидаемым (до сохранения). want=${want.length}, got=${nowChecked.length}`, before };
  }

  if (opts.dryRun) {
    return { ok: true, message: `dryRun: +[${add.join(",")}] −[${remove.join(",")}]. Не сохранено.`, before };
  }

  // save (submit the groups form)
  await s.page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('#userForm button, #userForm input[type="submit"], button, a.btn')).find(
      (b) => /сохранить/i.test((b as HTMLElement).innerText || (b as HTMLInputElement).value || ""),
    ) as HTMLElement | undefined;
    btn?.click();
  });
  await s.page.waitForTimeout(2500);

  const after = await listUserGroups(s, userId);
  return { ok: true, message: "Сохранено.", before, after: after.map((g) => g.id) };
}

// ── Update user profile ───────────────────────────────────────────────────────

export interface UserFields {
  firstName?: string;
  lastName?: string;
  phone?: string;
  city?: string;
  comment?: string;
}

const USER_FIELD_MAP: Record<keyof UserFields, string> = {
  firstName: "User[first_name]",
  lastName: "User[last_name]",
  phone: "User[phone]",
  city: "User[city]",
  comment: "User[comment]",
};

/**
 * Update profile fields (name/phone/city/comment) on the user card and save.
 * Email is intentionally out of scope (sensitive — separate flow). dryRun sets
 * the values but does not submit.
 */
export async function updateUser(
  s: GcSession,
  userId: string,
  fields: UserFields,
  dryRun = false,
): Promise<{ ok: boolean; message: string; before: Record<string, string>; after?: Record<string, string> }> {
  await goto(s, `/user/control/user/update/id/${userId}`);
  await s.page.waitForTimeout(1200);

  const entries = (Object.keys(fields) as (keyof UserFields)[])
    .filter((k) => fields[k] !== undefined)
    .map((k) => [USER_FIELD_MAP[k], String(fields[k])] as [string, string]);
  if (!entries.length) return { ok: false, message: "Нечего обновлять.", before: {} };

  const names = entries.map((e) => e[0]);
  const readValues = (ns: string[]) =>
    s.page.evaluate((names) => {
      const out: Record<string, string> = {};
      for (const n of names) {
        const el = document.querySelector(`[name="${n}"]`) as HTMLInputElement | HTMLTextAreaElement | null;
        out[n] = el ? el.value : "__MISSING__";
      }
      return out;
    }, ns);

  const before = await readValues(names);
  const missing = names.filter((n) => before[n] === "__MISSING__");
  if (missing.length) return { ok: false, message: `Поля не найдены в форме: ${missing.join(", ")}`, before };

  await s.page.evaluate((entries) => {
    for (const [name, val] of entries) {
      const el = document.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLTextAreaElement | null;
      if (el) {
        el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
  }, entries);

  if (dryRun) return { ok: true, message: `dryRun: ${entries.map((e) => `${e[0]}=${e[1]}`).join(", ")}. Не сохранено.`, before };

  await s.page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('#userForm button, #userForm input[type="submit"], button, a.btn')).find(
      (b) => /сохранить/i.test((b as HTMLElement).innerText || (b as HTMLInputElement).value || ""),
    ) as HTMLElement | undefined;
    btn?.click();
  });
  await s.page.waitForTimeout(2500);

  await goto(s, `/user/control/user/update/id/${userId}`);
  await s.page.waitForTimeout(1000);
  const after = await readValues(names);
  return { ok: true, message: "Сохранено.", before, after };
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

// ── Offers & orders (deals) ─────────────────────────────────────────────────────
// For trainings whose access is "только те, кто купил тренинг" (access_type=none),
// group membership grants NOTHING — access comes from a COMPLETED purchase. So to
// "выдать доступ как будто оплатил" you create a completed order for an offer that
// includes the training (a 0₽ comp offer keeps money records clean). See HANDOFF.

export interface GcOffer {
  id: string;
  /** Full row text (name + tags + terms + price + актуальность). */
  text: string;
  price: string;
  actual: boolean;
}

/** Search sales offers by name/substring (admin offers list /pl/sales/offer/index). */
export async function findOffers(s: GcSession, query: string): Promise<GcOffer[]> {
  await goto(s, `/pl/sales/offer/index?q=${encodeURIComponent(query)}`);
  await s.page.waitForTimeout(800);
  return s.page.evaluate(() => {
    const out: { id: string; text: string; price: string; actual: boolean }[] = [];
    const seen = new Set<string>();
    document.querySelectorAll("table tr").forEach((tr) => {
      const link = tr.querySelector('a[href*="offer"]') as HTMLAnchorElement | null;
      const txt = ((tr as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
      const idm = (link?.getAttribute("href") || "").match(/id[\/=](\d+)/) || txt.match(/\b(\d{6,})\b/);
      if (!idm || seen.has(idm[1])) return;
      seen.add(idm[1]);
      const price = ((txt.match(/[\d\s]+руб\./) || ["?"])[0] || "?").replace(/\s+/g, " ").trim();
      out.push({ id: idm[1], text: txt.slice(0, 160), price, actual: /Актуален/i.test(txt) });
    });
    return out;
  });
}

export interface GcOrder {
  dealId: string;
  status: string;
  amount: string;
  /** Row text (number + offer + status + amount + date). */
  text: string;
}

/**
 * List a user's orders (deals) from the user card sidebar. Card-scoped and reliable
 * (`/sales/control/deal?filter[user_id]` does NOT actually filter by user).
 */
export async function findUserOrders(s: GcSession, userId: string): Promise<GcOrder[]> {
  await goto(s, `/user/control/user/update/id/${userId}`);
  await s.page.waitForTimeout(1000);
  return s.page.evaluate(() => {
    const out: { dealId: string; status: string; amount: string; text: string }[] = [];
    const seen = new Set<string>();
    document.querySelectorAll('a[href*="deal/update/id/"]').forEach((a) => {
      const dealId = ((a.getAttribute("href") || "").match(/id\/(\d+)/) || [])[1] || "";
      if (!dealId || seen.has(dealId)) return;
      seen.add(dealId);
      const row = (a as HTMLElement).closest("tr,li,div");
      const txt = ((row as HTMLElement)?.innerText || (a as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
      const status = ((txt.match(/Завершен|Отменен|Новый|В работе|Ложный|Ожидаем оплаты|Частично оплачен|Отложен|Не подтвержден/) || [""])[0]) || "";
      const amount = ((txt.match(/[\d\s]+руб\./) || [""])[0] || "").replace(/\s+/g, " ").trim();
      out.push({ dealId, status, amount, text: txt.slice(0, 140) });
    });
    return out;
  });
}

export interface CreateOrderResult {
  ok: boolean;
  message: string;
  rows?: string[];
}

/**
 * Create an order (deal) for a user via the card "Создать заказ" operation
 * (POST /pl/logic/operation/prepare?operationType=user_create_deal).
 *
 * ⚠️ GOTCHA: this operation is SINGLE-STEP — "Запустить" (the /prepare POST)
 * EXECUTES immediately and creates the order; there is NO dry preview server-side.
 * A completed order for an offer whose access includes a training grants that
 * training's access ("только купившие"). A 0₽ comp offer = access without money.
 * `dryRun` therefore does NOT touch the account — it only echoes what would run.
 */
export async function createOrder(
  s: GcSession,
  userId: string,
  offerIds: string[],
  opts: { dryRun?: boolean; tryPayFromDeposit?: boolean } = {},
): Promise<CreateOrderResult> {
  const { dryRun = false, tryPayFromDeposit = false } = opts;
  if (dryRun) {
    return {
      ok: true,
      message: `dryRun: заказ НЕ создан. Пользователь ${userId}, офферы [${offerIds.join(", ")}] (qty 1 каждый). ` +
        `ВНИМАНИЕ: реальный вызов создаёт заказ сразу — у операции нет предпросмотра.`,
    };
  }
  if (!offerIds.length) return { ok: false, message: "Не указаны offerIds." };

  await goto(s, `/user/control/user/update/id/${userId}`);
  await s.page.waitForTimeout(1000);
  // open the "Создать заказ" operation widget (JS action-link on the card)
  await s.page.evaluate(() => {
    const el = Array.from(document.querySelectorAll("a")).find(
      (x) => /^Создать заказ$/i.test((x as HTMLElement).innerText.trim()) &&
        /logic-action|operations-widget/i.test((x.className || "").toString()),
    ) as HTMLElement | undefined;
    el?.click();
  });
  await s.page.waitForTimeout(2500);
  // instantiate the position block, then close the offer picker (offerIds set directly)
  await s.page.evaluate(() => {
    const el = Array.from(document.querySelectorAll("a,button,span,div")).find(
      (x) => /Добавить предложение/i.test((x as HTMLElement).innerText || ""),
    ) as HTMLElement | undefined;
    el?.click();
  });
  await s.page.waitForTimeout(900);
  await s.page.keyboard.press("Escape").catch(() => {});
  await s.page.waitForTimeout(500);
  // write offerIds + one qnt per offer onto the operation form (#w0)
  const set = await s.page.evaluate((ids: string[]) => {
    const form = document.getElementById("w0") as HTMLFormElement | null;
    if (!form) return false;
    let oi = form.querySelector('input[name="CreateDealOperation[offerIds]"]') as HTMLInputElement | null;
    if (!oi) {
      oi = document.createElement("input");
      oi.type = "hidden";
      oi.name = "CreateDealOperation[offerIds]";
      form.appendChild(oi);
    }
    oi.value = ids.join(",");
    form.querySelectorAll('input[name="CreateDealOperation[qnt][]"]').forEach((n) => n.remove());
    for (const _ of ids) {
      const q = document.createElement("input");
      q.type = "hidden";
      q.name = "CreateDealOperation[qnt][]";
      q.value = "1";
      form.appendChild(q);
    }
    return true;
  }, offerIds);
  if (!set) return { ok: false, message: "Форма создания заказа (#w0) не найдена." };

  if (tryPayFromDeposit) {
    await s.page.evaluate(() => {
      const c = document.querySelector('input[name="CreateDealOperation[tryToPayFromDeposit]"]') as HTMLInputElement | null;
      if (c && !c.checked) c.click();
    });
  }
  // submit ("Запустить" — one step, executes)
  await s.page.evaluate(() => {
    const bt = Array.from(document.querySelectorAll("button,a,input[type=submit],input[type=button]")).find(
      (x) => /^Запустить$/i.test(((x as HTMLElement).innerText || (x as HTMLInputElement).value || "").trim()) &&
        (x as HTMLElement).offsetParent !== null,
    ) as HTMLElement | undefined;
    bt?.click();
  });
  await s.page.waitForTimeout(4000);

  const res = await s.page.evaluate(() => {
    const t = (document.body.innerText || "").replace(/\s+/g, " ").trim();
    const err = /исправьте следующие ошибки/i.test(t);
    const errMsg = (t.match(/исправьте следующие ошибки[:.]?\s*([^]{0,140}?)(?:ID объектов|$)/i) || [])[1] || "";
    const rows: string[] = [];
    document.querySelectorAll("table tr").forEach((tr) => {
      const rt = ((tr as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
      if (/Успешно|Заказ создан|Ошибка|не удал/i.test(rt)) rows.push(rt.slice(0, 120));
    });
    return { err, errMsg: errMsg.trim(), rows, created: /Заказ создан/i.test(t) };
  });
  if (res.err) return { ok: false, message: `Ошибка формы: ${res.errMsg || "не заполнены поля"}`, rows: res.rows };
  return {
    ok: res.created,
    message: res.created ? "Заказ создан." : "Ответ без подтверждения «Заказ создан».",
    rows: res.rows,
  };
}

export interface SetOrderStatusResult {
  ok: boolean;
  message: string;
  status?: string;
}

/**
 * Change a deal's status (e.g. cancel a duplicate). Status values (select
 * `Deal[change_status]`): new, not_confirmed, in_work, cancelled, false,
 * payment_waiting, part_payed, waiting_for_return, pending. For `cancelled`
 * you may pass `cancelReasonId` (e.g. "Дубль заказа"=54347 on li-ft.ru).
 * NOTE: mechanism discovered from the DOM; verify end-to-end before relying on it.
 */
export async function setOrderStatus(
  s: GcSession,
  dealId: string,
  status: string,
  opts: { cancelReasonId?: string } = {},
): Promise<SetOrderStatusResult> {
  await goto(s, `/sales/control/deal/update/id/${dealId}`);
  await s.page.waitForTimeout(1000);
  const submitted = await s.page.evaluate((args: { status: string; reason: string }) => {
    const sel = document.querySelector('select[name="Deal[change_status]"]') as HTMLSelectElement | null;
    if (!sel) return "no-select";
    const form = sel.closest("form") as HTMLFormElement | null;
    if (!form) return "no-form";
    sel.value = args.status;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    if (args.reason) {
      const r = document.querySelector('select[name="FunnelStageDeal[paramsObject][cancelReasonId]"]') as HTMLSelectElement | null;
      if (r) { r.value = args.reason; r.dispatchEvent(new Event("change", { bubbles: true })); }
    }
    form.submit();
    return "submitted";
  }, { status, reason: opts.cancelReasonId || "" });
  if (submitted !== "submitted") return { ok: false, message: `Не удалось отправить смену статуса: ${submitted}` };
  await s.page.waitForTimeout(2500);
  await goto(s, `/sales/control/deal/update/id/${dealId}`);
  await s.page.waitForTimeout(1000);
  const cur = await s.page.evaluate(
    () => (document.body.innerText.match(/Статус:\s*(Завершен|Отменен|Новый|В работе|Ложный|Ожидаем оплаты|Частично оплачен|Отложен|Не подтвержден)/i) || [])[1] || "?",
  );
  return { ok: true, message: "Смена статуса отправлена.", status: cur };
}

// ── Mailing categories (tag-like user segmentation) ─────────────────────────────
// GetCourse has NO free-form user "tags" — user segmentation = groups (see
// setUserGroups) + mailing categories. The card ops «Добавить/Удалить из категории
// рассылок» open an operation widget whose form carries checkboxes
// `…[mailingCategoryIds][<catId>]`. We drive the link + checkbox + «Запустить»
// (no operationType/POST guessing needed).

export interface GcMailingCategory {
  id: string;
  name: string;
}

/** List mailing categories (id + name) from the "add to mailing category" widget. */
export async function listMailingCategories(s: GcSession, userId: string): Promise<GcMailingCategory[]> {
  await goto(s, `/user/control/user/update/id/${userId}`);
  await s.page.waitForTimeout(1000);
  await s.page.evaluate(() => {
    const e = Array.from(document.querySelectorAll("a")).find(
      (x) => /^Добавить в категорию рассылок$/i.test((x as HTMLElement).innerText.trim()) &&
        /logic-action|operations-widget/i.test((x.className || "").toString()),
    ) as HTMLElement | undefined;
    e?.click();
  });
  await s.page.waitForTimeout(2200);
  return s.page.evaluate(() => {
    const out: { id: string; name: string }[] = [];
    document.querySelectorAll('input[name*="[mailingCategoryIds]["]').forEach((c) => {
      const id = ((c.getAttribute("name") || "").match(/\[(\d+)\]$/) || [])[1] || "";
      if (!id || id === "0") return;
      const name = ((c as HTMLElement).closest("label")?.innerText || (c as HTMLElement).parentElement?.innerText || "")
        .replace(/\s+/g, " ")
        .trim();
      out.push({ id, name });
    });
    return out;
  });
}

/**
 * Add or remove a user from a mailing category via the card operation widget.
 * Drives the «Добавить/Удалить из категории рассылок» action → checks the
 * `…[mailingCategoryIds][<categoryId>]` box → «Запустить» (single-step, executes).
 */
export async function setMailingCategory(
  s: GcSession,
  userId: string,
  categoryId: string,
  add: boolean,
): Promise<{ ok: boolean; message: string; rows?: string[] }> {
  const linkText = add ? "Добавить в категорию рассылок" : "Удалить из категории рассылок";
  await goto(s, `/user/control/user/update/id/${userId}`);
  await s.page.waitForTimeout(1000);
  await s.page.evaluate((lt: string) => {
    const e = Array.from(document.querySelectorAll("a")).find(
      (x) => new RegExp("^" + lt + "$", "i").test((x as HTMLElement).innerText.trim()) &&
        /logic-action|operations-widget/i.test((x.className || "").toString()),
    ) as HTMLElement | undefined;
    e?.click();
  }, linkText);
  await s.page.waitForTimeout(2200);
  const checked = await s.page.evaluate((cat: string) => {
    const c = document.querySelector(`input[name$="[mailingCategoryIds][${cat}]"]`) as HTMLInputElement | null;
    if (!c) return false;
    if (!c.checked) c.click();
    return c.checked;
  }, categoryId);
  if (!checked) return { ok: false, message: `Категория ${categoryId} не найдена в форме операции.` };
  await s.page.evaluate(() => {
    const bt = Array.from(document.querySelectorAll("button,a,input[type=submit],input[type=button]")).find(
      (x) => /^Запустить$/i.test(((x as HTMLElement).innerText || (x as HTMLInputElement).value || "").trim()) &&
        (x as HTMLElement).offsetParent !== null,
    ) as HTMLElement | undefined;
    bt?.click();
  });
  await s.page.waitForTimeout(3500);
  const res = await s.page.evaluate(() => {
    const t = (document.body.innerText || "").replace(/\s+/g, " ").trim();
    const rows: string[] = [];
    document.querySelectorAll("table tr").forEach((tr) => {
      const rt = ((tr as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
      if (/Успешно|Выполнен|Ошибка|не удал/i.test(rt)) rows.push(rt.slice(0, 120));
    });
    return { ok: /Успешно|Выполнен/i.test(t), rows };
  });
  return { ok: res.ok, message: res.ok ? "Готово." : "Ответ без подтверждения «Успешно».", rows: res.rows };
}
