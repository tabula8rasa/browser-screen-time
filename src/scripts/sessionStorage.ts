import { calendarOf, sameCalendar } from './sessionLifecycle';
import { CalendarIdentity, ControlState, DomainRecord, HistoryQuery, HistorySnapshot, InvalidDay, ObservedWindow, OpenState, ReplacementIntent, SessionOperation, SessionRecord } from './sessionTypes';
import { validCalendar } from './sessionClock';

export const SESSION_DATABASE = 'browser-screen-time-sessions';
const stores = ['domains', 'sessions', 'metadata'];
export function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
function intervalValid(row: {start: number; end: number} & CalendarIdentity): boolean {
    return validCalendar(row) && Number.isSafeInteger(row.start) && Number.isSafeInteger(row.end) &&
        row.dayStart <= row.start && row.start <= row.end && row.end <= row.dayEnd;
}
export class SessionStorage {
    private database?: IDBDatabase;
    activeTransaction?: IDBTransaction;
    constructor(private factory: IDBFactory = globalThis.indexedDB) {}
    async open(): Promise<void> {
        if (this.database) return;
        if (!this.factory) throw new Error('IndexedDB unavailable');
        const request = this.factory.open(SESSION_DATABASE, 1);
        let rejected = false;
        this.database = await new Promise<IDBDatabase>((resolve, reject) => {
            request.onupgradeneeded = () => {
                const db = request.result;
                const domains = db.createObjectStore('domains', { keyPath: 'id', autoIncrement: true });
                domains.createIndex('byDomain', 'domain', { unique: true });
                const sessions = db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
                sessions.createIndex('byDayStart', ['dayKey', 'start']); sessions.createIndex('byStart', 'start');
                sessions.createIndex('byEnd', 'end'); sessions.createIndex('byDomainStart', ['domainId', 'start']);
                db.createObjectStore('metadata', { keyPath: 'key' });
            };
            request.onerror = () => { rejected = true; reject(request.error); };
            request.onblocked = () => { rejected = true; reject(new Error('Session database upgrade blocked')); };
            request.onsuccess = () => { if (rejected) request.result.close(); else resolve(request.result); };
        });
        const connection = this.database;
        connection.onversionchange = () => { connection.close(); if (this.database === connection) this.database = undefined; };
        if (stores.some(name => !this.database.objectStoreNames.contains(name))) { this.close(); throw new Error('Invalid session database schema'); }
    }
    close(): void { this.database?.close(); this.database = undefined; }
    abort(): void { try { this.activeTransaction?.abort(); } catch { /* Already committing/settled; outcome remains owned by its promise. */ } }
    async transaction<T>(mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>, requireStrict = false): Promise<T> {
        if (!this.database) throw new Error('Session database is closed');
        let tx: IDBTransaction;
        try { tx = this.database.transaction(stores, mode, { durability: 'strict' }); }
        catch (error) {
            if (requireStrict || !(error instanceof TypeError)) throw error;
            console.warn('Strict session durability unavailable; using default durability');
            tx = this.database.transaction(stores, mode);
        }
        if (requireStrict && tx.durability !== 'strict') { tx.abort(); throw new Error('Strict durability required for data replacement'); }
        this.activeTransaction = tx;
        const completed = new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('Session transaction aborted'));
            tx.onerror = () => {}; // Abort/completion is the authoritative transaction outcome.
        });
        try {
            let result: T;
            try { result = await work(tx); }
            catch (error) { try { tx.abort(); } catch { /* Completion owns the outcome. */ } await completed.catch(() => {}); throw error; }
            await completed; return result;
        } finally { if (this.activeTransaction === tx) this.activeTransaction = undefined; }
    }
    private async invalidate(tx: IDBTransaction, intent: ReplacementIntent): Promise<void> {
        const metadata = tx.objectStore('metadata'), sessions = tx.objectStore('sessions');
        if (intent.kind !== 'legacy-merge') {
            await Promise.all([idbRequest(sessions.clear()), idbRequest(tx.objectStore('domains').clear()), idbRequest(metadata.clear())]);
            return;
        }
        const open = await idbRequest(metadata.get('open')) as OpenState | undefined;
        if (open) { const row = await idbRequest(sessions.get(open.sessionId)) as SessionRecord | undefined; if (row && row.start === row.end) await idbRequest(sessions.delete(row.id)); }
        const days = new Set(intent.affectedDayKeys);
        const rows = await idbRequest(sessions.getAll()) as SessionRecord[];
        for (const row of rows) if (days.has(row.dayKey)) await idbRequest(sessions.delete(row.id));
        const records = await idbRequest(metadata.getAll());
        for (const record of records) {
            if (record.key === 'open' || record.key === 'control' || record.key === 'replacement' ||
                record.key.startsWith('observed:') && days.has(record.dayKey)) await idbRequest(metadata.delete(record.key));
        }
        for (const dayKey of days) await idbRequest(metadata.put({ key: `invalid-day:${dayKey}`, dayKey, reason: 'legacy-merge' }));
    }
    private async validatePersistedState(tx: IDBTransaction): Promise<{ control?: ControlState; open?: OpenState; row?: SessionRecord }> {
        const metadata = tx.objectStore('metadata');
        const control = await idbRequest(metadata.get('control')) as ControlState | undefined;
        const open = await idbRequest(metadata.get('open')) as OpenState | undefined;
        if (control && (!Number.isSafeInteger(control.lastEnd) || control.lastEnd < 0 || !Number.isSafeInteger(control.lastObservedAt) || control.lastObservedAt < 0 || !Number.isSafeInteger(control.generation) || typeof control.ownerRunId !== 'string')) throw new Error('Corrupt session control');
        const row = open ? await idbRequest(tx.objectStore('sessions').get(open.sessionId)) as SessionRecord : undefined;
        if (open && (!control || open.ownerRunId !== control.ownerRunId || open.generation !== control.generation || !row || !intervalValid(row) || row.end > control.lastEnd || !await idbRequest(tx.objectStore('domains').get(row.domainId)))) throw new Error('Corrupt open session');
        if (!control) {
            const rows = await idbRequest(tx.objectStore('sessions').getAll()) as SessionRecord[];
            const records = await idbRequest(metadata.getAll());
            if (rows.length || records.some(record => record.key.startsWith('observed:'))) throw new Error('Missing control in nonempty session database');
        }
        return { control, open, row };
    }
    async preflight(): Promise<void> {
        await this.transaction('readonly', async tx => {
            if (await idbRequest(tx.objectStore('metadata').get('replacement'))) throw new Error('History replacement recovery pending');
            await this.validatePersistedState(tx);
        });
    }
    async recover(ownerRunId: string, generation: number, now: number): Promise<void> {
        await this.transaction('readwrite', async tx => {
            const metadata = tx.objectStore('metadata');
            const intent = await idbRequest(metadata.get('replacement')) as ReplacementIntent | undefined;
            if (intent) await this.invalidate(tx, intent);
            // Intent invalidation may deliberately remove control while retaining
            // unaffected merge rows; that recovery-only case is validated below.
            let control: ControlState | undefined;
            let open: OpenState | undefined;
            let row: SessionRecord | undefined;
            if (!intent) ({ control, open, row } = await this.validatePersistedState(tx));
            else { control = await idbRequest(metadata.get('control')); open = await idbRequest(metadata.get('open')); }
            if (open) {
                if (row.start === row.end) await idbRequest(tx.objectStore('sessions').delete(row.id));
                await idbRequest(metadata.delete('open'));
            }
            if (!control) {
                const rows = await idbRequest(tx.objectStore('sessions').getAll()) as SessionRecord[];
                const records = await idbRequest(metadata.getAll());
                const windows = records.filter(row => row.key.startsWith('observed:')) as ObservedWindow[];
                if (!intent && (rows.length || windows.length)) throw new Error('Missing control in nonempty session database');
                const domains = await idbRequest(tx.objectStore('domains').getAll()) as DomainRecord[];
                const ids = new Set(domains.map(domain => domain.id));
                let lastEnd = 0;
                for (const row of rows.sort((a, b) => a.start - b.start || a.id - b.id)) {
                    if (!intervalValid(row) || row.start === row.end || !ids.has(row.domainId) || row.start < lastEnd) throw new Error('Corrupt retained session history');
                    lastEnd = row.end;
                }
                if (windows.some(window => !intervalValid(window))) throw new Error('Corrupt retained observation coverage');
                control = { key: 'control', ownerRunId, generation, lastSequence: -1, recordingSince: now,
                    lastEnd: rows.reduce((value, row) => Math.max(value, row.end), 0),
                    lastObservedAt: records.filter(row => row.key.startsWith('observed:')).reduce((value, row) => Math.max(value, row.end), 0) };
            }
            const floor = Math.max(control.lastEnd, control.lastObservedAt);
            if (floor && now > floor) await idbRequest(metadata.put({ key: `gap:${generation}:restart:${now}`, id: now, start: floor, end: now, reason: 'restart' }));
            await idbRequest(metadata.put({ key: 'control', ownerRunId, generation, lastEnd: control?.lastEnd ?? 0,
                lastObservedAt: control?.lastObservedAt ?? 0, recordingSince: control?.recordingSince ?? now, lastSequence: -1 } satisfies ControlState));
        });
    }
    async apply(owner: string, generation: number, operation: SessionOperation): Promise<{ floor: number; suppressed: boolean }> {
        return this.transaction('readwrite', async tx => {
            const metadata = tx.objectStore('metadata'), sessions = tx.objectStore('sessions'), domains = tx.objectStore('domains');
            const control = await idbRequest(metadata.get('control')) as ControlState;
            const observation = operation.observation, t = observation.wallTimestamp;
            if (!control || control.ownerRunId !== owner || control.generation !== generation || observation.historyGeneration !== generation ||
                observation.sequence <= control.lastSequence || await idbRequest(metadata.get('replacement'))) throw new Error('Stale session writer');
            let pointer = await idbRequest(metadata.get('open')) as OpenState | undefined;
            let row = pointer ? await idbRequest(sessions.get(pointer.sessionId)) as SessionRecord : undefined;
            let window = control.windowKey ? await idbRequest(metadata.get(control.windowKey)) as ObservedWindow : undefined;
            if (pointer && (!row || !intervalValid(row) || pointer.ownerRunId !== owner || pointer.generation !== generation)) throw new Error('Invalid session pointer');
            if (window && !intervalValid(window)) throw new Error('Invalid observed window');
            const saveRow = async () => { if (row) { await idbRequest(sessions.put(row)); control.lastEnd = Math.max(control.lastEnd, row.end); } };
            const closeRow = async () => {
                if (row) { if (row.start === row.end) await idbRequest(sessions.delete(row.id)); else await saveRow(); }
                await idbRequest(metadata.delete('open')); row = undefined; pointer = undefined;
            };
            const openRow = async (domainId: number, start: number, calendar: CalendarIdentity) => {
                const value = { domainId, start, end: start, ...calendar };
                const id = await idbRequest(sessions.add(value)) as number;
                row = { id, ...value }; pointer = { key: 'open', sessionId: id, ownerRunId: owner, generation, lastSequence: observation.sequence };
                await idbRequest(metadata.put(pointer)); control.lastEnd = Math.max(control.lastEnd, start);
            };
            const saveWindow = async () => {
                if (window) { await idbRequest(metadata.put(window)); control.lastObservedAt = Math.max(control.lastObservedAt, window.end); }
            };
            const openWindow = async (start: number, calendar: CalendarIdentity) => {
                window = { key: `observed:${owner}:${generation}:${observation.sequence}`, start, end: start, ...calendar };
                control.windowKey = window.key; await saveWindow();
            };
            if (operation.gap) {
                const previous = operation.previousReliable;
                if (previous) {
                    if (row && sameCalendar(row, previous) && previous.wallTimestamp >= row.end) { row.end = Math.min(previous.wallTimestamp, row.dayEnd); await saveRow(); }
                    if (window && sameCalendar(window, previous) && previous.wallTimestamp >= window.end) { window.end = Math.min(previous.wallTimestamp, window.dayEnd); await saveWindow(); }
                }
                await closeRow(); window = undefined; delete control.windowKey;
                const gapStart = Math.max(control.lastEnd, control.lastObservedAt);
                if (t > gapStart) await idbRequest(metadata.put({ key: `gap:${owner}:${observation.sequence}`, id: observation.sequence, start: gapStart, end: t, reason: operation.gap }));
            }
            const floor = Math.max(control.lastEnd, control.lastObservedAt);
            if (t < floor) {
                await closeRow(); delete control.windowKey; control.lastSequence = observation.sequence;
                await idbRequest(metadata.put(control)); return { floor, suppressed: true };
            }
            if (window && !sameCalendar(window, observation)) {
                if (window.dayEnd !== observation.dayStart || window.timeZone !== observation.timeZone) throw new Error('Missing immutable coverage calendar boundary');
                window.end = window.dayEnd; await saveWindow(); await openWindow(observation.dayStart, calendarOf(observation));
            }
            if (!window) await openWindow(t, calendarOf(observation));
            window.end = t; await saveWindow();
            if (row && !sameCalendar(row, observation)) {
                if (row.dayEnd !== observation.dayStart || row.timeZone !== observation.timeZone) throw new Error('Missing immutable session calendar boundary');
                const oldDomain = row.domainId, boundary = row.dayEnd;
                row.end = boundary; await saveRow(); await closeRow();
                if (t > boundary || observation.decision.kind === 'track') await openRow(oldDomain, boundary, calendarOf(observation));
            }
            if (row) { row.end = t; await saveRow(); }
            let requestedDomain: number | undefined;
            if (observation.decision.kind === 'track') {
                const domain = observation.decision.domain;
                let entry = await idbRequest(domains.index('byDomain').get(domain)) as DomainRecord | undefined;
                if (!entry) entry = { id: await idbRequest(domains.add({ domain })) as number, domain };
                requestedDomain = entry.id;
            }
            if (row && row.domainId !== requestedDomain) await closeRow();
            if (requestedDomain !== undefined && !row) await openRow(requestedDomain, t, calendarOf(observation));
            if (pointer) { pointer.lastSequence = observation.sequence; await idbRequest(metadata.put(pointer)); }
            control.lastSequence = observation.sequence; await idbRequest(metadata.put(control));
            return { floor: Math.max(control.lastEnd, control.lastObservedAt), suppressed: false };
        });
    }
    async prepare(intent: ReplacementIntent): Promise<void> {
        await this.transaction('readwrite', async tx => {
            if (await idbRequest(tx.objectStore('metadata').get('replacement'))) throw new Error('History replacement recovery pending');
            await this.invalidate(tx, intent);
            await idbRequest(tx.objectStore('metadata').put(intent));
        }, true);
    }
    async finalize(owner: string, generation: number, now: number, history?: HistorySnapshot, legacyDays: string[] = []): Promise<void> {
        await this.transaction('readwrite', async tx => {
            const metadata = tx.objectStore('metadata');
            if (!await idbRequest(metadata.get('replacement'))) throw new Error('Missing history replacement intent');
            let lastEnd = 0, lastObservedAt = 0;
            if (history) {
                const remap = new Map<number, number>();
                for (const domain of history.domains) remap.set(domain.id, await idbRequest(tx.objectStore('domains').add({ domain: domain.domain })) as number);
                for (const { id, ...session } of history.sessions) {
                    await idbRequest(tx.objectStore('sessions').add({ ...session, domainId: remap.get(session.domainId) })); lastEnd = Math.max(lastEnd, session.end);
                }
                for (let i = 0; i < history.observedWindows.length; i++) {
                    const window = history.observedWindows[i]; await idbRequest(metadata.put({ key: `observed:import:${generation}:${i}`, ...window })); lastObservedAt = Math.max(lastObservedAt, window.end);
                }
                for (let i = 0; i < history.coverage.length; i++) await idbRequest(metadata.put({ key: `gap:import:${generation}:${i}`, ...history.coverage[i] }));
                for (const day of history.invalidDays) await idbRequest(metadata.put({ key: `invalid-day:${day.dayKey}`, ...day }));
            } else {
                const rows = await idbRequest(tx.objectStore('sessions').getAll()) as SessionRecord[];
                lastEnd = rows.reduce((value, row) => Math.max(value, row.end), 0);
                const records = await idbRequest(metadata.getAll());
                lastObservedAt = records.filter(record => record.key.startsWith('observed:')).reduce((value, row) => Math.max(value, row.end), 0);
            }
            if (!history) for (const dayKey of legacyDays) await idbRequest(metadata.put({ key: `invalid-day:${dayKey}`, dayKey, reason: 'legacy-import' }));
            await idbRequest(metadata.delete('replacement'));
            await idbRequest(metadata.put({ key: 'control', ownerRunId: owner, generation, lastEnd, lastObservedAt,
                recordingSince: history?.recordingSince ?? now, lastSequence: -1 } satisfies ControlState));
        }, true);
    }
    async snapshot(): Promise<HistorySnapshot> {
        return this.transaction('readonly', async tx => {
            const records = await idbRequest(tx.objectStore('metadata').getAll());
            if (records.some(record => record.key === 'replacement')) throw new Error('History replacement recovery pending');
            const control = records.find(record => record.key === 'control') as ControlState | undefined;
            const domains = await idbRequest(tx.objectStore('domains').getAll()) as DomainRecord[];
            const sessions = (await idbRequest(tx.objectStore('sessions').getAll()) as SessionRecord[]).filter(row => row.start < row.end);
            return { schemaVersion: 1, status: 'partial', recordingSince: control?.recordingSince ?? null, domains, sessions,
                coverage: records.filter(row => row.key.startsWith('gap:')).map(({ key, ...row }, index) => ({ ...row, id: index + 1 })),
                observedWindows: records.filter(row => row.key.startsWith('observed:')).map(({ key, ...row }) => row),
                invalidDays: records.filter(row => row.key.startsWith('invalid-day:')).map(({ key, ...row }) => row) };
        });
    }
    async query(dayKey?: string, range?: [number, number], domainId?: number): Promise<HistoryQuery> {
        return this.transaction('readonly', async tx => {
            const metadata = await idbRequest(tx.objectStore('metadata').getAll());
            if (metadata.some(row => row.key === 'replacement')) throw new Error('History replacement recovery pending');
            const store = tx.objectStore('sessions');
            let sessions: SessionRecord[];
            if (dayKey) sessions = await idbRequest(store.index('byDayStart').getAll(IDBKeyRange.bound([dayKey, 0], [dayKey, Number.MAX_SAFE_INTEGER]))) as SessionRecord[];
            else {
                const [a, b] = range;
                const index = store.index(domainId === undefined ? 'byStart' : 'byDomainStart');
                const low = domainId === undefined ? a : [domainId, a], high = domainId === undefined ? b : [domainId, b];
                sessions = await idbRequest(index.getAll(IDBKeyRange.bound(low, high, false, true))) as SessionRecord[];
                const predecessor = await new Promise<SessionRecord | undefined>((resolve, reject) => {
                    const request = index.openCursor(domainId === undefined ? IDBKeyRange.upperBound(a, true) : IDBKeyRange.bound([domainId, 0], [domainId, a], false, true), 'prev');
                    request.onerror = () => reject(request.error); request.onsuccess = () => {
                        const cursor = request.result;
                        if (!cursor) return resolve(undefined);
                        const row = cursor.value as SessionRecord;
                        if (row.start === row.end) cursor.continue(); else resolve(row);
                    };
                });
                if (predecessor) sessions.push(predecessor);
                sessions = sessions.filter(row => row.start < b && row.end > a);
            }
            sessions = sessions.filter(row => row.start < row.end && (domainId === undefined || row.domainId === domainId)).sort((a, b) => a.start - b.start || a.id - b.id);
            const domains = await idbRequest(tx.objectStore('domains').getAll()) as DomainRecord[];
            const windows = metadata.filter(row => row.key.startsWith('observed:') && (!dayKey || row.dayKey === dayKey)) as ObservedWindow[];
            const identities = new Map<string, CalendarIdentity>();
            for (const row of [...sessions, ...windows]) identities.set(JSON.stringify(calendarOf(row)), calendarOf(row));
            const groups = Array.from(identities.values(), calendar => {
                const observed = windows.filter(row => sameCalendar(row, calendar)).sort((a, b) => a.start - b.start);
                let end = calendar.dayStart;
                for (const row of observed) { if (row.start > end) break; end = Math.max(end, row.end); }
                const invalid = metadata.some(row => row.key === `invalid-day:${calendar.dayKey}` || row.key.startsWith('gap:') && row.start < calendar.dayEnd && row.end > calendar.dayStart);
                return { ...calendar, status: (!invalid && end >= calendar.dayEnd ? 'available' : 'partial') as 'available' | 'partial' };
            });
            return { status: groups.length ? groups.every(group => group.status === 'available') ? 'available' : 'partial' : 'unavailable', sessions, domains, groups };
        });
    }
}
