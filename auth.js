// --- Auth Gatekeeper (Triggered by Button Click) ---
function startStravaAuth() {
    if (DEV_MODE) {
        initAuth(); // Boot up fake UI instantly
    } else {
        // Safe redirect to real API endpoint
        window.top.location.href = "/api/auth";
    }
}

// --- Auth & Persistence Logic ---
function initAuth() {
    // DEV MODE BYPASS
    if (DEV_MODE) {
        stravaAccessToken = "DEV_MODE_ACTIVE";
        document.getElementById('strava-btn').style.display = 'none';
        document.getElementById('settings-container').style.display = 'block';
        document.getElementById('data-settings-box').style.display = 'flex'; 
        document.getElementById('toggleSettingsBtn').innerHTML = '▼ Hide Settings';
        return;
    }

    let urlToken = null;
    try {
        const urlParams = new URLSearchParams(window.location.search);
        urlToken = urlParams.get('access_token') || urlParams.get('code') || urlParams.get('token'); 
    } catch(e) {}

    if (!urlToken) {
        try {
            const parentParams = new URLSearchParams(window.parent.location.search);
            urlToken = parentParams.get('access_token') || parentParams.get('code') || parentParams.get('token');
        } catch(e) {}
    }

    if (urlToken) {
        stravaAccessToken = urlToken;
        const expiryTime = Date.now() + (5.5 * 60 * 60 * 1000); 
        safeStorage.set('strava_token', urlToken);
        safeStorage.set('strava_expiry', expiryTime.toString());
        try { window.history.replaceState({}, document.title, window.location.pathname); } catch(e) {}
    } else {
        const storedToken = safeStorage.get('strava_token');
        const storedExpiry = safeStorage.get('strava_expiry');
        if (storedToken && storedExpiry && Date.now() < parseInt(storedExpiry)) {
            stravaAccessToken = storedToken;
        } else {
            safeStorage.remove('strava_token');
            safeStorage.remove('strava_expiry');
        }
    }

    if (stravaAccessToken) {
        document.getElementById('strava-btn').style.display = 'none';
        document.getElementById('settings-container').style.display = 'block';
        document.getElementById('data-settings-box').style.display = 'flex'; 
        document.getElementById('toggleSettingsBtn').innerHTML = '▼ Hide Settings';
    } else {
        document.getElementById('strava-btn').style.display = 'inline-block';
        document.getElementById('settings-container').style.display = 'none';
    }
}
