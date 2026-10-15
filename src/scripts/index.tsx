import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Dashboard from './components/dashboard';
import Settings from './components/settings';
import '../styles/index.scss';

export default function Index() {
    const [settingsOpened, setSettingsOpened] = useState(false);
    return <div className="dashboard-shell">{settingsOpened ? <>
        <nav className="utility-navigation" aria-label="Page controls"><button onClick={() => setSettingsOpened(false)}>← Back to dashboard</button></nav>
        <div className="settings-panel panel"><Settings /></div>
    </> : <Dashboard pageControls={<button onClick={() => setSettingsOpened(true)}>⚙ Settings &amp; data</button>} />}</div>;
}
const container = document.getElementById('root');
if (container) createRoot(container).render(<React.StrictMode><Index /></React.StrictMode>);
