import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CheckIn from '../../components/qms/check-in';
import type { Customer, Ticket } from '../../lib/domain';
// The check-in screen is what a customer or receptionist sees first. These
// tests drive it the way a person would: pick how to identify, type a value,
// look the account up, and read what comes back. The network is a mock, so
// each test states exactly what the server answered.
type Reply = { status: number; body: unknown };
function answer(...replies: Reply[]) {
  const calls: { path: string; body: unknown }[] = [];
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    calls.push({
      path: input,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const reply = replies.shift() ?? { status: 500, body: { error: 'No reply' } };
    return {
      ok: reply.status < 400,
      status: reply.status,
      json: async () => reply.body,
    } as Response;
  });
  vi.stubGlobal('fetch', fetch);
  return calls;
}
const registered: Customer = {
  registered: true,
  salesforceId: '001000000000001AAA',
  firstName: 'Ayesha',
  middleName: '',
  lastName: 'Test',
  name: 'Ayesha Test',
  mobile: '971500000001',
  emiratesId: null,
  passportNumber: null,
  units: [
    {
      id: 'a01000000000001AAA',
      name: 'A-1204',
      project: 'Project A',
      bookingNumber: 'SB-1',
      ownerId: null,
      ownerName: null,
      managerId: null,
      managerName: null,
    },
  ],
};
const lookupOf = (customer: Customer) => ({
  status: 200,
  body: {
    lookupId: crypto.randomUUID(),
    customer,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  },
});
const identifier = () =>
  document.getElementById('identifier') as HTMLInputElement;
const submit = () =>
  document.querySelector('form button[type="submit"]') as HTMLButtonElement;
describe('Check-in', () => {
  it('starts on mobile, switches identifier type and clears the field', async () => {
    const user = userEvent.setup();
    render(<CheckIn />);
    const [mobile, emiratesId, passport] = Array.from(
      document.querySelectorAll('.identity-option'),
    ) as HTMLButtonElement[];
    expect(mobile.getAttribute('aria-pressed')).toBe('true');
    // No country code in the placeholder: the number Salesforce matches on is
    // the national one, and showing 971 taught customers to type a prefix the
    // lookup then had to undo.
    expect(identifier().placeholder).toBe('0501234567');
    expect(identifier().placeholder).not.toContain('971');
    await user.type(identifier(), '0501234567');
    await user.click(emiratesId);
    expect(emiratesId.getAttribute('aria-pressed')).toBe('true');
    expect(identifier().value).toBe('');
    expect(identifier().placeholder).toBe('784-XXXX-XXXXXXX-X');
    await user.click(passport);
    expect(identifier().maxLength).toBe(25);
  });
  it('will not search with an empty value', () => {
    render(<CheckIn />);
    expect(submit().disabled).toBe(true);
  });
  it('sends the identifier to the lookup and shows the account it finds', async () => {
    const user = userEvent.setup();
    const calls = answer(lookupOf(registered));
    render(<CheckIn />);
    await user.type(identifier(), '971500000001');
    await user.click(submit());
    await waitFor(() => expect(screen.getByText('Ayesha Test')).toBeTruthy());
    expect(calls[0].path).toBe('/api/customers/lookup');
    expect(calls[0].body).toEqual({ type: 'mobile', value: '971500000001' });
    expect(screen.getByText('1 linked units')).toBeTruthy();
  });
  it('shows the server message on failure and offers nothing else to a customer', async () => {
    const user = userEvent.setup();
    answer({ status: 502, body: { error: 'Salesforce is temporarily unreachable.' } });
    render(<CheckIn />);
    await user.type(identifier(), '971500000001');
    await user.click(submit());
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('temporarily unreachable'),
    );
    expect(screen.queryByText('Register walk-in visit')).toBeNull();
  });
  it('offers reception a walk-in when Salesforce is down, and registers it', async () => {
    const user = userEvent.setup();
    const walkIn: Customer = {
      ...registered,
      registered: false,
      salesforceId: null,
      name: 'Walk-in customer',
      units: [],
    };
    const calls = answer(
      { status: 503, body: { error: 'Salesforce is paused.' } },
      lookupOf(walkIn),
    );
    render(<CheckIn allowWalkIn />);
    await user.type(identifier(), '971500000009');
    await user.click(submit());
    const button = await screen.findByText('Register walk-in visit');
    await user.click(button);
    await waitFor(() =>
      expect(screen.getByText('Welcome, walk-in guest')).toBeTruthy(),
    );
    expect(calls[1].body).toEqual({
      type: 'mobile',
      value: '971500000009',
      walkIn: true,
    });
  });
  it('issues a ticket for the found account and reports it to the caller', async () => {
    const user = userEvent.setup();
    const onIssued = vi.fn();
    const issued = {
      id: crypto.randomUUID(),
      number: 'C-007',
      service_name: 'General Query',
      project_name: 'Project A',
      unit_name: 'A-1204',
    } as Ticket;
    const calls = answer(lookupOf(registered), { status: 201, body: issued });
    render(<CheckIn onIssued={onIssued} />);
    await user.type(identifier(), '971500000001');
    await user.click(submit());
    await screen.findByText('Ayesha Test');
    await user.click(screen.getByRole('button', { name: /Issue ticket/i }));
    await waitFor(() => expect(screen.getByText('C-007')).toBeTruthy());
    expect(onIssued).toHaveBeenCalledWith(issued);
    expect(calls[1].path).toBe('/api/tickets');
    expect(calls[1].body).toMatchObject({
      serviceId: 'crm-general',
      unitId: 'a01000000000001AAA',
    });
    expect(typeof (calls[1].body as { requestId: string }).requestId).toBe('string');
  });
  it('switches the whole page to Arabic and right-to-left, and remembers it', async () => {
    const user = userEvent.setup();
    render(<CheckIn fullPage />);
    await user.click(screen.getByRole('button', { name: 'العربية' }));
    const section = document.querySelector('section.checkin') as HTMLElement;
    expect(section.getAttribute('dir')).toBe('rtl');
    expect(section.getAttribute('lang')).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(localStorage.getItem('qms-lang')).toBe('ar');
    expect(screen.getByText('أهلاً بكم في سمانا')).toBeTruthy();
  });
});
