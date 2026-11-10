import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import Setup from './Setup';

// GitHub sends every sign-in back to this page, the one address the app knows. A sign-in that the
// dashboard started carries its own mark in the state, and is passed on there untouched.
const params = new URLSearchParams(window.location.search);
if (params.has('code') && params.get('state')?.startsWith('dash.')) {
  window.location.replace(`/dashboard/${window.location.search}`);
} else {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Setup />
    </StrictMode>,
  );
}
