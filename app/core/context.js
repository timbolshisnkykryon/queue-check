import { createAppState } from './state.js';
import { getElements } from './elements.js';
import * as constants from './constants.js';

export function createAppContext({ firebaseConfig = null } = {}) {
    const state = createAppState();
    const elements = getElements();

    return {
        firebaseConfig,
        state,
        elements,
        constants,
        locationCache: new Map(),
        modules: {}
    };
}
