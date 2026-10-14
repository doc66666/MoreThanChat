import { Component, isValidElement, useLayoutEffect, useState, type ReactNode } from 'react'
import type { UiSurfaceContribution, UiSurfaceRegistry } from '@more-than-chat/plugin-runtime'

class SurfaceBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}
const identities = new WeakMap<UiSurfaceContribution, number>()
let nextIdentity = 0
function identity(value: UiSurfaceContribution) {
  if (!identities.has(value)) identities.set(value, ++nextIdentity)
  return identities.get(value)!
}
function node(value: unknown): ReactNode {
  if (value == null || typeof value === 'boolean') return null
  if (isValidElement(value) || typeof value === 'string' || typeof value === 'number') return value
  if (Array.isArray(value)) return value.map(node)
  throw new Error('UI plugins must return React nodes.')
}

/** Trusted executable UI only. This is composition and error recovery, not a JS sandbox. */
export function UiSurface({ registry, name, context, children = null, path = [] }: {
  registry: UiSurfaceRegistry
  name: string
  context: unknown
  children?: ReactNode
  path?: readonly string[]
}) {
  const [, refresh] = useState(0)
  useLayoutEffect(() => {
    const dispose = registry.subscribe(() => refresh(value => value + 1))
    refresh(value => value + 1)
    return () => { void dispose() }
  }, [registry])
  if (path.includes(name) || path.length >= 32) return children
  const winner = registry.resolve(name)
  if (!winner) return children
  const renderSurface = (child: string, childContext: unknown = context, fallback: unknown = null) => (
    <UiSurface registry={registry} name={child} context={childContext} path={[...path, name]}>{node(fallback)}</UiSurface>
  )
  return <SurfaceBoundary key={identity(winner.contribution)} fallback={children}>
    <Render contribution={winner.contribution} context={context} defaultView={children} renderSurface={renderSurface} />
  </SurfaceBoundary>
}
function Render({ contribution, context, defaultView, renderSurface }: {
  contribution: UiSurfaceContribution
  context: unknown
  defaultView: ReactNode
  renderSurface: (name: string, context?: unknown, fallback?: unknown) => ReactNode
}) {
  return node(contribution.render({ context, defaultView, renderSurface }))
}
