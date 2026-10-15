export interface TimelineViewport { start: number; end: number }
export const MIN_TIMELINE_RANGE = 60000;

export function boundViewport(range: TimelineViewport, day: TimelineViewport): TimelineViewport {
    const duration = Math.min(day.end - day.start, Math.max(MIN_TIMELINE_RANGE, range.end - range.start));
    const start = Math.max(day.start, Math.min(day.end - duration, range.start));
    return { start, end: start + duration };
}
export function selectViewport(view: TimelineViewport, from: number, to: number): TimelineViewport | null {
    const left = Math.max(0, Math.min(1, Math.min(from, to)));
    const right = Math.max(0, Math.min(1, Math.max(from, to)));
    const duration = view.end - view.start;
    if ((right - left) * duration < MIN_TIMELINE_RANGE) return null;
    return { start: view.start + left * duration, end: view.start + right * duration };
}
export function panViewport(view: TimelineViewport, day: TimelineViewport, fraction: number): TimelineViewport {
    const shift = fraction * (view.end - view.start);
    return boundViewport({ start: view.start + shift, end: view.end + shift }, day);
}
export function scaleViewport(view: TimelineViewport, day: TimelineViewport, factor: number): TimelineViewport {
    const center = (view.start + view.end) / 2;
    const duration = Math.min(day.end - day.start, Math.max(MIN_TIMELINE_RANGE, (view.end - view.start) * factor));
    return boundViewport({ start: center - duration / 2, end: center + duration / 2 }, day);
}
