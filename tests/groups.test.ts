import { describe, it, expect } from 'vitest';
import { resolveMembers, type SfGroup } from '../lib/salesforce-groups';
const group = (
  Id: string,
  Type = 'Regular',
  RelatedId: string | null = null,
): SfGroup => ({ Id, Name: Id, Type, RelatedId });
describe('Salesforce service-group membership', () => {
  it('resolves nested groups, cycles, duplicate users and inactive users', () => {
    expect(
      resolveMembers(
        'g1',
        [group('g1'), group('g2')],
        [
          { GroupId: 'g1', UserOrGroupId: 'g2' },
          { GroupId: 'g2', UserOrGroupId: 'g1' },
          { GroupId: 'g1', UserOrGroupId: '005a' },
          { GroupId: 'g2', UserOrGroupId: '005a' },
          { GroupId: 'g2', UserOrGroupId: '005inactive' },
        ],
        [{ Id: '005a', UserRoleId: null }],
        [],
      ),
    ).toEqual(['005a']);
  });
  it('includes internal subordinate roles for the configured role group', () => {
    expect(
      resolveMembers(
        'g',
        [group('g', 'RoleAndSubordinatesInternal', 'r1')],
        [],
        [
          { Id: '005a', UserRoleId: 'r1' },
          { Id: '005b', UserRoleId: 'r2' },
          { Id: '005c', UserRoleId: 'r3' },
        ],
        [
          { Id: 'r1', ParentRoleId: null },
          { Id: 'r2', ParentRoleId: 'r1' },
          { Id: 'r3', ParentRoleId: null },
        ],
      ),
    ).toEqual(['005a', '005b']);
  });
  it('keeps direct role membership separate from subordinates', () => {
    expect(
      resolveMembers(
        'g',
        [group('g', 'Role', 'r1')],
        [],
        [
          { Id: '005a', UserRoleId: 'r1' },
          { Id: '005b', UserRoleId: 'r2' },
        ],
        [{ Id: 'r2', ParentRoleId: 'r1' }],
      ),
    ).toEqual(['005a']);
  });
  it('rejects unsupported dynamic groups instead of silently dropping members', () =>
    expect(() =>
      resolveMembers('g', [group('g', 'Manager')], [], [], []),
    ).toThrow('unsupported'));
  it('rejects a missing group instead of granting incomplete service access', () =>
    expect(() => resolveMembers('g', [], [], [], [])).toThrow(
      'could not be resolved',
    ));
});
