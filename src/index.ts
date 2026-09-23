#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  gcStatusSchema, handleGcStatus,
  gcFindUserSchema, handleGcFindUser,
  gcListTrainingGroupsSchema, handleGcListTrainingGroups,
  gcCheckMembershipSchema, handleGcCheckMembership,
  gcAddUserToGroupsSchema, handleGcAddUserToGroups,
  gcListUserGroupsSchema, handleGcListUserGroups,
  gcAddToGroupsSchema, handleGcAddToGroups,
  gcRemoveFromGroupsSchema, handleGcRemoveFromGroups,
  gcCopyAccessSchema, handleGcCopyAccess,
  gcUpdateUserSchema, handleGcUpdateUser,
  gcFindOffersSchema, handleGcFindOffers,
  gcFindOrdersSchema, handleGcFindOrders,
  gcCreateOrderSchema, handleGcCreateOrder,
  gcPayOrderSchema, handleGcPayOrder,
  gcSetOrderStatusSchema, handleGcSetOrderStatus,
  gcRefundOrderSchema, handleGcRefundOrder,
  gcUnlockModulesSchema, handleGcUnlockModules,
  gcUserSummarySchema, handleGcUserSummary,
  gcListMailingCategoriesSchema, handleGcListMailingCategories,
  gcAddToMailingCategorySchema, handleGcAddToMailingCategory,
  gcRemoveFromMailingCategorySchema, handleGcRemoveFromMailingCategory,
} from "./tools.js";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "getcourse-mcp", version: "0.5.1" });

  server.tool(
    "gc_status",
    "Проверить сессию GetCourse: залогинен ли администратор в браузере по CDP.",
    gcStatusSchema.shape,
    async () => text(await handleGcStatus()),
  );

  server.tool(
    "gc_find_user",
    "Найти пользователя по email в списке пользователей (id, имя, тип, статус).",
    gcFindUserSchema.shape,
    async (p) => text(await handleGcFindUser(p)),
  );

  server.tool(
    "gc_list_training_groups",
    "Список групп доступа, связанных с тренингом (id + название). filter — подстрока по названию.",
    gcListTrainingGroupsSchema.shape,
    async (p) => text(await handleGcListTrainingGroups(p)),
  );

  server.tool(
    "gc_check_membership",
    "Проверить, состоит ли пользователь (по email) в указанных группах (по списку пользователей — мгновенно).",
    gcCheckMembershipSchema.shape,
    async (p) => text(await handleGcCheckMembership(p)),
  );

  server.tool(
    "gc_add_user_to_groups",
    "Добавить пользователя в группы через импорт (создаёт нового при отсутствии) = выдать доступ. dryRun — предпросмотр.",
    gcAddUserToGroupsSchema.shape,
    async (p) => text(await handleGcAddUserToGroups(p)),
  );

  server.tool(
    "gc_list_user_groups",
    "Список групп, в которых состоит пользователь (id + название). filter — подстрока по названию.",
    gcListUserGroupsSchema.shape,
    async (p) => text(await handleGcListUserGroups(p)),
  );

  server.tool(
    "gc_add_to_groups",
    "Добавить существующего пользователя в группы через карточку (чисто, без импорта; сохраняет остальные группы). dryRun — предпросмотр.",
    gcAddToGroupsSchema.shape,
    async (p) => text(await handleGcAddToGroups(p)),
  );

  server.tool(
    "gc_remove_from_groups",
    "Убрать пользователя из групп = закрыть доступ (сохраняет остальные группы). dryRun — предпросмотр.",
    gcRemoveFromGroupsSchema.shape,
    async (p) => text(await handleGcRemoveFromGroups(p)),
  );

  server.tool(
    "gc_copy_access",
    "Выдать пользователю такой же доступ, как у эталонного ученика (копирует его группы). filter — только группы с подстрокой. dryRun — предпросмотр.",
    gcCopyAccessSchema.shape,
    async (p) => text(await handleGcCopyAccess(p)),
  );

  server.tool(
    "gc_update_user",
    "Изменить поля профиля на карточке (имя/фамилия/телефон/город/комментарий). Email вне области. dryRun — без сохранения.",
    gcUpdateUserSchema.shape,
    async (p) => text(await handleGcUpdateUser(p)),
  );

  server.tool(
    "gc_find_offers",
    "Найти офферы продажи по подстроке названия (id + цена + актуальность). Нужно для gc_create_order.",
    gcFindOffersSchema.shape,
    async (p) => text(await handleGcFindOffers(p)),
  );

  server.tool(
    "gc_find_orders",
    "Список заказов (сделок) пользователя по email: dealId + статус + сумма.",
    gcFindOrdersSchema.shape,
    async (p) => text(await handleGcFindOrders(p)),
  );

  server.tool(
    "gc_create_order",
    "Создать заказ по офферам = выдать доступ покупкой (для тренингов «только купившие» группы доступ НЕ дают). 0₽ комп-оффер = доступ без денег. " +
      "Сделка создаётся в статусе «Новый» — доступ НЕ выдан, пока сделка не оплачена: передай complete=true, чтобы сразу завершить 0₽-сделку и выдать доступ (или заверши потом gc_pay_order). " +
      "⚠️ dryRun=false создаёт заказ СРАЗУ (без предпросмотра).",
    gcCreateOrderSchema.shape,
    async (p) => text(await handleGcCreateOrder(p)),
  );

  server.tool(
    "gc_pay_order",
    "Завершить сделку (→ «Завершен»), чем ВЫДАЁТСЯ доступ по офферу. amount=0 (по умолч., комп-доступ): Геткурс не принимает нулевой платёж, поэтому сделка переводится в «Завершен» статусом. amount>0: проводится платёж «Получен». Результат проверяется по полю «Статус:» после перезагрузки. ⚠️ не ставь 0 на реальной платной сделке. dryRun — предпросмотр.",
    gcPayOrderSchema.shape,
    async (p) => text(await handleGcPayOrder(p)),
  );

  server.tool(
    "gc_set_order_status",
    "Изменить статус сделки (напр. отменить дубль: status=cancelled + cancelReasonId; payed = «Завершен»). OK только если карточка после перезагрузки показывает нужный статус.",
    gcSetOrderStatusSchema.shape,
    async (p) => text(await handleGcSetOrderStatus(p)),
  );

  server.tool(
    "gc_refund_order",
    "Оформить возврат денег по заказу через платёжный модуль Геткурса (реальный возврат на карту покупателя). Только для платежей через платформу Геткурс. НДС — как в чеке прихода (none = «без НДС»). dryRun — сводка без отправки.",
    gcRefundOrderSchema.shape,
    async (p) => text(await handleGcRefundOrder(p)),
  );

  server.tool(
    "gc_unlock_modules",
    "Открыть застрявшему (но оплатившему) ученику модули: протолкнуть процесс выдачи доступа мимо ожидания «Ждем: завершил модуль N» (нажимает «перейти далее»). all=true — открыть весь курс сразу; по умолчанию — следующий модуль. Нужны права менеджера/супервайзера процесса. dryRun — предпросмотр.",
    gcUnlockModulesSchema.shape,
    async (p) => text(await handleGcUnlockModules(p)),
  );

  server.tool(
    "gc_user_summary",
    "Сводка по пользователю за один вызов: профиль + группы + заказы.",
    gcUserSummarySchema.shape,
    async (p) => text(await handleGcUserSummary(p)),
  );

  server.tool(
    "gc_list_mailing_categories",
    "Список категорий рассылок (tag-подобная сегментация): id + название. GetCourse не имеет свободных user-тегов — это группы + категории рассылок.",
    gcListMailingCategoriesSchema.shape,
    async (p) => text(await handleGcListMailingCategories(p)),
  );

  server.tool(
    "gc_add_to_mailing_category",
    "Добавить пользователя в категорию рассылок (по categoryId из gc_list_mailing_categories).",
    gcAddToMailingCategorySchema.shape,
    async (p) => text(await handleGcAddToMailingCategory(p)),
  );

  server.tool(
    "gc_remove_from_mailing_category",
    "Убрать пользователя из категории рассылок (по categoryId).",
    gcRemoveFromMailingCategorySchema.shape,
    async (p) => text(await handleGcRemoveFromMailingCategory(p)),
  );

  return server;
}

async function main() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[getcourse-mcp] stdio server started (21 tools). Requires GETCOURSE_CDP_URL + logged-in browser.");
}

main().catch((e) => {
  console.error("[getcourse-mcp] fatal:", e);
  process.exit(1);
});
