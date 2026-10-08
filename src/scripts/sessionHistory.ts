import { captureObservation, continuityGap, SessionClockAdapter, systemSessionClock } from './sessionClock';
import { sameCalendar, sameDecision, validCalendarTransition } from './sessionLifecycle';
import { SessionStorage } from './sessionStorage';
import { HistoryQuery, HistorySnapshot, ReplacementIntent, SessionDecision, SessionObservation, SessionOperation } from './sessionTypes';

export class HistoryTimeout extends Error {}
export class ReplacementPendingError extends Error {}
export class SessionHistory {
    private owner = globalThis.crypto?.randomUUID?.() ?? `run-${Date.now()}-${Math.random()}`;
    private generation = 0;
    private sequence = 0;
    private previous?: SessionObservation;
    private latest: SessionDecision = { kind: 'stop' };
    private queue: Promise<void> = Promise.resolve();
    private pendingOutcomes = new Set<Promise<unknown>>();
    private ready = false;
    private stopped = true;
    private replacing = 0;
    private replacementRecoveryPending = false;
    private recoveryPending = false;
    private initialization?: Promise<void>;
    private pendingCount = 0;
    private oldestQueuedAt?: number;
    private checkpointPending = false;
    private checkpointAt = 0;
    private suppressedFloor?: number;
    private retryIndex = 0;
    private retryTimer?: ReturnType<typeof setTimeout>;
    private maintenance?: ReturnType<typeof setInterval>;
    private error?: string;
    constructor(readonly storage = new SessionStorage(), private clock: SessionClockAdapter = systemSessionClock) {}
    start(): void {
        if (!this.stopped) return; this.stopped = false;
        this.maintenance = setInterval(() => this.sample(), 1000);
        this.initialization = this.initialize();
    }
    stop(): void {
        this.stopped = true;
        clearInterval(this.maintenance); clearTimeout(this.retryTimer); this.generation++; this.ready = false;
        this.storage.abort(); this.storage.close();
    }
    observe(decision: SessionDecision): void { this.latest = { ...decision }; this.sample(); }
    private capture(): SessionObservation { return captureObservation(this.clock, this.latest, ++this.sequence, this.generation); }
    private fail(error: unknown): void {
        this.ready = false; this.previous = undefined; this.generation++; this.checkpointPending = false;
        this.error = String((error as Error)?.message ?? error); this.storage.abort();
        console.warn('Session history unavailable', this.error);
        this.scheduleRecovery();
    }
    private scheduleRecovery(): void {
        if (this.stopped || this.replacing || this.retryTimer || this.recoveryPending || this.pendingOutcomes.size) return;
        const delay = [1000, 5000, 30000, 60000][this.retryIndex++];
        if (delay === undefined) return;
        this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.initialization = this.initialize(); }, delay);
    }
    private async bounded<T>(work: Promise<T>, budget = 10000): Promise<T> {
        this.pendingOutcomes.add(work);
        let timer: ReturnType<typeof setTimeout>;
        const settled = work.finally(() => {
            this.pendingOutcomes.delete(work);
            if (!this.ready) this.scheduleRecovery();
        });
        // Attach a rejection handler even if the timeout wins; settlement still
        // remains the only permission to start another database writer.
        void settled.catch(() => {});
        try { return await Promise.race([work, new Promise<T>((_, reject) => {
            timer = setTimeout(() => { this.storage.abort(); reject(new HistoryTimeout('Session storage did not settle within 10 seconds')); }, budget);
        })]); } finally { clearTimeout(timer); }
    }
    private async initialize(): Promise<void> {
        if (this.stopped || this.replacing || this.pendingOutcomes.size || this.recoveryPending) return;
        this.recoveryPending = true; this.ready = false; this.previous = undefined;
        const generation = ++this.generation;
        const actual = (async () => {
            this.storage.close(); await this.storage.open();
            if (generation !== this.generation || this.replacing) { this.storage.close(); return; }
            await this.storage.recover(this.owner, generation, this.clock.wall());
        })();
        try {
            await this.bounded(actual);
            if (generation !== this.generation || this.replacing) return;
            this.ready = true; this.replacementRecoveryPending = false; this.error = undefined; this.retryIndex = 0; this.checkpointAt = this.clock.wall(); this.suppressedFloor = undefined;
            this.sample(true);
        } catch (error) { this.fail(error); }
        finally { this.recoveryPending = false; if (!this.ready) this.scheduleRecovery(); }
    }
    private sample(force = false): void {
        if (this.stopped || !this.ready || this.replacing) return;
        let observation: SessionObservation;
        try { observation = this.capture(); } catch (error) { this.fail(error); return; }
        const previous = this.previous;
        let gap = previous && continuityGap(previous, observation);
        if (previous && !gap && !validCalendarTransition(previous, observation)) gap = 'observation-gap';
        const transition = !previous || !sameDecision(previous.decision, observation.decision);
        const boundary = previous && !sameCalendar(previous, observation);
        this.previous = observation;
        const checkpoint = observation.wallTimestamp - this.checkpointAt >= 30000;
        const resumed = this.suppressedFloor !== undefined && observation.wallTimestamp >= this.suppressedFloor;
        if (!force && !gap && !transition && !boundary && !resumed && (!checkpoint || this.checkpointPending)) return;
        const operation: SessionOperation = { observation, ...(gap ? { gap, previousReliable: previous } : {}) };
        const onlyCheckpoint = !force && !transition && !boundary && !gap && !resumed;
        if (onlyCheckpoint) this.checkpointPending = true;
        this.enqueue(operation, onlyCheckpoint);
    }
    private enqueue(operation: SessionOperation, checkpoint: boolean): void {
        const generation = this.generation;
        if (this.pendingCount >= 1000 || this.oldestQueuedAt !== undefined && this.clock.mono() - this.oldestQueuedAt > 60000) {
            this.fail(new Error('Session observation queue exceeded its capacity')); return;
        }
        this.pendingCount++; this.oldestQueuedAt ??= this.clock.mono();
        const run = this.queue.then(async () => {
            if (generation !== this.generation || !this.ready || this.replacing) return;
            if (this.clock.mono() - this.oldestQueuedAt > 60000) throw new Error('Session observation queue exceeded its age');
            const result = await this.bounded(this.storage.apply(this.owner, generation, operation));
            if (generation !== this.generation || !this.ready || this.replacing) return;
            this.checkpointAt = operation.observation.wallTimestamp;
            this.suppressedFloor = result.suppressed ? result.floor : undefined;
        });
        this.queue = run.catch(error => { if (generation === this.generation) this.fail(error); }).finally(() => {
            this.pendingCount--; if (!this.pendingCount) this.oldestQueuedAt = undefined;
            if (checkpoint && generation === this.generation) this.checkpointPending = false;
        });
    }
    // Fence synchronously on message receipt, including requests queued behind
    // another replacement. No stale queued operation can publish after this.
    fenceReplacement(): void {
        this.replacing++; this.ready = false; this.generation++; this.previous = undefined;
        clearTimeout(this.retryTimer); this.retryTimer = undefined; this.storage.abort();
    }
    async preflight(): Promise<void> {
        try {
        if (this.replacementRecoveryPending) throw new ReplacementPendingError('History replacement recovery pending');
        const generation = this.generation;
        const started = performance.now();
        if (this.pendingOutcomes.size) await this.bounded(Promise.allSettled(Array.from(this.pendingOutcomes)));
        await this.bounded(this.queue, Math.max(1, 10000 - (performance.now() - started)));
        if (this.recoveryPending) throw new Error('Session initialization remains unsettled');
        // Opening/recovering storage is permitted only after the previous writer
        // settles. Recovery never changes daily data.
        await this.bounded((async () => {
            await this.storage.open();
            if (generation !== this.generation || !this.replacing) { this.storage.close(); throw new Error('Canceled history preflight'); }
            // Do not silently consume a pending intent before another destructive
            // request; require independent history recovery first.
            await this.storage.preflight();
        })(), Math.max(1, 10000 - (performance.now() - started)));
        } catch (error) { this.fail(error); throw error; }
    }
    async prepare(intent: ReplacementIntent): Promise<void> {
        this.replacementRecoveryPending = true;
        try { await this.bounded(this.storage.prepare(intent)); }
        catch (error) { this.fail(error); throw error; }
    }
    async finalize(history?: HistorySnapshot, legacyDays: string[] = []): Promise<void> {
        try { await this.bounded(this.storage.finalize(this.owner, this.generation, this.clock.wall(), history, legacyDays)); this.replacementRecoveryPending = false; }
        catch (error) { this.fail(error); throw error; }
    }
    async cleanupReplacement(): Promise<void> {
        if (this.pendingOutcomes.size) return; // An unknown outcome forbids a second writer.
        try { await this.bounded(this.storage.recover(this.owner, this.generation, this.clock.wall())); this.replacementRecoveryPending = false; }
        catch (error) { this.fail(error); }
    }
    releaseReplacement(): void {
        this.replacing = Math.max(0, this.replacing - 1);
        if (!this.stopped && !this.replacing) { this.retryIndex = 0; if (!this.pendingOutcomes.size) this.initialization = this.initialize(); }
    }
    async exportSnapshot(): Promise<HistorySnapshot> {
        if (this.replacing || this.replacementRecoveryPending) throw new ReplacementPendingError('History replacement recovery pending');
        if (!this.ready) throw new Error(this.error ?? 'Session history unavailable');
        this.sample(true);
        await this.bounded(this.queue);
        if (!this.ready || this.replacing) throw new Error('Session history unavailable');
        return this.bounded(this.storage.snapshot());
    }
    async query(dayKey?: string, range?: [number, number], domainId?: number): Promise<HistoryQuery> {
        if (!this.ready || this.replacing) return { status: 'unavailable', sessions: [], domains: [], groups: [], error: this.error ?? 'History unavailable' };
        if (dayKey && !/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) throw new Error('Invalid history date');
        if (!dayKey && (!range || !Number.isSafeInteger(range[0]) || !Number.isSafeInteger(range[1]) || range[0] < 0 || range[0] >= range[1])) throw new Error('Invalid history range');
        if (domainId !== undefined && (!Number.isSafeInteger(domainId) || domainId < 1)) throw new Error('Invalid history domain');
        try { return await this.bounded(this.storage.query(dayKey, range, domainId)); }
        catch (error) { this.fail(error); return { status: 'unavailable', sessions: [], domains: [], groups: [], error: this.error }; }
    }
    async settled(): Promise<void> { await this.initialization; await this.queue; }
}
