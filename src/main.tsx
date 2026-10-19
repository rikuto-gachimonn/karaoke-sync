import { createRoot } from 'react-dom/client';
import { createApp } from './app/createApp';
import { App } from './ui/App';
import './ui/styles.css';

const services = createApp(new URLSearchParams(window.location.search).get('mode') === 'simulation' ? 'simulation' : 'real');
const root = createRoot(document.getElementById('root')!);
root.render(<App {...services} />);
const stop = () => { void services.stopAll(); };
window.addEventListener('pagehide', stop);
const onVisibility = () => { if (document.visibilityState === 'hidden') stop(); };
document.addEventListener('visibilitychange', onVisibility);
if (import.meta.hot) import.meta.hot.dispose(() => {
  window.removeEventListener('pagehide', stop);
  document.removeEventListener('visibilitychange', onVisibility);
  root.unmount();
  stop();
});
