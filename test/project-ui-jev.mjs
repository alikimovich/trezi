import assert from 'node:assert/strict'
import { z } from 'zod'
import { cancelProjectUi, projectUiEnabled, setProjectUiEnabled } from '../src/main/project-ui.ts'
import { composeProjectUiWithJev } from '../src/main/project-ui-jev.ts'

const project = {
  components: [
    {
      name: 'Card',
      file: 'Card.tsx',
      exported: 'Card',
      description: 'Container',
      props: { title: z.string() },
      children: true,
      childrenRequired: false
    }
  ],
  styles: [],
  warnings: []
}
const input = {
  file: 'Page.tsx',
  prompt: 'Welcome card',
  candidates: [
    {
      id: 'card',
      description: 'Welcome container',
      element: { type: 'Card', props: { title: 'Hello' } }
    },
    {
      id: 'text',
      description: 'Welcome message',
      element: { type: 'Text', props: { text: 'Welcome home' } },
      root: false
    }
  ]
}
let calls = 0
const evaluate = async ({ questions }) => {
  calls++
  return {
    answers: Object.fromEntries(
      Object.entries(questions).map(([key, q]) => [
        key,
        {
          type: 'choice',
          choice:
            key === 'root' ? 'card' : Object.keys(q.criteria).find((k) => k.startsWith('use:'))
        }
      ])
    )
  }
}
const result = await composeProjectUiWithJev(project, input, { evaluate })
assert.equal(result.engine, 'jev')
assert.equal(result.stopReason, 'finish')
assert.match(result.code, /<Card title=\{"Hello"\}>/)
assert.match(result.code, /Welcome home/)
assert.equal(calls, 1)
for (const bad of [
  { ...input, file: '../escape.tsx' },
  { ...input, candidates: [...input.candidates, input.candidates[0]] },
  {
    ...input,
    candidates: [{ ...input.candidates[0], element: { type: 'Card', props: { nope: true } } }]
  },
  { ...input, spec: {} }
])
  await assert.rejects(composeProjectUiWithJev(project, bad, { evaluate }))
assert.equal(calls, 1, 'invalid input must not call evaluator')
const layout = await composeProjectUiWithJev(
  project,
  {
    ...input,
    candidates: [
      ...input.candidates,
      {
        id: 'footer',
        description: 'Footer',
        element: { type: 'Text', props: { text: 'Last' } },
        root: false
      }
    ]
  },
  {
    evaluate: async ({ questions }) => ({
      answers: Object.fromEntries(
        Object.entries(questions).map(([key, q]) => [
          key,
          {
            type: 'choice',
            choice:
              key === 'root'
                ? 'card'
                : key.startsWith('order_')
                  ? key === 'order_node_1'
                    ? '2'
                    : '1'
                  : Object.keys(q.criteria).find((k) => k.startsWith('use:'))
          }
        ])
      )
    })
  }
)
assert.equal(layout.evaluations, 2)
assert.ok(
  layout.code.indexOf('Last') < layout.code.indexOf('Welcome home'),
  'evaluator controls sibling order'
)
const unavailable = await composeProjectUiWithJev(project, input, {
  evaluate: async ({ questions }) => ({
    answers: Object.fromEntries(
      Object.keys(questions).map((key) => [
        key,
        { type: 'choice', choice: key === 'root' ? 'unavailable' : 'omit' }
      ])
    )
  })
})
assert.equal(unavailable.stopReason, 'unavailable')
assert.equal(unavailable.code, undefined, 'never silently fall back to source')
await assert.rejects(
  composeProjectUiWithJev(project, input, { evaluate, signal: AbortSignal.abort() }),
  /abort/i
)
assert.equal(calls, 1)
console.log('PROJECT-UI-JEV OK — real composer, validated candidates, unavailable, cancellation')

setProjectUiEnabled('jev-cancel-test', true, 'jev')
cancelProjectUi('jev-cancel-test')
assert.equal(projectUiEnabled('jev-cancel-test'), false, 'stop prevents late tool requests')
