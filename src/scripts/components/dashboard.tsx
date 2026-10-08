import React, { useEffect, useMemo, useRef, useState } from 'react';
import browser from 'webextension-polyfill';
import { calendarDate, calendarDays, CHART_PAGE_DAYS, changeLabel, dailySnapshot, DailySnapshot, dateInput, domainColor, domainInitial, formatDuration, legacyKey, localToday, parseDateInput, periodData, previousRange, shiftDay } from '../dashboardData';
import { axisLabel, HistoryDay, timelineRows } from '../timelinePresentation';

const shortDate = (date: Date) => date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
function Site({ domain }: { domain: string }) {
    return <span className="site-name"><span className="site-initial" style={{ background: domainColor(domain) }}>{domainInitial(domain)}</span><span>{domain}</span></span>;
}
function Delta({ current, previous }: { current: number; previous: number }) {
    const difference = current - previous;
    return <span className={`delta ${difference < 0 ? 'decrease' : 'increase'}`}>{difference === 0 ? '' : difference > 0 ? '↑ ' : '↓ '}{formatDuration(difference)} <span>{changeLabel(current, previous)}</span></span>;
}
function Spark({ values }: { values: number[] }) {
    const max = Math.max(1, ...values);
    return <div className="spark" aria-hidden="true">{values.slice(-14).map((value, index) => <i key={index} style={{ height: `${Math.max(3, value / max * 100)}%` }} />)}</div>;
}

export default function Dashboard() {
    const todayDate = localToday();
    const today = dateInput(todayDate);
    const [endInput, setEndInput] = useState(today);
    const [startInput, setStartInput] = useState(dateInput(shiftDay(todayDate, -6)));
    const [preset, setPreset] = useState<number | null>(7);
    const [snapshot, setSnapshot] = useState<DailySnapshot>({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [invalidRecords, setInvalidRecords] = useState(0);
    const [chartPage, setChartPage] = useState(0);
    useEffect(() => { setChartPage(0); }, [startInput, endInput]);
    const [revision, setRevision] = useState(0);
    const [siteSelection, setSiteSelection] = useState<Set<string> | null>(null);
    const [day, setDay] = useState(today);
    const [history, setHistory] = useState<HistoryDay | null>(null);
    const [historyLoading, setHistoryLoading] = useState(true);
    const [groupIndex, setGroupIndex] = useState(0);
    const [zoom, setZoom] = useState(1);
    const [heatmapSite, setHeatmapSite] = useState('');
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let active = true; setLoading(true); setError('');
        browser.storage.local.get().then(data => { if (active) { let invalid = 0; setSnapshot(dailySnapshot(data, () => invalid++)); setInvalidRecords(invalid); } })
            .catch(reason => { if (active) setError(`Unable to read saved daily statistics: ${String(reason?.message ?? reason)}`); })
            .finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [revision]);
    useEffect(() => {
        let active = true; setHistoryLoading(true); setHistory(null); setGroupIndex(0); setZoom(1);
        browser.runtime.sendMessage({ type: 'history:day', dayKey: day }).then((value: HistoryDay) => {
            if (!active) return;
            if (!value || !['available', 'partial', 'unavailable'].includes(value.status) || !Array.isArray(value.sessions) || !Array.isArray(value.domains) || !Array.isArray(value.groups)) throw new Error('Session history is not available');
            setHistory(value);
        }).catch(reason => { if (active) setHistory({ status: 'unavailable', sessions: [], domains: [], groups: [], error: String(reason?.message ?? reason) }); })
            .finally(() => { if (active) setHistoryLoading(false); });
        return () => { active = false; };
    }, [day, revision]);

    const start = parseDateInput(startInput), end = parseDateInput(endInput);
    const validRange = !!start && !!end && start <= end;
    const current = useMemo(() => validRange ? periodData(snapshot, start!, end!, chartPage) : periodData({}, localToday(), shiftDay(localToday(), -1)), [snapshot, startInput, endInput, chartPage]);
    const previous = useMemo(() => validRange ? periodData(snapshot, ...previousRange(start!, end!)) : periodData({}, localToday(), shiftDay(localToday(), -1)), [snapshot, startInput, endInput]);
    const priorSites = new Map(previous.sites.map(site => [site.domain, site.seconds]));
    const currentSites = new Map(current.sites.map(site => [site.domain, site.seconds]));
    const changes = [...new Set([...currentSites.keys(), ...priorSites.keys()])].map(domain => ({ domain, current: currentSites.get(domain) ?? 0, previous: priorSites.get(domain) ?? 0 })).sort((a, b) => (b.current - b.previous) - (a.current - a.previous) || a.domain.localeCompare(b.domain));
    const selected = (domain: string) => siteSelection === null || siteSelection.has(domain);
    const selectedTotal = current.sites.filter(site => selected(site.domain)).reduce((sum, site) => sum + site.seconds, 0);
    const selectedPrevious = previous.sites.filter(site => selected(site.domain)).reduce((sum, site) => sum + site.seconds, 0);
    const chartMax = Math.max(1, ...current.days.map(item => [...item.sites].filter(([domain]) => selected(domain)).reduce((sum, [, seconds]) => sum + seconds, 0)));
    const group = history?.groups[groupIndex];
    const rows = history && group ? timelineRows(history, group, zoom) : [];
    const year = end?.getUTCFullYear() ?? localToday().getUTCFullYear();
    const yearDays = calendarDays(calendarDate(year, 0, 1), calendarDate(year, 11, 31));
    const heatValue = (date: Date) => heatmapSite ? Number(Object.getOwnPropertyDescriptor(snapshot[legacyKey(date)]?.websiteTime ?? {}, heatmapSite)?.value ?? 0) : snapshot[legacyKey(date)]?.netTime ?? 0;
    const heatMax = Math.max(1, ...yearDays.map(heatValue));
    const allDomains = [...new Set(Object.values(snapshot).flatMap(item => Object.keys(item.websiteTime)))].sort();
    const distribution = current.sites.slice(0, 6).map(site => ({ ...site, color: domainColor(site.domain) }));
    const otherTotal = current.sites.slice(6).reduce((sum, site) => sum + site.seconds, 0);
    if (otherTotal) distribution.push({ domain: 'Other', seconds: otherTotal, color: '#a3b3d3' });
    let offset = 0;
    const stops = distribution.map(site => { const begin = offset; offset += current.total ? site.seconds / current.total * 100 : 0; return `${site.color} ${begin}% ${offset}%`; });
    const most = current.sites[0];

    function choosePreset(count: number) {
        const date = parseDateInput(endInput) ?? localToday();
        setEndInput(dateInput(date)); setStartInput(dateInput(shiftDay(date, 1 - count))); setPreset(count);
    }
    function changeEnd(value: string) {
        setEndInput(value);
        const parsed = parseDateInput(value); if (preset && parsed) setStartInput(dateInput(shiftDay(parsed, 1 - preset)));
    }
    function toggleSite(domain: string) {
        const next = new Set(siteSelection ?? current.sites.map(site => site.domain));
        next.has(domain) ? next.delete(domain) : next.add(domain); setSiteSelection(next);
    }
    const periodCaption = `vs previous ${current.dayCount} ${current.dayCount === 1 ? 'day' : 'days'}`;
    return <div className="dashboard">
        <header className="dashboard-heading"><div><h1><img src="assets/icons/128px.png" alt="" />Browser Screen Time</h1><p>Overview of your browsing activity</p></div>
            <div className="period-controls"><div className="range"><label>From<input aria-label="Period start" type="date" value={startInput} onChange={event => { setStartInput(event.target.value); setPreset(null); }} /></label><span>–</span><label>To<input aria-label="Period end" type="date" value={endInput} onChange={event => changeEnd(event.target.value)} /></label></div>
                <div className="presets">{[1, 7, 30].map(count => <button key={count} className={preset === count ? 'active' : ''} onClick={() => choosePreset(count)}>{count}D</button>)}<button className={preset === null ? 'active' : ''} onClick={() => setPreset(null)}>Custom</button></div>
            </div>
        </header>
        <div className="dashboard-status"><button onClick={() => setRevision(value => value + 1)} disabled={loading || historyLoading}>Refresh saved data</button><span>Local data · saved statistics</span>{loading && <span role="status">Loading statistics…</span>}</div>
        {invalidRecords > 0 && <p className="warning" role="alert">{invalidRecords} invalid saved daily {invalidRecords === 1 ? 'record was' : 'records were'} excluded from this view. Stored data remains unchanged.</p>}
        {error && <p className="warning" role="alert">{error}</p>}
        {!validRange && <p className="warning" role="alert">Choose a valid date range with the start on or before the end.</p>}
        {!loading && validRange && !current.total && <p className="empty-state">No saved screen time for this period. Select another period or start browsing.</p>}
        <section className="metric-grid" aria-label="Summary">
            <article className="panel metric"><h2>◷ Total screen time</h2><strong>{formatDuration(current.total)}</strong><Delta current={current.total} previous={previous.total} /><p>{periodCaption}</p><Spark values={current.days.map(item => item.total)} /></article>
            <article className="panel metric"><h2>♜ Most used site</h2>{most ? <><Site domain={most.domain} /><strong>{formatDuration(most.seconds)}</strong><span className="share">{Math.round(most.seconds / current.total * 100)}% of total</span><Delta current={most.seconds} previous={priorSites.get(most.domain) ?? 0} /></> : <strong className="no-site">No activity</strong>}<p>{periodCaption}</p></article>
            <article className="panel metric"><h2>▥ Daily average</h2><strong>{formatDuration(current.average)}</strong><Delta current={current.average} previous={previous.average} /><p>{periodCaption}</p><Spark values={current.days.map(item => item.total)} /></article>
        </section>
        <div className="analytics-grid">
            <section className="panel day-chart"><div className="section-heading"><h2>Total screen time by day</h2><details className="site-filter"><summary>Sites · {siteSelection === null ? 'All' : siteSelection.size} selected</summary><div><button onClick={() => setSiteSelection(null)}>All sites</button><button onClick={() => setSiteSelection(new Set())}>Clear selection</button>{current.sites.map(site => <label key={site.domain}><input type="checkbox" checked={selected(site.domain)} onChange={() => toggleSite(site.domain)} /><Site domain={site.domain} /></label>)}</div></details></div>
                {current.dayCount > CHART_PAGE_DAYS && <div className="chart-pagination" aria-label="Daily chart pages"><button disabled={chartPage === 0} onClick={() => setChartPage(value => value - 1)}>← Previous 30 days</button><span>{dateInput(current.days[0].date)} – {dateInput(current.days[current.days.length - 1].date)} · Page {chartPage + 1} of {Math.ceil(current.dayCount / CHART_PAGE_DAYS)}</span><button disabled={(chartPage + 1) * CHART_PAGE_DAYS >= current.dayCount} onClick={() => setChartPage(value => value + 1)}>Next 30 days →</button><label>Page <input aria-label="Daily chart page" type="number" min={1} max={Math.ceil(current.dayCount / CHART_PAGE_DAYS)} value={chartPage + 1} onChange={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1 && value <= Math.ceil(current.dayCount / CHART_PAGE_DAYS)) setChartPage(value - 1); }} /></label></div>}
                <div className="chart-with-summary"><div className="stack-chart" role="img" aria-label="Saved daily screen time by website"><div className="chart-axis"><span>{formatDuration(chartMax)}</span><span>{formatDuration(chartMax / 2)}</span><span>0</span></div><div className="chart-bars">{current.days.map(item => {
                    const entries = [...item.sites].filter(([domain, seconds]) => selected(domain) && seconds > 0).sort(([a], [b]) => a.localeCompare(b));
                    const sum = entries.reduce((n, [, seconds]) => n + seconds, 0);
                    return <button key={item.key} className="day-bar" onClick={() => setDay(dateInput(item.date))} title={`${shortDate(item.date)}: ${formatDuration(sum)}. Show timeline`}><span className="bar-total" style={{ bottom: `${sum / chartMax * 100}%` }}>{formatDuration(sum)}</span><span className="bar-stack" style={{ height: `${sum / chartMax * 100}%` }}>{entries.map(([domain, seconds]) => <span key={domain} title={`${domain}: ${formatDuration(seconds)}`} style={{ height: `${seconds / sum * 100}%`, background: domainColor(domain) }} />)}</span><span className="bar-date">{shortDate(item.date)}</span></button>;
                })}</div></div><aside><p>Selected sites</p><strong>{formatDuration(selectedTotal)}</strong><Delta current={selectedTotal} previous={selectedPrevious} /><p>{periodCaption}</p><hr /><p>Daily average</p><strong>{formatDuration(current.dayCount ? selectedTotal / current.dayCount : 0)}</strong></aside></div>
            </section>
            <section className="panel distribution"><h2>Time distribution</h2><div className="distribution-content"><div className="donut" role="img" aria-label="Website time distribution" style={{ background: stops.length ? `conic-gradient(${stops.join(',')})` : '#29364b' }}><span>{current.total ? formatDuration(current.total) : 'No data'}</span></div><ul>{distribution.map(site => <li key={site.domain}><i style={{ background: site.color }} /><span>{site.domain}</span><b>{formatDuration(site.seconds)}</b><small>{Math.round(site.seconds / current.total * 100)}%</small></li>)}</ul></div></section>
        </div>
        <section className="panel timeline"><div className="section-heading"><h2>Day timeline</h2><div className="timeline-controls"><label>Day <input aria-label="Timeline day" type="date" value={day} onChange={event => { if (parseDateInput(event.target.value)) setDay(event.target.value); }} /></label>{history && history.groups.length > 0 && <label>Calendar <select aria-label="Timeline calendar group" value={groupIndex} onChange={event => { setGroupIndex(Number(event.target.value)); setZoom(1); }}>{history.groups.map((item, index) => <option key={`${item.timeZone}-${item.dayStart}`} value={index}>{item.timeZone} · {(item.dayEnd - item.dayStart) / 3600000}h</option>)}</select></label>}<label>Zoom <select aria-label="Timeline zoom" value={zoom} onChange={event => { setZoom(Number(event.target.value)); if (scrollRef.current) scrollRef.current.scrollLeft = 0; }}><option value={1}>Full day</option><option value={2}>2×</option><option value={4}>4× · raw</option><option value={8}>8× · raw</option></select></label></div></div>
            {historyLoading ? <p role="status">Loading session history…</p> : <>
                {(history?.status !== 'available' || group?.status !== 'available') && <p className="coverage-note">{history?.status === 'unavailable' ? 'Detailed history is unavailable for this day. Daily statistics remain available.' : 'Partial session history: gaps may include unobserved activity. Numerical totals use raw sessions.'}{history?.error && <span> {history.error}</span>}</p>}
                {group && <><p className="timeline-caption">{group.timeZone} · {zoom >= 4 ? 'Exact raw intervals' : 'Visual smoothing up to ' + Math.round(120 / zoom) + ' seconds; raw durations unchanged'} · Scroll horizontally when zoomed.</p><div className="timeline-grid"><div className="timeline-labels"><div className="axis-spacer" />{rows.map((row, index) => <div key={index}>{row.domain ? <Site domain={row.domain} /> : <span>{index === 4 ? 'Other' : `Top ${index + 1} · no sessions`}</span>}<small>{formatDuration(row.milliseconds / 1000)}</small></div>)}</div><div className="timeline-scroll" ref={scrollRef}><div className="timeline-track" style={{ width: `${zoom * 100}%` }}><div className="time-axis">{Array.from({ length: 13 }, (_, index) => <span key={index} style={{ left: `${index / 12 * 100}%` }}>{axisLabel(group.dayStart + (group.dayEnd - group.dayStart) * index / 12, group)}</span>)}</div>{rows.map((row, index) => <div className="timeline-lane" key={index}>{row.intervals.map((interval, ordinal) => <span key={ordinal} className="session-span" style={{ left: `${(interval.start - group.dayStart) / (group.dayEnd - group.dayStart) * 100}%`, width: `${(interval.end - interval.start) / (group.dayEnd - group.dayStart) * 100}%`, background: domainColor(interval.domain) }} title={`${interval.domain}: ${axisLabel(interval.start, group)}–${axisLabel(interval.end, group)}${zoom < 4 ? ' (presentation span)' : ''}`} />)}</div>)}</div></div></div></>}
                {group && !rows.some(row => row.milliseconds > 0) && <p className="empty-state">{group.status === 'available' ? 'No recorded activity in this observed day.' : 'No recorded sessions in the available portion of this day.'}</p>}
                {!group && <p className="empty-state">No detailed sessions or calendar coverage are recorded for this day. Legacy daily totals cannot reconstruct a timeline.</p>}
            </>}
        </section>
        <div className="bottom-grid"><section className="panel comparisons"><h2>Changes vs previous period</h2><div className="comparison-columns">{[true, false].map(increase => <div key={String(increase)}><h3 className={increase ? 'increase' : 'decrease'}>{increase ? '↗ Most increased' : '↘ Most decreased'}</h3>{changes.filter(item => increase ? item.current > item.previous : item.current < item.previous).sort((a, b) => increase ? (b.current - b.previous) - (a.current - a.previous) : (a.current - a.previous) - (b.current - b.previous)).slice(0, 5).map(item => <div className="comparison-row" key={item.domain}><Site domain={item.domain} /><Delta current={item.current} previous={item.previous} /></div>)}{!changes.some(item => increase ? item.current > item.previous : item.current < item.previous) && <p>No {increase ? 'increases' : 'decreases'} in this period.</p>}</div>)}</div></section>
            <section className="panel heatmap"><div className="section-heading"><h2>Year heatmap · {year}</h2><select aria-label="Heatmap website" value={heatmapSite} onChange={event => setHeatmapSite(event.target.value)}><option value="">All sites</option>{allDomains.map(domain => <option key={domain} value={domain}>{domain}</option>)}</select></div><div className="heatmap-scroll"><div className="heatmap-months">{Array.from({ length: 12 }, (_, month) => <div className="heatmap-month" key={month}><span>{calendarDate(year, month, 1).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })}</span>{Array.from({ length: 31 }, (_, ordinal) => { const date = calendarDate(year, month, ordinal + 1), valid = date.getUTCMonth() === month, value = valid ? heatValue(date) : 0; return <button key={ordinal} disabled={!valid} title={valid ? `${dateInput(date)}: ${formatDuration(value)}` : ''} aria-label={valid ? `${dateInput(date)}: ${formatDuration(value)}` : undefined} onClick={() => setDay(dateInput(date))} style={{ background: valid ? value ? `rgba(52,124,255,${0.25 + 0.75 * value / heatMax})` : '#29364b' : 'transparent' }} />; })}</div>)}</div></div><p className="heatmap-legend">Less <i /><i /><i /><i /> More</p></section>
        </div>
    </div>;
}
