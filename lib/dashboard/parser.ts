/**
 * Prometheus Metrics Parser
 * Parses Prometheus text exposition format into structured data
 */

export interface ParsedMetricSample {
  name: string
  labels: Record<string, string>
  value: number | string
  timestamp: number | null
}

interface MetricAccumulator {
  name: string
  type: string | null
  help: string | null
  sampleCount: number
  labelKeys: Set<string>
  exampleSeries: ParsedMetricSample[]
  relatedMetrics: Set<string>
}

export interface ParsedMetric {
  name: string
  type: string | null
  help: string | null
  sampleCount: number
  labelKeys: string[]
  exampleSeries: ParsedMetricSample[]
  relatedMetrics: string[]
}

export interface ParsedMetricsResult {
  totalMetrics: number
  totalSamples: number
  metrics: ParsedMetric[]
}

/**
 * Parse Prometheus metrics text into structured format
 * @param {string} text - Raw Prometheus metrics text
 * @returns {Object} Parsed metrics result
 */
export function parsePrometheusMetrics(text: string): ParsedMetricsResult {
  const lines = text.split("\n")
  
  // Maps to store metadata
  const helpByName = new Map<string, string>()
  const typeByName = new Map<string, string>()
  const metricsByName = new Map<string, MetricAccumulator>()
  
  // Regex patterns
  const helpRegex = /^#\s*HELP\s+(\S+)\s+(.+)$/
  const typeRegex = /^#\s*TYPE\s+(\S+)\s+(\S+)$/
  
  for (const line of lines) {
    const trimmedLine = line.trim()
    
    // Skip empty lines
    if (!trimmedLine) continue
    
    // Parse HELP comment
    const helpMatch = trimmedLine.match(helpRegex)
    if (helpMatch) {
      helpByName.set(helpMatch[1], helpMatch[2])
      continue
    }
    
    // Parse TYPE comment
    const typeMatch = trimmedLine.match(typeRegex)
    if (typeMatch) {
      typeByName.set(typeMatch[1], typeMatch[2].toLowerCase())
      continue
    }
    
    // Skip other comments
    if (trimmedLine.startsWith("#")) continue
    
    // Parse metric sample line
    const sample = parseMetricLine(trimmedLine)
    if (!sample) continue
    
    // Determine how to group this metric
    // Check if this sample belongs to a known metric family (from HELP/TYPE)
    const metricType = typeByName.get(sample.name)
    let baseName = sample.name
    let isSubMetric = false
    
    if (metricType === "histogram" || metricType === "summary") {
      // For histogram/summary, use the declared name as-is
      baseName = sample.name
    } else if (typeByName.has(sample.name) || helpByName.has(sample.name)) {
      // If we have HELP/TYPE for this exact name, use it as-is
      baseName = sample.name
    } else {
      // Check if this is a sub-metric of a known metric (histogram bucket, etc.)
      const possibleBase = getBaseMetricName(sample.name)
      if (possibleBase !== sample.name && (typeByName.has(possibleBase) || helpByName.has(possibleBase))) {
        baseName = possibleBase
        isSubMetric = true
      } else {
        // No known parent, use as-is
        baseName = sample.name
      }
    }
    
    // Get or create metric entry
    if (!metricsByName.has(baseName)) {
      metricsByName.set(baseName, {
        name: baseName,
        type: typeByName.get(baseName) || null,
        help: helpByName.get(baseName) || null,
        sampleCount: 0,
        labelKeys: new Set(),
        exampleSeries: [],
        relatedMetrics: new Set() // For histogram/summary sub-metrics
      })
    }
    
    const metric = metricsByName.get(baseName)
    if (!metric) {
      continue
    }
    metric.sampleCount++
    
    // Track related metric names (histogram buckets, etc.)
    if (isSubMetric || sample.name !== baseName) {
      metric.relatedMetrics.add(sample.name)
    }
    
    // Collect label keys (exclude histogram 'le' and summary 'quantile' from main labels)
    for (const key of Object.keys(sample.labels)) {
      // Include all labels - they're useful context
      metric.labelKeys.add(key)
    }
    
    // Keep up to 5 example series with different label combinations
    if (metric.exampleSeries.length < 5) {
      const labelSignature = JSON.stringify(sample.labels)
      const exists = metric.exampleSeries.some(
        e => JSON.stringify(e.labels) === labelSignature
      )
      if (!exists) {
        metric.exampleSeries.push({
          name: sample.name,
          labels: sample.labels,
          value: sample.value,
          timestamp: sample.timestamp
        })
      }
    }
  }
  
  // Convert to output format
  const metrics = Array.from(metricsByName.values()).map(m => ({
    name: m.name,
    type: m.type,
    help: m.help,
    sampleCount: m.sampleCount,
    labelKeys: Array.from(m.labelKeys).sort(),
    exampleSeries: m.exampleSeries,
    relatedMetrics: Array.from(m.relatedMetrics).sort()
  }))
  
  // Sort by metric name
  metrics.sort((a, b) => a.name.localeCompare(b.name))
  
  return {
    totalMetrics: metrics.length,
    totalSamples: metrics.reduce((sum, m) => sum + m.sampleCount, 0),
    metrics
  }
}

/**
 * Parse a single metric sample line
 * @param {string} line - A metric sample line
 * @returns {Object|null} Parsed sample or null if invalid
 */
function parseMetricLine(line: string): ParsedMetricSample | null {
  // Check if line has labels (contains {)
  const braceIndex = line.indexOf("{")
  
  if (braceIndex !== -1) {
    // Metric with labels: metric_name{label1="value1",label2="value2"} value [timestamp]
    const name = line.slice(0, braceIndex).trim()
    if (!isValidMetricName(name)) return null
    
    const closeBraceIndex = findLabelsCloseBrace(line, braceIndex)
    if (closeBraceIndex === -1) return null
    
    const labelsStr = line.slice(braceIndex + 1, closeBraceIndex)
    const labels = parseLabels(labelsStr)
    
    const remainder = line.slice(closeBraceIndex + 1).trim()
    const parts = remainder.split(/\s+/)
    if (parts.length < 1 || !parts[0]) return null
    
    const value = parseValue(parts[0])
    const timestamp = parseTimestamp(parts[1])
    
    return { name, labels, value, timestamp }
  } else {
    // Metric without labels: metric_name value [timestamp]
    const parts = line.split(/\s+/)
    if (parts.length < 2) return null
    
    const name = parts[0]
    if (!isValidMetricName(name)) return null

    const value = parseValue(parts[1])
    const timestamp = parseTimestamp(parts[2])
    
    return { name, labels: {}, value, timestamp }
  }
}

function isValidMetricName(name: string): boolean {
  return /^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)
}

function findLabelsCloseBrace(line: string, openBraceIndex: number): number {
  let inQuotes = false
  let escaping = false

  for (let i = openBraceIndex + 1; i < line.length; i++) {
    const char = line[i]

    if (escaping) {
      escaping = false
      continue
    }

    if (char === "\\") {
      escaping = true
      continue
    }

    if (char === '"') {
      inQuotes = !inQuotes
      continue
    }

    if (char === "}" && !inQuotes) {
      return i
    }
  }

  return -1
}

function parseTimestamp(timestampStr?: string): number | null {
  if (!timestampStr) {
    return null
  }

  const parsed = Number(timestampStr)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Parse label string into object
 * @param {string} labelsStr - Labels string like: key1="value1",key2="value2"
 * @returns {Object} Labels object
 */
function parseLabels(labelsStr: string): Record<string, string> {
  const labels: Record<string, string> = {}
  if (!labelsStr.trim()) return labels
  
  // Handle escaped quotes and commas in label values
  // Match: key="value" patterns, handling escaped quotes
  const labelRegex = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"\s*(?:,|$)/g
  let match: RegExpExecArray | null
  
  while ((match = labelRegex.exec(labelsStr)) !== null) {
    const key = match[1]
    // Unescape the value
    const value = match[2]
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
    labels[key] = value
  }
  
  return labels
}

/**
 * Parse value string to number
 * @param {string} valueStr - Value string
 * @returns {number|string} Parsed value
 */
function parseValue(valueStr: string): number | string {
  if (valueStr === "+Inf" || valueStr === "Inf") return Infinity
  if (valueStr === "-Inf") return -Infinity
  if (valueStr === "NaN") return NaN
  
  const num = Number.parseFloat(valueStr)
  return Number.isNaN(num) ? valueStr : num
}

/**
 * Get base metric name by stripping histogram/summary suffixes
 * @param {string} name - Full metric name
 * @returns {string} Base metric name
 */
function getBaseMetricName(name: string): string {
  // Remove histogram suffixes
  const histogramSuffixes = ["_bucket", "_count", "_sum"]
  for (const suffix of histogramSuffixes) {
    if (name.endsWith(suffix)) {
      return name.slice(0, -suffix.length)
    }
  }

  return name
}

