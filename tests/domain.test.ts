import { describe, it, expect } from 'vitest';
import { normalizeIdentifier, nationalMobile, csvCell } from '@qms/shared';
import { hashPassword, verifyPassword, needsRehash } from '@backend/security';
import { mobileVariants, normalizeLookup } from '@backend/salesforce';
import { migrationFile, splitStatements } from '../scripts/sql.mjs';
describe('Password work factor', () => {
  it('hashes at the current work factor and flags older hashes', async () => {
    const current = await hashPassword('A-strong-test-password');
    expect(current.startsWith('pbkdf2$600000$')).toBe(true);
    expect(needsRehash(current)).toBe(false);
    const legacy = await hashPassword('A-strong-test-password', 'salt', 100000);
    expect(needsRehash(legacy)).toBe(true);
    expect(await verifyPassword('A-strong-test-password', legacy)).toBe(true);
  });
});
describe('Customer identifiers', () => {
  // Salesforce keeps the country code in its own field and matches on the
  // national number, so every way a customer writes one phone must reduce to
  // the same string. Getting this wrong means one person checking in twice
  // looks like two strangers, and a registered customer looks like a walk-in.
  it.each([
    '529548924',
    '0529548924',
    '971529548924',
    '00971529548924',
    '+971 52 954 8924',
    '+971 (52) 954-8924',
    '971-52-954-8924',
  ])('reads %s as the same phone', (typed) =>
    expect(normalizeIdentifier('mobile', typed)).toBe('529548924'),
  );
  it('keeps a number that carries no country code as it is', () =>
    expect(nationalMobile('9876543210')).toBe('9876543210'));
  it.each(['123', '+971abc', '971501234567890123456'])(
    'rejects invalid mobile %s',
    (value) => expect(() => normalizeIdentifier('mobile', value)).toThrow(),
  );
  // The Apex matches Mobile_Number__c exactly, so the lookup offers the forms
  // the data is actually stored in. POD2 holds mostly the bare national
  // number, some with the UAE code, some with the trunk zero.
  it('offers the stored shapes of a UAE number, most likely first', () =>
    expect(mobileVariants('529548924')).toEqual([
      '529548924',
      '0529548924',
      '971529548924',
    ]));
  it('adds tail forms only when the number could carry a country code', () => {
    // Ten digits is already a national number somewhere; slicing it would only
    // buy a wasted request.
    expect(mobileVariants('9876543210')).toEqual([
      '9876543210',
      '09876543210',
      '9719876543210',
    ]);
    // Twelve digits looks like a country code in front of one.
    expect(mobileVariants('919876543210')).toContain('9876543210');
  });
  it('accepts required Emirates ID format', () =>
    expect(normalizeIdentifier('emiratesId', '784-2000-1234567-1')).toBe(
      '784-2000-1234567-1',
    ));
  it.each(['784200012345671', '785-2000-1234567-1', '784-123-1234567-1'])(
    'rejects invalid Emirates ID %s',
    (value) => expect(() => normalizeIdentifier('emiratesId', value)).toThrow(),
  );
  it('normalizes passport case', () =>
    expect(normalizeIdentifier('passportNumber', ' ab12345 ')).toBe('AB12345'));
  it('rejects passport injection', () =>
    expect(() => normalizeIdentifier('passportNumber', "a' OR 1=1")).toThrow());
});
describe('Salesforce contract', () => {
  const account = {
    id: '001000000000001AAA',
    name: 'Synthetic Test Customer',
    phoneNumber: '971500000001',
    units: [
      {
        customerUnitId: 'a01000000000001AAA',
        unitNumber: '101',
        salesBookingReference: 'SB-TEST',
      },
    ],
  };
  const payload = {
    isSuccess: true,
    statusCode: 200,
    TotalRecords: 1,
    accounts: [account],
  };
  it('normalizes real API wrapper and units', () => {
    const c = normalizeLookup(payload);
    expect(c.registered).toBe(true);
    expect(c.units[0].id).toBe('a01000000000001AAA');
    expect(c.units[0].bookingNumber).toBe('SB-TEST');
  });
  it('uses the first matching account', () =>
    expect(
      normalizeLookup({
        ...payload,
        accounts: [account, { ...account, id: '001000000000002AAA' }],
      }).salesforceId,
    ).toBe(account.id));
  it('represents zero units without inventing one', () =>
    expect(
      normalizeLookup({ ...payload, accounts: [{ ...account, units: [] }] })
        .units,
    ).toEqual([]));
  it('maps Apex-provided names, project, agents and calling owners', () => {
    const unit = {
      ...account.units[0],
      projectName: 'Project A',
      collectionAgentId: '005000000000001AAA',
      collectionAgentManagerId: '005000000000002AAA',
      callingOwners: [
        {
          department: 'CRM',
          ownerId: '005000000000003AAA',
          ownerManagerId: '005000000000002AAA',
        },
        { department: 'Resale', ownerId: null, ownerManagerId: null },
      ],
    };
    const c = normalizeLookup({
      ...payload,
      accounts: [
        {
          ...account,
          firstName: 'Synthetic',
          middleName: 'Test',
          lastName: 'Customer',
          units: [unit],
        },
      ],
    });
    expect([c.firstName, c.middleName, c.lastName]).toEqual([
      'Synthetic',
      'Test',
      'Customer',
    ]);
    const u = c.units[0];
    expect(u.project).toBe('Project A');
    expect(u.ownerId).toBe('005000000000001AAA');
    expect(u.managerId).toBe('005000000000002AAA');
    const crm = { ownerId: '005000000000003AAA', managerId: '005000000000002AAA' };
    expect(u.owners?.['crm-general']).toEqual(crm);
    expect(u.owners?.['crm-refund']).toEqual(crm);
    expect(u.owners?.['crm-handover']).toEqual(crm);
    expect(u.owners?.['crm-noc']).toEqual({ ownerId: null, managerId: null });
  });
  it('drops owner ids that are not Salesforce user ids', () => {
    const c = normalizeLookup({
      ...payload,
      accounts: [
        {
          ...account,
          units: [
            {
              ...account.units[0],
              collectionAgentId: '00G000000000001AAA',
              callingOwners: [{ department: 'CRM', ownerId: 'queue', ownerManagerId: 'x' }],
            },
          ],
        },
      ],
    });
    expect(c.units[0].ownerId).toBeNull();
    expect(c.units[0].owners?.['crm-general']).toEqual({ ownerId: null, managerId: null });
    expect(c.units[0].project).toBe('Project unavailable');
  });
  it('valid no-match is a guest', () =>
    expect(
      normalizeLookup({ ...payload, TotalRecords: 0, accounts: [] }).registered,
    ).toBe(false));
  it.each([
    { isSuccess: false, statusCode: 500, TotalRecords: 0, accounts: [] },
    {},
    { accounts: [] },
    { ...payload, accounts: [{ id: 'bad', name: 'Bad', units: [] }] },
  ])('never turns malformed/provider-error responses into guests', (value) =>
    expect(() => normalizeLookup(value)).toThrow(),
  );
});
// The ticket lifecycle and SMS eligibility are enforced by the database
// functions, and tests/workflow.test.ts exercises them there. The TypeScript
// copies of those rules were removed rather than left as a second, silent
// definition that nothing called.
describe('Exports', () => {
  it.each(['=HYPERLINK("evil")', '+SUM(A1)', '-1+1', '@cmd', '\tformula'])(
    'neutralizes spreadsheet formula %s',
    (value) => expect(csvCell(value).startsWith('"\'')).toBe(true),
  );
  it('escapes quotes and preserves commas/newlines', () =>
    expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"'));
});
describe('Password security and SQL migration parsing', () => {
  it('hashes with unique salts and verifies without plaintext storage', async () => {
    const first = await hashPassword('A-strong-test-password');
    const second = await hashPassword('A-strong-test-password');
    expect(first).not.toBe(second);
    expect(first).not.toContain('strong');
    expect(await verifyPassword('A-strong-test-password', first)).toBe(true);
    expect(await verifyPassword('wrong', first)).toBe(false);
  });
  it('rejects invalid hashes', async () =>
    expect(await verifyPassword('password', 'plain-password')).toBe(false));
  it.each(['NaN', 'Infinity', '100000.5', '0', '1000001'])(
    'rejects invalid password work factor %s',
    async (iterations) =>
      expect(
        await verifyPassword('password', `pbkdf2$${iterations}$salt$hash`),
      ).toBe(false),
  );
  it('keeps procedural SQL bodies intact', () =>
    expect(
      splitStatements(
        "SELECT ';'; CREATE FUNCTION x() RETURNS void AS $$ BEGIN RAISE NOTICE ';'; END $$ LANGUAGE plpgsql; -- trailing\n SELECT 1;",
      ),
    ).toHaveLength(3));
  it('rejects broken migration literals', () =>
    expect(() => splitStatements("SELECT 'unterminated")).toThrow());
  it('applies only numbered migration files, never the schema snapshot', () => {
    expect(migrationFile.test('014_rollover_retention_and_numbers.sql')).toBe(true);
    expect(migrationFile.test('schema.sql')).toBe(false);
    expect(migrationFile.test('015_notes.sql.bak')).toBe(false);
    expect(migrationFile.test('README.md')).toBe(false);
  });
});
