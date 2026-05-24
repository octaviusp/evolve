import { EvolveConfig } from "../types.js";

export interface SchedulerState {
  intervalMs: number;
  lastRun: number | null;
  timerId: ReturnType<typeof setInterval> | null;
  running: boolean;
}

export interface SchedulerHandle extends SchedulerState {
  start(): void;
  stop(): void;
}

export function createScheduler(
  config: EvolveConfig,
  onTick: () => Promise<void>,
): SchedulerHandle {
  const intervalMs = config.scheduler.intervalMinutes * 60 * 1000;

  let lastRun: number | null = null;
  let timerId: ReturnType<typeof setInterval> | null = null;
  let running = false;

  function start(): void {
    if (running) return;
    running = true;

    const doRun = () => {
      lastRun = Date.now();
      void onTick().catch(() => {
        // errors in the tick handler are surfaced by the handler itself
      });
    };

    timerId = setInterval(doRun, intervalMs);
  }

  function stop(): void {
    running = false;
    if (timerId !== null) {
      clearInterval(timerId);
      timerId = null;
    }
  }

  return {
    get intervalMs() { return intervalMs; },
    get lastRun() { return lastRun; },
    get timerId() { return timerId; },
    get running() { return running; },
    start,
    stop,
  };
}
