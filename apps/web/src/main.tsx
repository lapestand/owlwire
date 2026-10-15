import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Placeholder } from './routes/placeholder';

const root = document.getElementById('root');
if (!root) throw new Error('#root element is missing');
createRoot(root).render(
  <StrictMode>
    <Placeholder />
  </StrictMode>,
);
