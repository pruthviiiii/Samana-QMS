// Split migration SQL without splitting procedural bodies, quoted values or comments.
export function splitStatements(text) {
  const output = [];
  let start = 0,
    quote = null,
    dollar = null,
    line = false,
    block = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i],
      n = text[i + 1];
    if (line) {
      if (c === '\n') line = false;
      continue;
    }
    if (block) {
      if (c === '*' && n === '/') {
        block = false;
        i++;
      }
      continue;
    }
    if (dollar) {
      if (text.startsWith(dollar, i)) {
        i += dollar.length - 1;
        dollar = null;
      }
      continue;
    }
    if (quote) {
      if (c === quote) {
        if (n === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (c === '-' && n === '-') {
      line = true;
      i++;
      continue;
    }
    if (c === '/' && n === '*') {
      block = true;
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === '$') {
      const match = text.slice(i).match(/^\$(?:[A-Za-z_][\w]*)?\$/);
      if (match) {
        dollar = match[0];
        i += dollar.length - 1;
        continue;
      }
    }
    if (c === ';') {
      const statement = text.slice(start, i).trim();
      if (statement) output.push(statement);
      start = i + 1;
    }
  }
  if (quote || dollar || block)
    throw new Error('Unclosed SQL literal or comment.');
  const tail = text.slice(start).trim();
  if (tail) output.push(tail);
  return output;
}
// Only numbered migration files are applied; db/schema.sql is the generated
// snapshot that lives beside them and must never be run.
export const migrationFile = /^[0-9]{3}_[a-z0-9_]+[.]sql$/;
