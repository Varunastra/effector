//@flow

import {getGraph} from './getter'
import {bind} from './bind'
import {createDefer} from './defer'
import {watchUnit} from './watch'
import {isObject} from './is'
import {throwError} from './throw'

import {is, step, launch, createNode} from 'effector'

const stack = []

/**
hydrate state on client

const root = createDomain()
hydrate(root, {
  values: window.__initialState__
})

*/
export function hydrate(domain, {values}) {
  if (!is.domain(domain)) {
    throwError('first argument of hydrate should be domain')
  }
  if (!isObject(values)) {
    throwError('values property should be an object')
  }

  const {storeWatches, storeWatchesRefs} = fillValues({
    flatGraphUnits: flatGraph(domain),
    values: normalizeValues(values),
    collectWatches: true,
  })

  launch({
    target: storeWatches,
    params: storeWatchesRefs.map(({current}) => current),
  })
}

function fillValues({flatGraphUnits, values, collectWatches}) {
  const storeWatches = []
  const storeWatchesRefs = []
  const refsMap = {}
  const predefinedRefs = new Set()
  const valuesSidList = Object.getOwnPropertyNames(values)
  for (const node of flatGraphUnits) {
    const {reg} = node
    const {op, unit, sid} = node.meta
    if (unit === 'store') {
      if (sid && valuesSidList.includes(sid)) {
        const {state} = node.scope
        state.current = values[sid]
        predefinedRefs.add(state)
      }
    }
    if (collectWatches && op === 'watch') {
      const owner = node.family.owners[0]
      if (owner.meta.unit === 'store') {
        storeWatches.push(node)
        storeWatchesRefs.push(owner.scope.state)
      }
    }
    for (const id in reg) {
      refsMap[id] = reg[id]
    }
  }
  const refGraph = createRefGraph(refsMap)
  const result = toposort(refGraph)
  result.forEach(id => {
    execRef(refsMap[id])
  })

  return {
    storeWatches,
    storeWatchesRefs,
  }
  function execRef(ref) {
    let isFresh = false
    if (ref.before && !predefinedRefs.has(ref)) {
      for (const cmd of ref.before) {
        switch (cmd.type) {
          case 'map': {
            const from = cmd.from
            ref.current = cmd.fn(from.current)
            break
          }
          case 'field': {
            const from = cmd.from
            if (!isFresh) {
              isFresh = true
              if (Array.isArray(ref.current)) {
                ref.current = [...ref.current]
              } else {
                ref.current = {...ref.current}
              }
            }
            ref.current[cmd.field] = from.current
            break
          }
          case 'closure':
            break
        }
      }
    }
    if (!ref.after) return
    const value = ref.current
    for (const cmd of ref.after) {
      const to = cmd.to
      // if (predefinedRefs.has(to)) continue
      switch (cmd.type) {
        case 'copy':
          to.current = value
          break
        case 'map':
          to.current = cmd.fn(value)
          break
      }
    }
  }
}

function createRefGraph(refsMap) {
  const items = Object.values(refsMap)
  const refGraph = {}
  for (const {id} of items) {
    refGraph[id] = []
  }
  //prettier-ignore
  for (const {id, before, after} of items) {
    before && before.forEach(cmd => {
      refGraph[cmd.from.id].push(id)
    })
    after && after.forEach(cmd => {
      refGraph[id].push(cmd.to.id)
    })
  }
  return refGraph
}

/**
serialize state on server
*/
export function serialize(
  {clones},
  {ignore = []}: {ignore?: Array<Store<any>>} = {},
) {
  const result = {}
  for (const {meta, scope, reg} of clones) {
    if (meta.unit !== 'store') continue
    const {sid} = meta
    if (!sid) continue
    result[sid] = reg[scope.state.id].current
  }
  for (const {sid} of ignore) {
    if (sid) delete result[sid]
  }
  return result
}

/** invoke event in scope */
export function invoke(unit, payload) {
  if (stack.length === 0) {
    throwError('invoke cannot be called outside of forked .watch')
  }
  launch(stack[stack.length - 1](unit), payload)
}

/** bind event to scope */
export function scopeBind(unit) {
  if (stack.length === 0) {
    throwError('scopeBind cannot be called outside of forked .watch')
  }
  const result = stack[stack.length - 1](unit)
  return payload => {
    launch(result, payload)
  }
}
function universalLaunch(unit, payload) {
  if (stack.length > 0) {
    invoke(unit, payload)
  } else {
    launch(unit, payload)
  }
}
function normalizeValues(values) {
  if (values instanceof Map) {
    const result = {}
    for (const [key, value] of values) {
      result[key.sid] = value
    }
    return result
  }
  return values
}
export function fork(domain, {values, handlers} = {}) {
  if (!is.domain(domain)) throwError('first argument of fork should be domain')
  if (!domain.graphite.meta.withScopes) {
    domain.graphite.meta.withScopes = true
    domain.onCreateEvent(event => {
      event.create = payload => {
        universalLaunch(event, payload)
        return payload
      }
    })
    domain.onCreateEffect(effect => {
      effect.create = params => {
        const req = createDefer()
        universalLaunch(effect, {params, req})
        return req.req
      }
    })
  }
  const needToFill = !!values
  values = normalizeValues(values || {})
  const forked = cloneGraph(domain)
  if (needToFill) {
    fillValues()
  }
  if (handlers) {
    handlers = normalizeValues(handlers)
    const handlerKeys = Object.keys(handlers)
    for (const {scope, meta} of forked.clones) {
      if (meta.sid && handlerKeys.includes(meta.sid)) {
        scope.runner.scope.getHandler = () => handlers[meta.sid]
      }
    }
  }
  return forked

  function fillValues() {
    const sourceList = flatGraph(domain)
    const sourceRefsMap = {}
    const refsMap = {}
    const predefinedRefs = new Set()
    const valuesSidList = Object.getOwnPropertyNames(values)
    for (const {reg} of sourceList) {
      for (const id in reg) {
        sourceRefsMap[id] = reg[id]
      }
    }
    for (const node of forked.clones) {
      const {reg} = node
      const {unit, sid} = node.meta
      if (unit === 'store') {
        if (sid && valuesSidList.includes(sid)) {
          const {state} = node.scope
          reg[state.id].current = values[sid]
          predefinedRefs.add(state)
        }
      }
      for (const id in reg) {
        refsMap[id] = reg[id]
      }
    }
    const refGraph = createRefGraph(sourceRefsMap)
    const result = toposort(refGraph)
    result.forEach(id => {
      execRef(refsMap[id], sourceRefsMap[id])
    })

    function execRef(ref, sourceRef) {
      let isFresh = false
      if (sourceRef && sourceRef.before && !predefinedRefs.has(ref)) {
        for (const cmd of sourceRef.before) {
          switch (cmd.type) {
            case 'map': {
              const from = refsMap[cmd.from.id]
              ref.current = cmd.fn(from.current)
              break
            }
            case 'field': {
              const from = refsMap[cmd.from.id]
              if (!isFresh) {
                isFresh = true
                if (Array.isArray(ref.current)) {
                  ref.current = [...ref.current]
                } else {
                  ref.current = {...ref.current}
                }
              }
              ref.current[cmd.field] = from.current
              break
            }
            case 'closure':
              break
          }
        }
      }
      if (!sourceRef || !sourceRef.after) return
      const value = ref.current
      for (const cmd of sourceRef.after) {
        const to = refsMap[cmd.to.id]
        // if (predefinedRefs.has(to)) continue
        switch (cmd.type) {
          case 'copy':
            to.current = value
            break
          case 'map':
            to.current = cmd.fn(value)
            break
        }
      }
    }
  }
}
function toposort(rawGraph) {
  const graph = {}
  for (const id in rawGraph) {
    graph[id] = [...new Set(rawGraph[id])]
  }
  const result = []
  const visited = {}
  const temp = {}
  for (const node in graph) {
    if (!visited[node] && !temp[node]) {
      topologicalSortHelper(node, visited, temp, graph, result)
    }
  }
  return result.reverse()
  function topologicalSortHelper(node, visited, temp, graph, result) {
    temp[node] = true
    const neighbors = graph[node]
    for (let i = 0; i < neighbors.length; i++) {
      const n = neighbors[i]
      if (temp[n]) {
        continue
        // throw Error('found cycle in DAG')
      }
      if (!visited[n]) {
        topologicalSortHelper(n, visited, temp, graph, result)
      }
    }
    temp[node] = false
    visited[node] = true
    result.push(node)
  }
}
export function allSettled(
  start,
  {
    scope: {
      find,
      graphite: {
        scope: {forkInFlightCounter},
      },
    },
    params: ctx,
  },
) {
  if (!is.unit(start))
    return Promise.reject(Error('first argument should be unit'))
  const defer = createDefer()
  forkInFlightCounter.scope.defers.push(defer)
  const contextStart = find(start)
  if (is.effect(start)) {
    launch(contextStart, {
      params: ctx,
      req: {
        rs() {},
        rj() {},
      },
    })
  } else {
    launch(contextStart, ctx)
  }
  launch(forkInFlightCounter)
  return defer.req
}
function flatGraph(unit) {
  const list = []
  ;(function traverse(node) {
    if (list.includes(node)) return
    list.push(node)
    forEachRelatedNode(node, traverse)
  })(getGraph(unit))
  return list
}
/**
everything we need to clone graph section
reachable from given unit
*/
function cloneGraph(unit) {
  const list = flatGraph(unit)
  const refs = new Map()
  const scope = {
    defers: [],
    inFlight: 0,
    fxID: 0,
  }
  const forkInFlightCounter = createNode({
    scope,
    node: [
      step.compute({
        fn(_, scope, stack) {
          if (!stack.parent) {
            scope.fxID += 1
            return
          }
          if (stack.parent.node.meta.named === 'finally') {
            scope.inFlight -= 1
          } else {
            scope.inFlight += 1
            scope.fxID += 1
          }
        },
      }),
      step.barrier({priority: 'sampler'}),
      step.run({
        fn(_, scope) {
          const {inFlight, defers, fxID} = scope
          if (inFlight > 0 || defers.length === 0) return
          Promise.resolve().then(() => {
            if (scope.fxID !== fxID) return
            defers.splice(0, defers.length).forEach(defer => {
              defer.rs()
            })
          })
        },
      }),
    ],
    meta: {unit: 'forkInFlightCounter'},
  })

  const clones = list.map(({seq, next, meta, scope, family}) => {
    const result = createNode({
      node: seq.map(step => ({
        id: step.id,
        type: step.type,
        data: Object.assign({}, step.data),
        hasRef: step.hasRef,
      })),
      child: [...next],
      meta: Object.assign({}, meta),
      scope: Object.assign({}, scope),
    })
    result.family = {
      type: family.type,
      links: [...family.links],
      owners: [...family.owners],
    }
    return result
  })

  clones.forEach(node => {
    const {
      reg,
      scope,
      meta: {onCopy, op, unit},
    } = node
    for (const id in reg) {
      const ref = reg[id]
      let newRef = refs.get(ref)
      if (!newRef) {
        newRef = {
          id: ref.id,
          current: ref.current, //ref.id in values ? values[ref.id] : ref.current,
        }
        refs.set(ref, newRef)
      }
      reg[id] = newRef
    }
    if (onCopy) {
      for (let j = 0; j < onCopy.length; j++) {
        scope[onCopy[j]] = findClone(scope[onCopy[j]])
      }
    }
    forEachRelatedNode(node, (node, i, siblings) => {
      siblings[i] = findClone(node)
    })
    const itemTag = op || unit
    switch (itemTag) {
      case 'store':
        node.meta.wrapped = wrapStore(node)
        break
      case 'effect':
        node.next.push(forkInFlightCounter)
        break
      case 'fx':
        scope.finally.next.push(forkInFlightCounter)
        break
      case 'watch': {
        const handler = scope.fn
        scope.fn = data => {
          stack.push(findClone)
          try {
            handler(data)
          } finally {
            stack.pop()
          }
        }
        break
      }
    }
  })

  return {
    clones,
    find: findClone,
    getState: store => findClone(store).meta.wrapped.getState(),
    graphite: createNode({
      family: {
        type: 'domain',
        links: [forkInFlightCounter, ...clones],
      },
      meta: {unit: 'fork'},
      scope: {forkInFlightCounter},
    }),
  }
  function findClone(unit) {
    unit = getGraph(unit)
    const index = list.indexOf(unit)
    if (index === -1) throwError('unit not found in forked scope')
    return clones[index]
  }
}

function wrapStore(node) {
  return {
    kind: 'store',
    getState: () => node.reg[node.scope.state.id].current,
    updates: {
      watch: bind(watchUnit, node),
    },
    graphite: node,
    family: node.family,
  }
}
function forEachRelatedNode({next, family, meta}, cb) {
  if (meta.unit === 'fork' || meta.unit === 'forkInFlightCounter') return
  next.forEach(cb)
  family.owners.forEach(cb)
  family.links.forEach(cb)
}
