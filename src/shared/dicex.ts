/**
 * Small formulas with dice in them, so that a rules pack can say how a figure is worked out:
 * "2D-7", "D3+D3", "5*(1D+1)", "BASE + (2D-7)/20", "sqrt(L)", "max(1, N)".
 *
 * Dice are written nD or nDs (2D, D3, d10, 3D6); a bare D is one six-sided die. Names stand for
 * values passed in. Operators are + - * / ^ with the usual precedence, and the functions min, max,
 * floor, ceil, round, abs, sqrt, ln and pow are available. Comparisons (< <= > >= == !=) and the
 * words and, or, not give 1 for true and 0 for false, for conditions such as "worlds < 4 and stars > 1".
 */
import type { Rng } from './util';

export type Vars = Record<string, number>;
type Node = (vars: Vars, rng: Rng) => number;

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  min: Math.min,
  max: Math.max,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  abs: Math.abs,
  sqrt: Math.sqrt,
  ln: Math.log,
  pow: Math.pow,
};

interface Token {
  kind: 'num' | 'dice' | 'name' | 'op';
  text: string;
  value?: number;
  count?: number;
  sides?: number;
}

function tokenise(source: string): Token[] {
  const out: Token[] = [];
  const re = /\s*(?:(\d*)[dD](\d*)(?![A-Za-z_.])|(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_.]*)|(<=|>=|==|!=|[-+*/^(),×<>]))/y;
  let at = 0;
  while (at < source.length) {
    if (/^\s*$/.test(source.slice(at))) break;
    re.lastIndex = at;
    const m = re.exec(source);
    if (!m) throw new Error(`Cannot read the formula "${source}" at "${source.slice(at, at + 12)}"`);
    at = re.lastIndex;
    if (m[3] !== undefined) out.push({ kind: 'num', text: m[3], value: Number(m[3]) });
    else if (m[4] !== undefined) {
      // "x" between two figures is a multiplication sign; "and", "or" and "not" are operators
      if (/^x$/i.test(m[4])) out.push({ kind: 'op', text: '*' });
      else if (/^(and|or|not)$/i.test(m[4])) out.push({ kind: 'op', text: m[4].toLowerCase() });
      else out.push({ kind: 'name', text: m[4] });
    }
    else if (m[5] !== undefined) out.push({ kind: 'op', text: m[5] === '×' || m[5] === 'x' ? '*' : m[5] });
    else out.push({ kind: 'dice', text: m[0].trim(), count: m[1] ? Number(m[1]) : 1, sides: m[2] ? Number(m[2]) : 6 });
  }
  return out;
}

function parse(source: string): Node {
  const tokens = tokenise(source);
  let i = 0;
  const peek = () => tokens[i];
  const isOp = (text: string) => peek()?.kind === 'op' && peek()!.text === text;
  const fail = (what: string): never => {
    throw new Error(`${what} in the formula "${source}"`);
  };

  const atom = (): Node => {
    const t = tokens[i++];
    if (!t) return fail('Something is missing');
    if (t.kind === 'num') return () => t.value!;
    if (t.kind === 'dice') {
      const { count, sides } = t as Required<Token>;
      return (_vars, rng) => {
        let total = 0;
        for (let n = 0; n < count; n++) total += 1 + Math.floor(rng() * sides);
        return total;
      };
    }
    if (t.kind === 'name') {
      if (isOp('(')) {
        i++;
        const fn = FUNCTIONS[t.text.toLowerCase()] ?? fail(`"${t.text}" is not a function`);
        const args: Node[] = [];
        if (!isOp(')')) {
          args.push(condition());
          while (isOp(',')) (i++, args.push(condition()));
        }
        if (!isOp(')')) fail('A bracket is not closed');
        i++;
        return (vars, rng) => fn(...args.map((a) => a(vars, rng)));
      }
      return (vars) => {
        const value = vars[t.text];
        if (value === undefined) throw new Error(`The formula "${source}" needs a value for ${t.text}`);
        return value;
      };
    }
    if (t.text === '(') {
      const inner = condition();
      if (!isOp(')')) fail('A bracket is not closed');
      i++;
      return inner;
    }
    return fail(`"${t.text}" is out of place`);
  };
  const power = (): Node => {
    const base = atom();
    if (!isOp('^')) return base;
    i++;
    const exponent = unary();
    return (vars, rng) => Math.pow(base(vars, rng), exponent(vars, rng));
  };
  const unary = (): Node => {
    if (isOp('-')) {
      i++;
      const inner = unary();
      return (vars, rng) => -inner(vars, rng);
    }
    if (isOp('+')) i++;
    return power();
  };
  const term = (): Node => {
    let left = unary();
    while (isOp('*') || isOp('/')) {
      const divide = tokens[i++].text === '/';
      const a = left;
      const b = unary();
      left = divide ? (vars, rng) => a(vars, rng) / b(vars, rng) : (vars, rng) => a(vars, rng) * b(vars, rng);
    }
    return left;
  };
  const expr = (): Node => {
    let left = term();
    while (isOp('+') || isOp('-')) {
      const minus = tokens[i++].text === '-';
      const a = left;
      const b = term();
      left = minus ? (vars, rng) => a(vars, rng) - b(vars, rng) : (vars, rng) => a(vars, rng) + b(vars, rng);
    }
    return left;
  };

  const COMPARE: Record<string, (a: number, b: number) => boolean> = {
    '<': (a, b) => a < b,
    '<=': (a, b) => a <= b,
    '>': (a, b) => a > b,
    '>=': (a, b) => a >= b,
    '==': (a, b) => a === b,
    '!=': (a, b) => a !== b,
  };
  const comparison = (): Node => {
    const left = expr();
    const test = peek()?.kind === 'op' ? COMPARE[peek()!.text] : undefined;
    if (!test) return left;
    i++;
    const right = expr();
    return (vars, rng) => (test(left(vars, rng), right(vars, rng)) ? 1 : 0);
  };
  const negation = (): Node => {
    if (!isOp('not')) return comparison();
    i++;
    const inner = negation();
    return (vars, rng) => (inner(vars, rng) ? 0 : 1);
  };
  const conjunction = (): Node => {
    let left = negation();
    while (isOp('and')) {
      i++;
      const a = left;
      const b = negation();
      left = (vars, rng) => (a(vars, rng) && b(vars, rng) ? 1 : 0);
    }
    return left;
  };
  const condition = (): Node => {
    let left = conjunction();
    while (isOp('or')) {
      i++;
      const a = left;
      const b = conjunction();
      left = (vars, rng) => (a(vars, rng) || b(vars, rng) ? 1 : 0);
    }
    return left;
  };

  const root = condition();
  if (i < tokens.length) fail(`"${tokens[i].text}" is out of place`);
  return root;
}

const cache = new Map<string, Node>();

/** Works out a formula. A plain number is returned as it is. */
export function evaluate(formula: string | number, rng: Rng, vars: Vars = {}): number {
  if (typeof formula === 'number') return formula;
  let node = cache.get(formula);
  if (!node) {
    node = parse(formula);
    cache.set(formula, node);
  }
  return node(vars, rng);
}

/** Checks a formula can be read, without working it out. Returns the problem, or nothing. */
export function formulaError(formula: string | number): string | undefined {
  if (typeof formula === 'number') return undefined;
  try {
    parse(formula);
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}
