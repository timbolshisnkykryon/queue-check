import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
    collection,
    doc,
    getFirestore,
    onSnapshot,
    orderBy,
    query,
    runTransaction,
    serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import {
    MAX_VISIT_HISTORY,
    normalizeLocationRecord,
    prepareCheckInUpdate,
    sanitizeCoords
} from '../location-model.js';

import { RADIUS_STYLES } from '../core/constants.js';

export function initializeApplication(context) {
    const { state, elements, constants, locationCache } = context;
    const {
        GEMINI_API_KEY,
        FIRESTORE_LOCATIONS_COLLECTION,
        HOURS_PER_DAY,
        DAY_NAMES_HE,
        SHORT_DAY_NAMES_HE
    } = constants;
    const firebaseConfig = context.firebaseConfig;

    let {
        map,
        userMarker,
        targetMarker,
        targetCircle,
        targetCoords,
        targetName,
        searchSuggestions,
        activeSuggestionIndex,
        searchSuggestionsQuery,
        searchFetchTimeoutId,
        searchSuggestionController,
        currentLocationId,
        gpsWatcherId,
        checkInStartTime,
        checkInTimerInterval,
        gpsCountdownInterval,
        userIcon,
        miniMap,
        miniMapTargetMarker,
        miniMapUserMarker,
        lastGpsTime,
        lastKnownPosition,
        confirmationCooldownUntil,
        visitedLocationsLayer,
        poiLayer,
        poiRefreshTimeoutId,
        poiFetchAbortController,
        isLoadingPois,
        lastPoiFetchBounds,
        selectedPlaceInfo,
        isSavingCheckIn,
        liveStatusTimeoutId,
        waitingSyncHideTimeoutId,
        renameLocationPendingId,
        isRenamingLocation,
        firebaseAppInstance,
        firestoreDb,
        unsubscribeLocations,
        locationsLoaded,
        firebaseInitializationError
    } = state;

    const {
        mainScreen,
        waitingScreen,
        onboardingModal,
        targetDetailsCard,
        liveStatusPill,
        liveStatusText,
        mainHeader,
        tabNavigation,
        mapSearchBar,
        mapContainer,
        searchBtn,
        locationNameInput,
        searchSuggestionsList,
        gpsStatusBtn,
        allLocationsList,
        waitingLocationName,
        timerDisplay,
        waitingDistance,
        waitingBearing,
        gpsCountdownEl,
        miniMapEl,
        infoLoading,
        infoResult,
        infoSources,
        infoErrorEl,
        cancelCheckInBtn,
        manualFinishBtn,
        waitingSyncIndicator,
        successMessage,
        successTime,
        closeSuccessBtn,
        arrivalConfirmationModal,
        confirmArrivalBtn,
        denyArrivalBtn,
        intelModal,
        intelModalCloseBtn,
        intelModalTitle,
        intelModalBody,
        intelModalSources,
        renameLocationModal,
        renameLocationForm,
        renameLocationInput,
        renameLocationError,
        renameLocationCancelBtn,
        renameLocationSaveBtn,
        renameLocationCloseBtn,
        tabContainers,
        tabButtons
    } = elements;

    if (gpsCountdownEl) {
        gpsCountdownEl.textContent = '';
        gpsCountdownEl.setAttribute('aria-hidden', 'true');
        gpsCountdownEl.style.setProperty('display', 'none', 'important');
    }

    const ALLOWED_POI_AMENITIES = new Set(['restaurant', 'cafe', 'bar']);

    function updateState() {
        Object.assign(state, {
            map,
            userMarker,
            targetMarker,
            targetCircle,
            targetCoords,
            targetName,
            searchSuggestions,
            activeSuggestionIndex,
            searchSuggestionsQuery,
            searchFetchTimeoutId,
            searchSuggestionController,
            currentLocationId,
            gpsWatcherId,
            checkInStartTime,
            checkInTimerInterval,
            gpsCountdownInterval,
            userIcon,
            miniMap,
            miniMapTargetMarker,
            miniMapUserMarker,
            lastGpsTime,
            lastKnownPosition,
            confirmationCooldownUntil,
            visitedLocationsLayer,
            poiLayer,
            poiRefreshTimeoutId,
            poiFetchAbortController,
            isLoadingPois,
            lastPoiFetchBounds,
            selectedPlaceInfo,
            isSavingCheckIn,
            liveStatusTimeoutId,
            waitingSyncHideTimeoutId,
            renameLocationPendingId,
            isRenamingLocation,
            firebaseAppInstance,
            firestoreDb,
            unsubscribeLocations,
            locationsLoaded,
            firebaseInitializationError
        });
    }

    const NOMINATIM_SEARCH_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
    const SEARCH_SUGGESTION_LIMIT = 12;
    const SEARCH_SUGGESTION_DEBOUNCE_MS = 320;
    const MIN_SEARCH_QUERY_LENGTH = 2;
    const SUGGESTION_ID_PREFIX = 'search-suggestion-option';
    const DEFAULT_SUGGESTION_EMOJI = '📍';

    function normalizeSearchText(value) {
        return typeof value === 'string'
            ? value
                .trim()
                .toLocaleLowerCase('he-IL')
            : '';
    }

    function suggestionMatchesQuery(suggestion, normalizedQuery) {
        if (!normalizedQuery) {
            return true;
        }

        const fields = [
            suggestion.mainText,
            suggestion.displayName,
            suggestion.secondaryText,
            ...(Array.isArray(suggestion.placeInfo?.addressLines)
                ? suggestion.placeInfo.addressLines
                : [])
        ];

        return fields.some((field) => normalizeSearchText(field).includes(normalizedQuery));
    }

    function scoreSuggestionRelevance(suggestion, normalizedQuery) {
        if (!normalizedQuery) {
            return 0;
        }

        const main = normalizeSearchText(suggestion.mainText);
        const display = normalizeSearchText(suggestion.displayName);
        const secondary = normalizeSearchText(suggestion.secondaryText);

        if (main.startsWith(normalizedQuery)) return 0;
        if (display.startsWith(normalizedQuery)) return 1;
        if (secondary.startsWith(normalizedQuery)) return 2;
        if (main.includes(normalizedQuery)) return 3;
        if (display.includes(normalizedQuery)) return 4;
        if (secondary.includes(normalizedQuery)) return 5;
        return 6;
    }

    function abortPendingSearchSuggestions() {
        if (searchFetchTimeoutId) {
            clearTimeout(searchFetchTimeoutId);
            searchFetchTimeoutId = null;
        }

        if (searchSuggestionController) {
            try {
                searchSuggestionController.abort();
            } catch (abortError) {
                console.warn('Failed to abort search suggestion request:', abortError);
            }
            searchSuggestionController = null;
        }

        updateState();
    }

    function clearSearchSuggestions({ abort = false, resetQuery = false } = {}) {
        if (abort) {
            abortPendingSearchSuggestions();
        }

        searchSuggestions = [];
        activeSuggestionIndex = -1;

        if (resetQuery) {
            searchSuggestionsQuery = '';
        }

        if (searchSuggestionsList) {
            searchSuggestionsList.innerHTML = '';
            searchSuggestionsList.classList.add('hidden');
            searchSuggestionsList.setAttribute('aria-hidden', 'true');
        }

        if (locationNameInput) {
            locationNameInput.setAttribute('aria-expanded', 'false');
            locationNameInput.removeAttribute('aria-activedescendant');
        }

        updateState();
    }

    function normalizeNominatimLabel(value) {
        if (!value || typeof value !== 'string') {
            return '';
        }

        const cleaned = value.replace(/_/g, ' ').trim();
        if (!cleaned) {
            return '';
        }

        return cleaned
            .split(' ')
            .filter(Boolean)
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join(' ');
    }

    function getLocalizedPrimaryName(result) {
        if (!result || typeof result !== 'object') {
            return '';
        }

        const namedetails = result.namedetails;
        if (namedetails && typeof namedetails === 'object') {
            const candidates = ['name:he', 'name:he-IL', 'name'];
            for (const key of candidates) {
                const value = namedetails[key];
                if (typeof value === 'string' && value.trim()) {
                    return value.trim();
                }
            }
        }

        const displayName = typeof result.display_name === 'string' ? result.display_name : '';
        if (!displayName) {
            return '';
        }

        const [firstPart] = displayName.split(',').map((part) => part.trim()).filter(Boolean);
        return firstPart || displayName.trim();
    }

    function pushUnique(list, value) {
        if (!value || typeof value !== 'string') {
            return;
        }

        const trimmed = value.trim();
        if (!trimmed) {
            return;
        }

        if (!list.includes(trimmed)) {
            list.push(trimmed);
        }
    }

    function buildAddressLinesFromResult(result) {
        const address = result?.address;
        if (!address || typeof address !== 'object') {
            const fallback = typeof result?.display_name === 'string'
                ? result.display_name.split(',').map((part) => part.trim()).filter(Boolean).slice(1, 4)
                : [];
            return fallback;
        }

        const lines = [];
        const streetParts = [];
        if (address.house_number) {
            streetParts.push(address.house_number);
        }
        if (address.road) {
            streetParts.push(address.road);
        }
        if (streetParts.length > 0) {
            pushUnique(lines, streetParts.join(' '));
        }

        const localityKeys = [
            'neighbourhood',
            'quarter',
            'suburb',
            'village',
            'town',
            'city',
            'municipality',
            'county'
        ];
        for (const key of localityKeys) {
            if (address[key]) {
                pushUnique(lines, address[key]);
                break;
            }
        }

        const regionKeys = ['state_district', 'state', 'region', 'province', 'district'];
        for (const key of regionKeys) {
            if (address[key]) {
                pushUnique(lines, address[key]);
                break;
            }
        }

        if (address.postcode) {
            pushUnique(lines, address.postcode);
        }

        if (address.country) {
            pushUnique(lines, address.country);
        }

        if (lines.length === 0 && typeof result?.display_name === 'string') {
            return result.display_name.split(',').map((part) => part.trim()).filter(Boolean).slice(1, 4);
        }

        return lines;
    }

    function createSuggestionFromResult(result) {
        if (!result || typeof result !== 'object') {
            return null;
        }

        const lat = Number.parseFloat(result.lat);
        const lon = Number.parseFloat(result.lon);

        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            return null;
        }

        const rawDisplayName = typeof result.display_name === 'string' ? result.display_name.trim() : '';
        const primaryName = getLocalizedPrimaryName(result) || '';
        const fallbackParts = rawDisplayName ? rawDisplayName.split(',').map((part) => part.trim()).filter(Boolean) : [];
        const fallbackMain = fallbackParts[0] || '';
        const addressLines = buildAddressLinesFromResult(result).filter(Boolean);
        let secondaryText = addressLines.slice(0, 3).join(' • ');

        if (!secondaryText && fallbackParts.length > 1) {
            secondaryText = fallbackParts.slice(1).join(', ');
        }

        const mainText = primaryName || fallbackMain || rawDisplayName;
        if (!mainText) {
            return null;
        }

        const displayName = secondaryText ? `${mainText}, ${secondaryText}` : mainText;

        const rawCategory = normalizeNominatimLabel(result.addresstype)
            || normalizeNominatimLabel(result.type)
            || normalizeNominatimLabel(result.category);

        const extratags = result.extratags && typeof result.extratags === 'object' ? result.extratags : null;
        const contactPhone = extratags?.['contact:phone'] || extratags?.phone || '';
        const contactWebsite = extratags?.website || extratags?.['contact:website'] || '';
        const contactOpeningHours = extratags?.opening_hours || '';

        const suggestionId = result.place_id ? `nominatim_${result.place_id}` : `${lat.toFixed(6)}_${lon.toFixed(6)}`;

        return {
            id: suggestionId,
            displayName,
            mainText,
            secondaryText,
            lat,
            lon,
            placeInfo: {
                sourceType: 'nominatim',
                id: suggestionId,
                displayName: mainText,
                category: {
                    label: rawCategory || 'נקודת עניין בסביבה',
                    emoji: DEFAULT_SUGGESTION_EMOJI
                },
                addressLines,
                infoLines: [],
                website: contactWebsite || '',
                websiteLabel: contactWebsite || '',
                phone: contactPhone || '',
                openingHours: contactOpeningHours || '',
                tags: {
                    osmType: result.osm_type || null,
                    osmId: result.osm_id || null,
                    category: result.category || null,
                    type: result.type || null
                }
            }
        };
    }

    function renderSearchSuggestions() {
        if (!searchSuggestionsList) {
            return;
        }

        if (!Array.isArray(searchSuggestions) || searchSuggestions.length === 0) {
            searchSuggestionsList.innerHTML = '';
            searchSuggestionsList.classList.add('hidden');
            searchSuggestionsList.setAttribute('aria-hidden', 'true');
            if (locationNameInput) {
                locationNameInput.setAttribute('aria-expanded', 'false');
                locationNameInput.removeAttribute('aria-activedescendant');
            }
            return;
        }

        const itemsHtml = searchSuggestions
            .map((suggestion, index) => {
                const isActive = index === activeSuggestionIndex;
                const optionId = `${SUGGESTION_ID_PREFIX}-${index}`;
                const subtitle = suggestion.secondaryText
                    ? `<span class="search-suggestion-item__subtitle">${escapeHtml(suggestion.secondaryText)}</span>`
                    : '';

                return `
                    <li id="${optionId}" class="search-suggestion-item${isActive ? ' search-suggestion-item--active' : ''}" role="option" aria-selected="${isActive}" data-index="${index}">
                        <span class="search-suggestion-item__title">${escapeHtml(suggestion.mainText)}</span>
                        ${subtitle}
                    </li>
                `;
            })
            .join('');

        searchSuggestionsList.innerHTML = itemsHtml;
        searchSuggestionsList.classList.remove('hidden');
        searchSuggestionsList.setAttribute('aria-hidden', 'false');

        if (locationNameInput) {
            locationNameInput.setAttribute('aria-expanded', 'true');
            if (activeSuggestionIndex >= 0) {
                locationNameInput.setAttribute('aria-activedescendant', `${SUGGESTION_ID_PREFIX}-${activeSuggestionIndex}`);
            } else {
                locationNameInput.removeAttribute('aria-activedescendant');
            }
        }

        if (activeSuggestionIndex >= 0) {
            const activeEl = searchSuggestionsList.querySelector(`[data-index="${activeSuggestionIndex}"]`);
            if (activeEl && typeof activeEl.scrollIntoView === 'function') {
                activeEl.scrollIntoView({ block: 'nearest' });
            }
        }
    }

    function setActiveSuggestion(index) {
        if (!Array.isArray(searchSuggestions) || searchSuggestions.length === 0) {
            return;
        }

        const boundedIndex = Math.max(-1, Math.min(index, searchSuggestions.length - 1));
        if (boundedIndex === activeSuggestionIndex) {
            return;
        }

        activeSuggestionIndex = boundedIndex;
        renderSearchSuggestions();
        updateState();
    }

    function moveActiveSuggestion(step) {
        if (!Array.isArray(searchSuggestions) || searchSuggestions.length === 0) {
            return;
        }

        const total = searchSuggestions.length;
        if (total === 0) {
            return;
        }

        if (activeSuggestionIndex === -1) {
            setActiveSuggestion(step > 0 ? 0 : total - 1);
            return;
        }

        const nextIndex = (activeSuggestionIndex + step + total) % total;
        setActiveSuggestion(nextIndex);
    }

    function selectSearchSuggestion(index, { focusInput = true } = {}) {
        if (!Array.isArray(searchSuggestions) || searchSuggestions.length === 0) {
            return;
        }

        const suggestion = searchSuggestions[index];
        if (!suggestion) {
            return;
        }

        clearSearchSuggestions({ abort: true, resetQuery: true });

        if (locationNameInput) {
            locationNameInput.value = suggestion.displayName;
            if (focusInput) {
                locationNameInput.focus();
            }
        }

        targetName = suggestion.displayName;
        selectLocation(suggestion.lat, suggestion.lon, suggestion.displayName, null, { placeInfo: suggestion.placeInfo });
        renderVisitedLocationsOnMap();
        updateState();
    }

    function scheduleSearchSuggestions(query) {
        const trimmed = typeof query === 'string' ? query.trim() : '';

        if (trimmed.length < MIN_SEARCH_QUERY_LENGTH) {
            clearSearchSuggestions({ abort: true, resetQuery: trimmed.length === 0 });
            return;
        }

        if (trimmed === searchSuggestionsQuery && Array.isArray(searchSuggestions) && searchSuggestions.length > 0) {
            renderSearchSuggestions();
            return;
        }

        if (searchFetchTimeoutId) {
            clearTimeout(searchFetchTimeoutId);
        }

        searchFetchTimeoutId = setTimeout(() => {
            searchFetchTimeoutId = null;
            void loadSearchSuggestions(trimmed, { triggeredByInput: true, autopickSingleResult: false });
            updateState();
        }, SEARCH_SUGGESTION_DEBOUNCE_MS);

        updateState();
    }

    function handleLocationInputChange(event) {
        scheduleSearchSuggestions(event.target.value || '');
    }

    function handleLocationInputKeyDown(event) {
        if (!Array.isArray(searchSuggestions) || searchSuggestions.length === 0) {
            if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
                event.preventDefault();
                void handleSearchLocation();
            }
            return;
        }

        switch (event.key) {
            case 'ArrowDown':
                event.preventDefault();
                moveActiveSuggestion(1);
                break;
            case 'ArrowUp':
                event.preventDefault();
                moveActiveSuggestion(-1);
                break;
            case 'Enter':
                event.preventDefault();
                if (activeSuggestionIndex >= 0) {
                    selectSearchSuggestion(activeSuggestionIndex);
                } else {
                    selectSearchSuggestion(0);
                }
                break;
            case 'Escape':
                event.preventDefault();
                clearSearchSuggestions({ abort: true, resetQuery: false });
                break;
            default:
                break;
        }
    }

    function handleSearchSuggestionListClick(event) {
        const optionEl = event.target.closest('[data-index]');
        if (!optionEl) {
            return;
        }

        const index = Number.parseInt(optionEl.getAttribute('data-index'), 10);
        if (Number.isNaN(index)) {
            return;
        }

        selectSearchSuggestion(index);
    }

    async function loadSearchSuggestions(query, { triggeredByInput = false, autopickSingleResult = false } = {}) {
        const trimmed = typeof query === 'string' ? query.trim() : '';

        if (trimmed.length < MIN_SEARCH_QUERY_LENGTH) {
            clearSearchSuggestions({ abort: triggeredByInput, resetQuery: trimmed.length === 0 });
            return { suggestions: [] };
        }

        abortPendingSearchSuggestions();

        searchSuggestionsQuery = trimmed;
        searchSuggestionController = new AbortController();
        updateState();

        try {
            const url = new URL(NOMINATIM_SEARCH_ENDPOINT);
            url.searchParams.set('format', 'json');
            url.searchParams.set('q', trimmed);
            url.searchParams.set('limit', String(SEARCH_SUGGESTION_LIMIT));
            url.searchParams.set('addressdetails', '1');
            url.searchParams.set('extratags', '1');
            url.searchParams.set('namedetails', '1');
            url.searchParams.set('accept-language', 'he,en');

            const response = await fetch(url.toString(), {
                signal: searchSuggestionController.signal,
                headers: {
                    'Accept-Language': 'he,en;q=0.8'
                }
            });

            if (!response.ok) {
                throw new Error(`Nominatim search failed with status ${response.status}`);
            }

            const payload = await response.json();
            if (!Array.isArray(payload)) {
                throw new Error('Unexpected Nominatim search response format.');
            }

            if (locationNameInput && locationNameInput.value.trim() !== trimmed) {
                return { suggestions: [] };
            }

            const suggestions = payload.map(createSuggestionFromResult).filter(Boolean);
            const normalizedQuery = normalizeSearchText(trimmed);
            const relevantSuggestions = suggestions.filter((suggestion) =>
                suggestionMatchesQuery(suggestion, normalizedQuery)
            );

            const rankedSuggestions = (relevantSuggestions.length > 0 ? relevantSuggestions : suggestions)
                .map((suggestion) => ({
                    suggestion,
                    score: scoreSuggestionRelevance(suggestion, normalizedQuery)
                }))
                .sort((a, b) => {
                    if (a.score !== b.score) {
                        return a.score - b.score;
                    }

                    const aLength = (a.suggestion.displayName || '').length;
                    const bLength = (b.suggestion.displayName || '').length;
                    return aLength - bLength;
                })
                .map((entry) => entry.suggestion);

            searchSuggestions = rankedSuggestions;

            if (rankedSuggestions.length === 0) {
                activeSuggestionIndex = -1;
                renderSearchSuggestions();
                updateState();
                return { suggestions: [] };
            }

            if (activeSuggestionIndex >= rankedSuggestions.length) {
                activeSuggestionIndex = -1;
            }

            if (!triggeredByInput && rankedSuggestions.length === 1) {
                activeSuggestionIndex = 0;
            }

            renderSearchSuggestions();
            updateState();

            if (autopickSingleResult && rankedSuggestions.length === 1) {
                selectSearchSuggestion(0, { focusInput: false });
            }

            return { suggestions: rankedSuggestions };
        } catch (error) {
            if (error?.name === 'AbortError') {
                return { suggestions: [] };
            }

            console.error('Error fetching search suggestions:', error);
            if (!triggeredByInput) {
                clearSearchSuggestions({ abort: true, resetQuery: false });
            }
            return { suggestions: [], error };
        } finally {
            searchSuggestionController = null;
            updateState();
        }
    }


// --- IMPORTANT API KEY ---
// The Gemini API features will not work without a valid API key.
// Get one from Google AI Studio and paste it here.



// --- Element Refs ---
if (targetDetailsCard) {
    targetDetailsCard.setAttribute('aria-hidden', 'true');
}

// Map Tab

// Locations Tab

// Waiting Screen

// Success Modal

// Arrival Confirmation Modal Refs

// Intel Modal

// Rename Location Modal

// --- 0. Initialize App ---
async function initApp() {
    initMap();

    // Define user icon
    userIcon = L.divIcon({
        className: 'user-location-icon',
        iconSize: [18, 18]
    });

    // Event Listeners
    searchBtn.addEventListener('click', () => { void handleSearchLocation(); });
    if (locationNameInput) {
        locationNameInput.addEventListener('input', handleLocationInputChange);
        locationNameInput.addEventListener('keydown', handleLocationInputKeyDown);
    }
    if (searchSuggestionsList) {
        searchSuggestionsList.addEventListener('pointerdown', (event) => event.preventDefault());
        searchSuggestionsList.addEventListener('click', handleSearchSuggestionListClick);
    }

    cancelCheckInBtn.addEventListener('click', () => { void finishCheckIn(false); }); // Don't save
    manualFinishBtn.addEventListener('click', () => { void finishCheckIn(true); }); // Save
    closeSuccessBtn.addEventListener('click', () => successMessage.classList.add('hidden'));

    if (intelModalCloseBtn) {
        intelModalCloseBtn.addEventListener('click', closeIntelModal);
    }

    if (intelModal) {
        intelModal.addEventListener('click', (event) => {
            if (event.target === intelModal) {
                closeIntelModal();
            }
        });
    }

    if (renameLocationCancelBtn) {
        renameLocationCancelBtn.addEventListener('click', () => closeRenameLocationModal());
    }

    if (renameLocationCloseBtn) {
        renameLocationCloseBtn.addEventListener('click', () => closeRenameLocationModal());
    }

    if (renameLocationModal) {
        renameLocationModal.addEventListener('click', (event) => {
            if (event.target === renameLocationModal) {
                closeRenameLocationModal();
            }
        });
    }

    if (renameLocationForm) {
        renameLocationForm.addEventListener('submit', handleRenameLocationSubmit);
    }

    if (renameLocationInput) {
        renameLocationInput.addEventListener('input', () => {
            if (renameLocationError) {
                renameLocationError.textContent = '';
            }
        });
    }

    // Arrival Confirmation Listeners
    confirmArrivalBtn.addEventListener('click', handleConfirmArrival);
    denyArrivalBtn.addEventListener('click', handleDenyArrival);

    // NEW: GPS Button Listener
    gpsStatusBtn.addEventListener('click', startGpsWatcher);

    // Check for onboarding
    if (localStorage.getItem('tfosMakomOnboarding') === 'true') {
        onboardingModal.classList.add('hidden');
    } else {
        onboardingModal.classList.remove('hidden');
    }

    await initializeFirebase();

    // Load saved locations into tab
    renderAllLocations();

    // Start GPS Watcher on load
    startGpsWatcher();

    updateState();
}

// --- 1. Onboarding Logic ---
window.nextSlide = function(slideNumber) {
    document.querySelectorAll('.slide').forEach(s => s.classList.add('hidden'));
    document.getElementById(`slide-${slideNumber}`).classList.remove('hidden');

    const progress = (slideNumber / 3) * 100;
    document.getElementById('onboarding-progress').style.width = `${progress}%`;
}

window.finishOnboarding = function() {
    localStorage.setItem('tfosMakomOnboarding', 'true');
    onboardingModal.classList.add('hidden');
}

// --- 2. Tab Navigation ---
window.switchTab = function(tabName) {
    tabContainers.forEach((el) => el.classList.remove('active'));
    tabButtons.forEach((el) => el.classList.remove('active'));

    document.getElementById(`tab-content-${tabName}`).classList.add('active');
    document.getElementById(`tab-btn-${tabName}`).classList.add('active');

    if (tabName === 'locations') {
        renderAllLocations();
    } else if (tabName === 'map') {
        renderVisitedLocationsOnMap();
        // Invalidate map size to fix potential rendering issues
        setTimeout(() => map.invalidateSize(), 0);
    }
}

// --- Firebase Integration ---
async function initializeFirebase() {
    if (!firebaseConfig) {
        firebaseInitializationError = new Error('חסרה תצורת Firebase.');
        locationsLoaded = true;
        renderAllLocations();
        updateState();
        return;
    }

    if (firebaseAppInstance) {
        updateState();
        return;
    }

    try {
        firebaseAppInstance = initializeApp(firebaseConfig);
        firestoreDb = getFirestore(firebaseAppInstance);
        subscribeToLocations();
    } catch (error) {
        firebaseInitializationError = error;
        console.error('Failed to initialize Firebase', error);
        renderAllLocations();
    }

    updateState();
}

function subscribeToLocations() {
    if (!firestoreDb) return;

    if (unsubscribeLocations) {
        unsubscribeLocations();
    }

    const locationsRef = collection(firestoreDb, FIRESTORE_LOCATIONS_COLLECTION);
    const q = query(locationsRef, orderBy('name', 'asc'));

    unsubscribeLocations = onSnapshot(q, (snapshot) => {
        locationCache.clear();

        snapshot.forEach((docSnap) => {
            const normalized = normalizeLocationRecord(docSnap.id, docSnap.data(), { maxVisitHistory: MAX_VISIT_HISTORY });
            locationCache.set(docSnap.id, normalized);
        });

        locationsLoaded = true;
        firebaseInitializationError = null;
        onLocationDataUpdated();
        pulseLiveStatus('receive', 'נתונים חיים עודכנו');
        updateState();
    }, (error) => {
        console.error('Firestore listener error', error);
        firebaseInitializationError = error;
        locationsLoaded = true;
        renderAllLocations();
        updateState();
    });
}

function onLocationDataUpdated() {
    renderAllLocations();
    renderVisitedLocationsOnMap();

    if (currentLocationId && targetDetailsCard && targetDetailsCard.getAttribute('aria-hidden') === 'false') {
        showLocationCard(targetName, currentLocationId);
    }
}

function getLocationFromCache(id) {
    if (!id) return null;
    return locationCache.get(id) || null;
}

function upsertLocationInCache(id, data) {
    if (!id) return;

    const normalized = normalizeLocationRecord(id, data, { maxVisitHistory: MAX_VISIT_HISTORY });
    locationCache.set(id, normalized);
    locationsLoaded = true;
    onLocationDataUpdated();
    updateState();
}

// --- 3. Map & Search ---
function initMap() {
    map = L.map('map', {
        zoomControl: false // Disable default zoom
    }).setView([32.0853, 34.7818], 13); // Default to Tel Aviv

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    poiLayer = L.layerGroup().addTo(map);
    visitedLocationsLayer = L.layerGroup().addTo(map);

    // Add zoom control to bottom-right
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // Set target on map click
    map.on('click', (e) => {
        const { lat, lng } = e.latlng;
        targetName = `מיקום (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
        locationNameInput.value = targetName;
        clearSearchSuggestions({ abort: true, resetQuery: false });
        selectLocation(lat, lng, targetName);
    });

    renderVisitedLocationsOnMap();

    scheduleNearbyPlacesRefresh({ immediate: true });

    map.on('moveend', handleMapMoveEnd);

    updateState();
}

function handleMapMoveEnd() {
    scheduleNearbyPlacesRefresh();
}

function scheduleNearbyPlacesRefresh({ immediate = false } = {}) {
    if (!map) {
        return;
    }

    if (poiRefreshTimeoutId) {
        clearTimeout(poiRefreshTimeoutId);
        poiRefreshTimeoutId = null;
    }

    const triggerFetch = () => {
        poiRefreshTimeoutId = null;
        fetchNearbyPlaces().catch((error) => {
            if (error?.name === 'AbortError') {
                return;
            }
            console.error('Failed to refresh nearby places', error);
        });
    };

    if (immediate) {
        triggerFetch();
    } else {
        poiRefreshTimeoutId = setTimeout(triggerFetch, 450);
    }

    updateState();
}

async function fetchNearbyPlaces() {
    if (!map) {
        return;
    }

    if (poiFetchAbortController) {
        poiFetchAbortController.abort();
    }

    const bounds = map.getBounds();
    if (!bounds) {
        return;
    }

    const zoomLevel = map.getZoom();
    if (!Number.isFinite(zoomLevel) || zoomLevel < 12) {
        if (poiLayer) {
            poiLayer.clearLayers();
        }
        lastPoiFetchBounds = null;
        updateState();
        return;
    }

    const south = bounds.getSouth();
    const west = bounds.getWest();
    const north = bounds.getNorth();
    const east = bounds.getEast();

    if (![south, west, north, east].every((coord) => Number.isFinite(coord))) {
        return;
    }

    const boundsSummary = {
        south: Number(south.toFixed(5)),
        west: Number(west.toFixed(5)),
        north: Number(north.toFixed(5)),
        east: Number(east.toFixed(5)),
        zoom: Number(zoomLevel.toFixed(2))
    };

    lastPoiFetchBounds = boundsSummary;

    poiFetchAbortController = new AbortController();
    const signal = poiFetchAbortController.signal;

    isLoadingPois = true;
    updateState();

    const query = buildOverpassPlacesQuery({ south, west, north, east });

    try {
        const response = await fetch('https://overpass-api.de/api/interpreter', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
            },
            body: new URLSearchParams({ data: query }),
            signal
        });

        if (!response.ok) {
            throw new Error(`Overpass API responded with status ${response.status}`);
        }

        const data = await response.json();
        if (signal.aborted) {
            return;
        }

        const elements = Array.isArray(data?.elements) ? data.elements : [];
        renderPointsOfInterest(elements);
    } catch (error) {
        if (error?.name === 'AbortError') {
            return;
        }
        console.error('Failed to fetch nearby places', error);
    } finally {
        if (poiFetchAbortController?.signal === signal) {
            poiFetchAbortController = null;
        }
        isLoadingPois = false;
        updateState();
    }
}

function buildOverpassPlacesQuery({ south, west, north, east }) {
    const bbox = [south, west, north, east]
        .map((coord) => coord.toFixed(6))
        .join(',');

    return `
[out:json][timeout:25];
(
  node["amenity"~"^(restaurant|cafe|bar)$"](${bbox});
  way["amenity"~"^(restaurant|cafe|bar)$"](${bbox});
  rel["amenity"~"^(restaurant|cafe|bar)$"](${bbox});
);
out center 120;
`;
}

function renderPointsOfInterest(elements) {
    if (!map) {
        return;
    }

    if (!poiLayer) {
        poiLayer = L.layerGroup().addTo(map);
    }

    poiLayer.clearLayers();

    const uniqueElements = new Map();
    for (const element of elements) {
        if (!element || typeof element.id === 'undefined') {
            continue;
        }
        const key = `${element.type || 'node'}_${element.id}`;
        if (!uniqueElements.has(key)) {
            uniqueElements.set(key, element);
        }
    }

    const places = [];
    for (const [, element] of uniqueElements.entries()) {
        const place = normalizeOverpassElement(element);
        if (place) {
            places.push(place);
        }
    }

    for (const place of places.slice(0, 160)) {
        const marker = L.marker([place.lat, place.lon], {
            icon: createPoiIcon(place)
        }).addTo(poiLayer);

        marker.bindTooltip(place.displayName, {
            direction: 'top',
            offset: [0, -12],
            opacity: 0.95,
            className: 'poi-tooltip'
        });

        marker.on('click', () => {
            const locationId = `poi_${place.sourceType}_${place.id}`;
            if (locationNameInput) {
                locationNameInput.value = place.displayName;
            }
            selectLocation(place.lat, place.lon, place.displayName, locationId, { placeInfo: place });
        });
    }

    updateState();
}

function normalizeOverpassElement(element) {
    if (!element) {
        return null;
    }

    const tags = element.tags || {};
    const amenity = typeof tags.amenity === 'string' ? tags.amenity : '';

    if (!ALLOWED_POI_AMENITIES.has(amenity)) {
        return null;
    }

    const lat = Number.isFinite(element.lat) ? element.lat : element.center?.lat;
    const lon = Number.isFinite(element.lon) ? element.lon : element.center?.lon;

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return null;
    }

    const rawName = typeof tags.name === 'string' ? tags.name.trim() : '';
    const displayName = rawName || buildFallbackPoiName(tags);
    const category = resolvePoiCategory(tags);
    const addressLines = buildPoiAddressLines(tags);
    const infoLines = buildPoiInfoLines(tags);
    const websiteRaw = extractFirstTagValue(tags, ['website', 'contact:website', 'url']);
    const website = sanitizeUrl(websiteRaw);

    return {
        id: element.id,
        sourceType: element.type || 'node',
        lat,
        lon,
        name: rawName,
        displayName,
        tags,
        category,
        addressLines,
        infoLines,
        website,
        websiteLabel: websiteRaw || website,
        phone: extractFirstTagValue(tags, ['phone', 'contact:phone']),
        openingHours: typeof tags.opening_hours === 'string' ? tags.opening_hours : ''
    };
}

function buildFallbackPoiName(tags) {
    const category = resolvePoiCategory(tags);
    if (category && category.label) {
        return `${category.label} בקרבת מקום`;
    }
    return 'נקודת עניין בסביבה';
}

function resolvePoiCategory(tags = {}) {
    const amenity = typeof tags.amenity === 'string' ? tags.amenity : '';
    const shop = typeof tags.shop === 'string' ? tags.shop : '';
    const tourism = typeof tags.tourism === 'string' ? tags.tourism : '';

    const amenityCategory = AMENITY_CATEGORY_MAP[amenity];
    if (amenityCategory) {
        return amenityCategory;
    }

    const shopCategory = SHOP_CATEGORY_MAP[shop];
    if (shopCategory) {
        return shopCategory;
    }

    const tourismCategory = TOURISM_CATEGORY_MAP[tourism];
    if (tourismCategory) {
        return tourismCategory;
    }

    if (amenity) {
        return createDynamicCategory(amenity, 'services', '📍');
    }

    if (shop) {
        return createDynamicCategory(shop, 'shopping', '🛍️');
    }

    if (tourism) {
        return createDynamicCategory(tourism, 'culture', '🎭');
    }

    return DEFAULT_POI_CATEGORY;
}

function createDynamicCategory(key, group, emoji) {
    return {
        key,
        label: humanizePoiLabel(key),
        group,
        emoji
    };
}

const AMENITY_CATEGORY_MAP = Object.freeze({
    restaurant: { key: 'restaurant', label: 'מסעדה', group: 'food', emoji: '🍽️' },
    cafe: { key: 'cafe', label: 'בית קפה', group: 'food', emoji: '☕' },
    bar: { key: 'bar', label: 'בר', group: 'food', emoji: '🍸' },
    fast_food: { key: 'fast_food', label: 'מזון מהיר', group: 'food', emoji: '🍔' },
    pub: { key: 'pub', label: 'פאב', group: 'food', emoji: '🍻' },
    food_court: { key: 'food_court', label: 'פודקורט', group: 'food', emoji: '🍽️' },
    ice_cream: { key: 'ice_cream', label: 'גלידריה', group: 'food', emoji: '🍨' },
    bakery: { key: 'bakery', label: 'מאפייה', group: 'food', emoji: '🥐' },
    cinema: { key: 'cinema', label: 'קולנוע', group: 'culture', emoji: '🎬' },
    theatre: { key: 'theatre', label: 'תיאטרון', group: 'culture', emoji: '🎭' },
    arts_centre: { key: 'arts_centre', label: 'מרכז תרבות', group: 'culture', emoji: '🎨' },
    nightclub: { key: 'nightclub', label: 'מועדון לילה', group: 'culture', emoji: '🎶' }
});

const SHOP_CATEGORY_MAP = Object.freeze({
    supermarket: { key: 'supermarket', label: 'סופרמרקט', group: 'shopping', emoji: '🛒' },
    convenience: { key: 'convenience', label: 'מכולת', group: 'shopping', emoji: '🛍️' },
    mall: { key: 'mall', label: 'קניון', group: 'shopping', emoji: '🏬' },
    department_store: { key: 'department_store', label: 'כלבו', group: 'shopping', emoji: '🏢' },
    clothes: { key: 'clothes', label: 'חנות בגדים', group: 'shopping', emoji: '👕' },
    shoes: { key: 'shoes', label: 'חנות נעליים', group: 'shopping', emoji: '👟' },
    electronics: { key: 'electronics', label: 'אלקטרוניקה', group: 'shopping', emoji: '🔌' },
    books: { key: 'books', label: 'חנות ספרים', group: 'shopping', emoji: '📚' },
    gift: { key: 'gift', label: 'מתנות', group: 'shopping', emoji: '🎁' },
    beauty: { key: 'beauty', label: 'קוסמטיקה', group: 'shopping', emoji: '💄' }
});

const TOURISM_CATEGORY_MAP = Object.freeze({
    museum: { key: 'museum', label: 'מוזיאון', group: 'culture', emoji: '🏛️' },
    gallery: { key: 'gallery', label: 'גלריה', group: 'culture', emoji: '🖼️' },
    attraction: { key: 'attraction', label: 'אטרקציה', group: 'culture', emoji: '⭐' }
});

const DEFAULT_POI_CATEGORY = Object.freeze({
    key: 'poi',
    label: 'נקודת עניין',
    group: 'services',
    emoji: '📍'
});

function humanizePoiLabel(value) {
    if (typeof value !== 'string') {
        return '';
    }

    return value
        .split(/[_-]/)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ')
        .trim();
}

function buildPoiAddressLines(tags = {}) {
    const street = extractFirstTagValue(tags, ['addr:street', 'addr:road']);
    const houseNumber = extractFirstTagValue(tags, ['addr:housenumber']);
    const city = extractFirstTagValue(tags, ['addr:city', 'addr:town', 'addr:place', 'addr:suburb']);
    const postcode = extractFirstTagValue(tags, ['addr:postcode']);

    const lines = [];
    if (street) {
        const streetLine = [street, houseNumber].filter(Boolean).join(' ');
        if (streetLine) {
            lines.push(streetLine);
        }
    }

    if (city) {
        lines.push(city);
    }

    if (postcode) {
        lines.push(`מיקוד ${postcode}`);
    }

    return lines;
}

function buildPoiInfoLines(tags = {}) {
    const lines = [];

    const cuisine = extractFirstTagValue(tags, ['cuisine']);
    if (cuisine) {
        lines.push({ label: 'מטבח', value: humanizePoiLabel(cuisine) });
    }

    const openingHours = typeof tags.opening_hours === 'string' ? tags.opening_hours : '';
    if (openingHours) {
        lines.push({ label: 'שעות פתיחה', value: openingHours });
    }

    const phone = extractFirstTagValue(tags, ['phone', 'contact:phone']);
    if (phone) {
        lines.push({ label: 'טלפון', value: phone });
    }

    return lines;
}

function extractFirstTagValue(tags, keys) {
    if (!tags || !Array.isArray(keys)) {
        return '';
    }

    for (const key of keys) {
        const value = tags[key];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }

    return '';
}

function sanitizeUrl(value) {
    if (typeof value !== 'string') {
        return '';
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return '';
    }

    if (/^https?:\/\//i.test(trimmed)) {
        return trimmed;
    }

    if (/^\/\//.test(trimmed)) {
        return `https:${trimmed}`;
    }

    if (/^[\w.-]+\.[\w.-]+(?:\/[\w./%-]*)?$/i.test(trimmed)) {
        return `https://${trimmed}`;
    }

    return '';
}

function createPoiIcon(place) {
    const groupClass = place?.category?.group ? `poi-marker--${place.category.group}` : 'poi-marker--services';
    const emoji = place?.category?.emoji || '📍';

    return L.divIcon({
        className: 'poi-marker-wrapper',
        html: `<div class="poi-marker ${groupClass}"><span class="poi-marker__emoji">${escapeHtml(emoji)}</span></div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
        popupAnchor: [0, -16],
        tooltipAnchor: [0, -18]
    });
}

async function handleSearchLocation() {
    const query = typeof locationNameInput?.value === 'string' ? locationNameInput.value.trim() : '';
    if (!query) {
        return;
    }

    if (Array.isArray(searchSuggestions) && searchSuggestions.length > 0) {
        const index = activeSuggestionIndex >= 0 ? activeSuggestionIndex : 0;
        selectSearchSuggestion(index);
        return;
    }

    searchBtn.disabled = true;
    searchBtn.innerHTML = '<div class="spinner w-5 h-5 border-2 rounded-full"></div>';

    try {
        const { suggestions, error } = await loadSearchSuggestions(query, { autopickSingleResult: true });
        if (error) {
            throw error;
        }

        if (!suggestions || suggestions.length === 0) {
            alert('לא נמצאו תוצאות עבור החיפוש.');
            clearSearchSuggestions({ abort: true, resetQuery: false });
            return;
        }

        if (Array.isArray(searchSuggestions) && searchSuggestions.length > 1) {
            locationNameInput?.focus();
        }
    } catch (error) {
        console.error('Error searching location:', error);
        alert('אירעה שגיאה בחיפוש המיקום.');
    } finally {
        searchBtn.disabled = false;
        searchBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clip-rule="evenodd" /></svg>`;
    }
}

function selectLocation(lat, lon, name, id = null, options = {}) {
    if (map) {
        map.closePopup();
    }
    targetCoords = { lat, lon };
    targetName = name;

    const placeInfo = options?.placeInfo;
    if (placeInfo && typeof placeInfo === 'object') {
        selectedPlaceInfo = {
            id: `poi_${placeInfo.sourceType || 'node'}_${placeInfo.id ?? ''}`,
            displayName: placeInfo.displayName || name,
            category: placeInfo.category || null,
            addressLines: Array.isArray(placeInfo.addressLines) ? [...placeInfo.addressLines] : [],
            infoLines: Array.isArray(placeInfo.infoLines) ? [...placeInfo.infoLines] : [],
            website: typeof placeInfo.website === 'string' ? placeInfo.website : '',
            websiteLabel: typeof placeInfo.websiteLabel === 'string' ? placeInfo.websiteLabel : '',
            phone: typeof placeInfo.phone === 'string' ? placeInfo.phone : '',
            openingHours: typeof placeInfo.openingHours === 'string' ? placeInfo.openingHours : '',
            tags: placeInfo.tags || null
        };
    } else {
        selectedPlaceInfo = null;
    }

    // Generate a unique ID if one isn't provided
    currentLocationId = id || `loc_${lat.toFixed(6)}_${lon.toFixed(6)}`;

    // Clear previous markers
    if (targetMarker) map.removeLayer(targetMarker);
    if (targetCircle) map.removeLayer(targetCircle);

    // Add new marker (10m radius)
    targetMarker = L.marker([lat, lon]).addTo(map);
    const circleStyle = locationCache.has(currentLocationId) ? RADIUS_STYLES.selectedVisited : RADIUS_STYLES.newLocation;
    targetCircle = L.circle([lat, lon], { ...circleStyle }).addTo(map);

    // Zoom map
    map.setView([lat, lon], 19);

    // Show location details card
    showLocationCard(name, currentLocationId);

    // Ensure map tab is active
    if (document.getElementById('tab-content-locations').classList.contains('active')) {
        switchTab('map');
    }

    updateState();
}

function hideLocationCard() {
    if (!targetDetailsCard) return;
    targetDetailsCard.classList.add('translate-y-full');
    targetDetailsCard.classList.remove('float-in');
    targetDetailsCard.setAttribute('aria-hidden', 'true');
    targetDetailsCard.innerHTML = '';
}

function renderSelectedPlaceInfoSection(placeInfo) {
    if (!placeInfo) {
        return '';
    }

    const emoji = placeInfo?.category?.emoji || '📍';
    const categoryLabel = placeInfo?.category?.label || 'נקודת עניין בסביבה';
    const addressHtml = Array.isArray(placeInfo.addressLines) && placeInfo.addressLines.length > 0
        ? `<div class="mt-3">
                <h4 class="text-xs font-semibold text-blue-900 uppercase tracking-wide mb-1">כתובת</h4>
                <p class="text-sm text-blue-900/90 leading-snug">${escapeHtml(placeInfo.addressLines.join(', '))}</p>
            </div>`
        : '';

    const detailItems = [];
    if (Array.isArray(placeInfo.infoLines)) {
        for (const info of placeInfo.infoLines) {
            if (info?.label && info?.value) {
                detailItems.push(`<li><span class="font-semibold">${escapeHtml(info.label)}:</span> ${escapeHtml(info.value)}</li>`);
            }
        }
    }

    const openingHours = placeInfo.openingHours && !detailItems.some((item) => item.includes('שעות פתיחה'))
        ? `<li><span class="font-semibold">שעות פתיחה:</span> ${escapeHtml(placeInfo.openingHours)}</li>`
        : '';

    if (openingHours) {
        detailItems.push(openingHours);
    }

    if (placeInfo.phone) {
        detailItems.push(`<li><span class="font-semibold">טלפון:</span> ${escapeHtml(placeInfo.phone)}</li>`);
    }

    const detailsHtml = detailItems.length > 0
        ? `<ul class="mt-3 space-y-1 text-sm text-blue-900/90">${detailItems.join('')}</ul>`
        : '';

    let websiteHtml = '';
    const rawWebsiteLabel = typeof placeInfo.websiteLabel === 'string' && placeInfo.websiteLabel.trim()
        ? placeInfo.websiteLabel.trim()
        : placeInfo.website || '';
    const displayWebsite = rawWebsiteLabel.replace(/^https?:\/\//, '');
    if (placeInfo.website) {
        websiteHtml = `<div class="mt-3 text-sm"><span class="font-semibold text-blue-900">אתר:</span> <a href="${escapeHtml(placeInfo.website)}" target="_blank" rel="noopener" class="text-blue-700 underline">${escapeHtml(displayWebsite)}</a></div>`;
    } else if (displayWebsite) {
        websiteHtml = `<div class="mt-3 text-sm"><span class="font-semibold text-blue-900">אתר:</span> ${escapeHtml(displayWebsite)}</div>`;
    }

    return `
        <div class="selected-place-info bg-blue-50 border border-blue-100 rounded-lg p-4 mb-4">
            <div class="flex items-center gap-3">
                <div class="selected-place-info__icon" aria-hidden="true">${escapeHtml(emoji)}</div>
                <p class="text-sm font-semibold text-blue-900">${escapeHtml(categoryLabel)}</p>
            </div>
            ${addressHtml}
            ${detailsHtml}
            ${websiteHtml}
            <p class="mt-3 text-[0.7rem] text-blue-800/60">לחצו על "התחל צ'ק-אין" כדי לשתף את זמן ההמתנה שלכם במקום זה.</p>
        </div>
    `;
}

function showLocationCard(name, id) {
    if (!targetDetailsCard) return;
    const locationData = getLocationFromCache(id) || { id, name, totalCheckIns: 0, avgWaitSeconds: 0, visits: [], coords: sanitizeCoords(targetCoords), intel: null };

    const overallAverageDisplay = locationData.totalCheckIns > 0
        ? formatDurationWithUnits(locationData.avgWaitSeconds)
        : "אין עדיין מידע";

    const stats = computeLocationStats(locationData.visits);
    const { dayIndex, hourIndex } = getCurrentTimeContext();
    const todaysHourly = stats.hourlyAverages?.[dayIndex] || [];
    const todaysAverageSeconds = computeDailyAverageWaitSeconds(todaysHourly);
    const todaysAverageDisplay = formatDurationWithUnits(todaysAverageSeconds);
    const currentHourStats = getCurrentHourStats(todaysHourly, hourIndex);
    const hourlyChartHtml = renderHourlyChart(todaysHourly, hourIndex, {
        variant: 'app',
        emptyMessage: 'אין עדיין נתונים לשעות היום במיקום זה.'
    });
    const weeklyHasData = Array.isArray(stats.weeklyAverages)
        && stats.weeklyAverages.some((value) => Number.isFinite(value) && value > 0);
    const weeklySummaryPreviewHtml = weeklyHasData
        ? renderWeeklySummary(stats.weeklyAverages, dayIndex, {
            variant: 'app',
            emptyMessage: 'אין עדיין נתונים שבועיים עבור מיקום זה.',
            compact: true
        })
        : '';
    const weeklySummaryExpandedHtml = renderWeeklySummary(stats.weeklyAverages, dayIndex, {
        variant: 'app',
        emptyMessage: 'אין עדיין נתונים שבועיים עבור מיקום זה.'
    });

    const hasIntel = hasIntelData(locationData.intel);
    const intelPreviewHtml = renderIntelPreviewHtml(locationData.intel, {
        emptyMessage: 'היו הראשונים לקבל סקירה למיקום זה באמצעות Gemini כאשר תבצעו צ\'ק-אין.',
        textClass: 'text-xs text-gray-500 mt-2',
        summaryClass: 'text-sm text-blue-900/90 leading-relaxed',
        maxLength: 220
    });
    const placeInfoHtml = renderSelectedPlaceInfoSection(selectedPlaceInfo);

    targetDetailsCard.innerHTML = `
        <div class="flex items-start justify-between gap-3 mb-2">
            <h3 class="font-bold text-lg text-gray-900">${name}</h3>
            <button id="close-location-card-btn" type="button" class="w-8 h-8 flex items-center justify-center rounded-full bg-blue-100 text-blue-700 text-lg font-semibold leading-none hover:bg-blue-200 transition" aria-label="סגירת חלון מידע" title="סגירה">
                ×
            </button>
        </div>
        ${placeInfoHtml}
        <div class="bg-gradient-to-r from-blue-600 via-blue-500 to-indigo-500 text-white rounded-xl p-4 mb-4 shadow-sm">
            <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <p class="text-xs uppercase tracking-wide text-blue-100">ממוצע ההמתנה היום</p>
                    <p class="text-2xl font-bold">${todaysAverageDisplay}</p>
                </div>
                <div class="sm:text-right">
                    <p class="text-xs uppercase tracking-wide text-blue-100">מצב נוכחי</p>
                    <p class="text-xs text-blue-100/80 mb-1">${DAY_NAMES_HE[dayIndex]} · ${formatHourLabel(hourIndex)}</p>
                    <p class="text-lg font-semibold">${currentHourStats.label}</p>
                </div>
            </div>
        </div>
        <details class="bg-white border border-gray-200 rounded-lg p-3 mb-4" data-testid="location-stats-toggle">
            <summary class="flex items-center justify-between gap-2 cursor-pointer text-sm font-semibold text-gray-700">
                <span>סטטיסטיקות</span>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-4 h-4 text-gray-500 transition-transform details-arrow">
                    <path fill-rule="evenodd" d="M12 16a1 1 0 0 1-.707-.293l-5-5a1 1 0 1 1 1.414-1.414L12 13.586l4.293-4.293a1 1 0 1 1 1.414 1.414l-5 5A1 1 0 0 1 12 16Z" clip-rule="evenodd" />
                </svg>
            </summary>
            <div class="mt-3 flex flex-col gap-4 text-sm text-gray-600 leading-relaxed">
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div class="bg-gray-50 rounded-lg p-3 text-gray-600">
                        <div class="font-semibold text-gray-700">ממוצע כללי</div>
                        <div class="text-blue-600 font-semibold">${overallAverageDisplay}</div>
                    </div>
                    <div class="bg-gray-50 rounded-lg p-3 text-gray-600">
                        <div class="font-semibold text-gray-700">סה"כ צ'ק-אינים</div>
                        <div class="text-blue-600 font-semibold">${locationData.totalCheckIns}</div>
                    </div>
                </div>
                <div class="bg-white border border-blue-100 rounded-lg p-3">
                    <h4 class="text-sm font-semibold text-gray-700">ממוצע לפי שעה (היום)</h4>
                    ${hourlyChartHtml}
                </div>
                <details class="bg-white border border-gray-200 rounded-lg p-3" ${weeklyHasData ? '' : 'open'}>
                    <summary class="flex flex-col gap-2 cursor-pointer text-sm font-semibold text-gray-700">
                        <span>מבט שבועי</span>
                        ${weeklyHasData ? `<div class="text-xs text-gray-600">${weeklySummaryPreviewHtml}</div>` : ''}
                    </summary>
                    <div class="mt-3 text-sm text-gray-600 leading-relaxed">${weeklySummaryExpandedHtml}</div>
                </details>
                <div class="bg-blue-50 border border-blue-100 rounded-lg p-4">
                    <div class="flex items-center justify-between gap-3">
                        <div>
                            <h4 class="text-sm font-semibold text-blue-900">סקירת יעד</h4>
                            <p class="text-xs text-blue-700 opacity-80">מידע תמציתי לביקור חכם</p>
                        </div>
                        ${hasIntel ? `<button type="button" class="open-intel-modal-btn text-xs font-semibold bg-blue-600 text-white rounded-full px-3 py-2 hover:bg-blue-700 transition">פתח סקירה מלאה</button>` : ''}
                    </div>
                    <div class="mt-3 bg-white rounded-xl border border-blue-100/60 p-3 max-h-60 overflow-y-auto ${hasIntel ? 'intel-rich-text text-sm text-blue-900/90' : ''}">
                        ${intelPreviewHtml}
                    </div>
                </div>
            </div>
        </details>
        <button id="start-check-in-btn" class="w-full bg-green-600 text-white font-bold py-3 px-4 rounded-md hover:bg-green-700 transition">
            התחל צ'ק-אין למקום
        </button>
    `;

    // Add event listener to the new button
    const closeBtn = targetDetailsCard.querySelector('#close-location-card-btn');
    document.getElementById('start-check-in-btn').onclick = startCheckIn;
    if (closeBtn) {
        closeBtn.addEventListener('click', hideLocationCard);
    }

    const intelModalBtn = targetDetailsCard.querySelector('.open-intel-modal-btn');
    if (intelModalBtn) {
        intelModalBtn.addEventListener('click', () => {
            openIntelModal({ ...locationData, name });
        });
    }

    // Animate card in
    targetDetailsCard.classList.remove('float-in');
    void targetDetailsCard.offsetWidth;
    targetDetailsCard.classList.remove('translate-y-full');
    targetDetailsCard.classList.add('float-in');
    targetDetailsCard.setAttribute('aria-hidden', 'false');
}

// --- 4. Check-In Logic ---
function startCheckIn() {
    if (!targetCoords) {
        alert("אנא בחר מיקום תחילה.");
        return;
    }

    // Hide main screen, show waiting screen
    mainScreen.classList.add('hidden');
    waitingScreen.classList.remove('hidden');

    waitingLocationName.textContent = targetName;

    // Reset UI
    timerDisplay.textContent = "00:00";
    // Clearer initial state
    waitingDistance.textContent = "...ממתין ל-GPS";
    waitingBearing.textContent = "...ממתין ל-GPS";
    gpsCountdownEl.textContent = "";
    infoResult.innerHTML = "";
    infoSources.innerHTML = "";
    infoSources.classList.add('hidden');
    infoErrorEl.textContent = "";
    infoLoading.classList.remove('hidden');

    // Start Timer
    checkInStartTime = Date.now();
    checkInTimerInterval = setInterval(updateTimerDisplay, 1000);

    // (GPS watcher is already running, it will now pick up the new state)

    // Immediately update UI with last known position
    if (lastKnownPosition) {
        updateWaitingUI(lastKnownPosition); 
    }

    // Fire Gemini Calls
    handleGetInfo();

    // Init Mini Map
    setTimeout(initMiniMap, 100);

    updateState();
}

function updateTimerDisplay() {
    if (!checkInStartTime) return;

    const elapsedSeconds = (Date.now() - checkInStartTime) / 1000;
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = Math.floor(elapsedSeconds % 60);

    timerDisplay.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function updateWaitingUI(position) {
    if (!checkInStartTime || !targetCoords) return; // Only run if checking in

    const { latitude: userLat, longitude: userLon } = position.coords;
    const userLatLng = L.latLng(userLat, userLon);

    // Update user marker on MINI map
    if (miniMap) {
        if (!miniMapUserMarker) {
            miniMapUserMarker = L.marker(userLatLng, { icon: userIcon }).addTo(miniMap);
        } else {
            miniMapUserMarker.setLatLng(userLatLng);
        }

        // Keep both markers in view
        miniMap.fitBounds(L.latLngBounds(userLatLng, [targetCoords.lat, targetCoords.lon]), { padding: [20, 20], maxZoom: 17 });
        scheduleMiniMapResize();
    }

    // Calculations
    const distance = map.distance([userLat, userLon], [targetCoords.lat, targetCoords.lon]);
    const bearing = getBearing(userLat, userLon, targetCoords.lat, targetCoords.lon);
    const compassDirection = getCompassDirection(bearing);

    // Update Waiting UI
    waitingDistance.textContent = `${distance.toFixed(1)} מטר`;
    waitingBearing.textContent = `${bearing.toFixed(1)}° (${compassDirection})`;

    // --- The "Win" Condition ---
    if (distance <= 10) {
        // Check if we are in a cooldown period
        if (confirmationCooldownUntil && Date.now() < confirmationCooldownUntil) {
            // Cooldown is active, do nothing
            return;
        }

        // Check if modal is already open
        if (!arrivalConfirmationModal.classList.contains('hidden')) {
            // Modal is already open, do nothing
            return;
        }

        // --- Show Confirmation ---
        console.log("User entered 10m radius. Showing confirmation.");

        // Pause the timer
        if (checkInTimerInterval) {
            clearInterval(checkInTimerInterval);
            checkInTimerInterval = null;
        }

        // Show the modal
        arrivalConfirmationModal.classList.remove('hidden');
    }
}

function handleConfirmArrival() {
    arrivalConfirmationModal.classList.add('hidden');
    void finishCheckIn(true); // Save data and finish
}

function handleDenyArrival() {
    arrivalConfirmationModal.classList.add('hidden');

    // Set 30 second cooldown to prevent modal from popping up immediately
    confirmationCooldownUntil = Date.now() + 30000; 

    // Resume timer
    if (checkInStartTime && !checkInTimerInterval) {
        checkInTimerInterval = setInterval(updateTimerDisplay, 1000);
    }

    updateState();
}

async function finishCheckIn(saveData) {
    if (isSavingCheckIn) {
        return;
    }

    // Ensure confirmation modal is hidden and cooldown is reset
    arrivalConfirmationModal.classList.add('hidden');
    confirmationCooldownUntil = null;

    // Stop timers
    if (checkInTimerInterval) clearInterval(checkInTimerInterval);
    if (gpsCountdownInterval) clearInterval(gpsCountdownInterval);
    checkInTimerInterval = null;
    gpsCountdownInterval = null;

    destroyMiniMap(); // Destroy mini-map

    const finalTimeDisplay = timerDisplay.textContent;

    if (saveData && checkInStartTime) {
        const elapsedSeconds = (Date.now() - checkInStartTime) / 1000;

        try {
            setWaitingScreenSavingState(true);
            await saveWaitTime(currentLocationId, targetName, targetCoords, elapsedSeconds);

            // Show success message
            successTime.textContent = `זמן ההמתנה שלך (${finalTimeDisplay}) נשמר!`;
            successMessage.classList.remove('hidden');
        } catch (error) {
            console.error('Failed to save wait time', error);
            alert('אירעה שגיאה בשמירת הנתונים לענן. אנא נסה שוב.');
        } finally {
            setWaitingScreenSavingState(false);
        }
    }

    // Reset state
    checkInStartTime = null;
    // currentLocationId and targetName are kept for the card

    // Hide waiting screen, show main screen
   waitingScreen.classList.add('hidden');
   mainScreen.classList.remove('hidden');

   // Re-show location card
   if (targetCoords) {
       showLocationCard(targetName, currentLocationId);
   }

    updateState();
}

// --- 5. GPS Watcher ---
function startGpsWatcher() {
    // NEW: If a successful watcher is already running, don't start another.
    if (gpsWatcherId !== null && lastKnownPosition !== null) {
        console.log("GPS watcher is active and has a fix.");
        return;
    }

    // NEW: If a watcher is trying (has ID but no position), clear it before starting a new one.
    if (gpsWatcherId !== null) {
        navigator.geolocation.clearWatch(gpsWatcherId);
        gpsWatcherId = null;
    }

    if (!navigator.geolocation) {
        // gpsErrorEl.textContent = "GPS אינו נתמך בדפדפן זה."; // OLD
        gpsStatusBtn.textContent = "GPS אינו נתמך"; // NEW
        gpsStatusBtn.disabled = true; // NEW
        return;
    }

    // NEW: Set button state to loading
    gpsStatusBtn.textContent = "מאתר מיקום GPS...";
    gpsStatusBtn.disabled = true;

    const options = {
        enableHighAccuracy: true,
        timeout: 5000, // 5 seconds
        maximumAge: 0 // Don't use a cached position
    };

    gpsWatcherId = navigator.geolocation.watchPosition(
        updatePosition,
        handleGpsError,
        options
    );

    updateState();
}

function updatePosition(position) {
    lastGpsTime = Date.now();
    lastKnownPosition = position; // Store last known position
    startGpsCountdown(); // Start/reset the 5-second countdown

    console.log("GPS Update Received at:", new Date().toLocaleTimeString(), position.coords);
    const { latitude: userLat, longitude: userLon } = position.coords;

    // gpsErrorEl.textContent = "GPS פעיל"; // OLD
    gpsStatusBtn.textContent = "GPS פעיל"; // NEW
    gpsStatusBtn.disabled = true; // NEW: Disable on success

    // Update user marker on MAIN map
    const userLatLng = L.latLng(userLat, userLon);
    if (!userMarker) {
        userMarker = L.marker(userLatLng, { icon: userIcon }).addTo(map).bindPopup("<b>מיקומך</b>");
        map.setView(userLatLng, 17); // Pan to user on first fix
    } else {
        userMarker.setLatLng(userLatLng);
    }

    // --- Logic for when check-in is ACTIVE ---
    if (checkInStartTime && targetCoords) {
        updateWaitingUI(position); // Call the new UI update function
    }

    updateState();
}

function handleGpsError(error) {
    console.warn(`GPS Error: ${error.message}`);
    let message = "שגיאת GPS";
    if (error.code === error.PERMISSION_DENIED) {
        message = "לחץ כאן לאישור מיקום"; // NEW
    } else if (error.code === error.POSITION_UNAVAILABLE) {
        message = "מיקום לא זמין. לחץ לנסות שוב."; // NEW
    } else if (error.code === error.TIMEOUT) {
        message = "זמן קצוב. לחץ לנסות שוב."; // NEW
    }
    // gpsErrorEl.textContent = message; // OLD
    gpsStatusBtn.textContent = message; // NEW
    gpsStatusBtn.disabled = false; // NEW: Re-enable button on failure

    // NEW: Clear the failed watcher ID so it can be started again
    if (gpsWatcherId) {
        navigator.geolocation.clearWatch(gpsWatcherId);
        gpsWatcherId = null;
    }

    if (checkInStartTime) {
        waitingDistance.textContent = "שגיאת GPS";
        waitingBearing.textContent = "שגיאת GPS";
    }

    updateState();
}

function startGpsCountdown() {
    if (gpsCountdownInterval) clearInterval(gpsCountdownInterval);
    gpsCountdownInterval = null;

    if (gpsCountdownEl) {
        gpsCountdownEl.textContent = '';
    }

    updateState();
}

// --- 6. Bearing & Compass Calculations ---
function getBearing(lat1, lon1, lat2, lon2) {
    const rad = Math.PI / 180;
    const dLon = (lon2 - lon1) * rad;
    lat1 = lat1 * rad;
    lat2 = lat2 * rad;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    let brng = Math.atan2(y, x) * (180 / Math.PI);
    brng = (brng + 360) % 360;
    return brng;
}

function getCompassDirection(bearing) {
    const directions = ['צפון', 'צפון-מזרח', 'מזרח', 'דרום-מזרח', 'דרום', 'דרום-מערב', 'מערב', 'צפון-מערב'];
    const index = Math.round(bearing / 45) % 8;
    return directions[index];
}

function getCurrentTimeContext(referenceDate = new Date()) {
    return {
        now: referenceDate,
        dayIndex: referenceDate.getDay(),
        hourIndex: referenceDate.getHours()
    };
}

function formatHourLabel(hour) {
    const normalized = Number.isInteger(hour) ? Math.min(Math.max(hour, 0), HOURS_PER_DAY - 1) : 0;
    return `${normalized.toString().padStart(2, '0')}:00`;
}

function formatDurationWithUnits(seconds) {
    if (!Number.isFinite(Number(seconds)) || seconds <= 0) {
        return 'אין נתונים';
    }

    return `${formatDuration(seconds)} דקות`;
}

function getCurrentHourStats(hourlyData, hourIndex) {
    if (!Array.isArray(hourlyData) || !Number.isInteger(hourIndex)) {
        return { hasData: false, seconds: null, label: 'אין נתונים לשעה זו עדיין' };
    }

    const value = hourlyData[hourIndex];
    if (Number.isFinite(value) && value > 0) {
        return { hasData: true, seconds: value, label: formatDurationWithUnits(value) };
    }

    return { hasData: false, seconds: null, label: 'אין נתונים לשעה זו עדיין' };
}

async function saveWaitTime(id, name, coords, waitSeconds) {
    if (!firestoreDb) {
        throw new Error('Firebase אינו מוכן.');
    }

    const normalizedCoords = sanitizeCoords(coords) || sanitizeCoords(targetCoords);
    const now = new Date();
    let updatedDataForCache = null;

    pulseLiveStatus('send', 'שומר נתונים לענן...');
    await runTransaction(firestoreDb, async (transaction) => {
        const locationRef = doc(firestoreDb, FIRESTORE_LOCATIONS_COLLECTION, id);
        const snapshot = await transaction.get(locationRef);

        const existingData = snapshot.exists()
            ? normalizeLocationRecord(id, snapshot.data(), { maxVisitHistory: MAX_VISIT_HISTORY })
            : { id, name, coords: normalizedCoords, totalCheckIns: 0, totalWaitSeconds: 0, avgWaitSeconds: 0, visits: [] };

        const { data } = prepareCheckInUpdate(existingData, { waitSeconds, now, name, coords: normalizedCoords });

        updatedDataForCache = { ...existingData, ...data };

        transaction.set(locationRef, {
            ...data,
            lastUpdatedAt: serverTimestamp()
        }, { merge: true });
    });
    pulseLiveStatus('receive', 'הסנכרון הושלם!');

    if (updatedDataForCache) {
        upsertLocationInCache(id, updatedDataForCache);
    }
}

async function persistLocationIntel(id, intelRecord, options = {}) {
    if (!firestoreDb || !id || !intelRecord) {
        return null;
    }

    const sanitizedText = typeof intelRecord.text === 'string' ? intelRecord.text : '';
    const sanitizedHtml = typeof intelRecord.html === 'string' && intelRecord.html.trim().length > 0
        ? intelRecord.html
        : formatIntelTextToHtml(sanitizedText);
    const sanitizedSources = Array.isArray(intelRecord.sources)
        ? intelRecord.sources
            .map((source) => ({
                title: typeof source?.title === 'string' ? source.title.trim() : '',
                uri: typeof source?.uri === 'string' ? source.uri.trim() : ''
            }))
            .filter((source) => source.title && source.uri)
        : [];
    const sanitizedCoords = sanitizeCoords(options.coords);
    const sanitizedName = typeof options.name === 'string' && options.name.trim().length > 0
        ? options.name.trim()
        : null;
    const locale = typeof intelRecord.locale === 'string' && intelRecord.locale.trim().length > 0
        ? intelRecord.locale
        : 'he-IL';

    const timestampSentinel = serverTimestamp();
    let savedIntel = null;

    await runTransaction(firestoreDb, async (transaction) => {
        const locationRef = doc(firestoreDb, FIRESTORE_LOCATIONS_COLLECTION, id);
        const snapshot = await transaction.get(locationRef);

        if (snapshot.exists()) {
            const existingData = snapshot.data();

            if (existingData.intel && hasIntelData(existingData.intel)) {
                savedIntel = {
                    text: typeof existingData.intel.text === 'string' ? existingData.intel.text : '',
                    html: typeof existingData.intel.html === 'string' ? existingData.intel.html : '',
                    sources: Array.isArray(existingData.intel.sources)
                        ? existingData.intel.sources
                            .map((source) => ({
                                title: typeof source?.title === 'string' ? source.title : '',
                                uri: typeof source?.uri === 'string' ? source.uri : ''
                            }))
                            .filter((source) => source.title && source.uri)
                        : [],
                    locale: existingData.intel.locale || locale
                };
                return;
            }

            const updatePayload = {
                intel: {
                    text: sanitizedText,
                    html: sanitizedHtml,
                    sources: sanitizedSources,
                    locale,
                    createdAt: timestampSentinel,
                    updatedAt: timestampSentinel
                }
            };

            if (!existingData.name && sanitizedName) {
                updatePayload.name = sanitizedName;
            }

            if (!existingData.coords && sanitizedCoords) {
                updatePayload.coords = sanitizedCoords;
            }

            transaction.set(locationRef, updatePayload, { merge: true });
            savedIntel = {
                text: sanitizedText,
                html: sanitizedHtml,
                sources: sanitizedSources,
                locale
            };
        } else {
            const newDocument = {
                name: sanitizedName || `מיקום ${id}`,
                coords: sanitizedCoords || null,
                totalCheckIns: 0,
                totalWaitSeconds: 0,
                avgWaitSeconds: 0,
                visits: [],
                intel: {
                    text: sanitizedText,
                    html: sanitizedHtml,
                    sources: sanitizedSources,
                    locale,
                    createdAt: timestampSentinel,
                    updatedAt: timestampSentinel
                },
                lastUpdatedAt: timestampSentinel
            };

            transaction.set(locationRef, newDocument, { merge: true });
            savedIntel = {
                text: sanitizedText,
                html: sanitizedHtml,
                sources: sanitizedSources,
                locale
            };
        }
    });

    return savedIntel;
}

async function updateLocationName(id, newName) {
    if (!firestoreDb) {
        throw new Error('Firebase אינו מוכן.');
    }

    const trimmedName = typeof newName === 'string' ? newName.trim() : '';
    if (!trimmedName) {
        throw new Error('שם המיקום חייב להכיל לפחות תו אחד.');
    }

    const nowIso = new Date().toISOString();

    await runTransaction(firestoreDb, async (transaction) => {
        const locationRef = doc(firestoreDb, FIRESTORE_LOCATIONS_COLLECTION, id);
        const snapshot = await transaction.get(locationRef);

        if (snapshot.exists()) {
            transaction.update(locationRef, {
                name: trimmedName,
                lastUpdatedAt: serverTimestamp()
            });
        } else {
            transaction.set(locationRef, {
                name: trimmedName,
                lastUpdatedAt: serverTimestamp()
            }, { merge: true });
        }
    });

    const cached = getLocationFromCache(id);
    if (cached) {
        upsertLocationInCache(id, { ...cached, name: trimmedName, lastUpdatedAt: nowIso });
    } else {
        upsertLocationInCache(id, {
            id,
            name: trimmedName,
            coords: null,
            totalCheckIns: 0,
            totalWaitSeconds: 0,
            avgWaitSeconds: 0,
            visits: [],
            lastUpdatedAt: nowIso,
            intel: null
        });
    }
}

function computeLocationStats(visits) {
    const safeVisits = Array.isArray(visits) ? visits : [];
    const totals = Array.from({ length: DAY_NAMES_HE.length }, () => Array.from({ length: HOURS_PER_DAY }, () => 0));
    const counts = Array.from({ length: DAY_NAMES_HE.length }, () => Array.from({ length: HOURS_PER_DAY }, () => 0));

    for (const visit of safeVisits) {
        if (!visit || typeof visit !== 'object') continue;

        const dayIndex = Number.isInteger(visit.dayOfWeek) ? visit.dayOfWeek : null;
        const hourIndex = Number.isInteger(visit.hourOfDay) ? visit.hourOfDay : null;
        const waitSeconds = Number(visit.waitSeconds);

        if (dayIndex === null || hourIndex === null) continue;
        if (dayIndex < 0 || dayIndex >= DAY_NAMES_HE.length) continue;
        if (hourIndex < 0 || hourIndex >= HOURS_PER_DAY) continue;
        if (!Number.isFinite(waitSeconds) || waitSeconds <= 0) continue;

        totals[dayIndex][hourIndex] += waitSeconds;
        counts[dayIndex][hourIndex] += 1;
    }

    const hourlyAverages = totals.map((dayTotals, dayIdx) =>
        dayTotals.map((total, hourIdx) => {
            const count = counts[dayIdx][hourIdx];
            return count > 0 ? total / count : null;
        })
    );

    const weeklyAverages = totals.map((dayTotals, dayIdx) => {
        let total = 0;
        let count = 0;
        for (let hourIdx = 0; hourIdx < HOURS_PER_DAY; hourIdx += 1) {
            total += dayTotals[hourIdx];
            count += counts[dayIdx][hourIdx];
        }
        return count > 0 ? total / count : null;
    });

    return { hourlyAverages, weeklyAverages, counts };
}

function computeDailyAverageWaitSeconds(hourlyValues) {
    if (!Array.isArray(hourlyValues) || hourlyValues.length === 0) {
        return null;
    }

    let total = 0;
    let count = 0;

    for (const value of hourlyValues) {
        if (Number.isFinite(value) && value > 0) {
            total += value;
            count += 1;
        }
    }

    return count > 0 ? total / count : null;
}

function renderHourlyChart(hourlyData, highlightHour, options = {}) {
    if (!Array.isArray(hourlyData) || hourlyData.length === 0) {
        return options.variant === 'map'
            ? `<p style="margin-top:0.5rem; font-size:0.75rem; color:#6b7280;">${options.emptyMessage || 'אין עדיין נתונים עבור שעות היום.'}</p>`
            : `<p class="text-xs text-gray-500 mt-2">${options.emptyMessage || 'אין עדיין נתונים עבור שעות היום.'}</p>`;
    }

    const hasData = hourlyData.some((value) => Number.isFinite(value) && value > 0);
    const variant = options.variant || 'app';
    const emptyMessage = options.emptyMessage || 'אין עדיין נתונים עבור שעות היום.';

    if (!hasData) {
        return variant === 'map'
            ? `<p style="margin-top:0.5rem; font-size:0.75rem; color:#6b7280;">${emptyMessage}</p>`
            : `<p class="text-xs text-gray-500 mt-2">${emptyMessage}</p>`;
    }

    const baseHeight = options.height ?? (variant === 'map' ? 60 : 96);
    const gap = options.gap ?? (variant === 'map' ? 4 : 4);
    const effectiveMax = hourlyData.reduce((max, value) => (Number.isFinite(value) && value > max ? value : max), 0) || 1;

    const barsHtml = hourlyData
        .map((value, hourIdx) => {
            const safeValue = Number.isFinite(value) && value > 0 ? value : 0;
            const heightPx = Math.round((safeValue / effectiveMax) * baseHeight);
            const barHeight = safeValue > 0 ? Math.max(heightPx, 6) : 4;
            const isHighlight = hourIdx === highlightHour;
            const tooltipValue = safeValue > 0 ? formatDurationWithUnits(safeValue) : 'אין נתונים';

            if (variant === 'map') {
                const barColor = isHighlight ? '#2563eb' : '#93c5fd';
                const opacity = safeValue > 0 ? 1 : 0.4;
                return `<div style="flex:1; display:flex; align-items:flex-end;" title="${formatHourLabel(hourIdx)} · ${tooltipValue}"><div style="width:100%; height:${barHeight}px; background:${barColor}; border-radius:6px 6px 0 0; opacity:${opacity};"></div></div>`;
            }

            const barClass = isHighlight ? 'bg-blue-600' : 'bg-blue-300';
            const opacity = safeValue > 0 ? 1 : 0.35;
            return `<div class="flex-1 flex items-end" title="${formatHourLabel(hourIdx)} · ${tooltipValue}"><div class="${barClass} w-full rounded-t-md" style="height:${barHeight}px; opacity:${opacity};"></div></div>`;
        })
        .join('');

    if (variant === 'map') {
        const labels = options.hideLabels
            ? ''
            : `<div style="display:flex; justify-content:space-between; font-size:0.65rem; color:#4b5563; margin-top:0.25rem;"><span>00</span><span>12</span><span>23</span></div>`;
        return `<div style="display:flex; align-items:flex-end; gap:${gap}px; height:${baseHeight}px; margin-top:0.5rem;">${barsHtml}</div>${labels}`;
    }

    const labels = options.hideLabels
        ? ''
        : `<div class="flex justify-between text-[0.65rem] text-gray-500 mt-1"><span>00</span><span>12</span><span>23</span></div>`;
    return `<div class="flex items-end gap-1 w-full mt-2" style="height:${baseHeight}px;">${barsHtml}</div>${labels}`;
}

function renderWeeklySummary(weeklyData, highlightDay, options = {}) {
    if (!Array.isArray(weeklyData) || weeklyData.length === 0) {
        return options.variant === 'map'
            ? `<p style="margin-top:0.5rem; font-size:0.75rem; color:#6b7280;">${options.emptyMessage || 'אין עדיין נתונים שבועיים.'}</p>`
            : `<p class="text-xs text-gray-500 mt-2">${options.emptyMessage || 'אין עדיין נתונים שבועיים.'}</p>`;
    }

    const variant = options.variant || 'app';
    const emptyMessage = options.emptyMessage || 'אין עדיין נתונים שבועיים.';
    const hasData = weeklyData.some((value) => Number.isFinite(value) && value > 0);

    if (!hasData) {
        return variant === 'map'
            ? `<p style="margin-top:0.5rem; font-size:0.75rem; color:#6b7280;">${emptyMessage}</p>`
            : `<p class="text-xs text-gray-500 mt-2">${emptyMessage}</p>`;
    }

    if (options.compact) {
        const itemsHtml = weeklyData
            .map((value, dayIdx) => {
                const highlight = dayIdx === highlightDay;
                const hasDayData = Number.isFinite(value) && value > 0;
                const minutes = hasDayData ? Math.round(value / 60) : null;
                const display = minutes !== null ? (minutes > 0 ? `${minutes}׳` : '<1׳') : '—';

                if (variant === 'map') {
                    const background = highlight ? '#2563eb' : '#e5e7eb';
                    const color = highlight ? '#ffffff' : '#1f2937';
                    const opacity = hasDayData ? 1 : 0.6;
                    return `<div style="flex:1; text-align:center; border-radius:0.6rem; padding:0.35rem 0.25rem; font-size:0.7rem; background:${background}; color:${color}; opacity:${opacity};">
                                <div style="font-weight:600;">${SHORT_DAY_NAMES_HE[dayIdx]}</div>
                                <div>${display}</div>
                            </div>`;
                }

                const baseClass = highlight ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700';
                const opacityClass = hasDayData ? '' : 'opacity-60';
                return `<div class="flex flex-col items-center justify-center rounded-lg px-2 py-2 text-xs sm:text-sm font-medium ${baseClass} ${opacityClass}">
                            <div>${SHORT_DAY_NAMES_HE[dayIdx]}</div>
                            <div class="mt-1">${display}</div>
                        </div>`;
            })
            .join('');

        if (variant === 'map') {
            return `<div style="display:flex; gap:4px; margin-top:0.5rem;">${itemsHtml}</div>`;
        }

        return `<div class="grid grid-cols-4 sm:grid-cols-7 gap-2 mt-2">${itemsHtml}</div>`;
    }

    const itemsHtml = weeklyData
        .map((value, dayIdx) => {
            const highlight = dayIdx === highlightDay;
            const hasDayData = Number.isFinite(value) && value > 0;
            const label = DAY_NAMES_HE[dayIdx];
            const valueLabel = hasDayData ? formatDurationWithUnits(value) : 'אין נתונים';

            if (variant === 'map') {
                const background = highlight ? '#dbeafe' : '#f3f4f6';
                const color = highlight ? '#1d4ed8' : '#1f2937';
                const opacity = hasDayData ? 1 : 0.65;
                return `<div style="display:flex; justify-content:space-between; align-items:center; border-radius:0.75rem; padding:0.35rem 0.5rem; margin-top:0.25rem; background:${background}; color:${color}; font-size:0.75rem; opacity:${opacity};">
                            <span style="font-weight:600;">${label}</span>
                            <span>${valueLabel}</span>
                        </div>`;
            }

            const baseClass = highlight ? 'bg-blue-50 text-blue-800' : 'bg-gray-100 text-gray-700';
            const opacityClass = hasDayData ? '' : 'opacity-60';
            return `<div class="flex items-center justify-between rounded-lg px-3 py-2 text-xs sm:text-sm ${baseClass} ${opacityClass}">
                        <span class="font-semibold">${label}</span>
                        <span>${valueLabel}</span>
                    </div>`;
        })
        .join('');

    if (variant === 'map') {
        return `<div style="margin-top:0.5rem;">${itemsHtml}</div>`;
    }

    return `<div class="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">${itemsHtml}</div>`;
}

function animateLiveCard(element) {
    if (!element) return;

    element.classList.remove('live-card-animate');
    void element.offsetWidth;
    element.classList.add('live-card-animate');
    element.addEventListener('animationend', () => {
        element.classList.remove('live-card-animate');
    }, { once: true });
}

function pulseLiveStatus(mode, message, options = {}) {
    if (!liveStatusPill || !liveStatusText) return;

    const { duration = 2200 } = options;
    liveStatusPill.classList.remove('live-mode-send', 'live-mode-receive');
    if (mode === 'send') {
        liveStatusPill.classList.add('live-mode-send');
    } else {
        liveStatusPill.classList.add('live-mode-receive');
    }

    liveStatusText.textContent = message;

    liveStatusPill.classList.remove('active');
    void liveStatusPill.offsetWidth;
    liveStatusPill.classList.add('active');

    if (liveStatusTimeoutId) {
        clearTimeout(liveStatusTimeoutId);
    }

    liveStatusTimeoutId = window.setTimeout(() => {
        if (liveStatusPill) {
            liveStatusPill.classList.remove('active');
        }
        liveStatusTimeoutId = null;
    }, duration);
}

function setWaitingSyncIndicatorActive(isActive) {
    if (!waitingSyncIndicator) return;

    if (waitingSyncHideTimeoutId) {
        clearTimeout(waitingSyncHideTimeoutId);
        waitingSyncHideTimeoutId = null;
    }

    if (isActive) {
        waitingSyncIndicator.classList.remove('hidden');
        waitingSyncIndicator.classList.add('active');
    } else {
        waitingSyncIndicator.classList.remove('active');
        waitingSyncHideTimeoutId = window.setTimeout(() => {
            if (waitingSyncIndicator) {
                waitingSyncIndicator.classList.add('hidden');
            }
            waitingSyncHideTimeoutId = null;
        }, 300);
    }
}

// --- 8. Render All Locations Tab ---
function renderAllLocations() {
    if (!allLocationsList) return;

    if (!locationsLoaded) {
        allLocationsList.innerHTML = `<p class="text-gray-500 text-center">טוען נתונים מהענן...</p>`;
        return;
    }

    if (firebaseInitializationError) {
        const errorText = firebaseInitializationError?.message || 'אנא בדוק את החיבור והגדרות Firebase.';
        allLocationsList.innerHTML = `<p class="text-red-500 text-center">שגיאה בטעינת נתוני Firebase: ${errorText}</p>`;
        return;
    }

    const locations = Array.from(locationCache.entries());

    if (locations.length === 0) {
        allLocationsList.innerHTML = `<p class="text-gray-500 text-center">עדיין לא שמרתם מקומות...</p>`;
        return;
    }

    allLocationsList.innerHTML = '';

    locations.sort(([, a], [, b]) => (b.totalCheckIns || 0) - (a.totalCheckIns || 0));

    for (const [id, data] of locations) {
        const avgTimeDisplay = data.totalCheckIns > 0
            ? formatDurationWithUnits(data.avgWaitSeconds)
            : "אין עדיין מידע";

        const stats = computeLocationStats(data.visits);
        const { dayIndex, hourIndex } = getCurrentTimeContext();
        const todaysHourly = stats.hourlyAverages?.[dayIndex] || [];
        const currentHourStats = getCurrentHourStats(todaysHourly, hourIndex);
        const currentDayLabel = DAY_NAMES_HE[dayIndex];
        const hasIntel = hasIntelData(data.intel);

        const hourlyChartHtml = renderHourlyChart(todaysHourly, hourIndex, {
            variant: 'app',
            emptyMessage: 'אין עדיין נתונים לשעות היום עבור מיקום זה.'
        });

        const weeklySummaryHtml = renderWeeklySummary(stats.weeklyAverages, dayIndex, {
            variant: 'app',
            emptyMessage: 'אין עדיין נתונים שבועיים עבור מיקום זה.'
        });

        const el = document.createElement('div');
        el.className = "bg-white p-4 rounded-lg shadow-md border transition cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500";
        el.setAttribute('tabindex', '0');
        el.setAttribute('role', 'button');
        el.innerHTML = `
            <div class="flex flex-col gap-3">
                <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                    <div class="space-y-2">
                        <h3 class="font-semibold text-lg text-gray-800">${data.name}</h3>
                        <p class="text-sm text-gray-600">זמן המתנה ממוצע: <span class="font-medium text-blue-600">${avgTimeDisplay}</span></p>
                        <p class="text-sm text-gray-600">סה"כ צ'ק-אינים: <span class="font-medium text-blue-600">${data.totalCheckIns}</span></p>
                    </div>
                    <div class="flex items-center gap-2 self-start">
                        <button class="intel-details-btn text-sm font-semibold rounded-md px-3 py-2 transition ${hasIntel ? 'bg-purple-600 text-white hover:bg-purple-700' : 'bg-gray-100 text-gray-400 cursor-not-allowed'}" ${hasIntel ? '' : 'disabled'}>
                            סקירת יעד
                        </button>
                        <button class="toggle-details-btn text-sm bg-gray-100 text-gray-700 font-semibold py-2 px-3 rounded-md hover:bg-gray-200 transition" aria-expanded="false">
                            הצג פרטים
                        </button>
                        <button type="button" class="rename-location-btn text-sm bg-amber-100 text-amber-700 font-semibold py-2 px-3 rounded-md hover:bg-amber-200 transition">
                            שינוי שם
                        </button>
                        <button class="goto-location-btn text-sm bg-blue-100 text-blue-700 font-semibold py-2 px-3 rounded-md hover:bg-blue-200 transition">
                            עבור למיקום
                        </button>
                    </div>
                </div>
                <div class="location-details hidden space-y-3">
                    <p class="text-xs text-gray-500">שעה נוכחית (${currentDayLabel} · ${formatHourLabel(hourIndex)}): <span class="font-semibold text-blue-600">${currentHourStats.label}</span></p>
                    <div class="bg-blue-50 border border-blue-100 rounded-lg p-3">
                        <div class="flex items-center justify-between text-xs sm:text-sm text-blue-900 font-semibold">
                            <span>היום לפי שעות</span>
                            <span>${currentHourStats.hasData ? currentHourStats.label : 'אין נתונים לשעה זו'}</span>
                        </div>
                        ${hourlyChartHtml}
                    </div>
                    <div>
                        <h4 class="text-sm font-semibold text-gray-700">מבט שבועי</h4>
                        ${weeklySummaryHtml}
                    </div>
                </div>
            </div>
        `;

        const openLocation = () => {
            const coords = data.coords || {};
            const lat = coords.lat ?? coords.latitude;
            const lon = coords.lon ?? coords.lng ?? coords.longitude;
            if (lat == null || lon == null) return;
            selectLocation(lat, lon, data.name, id);
        };

        el.addEventListener('click', (event) => {
            if (event.target.closest('button')) {
                return;
            }
            openLocation();
        });

        el.addEventListener('keydown', (event) => {
            if (event.target.closest('button')) {
                return;
            }
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openLocation();
            }
        });

        const gotoBtn = el.querySelector('.goto-location-btn');
        if (gotoBtn) {
            gotoBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                openLocation();
            });
        }

        const intelBtn = el.querySelector('.intel-details-btn');
        if (intelBtn && hasIntel) {
            intelBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                openIntelModal({ ...data, id });
            });
        }

        const renameBtn = el.querySelector('.rename-location-btn');
        if (renameBtn) {
            renameBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                openRenameLocationModal(id);
            });
        }

        const detailsEl = el.querySelector('.location-details');
        const toggleBtn = el.querySelector('.toggle-details-btn');
        if (detailsEl && toggleBtn) {
            const setExpanded = (expanded) => {
                if (expanded) {
                    detailsEl.classList.remove('hidden');
                    toggleBtn.textContent = 'הסתר פרטים';
                    toggleBtn.setAttribute('aria-expanded', 'true');
                } else {
                    detailsEl.classList.add('hidden');
                    toggleBtn.textContent = 'הצג פרטים';
                    toggleBtn.setAttribute('aria-expanded', 'false');
                }
            };

            setExpanded(false);

            toggleBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                const expanded = toggleBtn.getAttribute('aria-expanded') === 'true';
                setExpanded(!expanded);
            });
        }

        allLocationsList.appendChild(el);
        animateLiveCard(el);
    }
}

function setWaitingScreenSavingState(isSaving) {
    isSavingCheckIn = isSaving;

    if (manualFinishBtn) {
        manualFinishBtn.disabled = isSaving;
        if (isSaving) {
            manualFinishBtn.innerHTML = '<span class="inline-flex items-center justify-center gap-2 w-full"><span class="send-spinner"></span><span>שומר נתונים...</span></span>';
        } else {
            manualFinishBtn.textContent = 'סיום ידני ושמירה';
        }
    }

    if (cancelCheckInBtn) {
        cancelCheckInBtn.disabled = isSaving;
    }

    if (confirmArrivalBtn) {
        confirmArrivalBtn.disabled = isSaving;
    }

    if (denyArrivalBtn) {
        denyArrivalBtn.disabled = isSaving;
    }

    setWaitingSyncIndicatorActive(isSaving);
    updateState();
}

function createLeafletPoint(x, y) {
    if (typeof L !== 'undefined' && L?.point) {
        return L.point(x, y);
    }
    return [x, y];
}

function getSafeAreaInset(side) {
    if (typeof window === 'undefined' || !document?.documentElement) {
        return 0;
    }

    try {
        const computed = window.getComputedStyle(document.documentElement);
        const variableName = side === 'top' ? '--safe-area-top' : '--safe-area-bottom';
        const value = computed.getPropertyValue(variableName);
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : 0;
    } catch (error) {
        return 0;
    }
}

function getElementHeightIfVisible(element) {
    if (!element || typeof element.getBoundingClientRect !== 'function') {
        return 0;
    }

    if (element.getAttribute && element.getAttribute('aria-hidden') === 'true') {
        return 0;
    }

    const rect = element.getBoundingClientRect();
    if (!rect || rect.height <= 0 || rect.width <= 0) {
        return 0;
    }

    return rect.height;
}

function renderVisitedLocationsOnMap() {
    if (!map) return;

    if (!visitedLocationsLayer) {
        visitedLocationsLayer = L.layerGroup().addTo(map);
    }

    visitedLocationsLayer.clearLayers();

    if (!locationsLoaded) {
        return;
    }

    for (const [id, data] of locationCache.entries()) {
        if (!data || !data.coords || !data.totalCheckIns) continue;

        const rawLat = data.coords.lat ?? data.coords.latitude;
        const rawLon = data.coords.lon ?? data.coords.lng ?? data.coords.longitude;

        const lat = typeof rawLat === 'number' ? rawLat : parseFloat(rawLat);
        const lon = typeof rawLon === 'number' ? rawLon : parseFloat(rawLon);

        if (Number.isNaN(lat) || Number.isNaN(lon)) continue;

        const marker = L.marker([lat, lon]).addTo(visitedLocationsLayer);
        L.circle([lat, lon], { ...RADIUS_STYLES.visited }).addTo(visitedLocationsLayer);

        const locationName = data.name || `מיקום (${lat.toFixed(4)}, ${lon.toFixed(4)})`;

        const locationDetails = {
            id,
            name: locationName,
            totalCheckIns: data.totalCheckIns,
            avgWaitSeconds: data.avgWaitSeconds,
            lastVisitAt: data?.visits?.[0]?.timestamp ?? data?.lastUpdatedAt ?? null
        };

        marker.bindTooltip(locationName, {
            permanent: true,
            direction: 'top',
            offset: [0, -4],
            opacity: 1,
            className: 'map-location-label'
        });

        marker.on('click', () => {
            if (locationNameInput) {
                locationNameInput.value = locationName;
            }
            selectLocation(lat, lon, locationName, id);
        });
    }

    updateState();
}

function formatDuration(seconds) {
    const numericSeconds = Number(seconds);
    if (!Number.isFinite(numericSeconds) || numericSeconds < 0) return '00:00';

    const totalSeconds = Math.round(numericSeconds);
    const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
    const secs = Math.abs(totalSeconds % 60).toString().padStart(2, '0');
    return `${minutes}:${secs}`;
}

function formatTimestamp(timestamp) {
    if (!timestamp) return 'לא ידוע';

    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return 'לא ידוע';

    return date.toLocaleString('he-IL', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function hasIntelData(intel) {
    if (!intel || typeof intel !== 'object') {
        return false;
    }

    const html = typeof intel.html === 'string' ? intel.html.trim() : '';
    const text = typeof intel.text === 'string' ? intel.text.trim() : '';
    return html.length > 0 || text.length > 0;
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatIntelTextToHtml(text) {
    if (typeof text !== 'string') {
        return '';
    }

    const lines = text.split(/\r?\n/).map((line) => line.trim());
    const chunks = [];
    let listBuffer = [];

    const flushList = () => {
        if (listBuffer.length > 0) {
            chunks.push(`<ul>${listBuffer.join('')}</ul>`);
            listBuffer = [];
        }
    };

    for (const line of lines) {
        if (!line) {
            flushList();
            continue;
        }

        const bulletMatch = line.match(/^([\-*•])\s*(.+)$/);
        if (bulletMatch) {
            const [, , content] = bulletMatch;
            listBuffer.push(`<li>${escapeHtml(content)}</li>`);
            continue;
        }

        flushList();

        const numberedMatch = line.match(/^(\d+)[\.)]\s*(.+)$/);
        if (numberedMatch) {
            const [, index, content] = numberedMatch;
            chunks.push(`<p><strong>${escapeHtml(index)}.</strong> ${escapeHtml(content)}</p>`);
            continue;
        }

        const colonIndex = line.indexOf(':');
        if (colonIndex > 0 && colonIndex < line.length - 1) {
            const title = escapeHtml(line.slice(0, colonIndex));
            const body = escapeHtml(line.slice(colonIndex + 1).trim());
            chunks.push(`<p><strong>${title}:</strong> ${body}</p>`);
        } else {
            chunks.push(`<p>${escapeHtml(line)}</p>`);
        }
    }

    flushList();

    return chunks.join('');
}

function getIntelHtml(intel) {
    if (!intel || typeof intel !== 'object') {
        return '';
    }

    if (typeof intel.html === 'string' && intel.html.trim().length > 0) {
        return intel.html.trim();
    }

    if (typeof intel.text === 'string' && intel.text.trim().length > 0) {
        return formatIntelTextToHtml(intel.text);
    }

    return '';
}

function getIntelTextContent(intel) {
    if (!intel || typeof intel !== 'object') {
        return '';
    }

    if (typeof intel.text === 'string' && intel.text.trim().length > 0) {
        return intel.text.trim();
    }

    if (typeof intel.html === 'string' && intel.html.trim().length > 0) {
        return intel.html
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<li[^>]*>/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    return '';
}

function getIntelSummaryText(intel, options = {}) {
    const limit = Math.max(1, options.sentences ?? 2);
    const maxChars = Math.max(60, options.maxLength ?? 320);
    const textContent = getIntelTextContent(intel);

    if (!textContent) {
        return '';
    }

    const normalized = textContent.replace(/\s+/g, ' ').trim();
    if (!normalized) {
        return '';
    }

    const sentences = normalized.split(/(?<=[.!?\u05be\u2022])\s+/).filter(Boolean);
    let summary = sentences.slice(0, limit).join(' ');

    if (!summary) {
        summary = normalized;
    }

    if (summary.length > maxChars) {
        return `${summary.slice(0, maxChars).trim()}…`;
    }

    return summary;
}

function renderIntelPreviewHtml(intel, options = {}) {
    const summary = getIntelSummaryText(intel, options);
    if (!summary) {
        const emptyMessage = options.emptyMessage || '';
        if (!emptyMessage) {
            return '';
        }
        const textClass = options.textClass || 'text-sm text-gray-500';
        return `<p class="${textClass}">${emptyMessage}</p>`;
    }

    const summaryClass = options.summaryClass || options.textClass || 'text-sm text-blue-900/90 leading-relaxed';
    return `<p class="${summaryClass}">${escapeHtml(summary)}</p>`;
}

function renderIntelIntoContainer(container, intel, options = {}) {
    if (!container) {
        return;
    }

    const html = getIntelHtml(intel);
    if (html) {
        container.innerHTML = html;
        container.classList.remove('hidden');
        return;
    }

    container.innerHTML = options.emptyMessage
        ? `<p class="${options.emptyClass || 'text-sm text-blue-100/80'}">${escapeHtml(options.emptyMessage)}</p>`
        : '';

    if (options.hideWhenEmpty) {
        container.classList.add('hidden');
    }
}

function renderIntelSources(container, sources, options = {}) {
    if (!container) {
        return;
    }

    const safeSources = Array.isArray(sources)
        ? sources
            .map((source) => ({
                title: typeof source?.title === 'string' ? source.title.trim() : '',
                uri: typeof source?.uri === 'string' ? source.uri.trim() : ''
            }))
            .filter((source) => source.title && source.uri)
        : [];

    if (safeSources.length === 0) {
        container.innerHTML = '';
        container.classList.add('hidden');
        return;
    }

    const linkClass = options.linkClass || 'text-blue-300 hover:text-blue-100 underline-offset-2 hover:underline';
    const title = options.title || 'מקורות:';
    const links = safeSources
        .map((source) => `<a href="${source.uri}" target="_blank" rel="noopener" class="${linkClass}">${escapeHtml(source.title)}</a>`)
        .join('<span class="text-blue-200/40">•</span>');

    container.innerHTML = `<div class="flex flex-wrap items-center gap-2"><span class="font-semibold">${escapeHtml(title)}</span>${links}</div>`;
    container.classList.remove('hidden');
}

function setRenameModalLoading(isLoading) {
    if (renameLocationSaveBtn) {
        renameLocationSaveBtn.disabled = isLoading;
        if (isLoading) {
            renameLocationSaveBtn.innerHTML = `<span class="flex items-center justify-center gap-2"><span class="spinner w-4 h-4 border-2 rounded-full"></span><span>שומר...</span></span>`;
        } else {
            renameLocationSaveBtn.innerHTML = 'שמור שם חדש';
        }
    }

    if (renameLocationCancelBtn) {
        renameLocationCancelBtn.disabled = isLoading;
        renameLocationCancelBtn.classList.toggle('opacity-60', isLoading);
    }
}

function openRenameLocationModal(locationId) {
    if (!renameLocationModal || !renameLocationInput) {
        return;
    }

    const cached = getLocationFromCache(locationId);

    renameLocationPendingId = locationId;
    setRenameModalLoading(false);

    renameLocationModal.classList.remove('hidden');
    renameLocationModal.setAttribute('aria-hidden', 'false');

    const currentName = cached?.name || '';
    renameLocationInput.value = currentName;
    if (renameLocationError) {
        renameLocationError.textContent = '';
    }

    window.setTimeout(() => {
        if (renameLocationInput) {
            renameLocationInput.focus({ preventScroll: true });
            renameLocationInput.setSelectionRange(0, renameLocationInput.value.length);
        }
    }, 0);

    updateState();
}

function closeRenameLocationModal() {
    if (!renameLocationModal) {
        return;
    }

    renameLocationPendingId = null;
    isRenamingLocation = false;
    setRenameModalLoading(false);

    if (renameLocationForm) {
        renameLocationForm.reset();
    }

    if (renameLocationError) {
        renameLocationError.textContent = '';
    }

    renameLocationModal.classList.add('hidden');
    renameLocationModal.setAttribute('aria-hidden', 'true');

    updateState();
}

async function handleRenameLocationSubmit(event) {
    event.preventDefault();

    if (isRenamingLocation) {
        return;
    }

    if (!renameLocationInput) {
        return;
    }

    const newName = renameLocationInput.value.trim();
    if (!newName) {
        if (renameLocationError) {
            renameLocationError.textContent = 'אנא הזינו שם תקין למיקום.';
        }
        return;
    }

    if (!renameLocationPendingId) {
        if (renameLocationError) {
            renameLocationError.textContent = 'אירעה שגיאה בזיהוי המיקום לעריכה.';
        }
        return;
    }

    isRenamingLocation = true;
    setRenameModalLoading(true);
    if (renameLocationError) {
        renameLocationError.textContent = '';
    }

    try {
        pulseLiveStatus('send', 'מעדכן שם המיקום...');
        await updateLocationName(renameLocationPendingId, newName);
        pulseLiveStatus('receive', 'שם המיקום עודכן');

        if (currentLocationId === renameLocationPendingId) {
            targetName = newName;
            if (locationNameInput) {
                locationNameInput.value = newName;
            }
            if (waitingLocationName) {
                waitingLocationName.textContent = newName;
            }
            if (targetDetailsCard && targetDetailsCard.getAttribute('aria-hidden') === 'false') {
                showLocationCard(newName, currentLocationId);
            }
        }

        closeRenameLocationModal();
    } catch (error) {
        console.error('Failed to rename location', error);
        if (renameLocationError) {
            renameLocationError.textContent = error?.message || 'אירעה שגיאה בעת שמירת השם החדש.';
        }
    } finally {
        isRenamingLocation = false;
        setRenameModalLoading(false);
    }

    updateState();
}

function openIntelModal(location = {}) {
    if (!intelModal || !intelModalBody || !intelModalTitle) {
        return;
    }

    intelModalTitle.textContent = location.name || 'סקירת יעד';
    renderIntelIntoContainer(intelModalBody, location.intel, {
        emptyMessage: 'עדיין אין סקירה שמורה למיקום זה.',
        emptyClass: 'text-sm text-blue-100/70'
    });
    renderIntelSources(intelModalSources, location.intel?.sources, {
        linkClass: 'text-blue-200 hover:text-white underline-offset-4 hover:underline'
    });

    intelModal.classList.remove('hidden');
    document.body.classList.add('overflow-hidden');
}

function closeIntelModal() {
    if (!intelModal) {
        return;
    }

    intelModal.classList.add('hidden');
    document.body.classList.remove('overflow-hidden');
}

// --- 9. Gemini API ---
async function callGeminiApi(payload) {
    const apiKey = GEMINI_API_KEY; // API key is handled by the environment
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

    let response;
    try {
        response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorBody = await response.json();
            console.error("API Error Response:", errorBody);
            throw new Error(`API request failed with status ${response.status}: ${errorBody.error?.message || 'Unknown error'}`);
        }

        return await response.json();

    } catch (error) {
        console.error('Error calling Gemini API:', error);
        throw error;
    }
}

async function handleGetInfo() {
    if (!targetCoords) return;

    infoLoading.classList.remove('hidden');
    infoResult.innerHTML = "";
    infoSources.innerHTML = "";
    infoSources.classList.add('hidden');
    infoErrorEl.textContent = "";

    const cachedLocation = getLocationFromCache(currentLocationId);
    if (hasIntelData(cachedLocation?.intel)) {
        renderIntelIntoContainer(infoResult, cachedLocation.intel);
        renderIntelSources(infoSources, cachedLocation.intel.sources);
        infoLoading.classList.add('hidden');
        return;
    }

    // --- API Key Check ---
    if (!GEMINI_API_KEY) {
        displayApiError("פיצ'ר זה דורש מפתח API של Gemini. יש להוסיף אותו בקוד.", infoErrorEl);
        infoLoading.classList.add('hidden');
        return;
    }
    // --- End Check ---

    const prettyName = targetName || cachedLocation?.name || 'המיקום';
    const userQuery = `הכן תגובה תמציתית בעברית עבור המיקום "${prettyName}" שבקואורדינטות ${targetCoords.lat}, ${targetCoords.lon}. שמור על הפורמט הבא:\nתקציר: משפט אחד עד שניים בלבד עם המידע החשוב ביותר למבקר.\nעיקרי מידע:\n- מאפיין חשוב או רקע קצר (אם ידוע).\n- טיפ ביקור פרקטי (אם רלוונטי).\n- שעות פעילות או זמינות (אם יש מידע).\nהימנע מחזרות או מילים מיותרות.`;

    const payload = {
        contents: [{ parts: [{ text: userQuery }] }],
        tools: [{ "google_search": {} }],
        systemInstruction: {
            parts: [{ text: "הנך מדריך שטח ישראלי. השב תמיד בעברית מודרנית, ברורה ומכבדת. שמור על טון אינפורמטיבי, הימנע מטקסט שיווקי, ועמוד במגבלת אורך קצרה. תמיד התחל בסעיף \"תקציר\" בן משפט אחד עד שניים, ואחריו רשימת נקודות ממוקדות (עד שלוש). אם אין מידע עבור סעיף מסוים, ציין \"לא ידוע\" במקום להשאיר ריק." }]
        },
    };

    try {
        const result = await callGeminiApi(payload);
        console.log("Gemini API Result:", result);
        const candidate = result.candidates?.[0];

        if (candidate && candidate.content?.parts?.[0]?.text) {
            const contentText = candidate.content.parts[0].text;
            const groundingMetadata = candidate.groundingMetadata;
            const sources = groundingMetadata && groundingMetadata.groundingAttributions
                ? groundingMetadata.groundingAttributions
                    .map((attr) => (attr.web?.title && attr.web?.uri ? { title: attr.web.title, uri: attr.web.uri } : null))
                    .filter(Boolean)
                : [];

            const intelRecord = {
                text: contentText,
                html: formatIntelTextToHtml(contentText),
                sources,
                locale: 'he-IL'
            };

            renderIntelIntoContainer(infoResult, intelRecord, {
                emptyMessage: 'לא התקבל תוכן מתאים מהשירות.'
            });
            renderIntelSources(infoSources, intelRecord.sources);

            if (currentLocationId) {
                const coordsForIntel = sanitizeCoords(targetCoords);
                try {
                    const storedIntel = await persistLocationIntel(currentLocationId, intelRecord, {
                        name: prettyName,
                        coords: coordsForIntel
                    }) || intelRecord;

                    const baseData = cachedLocation || {
                        id: currentLocationId,
                        name: prettyName,
                        coords: coordsForIntel,
                        totalCheckIns: 0,
                        totalWaitSeconds: 0,
                        avgWaitSeconds: 0,
                        visits: []
                    };

                    upsertLocationInCache(currentLocationId, {
                        ...baseData,
                        intel: storedIntel
                    });
                } catch (persistError) {
                    console.warn('Failed to persist Gemini intel', persistError);
                }
            }
        } else {
            displayApiError("לא התקבל תוכן תקין מה-API.", infoErrorEl);
        }
    } catch (error) {
        console.error("Failed to get info:", error);
        displayApiError(`שגיאה בטעינת מידע: ${error.message}`, infoErrorEl);
    } finally {
        infoLoading.classList.add('hidden');
    }
}

function displayApiError(message, element) {
    element.textContent = message;
}

// --- 10. Mini Map Functions ---
function initMiniMap() {
    if (!targetCoords || !miniMapEl) return;

    try {
        if (miniMap) {
            miniMap.remove();
            miniMap = null;
        }

        if (miniMapEl._leaflet_id) {
            delete miniMapEl._leaflet_id;
        }

        miniMapEl.innerHTML = '';

        miniMap = L.map(miniMapEl, {
            zoomControl: false,
            scrollWheelZoom: false,
            dragging: false,
            touchZoom: false,
            doubleClickZoom: false
        }).setView([targetCoords.lat, targetCoords.lon], 17);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(miniMap);
        miniMapTargetMarker = L.marker([targetCoords.lat, targetCoords.lon]).addTo(miniMap);

        if (lastKnownPosition) {
            const userLatLng = L.latLng(lastKnownPosition.coords.latitude, lastKnownPosition.coords.longitude);
            miniMapUserMarker = L.marker(userLatLng, { icon: userIcon }).addTo(miniMap);
            miniMap.fitBounds(L.latLngBounds(userLatLng, [targetCoords.lat, targetCoords.lon]), { padding: [20, 20], maxZoom: 17 });
        }

        scheduleMiniMapResize();

    } catch (e) {
        console.error("Error initializing mini-map:", e);
        if (miniMapEl) {
            miniMapEl.innerHTML = '<p class="text-red-500 p-2 text-center">שגיאה בטעינת המפה.</p>';
        }
    }

    updateState();
}

function scheduleMiniMapResize() {
    if (!miniMap) {
        return;
    }

    const invalidate = () => {
        if (miniMap) {
            miniMap.invalidateSize();
        }
    };

    const raf = (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function')
        ? window.requestAnimationFrame.bind(window)
        : (fn) => setTimeout(fn, 16);

    raf(() => {
        invalidate();
        setTimeout(invalidate, 120);
    });

    if (typeof miniMap.whenReady === 'function') {
        miniMap.whenReady(() => {
            invalidate();
            setTimeout(invalidate, 200);
        });
    }
}

function destroyMiniMap() {
    if (miniMap) {
        miniMap.remove();
        miniMap = null;
    }

    if (miniMapEl && miniMapEl._leaflet_id) {
        delete miniMapEl._leaflet_id;
    }

    miniMapTargetMarker = null;
    miniMapUserMarker = null;

    updateState();
}

// --- Run Initialization ---
initApp();

}
