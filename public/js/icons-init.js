// Initialise les icônes Lucide (script externe : compatible avec une CSP sans 'unsafe-inline').
const init = () => window.lucide?.createIcons();
window.addEventListener('load', init);
document.addEventListener('DOMContentLoaded', () => setTimeout(init, 50));
