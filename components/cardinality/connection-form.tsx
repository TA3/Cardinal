"use client"

import { ChevronRight, Search, Settings2Icon, Trash2 } from "lucide-react"
import type { PrometheusConnectionInput } from "@/lib/prometheus/types"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useState } from "react"

interface ConnectionFormProps {
  baseUrl: string
  setBaseUrl: (v: string) => void
  instanceId: string
  setInstanceId: (v: string) => void
  token: string
  setToken: (v: string) => void
  rememberConnection: boolean
  setRememberConnection: (v: boolean) => void
  proxyMode: boolean
  setProxyMode: (v: boolean) => void
  topN: number
  setTopN: (v: number) => void
  isLoadingSnapshot: boolean
  hasSnapshot: boolean
  connection: PrometheusConnectionInput | null
  onSubmit: () => void
  onCollapse: () => void
  onDisconnect: () => void
}

export function ConnectionForm({
  baseUrl,
  setBaseUrl,
  instanceId,
  setInstanceId,
  token,
  setToken,
  rememberConnection,
  setRememberConnection,
  proxyMode,
  setProxyMode,
  topN,
  setTopN,
  isLoadingSnapshot,
  hasSnapshot,
  connection,
  onSubmit,
  onCollapse,
  onDisconnect,
}: ConnectionFormProps) {
  const [showOptions, setShowOptions] = useState(false)
  return (
    <Card className="shadow-none rounded-lg">
      <CardHeader>
        <p className="text-xs uppercase tracking-wider text-muted-foreground pb-2">
          Configuration
        </p>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="font-heading">Connection</CardTitle>
            <CardDescription>
              Optional basic auth — instance ID and token only needed for
              protected endpoints.
            </CardDescription>
          </div>
          {hasSnapshot ? (
            <Button variant="ghost" size="sm" onClick={onCollapse}>
              <ChevronRight className="size-4" />
              Collapse
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <FieldGroup className="flex flex-row justify-center gap-2 items-end">
          <Field>
            <FieldLabel htmlFor="base-url">Prometheus base URL</FieldLabel>
            <FieldContent>
              <Input
                id="base-url"
                placeholder="https://prometheus.example.com"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </FieldContent>
          </Field>
          <Button variant="outline" size="icon-lg" onClick={() => setShowOptions(!showOptions)}>
            <Settings2Icon />
          </Button>
        </FieldGroup>
        {showOptions ? (
          <FieldGroup>
            <Field orientation="responsive">
              <Field>
                <FieldLabel htmlFor="instance-id">
                  Instance ID{" "}
                  <span className="text-muted-foreground">(optional)</span>
                </FieldLabel>
                <FieldContent>
                  <Input
                    id="instance-id"
                    autoComplete="off"
                    placeholder="your-instance-id"
                    value={instanceId}
                    onChange={(e) => setInstanceId(e.target.value)}
                  />
                </FieldContent>
              </Field>
              <Field>
                <FieldLabel htmlFor="token">
                  Token{" "}
                  <span className="text-muted-foreground">(optional)</span>
                </FieldLabel>
                <FieldContent>
                  <Input
                    id="token"
                    type="password"
                    autoComplete="off"
                    placeholder="••••••••"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                  />
                </FieldContent>
              </Field>
            </Field>
            <Field orientation="horizontal">
              <Checkbox
                id="remember-connection"
                checked={rememberConnection}
                onCheckedChange={(checked) =>
                  setRememberConnection(Boolean(checked))
                }
              />
              <FieldContent>
                <FieldLabel htmlFor="remember-connection">
                  Remember connection in localStorage
                </FieldLabel>
                <FieldDescription>
                  Stores base URL and optional credentials in this browser.
                </FieldDescription>
              </FieldContent>
            </Field>
            <Field orientation="horizontal">
              <Checkbox
                id="proxy-mode"
                checked={proxyMode}
                onCheckedChange={(checked) => setProxyMode(Boolean(checked))}
              />
              <FieldContent>
                <FieldLabel htmlFor="proxy-mode">
                  Route through server proxy
                </FieldLabel>
                <FieldDescription>
                  Required for Mimir and Grafana Cloud to bypass CORS restrictions.
                </FieldDescription>
              </FieldContent>
            </Field>
            <Field orientation="responsive">
              <Field>
                <FieldLabel htmlFor="top-n">Top N metrics</FieldLabel>
                <FieldContent>
                  <Input
                    id="top-n"
                    type="number"
                    min={1}
                    max={100}
                    value={topN}
                    onChange={(e) =>
                      setTopN(
                        Math.max(1, Math.min(100, Number(e.target.value) || 20))
                      )
                    }
                    className="w-28"
                  />
                </FieldContent>
              </Field>
            </Field>
          </FieldGroup>
        ) : null}

        <div className="flex flex-wrap gap-3">
          <Button
            onClick={onSubmit}
            disabled={isLoadingSnapshot || !connection}
          >
            <Search data-icon="inline-start" />
            {isLoadingSnapshot ? "Analyzing…" : "Analyze snapshot"}
          </Button>
          {hasSnapshot ? (
            <Button variant="ghost" onClick={onDisconnect}>
              <Trash2 data-icon="inline-start" />
              Clear session
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}
