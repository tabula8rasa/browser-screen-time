import { CounterData } from './counter';

export interface CalendarIdentity { dayKey: string; timeZone: string; dayStart: number; dayEnd: number }
export type SessionDecision = { kind: 'stop' } | { kind: 'track'; domain: string };
export interface SessionObservation extends CalendarIdentity {
    wallTimestamp: number; monotonicTimestamp: number; sequence: number; historyGeneration: number;
    decision: SessionDecision;
}
export type GapReason = 'storage-unavailable' | 'observation-gap' | 'clock-change' | 'timezone-change' | 'restart' | 'legacy-merge';
export interface DomainRecord { id: number; domain: string }
export interface SessionRecord extends CalendarIdentity { id: number; domainId: number; start: number; end: number }
export interface ObservedWindow extends CalendarIdentity { key: string; start: number; end: number }
export interface CoverageRecord { id: number; start: number; end: number; reason: GapReason }
export interface OpenState { key: 'open'; sessionId: number; ownerRunId: string; generation: number; lastSequence: number }
export interface ControlState {
    key: 'control'; ownerRunId: string; generation: number; lastEnd: number; lastObservedAt: number;
    recordingSince: number; windowKey?: string; lastSequence: number;
}
export interface InvalidDay { dayKey: string; reason: 'legacy-merge' | 'legacy-import' }
export type HistoryStatus = 'available' | 'partial' | 'unavailable';
export interface HistorySnapshot {
    schemaVersion: 1; status: HistoryStatus; recordingSince: number | null;
    domains: DomainRecord[]; sessions: SessionRecord[]; coverage: CoverageRecord[];
    observedWindows: Array<CalendarIdentity & { start: number; end: number }>; invalidDays: InvalidDay[];
}
export interface SessionExportV1 {
    format: 'browser-screen-time'; formatVersion: 1; exportedAt: number;
    dailyAggregates: CounterData; history: HistorySnapshot;
}
export interface HistoryQuery {
    status: HistoryStatus; sessions: SessionRecord[]; domains: DomainRecord[];
    groups: Array<CalendarIdentity & { status: HistoryStatus }>; error?: string;
}
export interface ReplacementIntent {
    key: 'replacement'; operationId: string; kind: 'reset' | 'overwrite' | 'legacy-merge';
    affectedDayKeys: string[]; beganAt: number; recovery: 'discard-affected-detail';
}
export interface SessionOperation {
    observation: SessionObservation; previousReliable?: SessionObservation; gap?: GapReason;
}
