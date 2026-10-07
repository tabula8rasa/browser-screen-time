import { CounterDailyData } from "./counter";

export interface WebsiteData {
    time: number,
    color: string,
    url: string,
    percentage: number
}

export interface WebsiteMap {
    // Url         Time
    [key: string]: number
}

export type CounterTimespanInterval = [Date, Date];

export interface CounterTimespanData {
    interval: CounterTimespanInterval,
    name: string,
    fullName: string
}

export interface MsgEvent {
    type: string
}

// Content reports facts only. Tab/frame/document identity comes from Firefox.
export const MEDIA_PORT = 'browser-screen-time:media';
export interface MediaElementState {
    elementId: string;
    playing: boolean;
    muted: boolean;
    volume: number;
}
export type MediaMessage =
    | { type: 'media:hello'; token: string }
    | { type: 'media:snapshot'; elements: MediaElementState[] }
    | { type: 'media:element'; element: MediaElementState }
    | { type: 'media:removed'; elementId: string };
export type MediaBackgroundMessage =
    | { type: 'media:accepted' }
    | { type: 'media:settings'; enabled: boolean };
export interface MediaDocumentIdentity {
    tabId: number;
    frameId: number;
    documentId: string;
}
export interface ActiveTrackingTab {
    id: number;
    windowId: number;
    url: string;
}
export interface TrackingState {
    focusedWindowId: number | null;
    activeTab: ActiveTrackingTab | null;
    idle: boolean;
    idleInitialized: boolean;
    mediaEnabled: boolean;
}

export type SettingsDataType = boolean | string;

export interface SettingsData {
    [key: string]: SettingsDataType
}

export interface SettingsChangeEvent extends MsgEvent {
    type: 'settings',
    settings: SettingsData
}

export interface CounterOverwriteEvent extends MsgEvent {
    type: 'counter',
    counter: CounterDailyData | null
}

// Cross-context daily-data replacement; background owns storage and memory commit.
export interface CounterReplacementRequest {
    type: 'counter:replace';
    mode: 'overwrite' | 'merge';
    data: unknown;
}
export type CounterReplacementResponse = { ok: true } | { ok: false; error: string };
