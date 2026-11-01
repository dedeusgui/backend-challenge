/**
 * Load test report module.
 * Markdown report rendering lives in `report-renderer.ts`.
 * Run record persistence lives in `run-store.ts`.
 */
export { renderReport } from './report-renderer';
export { RUN_FILE_PATTERN, readRuns, writeRun } from './run-store';
