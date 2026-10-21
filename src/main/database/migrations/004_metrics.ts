/** Metrics: time index for bounded retention pruning and windowed queries across all series. */
export const sql = `
CREATE INDEX idx_metrics_at ON metric_samples(at);
CREATE INDEX idx_metrics_series ON metric_samples(metric, device_id);
`
