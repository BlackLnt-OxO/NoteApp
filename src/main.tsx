import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Auto-recover from a rare first-run race where the window renders the raw
// HTML/CSS source (portable unpacking) instead of the mounted app. If the body
// text looks like stylesheet source, reload once.
const guardTimer = setInterval(() => {
  const t = document.body.innerText || '';
  if (t.includes('* { margin: 0') || t.includes('<style>') || t.includes('<!DOCTYPE')) {
    clearInterval(guardTimer);
    location.reload();
  }
}, 250);
setTimeout(() => clearInterval(guardTimer), 4000);
