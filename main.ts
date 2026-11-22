// mend: one patch tool for every AI edit format. SPEC.md sections 1-10.
// Node 22+, standard library only. Run as `node main.ts [options] [PATCH]`.
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set and
// this file hands over to runner.ts (last lines below): keep that hand-over.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FMTS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class E2 extends Error {
  readonly line: string;
  constructor(line: string) { super(line); this.line = line; }
}
class Fail extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) { super(code); this.code = code; this.path = path; }
}

const blank = (s: string): boolean => s.trim() === '';
const trail = (s: string): string => s.replace(/[ \t]+$/, '');
const both = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const lead = (s: string): string => /^[ \t]*/.exec(s)![0];
const norm = (s: string, t: number): string => (t === 0 ? s : t === 1 ? trail(s) : both(s));

function patchLines(text: string): string[] {
  if (text === '') return [];
  const ls = text.split('\n');
  if (text.endsWith('\n')) ls.pop();
  return ls.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

interface F { br: string; ls: string[]; fin: boolean }
function parseFile(t: string): F {
  if (t === '') return { br: '\n', ls: [], fin: false };
  const i = t.indexOf('\n');
  const br = i > 0 && t[i - 1] === '\r' ? '\r\n' : '\n';
  const ls = t.split(br);
  const fin = t.endsWith(br);
  if (fin) ls.pop();
  return { br, ls, fin };
}
function serFile(f: F): string {
  return f.ls.length === 0 ? '' : f.ls.join(f.br) + (f.fin ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private orig = new Map<string, string | null>();
  now = new Map<string, string | null>();
  moves: [string, string][] = [];
  origOf(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try { if (statSync(p).isFile()) v = readFileSync(p, 'utf8'); } catch { v = null; }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null { return this.now.has(p) ? this.now.get(p)! : this.origOf(p); }
  set(p: string, v: string | null): void { this.now.set(p, v); }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** Positions where O occurs in ls at tier t (0 exact, 1 trailing-ws, 2 both-ends ws). */
function occs(O: string[], ls: string[], t: number): number[] {
  const r: number[] = [];
  for (let i = 0; i + O.length <= ls.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) if (norm(ls[i + j], t) !== norm(O[j], t)) { ok = false; break; }
    if (ok) r.push(i);
  }
  return r;
}
function tierOf(O: string[], ls: string[], strict: boolean, from = 0): { t: number; at: number[] } | null {
  for (let t = 0; t <= (strict ? 0 : 2); t++) {
    const at = occs(O, ls, t).filter((i) => i >= from);
    if (at.length > 0) return { t, at };
  }
  return null;
}

interface Body { k: string; s: string }
/** Replacement lines for a matched region: context lines come from the file,
 * other new lines are re-indented at tier 2 (P: O's first line indent -> F: file's). */
function buildRep(body: Body[], i: number, t: number, ls: string[], O: string[]): string[] {
  const out: string[] = [];
  let oi = 0;
  const F = lead(ls[i] ?? '');
  const P = O.length > 0 ? lead(O[0]) : '';
  for (const b of body) {
    if (b.k === ' ') { out.push(ls[i + oi]); oi += 1; }
    else if (b.k === '-') { oi += 1; }
    else if (b.k === '+') {
      let s = b.s;
      if (t === 2 && s !== '' && s.trim() !== '' && s.startsWith(P)) s = F + s.slice(P.length);
      out.push(s);
    }
  }
  return out;
}

/* ---------------- JSON (section 9) ---------------- */

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const t = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, t);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldS = o.old_str;
    const newS = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const ni = cur.indexOf('\n');
      const crlf = ni > 0 && cur[ni - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(cur);
      const old = lf(oldS);
      let n = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) n += 1;
      if (n === 0) throw new Fail('no-match', p);
      if (n > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newS) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const ln = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const f = parseFile(cur);
      if (ln < 0 || ln > f.ls.length) throw new Fail('no-match', p);
      const ls = [...f.ls];
      ls.splice(ln, 0, ...add);
      tree.set(p, serFile({ br: f.br, ls, fin: f.fin }));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new E2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try { v = JSON.parse(text); } catch { throw new E2(`error: parse ${first + 1}`); }
    if (!Array.isArray(v)) throw new E2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new E2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try { e = jsonEdit(JSON.parse(l)); } catch { e = null; }
    if (e === null) throw new E2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---------------- shared line replacement (sections 5-8) ---------------- */

/** Apply hunks/chunks described by body items to a file; O = context+'-' lines. */
function applyBody(f: F, items: Body[], O: string[], pos: number, tier: number, noeol: boolean, path: string): F {
  void path;
  const rep = buildRep(items, pos, tier, f.ls, O);
  const touches = pos + O.length === f.ls.length;
  const ls = [...f.ls.slice(0, pos), ...rep, ...f.ls.slice(pos + O.length)];
  return { br: f.br, ls, fin: touches ? !noeol : f.fin };
}

/* ---------------- unified diffs (section 6) ---------------- */

interface Hunk { a: number; body: Body[]; noeol: boolean }
interface Sec {
  pairOld: string | null; pairNew: string | null;
  renOld: string | null; renNew: string | null;
  diffOld: string; diffNew: string;
  create: boolean; del: boolean; hunks: Hunk[];
}

function uniPath(line: string): string | null {
  let s = line.slice(4).split('\t')[0].trim();
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}
function noeolOf(body: Body[]): boolean {
  let last = -1;
  for (let j = 0; j < body.length; j++) if (body[j].k === ' ' || body[j].k === '+') last = j;
  return last >= 0 && last + 1 < body.length && body[last + 1].k === '\\';
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const secs: Sec[] = [];
  let cur: Sec | null = null;
  let head = false;
  let i = 0;
  const newSecAt = (j: number): boolean => lines[j].startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ');
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(l);
      if (!m) throw new E2(`error: parse ${i + 1}`);
      cur = { pairOld: null, pairNew: null, renOld: null, renNew: null, diffOld: m[1], diffNew: m[2], create: false, del: false, hunks: [] };
      secs.push(cur);
      head = true;
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new E2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (!m) throw new E2(`error: parse ${i + 1}`);
      const h: Hunk = { a: parseInt(m[1], 10), body: [], noeol: false };
      i += 1;
      while (i < lines.length) {
        const b = lines[i];
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') { h.body.push({ k: ' ', s: '' }); i += 1; continue; }
        if (b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') { h.body.push({ k: b[0], s: b.slice(1) }); i += 1; continue; }
        break;
      }
      while (h.body.length > 0 && h.body[h.body.length - 1].k === ' ' && h.body[h.body.length - 1].s === '') h.body.pop();
      h.noeol = noeolOf(h.body);
      cur.hunks.push(h);
      head = false;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && head) {
        cur.pairOld = uniPath(l);
        cur.pairNew = uniPath(lines[i + 1]);
        i += 2;
        continue;
      }
      cur = { pairOld: uniPath(l), pairNew: uniPath(lines[i + 1]), renOld: null, renNew: null, diffOld: '', diffNew: '', create: false, del: false, hunks: [] };
      secs.push(cur);
      head = true;
      i += 2;
      continue;
    }
    if (cur !== null && head) {
      if (l.startsWith('--- ')) throw new E2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) { if (cur.renOld === null) cur.renOld = l.slice(12).trim(); }
      else if (l.startsWith('rename to ')) { if (cur.renNew === null) cur.renNew = l.slice(10).trim(); }
      else if (l.startsWith('new file mode')) cur.create = true;
      else if (l.startsWith('deleted file mode')) cur.del = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  if (secs.length === 0) throw new E2('error: parse 1');
  return secs.map((s) => uniEdit(s, strict));
}

function applyHunks(f: F, hunks: Hunk[], strict: boolean, path: string): F {
  let cur = f;
  let d = 0;
  for (const h of hunks) {
    const O: string[] = [];
    const items: Body[] = [];
    for (const b of h.body) {
      if (b.k === ' ' || b.k === '-') O.push(b.s);
      if (b.k !== '\\') items.push(b);
    }
    const nLines = items.filter((b) => b.k === ' ' || b.k === '+').length;
    if (O.length > 0) {
      const r = tierOf(O, cur.ls, strict);
      if (r === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = r.at[0];
      let bd = Math.abs(best - target);
      for (const p of r.at) {
        const dd = Math.abs(p - target);
        if (dd < bd) { bd = dd; best = p; }
      }
      cur = applyBody(cur, items, O, best, r.t, h.noeol, path);
      d += nLines - O.length;
    } else {
      const pos = Math.min(h.a + d, cur.ls.length);
      const touches = pos === cur.ls.length;
      const rep = items.filter((b) => b.k === '+').map((b) => b.s);
      const ls = [...cur.ls.slice(0, pos), ...rep, ...cur.ls.slice(pos)];
      cur = { br: cur.br, ls, fin: touches ? !h.noeol : cur.fin };
      d += nLines;
    }
  }
  return cur;
}

function uniEdit(sec: Sec, strict: boolean): Edit {
  const oldP = sec.pairOld ?? sec.renOld ?? (sec.diffOld !== '' ? sec.diffOld : null);
  const newP = sec.pairNew ?? sec.renNew ?? (sec.diffNew !== '' ? sec.diffNew : null);
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (sec.create || oldP === null) {
      const p = newP;
      if (p === null) return;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const ls: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.k === '+') ls.push(b.s);
      let fin = true;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi -= 1) {
        const body = sec.hunks[hi].body;
        for (let j = body.length - 1; j >= 0; j -= 1) {
          if (body[j].k === '+') { fin = !(j + 1 < body.length && body[j + 1].k === '\\'); break outer; }
        }
      }
      tree.set(p, ls.length === 0 ? '' : ls.join('\n') + (fin ? '\n' : ''));
      return;
    }
    if (sec.del || newP === null) {
      const p = oldP;
      if (p === null) return;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.set(p, null);
      return;
    }
    if (oldP !== newP) {
      const o = oldP!;
      const n = newP!;
      const cur = tree.get(o);
      if (cur === null) throw new Fail('missing', o);
      if (tree.get(n) !== null) throw new Fail('exists', n);
      const f = applyHunks(parseFile(cur), sec.hunks, strict, o);
      tree.set(n, serFile(f));
      tree.set(o, null);
      tree.moves.push([o, n]);
      return;
    }
    const p = oldP!;
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    tree.set(p, serFile(applyHunks(parseFile(cur), sec.hunks, strict, p)));
  };
}

/* ---------------- SEARCH/REPLACE (section 7) ---------------- */

function srEdit(path: string, oldL: string[], newL: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldL.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.set(path, newL.length === 0 ? '' : newL.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = parseFile(cur);
    const r = tierOf(oldL, f.ls, strict);
    if (r === null) throw new Fail('no-match', path);
    if (r.at.length > 1) throw new Fail('ambiguous', path);
    const items: Body[] = newL.map((s) => ({ k: '+', s }));
    const rep = buildRep(items, r.at[0], r.t, f.ls, oldL);
    const ls = [...f.ls.slice(0, r.at[0]), ...rep, ...f.ls.slice(r.at[0] + oldL.length)];
    tree.set(path, serFile({ br: f.br, ls, fin: f.fin }));
  };
}

function parseSR(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < lines.length) {
    let si = -1;
    for (let j = i; j < lines.length; j++) if (lines[j].trimEnd() === '<<<<<<< SEARCH') { si = j; break; }
    if (si < 0) break;
    let path: string | null = null;
    for (let j = si - 1; j >= prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new E2(`error: parse ${si + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = si + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === '=======') { eq = j; break; }
      if (lines[j].trimEnd() === '<<<<<<< SEARCH') break;
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j].trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
        if (lines[j].trimEnd() === '<<<<<<< SEARCH') break;
      }
    }
    if (eq < 0 || rep < 0) throw new E2(`error: parse ${si + 1}`);
    edits.push(srEdit(path, lines.slice(si + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new E2('error: parse 1');
  return edits;
}

/* ---------------- V4A (section 8) ---------------- */

interface Chunk { anchor: string | null; body: Body[]; eof: boolean }
const v4aSec = (l: string): string | null => {
  if (l.startsWith('*** Add File: ')) return 'add';
  if (l.startsWith('*** Delete File: ')) return 'del';
  if (l.startsWith('*** Update File: ')) return 'upd';
  return null;
};

function v4aAddEdit(path: string, body: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.set(path, body.length === 0 ? '' : body.join('\n') + '\n');
  };
}
function v4aDelEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.set(path, null);
  };
}
function v4aUpdEdit(path: string, moveTo: string | null, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let f = parseFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        let found = -1;
        for (let t = 0; t <= (strict ? 0 : 2) && found < 0; t++) {
          for (let j = cursor; j < f.ls.length; j++) {
            if (norm(f.ls[j], t) === norm(ch.anchor, t)) { found = j; break; }
          }
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      const O: string[] = [];
      const items: Body[] = [];
      for (const b of ch.body) {
        if (b.k === ' ' || b.k === '-') O.push(b.s);
        if (b.k !== '\\') items.push(b);
      }
      if (O.length > 0) {
        let hit: { t: number; at: number } | null = null;
        for (let t = 0; t <= (strict ? 0 : 2) && hit === null; t++) {
          for (const p of occs(O, f.ls, t)) {
            if (p < cursor) continue;
            if (ch.eof && p + O.length !== f.ls.length) continue;
            hit = { t, at: p };
            break;
          }
        }
        if (hit === null) throw new Fail('no-match', path);
        const rep = buildRep(items, hit.at, hit.t, f.ls, O);
        const ls = [...f.ls.slice(0, hit.at), ...rep, ...f.ls.slice(hit.at + O.length)];
        f = { br: f.br, ls, fin: f.fin };
        cursor = hit.at + rep.length;
      } else {
        const pos = ch.eof ? f.ls.length : cursor;
        const rep = items.filter((b) => b.k === '+').map((b) => b.s);
        const ls = [...f.ls.slice(0, pos), ...rep, ...f.ls.slice(pos)];
        f = { br: f.br, ls, fin: f.fin };
        cursor = pos + rep.length;
      }
    }
    if (moveTo !== null) {
      tree.set(moveTo, serFile(f));
      tree.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.set(path, serFile(f));
    }
  };
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new E2('error: parse 1');
  if (lines[first].trim() !== '*** Begin Patch') throw new E2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last])) last -= 1;
  if (last < 0 || lines[last].trim() !== '*** End Patch') throw new E2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i])) { i += 1; continue; }
    const l = lines[i];
    const kind = v4aSec(l);
    if (kind === null) throw new E2(`error: parse ${i + 1}`);
    if (kind === 'add') {
      const p = l.slice('*** Add File: '.length).trim();
      const body: string[] = [];
      i += 1;
      while (i < last) {
        const b = lines[i];
        if (v4aSec(b) !== null || b.trim() === '*** End Patch') break;
        if (b === '') { body.push(''); i += 1; continue; }
        if (b.startsWith('+')) { body.push(b.slice(1)); i += 1; continue; }
        throw new E2(`error: parse ${i + 1}`);
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      edits.push(v4aAddEdit(p, body));
      continue;
    }
    if (kind === 'del') {
      const p = l.slice('*** Delete File: '.length).trim();
      i += 1;
      while (i < last) {
        const b = lines[i];
        if (blank(b)) { i += 1; continue; }
        if (v4aSec(b) !== null || b.trim() === '*** End Patch') break;
        throw new E2(`error: parse ${i + 1}`);
      }
      edits.push(v4aDelEdit(p));
      continue;
    }
    const p = l.slice('*** Update File: '.length).trim();
    const updLine = i;
    i += 1;
    let moveTo: string | null = null;
    if (i < last && lines[i].startsWith('*** Move to: ')) {
      moveTo = lines[i].slice('*** Move to: '.length).trim();
      i += 1;
    }
    const chunks: Chunk[] = [];
    let cur: Chunk | null = null;
    const finish = (): void => {
      if (cur !== null) {
        while (cur.body.length > 0 && cur.body[cur.body.length - 1].k === ' ' && cur.body[cur.body.length - 1].s === '') cur.body.pop();
        chunks.push(cur);
        cur = null;
      }
    };
    while (i < last) {
      const b = lines[i];
      if (blank(b)) {
        if (cur !== null) cur.body.push({ k: ' ', s: '' });
        i += 1;
        continue;
      }
      if (v4aSec(b) !== null || b.trim() === '*** End Patch') break;
      if (b.trim() === '*** End of File') {
        if (cur === null) throw new E2(`error: parse ${i + 1}`);
        cur.eof = true;
        finish();
        i += 1;
        break;
      }
      if (b.startsWith('@@')) {
        finish();
        cur = { anchor: b.slice(2).trim(), body: [], eof: false };
        i += 1;
        continue;
      }
      if (b[0] === ' ' || b[0] === '-' || b[0] === '+') {
        if (cur === null) cur = { anchor: null, body: [], eof: false };
        cur.body.push({ k: b[0], s: b.slice(1) });
        i += 1;
        continue;
      }
      throw new E2(`error: parse ${i + 1}`);
    }
    finish();
    if (chunks.length === 0 && moveTo === null) throw new E2(`error: parse ${updLine + 1}`);
    edits.push(v4aUpdEdit(p, moveTo, chunks, strict));
  }
  if (edits.length === 0) throw new E2('error: parse 1');
  return edits;
}

/* ---------------- run (sections 1, 2, 10) ---------------- */

const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

function run(args: string[]): { code: number; out: string[] } {
  const usage = { code: 2, out: ['error: usage'] };
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') { ended = true; continue; }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) return usage;
        const v = a.slice(9);
        if (!FMTS.includes(v)) return usage;
        format = v;
      } else if (a === '--check') { if (check) return usage; check = true; }
      else if (a === '--strict') { if (strict) return usage; strict = true; }
      else return usage;
    } else pos.push(a);
  }
  if (pos.length > 1) return usage;
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try { text = readFileSync(file ?? 0, 'utf8'); } catch { if (file !== null) return { code: 2, out: ['error: no-patch'] }; }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? parseUnified(lines, strict)
      : kind === 'search-replace' ? parseSR(lines, strict)
      : parseV4A(lines, strict);
    if (edits.length === 0) throw new E2('error: parse 1');
  } catch (e) {
    if (e instanceof E2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const snap = new Map(tree.now);
    const mv = tree.moves.length;
    try { edit(tree); } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now = snap;
      tree.moves.length = mv;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows: { key: string; line: string }[] = [];
  const rOld = new Set<string>();
  const rNew = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.origOf(o) !== null && tree.get(o) === null && tree.origOf(n) === null && tree.get(n) !== null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      rOld.add(o);
      rNew.add(n);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    const was = tree.origOf(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (now === null) { if (!rOld.has(p)) rows.push({ key: p, line: `D ${p}` }); continue; }
    if (rNew.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  if (!check) {
    for (const r of rows) {
      const p = r.line.startsWith('R ') ? r.line.slice(2).split(' -> ')[1] : r.line.slice(2);
      if (r.line.startsWith('D ')) rmSync(p, { force: true });
      else {
        const v = tree.now.get(p)!;
        if (v === null) rmSync(p, { force: true });
        else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, v); }
      }
      if (r.line.startsWith('R ')) {
        const o = r.line.slice(2).split(' -> ')[0];
        rmSync(o, { force: true });
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
