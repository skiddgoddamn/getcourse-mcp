import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import type { BrowserContext, Cookie, Page } from "playwright-core";
import { ensureEvalShim, type GcSession } from "./gc.js";

/**
 * Full access to a training with stop-lessons ("стоп-урок" = next lessons are
 * locked until the task of this one is accepted).
 *
 * Path that works (verified on li-ft.ru / АТОМ ЛИД):
 *  1. admin card -> «Войти под этим пользователем» (sublogin). It swaps the cookies of
 *     the admin browser context for the student's, so we copy the student cookies into
 *     a SEPARATE context and put the admin cookies back -> both sessions live at once;
 *  2. as the student: open every lesson not yet «accomplished», fill the answer form
 *     (text areas, first option of tests, a 1x1 png for required file fields), send;
 *  3. as the admin: /teach/control/answers -> «Принять» the pending answers of that student;
 *  4. repeat until no lesson needs action (new lessons open after acceptance, with a lag);
 *  5. verify from the ADMIN side: /teach/control/stat/userTraining/... must show no
 *     «Недоступен (стоп-урок)». Success is judged only by that, not by our own counters.
 *
 * NB: no named inner functions inside page.evaluate (esbuild __name helper).
 */

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export interface BlockStat {
  id: string;
  title: string;
  stopLocked: number;
}
export interface GrantResult {
  ok: boolean;
  message: string;
  blocks: BlockStat[];
  sent: number;
  accepted: number;
  log: string[];
}

async function go(page: Page, url: string): Promise<void> {
  let last: unknown;
  for (let i = 0; i < 4; i++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await ensureEvalShim(page);
      return;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** Training = list of blocks (nested trainings). A flat training counts as its own single block. */
async function listBlocks(s: GcSession, trainingId: string): Promise<{ id: string; title: string }[]> {
  await go(s.page, `${s.cfg.baseUrl}/teach/control/stream/view/id/${trainingId}`);
  await s.page.waitForTimeout(1500);
  const blocks = await s.page.evaluate((tid) => {
    const m = new Map<string, string>();
    for (const a of Array.from(document.querySelectorAll("a[href]"))) {
      const h = a.getAttribute("href") || "";
      const x = h.match(/\/teach\/control\/stream\/view\/id\/(\d+)/);
      if (x && x[1] !== tid && !m.has(x[1])) m.set(x[1], ((a as HTMLElement).innerText || "").replace(/\s+/g, " ").trim());
    }
    return Array.from(m.entries()).map(([id, title]) => ({ id, title }));
  }, trainingId);
  return blocks.length ? blocks : [{ id: trainingId, title: "(тренинг)" }];
}

/** Admin-side truth: how many lessons the user still sees as «Недоступен (стоп-урок)». */
export async function stopLockedByBlock(s: GcSession, userId: string, trainingId: string): Promise<BlockStat[]> {
  const blocks = await listBlocks(s, trainingId);
  const out: BlockStat[] = [];
  for (const b of blocks) {
    await go(s.page, `${s.cfg.baseUrl}/teach/control/stat/userTraining/id/${userId}/trainingId/${b.id}`);
    await s.page.waitForTimeout(1200);
    const n = await s.page.evaluate(() => (document.body.innerText.match(/Недоступен\s*\(стоп-урок\)/gi) || []).length);
    out.push({ id: b.id, title: b.title.split("\n")[0].slice(0, 70), stopLocked: n });
  }
  return out;
}

interface Lesson {
  id: string;
  state: string;
  title: string;
}

async function scanLessons(page: Page, baseUrl: string, blockIds: string[]): Promise<Lesson[]> {
  const res: Lesson[] = [];
  for (const id of blockIds) {
    await go(page, `${baseUrl}/teach/control/stream/view/id/${id}`);
    await page.waitForTimeout(1200);
    const rows = await page.evaluate(() => {
      const m = new Map<string, { id: string; cls: string; t: string }>();
      for (const e of Array.from(document.querySelectorAll("[class*=lesson-id-]"))) {
        const cls = (e as HTMLElement).className;
        const x = cls.match(/lesson-id-(\d+)/);
        if (x && cls.includes("user-state")) m.set(x[1], { id: x[1], cls, t: ((e as HTMLElement).innerText || "").replace(/\s+/g, " ") });
      }
      return Array.from(m.values());
    });
    for (const r of rows) {
      res.push({ id: r.id, state: (r.cls.match(/user-state-(\w+)/) || [])[1] || "", title: r.t });
    }
  }
  return res;
}

/** Fill and send the answer form of one lesson. Returns a short note. */
async function answerLesson(page: Page, baseUrl: string, lesson: Lesson, text: string): Promise<string> {
  await go(page, `${baseUrl}/teach/control/lesson/view/id/${lesson.id}`);
  await page.waitForTimeout(2000);
  const info = await page.evaluate(() => ({
    ta: document.querySelectorAll('#lessonAnswerForm textarea[name^="LessonAnswer"]').length,
    opts: document.querySelectorAll("#lessonAnswerForm input[type=radio], #lessonAnswerForm input[type=checkbox]").length,
    pending: /Задание ожидает проверки/i.test(document.body.innerText),
  }));
  if (info.pending) return "уже ждёт проверки";
  if (!info.ta && !info.opts) return "формы ответа нет (урок без задания)";

  const tas = page.locator('#lessonAnswerForm textarea[name^="LessonAnswer"]');
  for (let i = 0; i < (await tas.count()); i++) {
    if (await tas.nth(i).isVisible()) await tas.nth(i).fill(text);
  }
  // tests: first option of each radio group, nothing for checkbox groups beyond the first box
  await page.evaluate(() => {
    const seen = new Set<string>();
    for (const e of Array.from(document.querySelectorAll("#lessonAnswerForm input[type=radio], #lessonAnswerForm input[type=checkbox]"))) {
      const i = e as HTMLInputElement;
      const key = i.name;
      if (!seen.has(key)) {
        seen.add(key);
        i.checked = true;
        i.dispatchEvent(new Event("change", { bubbles: true }));
        i.dispatchEvent(new Event("click", { bubbles: true }));
      }
    }
  });
  // required file fields: the real <input type=file> is bound to the visible «Выбрать файл» button
  const pick = page.getByText("Выбрать файл");
  const nFiles = await pick.count();
  if (nFiles) {
    const file = join(tmpdir(), "gc-grant-proof.png");
    writeFileSync(file, PNG_1X1);
    for (let i = 0; i < nFiles; i++) {
      const [fc] = await Promise.all([page.waitForEvent("filechooser", { timeout: 8000 }), pick.nth(i).click()]).catch(() => [null]);
      if (fc) {
        await fc.setFiles(file);
        await page.waitForTimeout(3500);
      }
    }
  }
  const send = page.locator("button[name=send-answer]").first();
  if (!(await send.isVisible())) return "кнопка «Отправить ответ» скрыта (скорее всего сначала нужно пройти встроенный тест), пропущено";
  await send.click();
  await page.waitForTimeout(3500);
  const res = await page.evaluate(() => {
    const t = document.body.innerText;
    const m = t.match(/Не заполнено поле[^\n]*/);
    return { err: m ? m[0] : "", pending: /Задание ожидает проверки/i.test(t) };
  });
  if (res.err) return `ОШИБКА формы: ${res.err}`;
  return res.pending ? "отправлено" : "отправлено (статус «ожидает проверки» не виден, проверим по итогу)";
}

/** Accept pending answers of this student (matched by display name + lesson titles). */
async function acceptPending(admin: Page, baseUrl: string, name: string, titles: string[]): Promise<number> {
  await go(admin, `${baseUrl}/teach/control/answers`);
  await admin.waitForTimeout(2500);
  let n = 0;
  for (let i = 0; i < 60; i++) {
    let hit = admin
      .locator(".answer_wrapper.user-answer")
      .filter({ hasText: name })
      .filter({ hasText: "Задание ожидает проверки" });
    const mine = titles.filter(Boolean);
    if (mine.length) {
      // keep only answers whose lesson title is one of ours
      const rx = new RegExp(mine.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"));
      hit = hit.filter({ hasText: rx });
    }
    if (!(await hit.count())) break;
    await hit.first().locator("button[data-action=accept]").first().click();
    await admin.waitForTimeout(3000);
    n++;
    await go(admin, `${baseUrl}/teach/control/answers`);
    await admin.waitForTimeout(2000);
  }
  return n;
}

async function adminAlive(page: Page, baseUrl: string): Promise<boolean> {
  await go(page, `${baseUrl}/pl/user/user`);
  return !/login/i.test(page.url());
}

export async function grantFullAccess(
  s: GcSession,
  userId: string,
  opts: { trainingId: string; answerText?: string; dryRun?: boolean; maxRounds?: number },
): Promise<GrantResult> {
  const answerText = opts.answerText || "Изучил, готово";
  const maxRounds = opts.maxRounds ?? 15;
  const log: string[] = [];
  const base = s.cfg.baseUrl;

  const before = await stopLockedByBlock(s, userId, opts.trainingId);
  const lockedBefore = before.reduce((a, b) => a + b.stopLocked, 0);
  if (opts.dryRun) {
    return {
      ok: lockedBefore === 0,
      message:
        lockedBefore === 0
          ? "dryRun: «Недоступен (стоп-урок)» нет, делать нечего."
          : `dryRun: НИЧЕГО не отправлено. Закрыто стоп-уроками: ${lockedBefore}. Выполнил бы: вход под учеником, ответы на задания по цепочке, приём в ленте ответов, проверка.`,
      blocks: before,
      sent: 0,
      accepted: 0,
      log,
    };
  }
  if (lockedBefore === 0) {
    return { ok: true, message: "Стоп-уроков уже нет, ничего не делал.", blocks: before, sent: 0, accepted: 0, log };
  }

  const adminCtx = s.page.context();
  const adminCookies: Cookie[] = await adminCtx.cookies(base);

  // 1. sublogin
  await go(s.page, `${base}/user/control/user/update/id/${userId}`);
  await s.page.waitForTimeout(1500);
  const clicked = await s.page.evaluate(() => {
    const a = document.querySelector("a[data-action=sublogin]") as HTMLElement | null;
    if (a) a.click();
    return !!a;
  });
  if (!clicked) throw new Error("На карточке нет «Войти под этим пользователем» (нужны права админа).");
  await s.page.waitForTimeout(5000);
  await go(s.page, `${base}/teach/control/stream/index`);
  const studentName = await s.page.evaluate(() => {
    const m = document.body.innerText.match(/Вы авторизованы как пользователь:\s*([^\n]+)/);
    return m ? m[1].trim() : "";
  });
  const studentCookies: Cookie[] = await adminCtx.cookies(base);

  // 2. put the admin back immediately, student lives in its own context
  await adminCtx.clearCookies();
  await adminCtx.addCookies(adminCookies);
  let studentCtx: BrowserContext | null = null;
  let sent = 0;
  let accepted = 0;
  try {
    if (!(await adminAlive(s.page, base))) {
      throw new Error("Админская сессия не восстановилась после входа под учеником — войди заново (node _login.cjs) и повтори.");
    }
    studentCtx = await s.browser.newContext();
    await studentCtx.addCookies(studentCookies);
    const sp = await studentCtx.newPage();
    sp.on("dialog", (d) => d.accept().catch(() => {}));
    const name = studentName || "";
    log.push(`ученик в ленте ответов: «${name || "?"}»`);

    const blockIds = (await listBlocks(s, opts.trainingId)).map((b) => b.id);
    let idle = 0;
    const ourTitles = new Set<string>();
    const skipped = new Set<string>(); // уроки, на которые ответить нельзя (тест, нет формы, ошибка формы)
    for (let round = 1; round <= maxRounds; round++) {
      const lessons = await scanLessons(sp, base, blockIds);
      const todo = lessons.filter((l) => l.state !== "accomplished" && l.state !== "not_reached" && !skipped.has(l.id));
      const blocked = lessons.filter((l) => l.state === "not_reached").length;
      log.push(`раунд ${round}: к ответу ${todo.length}, закрыто ${blocked}`);
      if (!todo.length) {
        // acceptance lags; wait a bit while something is still locked
        if (blocked > 0 && ++idle <= 3) {
          await sp.waitForTimeout(25000);
          continue;
        }
        break;
      }
      idle = 0;
      for (const l of todo) {
        const note = await answerLesson(sp, base, l, answerText);
        log.push(`  урок ${l.id}: ${note}`);
        if (!note.startsWith("отправлено") && !note.startsWith("уже ждёт")) skipped.add(l.id);
        if (note.startsWith("отправлено")) {
          sent++;
          // title as shown in the answers feed = lesson title without the state prefix / «просмотрено»
          ourTitles.add(l.title.replace(/НЕОБХОДИМО ВЫПОЛНИТЬ ЗАДАНИЕ \(СТОП-УРОК\)|НЕДОСТУПЕН \(СТОП-УРОК\)|просмотрено/gi, "").trim().slice(0, 40));
        }
      }
      accepted += await acceptPending(s.page, base, name, Array.from(ourTitles));
    }
  } finally {
    if (studentCtx) await studentCtx.close().catch(() => {});
    // leave the admin cookies in place whatever happened
    await adminCtx.clearCookies().catch(() => {});
    await adminCtx.addCookies(adminCookies).catch(() => {});
  }

  const after = await stopLockedByBlock(s, userId, opts.trainingId);
  const lockedAfter = after.reduce((a, b) => a + b.stopLocked, 0);
  return {
    ok: lockedAfter === 0,
    message:
      lockedAfter === 0
        ? `OK: «Недоступен (стоп-урок)» не осталось (было ${lockedBefore}). Ответов отправлено ${sent}, принято ${accepted}.`
        : `FAIL: осталось «Недоступен (стоп-урок)»: ${lockedAfter} (было ${lockedBefore}). Ответов отправлено ${sent}, принято ${accepted}. Смотри log.`,
    blocks: after,
    sent,
    accepted,
    log,
  };
}
