// Read-only rule audit of the actual DS draft; not a desktop end-to-end test.
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { parseGroupProgram, evaluate, transition } from '../packages/central-protocol/dist/group-program.js'

const draft = JSON.parse(await readFile(process.argv[2], 'utf8'))
const program = parseGroupProgram(JSON.parse(draft.source))
const members = ['author', 'player', 'spectator']
let state
let checks = 0
const act = (actor, action, event = {}) => {
  state = transition(program, { state, actor, members, event }, action)
  for (const viewer of members) {
    const context = { state, actor: viewer, members, event: {} }
    const budget = { n: 10000 }
    for (const text of program.view.texts) evaluate(text, context, budget)
    for (const button of program.view.buttons) evaluate(button.enabled, context, budget)
    for (const grid of program.view.grids) {
      const cells = evaluate(grid.cells, context, budget)
      cells.forEach((item, index) => {
        evaluate(grid.label, { ...context, item, index }, budget)
        evaluate(grid.enabled, { ...context, item, index }, budget)
      })
    }
  }
  checks++
}
const deny = (actor, action, event = {}) => {
  const before = structuredClone(state)
  assert.throws(() => act(actor, action, event))
  assert.deepEqual(state, before)
  checks++
}
const start = () => {
  state = structuredClone(program.initial)
  act('author', 'joinX')
  deny('author', 'play', { cell: 0 }) // Must wait for the other seat.
  deny('author', 'joinO')
  act('player', 'joinO')
  deny('spectator', 'joinX')
  deny('spectator', 'play', { cell: 0 })
  deny('outsider', 'play', { cell: 0 })
  deny('player', 'play', { cell: 0 })
  deny('author', 'again')
  for (const cell of [-1, 9, 0.5, '0', null]) deny('author', 'play', { cell })
}
const wins = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]]
for (const line of wins) {
  start()
  const others = Array.from({ length: 9 }, (_, i) => i).filter(i => !line.includes(i))
  act('author', 'play', { cell: line[0] })
  deny('author', 'play', { cell: line[1] })
  deny('player', 'play', { cell: line[0] })
  act('player', 'play', { cell: others[0] })
  act('author', 'play', { cell: line[1] })
  act('player', 'play', { cell: others[1] })
  act('author', 'play', { cell: line[2] })
  assert.equal(state.winner, 'X')
  deny('player', 'play', { cell: others[2] })
  deny('spectator', 'again')
  act('player', 'again')
  assert.deepEqual(state.board, Array(9).fill(''))
  assert.equal(state.round, 2)
}
start()
for (const [i, cell] of [0,4,8,1,7,6,2,5,3].entries()) act(i % 2 ? 'player' : 'author', 'play', { cell })
assert.ok(state.winner && !['X', 'O'].includes(state.winner), 'A full non-winning board must be a draw')
deny('author', 'play', { cell: 0 })
act('author', 'again')
assert.equal(state.winner, '')
start()
for (const [i, cell] of [0,3,1,4,8,5].entries()) act(i % 2 ? 'player' : 'author', 'play', { cell })
assert.equal(state.winner, 'O')
console.log(JSON.stringify({ draftRevision: draft.revision, version: draft.manifest.version, checks, xWinningLines: wins.length, oWin: true, draw: true, viewCheckedAfterEachAcceptedAction: true, scope: 'isolated artifact evaluation; no live client/server state changed' }, null, 2))
