/**
 * CLI runner — invoke a plugin tool handler directly.
 *   tsx src/run.ts <tool> '<jsonArgs>'
 * Example:
 *   tsx src/run.ts gc_find_user '{"email":"user@example.com"}'
 */
import {
  handleGcStatus,
  handleGcFindUser, gcFindUserSchema,
  handleGcListTrainingGroups, gcListTrainingGroupsSchema,
  handleGcCheckMembership, gcCheckMembershipSchema,
  handleGcAddUserToGroups, gcAddUserToGroupsSchema,
  handleGcListUserGroups, gcListUserGroupsSchema,
  handleGcAddToGroups, gcAddToGroupsSchema,
  handleGcRemoveFromGroups, gcRemoveFromGroupsSchema,
  handleGcCopyAccess, gcCopyAccessSchema,
  handleGcUpdateUser, gcUpdateUserSchema,
  handleGcFindOffers, gcFindOffersSchema,
  handleGcFindOrders, gcFindOrdersSchema,
  handleGcCreateOrder, gcCreateOrderSchema,
  handleGcSetOrderStatus, gcSetOrderStatusSchema,
  handleGcUserSummary, gcUserSummarySchema,
  handleGcListMailingCategories, gcListMailingCategoriesSchema,
  handleGcAddToMailingCategory, gcAddToMailingCategorySchema,
  handleGcRemoveFromMailingCategory, gcRemoveFromMailingCategorySchema,
} from "./tools.js";

const tool = process.argv[2];
const rawArgs = process.argv[3] || "{}";
const args = JSON.parse(rawArgs);

const dispatch: Record<string, () => Promise<string>> = {
  gc_status: () => handleGcStatus(),
  gc_find_user: () => handleGcFindUser(gcFindUserSchema.parse(args)),
  gc_list_training_groups: () => handleGcListTrainingGroups(gcListTrainingGroupsSchema.parse(args)),
  gc_check_membership: () => handleGcCheckMembership(gcCheckMembershipSchema.parse(args)),
  gc_add_user_to_groups: () => handleGcAddUserToGroups(gcAddUserToGroupsSchema.parse(args)),
  gc_list_user_groups: () => handleGcListUserGroups(gcListUserGroupsSchema.parse(args)),
  gc_add_to_groups: () => handleGcAddToGroups(gcAddToGroupsSchema.parse(args)),
  gc_remove_from_groups: () => handleGcRemoveFromGroups(gcRemoveFromGroupsSchema.parse(args)),
  gc_copy_access: () => handleGcCopyAccess(gcCopyAccessSchema.parse(args)),
  gc_update_user: () => handleGcUpdateUser(gcUpdateUserSchema.parse(args)),
  gc_find_offers: () => handleGcFindOffers(gcFindOffersSchema.parse(args)),
  gc_find_orders: () => handleGcFindOrders(gcFindOrdersSchema.parse(args)),
  gc_create_order: () => handleGcCreateOrder(gcCreateOrderSchema.parse(args)),
  gc_set_order_status: () => handleGcSetOrderStatus(gcSetOrderStatusSchema.parse(args)),
  gc_user_summary: () => handleGcUserSummary(gcUserSummarySchema.parse(args)),
  gc_list_mailing_categories: () => handleGcListMailingCategories(gcListMailingCategoriesSchema.parse(args)),
  gc_add_to_mailing_category: () => handleGcAddToMailingCategory(gcAddToMailingCategorySchema.parse(args)),
  gc_remove_from_mailing_category: () => handleGcRemoveFromMailingCategory(gcRemoveFromMailingCategorySchema.parse(args)),
};

const fn = dispatch[tool];
if (!fn) {
  console.error(`Unknown tool "${tool}". Available: ${Object.keys(dispatch).join(", ")}`);
  process.exit(2);
}

fn()
  .then((out) => {
    console.log(out);
    process.exit(0);
  })
  .catch((e) => {
    console.error("ERROR:", e.message || e);
    process.exit(1);
  });
