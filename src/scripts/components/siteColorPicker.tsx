import React, { useEffect, useRef, useState } from 'react';
import { hexToHSB, HSB, hsbToHex, normalizeHex } from '../siteColors';

export default function SiteColorPicker({ domain, color, onPreview, onSave, onCancel }: {
    domain: string; color: string; onPreview: (color: string) => void; onSave: (color: string) => Promise<void>; onCancel: () => void;
}) {
    const [hsb, setHSB] = useState(() => hexToHSB(color));
    const [hex, setHex] = useState(color);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const hexRef = useRef<HTMLInputElement>(null);
    useEffect(() => { hexRef.current?.focus(); }, []);
    const validHex = normalizeHex(hex);
    function updateHSB(key: keyof HSB, value: number) {
        if (!Number.isFinite(value)) return;
        const next = { ...hsb, [key]: Math.min(key === 'h' ? 360 : 100, Math.max(0, value)) };
        const nextHex = hsbToHex(next);
        setHSB(next); setHex(nextHex); onPreview(nextHex);
    }
    return <form className="site-color-picker" role="dialog" aria-labelledby="site-color-heading" onKeyDown={event => { if (event.key === 'Escape' && !saving) { event.preventDefault(); onCancel(); } }} onSubmit={async event => {
        event.preventDefault(); if (!validHex || saving) return;
        setSaving(true); setError('');
        try { await onSave(validHex); } catch { setError('Unable to save the color. Please try again.'); setSaving(false); }
    }}>
        <h3 id="site-color-heading">Color for {domain}</h3>
        <fieldset disabled={saving}>
            <div className="color-hex"><span className="color-preview" style={{ background: color }} aria-hidden="true" /><label>Hex <input ref={hexRef} aria-label="Site color hex" value={hex} maxLength={7} spellCheck={false} aria-invalid={!validHex} onChange={event => {
                const value = event.target.value; setHex(value); const normalized = normalizeHex(value);
                if (normalized) { setHSB(hexToHSB(normalized)); onPreview(normalized); }
            }} /></label></div>
            {(['h', 's', 'b'] as const).map((key, index) => {
                const label = ['Hue', 'Saturation', 'Brightness'][index], max = key === 'h' ? 360 : 100;
                return <div className="hsb-control" key={key}><label>{label} <input aria-label={label} type="range" min={0} max={max} step={1} value={hsb[key]} onChange={event => updateHSB(key, event.target.valueAsNumber)} /></label><input aria-label={`${label} value`} type="number" min={0} max={max} step={1} value={Math.round(hsb[key])} onChange={event => updateHSB(key, event.target.valueAsNumber)} /><span>{key === 'h' ? '°' : '%'}</span></div>;
            })}
            {!validHex && <p role="alert">Enter a valid hex color, such as #36D9EF.</p>}
            {error && <p role="alert">{error}</p>}
            <div className="color-actions"><button type="submit" disabled={!validHex}>{saving ? 'Saving…' : 'Save color'}</button><button type="button" onClick={onCancel}>Cancel</button></div>
        </fieldset>
    </form>;
}
