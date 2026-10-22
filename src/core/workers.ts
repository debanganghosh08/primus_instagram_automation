/**
 * The worker loops. Deliberately boring: claim a batch, hand each row to the
 * engine, sleep, repeat.
 *
 * The webhook route only writes an events row and returns 200. All the real
 * work happens here, so Meta's delivery never waits on us.
 *
 * Shutdown: `stop()` stops claiming new work, waits for the current tick to
 * finish, and returns. The caller then closes the DB pool.
 */
import type { Logger } from '../logger.js';
import type { Config } from '../config.js';
import type { Repository } from '../repo/repository.js';
import type { Engine } from './engine.js';

export interface WorkersDeps {
  repo: Repository;
  engine: Engine;
  cfg: Config;
  log: Logger;
  /**
   * Injectable clock. It MUST be the same clock the engine uses: the engine
   * schedules `next_attempt_at` with it and the worker decides what is due
   * with it. Two different clocks here means backoff is silently ignored.
   */
  now?: () => Date;
}

export interface TickResult {
  events: number;
  outbox: number;
}

export class Workers {
  private readonly repo: Repository;
  private readonly engine: Engine;
  private readonly cfg: Config;
  private readonly log: Logger;
  private readonly now: () => Date;

  private eventTimer: NodeJS.Timeout | undefined;
  private outboxTimer: NodeJS.Timeout | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;
  private running = false;
  private inFlight = 0;

  constructor(deps: WorkersDeps) {
    this.repo = deps.repo;
    this.engine = deps.engine;
    this.cfg = deps.cfg;
    this.log = deps.log;
    this.now = deps.now ?? (() => new Date());
  }

  /** Claim and process one batch of events. Returns how many it handled. */
  async runEventsOnce(): Promise<number> {
    const events = await this.repo.claimEvents(this.cfg.EVENT_BATCH, this.now());
    for (const event of events) {
      await this.engine.processEvent(event);
    }
    return events.length;
  }

  /** Claim and send one batch of outbox rows. Returns how many it attempted. */
  async runOutboxOnce(): Promise<number> {
    const items = await this.repo.claimOutbox(this.cfg.OUTBOX_BATCH, this.now());
    for (const item of items) {
      await this.engine.deliver(item);
    }
    return items.length;
  }

  /**
   * Drain everything until both queues are empty. Used by the tests and the
   * simulator, where we want the whole flow to have settled before asserting.
   * `maxPasses` stops a bug turning into an infinite loop.
   */
  async drain(maxPasses = 50): Promise<TickResult> {
    const total: TickResult = { events: 0, outbox: 0 };
    for (let i = 0; i < maxPasses; i++) {
      const events = await this.runEventsOnce();
      const outbox = await this.runOutboxOnce();
      total.events += events;
      total.outbox += outbox;
      if (events === 0 && outbox === 0) return total;
    }
    this.log.warn({ maxPasses }, 'drain hit its pass limit; queues may still have work');
    return total;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    const loop = (
      name: 'events' | 'outbox' | 'sweep',
      intervalMs: number,
      body: () => Promise<unknown>,
    ): NodeJS.Timeout => {
      const timer = setInterval(() => {
        if (!this.running) return;
        this.inFlight += 1;
        void body()
          .catch((e: unknown) => {
            this.log.error(
              { loop: name, err: e instanceof Error ? e.message : String(e) },
              'worker tick failed',
            );
          })
          .finally(() => {
            this.inFlight -= 1;
          });
      }, intervalMs);
      timer.unref?.();
      return timer;
    };

    this.eventTimer = loop('events', this.cfg.EVENT_POLL_MS, () => this.runEventsOnce());
    this.outboxTimer = loop('outbox', this.cfg.OUTBOX_POLL_MS, () => this.runOutboxOnce());
    // Housekeeping is cheap and rare: once a minute is plenty.
    this.sweepTimer = loop('sweep', 60_000, () => this.engine.sweepIdle());
    this.log.info(
      { eventPollMs: this.cfg.EVENT_POLL_MS, outboxPollMs: this.cfg.OUTBOX_POLL_MS },
      'workers started',
    );
  }

  /** Stop claiming work and wait for in-flight ticks (bounded). */
  async stop(timeoutMs = 10_000): Promise<void> {
    this.running = false;
    if (this.eventTimer) clearInterval(this.eventTimer);
    if (this.outboxTimer) clearInterval(this.outboxTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.eventTimer = undefined;
    this.outboxTimer = undefined;
    this.sweepTimer = undefined;

    const deadline = Date.now() + timeoutMs;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    if (this.inFlight > 0) {
      this.log.warn({ inFlight: this.inFlight }, 'shutting down with work still in flight');
    } else {
      this.log.info('workers stopped cleanly');
    }
  }
}
