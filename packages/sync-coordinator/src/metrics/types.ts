/**
 * Metrics types and interfaces.
 */

/**
 * Histogram bucket for timing metrics.
 */
export interface HistogramBucket {
  le: number; // "less than or equal"
  count: number;
}

/**
 * A histogram metric with buckets.
 */
export interface Histogram {
  buckets: HistogramBucket[];
  sum: number;
  count: number;
}

/**
 * Labels for categorizing metrics.
 */
export interface MetricLabels {
  [key: string]: string;
}

/**
 * Counter metric - monotonically increasing value.
 */
export interface CounterMetric {
  name: string;
  help: string;
  type: 'counter';
  values: Map<string, number>; // labelKey -> value
}

/**
 * Gauge metric - value that can go up and down.
 */
export interface GaugeMetric {
  name: string;
  help: string;
  type: 'gauge';
  values: Map<string, number>;
}

/**
 * Histogram metric - distribution of values.
 */
export interface HistogramMetric {
  name: string;
  help: string;
  type: 'histogram';
  values: Map<string, Histogram>;
  bucketBoundaries: number[];
}

export type Metric = CounterMetric | GaugeMetric | HistogramMetric;

/**
 * Default histogram buckets for timing (in seconds).
 */
export const DEFAULT_DURATION_BUCKETS = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10
];

/**
 * Default histogram buckets for sizes (in bytes/items).
 */
export const DEFAULT_SIZE_BUCKETS = [
  1, 10, 50, 100, 500, 1000, 5000, 10000, 50000, 100000
];

