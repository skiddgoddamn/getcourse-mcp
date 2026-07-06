import { z } from "zod";
import {
  connect,
  status,
  findUser,
  listTrainingGroups,
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
