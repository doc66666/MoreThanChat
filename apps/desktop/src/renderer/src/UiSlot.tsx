import { Component, isValidElement, type ReactNode } from 'react'
import type {
  RegisteredContribution,
  UiSlotContribution,
} from '@more-than-chat/plugin-runtime'
class SlotBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed
      ? (this.props.fallback ?? (
          <p className="settings-error">插件界面加载失败，可在插件面板停用。</p>
        ))
      : this.props.children
  }
}
function Contribution({
  contribution,
  context,
}: {
  contribution: UiSlotContribution
  context: unknown
}) {
  const value = contribution.render(context)
  return isValidElement(value) || typeof value === 'string' ? value : null
}
export function UiSlot({
  name,
  entries,
  context,
  fallback,
}: {
  name: string
  entries: readonly RegisteredContribution<UiSlotContribution>[]
  context: unknown
  fallback?: ReactNode
}) {
  return (
    <div className="ui-slot" data-ui-slot={name}>
      {entries
        .filter((entry) => entry.contribution.slot === name)
        .sort(
          (a, b) => (a.contribution.order ?? 0) - (b.contribution.order ?? 0),
        )
        .map((entry) => (
          <SlotBoundary
            key={entry.ownerId + ':' + entry.contribution.id}
            {...(fallback === undefined ? {} : { fallback })}
          >
            <Contribution contribution={entry.contribution} context={context} />
          </SlotBoundary>
        ))}
    </div>
  )
}
