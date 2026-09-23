// One error type for everything the API answers with, and one table that turns
// a database rule violation into a status and a sentence a person at the desk
// can act on.
//
// Identity is a field, never a substring of a sentence: `HttpError.code` and
// the PostgreSQL SQLSTATE decide the response, so rewording a message can
// never change a status code, and a customer's note that happens to contain
// the word FORBIDDEN can never be mistaken for a rule violation.
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** PostgreSQL raises application rules with RAISE EXCEPTION, SQLSTATE P0001. */
const RAISE_EXCEPTION = 'P0001';

/** Rule codes the database raises, with the status and wording for the caller. */
export const RULE_MESSAGES: Record<string, [number, string]> = {
  TICKET_NOT_FOUND: [404, 'That ticket no longer exists.'],
  LOOKUP_EXPIRED: [
    409,
    'The customer lookup has expired. Look the customer up again.',
  ],
  UNIT_REQUIRED: [400, 'Choose the unit this visit is about.'],
  INVALID_SERVICE: [400, 'That service is not available for this customer.'],
  VERSION_CONFLICT: [
    409,
    'This ticket was just updated by someone else. It has been refreshed; please try again.',
  ],
  INVALID_TRANSITION: [
    409,
    "That action is not possible in the ticket's current state.",
  ],
  AGENT_BUSY: [409, 'That team member is already with a customer.'],
  FORBIDDEN: [403, 'You do not have permission for this action.'],
  AGENT_UNAVAILABLE: [409, 'Go online before calling a customer.'],
  INVALID_ASSIGNEE: [
    400,
    'Choose a team member who is online and covers this service.',
  ],
  DUPLICATE_VISIT: [
    409,
    'This customer already has an open ticket for this service.',
  ],
  IDEMPOTENCY_CONFLICT: [
    409,
    'This request was already used for a different ticket. Start again.',
  ],
  UNIT_NOT_ALLOWED: [400, 'A unit cannot be attached to this visit.'],
  USER_NOT_FOUND: [404, 'That team member was not found.'],
  PASSWORD_REQUIRED: [400, 'Set a temporary password for a new member.'],
};

/**
 * Turns a database error into an HttpError when it is one of our rules.
 * Anything else (a syntax error, a constraint violation, a dropped connection)
 * is left alone so it is reported as an unexpected failure and investigated.
 */
export function ruleError(error: unknown): HttpError | null {
  if (
    !error ||
    typeof error !== 'object' ||
    (error as { code?: unknown }).code !== RAISE_EXCEPTION
  )
    return null;
  const raw = (error as { message?: unknown }).message;
  const message = typeof raw === 'string' ? raw.trim() : '';
  const rule = RULE_MESSAGES[message];
  if (!rule) return null;
  return new HttpError(rule[0], rule[1], message);
}
