const encoder = new TextEncoder();
export async function sha256(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', encoder.encode(value)),
    ),
  )
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}
export function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}
// Current work factor. Older hashes carry their own count and are re-hashed at
// the next successful sign-in (see needsRehash), so raising this is transparent.
export const PBKDF2_ITERATIONS = 600000;
export function needsRehash(hash: string) {
  const iterations = Number(hash.split('$')[1]);
  return !Number.isInteger(iterations) || iterations < PBKDF2_ITERATIONS;
}
export async function hashPassword(
  password: string,
  salt = randomToken(),
  iterations = PBKDF2_ITERATIONS,
) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const result = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations },
    key,
    256,
  );
  return `pbkdf2$${iterations}$${salt}$${Array.from(new Uint8Array(result))
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('')}`;
}
export async function verifyPassword(password: string, hash: string) {
  const [algorithm, iterationString, salt] = hash.split('$');
  const iterations = Number(iterationString);
  if (
    algorithm !== 'pbkdf2' ||
    !salt ||
    !Number.isInteger(iterations) ||
    iterations < 100000 ||
    iterations > 1000000
  )
    return false;
  const actual = await hashPassword(password, salt, iterations);
  if (actual.length !== hash.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++)
    diff |= actual.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}
