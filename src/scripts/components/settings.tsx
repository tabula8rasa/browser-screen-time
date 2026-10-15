import React, { useEffect, useRef, useState } from 'react'
import browser from 'webextension-polyfill'
import SettingsStorage from '../settingsStorage'
import { DEFAULT_SMOOTHING_SECONDS, timelinePreferences } from '../timelinePresentation'
import { SettingsData, SettingsDataType, SettingsChangeEvent } from '../types'
import { format } from 'date-fns'
import CounterStorage from '../counterStorage'
import Notification, { NotificationData, NotificationTypeEnum } from './notification'

const Settings = () => {
    const [settings, setSettings] = useState<SettingsData | null>(null);
    const pendingSave = useRef<Promise<void>>(Promise.resolve());
    const [notification, setNotification] = useState<NotificationData>({ type: NotificationTypeEnum.NONE, message: '' });

    useEffect(() => {
        const setInitialSettings = async () => {
            setSettings(await SettingsStorage.get());
        }

        setInitialSettings();
    }, []);

    const handleChange = (event: React.ChangeEvent<HTMLInputElement> | React.ChangeEvent<HTMLSelectElement>) => {
        if (event.target.type === 'checkbox') {
            event = event as React.ChangeEvent<HTMLInputElement>;
            changeSettings(event.target.name, event.target.checked);
        } else {
            changeSettings(event.target.name, event.target.value);
        }
    }

    const changeSettings = (key: string, value: SettingsDataType): void => {
        if (!settings) {
            return;
        }

        pendingSave.current = pendingSave.current.then(() => SettingsStorage.set(key, value)).catch(error => {
            setNotification({ type: NotificationTypeEnum.ERROR, message: `Failed to save settings: ${error.message}` });
        });

        const currentSettings = { ...settings };
        currentSettings[key] = value;

        setSettings(currentSettings);

        const msg: SettingsChangeEvent = {
            type: 'settings',
            settings: currentSettings
        }

        // Send settings change message to background or popup
        browser.runtime.sendMessage(msg);
    }

    const exportData = async (mode: 'full' | 'daily') => {
        try {
        const exportData = await CounterStorage.exportJSONString(mode);

        const currentDay = format(new Date(), 'yyyy-MM-dd');
        const fileName = `browser-screen-time-${currentDay}${mode === 'daily' ? '-daily' : ''}.json`;

        const blob = new Blob([exportData], { type: 'application/json' });

        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = fileName;

        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);
        setNotification({ type: NotificationTypeEnum.SUCCESS, message: 'Successfully exported time data' });
        } catch (error) { setNotification({ type: NotificationTypeEnum.ERROR, message: `Failed to export: ${error.message}` }); }
    }

    const pickFile = (): Promise<object> => {
        return new Promise((resolve, reject) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'application/json';

            input.addEventListener('change', (event: Event) => {
                const target = event.target as HTMLInputElement;
                const file = target.files?.[0];
                if (!file) {
                    return reject(new Error('No file selected'));
                }

                const reader = new FileReader();
                reader.onload = () => {
                    try {
                        const jsonObject = JSON.parse(reader.result as string);
                        resolve(jsonObject);
                    } catch (error) {
                        reject(new Error('Invalid JSON format'));
                    }
                };
                reader.onerror = () => reject(new Error('Error reading file'));
                reader.readAsText(file);
            });

            input.click();
        });
    }

    const overwriteData = async () => {
        if (!window.confirm('Are you sure you want to overwrite the current time data? This process is not reversible.')) {
            return;
        }

        try {
            const newData = await pickFile();
            await CounterStorage.overwriteStorage(newData);
            setNotification({ type: NotificationTypeEnum.SUCCESS, message: 'Successfully overwriten time data' });
        } catch (error) {
            setNotification({ type: NotificationTypeEnum.ERROR, message: `Failed to overwrite data: ${error.message}` });
        }
    }

    const mergeData = async () => {
        if (!window.confirm('Are you sure you want to add time data to the current data? This process is not reversible.')) {
            return;
        }

        try {
            const newData = await pickFile();
            await CounterStorage.mergeStorage(newData);
            setNotification({ type: NotificationTypeEnum.SUCCESS, message: 'Successfully merged time data' });
        } catch (error) {
            setNotification({ type: NotificationTypeEnum.ERROR, message: `Failed to merge data: ${error.message}` });
        }
    }

    const resetData = async () => {
        if (!window.confirm('Delete all daily totals and session history? Settings will be preserved.')) return;
        try { await CounterStorage.overwriteStorage({}); setNotification({ type: NotificationTypeEnum.SUCCESS, message: 'Time data reset' }); }
        catch (error) { setNotification({ type: NotificationTypeEnum.ERROR, message: `Failed to reset: ${error.message}` }); }
    };

    const timeline = timelinePreferences(settings);

    return (
        <div className="settings">
            <Notification {...notification} />
            {settings && (
                <form>
                    <h1>Settings</h1>
                    <h2>General</h2>
                    <p>Consider the browser idle after</p>
                    <select name="idleTimer" value={settings.idleTimer as string} onChange={handleChange}>
                        <option value="15">15 seconds</option>
                        <option value="20">20 seconds</option>
                        <option value="30">30 seconds</option>
                        <option value="60">1 minute</option>
                        <option value="300">5 minutes</option>
                    </select>
                    <br />
                    <input type="checkbox" name="videoCheck" checked={settings.videoCheck as boolean} onChange={handleChange} />
                    <label htmlFor="videoCheck">Continue counting time when watching a video</label>
                    <br />
                    <h2>Notifications</h2>
                    <input type="checkbox" name="notifications" checked={settings.notifications as boolean} onChange={handleChange} />
                    <label htmlFor="notifications">Notify me when I spend too much time on one site</label>
                    <br />
                    <div className={`${!settings.notifications ? 'disabled' : ''}`}>
                        <p>Remind me every</p>
                        <select name="notificationTimer" value={settings.notificationTimer as string} onChange={handleChange}>
                            <option value="900">15 minutes</option>
                            <option value="1800">30 minutes</option>
                            <option value="3600">1 hour</option>
                            <option value="7200">2 hours</option>
                            <option value="10800">3 hours</option>
                            <option value="14400">4 hours</option>
                        </select>
                    </div>
                    <h2>Day timeline</h2>
                    <div className="smoothing-settings">
                        <label>Full-day smoothing <input aria-label="Timeline smoothing seconds" type="number" min={0} max={3600} step={1} value={timeline.smoothingSeconds} onChange={event => {
                            const value = event.target.valueAsNumber;
                            if (Number.isFinite(value) && value >= 0 && value <= 3600) changeSettings('timelineSmoothingSeconds', String(value));
                        }} /> seconds</label>
                        <input aria-label="Adjust timeline smoothing" type="range" min={0} max={3600} step={1} value={timeline.smoothingSeconds} onChange={event => changeSettings('timelineSmoothingSeconds', event.target.value)} />
                        <button type="button" onClick={() => changeSettings('timelineSmoothingSeconds', String(DEFAULT_SMOOTHING_SECONDS))}>Reset to {DEFAULT_SMOOTHING_SECONDS}s</button>
                    </div>
                    <label><input type="checkbox" name="timelineHideShortIsolated" checked={timeline.hideShortIsolated} onChange={handleChange} /> Hide isolated sessions &lt; 5m</label>
                    <br />
                    <h2>Data</h2>
                    <button className="button" type="button" onClick={() => exportData('full')}>Export full backup</button>
                    <button className="button" type="button" onClick={() => exportData('daily')}>Export daily totals only</button>
                    <button className="button" type="button" onClick={resetData}>Reset time data</button>
                    <button className="button" type="button" onClick={overwriteData}>Import (overwrite current time)</button>
                    <button className="button" type="button" onClick={mergeData}>Import (add to current time)</button>
                </form>
            )}
            <footer>made by <a href="https://github.com/aaaeka" style={{ color: "#227C9D" }}>aaaeka</a> | <a href="https://github.com/aaaeka/browser-screen-time" style={{ color: "#17C3B2" }}>source code</a> | <a href="http://www.gnu.org/licenses/lgpl-3.0.html" style={{ color: "#FE6D73" }}>license</a></footer>
        </div>
    )
}

export default Settings;
