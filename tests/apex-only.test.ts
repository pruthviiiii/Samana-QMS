import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sfRequest } from '../lib/salesforce';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx|mjs)$/.test(entry)) out.push(path);
  }
  return out;
}

// The Salesforce integration user holds API access and Apex class access only.
// Any direct object or query call would fail in production, so none may exist.
describe('Salesforce access is Apex-only', () => {
  const files = [
    ...sourceFiles('lib'),
    ...sourceFiles('app'),
    ...sourceFiles('scripts'),
  ];
  it('no server code builds a direct data, query or sobject URL', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/services\/data\//);
      expect(text, file).not.toMatch(/\/query\?q=/);
      expect(text, file).not.toMatch(/\/sobjects\//);
    }
  });
  it('no server code writes SOQL against Salesforce objects', () => {
    const soql =
      /\bSELECT\s+[\w,.\s]+\s+FROM\s+(Account|Contact|User|Group|GroupMember|UserRole|Customer_Unit__c|Calling_List__c|Sales_Booking__c|Project__c)\b/;
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(soql);
    }
  });
  it('sfRequest refuses paths outside the Apex REST prefix', async () => {
    for (const path of [
      '/services/data/v67.0/limits',
      '/services/oauth2/userinfo',
      '/services/apexrest/other/Thing',
      'https://evil.example/services/apexrest/api/AccountLookupAPI',
    ]) {
      await expect(sfRequest(path)).rejects.toThrow('Invalid Salesforce path.');
    }
  });
});
