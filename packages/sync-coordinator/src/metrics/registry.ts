/**
 * Metrics registry - collects and formats Prometheus metrics.
 */

import {
  type Metric,
  type CounterMetric,
  type GaugeMetric,
  type HistogramMetric,
  DEFAULT_DURATION_BUCKETS,
} from './types.js';

/**
 * Serialize labels to a string key.
 */
function labelsToKey(labels: Record<string, string>): string {
  if (Object.keys(labels).length === 0) return '';
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
    .join(',');
}

/**
 * Format labels for Prometheus output.
 */
function formatLabels(labelKey: string): string {
  return labelKey ? `{${labelKey}}` : '';
}

/**
 * Metrics registry for collecting and exporting metrics.
 */
export class MetricsRegistry {
  private metrics = new Map<string, Metric>();

  /**
   * Register a counter metric.
   */
  registerCounter(name: string, help: string): CounterMetric {
    const metric: CounterMetric = {
      name,
      help,
      type: 'counter',
      values: new Map(),
    };
    this.metrics.set(name, metric);
    return metric;
  }

  /**
   * Register a gauge metric.
   */
  registerGauge(name: string, help: string): GaugeMetric {
    const metric: GaugeMetric = {
      name,
      help,
      type: 'gauge',
      values: new Map(),
    };
    this.metrics.set(name, metric);
    return metric;
  }

  /**
   * Register a histogram metric.
   */
  registerHistogram(
    name: string,
    help: string,
    buckets: number[] = DEFAULT_DURATION_BUCKETS
  ): HistogramMetric {
    const metric: HistogramMetric = {
      name,
      help,
      type: 'histogram',
      values: new Map(),
      bucketBoundaries: [...buckets].sort((a, b) => a - b),
    };
    this.metrics.set(name, metric);
    return metric;
  }

  /**
   * Increment a counter.
   */
  incCounter(metric: CounterMetric, labels: Record<string, string> = {}, value = 1): void {
    const key = labelsToKey(labels);
    metric.values.set(key, (metric.values.get(key) || 0) + value);
  }

  /**
   * Set a gauge value.
   */
  setGauge(metric: GaugeMetric, value: number, labels: Record<string, string> = {}): void {
    const key = labelsToKey(labels);
    metric.values.set(key, value);
  }

  /**
   * Increment a gauge.
   */
  incGauge(metric: GaugeMetric, labels: Record<string, string> = {}, value = 1): void {
    const key = labelsToKey(labels);
    metric.values.set(key, (metric.values.get(key) || 0) + value);
  }

  /**
   * Decrement a gauge.
   */
  decGauge(metric: GaugeMetric, labels: Record<string, string> = {}, value = 1): void {
    const key = labelsToKey(labels);
    metric.values.set(key, (metric.values.get(key) || 0) - value);
  }

  /**
   * Observe a value in a histogram.
   */
  observeHistogram(
    metric: HistogramMetric,
    value: number,
    labels: Record<string, string> = {}
  ): void {
    const key = labelsToKey(labels);
    let hist = metric.values.get(key);

    if (!hist) {
      hist = {
        buckets: metric.bucketBoundaries.map(le => ({ le, count: 0 })),
        sum: 0,
        count: 0,
      };
      metric.values.set(key, hist);
    }

    hist.sum += value;
    hist.count += 1;

    for (const bucket of hist.buckets) {
      if (value <= bucket.le) {
        bucket.count += 1;
      }
    }
  }

  /**
   * Start a timer for a histogram observation.
   */
  startTimer(metric: HistogramMetric, labels: Record<string, string> = {}): () => void {
    const start = performance.now();
    return () => {
      const duration = (performance.now() - start) / 1000; // Convert to seconds
      this.observeHistogram(metric, duration, labels);
    };
  }

  /**
   * Format all metrics as Prometheus text format.
   */
  format(): string {
    const lines: string[] = [];

    for (const metric of this.metrics.values()) {
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);

      if (metric.type === 'counter' || metric.type === 'gauge') {
        for (const [labelKey, value] of metric.values) {
          lines.push(`${metric.name}${formatLabels(labelKey)} ${value}`);
        }
      } else if (metric.type === 'histogram') {
        for (const [labelKey, hist] of metric.values) {
          const labelPrefix = labelKey ? `${labelKey},` : '';
          for (const bucket of hist.buckets) {
            lines.push(`${metric.name}_bucket{${labelPrefix}le="${bucket.le}"} ${bucket.count}`);
          }
          lines.push(`${metric.name}_bucket{${labelPrefix}le="+Inf"} ${hist.count}`);
          lines.push(`${metric.name}_sum${formatLabels(labelKey)} ${hist.sum}`);
          lines.push(`${metric.name}_count${formatLabels(labelKey)} ${hist.count}`);
        }
      }

      lines.push('');
    }

    return lines.join('\n');
  }
}

/** Global metrics registry instance. */
export const globalRegistry = new MetricsRegistry();

