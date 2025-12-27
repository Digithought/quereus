/**
 * Tests for metrics registry.
 */

import { expect } from 'chai';
import { MetricsRegistry } from '../src/metrics/registry.js';

describe('MetricsRegistry', () => {
  let registry: MetricsRegistry;

  beforeEach(() => {
    registry = new MetricsRegistry();
  });

  describe('Counter', () => {
    it('should increment counter', () => {
      const counter = registry.registerCounter('test_counter', 'A test counter');
      registry.incCounter(counter);
      registry.incCounter(counter);
      registry.incCounter(counter, {}, 5);

      const output = registry.format();
      expect(output).to.include('test_counter 7');
    });

    it('should handle labels', () => {
      const counter = registry.registerCounter('test_counter', 'A test counter');
      registry.incCounter(counter, { status: 'success' });
      registry.incCounter(counter, { status: 'error' }, 2);

      const output = registry.format();
      expect(output).to.include('test_counter{status="success"} 1');
      expect(output).to.include('test_counter{status="error"} 2');
    });
  });

  describe('Gauge', () => {
    it('should set gauge value', () => {
      const gauge = registry.registerGauge('test_gauge', 'A test gauge');
      registry.setGauge(gauge, 42);

      const output = registry.format();
      expect(output).to.include('test_gauge 42');
    });

    it('should increment and decrement gauge', () => {
      const gauge = registry.registerGauge('test_gauge', 'A test gauge');
      registry.incGauge(gauge);
      registry.incGauge(gauge);
      registry.decGauge(gauge);

      const output = registry.format();
      expect(output).to.include('test_gauge 1');
    });
  });

  describe('Histogram', () => {
    it('should observe values', () => {
      const hist = registry.registerHistogram('test_hist', 'A test histogram', [0.1, 0.5, 1.0]);
      registry.observeHistogram(hist, 0.05);
      registry.observeHistogram(hist, 0.3);
      registry.observeHistogram(hist, 0.8);

      const output = registry.format();
      expect(output).to.include('test_hist_bucket{le="0.1"} 1');
      expect(output).to.include('test_hist_bucket{le="0.5"} 2');
      expect(output).to.include('test_hist_bucket{le="1"} 3');
      expect(output).to.include('test_hist_bucket{le="+Inf"} 3');
      expect(output).to.include('test_hist_count 3');
    });

    it('should track sum', () => {
      const hist = registry.registerHistogram('test_hist', 'A test histogram', [1, 10]);
      registry.observeHistogram(hist, 5);
      registry.observeHistogram(hist, 7);

      const output = registry.format();
      expect(output).to.include('test_hist_sum 12');
    });
  });

  describe('Timer', () => {
    it('should measure duration', async () => {
      const hist = registry.registerHistogram('test_duration', 'Duration');
      const end = registry.startTimer(hist);

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 10));
      end();

      const output = registry.format();
      expect(output).to.include('test_duration_count 1');
      // Sum should be > 0 (some milliseconds)
      expect(output).to.match(/test_duration_sum [0-9.]+/);
    });
  });

  describe('format', () => {
    it('should output Prometheus format', () => {
      const counter = registry.registerCounter('http_requests', 'Total HTTP requests');
      registry.incCounter(counter, { method: 'GET', path: '/api' }, 100);

      const output = registry.format();
      expect(output).to.include('# HELP http_requests Total HTTP requests');
      expect(output).to.include('# TYPE http_requests counter');
      expect(output).to.include('http_requests{method="GET",path="/api"} 100');
    });
  });
});

