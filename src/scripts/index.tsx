import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Dashboard from './components/dashboard';
import Settings from './components/settings';
import '../styles/index.scss';

export default function Index() {
    const [settingsOpened, setSettingsOpened] = useState(false);
    return <div className="dashboard-shell"><nav className="utility-navigation" aria-label="Page controls"><button onClick={() => setSettingsOpened(value => !value)}>{settingsOpened ? '← Back to dashboard' : '⚙ Settings & data'}</button></nav>{settingsOpened ? <div className="settings-panel panel"><Settings /></div> : <Dashboard />}</div>;
}
const container = document.getElementById('root');
if (container) createRoot(container).render(<React.StrictMode><Index /></React.StrictMode>);
