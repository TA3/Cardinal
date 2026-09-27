import * as React from "react"

/** Shell-level actions that search, menus and shortcuts can all trigger. */
export interface ShellActions {
  refresh: () => void
  toggleTheme: () => void
  openShortcuts: () => void
  openGlossary: () => void
  openReport: () => void
  openActivity: () => void
  /** Opens Connect Grafana (data sources per signal, usage scan). */
  openGrafanaConnect: () => void
  openGrafanaExport: () => void
}

const noop = () => {}

export const ShellActionsContext = React.createContext<ShellActions>({
  refresh: noop,
  toggleTheme: noop,
  openShortcuts: noop,
  openGlossary: noop,
  openReport: noop,
  openActivity: noop,
  openGrafanaConnect: noop,
  openGrafanaExport: noop,
})

export function useShellActions() {
  return React.useContext(ShellActionsContext)
}
