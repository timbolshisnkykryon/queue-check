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
        gpsStatusBtn,
        allLocationsList,
        waitingLocationName,
        timerDisplay,
        waitingDistance,
        waitingBearing,
        gpsCountdownEl,
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

    const POPUP_VISIBILITY_ATTEMPT_KEY = '__queueCheckPopupEnsureAttempts';
    const DEFAULT_VISIBILITY_PADDING = Object.freeze({
        top: 32,
        bottom: 40,
        left: 16,
        right: 16
    });

    function updateState() {
        Object.assign(state, {
            map,
            userMarker,
            targetMarker,
            targetCircle,
            targetCoords,
            targetName,
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
    searchBtn.addEventListener('click', handleSearchLocation);
    locationNameInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleSearchLocation();
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

    visitedLocationsLayer = L.layerGroup().addTo(map);

    // Add zoom control to bottom-right
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // Set target on map click
    map.on('click', (e) => {
        const { lat, lng } = e.latlng;
        targetName = `מיקום (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
        locationNameInput.value = targetName;
        selectLocation(lat, lng, targetName);
    });

    renderVisitedLocationsOnMap();

    updateState();
}

async function handleSearchLocation() {
    const query = locationNameInput.value;
    if (!query) return;

    searchBtn.disabled = true;
    searchBtn.innerHTML = '<div class="spinner w-5 h-5 border-2 rounded-full"></div>';

    try {
        // Use Nominatim for free geocoding
        const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`);
        if (!response.ok) throw new Error('Network response was not ok');

        const data = await response.json();

        if (data && data.length > 0) {
            const { lat, lon, display_name } = data[0];
            targetName = display_name;
            locationNameInput.value = targetName;
            selectLocation(parseFloat(lat), parseFloat(lon), targetName);
        } else {
            alert('לא נמצאו תוצאות עבור החיפוש.');
        }
    } catch (error) {
        console.error('Error searching location:', error);
        alert('אירעה שגיאה בחיפוש המיקום.');
    } finally {
        searchBtn.disabled = false;
        searchBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clip-rule="evenodd" /></svg>`;
    }

    renderVisitedLocationsOnMap();
    updateState();
}

function selectLocation(lat, lon, name, id = null) {
    if (map) {
        map.closePopup();
    }
    targetCoords = { lat, lon };
    targetName = name;

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

function showLocationCard(name, id) {
    if (!targetDetailsCard) return;
    const locationData = getLocationFromCache(id) || { id, name, totalCheckIns: 0, avgWaitSeconds: 0, visits: [], coords: sanitizeCoords(targetCoords), intel: null };

    const avgTimeDisplay = locationData.totalCheckIns > 0
        ? formatDurationWithUnits(locationData.avgWaitSeconds)
        : "אין עדיין מידע";

    const stats = computeLocationStats(locationData.visits);
    const { dayIndex, hourIndex } = getCurrentTimeContext();
    const todaysHourly = stats.hourlyAverages?.[dayIndex] || [];
    const currentHourStats = getCurrentHourStats(todaysHourly, hourIndex);
    const hourlyChartHtml = renderHourlyChart(todaysHourly, hourIndex, {
        variant: 'app',
        emptyMessage: 'אין עדיין נתונים לשעות היום במיקום זה.'
    });
    const weeklySummaryHtml = renderWeeklySummary(stats.weeklyAverages, dayIndex, {
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

    targetDetailsCard.innerHTML = `
        <div class="flex items-start justify-between gap-3 mb-2">
            <h3 class="font-bold text-lg text-gray-900">${name}</h3>
            <button id="close-location-card-btn" type="button" class="w-8 h-8 flex items-center justify-center rounded-full bg-blue-100 text-blue-700 text-lg font-semibold leading-none hover:bg-blue-200 transition" aria-label="סגירת חלון מידע" title="סגירה">
                ×
            </button>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm mb-4">
            <div class="bg-gray-50 rounded-lg p-3 text-gray-600">
                <div class="font-semibold text-gray-700">זמן המתנה ממוצע</div>
                <div class="text-blue-600 font-semibold">${avgTimeDisplay}</div>
            </div>
            <div class="bg-gray-50 rounded-lg p-3 text-gray-600">
                <div class="font-semibold text-gray-700">סה"כ צ'ק-אינים</div>
                <div class="text-blue-600 font-semibold">${locationData.totalCheckIns}</div>
            </div>
            <div class="bg-blue-50 rounded-lg p-3 text-blue-900 sm:col-span-2">
                <div class="font-semibold">שעה נוכחית (${DAY_NAMES_HE[dayIndex]} · ${formatHourLabel(hourIndex)})</div>
                <div>${currentHourStats.label}</div>
            </div>
        </div>
        <div class="bg-white border border-blue-100 rounded-lg p-3 mb-4">
            <h4 class="text-sm font-semibold text-gray-700">ממוצע לפי שעה (היום)</h4>
            ${hourlyChartHtml}
        </div>
        <div class="bg-white border border-gray-200 rounded-lg p-3 mb-4">
            <h4 class="text-sm font-semibold text-gray-700">מבט שבועי</h4>
            ${weeklySummaryHtml}
        </div>
        <div class="bg-blue-50 border border-blue-100 rounded-lg p-4 mb-4">
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
        <button id="start-check-in-btn" class="w-full bg-green-600 text-white font-bold py-3 px-4 rounded-md hover:bg-green-700 transition">
            התחל צ'ק-אין למקום
        </button>
    `;

    // Add event listener to the new button
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
    if (!checkInStartTime) {
        gpsCountdownEl.textContent = "";
        return;
    }

    let secondsLeft = 5; // 5 second timeout

    const updateCountdown = () => {
        if (!checkInStartTime) { // Check if check-in was cancelled
             clearInterval(gpsCountdownInterval);
             gpsCountdownEl.textContent = "";
             return;
        }

        const sinceLastUpdate = (Date.now() - lastGpsTime) / 1000;
        secondsLeft = Math.max(0, 5 - sinceLastUpdate);

        gpsCountdownEl.textContent = `(עדכון בעוד ${secondsLeft.toFixed(0)} ש')`;

        if (secondsLeft <= 0) {
            clearInterval(gpsCountdownInterval);
            gpsCountdownEl.textContent = "(ממתין לעדכון...)";
        }
    };

    updateCountdown(); // Run immediately
    gpsCountdownInterval = setInterval(updateCountdown, 500);

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

function applyVisitedLocationPopupOptions(popup, popupOptions = {}) {
    if (!popup || !popupOptions) {
        return;
    }

    if (Number.isFinite(popupOptions.maxWidth)) {
        popup.options.maxWidth = popupOptions.maxWidth;
    }

    if (Number.isFinite(popupOptions.minWidth)) {
        popup.options.minWidth = popupOptions.minWidth;
    }

    if (popupOptions.autoPanPadding) {
        popup.options.autoPanPadding = popupOptions.autoPanPadding;
    }

    if (popupOptions.autoPanPaddingTopLeft) {
        popup.options.autoPanPaddingTopLeft = popupOptions.autoPanPaddingTopLeft;
    }

    if (popupOptions.autoPanPaddingBottomRight) {
        popup.options.autoPanPaddingBottomRight = popupOptions.autoPanPaddingBottomRight;
    }

    popup.__queueCheckVisibilityPadding = popupOptions.visibilityPadding || DEFAULT_VISIBILITY_PADDING;
}

function resetPopupVisibilityAttempts(popup) {
    if (!popup) {
        return;
    }

    if (Object.prototype.hasOwnProperty.call(popup, POPUP_VISIBILITY_ATTEMPT_KEY)) {
        delete popup[POPUP_VISIBILITY_ATTEMPT_KEY];
    }
}

function ensurePopupVisible(popup, popupOptions = null) {
    if (!popup || !map) {
        return;
    }

    const attempts = popup[POPUP_VISIBILITY_ATTEMPT_KEY] ?? 0;
    if (attempts > 3) {
        resetPopupVisibilityAttempts(popup);
        return;
    }

    const schedule = (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function')
        ? window.requestAnimationFrame.bind(window)
        : (fn) => setTimeout(fn, 16);

    schedule(() => {
        const popupElement = typeof popup.getElement === 'function' ? popup.getElement() : popup._container;
        const container = mapContainer && typeof mapContainer.getBoundingClientRect === 'function'
            ? mapContainer
            : (typeof map.getContainer === 'function' ? map.getContainer() : null);

        if (!popupElement || !container) {
            return;
        }

        const mapRect = container.getBoundingClientRect();
        const popupRect = popupElement.getBoundingClientRect();

        if (!mapRect || !popupRect) {
            return;
        }

        const padding = (popupOptions && popupOptions.visibilityPadding)
            || popup.__queueCheckVisibilityPadding
            || DEFAULT_VISIBILITY_PADDING;

        const leftBound = mapRect.left + (padding.left ?? DEFAULT_VISIBILITY_PADDING.left);
        const rightBound = mapRect.right - (padding.right ?? DEFAULT_VISIBILITY_PADDING.right);
        const topBound = mapRect.top + (padding.top ?? DEFAULT_VISIBILITY_PADDING.top);
        const bottomBound = mapRect.bottom - (padding.bottom ?? DEFAULT_VISIBILITY_PADDING.bottom);

        let offsetX = 0;
        if (popupRect.left < leftBound) {
            offsetX = leftBound - popupRect.left;
        } else if (popupRect.right > rightBound) {
            offsetX = -(popupRect.right - rightBound);
        }

        let offsetY = 0;
        if (popupRect.top < topBound) {
            offsetY = topBound - popupRect.top;
        } else if (popupRect.bottom > bottomBound) {
            offsetY = -(popupRect.bottom - bottomBound);
        }

        if (offsetX !== 0 || offsetY !== 0) {
            popup[POPUP_VISIBILITY_ATTEMPT_KEY] = attempts + 1;
            map.panBy([offsetX, offsetY], {
                animate: true,
                duration: 0.35,
                easeLinearity: 0.25,
                noMoveStart: true
            });

            map.once('moveend', () => ensurePopupVisible(popup, popupOptions));
        } else if (attempts > 0) {
            resetPopupVisibilityAttempts(popup);
        }
    });
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

        let popupOptions = getVisitedLocationPopupOptions();
        let lastPopupOptions = popupOptions;
        const popupContent = buildVisitedLocationPopupContent(locationDetails, popupOptions);

        marker.bindTooltip(locationName, {
            permanent: true,
            direction: 'top',
            offset: [0, -4],
            opacity: 1,
            className: 'map-location-label'
        });

        const popupConfig = {
            maxWidth: popupOptions.maxWidth,
            minWidth: popupOptions.minWidth,
            autoPan: true,
            closeButton: true,
            className: 'visited-location-popup'
        };

        if (popupOptions.autoPanPadding) {
            popupConfig.autoPanPadding = popupOptions.autoPanPadding;
        }

        if (popupOptions.autoPanPaddingTopLeft) {
            popupConfig.autoPanPaddingTopLeft = popupOptions.autoPanPaddingTopLeft;
        }

        if (popupOptions.autoPanPaddingBottomRight) {
            popupConfig.autoPanPaddingBottomRight = popupOptions.autoPanPaddingBottomRight;
        }

        marker.bindPopup(popupContent, popupConfig);

        const initialPopup = marker.getPopup();
        if (initialPopup) {
            applyVisitedLocationPopupOptions(initialPopup, popupOptions);
        }

        marker.on('click', () => {
            if (locationNameInput) {
                locationNameInput.value = locationName;
            }
            selectLocation(lat, lon, locationName, id);

            const popup = marker.getPopup();
            if (popup) {
                popupOptions = getVisitedLocationPopupOptions();
                lastPopupOptions = popupOptions;
                applyVisitedLocationPopupOptions(popup, popupOptions);
                popup.setContent(buildVisitedLocationPopupContent(locationDetails, popupOptions));
                popup.update();
                resetPopupVisibilityAttempts(popup);
            }

            marker.openPopup();
        });

        marker.on('popupopen', (event) => {
            const popup = event?.popup || marker.getPopup();
            if (!popup) {
                return;
            }

            const optionsForVisibility = lastPopupOptions || popupOptions || getVisitedLocationPopupOptions();
            ensurePopupVisible(popup, optionsForVisibility);
        });

        marker.on('popupclose', (event) => {
            const popup = event?.popup || marker.getPopup();
            resetPopupVisibilityAttempts(popup);
        });
    }

    updateState();
}

function getVisitedLocationPopupOptions() {
    const fallbackOptions = {
        maxWidth: 240,
        minWidth: 180,
        maxHeight: 280,
        autoPanPadding: createLeafletPoint(24, 36),
        autoPanPaddingTopLeft: createLeafletPoint(24, 36),
        autoPanPaddingBottomRight: createLeafletPoint(24, 36),
        visibilityPadding: DEFAULT_VISIBILITY_PADDING
    };

    if (!map || typeof map.getSize !== 'function') {
        return fallbackOptions;
    }

    const mapSize = map.getSize();
    const mapWidth = Number.isFinite(mapSize?.x) && mapSize.x > 0 ? mapSize.x : 0;
    const mapHeight = Number.isFinite(mapSize?.y) && mapSize.y > 0 ? mapSize.y : 0;

    if (mapWidth <= 0 || mapHeight <= 0) {
        return fallbackOptions;
    }

    const safeAreaTop = getSafeAreaInset('top');
    const safeAreaBottom = getSafeAreaInset('bottom');
    const headerHeight = getElementHeightIfVisible(mainHeader);
    const navHeight = getElementHeightIfVisible(tabNavigation);
    const searchHeight = getElementHeightIfVisible(mapSearchBar);
    const gpsButtonHeight = getElementHeightIfVisible(gpsStatusBtn);
    const targetCardVisible = targetDetailsCard && targetDetailsCard.getAttribute('aria-hidden') === 'false';
    const targetCardHeight = targetCardVisible ? getElementHeightIfVisible(targetDetailsCard) : 0;

    const topOverlayHeight = safeAreaTop + headerHeight + navHeight + searchHeight;
    const bottomOverlayHeight = safeAreaBottom + gpsButtonHeight + targetCardHeight;

    const horizontalPadding = Math.max(18, Math.floor(mapWidth * 0.08));
    const visibilityTop = Math.max(28, Math.round(topOverlayHeight + 16));
    const visibilityBottom = Math.max(32, Math.round(bottomOverlayHeight + 20));

    const baselineMaxHeight = Math.max(160, Math.floor(mapHeight * 0.55));
    let availableHeight = mapHeight - (visibilityTop + visibilityBottom) - 32;
    if (!Number.isFinite(availableHeight)) {
        availableHeight = baselineMaxHeight;
    }

    const minReasonableHeight = Math.max(160, Math.floor(mapHeight * 0.35));
    if (Number.isFinite(availableHeight) && availableHeight > 0) {
        availableHeight = Math.max(minReasonableHeight, Math.floor(availableHeight));
    } else {
        availableHeight = minReasonableHeight;
    }

    const maxHeight = Math.min(Math.max(minReasonableHeight, availableHeight), Math.min(baselineMaxHeight, 420));

    const maxWidth = Math.max(200, Math.min(Math.floor(mapWidth * 0.5), 360));
    const minWidth = Math.min(Math.max(180, Math.floor(mapWidth * 0.36)), maxWidth);

    const maxPanPadding = Math.max(56, Math.floor(mapHeight * 0.8));
    const topPanPadding = Math.min(
        maxPanPadding,
        Math.max(Math.floor(mapHeight * 0.24), visibilityTop + Math.ceil(maxHeight * 0.6))
    );
    const bottomPanPadding = Math.min(
        maxPanPadding,
        Math.max(Math.floor(mapHeight * 0.2), visibilityBottom + Math.ceil(maxHeight * 0.4))
    );

    const autoPanPaddingTopLeft = createLeafletPoint(horizontalPadding, topPanPadding);
    const autoPanPaddingBottomRight = createLeafletPoint(horizontalPadding, bottomPanPadding);
    const autoPanPadding = createLeafletPoint(horizontalPadding, Math.max(topPanPadding, bottomPanPadding));

    return {
        maxWidth,
        minWidth,
        maxHeight,
        autoPanPadding,
        autoPanPaddingTopLeft,
        autoPanPaddingBottomRight,
        visibilityPadding: {
            top: visibilityTop,
            bottom: visibilityBottom,
            left: horizontalPadding,
            right: horizontalPadding
        }
    };
}

function buildVisitedLocationPopupContent(locationData, popupOptions = {}) {
    const totalCheckIns = Number.isFinite(Number(locationData.totalCheckIns))
        ? Number(locationData.totalCheckIns)
        : 0;

    const avgWaitSeconds = Number.isFinite(Number(locationData.avgWaitSeconds)) && Number(locationData.avgWaitSeconds) > 0
        ? Number(locationData.avgWaitSeconds)
        : null;

    const lastVisitAt = locationData.lastVisitAt || null;

    const totalCheckInsText = totalCheckIns > 0
        ? totalCheckIns.toLocaleString('he-IL')
        : '—';

    const avgWaitText = avgWaitSeconds
        ? formatDuration(avgWaitSeconds)
        : 'לא זמין';

    const lastVisitText = lastVisitAt
        ? formatTimestamp(lastVisitAt)
        : 'לא נרשם';

    const styleAttributes = [];
    if (popupOptions.minWidth) {
        styleAttributes.push(`min-width:${popupOptions.minWidth}px`);
    }
    if (popupOptions.maxWidth) {
        styleAttributes.push(`max-width:${popupOptions.maxWidth}px`);
    }
    if (popupOptions.maxHeight) {
        styleAttributes.push(`max-height:${popupOptions.maxHeight}px`);
        styleAttributes.push('overflow-y:auto');
    }

    const styleAttribute = styleAttributes.length > 0
        ? ` style="${styleAttributes.join(';')}"`
        : '';

    return `
        <div class="visited-location-popup__content"${styleAttribute}>
            <h3 class="visited-location-popup__title">${escapeHtml(locationData.name || 'מיקום ללא שם')}</h3>
            <dl class="visited-location-popup__stats">
                <div>
                    <dt>סה"כ ביקורים</dt>
                    <dd>${escapeHtml(totalCheckInsText)}</dd>
                </div>
                <div>
                    <dt>המתנה ממוצעת</dt>
                    <dd>${escapeHtml(avgWaitText)}</dd>
                </div>
                <div>
                    <dt>ביקור אחרון</dt>
                    <dd>${escapeHtml(lastVisitText)}</dd>
                </div>
            </dl>
        </div>
    `;
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
    if (miniMap) {
        miniMap.remove();
        miniMap = null;
    }
    if (!targetCoords) return;

    try {
        if (!miniMapEl) return;

        miniMapEl.innerHTML = ''; // Clear any error messages

        miniMap = L.map('mini-map', { 
            zoomControl: false, 
            scrollWheelZoom: false,
            dragging: false,
            touchZoom: false,
            doubleClickZoom: false
        }).setView([targetCoords.lat, targetCoords.lon], 17);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(miniMap);
        miniMapTargetMarker = L.marker([targetCoords.lat, targetCoords.lon]).addTo(miniMap);

        // If user location is already known, add it
        if (lastKnownPosition) {
            const userLatLng = L.latLng(lastKnownPosition.coords.latitude, lastKnownPosition.coords.longitude);
            miniMapUserMarker = L.marker(userLatLng, { icon: userIcon }).addTo(miniMap);
            miniMap.fitBounds(L.latLngBounds(userLatLng, [targetCoords.lat, targetCoords.lon]), { padding: [20, 20], maxZoom: 17 });
        }

        // Fix for grey map bug
        miniMap.invalidateSize(); 

    } catch (e) {
        console.error("Error initializing mini-map:", e);
        if (miniMapEl) {
            miniMapEl.innerHTML = '<p class="text-red-500 p-2 text-center">שגיאה בטעינת המפה.</p>';
        }
    }

    updateState();
}

function destroyMiniMap() {
    if (miniMap) {
        miniMap.remove();
        miniMap = null;
    }
    miniMapTargetMarker = null;
    miniMapUserMarker = null;

    updateState();
}

// --- Run Initialization ---
initApp();

}
