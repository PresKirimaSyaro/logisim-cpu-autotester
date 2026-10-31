import {createRoot} from 'react-dom/client';
import {ResultApp} from './result/ResultApp.js';
import './styles.css';
import './result/result.css';

const container = document.getElementById('result-root');
if (!container) throw new Error('Missing #result-root');
createRoot(container).render(<ResultApp />);
