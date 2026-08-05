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
  updateUser,
  findOffers,
  findUserOrders,
  createOrder,
  payDeal,
  setOrderStatus,
  refundOrder,
  listMailingCategories,
  setMailingCategory,
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
    if (st.loggedIn) return `✅ Залогинен, права админки есть. ${st.account ?? ""} (${st.url})`;
    if (st.wrongRole)
      return (
        `❌ Сессия есть, но без прав админки${st.account ? ` — ${st.account}` : ""}. ` +
        `Похоже, в браузере вошли под учеником/сотрудником. Перелогиньтесь администратором (${st.url}).`
      );
    return `❌ Не залогинен (${st.url}). Войдите в аккаунт в браузере с debug-портом.`;
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

// gc_update_user — edit profile fields on the card (email is out of scope)
export const gcUpdateUserSchema = z.object({
  email: z.string().describe("Email пользователя."),
  firstName: z.string().optional().describe("Имя."),
  lastName: z.string().optional().describe("Фамилия."),
  phone: z.string().optional().describe("Телефон."),
  city: z.string().optional().describe("Город."),
  comment: z.string().optional().describe("Комментарий."),
  dryRun: z.boolean().optional().describe("Заполнить поля без сохранения."),
});
export async function handleGcUpdateUser(p: z.infer<typeof gcUpdateUserSchema>): Promise<string> {
  return withSession(async (s) => {
    const id = await resolveUserId(s, p.email);
    const { email: _e, dryRun, ...fields } = p;
    const r = await updateUser(s, id, fields, dryRun);
    const diff = r.after
      ? "\n" + Object.keys(r.after).map((k) => `• ${k}: «${r.before[k] ?? ""}» → «${r.after![k]}»`).join("\n")
      : "";
    return `${r.ok ? "OK" : "FAIL"} ${r.message}${diff}`;
  });
}

// gc_find_offers — search sales offers by name (for gc_create_order)
export const gcFindOffersSchema = z.object({
  query: z.string().describe("Подстрока названия оффера (например «Формула AI Полный доступ»)."),
});
export async function handleGcFindOffers(p: z.infer<typeof gcFindOffersSchema>): Promise<string> {
  return withSession(async (s) => {
    const offers = await findOffers(s, p.query);
    if (!offers.length) return "Офферы не найдены.";
    return offers.map((o) => `${o.id}\t${o.actual ? "✅" : "—"} ${o.price}\t${o.text}`).join("\n");
  });
}

// gc_find_orders — list a user's orders (deals)
export const gcFindOrdersSchema = z.object({
  email: z.string().describe("Email пользователя."),
});
export async function handleGcFindOrders(p: z.infer<typeof gcFindOrdersSchema>): Promise<string> {
  return withSession(async (s) => {
    const id = await resolveUserId(s, p.email);
    const orders = await findUserOrders(s, id);
    if (!orders.length) return "Заказов нет.";
    return orders.map((o) => `${o.dealId}\t${o.status || "?"}\t${o.amount}\t${o.text}`).join("\n");
  });
}

// gc_create_order (write) — create an order = grant access via a purchase.
// For "только купившие" trainings this is the ONLY way to open access (groups don't).
export const gcCreateOrderSchema = z.object({
  email: z.string().describe("Email пользователя (существующий)."),
  offerIds: z.array(z.string()).min(1).describe("ID офферов (см. gc_find_offers). 0₽ комп-оффер = доступ без денег."),
  tryPayFromDeposit: z.boolean().optional().describe("Попытаться оплатить с депозита (по умолчанию false)."),
  complete: z
    .boolean()
    .optional()
    .describe(
      "Сразу провести 0₽-оплату созданной сделки → доступ выдаётся немедленно. НУЖНО для комп-офферов «только купившие», где сделка «Новый» доступ НЕ даёт. " +
        "По умолчанию false: сделка остаётся «Новый», доступ не выдан — заверши потом gc_pay_order. ⚠️ используй complete только для 0₽/бесплатных офферов.",
    ),
  dryRun: z
    .boolean()
    .optional()
    .describe("Только эхо, БЕЗ создания. ВНИМАНИЕ: при dryRun=false заказ создаётся сразу — у операции нет предпросмотра."),
});
export async function handleGcCreateOrder(p: z.infer<typeof gcCreateOrderSchema>): Promise<string> {
  return withSession(async (s) => {
    const id = await resolveUserId(s, p.email);
    if (p.dryRun) {
      const r = await createOrder(s, id, p.offerIds, { dryRun: true, tryPayFromDeposit: p.tryPayFromDeposit });
      return `${r.ok ? "OK" : "FAIL"} ${r.message}`;
    }
    // Снимок сделок ДО записи. Операция одношаговая и может упасть уже ПОСЛЕ того,
    // как заказ создан, — брошенная ошибка не доказывает, что ничего не произошло;
    // источник истины только состояние аккаунта. Диф со снимком заодно опознаёт
    // именно НАШУ сделку вместо допущения «самая верхняя — наша».
    const before = new Set((await findUserOrders(s, id)).map((o) => o.dealId));
    let base: string;
    try {
      const r = await createOrder(s, id, p.offerIds, { tryPayFromDeposit: p.tryPayFromDeposit });
      const rows = r.rows?.length ? `\n${r.rows.join("\n")}` : "";
      base = `${r.ok ? "OK" : "FAIL"} ${r.message}${rows}`;
    } catch (e) {
      base = `FAIL создание заказа упало: ${(e as Error).message}`;
    }
    const fresh = (await findUserOrders(s, id)).find((o) => !before.has(o.dealId));
    if (!fresh) return `${base}\nНовых сделок у пользователя не появилось — заказ не создан.`;
    base += `\nСоздана сделка ${fresh.dealId}${fresh.status ? ` — статус «${fresh.status}»` : ""}.`;
    if (!p.complete) return base;
    // complete=true → provести оплату созданной сделки, чтобы доступ стал живым.
    // Для 0₽-заказа payDeal увидит, что Геткурс уже завершил сделку сам, и ничего не тронет.
    try {
      const pr = await payDeal(s, fresh.dealId, { dryRun: false });
      return `${base}\n${pr.ok ? "OK" : "FAIL"} ${pr.message}`;
    } catch (e) {
      return (
        `${base}\n⚠️ Заказ создан, но шаг завершения упал: ${(e as Error).message}\n` +
        `Проверь статус сделки и при необходимости добей: gc_pay_order {"dealId":"${fresh.dealId}"}.`
      );
    }
  });
}

// gc_pay_order (write) — complete a deal by registering a (0₽ by default) received payment
export const gcPayOrderSchema = z.object({
  dealId: z.string().describe("ID сделки (из gc_find_orders / gc_user_summary / URL /sales/control/deal/update/id/<id>)."),
  amount: z.string().optional().describe('Сумма платежа, по умолчанию "0" (комп/бесплатный доступ). ⚠️ НЕ ставь 0 на реальной платной сделке.'),
  dryRun: z.boolean().optional().describe("Только эхо, без проведения платежа."),
});
export async function handleGcPayOrder(p: z.infer<typeof gcPayOrderSchema>): Promise<string> {
  return withSession(async (s) => {
    const r = await payDeal(s, p.dealId, { amount: p.amount, dryRun: p.dryRun });
    return `${r.ok ? "OK" : "FAIL"} ${r.message}`;
  });
}

// gc_set_order_status (write) — change a deal's status (e.g. cancel a duplicate)
export const gcSetOrderStatusSchema = z.object({
  dealId: z.string().describe("ID сделки (из gc_find_orders или URL /sales/control/deal/update/id/<id>)."),
  status: z
    .enum(["new", "not_confirmed", "in_work", "cancelled", "false", "payment_waiting", "part_payed", "waiting_for_return", "pending"])
    .describe("Новый статус сделки."),
  cancelReasonId: z.string().optional().describe("ID причины отмены для status=cancelled (напр. «Дубль заказа»=54347 на li-ft.ru)."),
});
export async function handleGcSetOrderStatus(p: z.infer<typeof gcSetOrderStatusSchema>): Promise<string> {
  return withSession(async (s) => {
    const r = await setOrderStatus(s, p.dealId, p.status, { cancelReasonId: p.cancelReasonId });
    return `${r.ok ? "OK" : "FAIL"} ${r.message}${r.status ? ` Текущий статус: ${r.status}` : ""}`;
  });
}

// gc_refund_order (write) — real money refund via the Геткурс payment module.
// Only payments processed by the platform are refundable this way; VAT must
// mirror the original receipt (чек «нет налога» → vat=none).
export const gcRefundOrderSchema = z.object({
  dealId: z.string().describe("ID сделки (из gc_find_orders / gc_user_summary)."),
  paymentId: z.string().optional().describe("ID платежа, если на сделке их несколько (список вернётся в ошибке)."),
  amount: z.number().optional().describe("Сумма частичного возврата (только при одной позиции; по умолчанию полная стоимость)."),
  vat: z
    .enum(["none", "0", "5", "7", "10", "20", "22"])
    .optional()
    .describe("Ставка НДС позиций возврата — как в чеке прихода (по умолчанию none = «без НДС»)."),
  dryRun: z.boolean().optional().describe("Заполнить форму возврата и показать сводку БЕЗ отправки (по умолчанию false)."),
});
export async function handleGcRefundOrder(p: z.infer<typeof gcRefundOrderSchema>): Promise<string> {
  return withSession(async (s) => {
    const r = await refundOrder(s, p.dealId, { paymentId: p.paymentId, amount: p.amount, vat: p.vat, dryRun: p.dryRun });
    const pays = r.payments?.length ? `\nПлатежи сделки:\n${r.payments.map((x) => `• ${x.paymentId} — ${x.text}`).join("\n")}` : "";
    return `${r.ok ? "OK" : "FAIL"} [${r.step}] ${r.message}${pays}`;
  });
}

// gc_user_summary — one call: profile + groups + orders (composes reads, one session)
export const gcUserSummarySchema = z.object({
  email: z.string().describe("Email пользователя."),
});
export async function handleGcUserSummary(p: z.infer<typeof gcUserSummarySchema>): Promise<string> {
  return withSession(async (s) => {
    const u = await findUser(s, p.email);
    if (!u || !u.id) return `Пользователь ${p.email} не найден.`;
    const groups = await listUserGroups(s, u.id);
    const orders = await findUserOrders(s, u.id);
    const g = groups.length ? groups.map((x) => `  • ${x.name} (${x.id})`).join("\n") : "  (нет)";
    const o = orders.length ? orders.map((x) => `  • ${x.dealId} ${x.status || "?"} ${x.amount} — ${x.text}`).join("\n") : "  (нет)";
    return `${u.name} | ${u.email} | ${u.type} | ${u.status} | id: ${u.id}\nГруппы (${groups.length}):\n${g}\nЗаказы (${orders.length}):\n${o}`;
  });
}

// gc_list_mailing_categories — mailing categories (tag-like segmentation) id + name
export const gcListMailingCategoriesSchema = z.object({
  email: z.string().describe("Email любого пользователя (список категорий общий для аккаунта)."),
});
export async function handleGcListMailingCategories(p: z.infer<typeof gcListMailingCategoriesSchema>): Promise<string> {
  return withSession(async (s) => {
    const id = await resolveUserId(s, p.email);
    const cats = await listMailingCategories(s, id);
    if (!cats.length) return "Категории рассылок не найдены.";
    return cats.map((c) => `${c.id}\t${c.name}`).join("\n");
  });
}

// gc_add_to_mailing_category (write)
export const gcAddToMailingCategorySchema = z.object({
  email: z.string().describe("Email пользователя."),
  categoryId: z.string().describe("ID категории рассылок (см. gc_list_mailing_categories)."),
});
export async function handleGcAddToMailingCategory(p: z.infer<typeof gcAddToMailingCategorySchema>): Promise<string> {
  return withSession(async (s) => {
    const id = await resolveUserId(s, p.email);
    const r = await setMailingCategory(s, id, p.categoryId, true);
    const rows = r.rows?.length ? `\n${r.rows.join("\n")}` : "";
    return `${r.ok ? "OK" : "FAIL"} ${r.message}${rows}`;
  });
}

// gc_remove_from_mailing_category (write)
export const gcRemoveFromMailingCategorySchema = z.object({
  email: z.string().describe("Email пользователя."),
  categoryId: z.string().describe("ID категории рассылок (см. gc_list_mailing_categories)."),
});
export async function handleGcRemoveFromMailingCategory(p: z.infer<typeof gcRemoveFromMailingCategorySchema>): Promise<string> {
  return withSession(async (s) => {
    const id = await resolveUserId(s, p.email);
    const r = await setMailingCategory(s, id, p.categoryId, false);
    const rows = r.rows?.length ? `\n${r.rows.join("\n")}` : "";
    return `${r.ok ? "OK" : "FAIL"} ${r.message}${rows}`;
  });
}
