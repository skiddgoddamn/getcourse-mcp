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
} from "./tools.js";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "getcourse-mcp", version: "0.1.0" });

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

  return server;
}

async function main() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[getcourse-mcp] stdio server started (9 tools). Requires GETCOURSE_CDP_URL + logged-in browser.");
}

main().catch((e) => {
  console.error("[getcourse-mcp] fatal:", e);
  process.exit(1);
});
