//@flow

import {createEvent} from '../event'
import {createStore} from '../store'
import {createLinkNode} from '../forward'
import {
  step,
  createStateRef,
  readRef,
  writeRef,
  own,
} from '../stdlib'

export const storeBy = (
  source: any,
  clock: any,
  fn: null | ((a: any, b: any) => any),
  greedy: boolean,
  target: any,
) => {
  own(source, [
    createLinkNode(clock, target, {
      scope: {
        state: source.stateRef,
        fn,
      },
      node: [
        //$off
        !greedy && step.barrier({priority: 'sampler'}),
        step.compute({
          fn: fn
            ? (upd, {state, fn}) => fn(readRef(state), upd)
            : (upd, {state}) => readRef(state),
        }),
      ].filter(Boolean),
      meta: {op: 'sample', sample: 'store'},
    }),
  ])
  return target
}

export const storeByEvent = (
  source: any,
  clock: any,
  fn: null | ((a: any, b: any) => any),
  greedy: boolean,
  target: any,
  name: string | null,
) =>
  storeBy(
    source,
    clock,
    fn,
    greedy,
    target ||
      createEvent(name || source.shortName, {
        parent: source.domainName,
      }),
  )

export const storeByStore = (
  source: any,
  clock: any,
  fn: null | ((a: any, b: any) => any),
  greedy: boolean,
  target: any,
  name: string | null,
) => {
  const sourceState = readRef(source.stateRef)
  return storeBy(
    source,
    clock,
    fn,
    greedy,
    target ||
      createStore(fn ? fn(sourceState, readRef(clock.stateRef)) : sourceState, {
        name: name || source.shortName,
        parent: source.domainName,
      }),
  )
}

export const eventByUnit = (
  source: any,
  clock: any,
  fn: null | ((a: any, b: any) => any),
  greedy: boolean,
  target: any,
  name: string | null,
) => {
  target =
    target ||
    createEvent(name || source.shortName, {
      parent: source.domainName,
    })
  const hasSource = createStateRef(false)
  const sourceState = createStateRef()
  const clockState = createStateRef()

  own(clock, [
    createLinkNode(source, target, {
      scope: {hasSource},
      node: [
        step.update({store: sourceState}),
        step.compute({
          fn(upd, {hasSource}) {
            writeRef(hasSource, true)
          },
        }),
        step.filter({fn: () => false}),
      ],
      meta: {op: 'sample', sample: 'source'},
    }),
  ])
  own(source, [
    createLinkNode(clock, target, {
      scope: {sourceState, clockState, hasSource, fn},
      node: [
        step.update({store: clockState}),
        step.filter({
          fn: (upd, {hasSource}) => readRef(hasSource),
        }),
        //$off
        !greedy && step.barrier({priority: 'sampler'}),
        step.compute({
          fn: fn
            ? (upd, {sourceState, clockState, fn}) =>
              fn(readRef(sourceState), readRef(clockState))
            : (upd, {sourceState}) => readRef(sourceState),
        }),
      ].filter(Boolean),
      meta: {op: 'sample', sample: 'clock'},
    }),
  ])
  return target
}
