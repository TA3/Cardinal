import { selfHostedServer } from "@/lib/sources/transport"
import { useAppStore } from "@/lib/store/app-store"
import { useServerStore } from "@/lib/store/server-store"

/**
 * Asks this page's own server whether it is a self-hosted `cardinal` server.
 * If so, its proxy reaches private hosts, so connections not set up yet
 * default to proxy mode.
 */
export async function detectServer() {
  const server = await selfHostedServer()
  useServerStore.getState().setServer(server)
  if (!server) return
  const app = useAppStore.getState()
  if (!app.settings.baseUrl.trim() && app.settings.mode === "direct") app.updateSettings({ mode: "proxy" })
  if (!app.logsSettings.baseUrl.trim() && app.logsSettings.mode === "direct") app.updateLogsSettings({ mode: "proxy" })
  if (!app.grafanaSettings.baseUrl.trim() && app.grafanaSettings.mode === "direct") app.updateGrafanaSettings({ mode: "proxy" })
}
