import { createAppContext } from './core/context.js';
import { initializeApplication } from './modules/app.js';

async function loadFirebaseConfig() {
    try {
        const module = await import('../firebase-config.js');
        return module.firebaseConfig;
    } catch (error) {
        console.error('Firebase configuration not found. Copy firebase-config.js.example to firebase-config.js and provide your project credentials.', error);
        return null;
    }
}

(async () => {
    const firebaseConfig = await loadFirebaseConfig();
    const context = createAppContext({ firebaseConfig });
    initializeApplication(context);
})();
