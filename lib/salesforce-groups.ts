import { sfQuery, syncDirectory } from './salesforce';
import { query } from './db';
import { HttpError } from './http';
export type SfGroup = {
  Id: string;
  Name: string;
  Type: string;
  RelatedId: string | null;
};
type Member = { GroupId: string; UserOrGroupId: string };
type SfUser = { Id: string; UserRoleId: string | null };
type SfRole = { Id: string; ParentRoleId: string | null };
export function resolveMembers(
  root: string,
  groups: SfGroup[],
  members: Member[],
  users: SfUser[],
  roles: SfRole[],
) {
  const visited = new Set<string>(),
    result = new Set<string>();
  function visit(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    if (id.startsWith('005')) {
      if (users.some((u) => u.Id === id)) result.add(id);
      return;
    }
    const group = groups.find((g) => g.Id === id);
    if (!group)
      throw new HttpError(
        422,
        'A Salesforce group could not be resolved. No service access was changed.',
      );
    if (['Regular', 'Queue'].includes(group.Type)) {
      for (const member of members.filter((m) => m.GroupId === id))
        visit(member.UserOrGroupId);
      return;
    }
    if (group.Type === 'Organization') {
      for (const user of users) result.add(user.Id);
      return;
    }
    if (
      ['Role', 'RoleAndSubordinates', 'RoleAndSubordinatesInternal'].includes(
        group.Type,
      ) &&
      group.RelatedId
    ) {
      const selected = new Set([group.RelatedId]);
      if (group.Type !== 'Role') {
        let changed = true;
        while (changed) {
          changed = false;
          for (const role of roles)
            if (
              role.ParentRoleId &&
              selected.has(role.ParentRoleId) &&
              !selected.has(role.Id)
            ) {
              selected.add(role.Id);
              changed = true;
            }
        }
      }
      for (const user of users)
        if (user.UserRoleId && selected.has(user.UserRoleId))
          result.add(user.Id);
      return;
    }
    throw new HttpError(
      422,
      `The selected group includes unsupported ${group.Type} membership. Use a Salesforce user/role group or map members individually.`,
    );
  }
  visit(root);
  return [...result];
}
export async function listServiceGroups() {
  const [groups, mappings] = await Promise.all([
    sfQuery<SfGroup>(
      "SELECT Id,Name,Type,RelatedId FROM Group WHERE Type IN ('Regular','Queue') ORDER BY Name",
    ),
    query('SELECT * FROM qms.service_groups ORDER BY service_id'),
  ]);
  return {
    groups: groups.map((g) => ({ id: g.Id, name: g.Name, type: g.Type })),
    mappings,
  };
}
export async function syncServiceGroup(
  serviceId: string,
  groupId: string,
  actor: string,
) {
  const [groups, members, users, roles] = await Promise.all([
    sfQuery<SfGroup>('SELECT Id,Name,Type,RelatedId FROM Group'),
    sfQuery<Member>('SELECT GroupId,UserOrGroupId FROM GroupMember'),
    sfQuery<SfUser>(
      "SELECT Id,UserRoleId FROM User WHERE IsActive=true AND UserType='Standard'",
    ),
    sfQuery<SfRole>('SELECT Id,ParentRoleId FROM UserRole'),
  ]);
  const group = groups.find(
    (g) => g.Id === groupId && ['Regular', 'Queue'].includes(g.Type),
  );
  if (!group)
    throw new HttpError(
      400,
      'Select an existing Salesforce queue or public group.',
    );
  const userIds = resolveMembers(groupId, groups, members, users, roles);
  if (!userIds.length)
    throw new HttpError(
      409,
      'This Salesforce group has no active staff. No service access was changed.',
    );
  await syncDirectory();
  const [result] = await query<{ members: number }>(
    'SELECT qms.sync_service_group($1,$2,$3,$4,$5) members',
    [serviceId, groupId, group.Name, userIds, actor],
  );
  return result;
}
