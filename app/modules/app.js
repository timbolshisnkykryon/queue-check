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
    normalizeLiveQueueRecord,
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
        SHORT_DAY_NAMES_HE,
        NEARBY_PLACES_RADIUS_METERS
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
        gpsPoiFetchAbortController,
        isLoadingPois,
        lastPoiFetchBounds,
        lastGpsNearbyBounds,
        selectedPlaceInfo,
        isSavingCheckIn,
        selectedPartySizeKey,
        pendingPartySizeSelectionKey,
        isPartySizePromptOpen,
        activeWaitSessionId,
        activeWaitLocationId,
        activeWaitPartyKey,
        activeWaitRegisteredAt,
        liveStatusTimeoutId,
        waitingSyncHideTimeoutId,
        renameLocationPendingId,
        isRenamingLocation,
        firebaseAppInstance,
        firestoreDb,
        unsubscribeLocations,
        locationsLoaded,
        firebaseInitializationError,
        poiPlaces,
        gpsNearbyPlaces,
        nearbyPanelVisible,
        nearbyPanelCollapsed,
        nearbyPanelHasResults,
        confettiTimeoutId,
        recentVisits
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
        nearbyLocationsPanel,
        nearbyPanelToggleBtn,
        nearbyLocationsList,
        recentVisitsList,
        waitingLocationName,
        timerDisplay,
        waitingDistance,
        waitingBearing,
        gpsCountdownEl,
        waitingGroupAverageValue,
        waitingGroupAverageHint,
        waitingGroupPositionValue,
        waitingGroupPositionHint,
        partySizeSelector,
        partySizeOptionButtons,
        partySizePrompt,
        partySizePromptOptionButtons,
        partySizePromptConfirmBtn,
        partySizePromptCancelBtn,
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
        tabButtons,
        confettiRoot
    } = elements;

    if (gpsCountdownEl) {
        gpsCountdownEl.textContent = '';
        gpsCountdownEl.setAttribute('aria-hidden', 'true');
        gpsCountdownEl.style.setProperty('display', 'none', 'important');
    }

    const ALLOWED_AMENITY_VALUES = [
        'restaurant',
        'cafe',
        'bar',
        'fast_food',
        'food_court',
        'ice_cream',
        'bakery',
        'pub'
    ];
    const ALLOWED_POI_AMENITIES = new Set(ALLOWED_AMENITY_VALUES);
    const NEARBY_PANEL_MOBILE_BREAKPOINT = '(max-width: 768px)';

    let nearbyPanelMobileQuery = null;

    const partySizeButtons = Array.isArray(partySizeOptionButtons) ? partySizeOptionButtons : [];
    const partySizePromptButtons = Array.isArray(partySizePromptOptionButtons) ? partySizePromptOptionButtons : [];
    let partySizePromptResolver = null;


    const RECENT_VISITS_STORAGE_KEY = 'tfosMakomRecentVisits';
    const MAX_RECENT_VISITS = 20;
    const ACTIVE_WAIT_SESSION_STORAGE_KEY = 'tfosMakomActiveWaitSession';
    const LIVE_QUEUE_STALE_MINUTES = 45;
    const LIVE_QUEUE_ENTRY_STALE_MINUTES = 240;

    recentVisits = normalizeRecentVisitsArray(
        Array.isArray(recentVisits) && recentVisits.length > 0
            ? recentVisits
            : loadRecentVisitsFromStorage()
    );
    persistRecentVisits(recentVisits);

    function loadActiveWaitSessionFromStorage() {
        try {
            const raw = localStorage.getItem(ACTIVE_WAIT_SESSION_STORAGE_KEY);
            if (!raw) {
                return null;
            }
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') {
                return null;
            }

            const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId.trim() : '';
            const locationId = typeof parsed.locationId === 'string' ? parsed.locationId.trim() : '';
            const partyKey = typeof parsed.partyKey === 'string' ? parsed.partyKey.trim().toLowerCase() : '';
            const allowedKeys = ['small', 'medium', 'large'];
            const normalizedPartyKey = allowedKeys.includes(partyKey) ? partyKey : 'small';
            const enteredAt = typeof parsed.enteredAt === 'string' ? parsed.enteredAt : null;

            if (!sessionId || !locationId) {
                return null;
            }

            return {
                sessionId,
                locationId,
                partyKey: normalizedPartyKey,
                enteredAt
            };
        } catch (error) {
            console.warn('Failed to load active wait session from storage', error);
            return null;
        }
    }

    function persistActiveWaitSession(session) {
        try {
            if (!session) {
                localStorage.removeItem(ACTIVE_WAIT_SESSION_STORAGE_KEY);
                return;
            }

            const allowedKeys = ['small', 'medium', 'large'];
            const normalizedPartyKey = allowedKeys.includes((session.partyKey || '').toLowerCase())
                ? session.partyKey.toLowerCase()
                : 'small';

            const payload = {
                sessionId: session.sessionId,
                locationId: session.locationId,
                partyKey: normalizedPartyKey,
                enteredAt: session.enteredAt instanceof Date
                    ? session.enteredAt.toISOString()
                    : (typeof session.enteredAt === 'string' ? session.enteredAt : null)
            };

            localStorage.setItem(ACTIVE_WAIT_SESSION_STORAGE_KEY, JSON.stringify(payload));
        } catch (error) {
            console.warn('Failed to persist active wait session', error);
        }
    }

    function clearActiveWaitSessionStorage() {
        try {
            localStorage.removeItem(ACTIVE_WAIT_SESSION_STORAGE_KEY);
        } catch (error) {
            console.warn('Failed to clear active wait session storage', error);
        }
    }

    let orphanedWaitSession = loadActiveWaitSessionFromStorage();

    function normalizePartySizeKey(key) {
        const normalized = typeof key === 'string' ? key.trim().toLowerCase() : '';
        return normalized && WAIT_GROUP_CATEGORY_METADATA[normalized]
            ? normalized
            : 'small';
    }

    function updatePartySizeSelectionUI() {
        if (!partySizeButtons.length) {
            return;
        }

        const normalizedKey = normalizePartySizeKey(selectedPartySizeKey);
        partySizeButtons.forEach((button) => {
            if (!(button instanceof HTMLElement)) return;
            const key = normalizePartySizeKey(button.dataset.partyKey);
            const isActive = key === normalizedKey;
            button.classList.toggle('is-active', isActive);
            button.setAttribute('aria-checked', isActive ? 'true' : 'false');
            button.setAttribute('tabindex', isActive ? '0' : '-1');
        });

        if (partySizeSelector) {
            partySizeSelector.setAttribute('data-selected', normalizedKey);
        }
    }

    function setPartySizeButtonsDisabled(disabled) {
        if (!partySizeButtons.length) {
            return;
        }

        partySizeButtons.forEach((button) => {
            if (!(button instanceof HTMLButtonElement)) return;
            button.disabled = Boolean(disabled);
            button.setAttribute('data-disabled', disabled ? 'true' : 'false');
        });
    }

    function updatePartySizePromptSelectionUI() {
        if (!partySizePromptButtons.length) {
            if (partySizePromptConfirmBtn) {
                partySizePromptConfirmBtn.disabled = false;
            }
            return;
        }

        const normalizedKey = normalizePartySizeKey(pendingPartySizeSelectionKey || selectedPartySizeKey);

        partySizePromptButtons.forEach((button) => {
            if (!(button instanceof HTMLElement)) return;
            const key = normalizePartySizeKey(button.dataset.partyKey);
            const isActive = key === normalizedKey;
            button.classList.toggle('is-active', isActive);
            button.setAttribute('aria-checked', isActive ? 'true' : 'false');
            button.setAttribute('tabindex', isActive ? '0' : '-1');
        });

        if (partySizePromptConfirmBtn) {
            partySizePromptConfirmBtn.disabled = !normalizedKey;
        }
    }

    function setPendingPartySizeSelectionKey(newKey) {
        pendingPartySizeSelectionKey = normalizePartySizeKey(newKey || pendingPartySizeSelectionKey || selectedPartySizeKey);
        updatePartySizePromptSelectionUI();
        updateState();
    }

    function openPartySizePrompt(defaultKey) {
        if (!partySizePrompt) {
            return;
        }

        pendingPartySizeSelectionKey = normalizePartySizeKey(defaultKey || pendingPartySizeSelectionKey || selectedPartySizeKey);
        updatePartySizePromptSelectionUI();

        isPartySizePromptOpen = true;
        partySizePrompt.setAttribute('aria-hidden', 'false');
        partySizePrompt.classList.remove('hidden');
        document.body.classList.add('overflow-hidden');

        const focusTarget = partySizePromptButtons.find((button) => {
            const key = normalizePartySizeKey(button?.dataset?.partyKey);
            return key === pendingPartySizeSelectionKey;
        }) || partySizePromptButtons[0] || partySizePromptConfirmBtn;

        if (focusTarget && typeof focusTarget.focus === 'function') {
            focusTarget.focus({ preventScroll: true });
        }

        updateState();
    }

    function closePartySizePrompt() {
        if (!partySizePrompt) {
            return;
        }

        partySizePrompt.setAttribute('aria-hidden', 'true');
        partySizePrompt.classList.add('hidden');
        document.body.classList.remove('overflow-hidden');
        isPartySizePromptOpen = false;
        updateState();
    }

    function resolvePartySizePrompt(result) {
        const resolver = partySizePromptResolver;
        partySizePromptResolver = null;
        closePartySizePrompt();
        if (typeof resolver === 'function') {
            resolver(result);
        }
    }

    function promptForPartySize(defaultKey = 'small') {
        const normalizedDefault = normalizePartySizeKey(defaultKey);

        if (!partySizePrompt) {
            return Promise.resolve(normalizedDefault);
        }

        if (typeof partySizePromptResolver === 'function') {
            const resolver = partySizePromptResolver;
            partySizePromptResolver = null;
            resolver(null);
        }

        if (isPartySizePromptOpen) {
            closePartySizePrompt();
        }

        openPartySizePrompt(normalizedDefault);

        return new Promise((resolve) => {
            partySizePromptResolver = resolve;
        });
    }

    function calculateGroupsAhead(liveQueueRecord, partyKey, sessionId, registeredAt) {
        const normalizedKey = normalizePartySizeKey(partyKey);
        const fallbackSize = WAIT_GROUP_CATEGORY_METADATA[normalizedKey]?.estimate || 0;
        const entries = Array.isArray(liveQueueRecord?.entries) ? liveQueueRecord.entries : [];
        const now = Date.now();
        const entryStaleThreshold = now - LIVE_QUEUE_ENTRY_STALE_MINUTES * 60 * 1000;

        const normalizedEntries = entries
            .filter((entry) => entry && normalizePartySizeKey(entry.category) === normalizedKey)
            .map((entry) => {
                const sizeCandidate = Number(entry.size);
                const size = Number.isFinite(sizeCandidate) && sizeCandidate > 0 ? sizeCandidate : fallbackSize;
                const enteredAt = entry?.enteredAt ? new Date(entry.enteredAt) : null;
                return {
                    id: typeof entry?.id === 'string' ? entry.id : '',
                    size,
                    enteredAt
                };
            })
            .filter((entry) => entry.id && (!entry.enteredAt || entry.enteredAt.getTime() >= entryStaleThreshold));

        if (sessionId && registeredAt && !normalizedEntries.some((entry) => entry.id === sessionId)) {
            const registeredDate = registeredAt instanceof Date ? registeredAt : new Date(registeredAt);
            if (!Number.isNaN(registeredDate.getTime())) {
                normalizedEntries.push({
                    id: sessionId,
                    size: fallbackSize,
                    enteredAt: registeredDate,
                    isLocal: true
                });
            }
        }

        normalizedEntries.sort((a, b) => {
            const aTime = a.enteredAt ? a.enteredAt.getTime() : 0;
            const bTime = b.enteredAt ? b.enteredAt.getTime() : 0;
            return aTime - bTime;
        });

        let groupsAhead = 0;
        let peopleAhead = 0;
        let sawSelf = false;

        for (const entry of normalizedEntries) {
            if (sessionId && entry.id === sessionId) {
                sawSelf = true;
                break;
            }
            groupsAhead += 1;
            peopleAhead += entry.size;
        }

        if (sessionId && !sawSelf) {
            groupsAhead = normalizedEntries.length;
            peopleAhead = normalizedEntries.reduce((sum, entry) => sum + entry.size, 0);
        }

        const updatedAt = normalizedEntries.reduce((latest, entry) => {
            if (!entry.enteredAt) {
                return latest;
            }
            if (!latest || entry.enteredAt > latest) {
                return entry.enteredAt;
            }
            return latest;
        }, liveQueueRecord?.updatedAt ? new Date(liveQueueRecord.updatedAt) : null);

        return {
            groupsAhead,
            peopleAhead,
            updatedAt
        };
    }

    function updateWaitingPartyInsights() {
        if (
            !waitingGroupAverageValue ||
            !waitingGroupAverageHint ||
            !waitingGroupPositionValue ||
            !waitingGroupPositionHint
        ) {
            return;
        }

        const normalizedKey = normalizePartySizeKey(selectedPartySizeKey);
        const category = WAIT_GROUP_CATEGORY_METADATA[normalizedKey] || WAIT_GROUP_CATEGORY_METADATA.small;
        const locationData = currentLocationId ? getLocationFromCache(currentLocationId) : null;
        const visits = Array.isArray(locationData?.visits) ? locationData.visits : [];
        const stats = computeLocationStats(visits, { liveQueue: locationData?.liveQueue });
        const { dayIndex, hourIndex } = getCurrentTimeContext();

        let averageSeconds = null;
        const hourlyByGroup = stats?.hourlyAveragesByGroup?.[normalizedKey];
        const hourlyRow = Array.isArray(hourlyByGroup?.[dayIndex]) ? hourlyByGroup[dayIndex] : null;
        const maybeAverage = Array.isArray(hourlyRow) ? hourlyRow[hourIndex] : null;
        if (Number.isFinite(maybeAverage) && maybeAverage > 0) {
            averageSeconds = maybeAverage;
        }

        if (averageSeconds !== null) {
            waitingGroupAverageValue.textContent = formatDurationWithUnits(averageSeconds);
            waitingGroupAverageHint.textContent = `${DAY_NAMES_HE[dayIndex]} · ${formatHourLabel(hourIndex)} · ממוצע לקבוצות ${category.rangeLabel}`;
        } else {
            waitingGroupAverageValue.textContent = 'אין נתונים';
            waitingGroupAverageHint.textContent = 'נעדכן ברגע שיגיעו דיווחים לשעה ולגודל קבוצה זה.';
        }

        const sessionMatchesLocation = activeWaitLocationId && activeWaitLocationId === currentLocationId;
        const sessionId = sessionMatchesLocation ? activeWaitSessionId : null;
        const sessionRegisteredAt = sessionMatchesLocation ? activeWaitRegisteredAt : null;
        const liveQueueRecord = normalizeLiveQueueRecord(locationData?.liveQueue);
        const { groupsAhead, peopleAhead, updatedAt: queueUpdatedAt } = calculateGroupsAhead(
            liveQueueRecord,
            normalizedKey,
            sessionId,
            sessionRegisteredAt
        );

        const roundedPeopleAhead = Math.max(0, Math.round(peopleAhead));

        let valueLabel;
        if (groupsAhead === 0) {
            valueLabel = '0 קבוצות לפניכם';
        } else if (groupsAhead === 1) {
            valueLabel = 'קבוצה אחת לפניכם';
        } else {
            valueLabel = `${groupsAhead} קבוצות לפניכם`;
        }

        waitingGroupPositionValue.textContent = valueLabel;

        const updateText = queueUpdatedAt instanceof Date
            ? `עודכן לפני ${formatRelativeTimeFromNow(queueUpdatedAt)}.`
            : 'נעדכן בזמן אמת אחרי צ׳ק-אין חדש.';

        if (groupsAhead > 0) {
            const peopleLabel = roundedPeopleAhead > 0 ? ` · כ-${roundedPeopleAhead} אנשים` : '';
            waitingGroupPositionHint.textContent = `קבוצות בגודל ${category.rangeLabel} שכבר בצ'ק-אין לפניכם${peopleLabel}. ${updateText}`;
        } else {
            waitingGroupPositionHint.textContent = `אין כרגע קבוצות בגודל ${category.rangeLabel} שממתינות לפניכם. ${updateText}`;
        }
    }

    function setSelectedPartySizeKey(newKey) {
        selectedPartySizeKey = normalizePartySizeKey(newKey || selectedPartySizeKey);
        pendingPartySizeSelectionKey = selectedPartySizeKey;
        updatePartySizeSelectionUI();
        updatePartySizePromptSelectionUI();
        updateWaitingPartyInsights();
        updateState();
    }

    function cyclePartySizeSelection(step, currentIndex = null) {
        if (!partySizeButtons.length) {
            return;
        }

        let index = Number.isInteger(currentIndex) ? currentIndex : partySizeButtons.findIndex((button) => {
            const key = normalizePartySizeKey(button?.dataset?.partyKey);
            return key === selectedPartySizeKey;
        });

        if (index < 0) {
            index = 0;
        }

        const total = partySizeButtons.length;
        const nextIndex = (index + step + total) % total;
        const nextButton = partySizeButtons[nextIndex];
        if (nextButton) {
            const nextKey = nextButton.dataset?.partyKey;
            setSelectedPartySizeKey(nextKey);
            nextButton.focus();
        }
    }

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
            gpsPoiFetchAbortController,
            isLoadingPois,
            lastPoiFetchBounds,
            lastGpsNearbyBounds,
            selectedPlaceInfo,
            isSavingCheckIn,
            selectedPartySizeKey,
            pendingPartySizeSelectionKey,
            isPartySizePromptOpen,
            activeWaitSessionId,
            activeWaitLocationId,
            activeWaitPartyKey,
            activeWaitRegisteredAt,
            liveStatusTimeoutId,
            waitingSyncHideTimeoutId,
            renameLocationPendingId,
            isRenamingLocation,
            firebaseAppInstance,
            firestoreDb,
            unsubscribeLocations,
            locationsLoaded,
            firebaseInitializationError,
            poiPlaces,
            gpsNearbyPlaces,
            nearbyPanelVisible,
            nearbyPanelCollapsed,
            nearbyPanelHasResults,
            confettiTimeoutId,
            recentVisits
        });
    }

    function isNearbyPanelCollapsible() {
        return Boolean(nearbyPanelMobileQuery?.matches);
    }

    function syncNearbyPanelCollapsedClass() {
        if (!nearbyLocationsPanel) {
            return;
        }

        if (nearbyPanelCollapsed && isNearbyPanelCollapsible()) {
            nearbyLocationsPanel.classList.add('nearby-panel--collapsed');
        } else {
            nearbyLocationsPanel.classList.remove('nearby-panel--collapsed');
        }
    }

    function updateNearbyPanelToggleState() {
        if (!nearbyPanelToggleBtn) {
            return;
        }

        const collapsible = isNearbyPanelCollapsible();

        if (collapsible) {
            nearbyPanelToggleBtn.removeAttribute('hidden');
            nearbyPanelToggleBtn.tabIndex = 0;
        } else {
            nearbyPanelToggleBtn.setAttribute('hidden', '');
            nearbyPanelToggleBtn.tabIndex = -1;
        }

        nearbyPanelToggleBtn.setAttribute('aria-expanded', String(!nearbyPanelCollapsed));
        const label = nearbyPanelCollapsed
            ? 'הצגת רשימת המקומות הקרובים'
            : 'צמצום רשימת המקומות הקרובים';
        nearbyPanelToggleBtn.setAttribute('aria-label', label);
    }

    function setNearbyPanelCollapsed(collapsed, { force = false, skipStateUpdate = false } = {}) {
        if (!nearbyLocationsPanel) {
            return;
        }

        const collapsible = isNearbyPanelCollapsible();
        const shouldCollapse = force ? Boolean(collapsed) : Boolean(collapsible && collapsed);
        const previousValue = nearbyPanelCollapsed;

        nearbyPanelCollapsed = shouldCollapse;
        syncNearbyPanelCollapsedClass();
        updateNearbyPanelToggleState();

        if (previousValue !== nearbyPanelCollapsed && !skipStateUpdate) {
            updateState();
        }
    }

    function handleNearbyPanelViewportChange(matches) {
        if (!matches && nearbyPanelCollapsed) {
            setNearbyPanelCollapsed(false, { force: true });
            return;
        }

        syncNearbyPanelCollapsedClass();
        updateNearbyPanelToggleState();
    }

    function setupNearbyPanelMediaQuery() {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
            updateNearbyPanelToggleState();
            syncNearbyPanelCollapsedClass();
            return;
        }

        if (nearbyPanelMobileQuery) {
            handleNearbyPanelViewportChange(nearbyPanelMobileQuery.matches);
            return;
        }

        nearbyPanelMobileQuery = window.matchMedia(NEARBY_PANEL_MOBILE_BREAKPOINT);

        const changeListener = (event) => {
            handleNearbyPanelViewportChange(event.matches);
        };

        if (typeof nearbyPanelMobileQuery.addEventListener === 'function') {
            nearbyPanelMobileQuery.addEventListener('change', changeListener);
        } else if (typeof nearbyPanelMobileQuery.addListener === 'function') {
            nearbyPanelMobileQuery.addListener(changeListener);
        }

        handleNearbyPanelViewportChange(nearbyPanelMobileQuery.matches);
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

    setupNearbyPanelMediaQuery();

    if (nearbyPanelToggleBtn) {
        nearbyPanelToggleBtn.addEventListener('click', () => {
            if (!isNearbyPanelCollapsible()) {
                return;
            }
            setNearbyPanelCollapsed(!nearbyPanelCollapsed);
        });
    }

    if (nearbyLocationsList) {
        renderNearbyPanelPlaceholder('ממתינים למיקום ה-GPS שלך כדי להציג מקומות קרובים.');
        setNearbyPanelVisible(true);
    }

    // Define user icon
    userIcon = L.divIcon({
        className: 'user-location-icon',
        iconSize: [18, 18]
    });

    // Event Listeners
    if (searchBtn) {
        searchBtn.addEventListener('click', () => { void handleSearchLocation(); });
    }
    if (locationNameInput) {
        locationNameInput.addEventListener('input', handleLocationInputChange);
        locationNameInput.addEventListener('keydown', handleLocationInputKeyDown);
    }
    if (searchSuggestionsList) {
        searchSuggestionsList.addEventListener('pointerdown', (event) => event.preventDefault());
        searchSuggestionsList.addEventListener('click', handleSearchSuggestionListClick);
    }

    if (nearbyLocationsList) {
        nearbyLocationsList.addEventListener('click', handleNearbyListClick);
        nearbyLocationsList.addEventListener('keydown', handleNearbyListKeyDown);
    }

    if (partySizeButtons.length) {
        partySizeButtons.forEach((button, index) => {
            if (!(button instanceof HTMLButtonElement)) return;

            button.addEventListener('click', () => {
                const key = button.dataset.partyKey;
                setSelectedPartySizeKey(key);
            });

            button.addEventListener('keydown', (event) => {
                if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                    event.preventDefault();
                    cyclePartySizeSelection(1, index);
                } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    cyclePartySizeSelection(-1, index);
                } else if (event.key === 'Home') {
                    event.preventDefault();
                    cyclePartySizeSelection(-index, index);
                } else if (event.key === 'End') {
                    event.preventDefault();
                    cyclePartySizeSelection(partySizeButtons.length - 1 - index, index);
                } else if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    const key = button.dataset.partyKey;
                    setSelectedPartySizeKey(key);
                }
            });
        });

        setSelectedPartySizeKey(selectedPartySizeKey);
    }

    if (partySizePromptButtons.length) {
        partySizePromptButtons.forEach((button, index) => {
            if (!(button instanceof HTMLButtonElement)) return;

            button.addEventListener('click', () => {
                const key = button.dataset.partyKey;
                setPendingPartySizeSelectionKey(key);
            });

            button.addEventListener('keydown', (event) => {
                if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                    event.preventDefault();
                    const nextIndex = (index + 1) % partySizePromptButtons.length;
                    partySizePromptButtons[nextIndex]?.focus?.();
                    const key = partySizePromptButtons[nextIndex]?.dataset?.partyKey;
                    if (key) {
                        setPendingPartySizeSelectionKey(key);
                    }
                } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    const nextIndex = (index - 1 + partySizePromptButtons.length) % partySizePromptButtons.length;
                    partySizePromptButtons[nextIndex]?.focus?.();
                    const key = partySizePromptButtons[nextIndex]?.dataset?.partyKey;
                    if (key) {
                        setPendingPartySizeSelectionKey(key);
                    }
                } else if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    const key = button.dataset.partyKey;
                    setPendingPartySizeSelectionKey(key);
                    if (partySizePromptConfirmBtn && !partySizePromptConfirmBtn.disabled) {
                        partySizePromptConfirmBtn.click();
                    }
                }
            });
        });
    }

    if (partySizePromptConfirmBtn) {
        partySizePromptConfirmBtn.addEventListener('click', () => {
            if (partySizePromptConfirmBtn.disabled) {
                return;
            }
            const normalized = normalizePartySizeKey(pendingPartySizeSelectionKey || selectedPartySizeKey || 'small');
            resolvePartySizePrompt(normalized);
        });
    }

    if (partySizePromptCancelBtn) {
        partySizePromptCancelBtn.addEventListener('click', () => {
            resolvePartySizePrompt(null);
        });
    }

    if (partySizePrompt) {
        partySizePrompt.addEventListener('click', (event) => {
            if (event.target === partySizePrompt) {
                resolvePartySizePrompt(null);
            }
        });
    }

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && isPartySizePromptOpen) {
            event.preventDefault();
            resolvePartySizePrompt(null);
        }
    });

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
    renderRecentVisits();

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
        renderRecentVisits();
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
            renderRecentVisits();
            updateState();
            return;
        }

        if (firebaseAppInstance) {
            if (orphanedWaitSession && orphanedWaitSession.locationId && orphanedWaitSession.sessionId && firestoreDb) {
                void releaseLiveQueueEntry(orphanedWaitSession.locationId, orphanedWaitSession.sessionId, {
                    silent: true,
                    keepState: true
                });
                orphanedWaitSession = null;
                clearActiveWaitSessionStorage();
            }

            updateState();
            return;
        }

        try {
            firebaseAppInstance = initializeApp(firebaseConfig);
            firestoreDb = getFirestore(firebaseAppInstance);
            subscribeToLocations();

            if (orphanedWaitSession && orphanedWaitSession.locationId && orphanedWaitSession.sessionId) {
                void releaseLiveQueueEntry(orphanedWaitSession.locationId, orphanedWaitSession.sessionId, {
                    silent: true,
                    keepState: true
                });
                orphanedWaitSession = null;
                clearActiveWaitSessionStorage();
            }
        } catch (error) {
            firebaseInitializationError = error;
            console.error('Failed to initialize Firebase', error);
            renderRecentVisits();
        }

        updateState();
    }

    function generateWaitSessionId() {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
        return `wait_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    }

    function applyLiveQueueEntriesToCache(locationId, entries, updatedAt, options = {}) {
        if (!locationId) {
            return;
        }

        const cached = getLocationFromCache(locationId);
        const baseData = cached || options.baseData;

        if (!baseData) {
            return;
        }

        const normalizedUpdatedAt = updatedAt instanceof Date
            ? updatedAt.toISOString()
            : (typeof updatedAt === 'string' ? updatedAt : null);

        const sanitizedEntries = Array.isArray(entries)
            ? entries
                .map((entry) => {
                    const id = typeof entry?.id === 'string' ? entry.id : '';
                    const category = normalizePartySizeKey(entry?.category || entry?.partyKey);
                    if (!id || !category) {
                        return null;
                    }

                    const sizeCandidate = Number(entry?.size);
                    const size = Number.isFinite(sizeCandidate) && sizeCandidate > 0
                        ? sizeCandidate
                        : (WAIT_GROUP_CATEGORY_METADATA[category]?.estimate || 0);

                    const enteredAt = entry?.enteredAt instanceof Date
                        ? entry.enteredAt.toISOString()
                        : (typeof entry?.enteredAt === 'string' ? entry.enteredAt : null);

                    return {
                        id,
                        category,
                        size,
                        enteredAt
                    };
                })
                .filter(Boolean)
            : [];

        const liveQueuePayload = {
            version: 1,
            updatedAt: normalizedUpdatedAt,
            entries: sanitizedEntries
        };

        upsertLocationInCache(locationId, {
            ...baseData,
            liveQueue: liveQueuePayload
        });
    }

    async function mutateLiveQueue(locationId, mutator, options = {}) {
        if (!firestoreDb || !locationId || typeof mutator !== 'function') {
            return null;
        }

        const { baseData = null } = options;

        const locationRef = doc(firestoreDb, FIRESTORE_LOCATIONS_COLLECTION, locationId);
        let mutationResult = null;

        await runTransaction(firestoreDb, async (transaction) => {
            const snapshot = await transaction.get(locationRef);
            const rawData = snapshot.exists() ? snapshot.data() : baseData || {};
            const normalizedRecord = normalizeLocationRecord(locationId, rawData, { maxVisitHistory: MAX_VISIT_HISTORY });
            const currentEntries = Array.isArray(normalizedRecord.liveQueue?.entries)
                ? normalizedRecord.liveQueue.entries
                : [];

            const mutatedEntries = mutator(currentEntries, normalizedRecord);

            if (!mutatedEntries) {
                mutationResult = {
                    entries: currentEntries,
                    updatedAt: normalizedRecord.liveQueue?.updatedAt
                        ? new Date(normalizedRecord.liveQueue.updatedAt)
                        : null
                };
                return;
            }

            const sanitizedEntries = Array.isArray(mutatedEntries)
                ? mutatedEntries
                : (Array.isArray(mutatedEntries.entries) ? mutatedEntries.entries : []);

            const uniqueMap = new Map();
            for (const entry of sanitizedEntries) {
                if (!entry) continue;

                const id = typeof entry.id === 'string' ? entry.id.trim() : '';
                const category = normalizePartySizeKey(entry.category || entry.partyKey);
                if (!id || !category) {
                    continue;
                }

                const sizeCandidate = Number(entry.size);
                const size = Number.isFinite(sizeCandidate) && sizeCandidate > 0
                    ? sizeCandidate
                    : (WAIT_GROUP_CATEGORY_METADATA[category]?.estimate || 0);

                const enteredAtIso = entry.enteredAt instanceof Date
                    ? entry.enteredAt.toISOString()
                    : (typeof entry.enteredAt === 'string' ? entry.enteredAt : new Date().toISOString());

                const key = `${category}:${id}`;
                const existing = uniqueMap.get(key);
                if (existing) {
                    const existingTime = existing.enteredAt ? new Date(existing.enteredAt).getTime() : 0;
                    const candidateTime = enteredAtIso ? new Date(enteredAtIso).getTime() : 0;
                    if (candidateTime <= existingTime) {
                        continue;
                    }
                }

                uniqueMap.set(key, {
                    id,
                    category,
                    size,
                    enteredAt: enteredAtIso
                });
            }

            const finalEntries = Array.from(uniqueMap.values()).sort((a, b) => {
                const aTime = a.enteredAt ? new Date(a.enteredAt).getTime() : 0;
                const bTime = b.enteredAt ? new Date(b.enteredAt).getTime() : 0;
                return aTime - bTime;
            });

            transaction.set(locationRef, {
                liveQueue: {
                    version: 1,
                    updatedAt: serverTimestamp(),
                    entries: finalEntries
                }
            }, { merge: true });

            mutationResult = {
                entries: finalEntries,
                updatedAt: new Date()
            };
        });

        if (mutationResult) {
            applyLiveQueueEntriesToCache(locationId, mutationResult.entries, mutationResult.updatedAt, { baseData });
        }

        return mutationResult;
    }

    async function registerLiveQueueEntry(locationId, partyKey, options = {}) {
        if (!locationId) {
            return null;
        }

        const normalizedKey = normalizePartySizeKey(partyKey);
        const sessionId = typeof options.sessionId === 'string' && options.sessionId.trim().length > 0
            ? options.sessionId.trim()
            : generateWaitSessionId();
        const now = new Date();
        const sizeEstimate = Number.isFinite(Number(options.sizeEstimate)) && Number(options.sizeEstimate) > 0
            ? Number(options.sizeEstimate)
            : (WAIT_GROUP_CATEGORY_METADATA[normalizedKey]?.estimate || 0);

        setWaitingSyncIndicatorActive(true);

        try {
            const result = await mutateLiveQueue(locationId, (currentEntries = []) => {
                const nowMs = now.getTime();
                const staleThreshold = nowMs - LIVE_QUEUE_ENTRY_STALE_MINUTES * 60 * 1000;
                const nextEntries = [];
                const seen = new Set();

                for (const entry of currentEntries) {
                    const entryId = typeof entry?.id === 'string' ? entry.id : '';
                    const entryCategory = normalizePartySizeKey(entry?.category);
                    if (!entryId || !entryCategory) {
                        continue;
                    }

                    if (entryId === sessionId) {
                        continue;
                    }

                    const enteredAtTime = entry?.enteredAt
                        ? new Date(entry.enteredAt).getTime()
                        : null;

                    if (enteredAtTime && enteredAtTime < staleThreshold) {
                        continue;
                    }

                    const uniqueKey = `${entryCategory}:${entryId}`;
                    if (seen.has(uniqueKey)) {
                        continue;
                    }
                    seen.add(uniqueKey);

                    nextEntries.push({
                        id: entryId,
                        category: entryCategory,
                        size: Number(entry?.size) > 0 ? Number(entry.size) : (WAIT_GROUP_CATEGORY_METADATA[entryCategory]?.estimate || 0),
                        enteredAt: enteredAtTime ? new Date(enteredAtTime).toISOString() : now.toISOString()
                    });
                }

                nextEntries.push({
                    id: sessionId,
                    category: normalizedKey,
                    size: sizeEstimate,
                    enteredAt: now.toISOString()
                });

                nextEntries.sort((a, b) => {
                    const aTime = a.enteredAt ? new Date(a.enteredAt).getTime() : 0;
                    const bTime = b.enteredAt ? new Date(b.enteredAt).getTime() : 0;
                    return aTime - bTime;
                });

                return nextEntries;
            }, {
                baseData: options.baseData || null
            });

            activeWaitSessionId = sessionId;
            activeWaitLocationId = locationId;
            activeWaitPartyKey = normalizedKey;
            activeWaitRegisteredAt = now;

            persistActiveWaitSession({
                sessionId,
                locationId,
                partyKey: normalizedKey,
                enteredAt: now
            });

            updateWaitingPartyInsights();
            updateState();

            return result;
        } catch (error) {
            console.error('Failed to register live queue entry', error);
            return null;
        } finally {
            setWaitingSyncIndicatorActive(false);
        }
    }

    async function releaseLiveQueueEntry(locationId, sessionId, options = {}) {
        if (!firestoreDb || !locationId || !sessionId) {
            return null;
        }

        const { silent = false, keepState = false, baseData = null } = options;

        if (!silent) {
            setWaitingSyncIndicatorActive(true);
        }

        try {
            const now = new Date();
            const result = await mutateLiveQueue(locationId, (currentEntries = []) => {
                const nowMs = now.getTime();
                const staleThreshold = nowMs - LIVE_QUEUE_ENTRY_STALE_MINUTES * 60 * 1000;
                const nextEntries = [];
                const seen = new Set();

                for (const entry of currentEntries) {
                    const entryId = typeof entry?.id === 'string' ? entry.id : '';
                    const entryCategory = normalizePartySizeKey(entry?.category);
                    if (!entryId || !entryCategory) {
                        continue;
                    }

                    if (entryId === sessionId) {
                        continue;
                    }

                    const enteredAtTime = entry?.enteredAt
                        ? new Date(entry.enteredAt).getTime()
                        : null;

                    if (enteredAtTime && enteredAtTime < staleThreshold) {
                        continue;
                    }

                    const uniqueKey = `${entryCategory}:${entryId}`;
                    if (seen.has(uniqueKey)) {
                        continue;
                    }
                    seen.add(uniqueKey);

                    nextEntries.push({
                        id: entryId,
                        category: entryCategory,
                        size: Number(entry?.size) > 0 ? Number(entry.size) : (WAIT_GROUP_CATEGORY_METADATA[entryCategory]?.estimate || 0),
                        enteredAt: enteredAtTime ? new Date(enteredAtTime).toISOString() : now.toISOString()
                    });
                }

                return nextEntries;
            }, { baseData });

            if (!keepState) {
                clearActiveWaitSessionStorage();

                if (activeWaitSessionId === sessionId) {
                    activeWaitSessionId = null;
                    activeWaitLocationId = null;
                    activeWaitPartyKey = selectedPartySizeKey || 'small';
                    activeWaitRegisteredAt = null;
                    updateWaitingPartyInsights();
                    updateState();
                }
            }

            return result;
        } catch (error) {
            if (!silent) {
                console.error('Failed to release live queue entry', error);
            }
            return null;
        } finally {
            if (!silent) {
                setWaitingSyncIndicatorActive(false);
            }
        }
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
        renderRecentVisits();
        updateState();
    });
}

function onLocationDataUpdated() {
    renderRecentVisits();
    renderVisitedLocationsOnMap();

    if (currentLocationId && targetDetailsCard && targetDetailsCard.getAttribute('aria-hidden') === 'false') {
        showLocationCard(targetName, currentLocationId);
    }

    if (checkInStartTime) {
        updateWaitingPartyInsights();
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

    renderVisitedLocationsOnMap();

    scheduleViewportPlacesRefresh({ immediate: true });

    map.on('moveend', handleMapMoveEnd);

    updateState();
}

function handleMapMoveEnd() {
    scheduleViewportPlacesRefresh();
}

function scheduleViewportPlacesRefresh({ immediate = false } = {}) {
    if (!map) {
        return;
    }

    if (poiRefreshTimeoutId) {
        clearTimeout(poiRefreshTimeoutId);
        poiRefreshTimeoutId = null;
    }

    const triggerFetch = () => {
        poiRefreshTimeoutId = null;
        fetchViewportPlaces().catch((error) => {
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

async function fetchViewportPlaces() {
    if (!map) {
        return;
    }

    if (poiFetchAbortController) {
        poiFetchAbortController.abort();
    }

    const center = map.getCenter();
    const centerLat = Number(center?.lat);
    const centerLon = Number(center?.lng);

    if (!Number.isFinite(centerLat) || !Number.isFinite(centerLon)) {
        if (poiLayer) {
            poiLayer.clearLayers();
        }
        lastPoiFetchBounds = null;
        updateState();
        return;
    }

    const fetchContext = {
        lat: centerLat,
        lon: centerLon,
        radius: Number(NEARBY_PLACES_RADIUS_METERS)
    };

    lastPoiFetchBounds = fetchContext;

    poiFetchAbortController = new AbortController();
    const signal = poiFetchAbortController.signal;

    const query = buildOverpassPlacesQuery(fetchContext);

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
        renderPointsOfInterest(elements, fetchContext);
    } catch (error) {
        if (error?.name === 'AbortError') {
            return;
        }
        console.error('Failed to fetch nearby places', error);
    } finally {
        if (poiFetchAbortController?.signal === signal) {
            poiFetchAbortController = null;
        }
        updateState();
    }
}

function buildOverpassPlacesQuery({ lat, lon, radius }) {
    const normalizedLat = Number(lat);
    const normalizedLon = Number(lon);
    const normalizedRadius = Math.min(Math.max(Number(radius) || 0, 50), 5000);
    const amenityPattern = ALLOWED_AMENITY_VALUES
        .map((value) => value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'))
        .join('|');

    if (!Number.isFinite(normalizedLat) || !Number.isFinite(normalizedLon)) {
        throw new Error('Invalid parameters for Overpass query');
    }

    const areaSelector = `(around:${normalizedRadius},${normalizedLat.toFixed(6)},${normalizedLon.toFixed(6)})`;

    return `
[out:json][timeout:25];
(
  node["amenity"~"^(${amenityPattern})$"]${areaSelector};
  way["amenity"~"^(${amenityPattern})$"]${areaSelector};
  rel["amenity"~"^(${amenityPattern})$"]${areaSelector};
);
out center 60;
`;
}

function collectPlacesFromOverpass(elements) {
    const uniqueElements = new Map();
    for (const element of Array.isArray(elements) ? elements : []) {
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

    return places;
}

function renderPointsOfInterest(elements, fetchContext) {
    if (!map) {
        return;
    }

    if (!poiLayer) {
        poiLayer = L.layerGroup().addTo(map);
    }

    poiLayer.clearLayers();

    const places = collectPlacesFromOverpass(elements);

    const referenceLat = Number(fetchContext?.lat);
    const referenceLon = Number(fetchContext?.lon);

    let prioritizedPlaces = places.slice();

    if (Number.isFinite(referenceLat) && Number.isFinite(referenceLon)) {
        prioritizedPlaces = places
            .map((place) => {
                if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lon)) {
                    return null;
                }

                const distance = calculateDistanceMeters(referenceLat, referenceLon, place.lat, place.lon);
                if (!Number.isFinite(distance)) {
                    return null;
                }

                return { place, distance };
            })
            .filter(Boolean)
            .sort((a, b) => a.distance - b.distance)
            .map(({ place }) => place);
    }

    poiPlaces = prioritizedPlaces;

    for (const place of poiPlaces) {
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

function setNearbyPanelHasResults(hasResults) {
    const nextValue = Boolean(hasResults);
    if (nearbyPanelHasResults !== nextValue) {
        nearbyPanelHasResults = nextValue;
        updateState();
    }
}

function renderNearbyPanelPlaceholder(message, options = {}) {
    if (!nearbyLocationsList) {
        return false;
    }

    const { preserveExisting = false } = options;
    if (preserveExisting && nearbyPanelHasResults) {
        return false;
    }

    const safeMessage = typeof message === 'string' && message.trim().length > 0
        ? message
        : 'לא נמצאו מקומות להצגה באזור זה.';

    nearbyLocationsList.innerHTML = `<li class="nearby-panel__empty" role="presentation">${escapeHtml(safeMessage)}</li>`;
    setNearbyPanelHasResults(false);
    return true;
}

async function fetchGpsNearbyPlaces() {
    if (!nearbyLocationsPanel || !nearbyLocationsList) {
        return;
    }

    const coords = lastKnownPosition?.coords;
    const lat = Number(coords?.latitude);
    const lon = Number(coords?.longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        if (!nearbyPanelHasResults) {
            gpsNearbyPlaces = [];
        }
        lastGpsNearbyBounds = null;
        renderNearbyPanelPlaceholder('ממתינים למיקום ה-GPS שלך כדי להציג מקומות קרובים.', {
            preserveExisting: nearbyPanelHasResults
        });
        setNearbyPanelVisible(true);
        updateState();
        return;
    }

    if (gpsPoiFetchAbortController) {
        gpsPoiFetchAbortController.abort();
    }

    const fetchContext = {
        lat,
        lon,
        radius: Number(NEARBY_PLACES_RADIUS_METERS)
    };

    lastGpsNearbyBounds = fetchContext;

    gpsPoiFetchAbortController = new AbortController();
    const signal = gpsPoiFetchAbortController.signal;

    isLoadingPois = true;
    updateState();

    try {
        const query = buildOverpassPlacesQuery(fetchContext);
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

        const places = collectPlacesFromOverpass(Array.isArray(data?.elements) ? data.elements : []);

        const prioritized = places
            .map((place) => {
                if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lon)) {
                    return null;
                }
                const distance = calculateDistanceMeters(lat, lon, place.lat, place.lon);
                if (!Number.isFinite(distance)) {
                    return null;
                }
                return { place, distance };
            })
            .filter(Boolean)
            .sort((a, b) => a.distance - b.distance)
            .map(({ place }) => place);

        if (prioritized.length > 0 || !nearbyPanelHasResults) {
            gpsNearbyPlaces = prioritized;
        }

        const hasRendered = renderNearbyLocationsPanel(fetchContext);
        if (hasRendered) {
            setNearbyPanelVisible(true);
        } else {
            renderNearbyPanelPlaceholder('לא נמצאו מקומות בקרבתך בטווח החיפוש.', {
                preserveExisting: nearbyPanelHasResults
            });
            setNearbyPanelVisible(true);
        }
    } catch (error) {
        if (error?.name === 'AbortError') {
            return;
        }
        console.error('Failed to fetch GPS nearby places', error);
        if (!nearbyPanelHasResults) {
            gpsNearbyPlaces = [];
        }
        renderNearbyPanelPlaceholder('לא הצלחנו לטעון מקומות בקרבתך. נסו שוב בעוד רגע.', {
            preserveExisting: nearbyPanelHasResults
        });
        setNearbyPanelVisible(true);
    } finally {
        if (gpsPoiFetchAbortController?.signal === signal) {
            gpsPoiFetchAbortController = null;
        }
        isLoadingPois = false;
        updateState();
    }
}

function renderNearbyLocationsPanel(referencePoint = lastGpsNearbyBounds) {
    if (!nearbyLocationsPanel || !nearbyLocationsList) {
        return false;
    }

    if (!Array.isArray(gpsNearbyPlaces) || gpsNearbyPlaces.length === 0) {
        renderNearbyPanelPlaceholder('לא נמצאו מקומות בקרבתך עדיין.', {
            preserveExisting: nearbyPanelHasResults
        });
        return nearbyPanelHasResults;
    }

    const fallbackCoords = lastKnownPosition?.coords;
    const referenceLat = Number(referencePoint?.lat ?? fallbackCoords?.latitude);
    const referenceLon = Number(referencePoint?.lon ?? fallbackCoords?.longitude);

    if (!Number.isFinite(referenceLat) || !Number.isFinite(referenceLon)) {
        renderNearbyPanelPlaceholder('לא ניתן לחשב מרחקים עבור המיקום הנוכחי.', {
            preserveExisting: nearbyPanelHasResults
        });
        return nearbyPanelHasResults;
    }

    const sorted = gpsNearbyPlaces
        .map((place) => {
            if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lon)) {
                return null;
            }

            const distance = calculateDistanceMeters(referenceLat, referenceLon, place.lat, place.lon);
            if (!Number.isFinite(distance)) {
                return null;
            }

            return { place, distance };
        })
        .filter(Boolean)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 10);

    if (sorted.length === 0) {
        renderNearbyPanelPlaceholder('לא נמצאו מקומות בקרבתך בטווח שנבחר.', {
            preserveExisting: nearbyPanelHasResults
        });
        return nearbyPanelHasResults;
    }

    const itemsHtml = sorted
        .map(({ place, distance }) => {
            const emoji = place?.category?.emoji || '📍';
            const distanceLabel = escapeHtml(formatDistanceLabel(distance));
            const locationId = escapeHtml(place.uid || `poi_${place.sourceType}_${place.id}`);
            const isActive = targetCoords
                && Math.abs(targetCoords.lat - place.lat) < 0.0001
                && Math.abs(targetCoords.lon - place.lon) < 0.0001;
            const activeClass = isActive ? ' nearby-panel__item--active' : '';

            return `<li class="nearby-panel__item${activeClass}" role="button" tabindex="0" data-location-id="${locationId}" aria-label="${escapeHtml(place.displayName)} (${distanceLabel})">
                <span class="nearby-panel__emoji" aria-hidden="true">${escapeHtml(emoji)}</span>
                <div class="nearby-panel__name">${escapeHtml(place.displayName)}</div>
                <span class="nearby-panel__distance">${distanceLabel}</span>
            </li>`;
        })
        .join('');

    if (nearbyLocationsList.innerHTML !== itemsHtml) {
        nearbyLocationsList.innerHTML = itemsHtml;
    }
    setNearbyPanelHasResults(true);
    return true;
}

function setNearbyPanelVisible(visible) {
    if (!nearbyLocationsPanel) {
        return;
    }

    const shouldShow = Boolean(visible);
    if (shouldShow === nearbyPanelVisible) {
        return;
    }

    if (shouldShow) {
        nearbyLocationsPanel.classList.remove('hidden');
        requestAnimationFrame(() => {
            nearbyLocationsPanel.classList.add('active');
        });
    } else {
        nearbyLocationsPanel.classList.remove('active');
        const handleTransitionEnd = (event) => {
            if (event.propertyName === 'opacity') {
                nearbyLocationsPanel.classList.add('hidden');
            }
        };
        nearbyLocationsPanel.addEventListener('transitionend', handleTransitionEnd, { once: true });
        if (!nearbyLocationsPanel.classList.contains('active')) {
            nearbyLocationsPanel.classList.add('hidden');
        }
    }

    syncNearbyPanelCollapsedClass();
    updateNearbyPanelToggleState();

    nearbyPanelVisible = shouldShow;
    updateState();
}

function handleNearbyListClick(event) {
    const item = event.target.closest('[data-location-id]');
    if (!item) {
        return;
    }

    event.preventDefault();
    activateNearbyItem(item.dataset.locationId);
}

function handleNearbyListKeyDown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') {
        return;
    }

    const item = event.target.closest('[data-location-id]');
    if (!item) {
        return;
    }

    event.preventDefault();
    activateNearbyItem(item.dataset.locationId);
}

function activateNearbyItem(locationId) {
    if (!locationId) {
        return;
    }

    const place = getPoiPlaceByUid(locationId);
    if (!place) {
        return;
    }

    const effectiveId = place.uid || `poi_${place.sourceType}_${place.id}`;
    selectLocation(place.lat, place.lon, place.displayName, effectiveId, { placeInfo: place });
    renderNearbyLocationsPanel();
}

function getPoiPlaceByUid(uid) {
    if (!uid) {
        return null;
    }

    const candidates = Array.isArray(gpsNearbyPlaces) && gpsNearbyPlaces.length > 0
        ? gpsNearbyPlaces
        : poiPlaces;

    if (!Array.isArray(candidates) || candidates.length === 0) {
        return null;
    }

    return candidates.find((place) => (place?.uid || `poi_${place?.sourceType}_${place?.id}`) === uid) || null;
}

function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
    if (map && typeof map.distance === 'function') {
        return map.distance([lat1, lon1], [lat2, lon2]);
    }

    const toRad = (value) => (value * Math.PI) / 180;
    const R = 6371000;
    const φ1 = toRad(lat1);
    const φ2 = toRad(lat2);
    const Δφ = toRad(lat2 - lat1);
    const Δλ = toRad(lon2 - lon1);

    const a = Math.sin(Δφ / 2) ** 2
        + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function formatDistanceLabel(distanceMeters) {
    if (!Number.isFinite(distanceMeters)) {
        return '---';
    }

    if (distanceMeters < 1000) {
        return `${Math.max(1, Math.round(distanceMeters))} מטר`;
    }

    const kilometers = distanceMeters / 1000;
    return `${kilometers.toFixed(2)} ק"מ`;
}

function celebrateSelection() {
    if (!confettiRoot) {
        return;
    }

    const colors = ['#38bdf8', '#818cf8', '#facc15', '#f97316', '#34d399'];
    const pieces = 28;
    const fragment = document.createDocumentFragment();

    for (let index = 0; index < pieces; index += 1) {
        const piece = document.createElement('span');
        piece.className = 'confetti-piece';
        piece.style.background = colors[index % colors.length];
        piece.style.left = `${Math.random() * 100}%`;
        piece.style.setProperty('--x-start', `${(Math.random() * 40 - 20).toFixed(2)}vw`);
        piece.style.setProperty('--x-end', `${(Math.random() * 60 - 30).toFixed(2)}vw`);
        piece.style.animationDuration = `${(1.6 + Math.random() * 0.9).toFixed(2)}s`;
        piece.style.animationDelay = `${(Math.random() * 0.15).toFixed(2)}s`;
        fragment.appendChild(piece);
        window.setTimeout(() => piece.remove(), 2800);
    }

    confettiRoot.appendChild(fragment);

    if (confettiTimeoutId) {
        clearTimeout(confettiTimeoutId);
    }

    confettiTimeoutId = window.setTimeout(() => {
        while (confettiRoot.firstChild) {
            confettiRoot.removeChild(confettiRoot.firstChild);
        }
        confettiTimeoutId = null;
        updateState();
    }, 3000);

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

    const sourceType = element.type || 'node';
    const uid = `poi_${sourceType}_${element.id}`;

    return {
        id: element.id,
        sourceType,
        uid,
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
    if (!searchBtn) {
        return;
    }

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

    celebrateSelection();
    renderNearbyLocationsPanel();
    setNearbyPanelVisible(true);

    if (isNearbyPanelCollapsible()) {
        setNearbyPanelCollapsed(true, { skipStateUpdate: true });
    }

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
    const addressLine = Array.isArray(placeInfo.addressLines) && placeInfo.addressLines.length > 0
        ? placeInfo.addressLines.join(', ')
        : '';

    const detailEntries = [];
    const normalizeLabel = (label) => typeof label === 'string'
        ? label.replace(/[:：]\s*$/, '').trim()
        : '';

    if (Array.isArray(placeInfo.infoLines)) {
        for (const info of placeInfo.infoLines) {
            if (info?.label && info?.value) {
                const normalizedLabel = normalizeLabel(info.label);
                detailEntries.push({ label: normalizedLabel, value: info.value });
            }
        }
    }

    const hasOpeningHours = detailEntries.some((entry) => entry.label === 'שעות פתיחה');
    if (placeInfo.openingHours && !hasOpeningHours) {
        detailEntries.push({ label: 'שעות פתיחה', value: placeInfo.openingHours });
    }

    if (placeInfo.phone && !detailEntries.some((entry) => entry.label === 'טלפון')) {
        detailEntries.push({ label: 'טלפון', value: placeInfo.phone });
    }

    const detailsHtml = detailEntries.length > 0
        ? `<div class="location-card__meta-grid">
                ${detailEntries
                    .map(({ label, value }) => `
                        <div class="location-card__meta-item">
                            <span class="location-card__meta-item-label">${escapeHtml(label)}:</span>
                            <span class="location-card__meta-item-value">${escapeHtml(value)}</span>
                        </div>
                    `)
                    .join('')}
            </div>`
        : '';

    let websiteHtml = '';
    const rawWebsiteLabel = typeof placeInfo.websiteLabel === 'string' && placeInfo.websiteLabel.trim()
        ? placeInfo.websiteLabel.trim()
        : placeInfo.website || '';
    const displayWebsite = rawWebsiteLabel.replace(/^https?:\/\//, '');
    if (placeInfo.website) {
        websiteHtml = `<a class="location-card__meta-link" href="${escapeHtml(placeInfo.website)}" target="_blank" rel="noopener">${escapeHtml(displayWebsite)}</a>`;
    } else if (displayWebsite) {
        websiteHtml = `<div class="location-card__meta-link location-card__meta-link--inactive">${escapeHtml(displayWebsite)}</div>`;
    }

    return `
        <section class="location-card__meta" aria-label="מידע על המקום הנבחר">
            <div class="location-card__meta-icon" aria-hidden="true">${escapeHtml(emoji)}</div>
            <div class="location-card__meta-body">
                <p class="location-card__meta-category">${escapeHtml(categoryLabel)}</p>
                ${addressLine ? `<p class="location-card__meta-address">${escapeHtml(addressLine)}</p>` : ''}
                ${detailsHtml}
                ${websiteHtml}
                <p class="location-card__meta-hint">הקהילה משתפת כאן זמני המתנה מעודכנים בזמן אמת לכל המבקרים.</p>
            </div>
        </section>
    `;
}

const WAIT_GROUP_CATEGORY_METADATA = Object.freeze({
    small: { key: 'small', label: 'קבוצות של 1-3', rangeLabel: '1-3', emoji: '👥', accent: '#22c55e' },
    medium: { key: 'medium', label: 'קבוצות של 4-6', rangeLabel: '4-6', emoji: '👨‍👩‍👧', accent: '#f59e0b' },
    large: { key: 'large', label: 'קבוצות של 7+', rangeLabel: '7+', emoji: '🎉', accent: '#ef4444' }
});

const RECENT_CHECKIN_WINDOW_MINUTES = 25;

const QUEUE_STATUS_LEVELS = Object.freeze([
    {
        key: 'empty',
        min: 0,
        max: 0,
        label: 'אין אנשים בתור',
        accent: '#16a34a',
        surface: 'rgba(22, 163, 74, 0.14)',
        text: '#14532d'
    },
    {
        key: 'light',
        min: 1,
        max: 3,
        label: 'תור קצר · 1-3 אנשים',
        accent: '#0ea5e9',
        surface: 'rgba(14, 165, 233, 0.14)',
        text: '#0f172a'
    },
    {
        key: 'medium',
        min: 4,
        max: 6,
        label: 'תור בינוני · 4-6 אנשים',
        accent: '#f59e0b',
        surface: 'rgba(245, 158, 11, 0.15)',
        text: '#78350f'
    },
    {
        key: 'busy',
        min: 7,
        max: Number.POSITIVE_INFINITY,
        label: 'תור עמוס · 7+ אנשים',
        accent: '#ef4444',
        surface: 'rgba(239, 68, 68, 0.14)',
        text: '#7f1d1d'
    }
]);

function computeRecentQueueSnapshot(visits, { windowMinutes = RECENT_CHECKIN_WINDOW_MINUTES } = {}) {
    const safeVisits = Array.isArray(visits) ? visits : [];
    const now = Date.now();
    const windowMs = Math.max(1, Number(windowMinutes) || 0) * 60 * 1000;

    let totalPeople = 0;
    let latestTimestamp = null;

    for (const visit of safeVisits) {
        if (!visit) continue;

        const timestamp = typeof visit.timestamp === 'string' ? visit.timestamp : null;
        if (!timestamp) {
            continue;
        }

        const visitTime = new Date(timestamp).getTime();
        if (!Number.isFinite(visitTime)) {
            continue;
        }

        if (windowMs > 0 && now - visitTime > windowMs) {
            continue;
        }

        const partyInfo = resolveVisitPartyInfo(visit);
        if (!partyInfo) {
            continue;
        }

        const normalizedSize = Math.max(0, Math.round(partyInfo.size || 0));
        totalPeople += normalizedSize;

        if (latestTimestamp === null || visitTime > latestTimestamp) {
            latestTimestamp = visitTime;
        }
    }

    if (totalPeople <= 0) {
        totalPeople = 0;
    }

    return {
        people: totalPeople,
        updatedAt: latestTimestamp ? new Date(latestTimestamp) : null
    };
}

function getQueueStatusLevel(peopleCount) {
    const normalized = Math.max(0, Math.round(Number(peopleCount) || 0));
    for (const level of QUEUE_STATUS_LEVELS) {
        if (normalized >= level.min && normalized <= level.max) {
            return { ...level, people: normalized };
        }
    }
    return { ...QUEUE_STATUS_LEVELS[QUEUE_STATUS_LEVELS.length - 1], people: normalized };
}

function formatPeopleCountLabel(count) {
    if (count <= 0) {
        return 'אין אנשים שממתינים כרגע';
    }
    if (count === 1) {
        return 'אדם אחד ממתין כרגע';
    }
    return `${count} אנשים ממתינים כרגע`;
}

function formatRelativeTimeFromNow(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        return '';
    }

    const diffMs = Date.now() - date.getTime();
    const diffMinutes = Math.round(diffMs / 60000);

    if (diffMinutes <= 0) {
        return 'הרגע';
    }
    if (diffMinutes === 1) {
        return 'דקה אחת';
    }
    if (diffMinutes < 60) {
        return `${diffMinutes} דקות`;
    }

    const diffHours = Math.round(diffMinutes / 60);
    if (diffHours === 1) {
        return 'שעה אחת';
    }
    if (diffHours < 24) {
        return `${diffHours} שעות`;
    }

    const diffDays = Math.round(diffHours / 24);
    if (diffDays === 1) {
        return 'יום אחד';
    }
    return `${diffDays} ימים`;
}

function renderQueueStatusSection(visits = []) {
    const snapshot = computeRecentQueueSnapshot(visits);
    const level = getQueueStatusLevel(snapshot.people);
    const peopleLabel = formatPeopleCountLabel(level.people);
    const updateHint = snapshot.updatedAt
        ? `עודכן לפני ${formatRelativeTimeFromNow(snapshot.updatedAt)}`
        : 'היו הראשונים לעדכן את מצב התור.';

    return `
        <section class="queue-status queue-status--${escapeHtml(level.key)}" style="--queue-status-accent: ${escapeHtml(level.accent)}; --queue-status-surface: ${escapeHtml(level.surface)}; --queue-status-text: ${escapeHtml(level.text)}" aria-label="מצב התור העדכני">
            <div class="queue-status__header">
                <span class="queue-status__indicator" aria-hidden="true"></span>
                <p class="queue-status__label">${escapeHtml(level.label)}</p>
            </div>
            <p class="queue-status__metric">${escapeHtml(peopleLabel)}</p>
            <p class="queue-status__hint">${escapeHtml(updateHint)}</p>
        </section>
    `;
}

function renderCurrentWaitSnapshot(latestVisit, waitGroupCounts = {}) {
    const latestWaitSeconds = Number(latestVisit?.waitSeconds);
    const waitLabel = latestWaitSeconds > 0 ? formatDurationWithUnits(latestWaitSeconds) : 'אין נתונים';

    const directPartyInfo = latestVisit ? resolveVisitPartyInfo(latestVisit) : null;
    const fallbackPartyInfo = directPartyInfo ? null : inferDominantWaitGroup(waitGroupCounts);
    const partyInfo = directPartyInfo || fallbackPartyInfo;

    if (!partyInfo && !(latestWaitSeconds > 0)) {
        return `
            <section class="wait-snapshot wait-snapshot--empty" aria-label="מצב התור העדכני">
                <div class="wait-snapshot__body">
                    <p class="wait-snapshot__title">עדיין אין נתוני תור זמינים</p>
                    <p class="wait-snapshot__metric">התחילו צ'ק-אין ראשון כדי לעדכן את זמן ההמתנה וכמות האנשים בתור.</p>
                </div>
            </section>
        `;
    }

    const category = partyInfo?.key && WAIT_GROUP_CATEGORY_METADATA[partyInfo.key]
        ? WAIT_GROUP_CATEGORY_METADATA[partyInfo.key]
        : null;
    const accentColor = category?.accent || '#2563eb';
    const peopleCount = partyInfo?.size ? Math.max(1, Math.round(partyInfo.size)) : 0;
    const peopleLabel = peopleCount > 0 ? `${peopleCount} אנשים` : 'אין נתונים';
    const title = category
        ? `קבוצת ${category.rangeLabel} ממתינה כעת`
        : 'מצב התור כעת';
    const badgeHtml = category
        ? `<span class="wait-snapshot__badge wait-snapshot__badge--${category.key}" aria-hidden="true">${escapeHtml(category.rangeLabel)}</span>`
        : '';

    return `
        <section class="wait-snapshot" style="--wait-snapshot-accent: ${escapeHtml(accentColor)}" aria-label="מצב התור העדכני">
            ${badgeHtml}
            <div class="wait-snapshot__body">
                <p class="wait-snapshot__title">${escapeHtml(title)}</p>
                <p class="wait-snapshot__metric"><span>זמן המתנה אחרון:</span> ${escapeHtml(waitLabel)}</p>
                <p class="wait-snapshot__metric"><span>אנשים בתור:</span> ${escapeHtml(peopleLabel)}</p>
            </div>
        </section>
    `;
}

function inferDominantWaitGroup(waitGroupCounts = {}) {
    let bestKey = null;
    let bestScore = -Infinity;

    for (const category of Object.values(WAIT_GROUP_CATEGORY_METADATA)) {
        const data = waitGroupCounts?.[category.key] || {};
        const people = Number(data.people) || 0;
        const groups = Number(data.groups) || 0;
        const score = people > 0 ? people : groups;

        if (score > bestScore) {
            bestScore = score;
            bestKey = category.key;
        }
    }

    if (!bestKey || bestScore <= 0) {
        return null;
    }

    const selected = waitGroupCounts[bestKey] || {};
    const estimatedPeople = Number(selected.people) > 0
        ? Number(selected.people)
        : (Number(selected.groups) || 0) * (PARTY_SIZE_ESTIMATES[bestKey] || 0);
    const fallbackSize = PARTY_SIZE_ESTIMATES[bestKey] || 0;
    const normalizedSize = estimatedPeople > 0 ? estimatedPeople : fallbackSize;

    return {
        key: bestKey,
        size: normalizedSize
    };
}

function renderWaitGroupsSection(waitGroupCounts = {}, latestVisit = null) {
    const categories = Object.values(WAIT_GROUP_CATEGORY_METADATA);

    const normalized = (key) => {
        const data = waitGroupCounts?.[key] || {};
        const rawUpdatedAt = data.updatedAt;
        let updatedAt = null;
        if (rawUpdatedAt instanceof Date && !Number.isNaN(rawUpdatedAt.getTime())) {
            updatedAt = rawUpdatedAt;
        } else if (typeof rawUpdatedAt === 'string') {
            const parsed = new Date(rawUpdatedAt);
            updatedAt = Number.isNaN(parsed.getTime()) ? null : parsed;
        }
        return {
            groups: Number.isFinite(Number(data.groups)) ? Number(data.groups) : 0,
            people: Number.isFinite(Number(data.people)) ? Number(data.people) : 0,
            updatedAt
        };
    };

    const activeKey = latestVisit ? resolveVisitPartyInfo(latestVisit)?.key || null : null;
    const totals = categories.map(({ key }) => normalized(key));
    const totalReports = totals.reduce((sum, entry) => sum + entry.groups, 0);

    const itemsHtml = categories
        .map(({ key, label, emoji, rangeLabel, accent }, index) => {
            const data = totals[index];
            const groups = Math.max(0, Math.round(data.groups));
            const people = Math.max(0, Math.round(data.people));
            const updateLabel = data.updatedAt ? formatRelativeTimeFromNow(data.updatedAt) : '';

            let primaryLabel;
            if (groups > 0) {
                primaryLabel = groups === 1 ? 'קבוצה אחת ממתינה' : `${groups} קבוצות ממתינות`;
            } else {
                primaryLabel = 'אין קבוצות ממתינות כרגע';
            }

            let secondaryLabel;
            if (groups > 0) {
                const peopleLabel = people > 0 ? `כ-${people} אנשים` : 'ללא הערכת אנשים';
                secondaryLabel = updateLabel ? `${peopleLabel} · עודכן לפני ${updateLabel}` : peopleLabel;
            } else {
                secondaryLabel = updateLabel ? `עודכן לפני ${updateLabel}` : 'היו הראשונים לעדכן';
            }

            if (activeKey === key && updateLabel) {
                secondaryLabel = `עודכן ממש עכשיו${people > 0 ? ` · כ-${people} אנשים` : ''}`;
            }

            return `<div class="wait-groups__item wait-groups__item--${key} ${activeKey === key ? 'wait-groups__item--active' : ''}" style="--wait-group-accent: ${escapeHtml(accent)}">
                <span class="wait-groups__emoji" aria-hidden="true">${escapeHtml(emoji)}</span>
                <div class="wait-groups__meta">
                    <p class="wait-groups__label">${escapeHtml(label)}</p>
                    <span class="wait-groups__range wait-groups__range--${key}">${escapeHtml(rangeLabel)}</span>
                    <p class="wait-groups__value">${escapeHtml(primaryLabel)}</p>
                    <p class="wait-groups__sub">${escapeHtml(secondaryLabel)}</p>
                </div>
            </div>`;
        })
        .join('');

    const hint = totalReports > 0
        ? 'הנתונים מבוססים על צ\'ק-אינים חיים מהדקות האחרונות ומציגים מי ממתין כרגע.'
        : 'אין כרגע צ\'ק-אינים פעילים בגודל קבוצה זה – היו הראשונים לעדכן.';

    return `
        <section class="wait-groups">
            <h4 class="wait-groups__title">מצב התור לפי גודל קבוצה</h4>
            <div class="wait-groups__grid">
                ${itemsHtml}
            </div>
            <p class="wait-groups__hint">${escapeHtml(hint)}</p>
        </section>
    `;
}

function renderGroupedHourlyHighlights(hourlyByGroup = {}, dayIndex, hourIndex) {
    const categories = Object.values(WAIT_GROUP_CATEGORY_METADATA);

    if (!categories.length) {
        return '';
    }

    const subtitle = `${DAY_NAMES_HE[dayIndex]} · ${formatHourLabel(hourIndex)}`;

    const cardsHtml = categories
        .map((category) => {
            const matrix = hourlyByGroup?.[category.key];
            const hourlyRow = Array.isArray(matrix?.[dayIndex]) ? matrix[dayIndex] : null;
            const value = Array.isArray(hourlyRow) ? hourlyRow[hourIndex] : null;
            const hasData = Number.isFinite(value) && value > 0;
            const display = hasData ? formatDurationWithUnits(value) : 'אין נתונים';
            const hint = hasData ? 'ממוצע לשעה זו' : 'היו הראשונים לעדכן';
            const emptyClass = hasData ? '' : ' is-empty';

            return `
                <div class="location-card__group-card location-card__group-card--${escapeHtml(category.key)}${emptyClass}">
                    <div class="location-card__group-card-label">
                        <span aria-hidden="true">${escapeHtml(category.emoji)}</span>
                        <span>${escapeHtml(category.label)}</span>
                    </div>
                    <p class="location-card__group-card-value">${escapeHtml(display)}</p>
                    <p class="location-card__group-card-hint">${escapeHtml(hint)}</p>
                </div>
            `;
        })
        .join('');

    return `
        <section class="location-card__group-averages" aria-label="ממוצע ההמתנה לפי גודל קבוצה">
            <h4 class="location-card__group-title">ממוצע ההמתנה לפי גודל קבוצה</h4>
            <p class="location-card__group-subtitle">${escapeHtml(subtitle)}</p>
            <div class="location-card__group-grid">${cardsHtml}</div>
        </section>
    `;
}

function renderGroupedWeeklyHighlights(weeklyByGroup = {}, dayIndex) {
    const categories = Object.values(WAIT_GROUP_CATEGORY_METADATA);

    if (!categories.length) {
        return '';
    }

    const dayLabel = DAY_NAMES_HE[dayIndex];

    const cardsHtml = categories
        .map((category) => {
            const weeklyValues = weeklyByGroup?.[category.key];
            const value = Array.isArray(weeklyValues) ? weeklyValues[dayIndex] : null;
            const hasData = Number.isFinite(value) && value > 0;
            const display = hasData ? formatDurationWithUnits(value) : 'אין נתונים';
            const hint = hasData ? 'ממוצע לכל היום' : 'מחכים לעדכון מהקהילה';
            const emptyClass = hasData ? '' : ' is-empty';

            return `
                <div class="location-card__group-card location-card__group-card--${escapeHtml(category.key)}${emptyClass}">
                    <div class="location-card__group-card-label">
                        <span aria-hidden="true">${escapeHtml(category.emoji)}</span>
                        <span>${escapeHtml(category.rangeLabel)}</span>
                    </div>
                    <p class="location-card__group-card-value">${escapeHtml(display)}</p>
                    <p class="location-card__group-card-hint">${escapeHtml(hint)}</p>
                </div>
            `;
        })
        .join('');

    return `
        <section class="location-card__group-weekly" aria-label="ממוצע יומי לפי גודל קבוצה">
            <h4 class="location-card__group-title">ממוצע יומי לפי גודל קבוצה</h4>
            <p class="location-card__group-subtitle">${escapeHtml(dayLabel)}</p>
            <div class="location-card__group-grid">${cardsHtml}</div>
        </section>
    `;
}

function showLocationCard(name, id) {
    if (!targetDetailsCard) return;
    const locationData = getLocationFromCache(id) || { id, name, totalCheckIns: 0, avgWaitSeconds: 0, visits: [], coords: sanitizeCoords(targetCoords), intel: null };

    const stats = computeLocationStats(locationData.visits, { liveQueue: locationData.liveQueue });
    const latestVisit = Array.isArray(locationData.visits) && locationData.visits.length > 0
        ? locationData.visits[0]
        : null;
    const hasIntel = hasIntelData(locationData.intel);
    const intelPreviewHtml = renderIntelPreviewHtml(locationData.intel, {
        emptyMessage: 'טרם נאספו תובנות למיקום זה. בצעו צ\'ק-אין ראשון כדי לקבל סקירה חכמה.',
        textClass: 'text-sm text-blue-900/90 leading-relaxed',
        summaryClass: 'text-sm text-blue-900/90 leading-relaxed',
        maxLength: 240
    });
    const placeInfoHtml = renderSelectedPlaceInfoSection(selectedPlaceInfo);
    const waitGroupsHtml = renderWaitGroupsSection(stats.waitGroupCounts, latestVisit);
    const intelSubtitle = hasIntel
        ? 'תובנות בזמן אמת לחוויה חלקה'
        : 'המידע יופיע כאן לאחר צ׳ק-אין מעודכן של הקהילה';
    const intelBodyContent = hasIntel
        ? `${intelPreviewHtml}
                <button type="button" class="open-intel-modal-btn intel-collapsible__action">פתח סקירה מלאה</button>`
        : '<p class="intel-collapsible__empty">טרם נאספו תובנות חכמות למיקום זה. ברגע שהקהילה תעדכן – המידע יופיע כאן.</p>';
    const intelSection = `
        <details class="location-card__intel intel-collapsible">
            <summary class="intel-collapsible__summary">
                <div class="intel-collapsible__summary-text">
                    <h4 class="intel-collapsible__title">סקירת יעד חכמה</h4>
                    <p class="intel-collapsible__subtitle">${escapeHtml(intelSubtitle)}</p>
                </div>
                <span class="intel-collapsible__chevron" aria-hidden="true"></span>
            </summary>
            <div class="intel-collapsible__body ${hasIntel ? 'intel-rich-text' : ''}">
                ${intelBodyContent}
            </div>
        </details>
    `;

    targetDetailsCard.innerHTML = `
        <section class="location-card" aria-label="פרטי המקום ${escapeHtml(name)}">
            <header class="location-card__header">
                <h3 class="location-card__title">${escapeHtml(name)}</h3>
                <div class="location-card__header-actions">
                    <button type="button" class="location-card__quick-checkin" aria-label="צ'ק-אין מידי למקום">צ'ק-אין</button>
                    <button id="close-location-card-btn" type="button" class="location-card__close" aria-label="סגירת חלון מידע">
                        <span aria-hidden="true">✕</span>
                    </button>
                </div>
            </header>
            ${placeInfoHtml}
            ${waitGroupsHtml}
            ${intelSection}
            <div class="location-card__actions">
                <button type="button" class="location-card__checkin-btn">צ'ק-אין למקום</button>
            </div>
        </section>
    `;

    const closeBtn = targetDetailsCard.querySelector('#close-location-card-btn');
    if (closeBtn) {
        closeBtn.addEventListener('click', hideLocationCard);
    }

    const quickCheckInBtn = targetDetailsCard.querySelector('.location-card__quick-checkin');
    if (quickCheckInBtn) {
        quickCheckInBtn.addEventListener('click', (event) => {
            event.preventDefault();
            startCheckIn();
        });
    }

    const primaryCheckInBtn = targetDetailsCard.querySelector('.location-card__checkin-btn');
    if (primaryCheckInBtn) {
        primaryCheckInBtn.addEventListener('click', (event) => {
            event.preventDefault();
            startCheckIn();
        });
    }

    const intelModalBtn = targetDetailsCard.querySelector('.open-intel-modal-btn');
    if (intelModalBtn) {
        intelModalBtn.addEventListener('click', () => {
            openIntelModal({ ...locationData, name });
        });
    }

    targetDetailsCard.classList.remove('float-in');
    void targetDetailsCard.offsetWidth;
    targetDetailsCard.classList.remove('translate-y-full');
    targetDetailsCard.classList.add('float-in');
    targetDetailsCard.setAttribute('aria-hidden', 'false');
}

// --- 4. Check-In Logic ---
async function startCheckIn(options = {}) {
    if (!targetCoords) {
        alert("אנא בחר מיקום תחילה.");
        return;
    }

    if (!options.skipPrompt) {
        try {
            const defaultKey = options.partySizeKey || pendingPartySizeSelectionKey || selectedPartySizeKey || 'small';
            const confirmedKey = await promptForPartySize(defaultKey);
            if (!confirmedKey) {
                return;
            }
            startCheckIn({ ...options, partySizeKey: confirmedKey, skipPrompt: true });
            return;
        } catch (error) {
            console.error('Failed to resolve party size prompt', error);
            return;
        }
    }

    const locationData = currentLocationId ? getLocationFromCache(currentLocationId) : null;
    const normalizedPartyKey = normalizePartySizeKey(options.partySizeKey || selectedPartySizeKey || 'small');
    selectedPartySizeKey = normalizedPartyKey;
    setPendingPartySizeSelectionKey(normalizedPartyKey);
    setSelectedPartySizeKey(normalizedPartyKey);
    activeWaitPartyKey = normalizedPartyKey;
    activeWaitLocationId = currentLocationId;

    if (activeWaitSessionId && activeWaitLocationId) {
        void releaseLiveQueueEntry(activeWaitLocationId, activeWaitSessionId, { silent: true, keepState: true });
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

    if (currentLocationId) {
        const baseData = {
            id: currentLocationId,
            name: targetName,
            coords: sanitizeCoords(targetCoords),
            visits: Array.isArray(locationData?.visits) ? locationData.visits : []
        };

        void registerLiveQueueEntry(currentLocationId, normalizedPartyKey, { baseData });
    }

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

    const releaseSessionId = activeWaitSessionId;
    const releaseLocationId = activeWaitLocationId || currentLocationId;
    if (releaseSessionId && releaseLocationId) {
        await releaseLiveQueueEntry(releaseLocationId, releaseSessionId);
    } else {
        clearActiveWaitSessionStorage();
    }

    const finalTimeDisplay = timerDisplay.textContent;

    if (saveData && checkInStartTime) {
        const elapsedSeconds = (Date.now() - checkInStartTime) / 1000;

        try {
            setWaitingScreenSavingState(true);
            await saveWaitTime(currentLocationId, targetName, targetCoords, elapsedSeconds, selectedPartySizeKey);

            recordRecentVisit({
                locationId: currentLocationId,
                name: targetName,
                waitSeconds: elapsedSeconds,
                completedAt: new Date(),
                coords: targetCoords,
                placeInfo: selectedPlaceInfo,
                partySizeKey: selectedPartySizeKey
            });

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

    scheduleViewportPlacesRefresh({ immediate: true });

    void fetchGpsNearbyPlaces();
    renderNearbyLocationsPanel();

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

    if (!nearbyPanelHasResults) {
        gpsNearbyPlaces = [];
    }
    lastGpsNearbyBounds = null;
    renderNearbyPanelPlaceholder('לא ניתן לקבל מיקום GPS. אפשרו גישה למיקום כדי להציג מקומות קרובים.', {
        preserveExisting: nearbyPanelHasResults
    });
    setNearbyPanelVisible(true);

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

async function saveWaitTime(id, name, coords, waitSeconds, partySizeKey = 'small') {
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

        const { data } = prepareCheckInUpdate(existingData, { waitSeconds, now, name, coords: normalizedCoords, partySizeKey });

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

function computeLocationStats(visits, options = {}) {
    const safeVisits = Array.isArray(visits) ? visits : [];
    const liveQueue = options?.liveQueue ?? null;
    const totals = Array.from({ length: DAY_NAMES_HE.length }, () => Array.from({ length: HOURS_PER_DAY }, () => 0));
    const counts = Array.from({ length: DAY_NAMES_HE.length }, () => Array.from({ length: HOURS_PER_DAY }, () => 0));

    const groupKeys = Object.keys(WAIT_GROUP_CATEGORY_METADATA);
    const totalsByGroup = {};
    const countsByGroup = {};

    for (const key of groupKeys) {
        totalsByGroup[key] = Array.from({ length: DAY_NAMES_HE.length }, () => Array.from({ length: HOURS_PER_DAY }, () => 0));
        countsByGroup[key] = Array.from({ length: DAY_NAMES_HE.length }, () => Array.from({ length: HOURS_PER_DAY }, () => 0));
    }

    for (const visit of safeVisits) {
        if (!visit || typeof visit !== 'object') continue;

        const dayIndex = Number.isInteger(visit.dayOfWeek) ? visit.dayOfWeek : null;
        const hourIndex = Number.isInteger(visit.hourOfDay) ? visit.hourOfDay : null;
        const waitSeconds = Number(visit.waitSeconds);

        const partyInfo = resolveVisitPartyInfo(visit);

        if (dayIndex === null || hourIndex === null) continue;
        if (dayIndex < 0 || dayIndex >= DAY_NAMES_HE.length) continue;
        if (hourIndex < 0 || hourIndex >= HOURS_PER_DAY) continue;
        if (!Number.isFinite(waitSeconds) || waitSeconds <= 0) continue;

        totals[dayIndex][hourIndex] += waitSeconds;
        counts[dayIndex][hourIndex] += 1;

        if (partyInfo && totalsByGroup[partyInfo.key]) {
            totalsByGroup[partyInfo.key][dayIndex][hourIndex] += waitSeconds;
            countsByGroup[partyInfo.key][dayIndex][hourIndex] += 1;
        }
    }

    const hourlyAverages = totals.map((dayTotals, dayIdx) =>
        dayTotals.map((total, hourIdx) => {
            const count = counts[dayIdx][hourIdx];
            return count > 0 ? total / count : null;
        })
    );

    const hourlyAveragesByGroup = groupKeys.reduce((acc, key) => {
        acc[key] = totalsByGroup[key].map((dayTotals, dayIdx) =>
            dayTotals.map((total, hourIdx) => {
                const count = countsByGroup[key][dayIdx][hourIdx];
                return count > 0 ? total / count : null;
            })
        );
        return acc;
    }, {});

    const weeklyAverages = totals.map((dayTotals, dayIdx) => {
        let total = 0;
        let count = 0;
        for (let hourIdx = 0; hourIdx < HOURS_PER_DAY; hourIdx += 1) {
            total += dayTotals[hourIdx];
            count += counts[dayIdx][hourIdx];
        }
        return count > 0 ? total / count : null;
    });

    const weeklyAveragesByGroup = groupKeys.reduce((acc, key) => {
        acc[key] = totalsByGroup[key].map((dayTotals, dayIdx) => {
            let total = 0;
            let count = 0;
            for (let hourIdx = 0; hourIdx < HOURS_PER_DAY; hourIdx += 1) {
                total += dayTotals[hourIdx];
                count += countsByGroup[key][dayIdx][hourIdx];
            }
            return count > 0 ? total / count : null;
        });
        return acc;
    }, {});

    const waitGroupCounts = computeCurrentWaitGroupCounts(safeVisits, { ...options, liveQueue });

    return { hourlyAverages, weeklyAverages, counts, waitGroupCounts, hourlyAveragesByGroup, weeklyAveragesByGroup };
}

const PARTY_SIZE_ESTIMATES = Object.freeze({
    small: 2,
    medium: 5,
    large: 8
});

function computeCurrentWaitGroupCounts(visits, { liveQueue = null } = {}) {
    const categories = Object.values(WAIT_GROUP_CATEGORY_METADATA);

    if (!Array.isArray(categories) || categories.length === 0) {
        return {};
    }

    const normalizedQueue = liveQueue ? normalizeLiveQueueRecord(liveQueue) : { entries: [], updatedAt: null };
    const queueEntries = Array.isArray(normalizedQueue.entries) ? normalizedQueue.entries : [];
    const queueUpdatedAtDate = normalizedQueue.updatedAt ? new Date(normalizedQueue.updatedAt) : null;
    const now = Date.now();
    const queueUpdatedAtMs = queueUpdatedAtDate ? queueUpdatedAtDate.getTime() : null;
    const queueIsStale = queueUpdatedAtMs !== null && (now - queueUpdatedAtMs > LIVE_QUEUE_STALE_MINUTES * 60 * 1000);
    const entryStaleThreshold = now - LIVE_QUEUE_ENTRY_STALE_MINUTES * 60 * 1000;

    return categories.reduce((acc, category) => {
        const bucket = {
            groups: 0,
            people: 0,
            updatedAt: queueUpdatedAtDate || null
        };

        if (!queueIsStale && queueEntries.length > 0) {
            for (const entry of queueEntries) {
                const entryCategory = normalizePartySizeKey(entry?.category);
                if (entryCategory !== category.key) {
                    continue;
                }

                const entryId = typeof entry?.id === 'string' ? entry.id.trim() : '';
                if (!entryId) {
                    continue;
                }

                const enteredAt = entry?.enteredAt ? new Date(entry.enteredAt) : null;
                if (enteredAt && enteredAt.getTime() < entryStaleThreshold) {
                    continue;
                }

                const sizeCandidate = Number(entry?.size);
                const estimatedPeople = Number.isFinite(sizeCandidate) && sizeCandidate > 0
                    ? sizeCandidate
                    : (WAIT_GROUP_CATEGORY_METADATA[entryCategory]?.estimate || 0);

                bucket.groups += 1;
                bucket.people += estimatedPeople;

                if (enteredAt && (!bucket.updatedAt || enteredAt > bucket.updatedAt)) {
                    bucket.updatedAt = enteredAt;
                }
            }
        }

        acc[category.key] = bucket;
        return acc;
    }, {});
}

function resolveVisitPartyInfo(visit) {
    const rawCategory = typeof visit?.partySizeCategory === 'string'
        ? visit.partySizeCategory.trim().toLowerCase()
        : null;
    const size = extractPartySizeValue(visit);
    const key = rawCategory && WAIT_GROUP_CATEGORY_METADATA[rawCategory]
        ? rawCategory
        : categorizePartySize(size);

    if (!key) {
        return null;
    }

    const effectiveSize = Number.isFinite(size) && size > 0
        ? size
        : PARTY_SIZE_ESTIMATES[key];

    return {
        key,
        size: effectiveSize
    };
}

function extractPartySizeValue(visit) {
    const candidates = [
        visit?.partySize,
        visit?.groupSize,
        visit?.peopleCount,
        visit?.people,
        visit?.size
    ];

    for (const candidate of candidates) {
        const numeric = Number(candidate);
        if (Number.isFinite(numeric) && numeric > 0) {
            return numeric;
        }
    }

    return null;
}

function categorizePartySize(size) {
    if (!Number.isFinite(size) || size <= 0) {
        return null;
    }

    if (size <= 3) {
        return 'small';
    }

    if (size <= 6) {
        return 'medium';
    }

    return 'large';
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

// --- 8. Recent Visits Tab ---


function normalizePlaceInfoForStorage(placeInfo) {
    if (!placeInfo || typeof placeInfo !== 'object') {
        return null;
    }

    const category = placeInfo?.category && typeof placeInfo.category === 'object'
        ? {
            emoji: typeof placeInfo.category.emoji === 'string' ? placeInfo.category.emoji : '',
            label: typeof placeInfo.category.label === 'string' ? placeInfo.category.label : ''
        }
        : null;

    const addressLines = Array.isArray(placeInfo.addressLines)
        ? placeInfo.addressLines.map((line) => (typeof line === 'string' ? line : '')).filter((line) => line.trim().length > 0)
        : [];

    const infoLines = Array.isArray(placeInfo.infoLines)
        ? placeInfo.infoLines
            .map((info) => {
                if (!info || typeof info !== 'object') {
                    return null;
                }
                const label = typeof info.label === 'string' ? info.label : '';
                const value = typeof info.value === 'string' ? info.value : '';
                if (!label.trim() || !value.trim()) {
                    return null;
                }
                return { label, value };
            })
            .filter(Boolean)
        : [];

    const website = typeof placeInfo.website === 'string' ? placeInfo.website : '';
    const websiteLabel = typeof placeInfo.websiteLabel === 'string' ? placeInfo.websiteLabel : '';
    const phone = typeof placeInfo.phone === 'string' ? placeInfo.phone : '';
    const openingHours = typeof placeInfo.openingHours === 'string' ? placeInfo.openingHours : '';
    const tags = placeInfo.tags && typeof placeInfo.tags === 'object' ? placeInfo.tags : null;

    if (
        !category?.emoji &&
        !category?.label &&
        addressLines.length === 0 &&
        infoLines.length === 0 &&
        !website &&
        !websiteLabel &&
        !phone &&
        !openingHours &&
        !tags
    ) {
        return null;
    }

    return {
        category: category?.emoji || category?.label ? category : null,
        addressLines,
        infoLines,
        website,
        websiteLabel,
        phone,
        openingHours,
        tags
    };
}

function normalizeRecentVisit(entry) {
    if (!entry || typeof entry !== 'object') {
        return null;
    }

    const waitSeconds = Number(entry.waitSeconds);
    if (!Number.isFinite(waitSeconds) || waitSeconds <= 0) {
        return null;
    }

    const locationId = typeof entry.locationId === 'string' ? entry.locationId : null;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';

    let completedAt;
    if (entry.completedAt instanceof Date && !Number.isNaN(entry.completedAt.getTime())) {
        completedAt = entry.completedAt.toISOString();
    } else if (typeof entry.completedAt === 'string') {
        const parsed = new Date(entry.completedAt);
        completedAt = Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }
    if (!completedAt) {
        completedAt = new Date().toISOString();
    }

    const coords = sanitizeCoords(entry.coords || entry.coordinates) || null;
    const partyKeyCandidate = typeof entry.partySizeKey === 'string' ? entry.partySizeKey.trim().toLowerCase() : '';
    const partySizeKey = partyKeyCandidate && WAIT_GROUP_CATEGORY_METADATA[partyKeyCandidate]
        ? partyKeyCandidate
        : null;

    const placeInfo = normalizePlaceInfoForStorage(entry.placeInfo);

    return {
        locationId,
        name,
        waitSeconds,
        completedAt,
        coords,
        placeInfo,
        partySizeKey
    };
}

function normalizeRecentVisitsArray(entries) {
    if (!Array.isArray(entries)) {
        return [];
    }

    const normalized = entries
        .map((entry) => normalizeRecentVisit(entry))
        .filter(Boolean);

    normalized.sort((a, b) => {
        const aTime = new Date(a.completedAt).getTime();
        const bTime = new Date(b.completedAt).getTime();
        return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
    });

    return normalized.slice(0, MAX_RECENT_VISITS);
}

function loadRecentVisitsFromStorage() {
    if (typeof window === 'undefined' || !window.localStorage) {
        return [];
    }

    try {
        const raw = window.localStorage.getItem(RECENT_VISITS_STORAGE_KEY);
        if (!raw) {
            return [];
        }
        const parsed = JSON.parse(raw);
        return normalizeRecentVisitsArray(Array.isArray(parsed) ? parsed : []);
    } catch (error) {
        console.warn('Failed to load recent visits from storage', error);
        return [];
    }
}

function persistRecentVisits(visitsToStore) {
    if (typeof window === 'undefined' || !window.localStorage) {
        return;
    }

    try {
        const payload = Array.isArray(visitsToStore) ? visitsToStore : [];
        window.localStorage.setItem(RECENT_VISITS_STORAGE_KEY, JSON.stringify(payload));
    } catch (error) {
        console.warn('Failed to persist recent visits', error);
    }
}

function setRecentVisits(nextVisits, { alreadyNormalized = false } = {}) {
    recentVisits = alreadyNormalized ? [...nextVisits] : normalizeRecentVisitsArray(nextVisits);
    persistRecentVisits(recentVisits);
    renderRecentVisits();
    updateState();
}

function recordRecentVisit(details) {
    const normalized = normalizeRecentVisit(details);
    if (!normalized) {
        return;
    }

    const existing = Array.isArray(recentVisits) ? recentVisits : [];
    const deduped = normalized.locationId
        ? existing.filter((visit) => visit.locationId !== normalized.locationId)
        : existing;

    const nextVisits = [normalized, ...deduped].slice(0, MAX_RECENT_VISITS);
    setRecentVisits(nextVisits, { alreadyNormalized: true });
}


function renderRecentVisits() {
    if (!recentVisitsList) return;

    if (!Array.isArray(recentVisits) || recentVisits.length === 0) {
        recentVisitsList.innerHTML = `<p class="text-gray-500 text-center">כשתסיימו צ'ק-אין – הביקור יופיע כאן.</p>`;
        return;
    }

    const sortedVisits = [...recentVisits].sort((a, b) => {
        const aTime = new Date(a?.completedAt || 0).getTime();
        const bTime = new Date(b?.completedAt || 0).getTime();
        return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
    });

    recentVisitsList.innerHTML = '';

    for (const visit of sortedVisits) {
        const locationId = typeof visit?.locationId === 'string' ? visit.locationId : null;
        const locationData = locationId ? getLocationFromCache(locationId) : null;
        const locationName = visit?.name && typeof visit.name === 'string'
            ? visit.name
            : locationData?.name || 'מיקום ללא שם';

        const waitSeconds = Number(visit?.waitSeconds);
        const waitLabel = waitSeconds > 0 ? formatDurationWithUnits(waitSeconds) : 'לא נמדד';

        const completedDate = visit?.completedAt ? new Date(visit.completedAt) : null;
        const completedLabel = formatTimestamp(visit?.completedAt);
        const relativeLabel = completedDate && !Number.isNaN(completedDate.getTime())
            ? formatRelativeTimeFromNow(completedDate)
            : null;

        const partyKey = typeof visit?.partySizeKey === 'string' ? visit.partySizeKey.trim().toLowerCase() : '';
        const partyMeta = partyKey && WAIT_GROUP_CATEGORY_METADATA[partyKey]
            ? WAIT_GROUP_CATEGORY_METADATA[partyKey]
            : null;
        const partyHtml = partyMeta
            ? `<p class="text-sm text-gray-600">גודל קבוצה: <span class="font-medium text-blue-600">${escapeHtml(partyMeta.rangeLabel)}</span></p>`
            : '';

        const coordsSource = visit?.coords || locationData?.coords || null;
        const rawLat = coordsSource?.lat ?? coordsSource?.latitude ?? null;
        const rawLon = coordsSource?.lon ?? coordsSource?.lng ?? coordsSource?.longitude ?? null;
        const lat = rawLat != null ? Number(rawLat) : null;
        const lon = rawLon != null ? Number(rawLon) : null;
        const canOpenLocation = Number.isFinite(lat) && Number.isFinite(lon);

        const hasIntel = hasIntelData(locationData?.intel);
        const intelButtonHtml = hasIntel
            ? `<button class="intel-details-btn text-sm font-semibold rounded-md px-3 py-2 transition bg-purple-600 text-white hover:bg-purple-700">סקירת יעד</button>`
            : `<button class="intel-details-btn text-sm font-semibold rounded-md px-3 py-2 transition bg-gray-100 text-gray-400 cursor-not-allowed" disabled>סקירת יעד</button>`;

        const gotoButtonClass = canOpenLocation
            ? 'goto-location-btn text-sm bg-blue-100 text-blue-700 font-semibold py-2 px-3 rounded-md hover:bg-blue-200 transition'
            : 'goto-location-btn text-sm bg-gray-100 text-gray-400 font-semibold py-2 px-3 rounded-md cursor-not-allowed';
        const gotoButtonAttrs = canOpenLocation ? '' : 'disabled';

        const renameButtonHtml = locationId
            ? `<button type="button" class="rename-location-btn text-sm bg-amber-100 text-amber-700 font-semibold py-2 px-3 rounded-md hover:bg-amber-200 transition">שינוי שם</button>`
            : '';

        const stats = locationData
            ? computeLocationStats(locationData.visits, { liveQueue: locationData.liveQueue })
            : { waitGroupCounts: {} };
        const latestVisit = locationData?.visits?.[0] || null;
        const waitSnapshotHtml = locationData ? renderCurrentWaitSnapshot(latestVisit, stats.waitGroupCounts) : '';
        const queueStatusHtml = locationData ? renderQueueStatusSection(locationData.visits) : '';
        const waitGroupsHtml = locationData ? renderWaitGroupsSection(stats.waitGroupCounts, latestVisit) : '';
        const placeInfoHtml = renderSelectedPlaceInfoSection(visit?.placeInfo || null);

        const detailsSections = [placeInfoHtml]
            .filter((section) => typeof section === 'string' && section.trim().length > 0);
        const detailsHtml = detailsSections.length > 0
            ? detailsSections.join('\n')
            : '<p class="text-sm text-gray-500">אין עדיין פרטים נוספים להצגה למיקום זה.</p>';

        const relativeHtml = relativeLabel
            ? `<p class="text-xs text-gray-500">נשמר לפני ${escapeHtml(relativeLabel)}</p>`
            : '';

        const cardClasses = [
            'bg-white',
            'p-4',
            'rounded-lg',
            'shadow-md',
            'border',
            'transition',
            'focus:outline-none',
            'focus:ring-2',
            'focus:ring-blue-500'
        ];
        if (canOpenLocation) {
            cardClasses.push('cursor-pointer');
        }

        const el = document.createElement('div');
        el.className = cardClasses.join(' ');
        el.setAttribute('tabindex', '0');
        el.setAttribute('role', 'button');
        el.innerHTML = `
            <div class="flex flex-col gap-3">
                <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                    <div class="space-y-2">
                        <h3 class="font-semibold text-lg text-gray-800">${escapeHtml(locationName)}</h3>
                        <p class="text-sm text-gray-600">זמן ההמתנה שלך: <span class="font-medium text-blue-600">${escapeHtml(waitLabel)}</span></p>
                        ${partyHtml}
                        <p class="text-xs text-gray-500">הושלם ב-${escapeHtml(completedLabel)}</p>
                        ${relativeHtml}
                    </div>
                    <div class="flex items-center gap-2 self-start flex-wrap">
                        ${intelButtonHtml}
                        <button class="toggle-details-btn text-sm bg-gray-100 text-gray-700 font-semibold py-2 px-3 rounded-md hover:bg-gray-200 transition" aria-expanded="false">הצג פרטים</button>
                        ${renameButtonHtml}
                        <button class="${gotoButtonClass}" ${gotoButtonAttrs}>עבור למיקום</button>
                    </div>
                </div>
                <div class="recent-visit-details hidden space-y-3">
                    ${detailsHtml}
                </div>
            </div>
        `;

        const openLocation = () => {
            if (!canOpenLocation) {
                return;
            }
            const latNum = Number(lat);
            const lonNum = Number(lon);
            if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
                return;
            }
            selectLocation(latNum, lonNum, locationName, locationId || null);
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
            if ((event.key === 'Enter' || event.key === ' ') && canOpenLocation) {
                event.preventDefault();
                openLocation();
            }
        });

        const gotoBtn = el.querySelector('.goto-location-btn');
        if (gotoBtn && canOpenLocation) {
            gotoBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                openLocation();
            });
        }

        const intelBtn = el.querySelector('.intel-details-btn');
        if (intelBtn && hasIntel) {
            intelBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                openIntelModal({ ...locationData, id: locationId || locationData?.id });
            });
        }

        const renameBtn = el.querySelector('.rename-location-btn');
        if (renameBtn && locationId) {
            renameBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                openRenameLocationModal(locationId);
            });
        }

        const detailsEl = el.querySelector('.recent-visit-details');
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

        recentVisitsList.appendChild(el);
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

    setPartySizeButtonsDisabled(isSaving);
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
