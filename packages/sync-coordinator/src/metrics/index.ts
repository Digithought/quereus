/**
 * Metrics module exports.
 */

export {
  type Histogram,
  type HistogramBucket,
  type MetricLabels,
  type CounterMetric,
  type GaugeMetric,
  type HistogramMetric,
  type Metric,
  DEFAULT_DURATION_BUCKETS,
  DEFAULT_SIZE_BUCKETS,
} from './types.js';

export {
  MetricsRegistry,
  globalRegistry,
} from './registry.js';

export {
  createCoordinatorMetrics,
  type CoordinatorMetrics,
} from './coordinator-metrics.js';

