export function getElements() {
    const elements = {
        mainScreen: document.getElementById('main-screen'),
        waitingScreen: document.getElementById('waiting-screen'),
        onboardingModal: document.getElementById('onboarding-modal'),
        targetDetailsCard: document.getElementById('target-details-card'),
        liveStatusPill: document.getElementById('live-status-pill'),
        liveStatusText: document.getElementById('live-status-text'),
        mainHeader: document.getElementById('main-header'),
        tabNavigation: document.getElementById('tab-navigation'),
        mapSearchBar: document.getElementById('map-search-bar'),
        mapContainer: document.getElementById('map'),
        searchBtn: document.getElementById('search-btn'),
        locationNameInput: document.getElementById('location-name-input'),
        gpsStatusBtn: document.getElementById('gps-status-btn'),
        allLocationsList: document.getElementById('all-locations-list'),
        waitingLocationName: document.getElementById('waiting-location-name'),
        timerDisplay: document.getElementById('timer-display'),
        waitingDistance: document.getElementById('waiting-distance'),
        waitingBearing: document.getElementById('waiting-bearing'),
        gpsCountdownEl: document.getElementById('gps-countdown-el'),
        infoLoading: document.getElementById('info-loading'),
        infoResult: document.getElementById('info-result'),
        infoSources: document.getElementById('info-sources'),
        infoErrorEl: document.getElementById('info-error'),
        cancelCheckInBtn: document.getElementById('cancel-check-in-btn'),
        manualFinishBtn: document.getElementById('manual-finish-btn'),
        waitingSyncIndicator: document.getElementById('waiting-sync-indicator'),
        successMessage: document.getElementById('success-message'),
        successTime: document.getElementById('success-time'),
        closeSuccessBtn: document.getElementById('close-success-btn'),
        arrivalConfirmationModal: document.getElementById('arrival-confirmation-modal'),
        confirmArrivalBtn: document.getElementById('confirm-arrival-btn'),
        denyArrivalBtn: document.getElementById('deny-arrival-btn'),
        intelModal: document.getElementById('intel-modal'),
        intelModalCloseBtn: document.getElementById('intel-modal-close-btn'),
        intelModalTitle: document.getElementById('intel-modal-title'),
        intelModalBody: document.getElementById('intel-modal-body'),
        intelModalSources: document.getElementById('intel-modal-sources'),
        renameLocationModal: document.getElementById('rename-location-modal'),
        renameLocationForm: document.getElementById('rename-location-form'),
        renameLocationInput: document.getElementById('rename-location-input'),
        renameLocationError: document.getElementById('rename-location-error'),
        renameLocationCancelBtn: document.getElementById('rename-location-cancel-btn'),
        renameLocationSaveBtn: document.getElementById('rename-location-save-btn'),
        renameLocationCloseBtn: document.getElementById('rename-location-close-btn'),
        tabContainers: Array.from(document.querySelectorAll('.tab-content')),
        tabButtons: Array.from(document.querySelectorAll('.tab-btn'))
    };

    if (elements.targetDetailsCard) {
        elements.targetDetailsCard.setAttribute('aria-hidden', 'true');
    }

    return elements;
}
