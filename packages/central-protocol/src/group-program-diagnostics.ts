import type { Expr, GroupProgram } from './group-program.js'

/** Author-time checks, deliberately separate from wire parsing of existing approved packs. */
export function diagnoseGroupProgram(program: GroupProgram): string[] {
  const issues: string[] = []
  function walk(expr: Expr, path: string, event: boolean, item: boolean): void {
    if (issues.length >= 20 || expr === null || typeof expr !== 'object') return
    if (Array.isArray(expr)) { expr.forEach((e, i) => walk(e, `${path}[${i}]`, event, item)); return }
    if ('ref' in expr) {
      const root = String(expr.ref).split('.')[0]
      if (root === 'event' && !event) issues.push(`${path}：视图没有 event 输入；网格使用 item/index，event.cell 仅用于点击动作的 guard/updates。`)
      if ((root === 'item' || root === 'index') && !item) issues.push(`${path}：${root} 仅在网格单元格或 some/every/filter 的谓词中可用。`)
      return
    }
    const predicate = ['some', 'every', 'filter'].includes(String(expr.op))
    ;(expr.args as Expr[]).forEach((arg, i) => walk(arg, `${path}.args[${i}]`, event, item || (predicate && i === 1)))
  }
  for (const [name, action] of Object.entries(program.actions)) {
    walk(action.guard, `actions.${name}.guard`, true, false)
    action.updates.forEach((update, i) => walk(update.value, `actions.${name}.updates[${i}].value`, true, false))
  }
  program.view.texts.forEach((expr, i) => walk(expr, `view.texts[${i}]`, false, false))
  program.view.buttons.forEach((button, i) => walk(button.enabled, `view.buttons[${i}].enabled`, false, false))
  program.view.grids.forEach((grid, i) => {
    walk(grid.cells, `view.grids[${i}].cells`, false, false)
    walk(grid.label, `view.grids[${i}].label`, false, true)
    walk(grid.enabled, `view.grids[${i}].enabled`, false, true)
  })
  return issues.slice(0, 20)
}
