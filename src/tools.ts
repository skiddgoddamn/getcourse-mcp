import { z } from "zod";
import {
  connect,
  status,
  findUser,
  resolveUserId,
  listTrainingGroups,
  listUserGroups,
  setUserGroups,
  checkMembership,
  addUserToGroups,
  type GcGroup,
} from "./gc.js";

/**
 * Tool layer: zod schemas + handlers returning human-readable text.
 * Each handler opens a CDP session, does its work, and detaches (leaves the
 * user's browser open).
 */

async function withSession<T>(fn: (s: Awaited<ReturnType<typeof connect>>) => Promise<T>): Promise<T> {
  const s = await connect();
  try {
    return await fn(s);
  } finally {
    await s.close();
  }
}

// gc_status
export const gcStatusSchema = z.object({});
export async function handleGcStatus(): Promise<string> {
  return withSession(async (s) => {
    const st = await status(s);
    return st.loggedIn
      ? `✅ Залогинен. ${st.account ?? ""} (${st.url})`
      : `❌ Не залогинен (${st.url}). Войдите в аккаунт в браузере с debug-портом.`;
  });
}

// gc_find_user
export const gcFindUserSchema = z.object({
  email: z.string().describe("Email пользователя для поиска."),
});
export async function handleGcFindUser(p: z.infer<typeof gcFindUserSchema>): Promise<string> {
  return withSession(async (s) => {
    const u = await findUser(s, p.email);
    if (!u) return `Пользователь ${p.email} не найден.`;
    return `Найден: ${u.name} | ${u.email} | тип: ${u.type} | статус: ${u.status} | id: ${u.id}`;
  });
}

// gc_list_training_groups
export const gcListTrainingGroupsSchema = z.object({
  trainingId: z.string().describe("ID тренинга."),
  filter: z.string().optional().describe("Подстрока для фильтрации названий групп (регистронезависимо)."),
});
export async function handleGcListTrainingGroups(p: z.infer<typeof gcListTrainingGroupsSchema>): Promise<string> {
  return withSession(async (s) => {
    let groups = await listTrainingGroups(s, p.trainingId);
    if (p.filter) groups = groups.filter((g) => g.name.toLowerCase().includes(p.filter!.toLowerCase()));
    if (!groups.length) return "Группы не найдены.";
    return groups.map((g) => `${g.id}\t${g.name}`).join("\n");
  });
}

// gc_check_membership
export const gcCheckMembershipSchema = z.object({
  email: z.string().describe("Email пользователя."),
  groups: z
    .array(z.object({ id: z.string(), name: z.string().optional() }))
    .describe("Группы для проверки: [{id, name?}]."),
});
export async function handleGcCheckMembership(p: z.infer<typeof gcCheckMembershipSchema>): Promise<string> {
  return withSession(async (s) => {
    const res = await checkMembership(s, p.email, p.groups as GcGroup[]);
    return res.map((m) => `${m.member ? "✅" : "—"} ${m.name ?? m.groupId} (${m.groupId})`).join("\n");
  });
}

// gc_add_user_to_groups (write)
export const gcAddUserToGroupsSchema = z.object({
  email: z.string().describe("Email пользователя (существующий или новый)."),
  groupIds: z.array(z.string()).min(1).describe("ID групп, в которые добавить."),
  sendInvitation: z.boolean().optional().describe("Отправлять письмо-приглашение (по умолчанию false)."),
  overwriteExisting: z
    .boolean()
    .optional()
    .describe("Ставить флаг «перезаписать при совпадении» — нужен, чтобы группы применились к существующему юзеру (по умолчанию true; импорт несёт только email, данные не теряются)."),
  dryRun: z.boolean().optional().describe("Дойти до предпросмотра без подтверждения (по умолчанию false)."),
});
export async function handleGcAddUserToGroups(p: z.infer<typeof gcAddUserToGroupsSchema>): Promise<string> {
  return withSession(async (s) => {
    const r = await addUserToGroups(s, p.email, p.groupIds, {
      sendInvitation: p.sendInvitation,
      overwriteExisting: p.overwriteExisting,
      dryRun: p.dryRun,
    });
    const btn = r.buttonsAtConfirm?.length ? `\nКнопки на шаге подтверждения: ${r.buttonsAtConfirm.join(" | ")}` : "";
    return `${r.ok ? "OK" : "FAIL"} [${r.step}] ${r.message}${btn}`;
  });
}

// gc_list_user_groups
export const gcListUserGroupsSchema = z.object({
  email: z.string().describe("Email пользователя."),
  filter: z.string().optional().describe("Подстрока для фильтрации названий групп (регистронезависимо)."),
});
export async function handleGcListUserGroups(p: z.infer<typeof gcListUserGroupsSchema>): Promise<string> {
  return withSession(async (s) => {
    const id = await resolveUserId(s, p.email);
    let groups = await listUserGroups(s, id);
    if (p.filter) groups = groups.filter((g) => g.name.toLowerCase().includes(p.filter!.toLowerCase()));
    if (!groups.length) return "Групп нет.";
    return groups.map((g) => `${g.id}\t${g.name}`).join("\n");
  });
}

// gc_remove_from_groups
export const gcRemoveFromGroupsSchema = z.object({
  email: z.string().describe("Email пользователя."),
  groupIds: z.array(z.string()).min(1).describe("ID групп, из которых убрать (= закрыть доступ)."),
  dryRun: z.boolean().optional().describe("Показать изменение без сохранения."),
});
export async function handleGcRemoveFromGroups(p: z.infer<typeof gcRemoveFromGroupsSchema>): Promise<string> {
  return withSession(async (s) => {
    const id = await resolveUserId(s, p.email);
    const r = await setUserGroups(s, id, { remove: p.groupIds, dryRun: p.dryRun });
    const diff = r.after ? ` | было ${r.before.length} → стало ${r.after.length} групп` : "";
    return `${r.ok ? "OK" : "FAIL"} ${r.message}${diff}`;
  });
}

// gc_add_to_groups (checkbox mechanism — clean, existing users; preserves other groups)
export const gcAddToGroupsSchema = z.object({
  email: z.string().describe("Email существующего пользователя."),
  groupIds: z.array(z.string()).min(1).describe("ID групп, в которые добавить (= выдать доступ)."),
  dryRun: z.boolean().optional().describe("Показать изменение без сохранения."),
});
export async function handleGcAddToGroups(p: z.infer<typeof gcAddToGroupsSchema>): Promise<string> {
  return withSession(async (s) => {
    const id = await resolveUserId(s, p.email);
    const r = await setUserGroups(s, id, { add: p.groupIds, dryRun: p.dryRun });
    const diff = r.after ? ` | было ${r.before.length} → стало ${r.after.length} групп` : "";
    return `${r.ok ? "OK" : "FAIL"} ${r.message}${diff}`;
  });
}

// gc_copy_access — grant "same access as another student": copy their groups
export const gcCopyAccessSchema = z.object({
  fromEmail: z.string().describe("Эталонный ученик, чьи группы копируем."),
  toEmail: z.string().describe("Кому выдать такие же группы."),
  filter: z.string().optional().describe("Копировать только группы, чьё название содержит подстроку."),
  dryRun: z.boolean().optional().describe("Показать, что будет добавлено, без сохранения."),
});
export async function handleGcCopyAccess(p: z.infer<typeof gcCopyAccessSchema>): Promise<string> {
  return withSession(async (s) => {
    const fromId = await resolveUserId(s, p.fromEmail);
    let src = await listUserGroups(s, fromId);
    if (p.filter) src = src.filter((g) => g.name.toLowerCase().includes(p.filter!.toLowerCase()));
    if (!src.length) return `У ${p.fromEmail} нет групп${p.filter ? " по фильтру" : ""} для копирования.`;
    const toId = await resolveUserId(s, p.toEmail);
    const r = await setUserGroups(s, toId, { add: src.map((g) => g.id), dryRun: p.dryRun });
    const list = src.map((g) => `• ${g.name} (${g.id})`).join("\n");
    return `${r.ok ? "OK" : "FAIL"} ${r.message}\nКопируем ${src.length} групп(ы):\n${list}`;
  });
}
