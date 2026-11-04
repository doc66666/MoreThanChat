import { Component, isValidElement, useLayoutEffect, useState, type ReactNode } from 'react'
import type { UiSurfaceContribution, UiSurfaceRegistry } from '@more-than-chat/plugin-runtime'
import type { ComposedPluginRuntime } from '@more-than-chat/plugin-runtime'

class SurfaceBoundary extends Component<{ children: ReactNode; fallback: ReactNode; revision: number }, { failed: boolean; revision: number }> {
  state = { failed: false, revision: this.props.revision }
  static getDerivedStateFromProps(props: {revision:number}, state: {revision:number}) { return props.revision === state.revision ? null : {failed:false,revision:props.revision} }
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
export function UiSurface({ registry, name, context, children = null, path = [], composition }: {
  registry: UiSurfaceRegistry
  name: string
  context: unknown
  children?: ReactNode
  path?: readonly string[]
  composition?:Pick<ComposedPluginRuntime,'isComposing'|'subscribeComposition'>|undefined
}) {
  const [snapshot, refresh] = useState(() => ({name,registry,entries:registry.resolveAll(name)}))
  useLayoutEffect(() => {
    const update = () => { if (!composition?.isComposing) refresh({name,registry,entries:registry.resolveAll(name)}) }
    const dispose = registry.subscribe(update)
    const settled = composition?.subscribeComposition(update)
    update()
    return () => { void dispose(); void settled?.() }
  }, [registry,name,composition])
  if (path.includes(name) || path.length >= 32) return children
  const entries = snapshot.name === name && snapshot.registry === registry ? snapshot.entries : registry.resolveAll(name)
  if (!entries.length) return children
  const renderSurface = (child: string, childContext: unknown = context, fallback: unknown = null) => (
    <UiSurface registry={registry} name={child} context={childContext} path={[...path, name]} composition={composition}>{node(fallback)}</UiSurface>
  )
  return entries.reduceRight<ReactNode>((fallback, entry) => <SurfaceBoundary key={entry.ownerId+':'+entry.contribution.id} revision={identity(entry.contribution)} fallback={fallback}>
    <Render contribution={entry.contribution} context={context} defaultView={fallback} renderSurface={renderSurface} />
  </SurfaceBoundary>, children)
}
function Render({ contribution, context, defaultView, renderSurface }: {
  contribution: UiSurfaceContribution
  context: unknown
  defaultView: ReactNode
  renderSurface: (name: string, context?: unknown, fallback?: unknown) => ReactNode
}) {
  return node(contribution.render({ context, defaultView, renderSurface }))
}
