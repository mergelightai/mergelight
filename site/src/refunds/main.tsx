import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import Refunds from './Refunds';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Refunds />
  </StrictMode>,
);
