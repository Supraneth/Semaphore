/**
 * A YAML reader for the subset a Lovelace card config is written in.
 *
 * The card ships a writer and no reader, because it never had to read one back.
 * The standalone editor does: a plan that cannot be re-opened is a plan you can
 * only ever build once, and the config the user already has in Home Assistant
 * is the most useful starting point there is.
 *
 * The subset is deliberate — block maps, block sequences, flow sequences, flow
 * maps, quoted and plain scalars, comments. No anchors, no tags, no multi-line
 * block scalars, no multiple documents. Anything outside it throws with a line
 * number rather than parsing to something plausible and wrong, which is the
 * failure mode that costs an afternoon.
 */

export class YamlError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`ligne ${line} : ${message}`);
    this.name = 'YamlError';
  }
}

interface Line {
  indent: number;
  text: string;
  no: number;
}

export function parseYaml(source: string): unknown {
  const lines = scan(source);
  if (!lines.length) return null;
  const [value, next] = parseBlock(lines, 0, lines[0].indent);
  if (next < lines.length) {
    throw new YamlError(
      `indentation inattendue — « ${lines[next].text} » ne se rattache à rien.`,
      lines[next].no,
    );
  }
  return value;
}

// ---- lexing ---------------------------------------------------------------

function scan(source: string): Line[] {
  const out: Line[] = [];
  source.split(/\r?\n/).forEach((raw, index) => {
    const no = index + 1;
    if (/^\s*\t/.test(raw)) {
      throw new YamlError(
        'indentation avec une tabulation. YAML n’accepte que des espaces.',
        no,
      );
    }
    const body = stripComment(raw);
    const text = body.trim();
    // Document markers are noise here: there is only ever one document.
    if (!text || text === '---' || text === '...') return;
    out.push({ indent: body.length - body.trimStart().length, text, no });
  });
  return out;
}

/** Drops a trailing comment, ignoring `#` inside quotes or inside a word. */
function stripComment(raw: string): string {
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (quote === '"' && c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(raw[i - 1]))) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

// ---- block structure ------------------------------------------------------

function parseBlock(lines: Line[], i: number, indent: number): [unknown, number] {
  const { text } = lines[i];
  if (isItem(text)) return parseSeq(lines, i, indent);
  if (splitEntry(text)) return parseMap(lines, i, indent);
  // A block that is neither: a lone scalar standing in for a value.
  return [parseValue(text, lines[i].no), i + 1];
}

const isItem = (text: string): boolean => text === '-' || text.startsWith('- ');

function parseSeq(lines: Line[], i: number, indent: number): [unknown[], number] {
  const out: unknown[] = [];
  while (i < lines.length && lines[i].indent === indent && isItem(lines[i].text)) {
    const line = lines[i];
    const rest = line.text.slice(1).trimStart();

    if (!rest) {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const [value, next] = parseBlock(lines, i + 1, lines[i + 1].indent);
        out.push(value);
        i = next;
      } else {
        out.push(null);
        i++;
      }
      continue;
    }

    // `- id: rdc` is a mapping whose first key happens to share the dash's
    // line. Re-indenting that line to where its value actually starts lets the
    // ordinary map parser pick up the sibling keys below it, with no second
    // code path for "first key of an item".
    const childIndent = indent + (line.text.length - rest.length);
    lines[i] = { indent: childIndent, text: rest, no: line.no };
    const [value, next] = parseBlock(lines, i, childIndent);
    out.push(value);
    i = next;
  }
  return [out, i];
}

function parseMap(lines: Line[], i: number, indent: number): [Record<string, unknown>, number] {
  const out: Record<string, unknown> = {};
  while (i < lines.length && lines[i].indent === indent) {
    const line = lines[i];
    if (isItem(line.text)) break;

    const entry = splitEntry(line.text);
    if (!entry) {
      throw new YamlError(`« ${line.text} » n’est pas de la forme « clé: valeur ».`, line.no);
    }
    if (entry.key in out) {
      throw new YamlError(`la clé « ${entry.key} » est définie deux fois.`, line.no);
    }

    if (entry.rest) {
      out[entry.key] = parseValue(entry.rest, line.no);
      i++;
      continue;
    }

    const next = lines[i + 1];
    if (next && next.indent > indent) {
      const [value, after] = parseBlock(lines, i + 1, next.indent);
      out[entry.key] = value;
      i = after;
    } else if (next && next.indent === indent && isItem(next.text)) {
      // A sequence written flush with its key. Legal YAML, and the shape most
      // people type by hand.
      const [value, after] = parseSeq(lines, i + 1, indent);
      out[entry.key] = value;
      i = after;
    } else {
      out[entry.key] = null;
      i++;
    }
  }
  return [out, i];
}

/** Splits `key: rest`, honouring quoted keys. Returns null if there is no key. */
function splitEntry(text: string): { key: string; rest: string } | null {
  if (text[0] === '"' || text[0] === "'") {
    const quote = text[0];
    let i = 1;
    while (i < text.length && text[i] !== quote) {
      if (quote === '"' && text[i] === '\\') i++;
      i++;
    }
    if (i >= text.length) return null;
    const after = text.slice(i + 1).trimStart();
    if (after[0] !== ':') return null;
    return { key: unquote(text.slice(0, i + 1)), rest: after.slice(1).trim() };
  }

  // The first colon that ends a word. `http://x` is therefore a value, not a
  // key, and `[0.1, 0.5]` never looks like one.
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ':' && (i + 1 === text.length || /\s/.test(text[i + 1]))) {
      const key = text.slice(0, i).trim();
      if (!key || key.includes('[') || key.includes('{')) return null;
      return { key, rest: text.slice(i + 1).trim() };
    }
  }
  return null;
}

// ---- scalars and flow collections -----------------------------------------

function parseValue(text: string, line: number): unknown {
  const t = text.trim();
  if (t[0] === '[' || t[0] === '{') {
    const [value, end] = parseFlow(t, 0, line);
    if (t.slice(end).trim()) {
      throw new YamlError(`caractères en trop après « ${t.slice(0, end)} ».`, line);
    }
    return value;
  }
  return parseAtom(t, line);
}

function parseFlow(s: string, i: number, line: number): [unknown, number] {
  i = skipSpace(s, i);
  if (s[i] === '[') return parseFlowSeq(s, i, line);
  if (s[i] === '{') return parseFlowMap(s, i, line);

  // A bare atom inside a flow collection ends at the next structural character.
  const start = i;
  if (s[i] === '"' || s[i] === "'") {
    const quote = s[i++];
    while (i < s.length && s[i] !== quote) {
      if (quote === '"' && s[i] === '\\') i++;
      i++;
    }
    if (i >= s.length) throw new YamlError('guillemet non fermé.', line);
    i++;
    return [unquote(s.slice(start, i)), i];
  }
  while (i < s.length && !',]}:'.includes(s[i])) i++;
  return [parseAtom(s.slice(start, i).trim(), line), i];
}

function parseFlowSeq(s: string, i: number, line: number): [unknown[], number] {
  const out: unknown[] = [];
  i = skipSpace(s, i + 1);
  if (s[i] === ']') return [out, i + 1];
  for (;;) {
    const [value, next] = parseFlow(s, i, line);
    out.push(value);
    i = skipSpace(s, next);
    if (s[i] === ',') {
      i = skipSpace(s, i + 1);
      // A trailing comma before the bracket is common enough to forgive.
      if (s[i] === ']') return [out, i + 1];
      continue;
    }
    if (s[i] === ']') return [out, i + 1];
    throw new YamlError(`« , » ou « ] » attendu dans ${s}.`, line);
  }
}

function parseFlowMap(s: string, i: number, line: number): [Record<string, unknown>, number] {
  const out: Record<string, unknown> = {};
  i = skipSpace(s, i + 1);
  if (s[i] === '}') return [out, i + 1];
  for (;;) {
    const [key, afterKey] = parseFlow(s, i, line);
    i = skipSpace(s, afterKey);
    if (s[i] !== ':') throw new YamlError(`« : » attendu dans ${s}.`, line);
    const [value, afterValue] = parseFlow(s, i + 1, line);
    out[String(key)] = value;
    i = skipSpace(s, afterValue);
    if (s[i] === ',') {
      i = skipSpace(s, i + 1);
      if (s[i] === '}') return [out, i + 1];
      continue;
    }
    if (s[i] === '}') return [out, i + 1];
    throw new YamlError(`« , » ou « } » attendu dans ${s}.`, line);
  }
}

const skipSpace = (s: string, i: number): number => {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
};

const NULLS = new Set(['', '~', 'null', 'Null', 'NULL']);
const TRUES = new Set(['true', 'yes', 'on']);
const FALSES = new Set(['false', 'no', 'off']);
const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

function parseAtom(t: string, line: number): unknown {
  if (NULLS.has(t)) return null;
  if (t[0] === '"' || t[0] === "'") {
    if (t.length < 2 || t[t.length - 1] !== t[0]) throw new YamlError('guillemet non fermé.', line);
    return unquote(t);
  }
  // Home Assistant reads YAML 1.1, where `no` is a boolean and not the word.
  const lower = t.toLowerCase();
  if (TRUES.has(lower)) return true;
  if (FALSES.has(lower)) return false;
  if (NUMBER.test(t)) return Number(t);
  if (t[0] === '&' || t[0] === '*' || t.startsWith('!!')) {
    throw new YamlError(`« ${t} » : ancres et tags ne sont pas gérés ici.`, line);
  }
  if (t === '|' || t === '>') {
    throw new YamlError('les blocs littéraux ne sont pas gérés ici.', line);
  }
  return t;
}

const ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  '0': '\0',
  '"': '"',
  '\\': '\\',
  '/': '/',
};

function unquote(t: string): string {
  const quote = t[0];
  const body = t.slice(1, -1);
  if (quote === "'") return body.replace(/''/g, "'");
  return body.replace(/\\u([0-9a-fA-F]{4})|\\(.)/g, (_, hex: string, char: string) =>
    hex ? String.fromCharCode(parseInt(hex, 16)) : (ESCAPES[char] ?? char),
  );
}
