export interface Clock {
  sleep(delayMs: number): Promise<void>;
}

export const systemClock: Clock = {
  sleep(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  },
};

export interface ReconnectPolicyOptions {
  baseDelayMs?: number;
  multiplier?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  random?: () => number;
  clock?: Clock;
}

export class ReconnectPolicy {
  private readonly baseDelayMs: number;
  private readonly multiplier: number;
  private readonly maxDelayMs: number;
  private readonly jitterRatio: number;
  private readonly random: () => number;
  private readonly clock: Clock;

  constructor(options: ReconnectPolicyOptions = {}) {
    this.baseDelayMs = options.baseDelayMs ?? 800;
    this.multiplier = options.multiplier ?? 1.7;
    this.maxDelayMs = options.maxDelayMs ?? 15_000;
    this.jitterRatio = options.jitterRatio ?? 0.2;
    this.random = options.random ?? Math.random;
    this.clock = options.clock ?? systemClock;
  }

  delay(attempt: number): number {
    const boundedAttempt = Math.max(0, Math.floor(attempt));
    const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * this.multiplier ** boundedAttempt);
    const jitter = 1 + (this.random() - 0.5) * 2 * this.jitterRatio;
    return Math.min(this.maxDelayMs, Math.round(exponential * jitter));
  }

  startupDelay(retryAfterMs: number): number {
    return Math.min(2_000, Math.max(100, Math.round(retryAfterMs)));
  }

  wait(attempt: number): Promise<void> {
    return this.clock.sleep(this.delay(attempt));
  }

  waitForStartup(retryAfterMs: number): Promise<void> {
    return this.clock.sleep(this.startupDelay(retryAfterMs));
  }
}

export interface SequenceGap {
  expected: number;
  received: number;
}

export type SequenceDecision = "accepted" | "duplicate" | "gap" | "desynced";

export class SequenceGapDetector {
  private lastSequence: number | undefined;
  private desynced = false;

  constructor(private readonly onResyncRequired: (gap: SequenceGap) => void) {}

  get isDesynced(): boolean {
    return this.desynced;
  }

  observe(sourceSequence: number): SequenceDecision {
    if (this.desynced) return "desynced";
    if (this.lastSequence === undefined) {
      this.lastSequence = sourceSequence;
      return "accepted";
    }
    if (sourceSequence <= this.lastSequence) return "duplicate";
    const expected = this.lastSequence + 1;
    if (sourceSequence === expected) {
      this.lastSequence = sourceSequence;
      return "accepted";
    }
    this.desynced = true;
    this.onResyncRequired({ expected, received: sourceSequence });
    return "gap";
  }

  reset(sourceSequence?: number): void {
    this.lastSequence = sourceSequence;
    this.desynced = false;
  }
}
