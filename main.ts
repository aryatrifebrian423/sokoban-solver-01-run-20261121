// Sokoban solver: room-decomposed push-optimal search.
//
// One run answers every instance of a set. Each level is a hallway with
// rooms off it; a box pushed out of a room through its door can never be
// pushed back, so every room is an independent puzzle and the level's
// push-optimal count is the sum of its rooms' optima. Each room is solved
// on its own by a breadth-first search over pushes: states expand in the
// order of pushes made, so the first solved state met is push-optimal.
// A state is the boxes' squares plus the lowest square of the player's
// reachable region (the exact square inside one region never changes
// which pushes are possible). Two prunings keep the search small, and
// neither prunes a solvable state: a box may only be pushed onto a live
// square (one from which a box alone can still be pushed onto a goal),
// and a push that leaves a box frozen in a 2 x 2 block of walls and
// boxes off its goal is dropped. The search budget is a fixed number of
// states, never the clock, so two runs write the same bytes. The player
// walks between rooms on the full board with every box treated as a
// wall; each room is then solved on a board of its own squares plus the
// hallway row, which keeps the search close to the room on its own.
// Node standard library only; no dependencies, no network, no clock.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** [dx, dy, step letter, push letter], in a fixed order: ties break the same way on every run. */
const DIRS: Array<[number, number, string, string]> = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

/** The most states one room's search keeps; work, never the clock. */
const ROOM_STATE_BUDGET = 300_000;
/** The most states the whole-level fallback search keeps. */
const WHOLE_STATE_BUDGET = 200_000;

type Board = {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

type Room = { squares: number[]; boxes: number[]; goals: number[] };

/** A level in XSB text: its width and height, walls (the outer frame is a wall whatever it shows), goals, boxes and player. */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/** The squares from which a box alone can still be pushed onto some goal, found by pulling back from the goals. */
function liveSquares(w: number, wall: Uint8Array, goals: number[]): Uint8Array {
  const size = wall.length;
  const live = new Uint8Array(size);
  const queue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (y < 0 || y >= size) continue;
      const behind = y - d;
      if (behind < 0 || behind >= size) continue;
      if (!wall[y] && !wall[behind] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * The level's rooms: the player's row is the hallway, so its dead squares
 * (no box there can ever reach a goal) are cut out of the floor, and each
 * connected part left that holds boxes is a room. Null when the level is
 * no set of rooms: a box in the hallway, a goal outside every part, or a
 * part with unequal boxes and goals.
 */
function roomsOf(level: Board): Room[] | null {
  const { w, h, wall, goals, boxes, player } = level;
  const size = w * h;
  const live = liveSquares(w, wall, goals);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(size);
  for (let x = 0; x < w; x++) {
    const i = row * w + x;
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  for (const b of boxes) if (cut[b]) return null;
  const part = new Int32Array(size).fill(-1);
  const rooms: Room[] = [];
  const stack: number[] = [];
  for (let s = 0; s < size; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares: number[] = [s];
    part[s] = rooms.length;
    stack.length = 0;
    stack.push(s);
    while (stack.length > 0) {
      const p = stack.pop()!;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (q < 0 || q >= size) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
          stack.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) {
    if (part[b] < 0) return null;
    rooms[part[b]]!.boxes.push(b);
  }
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]]!.goals.push(g);
  }
  for (const r of rooms) {
    if (r.boxes.length !== r.goals.length) return null;
  }
  return rooms.filter((r) => r.boxes.length > 0);
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters (the first direction first on ties). */
function walkTo(w: number, wall: Uint8Array, occupied: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const size = wall.length;
  const prev = new Int32Array(size).fill(-1);
  const how = new Array<string>(size);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (q < 0 || q >= size) continue;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: no walk to the push square');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The player and boxes after playing `moves` on a board (every step is legal: the caller only feeds it solved moves). */
function applyMoves(
  w: number,
  boxes: number[],
  player: number,
  moves: string,
): { player: number; boxes: number[] } {
  const boxSet = new Set(boxes);
  let p = player;
  for (const ch of moves) {
    const lower = ch.toLowerCase();
    const dir = DIRS.find(([, , l]) => l === lower)!;
    const d = dir[1] * w + dir[0];
    const q = p + d;
    if (boxSet.has(q)) {
      boxSet.delete(q);
      boxSet.add(q + d);
    }
    p = q;
  }
  return { player: p, boxes: [...boxSet].sort((a, b) => a - b) };
}

/** Sorted boxes packed one per byte (a board holds under 256 squares, so each square fits in a byte). */
function packBoxes(boxes: ArrayLike<number>, n: number): number {
  let p = 0;
  for (let i = 0; i < n; i++) p |= boxes[i]! << (8 * i);
  return p >>> 0;
}

function unpackInto(packed: number, out: Int32Array, n: number): void {
  for (let i = 0; i < n; i++) out[i] = (packed >> (8 * i)) & 0xff;
}

/** Insertion sort for at most four boxes. */
function sortSmall(a: Int32Array, n: number): void {
  for (let i = 1; i < n; i++) {
    const v = a[i]!;
    let j = i - 1;
    while (j >= 0 && a[j]! > v) {
      a[j + 1] = a[j]!;
      j--;
    }
    a[j + 1] = v;
  }
}

/**
 * The push-optimal solution of a board: a breadth-first search over pushes.
 * A state is the boxes' squares plus the lowest square of the player's
 * reachable region. The search keeps at most `maxStates` states and
 * returns {pushes, moves}, or null when it runs out of budget or the board
 * has no solution. The first solved state met is push-optimal, because
 * states expand in the order of pushes made.
 */
function solvePushes(
  w: number,
  wall: Uint8Array,
  goals: number[],
  boxes0: number[],
  player0: number,
  maxStates: number,
): { pushes: number; moves: string } | null {
  const size = wall.length;
  const n = boxes0.length;
  const offs = [-w, w, -1, 1];
  const goalSet = new Uint8Array(size);
  for (const g of goals) goalSet[g] = 1;
  const live = liveSquares(w, wall, goals);
  for (const b of boxes0) if (!live[b]) return null;

  const isSolved = (packed: number): boolean => {
    for (let i = 0; i < n; i++) if (!goalSet[(packed >> (8 * i)) & 0xff]) return false;
    return true;
  };

  // Scratch: which squares hold boxes, the region marks with their stamps, and the flood stack.
  // The current state's region and a successor's region need separate marks: a successor's
  // flood must not overwrite the marks the current state's push squares are tested against.
  const occupied = new Uint8Array(size);
  const regionMark = new Int32Array(size);
  const lowMark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  let lowStamp = 0;

  /** The lowest square of the region reached from `from`, marked in `marks` with `stampValue`. */
  const flood = (marks: Int32Array, from: number, stampValue: number): number => {
    let low = from;
    let sp = 0;
    stack[sp++] = from;
    marks[from] = stampValue;
    while (sp > 0) {
      const p = stack[--sp]!;
      if (p < low) low = p;
      for (let k = 0; k < 4; k++) {
        const q = p + offs[k]!;
        if (q < 0 || q >= size) continue;
        if (wall[q] || occupied[q] || marks[q] === stampValue) continue;
        marks[q] = stampValue;
        stack[sp++] = q;
      }
    }
    return low;
  };

  /** Whether the box just pushed to `t` sits frozen in a 2 x 2 block of walls and boxes with a box off its goal. */
  const frozenAt = (t: number): boolean => {
    for (const a of [t, t - 1, t - w, t - w - 1]) {
      const b = a + 1;
      const c = a + w;
      const d = c + 1;
      if (a < 0 || d >= size) continue;
      if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b])) continue;
      if (!(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
      if ((occupied[a] && !goalSet[a]) || (occupied[b] && !goalSet[b])) return true;
      if ((occupied[c] && !goalSet[c]) || (occupied[d] && !goalSet[d])) return true;
    }
    return false;
  };

  // The states in the order found: their packed boxes, the player's square, and their parent.
  const packs: number[] = [];
  const players: number[] = [];
  const parents: number[] = [];
  const seen = new Map<number, number>();
  const bx = new Int32Array(4);
  const nb = new Int32Array(4);

  const pack0 = packBoxes(boxes0, n);
  for (const b of boxes0) occupied[b] = 1;
  const low0 = flood(lowMark, player0, ++lowStamp);
  for (const b of boxes0) occupied[b] = 0;
  packs.push(pack0);
  players.push(player0);
  parents.push(-1);
  seen.set(pack0 * 256 + low0, 0);
  if (isSolved(pack0)) return { pushes: 0, moves: '' };

  /** The moves of the solved state `done`, rebuilt from its parents: walk to each push, then push. */
  const buildMoves = (done: number): { pushes: number; moves: string } => {
    const path: number[] = [];
    for (let s = done; s > 0; s = parents[s]!) path.push(s);
    path.reverse();
    let moves = '';
    let curPlayer = player0;
    let curBoxes = boxes0.slice();
    const occ = new Uint8Array(size);
    const child = new Int32Array(4);
    for (const s of path) {
      unpackInto(packs[s]!, child, n);
      const nextBoxes = Array.from(child.subarray(0, n));
      const from = curBoxes.find((b) => !nextBoxes.includes(b))!;
      const to = nextBoxes.find((b) => !curBoxes.includes(b))!;
      const d = to - from;
      const k = offs.indexOf(d);
      for (const b of curBoxes) occ[b] = 1;
      moves += walkTo(w, wall, occ, curPlayer, from - d);
      for (const b of curBoxes) occ[b] = 0;
      moves += DIRS[k]![3];
      curPlayer = from;
      curBoxes = nextBoxes;
    }
    return { pushes: path.length, moves };
  };

  let done = -1;
  for (let head = 0; head < packs.length && done < 0; head++) {
    const pack = packs[head]!;
    unpackInto(pack, bx, n);
    for (let i = 0; i < n; i++) occupied[bx[i]!] = 1;
    const here = ++stamp;
    flood(regionMark, players[head]!, here);
    for (let bi = 0; bi < n && done < 0; bi++) {
      const b = bx[bi]!;
      for (let k = 0; k < 4 && done < 0; k++) {
        const d = offs[k]!;
        const t = b + d;
        if (t < 0 || t >= size) continue;
        if (wall[t] || occupied[t] || !live[t]) continue;
        const psq = b - d;
        if (psq < 0 || psq >= size || regionMark[psq] !== here) continue;
        for (let i = 0; i < n; i++) nb[i] = bx[i]!;
        nb[bi] = t;
        sortSmall(nb, n);
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenAt(t);
        let key = -1;
        let npack = -1;
        if (!frozen) {
          const low = flood(lowMark, b, ++lowStamp);
          npack = packBoxes(nb, n);
          key = npack * 256 + low;
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || seen.has(key)) continue;
        const solvedNow = isSolved(npack);
        if (!solvedNow && packs.length >= maxStates) return null;
        seen.set(key, packs.length);
        packs.push(npack);
        players.push(b);
        parents.push(head);
        if (solvedNow) done = packs.length - 1;
      }
    }
    for (let i = 0; i < n; i++) occupied[bx[i]!] = 0;
  }
  if (done < 0) return null;
  return buildMoves(done);
}

/** One level's moves: room by room, the player walking between rooms. An empty string when a room will not solve. */
function solveLevel(text: string): string {
  const level = parseLevel(text);
  const { w, h, wall, goals, boxes, player } = level;
  if (boxes.length === 0) return '';
  const rooms = roomsOf(level);
  if (rooms === null) {
    const whole = solvePushes(w, wall, goals, boxes, player, WHOLE_STATE_BUDGET);
    return whole === null ? '' : whole.moves;
  }
  const size = w * h;
  const hallRow = Math.floor(player / w);
  let moves = '';
  let curPlayer = player;
  let boxesNow = boxes.slice();
  for (const room of rooms) {
    // The room's door: its one square touching the hallway row; the walk
    // target is the hallway square just outside it.
    let door = -1;
    let hallSq = -1;
    for (const s of room.squares) {
      for (const [dx, dy] of DIRS) {
        const q = s + dy * w + dx;
        if (q >= 0 && q < size && Math.floor(q / w) === hallRow && !wall[q]) {
          door = s;
          hallSq = q;
        }
      }
    }
    if (door < 0) return '';
    // Walk to the door on the full board, every box a wall.
    if (curPlayer !== hallSq) {
      const occ = new Uint8Array(size);
      for (const b of boxesNow) occ[b] = 1;
      let walk: string | null = null;
      let dest = hallSq;
      try {
        walk = walkTo(w, wall, occ, curPlayer, hallSq);
      } catch {
        try {
          walk = walkTo(w, wall, occ, curPlayer, door);
          dest = door;
        } catch {
          return '';
        }
      }
      moves += walk;
      curPlayer = dest;
    }
    // Solve the room on its own board: its squares plus the hallway row.
    const wall2 = new Uint8Array(size).fill(1);
    for (const s of room.squares) wall2[s] = 0;
    for (let x = 0; x < w; x++) {
      const i = hallRow * w + x;
      if (!wall[i]) wall2[i] = 0;
    }
    const solved = solvePushes(w, wall2, room.goals, room.boxes, curPlayer, ROOM_STATE_BUDGET);
    if (solved === null) return '';
    moves += solved.moves;
    const after = applyMoves(w, boxesNow, curPlayer, solved.moves);
    curPlayer = after.player;
    boxesNow = after.boxes;
  }
  return moves;
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
