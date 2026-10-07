import browser, { Idle } from 'webextension-polyfill';
import SettingsStorage from './settingsStorage';
import { SettingsData } from './types';

export default class Awake {
    idle = true;
    initialized = false;
    private idleGeneration = 0;
    private settingsGeneration = 0;
    private queryGeneration = 0;
    private detectionInterval: number | null = null;

    constructor(private onChange: () => void) {
        browser.idle.onStateChanged.addListener((state: Idle.IdleState) => {
            this.idleGeneration++;
            this.setState(state);
        });
        SettingsStorage.onChange((settings: SettingsData) => {
            this.settingsGeneration++;
            void this.configure(settings);
        });
        const generation = this.settingsGeneration;
        void SettingsStorage.get().then(settings => {
            if (generation === this.settingsGeneration) return this.configure(settings);
        }).catch(error => console.warn('Idle initialization failed', error));
    }

    private setState(state: Idle.IdleState): void {
        this.idle = state === 'idle' || state === 'locked';
        this.initialized = true;
        this.onChange();
    }

    private async configure(settings: SettingsData): Promise<void> {
        const seconds = parseInt(settings.idleTimer as string);
        if (!Number.isFinite(seconds) || seconds <= 0) return;
        if (seconds === this.detectionInterval) return;
        this.detectionInterval = seconds;
        browser.idle.setDetectionInterval(seconds);
        const queryGeneration = ++this.queryGeneration;
        const idleGeneration = this.idleGeneration;
        try {
            const state = await browser.idle.queryState(seconds);
            if (idleGeneration === this.idleGeneration && queryGeneration === this.queryGeneration) {
                this.setState(state);
            }
        } catch (error) {
            console.warn('Idle query failed', error);
        }
    }
}
