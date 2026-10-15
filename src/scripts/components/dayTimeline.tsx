import React, { useEffect, useRef, useState } from 'react';
import { axisLabel, HistoryDay, TimelineGroup, timelineRows } from '../timelinePresentation';
import { panViewport, scaleViewport, selectViewport, TimelineViewport } from '../timelineViewport';

interface Props {
    history: HistoryDay | null;
    group: TimelineGroup;
    smoothingSeconds: number;
    hideShortIsolated: boolean;
    colorFor: (domain: string) => string;
    otherColor: string;
    renderSite: (domain: string) => React.ReactNode;
}
interface Drag {
    pointerId: number; from: number; to: number; left: number; width: number;
    mode: 'select' | 'pan'; view: TimelineViewport;
}
export default function DayTimeline({ history, group, smoothingSeconds, hideShortIsolated, colorFor, otherColor, renderSite }: Props) {
    const day = { start: group.dayStart, end: group.dayEnd };
    const [view, setView] = useState<TimelineViewport>(day);
    const [selection, setSelection] = useState<{ from: number; to: number } | null>(null);
    const drag = useRef<Drag | null>(null);
    const viewport = useRef<HTMLDivElement>(null);
    const duration = view.end - view.start;
    const zoom = (day.end - day.start) / duration;
    useEffect(() => {
        const chart = viewport.current;
        if (!chart) return;
        const scroll = (event: WheelEvent) => {
            // Keep normal page scrolling at full day, and preserve browser pinch zoom.
            if (zoom === 1 || event.ctrlKey || drag.current) return;
            const width = chart.getBoundingClientRect().width;
            if (!width) return;
            const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
            if (!delta) return;
            const pixels = delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? width : 1);
            event.preventDefault();
            setView(current => panViewport(current, { start: group.dayStart, end: group.dayEnd }, pixels / width));
        };
        // React's delegated wheel listeners are passive; this prevents page movement while panning.
        chart.addEventListener('wheel', scroll, { passive: false });
        return () => chart.removeEventListener('wheel', scroll);
    }, [zoom, group.dayStart, group.dayEnd]);
    // Rank and smooth the complete day before clipping display spans to the viewport.
    const rows = timelineRows(history ?? { status: 'unavailable', sessions: [], domains: [], groups: [] }, group, zoom, smoothingSeconds, hideShortIsolated);
    const fraction = (clientX: number, gesture: Drag) => Math.max(0, Math.min(1, (clientX - gesture.left) / gesture.width));
    function cancelDrag() { drag.current = null; setSelection(null); }
    function abortDrag() {
        if (drag.current?.mode === 'pan') setView(drag.current.view);
        cancelDrag();
    }
    function begin(event: React.PointerEvent<HTMLDivElement>) {
        if (event.button !== 0 || drag.current) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (!rect.width) return;
        const from = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        const mode = (event.target as HTMLElement).closest('.time-axis') ? 'pan' : 'select';
        drag.current = { pointerId: event.pointerId, from, to: from, left: rect.left, width: rect.width, mode, view };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.focus();
        if (mode === 'select') setSelection({ from, to: from });
        event.preventDefault();
    }
    function move(event: React.PointerEvent<HTMLDivElement>) {
        const gesture = drag.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        gesture.to = fraction(event.clientX, gesture);
        if (gesture.mode === 'select') setSelection({ from: gesture.from, to: gesture.to });
        else setView(panViewport(gesture.view, day, gesture.to - gesture.from));
    }
    function finish(event: React.PointerEvent<HTMLDivElement>) {
        const gesture = drag.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        const to = fraction(event.clientX, gesture);
        if (gesture.mode === 'select' && Math.abs(to - gesture.from) * gesture.width >= 4) {
            const next = selectViewport(gesture.view, gesture.from, to);
            if (next) setView(next);
        } else if (gesture.mode === 'pan') setView(panViewport(gesture.view, day, to - gesture.from));
        cancelDrag();
        event.currentTarget.releasePointerCapture(event.pointerId);
    }
    function keyboard(event: React.KeyboardEvent<HTMLDivElement>) {
        if (!['Escape', 'ArrowLeft', 'ArrowRight', '+', '=', '-'].includes(event.key)) return;
        event.preventDefault(); cancelDrag();
        if (event.key === 'Escape') setView(day);
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') setView(panViewport(view, day, event.key === 'ArrowLeft' ? -0.25 : 0.25));
        else setView(scaleViewport(view, day, event.key === '-' ? 2 : 0.5));
    }
    const label = (epoch: number) => axisLabel(epoch, group, duration < 600000);
    return <div className="timeline-grid">
        <div className="timeline-labels"><div className="axis-spacer" />{rows.map((row, index) => <div key={index}>{row.domain ? renderSite(row.domain) : <span>{index === 4 ? 'Other' : `Top ${index + 1} · no sessions`}</span>}</div>)}</div>
        <div className="timeline-viewport" ref={viewport} role="group" aria-label="Day timeline chart" tabIndex={0}
            title="Drag to zoom. Double-click to zoom out. Drag the time axis or scroll to pan when zoomed. Keyboard: +/− zoom, arrows pan, Escape shows the full day."
            onPointerDown={begin} onPointerMove={move} onPointerUp={finish} onPointerCancel={abortDrag} onLostPointerCapture={abortDrag}
            onDoubleClick={() => { cancelDrag(); setView(scaleViewport(view, day, 2)); }} onKeyDown={keyboard}>
            <div className="time-axis">{Array.from({ length: 13 }, (_, index) => <span key={index} style={{ left: `${index / 12 * 100}%` }}>{label(view.start + duration * index / 12)}</span>)}</div>
            {rows.map((row, index) => <div className="timeline-lane" key={index}>{row.intervals.filter(interval => interval.end > view.start && interval.start < view.end).map((interval, ordinal) => {
                // Display clipping never alters the source interval.
                const start = Math.max(view.start, interval.start), end = Math.min(view.end, interval.end);
                return <span key={ordinal} className="session-span" style={{ left: `${(start - view.start) / duration * 100}%`, width: `${(end - start) / duration * 100}%`, background: index === 4 && zoom < 4 ? otherColor : colorFor(interval.domain) }} title={`${interval.domain}: ${axisLabel(interval.start, group)}–${axisLabel(interval.end, group)}${zoom < 4 && smoothingSeconds > 0 ? ' (presentation span)' : ''}`} />;
            })}</div>)}
            {selection && <div className="timeline-selection" style={{ left: `${Math.min(selection.from, selection.to) * 100}%`, width: `${Math.abs(selection.to - selection.from) * 100}%` }} />}
        </div>
    </div>;
}
