// Runs the game simulation from index.html in Node, without a browser.
// Usage: node tests/sim.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const block = id => html.match(new RegExp(`<script[^>]*id="${id}">([\\s\\S]*?)</script>`))[1];
const { Sim, CONFIG } = vm.runInNewContext(block('config') + block('sim') + '\n;({ Sim, CONFIG })', {});
const EVENTS = JSON.parse(block('events'));
Sim.setEvents(EVENTS);

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok -', name); }

function fourPlayers() {
  const g = Sim.createGame();
  for (const n of ['Amy', 'Ben', 'Cat', 'Dev']) Sim.addPlayer(g, n.toLowerCase(), n);
  for (const id of Object.keys(g.players)) Sim.setReady(g, id, true);
  return g;
}
// Runs the clock forward until the phase changes.
function until(g, phase, t) {
  for (let i = 0; i < 10000 && g.phase !== phase; i++) { t += 200; Sim.tick(g, t); }
  assert.strictEqual(g.phase, phase);
  return t;
}

test('every placeholder card has one default and trades stats off', () => {
  for (const e of EVENTS) {
    assert.strictEqual(e.options.filter(o => o.default).length, 1, e.id);
    assert(e.options.length >= 2 && e.options.length <= 3, e.id);
  }
  for (let s = 1; s <= 5; s++) assert(EVENTS.filter(e => e.stage === s).length >= CONFIG.roundsPerStage, 'stage ' + s);
});

test('lobby: fifth player is refused, start needs everyone ready', () => {
  const g = Sim.createGame();
  for (const n of ['a', 'b', 'c', 'd']) assert(Sim.addPlayer(g, n, n).ok);
  assert.strictEqual(Sim.addPlayer(g, 'e', 'e').err, 'full');
  assert(!Sim.canStart(g));
  for (const n of ['a', 'b', 'c', 'd']) Sim.setReady(g, n, true);
  assert(Sim.start(g, 0));
  assert.strictEqual(Sim.addPlayer(g, 'e', 'e').err, 'started');
  assert(Sim.addPlayer(g, 'a', 'a').ok, 'existing player can rejoin mid-game');
});

test('hidden picks never reach other players before the reveal', () => {
  const g = fourPlayers();
  Sim.start(g, 0);
  let t = until(g, 'pick', 0);
  assert(Sim.pick(g, 'amy', 1));
  assert(!Sim.pick(g, 'amy', 0), 'no changing a locked pick');
  const ben = Sim.viewFor(g, 'ben', t);
  assert.strictEqual(ben.myPick, null);
  assert(!JSON.stringify(ben).includes('"idx"'));
  assert.strictEqual(ben.players.find(p => p.id === 'amy').locked, true);
  assert.strictEqual(Sim.viewFor(g, 'amy', t).myPick, 1);
});

test('round ends early when all lock in; missing picks take the default', () => {
  const g = fourPlayers();
  Sim.start(g, 0);
  let t = until(g, 'pick', 0);
  for (const id of ['amy', 'ben', 'cat', 'dev']) Sim.pick(g, id, 0);
  Sim.tick(g, t + 1);
  assert.strictEqual(g.phase, 'reveal');
  t = until(g, 'pick', t);
  Sim.pick(g, 'amy', 0);
  const start = t;
  t = until(g, 'reveal', t);
  assert(t - start >= CONFIG.timings.pick * 1000, 'waited for the timer');
  const def = g.card.options.findIndex(o => o.default);
  for (const r of g.reveal.filter(r => r.id !== 'amy')) { assert(r.auto); assert.strictEqual(r.idx, def); }
});

test('a disconnected player does not stall the round', () => {
  const g = fourPlayers();
  Sim.start(g, 0);
  let t = until(g, 'pick', 0);
  Sim.setConnected(g, 'dev', false);
  for (const id of ['amy', 'ben', 'cat']) Sim.pick(g, id, 0);
  Sim.tick(g, t + 1);
  assert.strictEqual(g.phase, 'reveal');
  assert(g.reveal.find(r => r.id === 'dev').auto);
});

test('full game: 20 rounds, 5 stage intros, no repeats, stats stay in range', () => {
  const g = fourPlayers();
  Sim.start(g, 0);
  let t = 0, stages = 0, spotlights = {};
  const seen = new Set();
  while (g.phase !== 'final') {
    const before = g.phase;
    t += 200; Sim.tick(g, t);
    if (before !== g.phase && g.phase === 'stage') stages++;
    if (before !== g.phase && g.phase === 'card') {
      assert(!seen.has(g.card.id), 'repeat ' + g.card.id);
      seen.add(g.card.id);
      spotlights[g.spotlight] = (spotlights[g.spotlight] || 0) + 1;
    }
    for (const p of Object.values(g.players)) {
      assert(p.health >= 0 && p.health <= 100 && p.happiness >= 0 && p.happiness <= 100);
      assert.strictEqual(Math.abs(p.money % CONFIG.moneyStep), 0);
    }
  }
  assert.strictEqual(seen.size, 20);
  assert.strictEqual(stages + 1, 5);
  assert.deepStrictEqual(Object.values(spotlights), [5, 5, 5, 5]);
  assert(t / 60000 < 16, `game took ${(t / 60000).toFixed(1)} minutes`);
  console.log(`   (all-timeout game: ${(t / 60000).toFixed(1)} min)`);
  const st = Sim.viewFor(g, 'amy', t).standings;
  assert.strictEqual(st.length, 4);
  Sim.resetToLobby(g);
  assert.strictEqual(g.phase, 'lobby');
  assert(Object.values(g.players).every(p => !p.ready && p.money === CONFIG.start.money));
});

test("others' Health and Happiness never leave the host; mood and leader do", () => {
  const g = fourPlayers();
  Sim.start(g, 0);
  let t = until(g, 'reveal', 0);
  const v = Sim.viewFor(g, 'amy', t);
  for (const p of v.players) {
    assert(Number.isInteger(p.mood) && p.mood >= 0 && p.mood <= 5);
    assert.strictEqual('health' in p, p.id === 'amy', p.id);
    assert.strictEqual('happiness' in p, p.id === 'amy', p.id);
  }
  assert('leader' in v);
  t = until(g, 'final', t);
  assert(Sim.viewFor(g, 'amy', t).players.every(p => 'health' in p), 'all shown at the end');
});

test('mood faces use even thresholds', () => {
  const m = (h, p) => Sim.moodOf({ health: h, happiness: p });
  assert.deepStrictEqual([m(0, 0), m(16, 16), m(17, 17), m(33, 34), m(50, 50), m(67, 67), m(84, 84), m(85, 85), m(100, 100)], [0, 0, 1, 2, 2, 3, 4, 5, 5]);
});

test('colours: unique, first come first served, lobby only', () => {
  const g = Sim.createGame();
  Sim.addPlayer(g, 'a', 'a'); Sim.addPlayer(g, 'b', 'b');
  assert.notStrictEqual(g.players.a.colour, g.players.b.colour);
  assert(!Sim.setColour(g, 'b', g.players.a.colour));
  assert(Sim.setColour(g, 'b', 'bubblegum'));
  assert(!Sim.setColour(g, 'b', 'tartan'));
});

test('crown: nobody on a dead heat, the leader otherwise', () => {
  const g = fourPlayers();
  Sim.start(g, 0);
  assert.strictEqual(Sim.leader(g), null);
  g.players.cat.happiness += 5;
  assert.strictEqual(Sim.leader(g), 'cat');
});

test('life score caps and floors money points', () => {
  assert.strictEqual(Sim.lifeScore({ money: 100000, health: 50, happiness: 50 }).money, 100);
  assert.strictEqual(Sim.lifeScore({ money: -100000, health: 50, happiness: 50 }).money, -40);
  assert.strictEqual(Sim.lifeScore({ money: 1000, health: 70, happiness: 60 }).total, 132);
});

console.log(`\n${passed} tests passed`);
