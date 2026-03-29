// ==========================================
// js/state.js - Core State & Authentication
// ==========================================
const DEV_MODE = false; 

const safeStorage = {
    set: function(key, val) { try { window.localStorage.setItem(key, val); } catch(e) {} },
    get: function(key) { try { return window.localStorage.getItem(key); } catch(e) { return null; } },
    remove: function(key) { try { window.localStorage.removeItem(key); } catch(e) {} }
};

// --- Global State Variables ---
let stravaAccessToken = null;
let climbsConfig = [];
let currentClimb = null;
let isDataLoaded = false;
let isCockpitMode = false;

let baseSegments = [];
let activeSegments = [];
let startTime = null;
let timerInterval = null;
let currentActiveIndex = 0;

let actualCumSecData = [];
let trendData = [];
let currentSegTimeData = [];
let currentSegWattsData = [];

let pacingTrendChart, comparisonChart;

// --- Auth & Initialization ---
function startStravaAuth() {
    if (DEV_MODE) {
        initAuth(); 
    } else {
        window.top.location.href = "/api/auth";
    }
}

function initAuth() {
    if (DEV_MODE) stravaAccessToken = "DEV_MODE_ACTIVE";
    
    let urlToken = null;
    try {
        const urlParams = new URLSearchParams(window.location.search);
        urlToken = urlParams.get('access_token') || urlParams.get('code') || urlParams.get('token'); 
    } catch(e) {}

    if (urlToken) {
        stravaAccessToken = urlToken;
        safeStorage.set('strava_token', urlToken);
        safeStorage.set('strava_expiry', (Date.now() + (5.5 * 60 * 60 * 1000)).toString());
        try { window.history.replaceState({}, document.title, window.location.pathname); } catch(e) {}
    } else if (!stravaAccessToken) {
        const storedToken = safeStorage.get('strava_token');
        const storedExpiry = safeStorage.get('strava_expiry');
        if (storedToken && storedExpiry && Date.now() < parseInt(storedExpiry)) {
            stravaAccessToken = storedToken;
        }
    }

    if (stravaAccessToken) {
        document.getElementById('strava-btn').style.display = 'none';
        document.getElementById('settings-container').style.display = 'block';
        document.getElementById('data-settings-box').style.display = 'flex'; 
    }
}

async function loadSegmentsConfig() {
    try {
        const res = await fetch('./segments.json?t=' + Date.now());
        climbsConfig = await res.json();
        climbsConfig.push({ name: "Other / Custom Route (GPX)", id: "custom", defaultTime: "01:00", subSegments: [] });

        const selectEl = document.getElementById('climbSelect');
        climbsConfig.forEach((climb, index) => {
            const opt = document.createElement('option');
            opt.value = index;
            opt.textContent = climb.name;
            selectEl.appendChild(opt);
        });

        selectEl.addEventListener('change', (e) => {
            const selected = climbsConfig[e.target.value];
            if (selected.id === "custom") {
                document.getElementById('gpx-upload-zone').style.display = 'flex';
                document.getElementById('strava-fetch-row').style.display = 'none';
            } else {
                document.getElementById('gpx-upload-zone').style.display = 'none';
                document.getElementById('strava-fetch-row').style.display = 'flex';
            }
            loadClimbSkeleton(selected);
        });

        const cachedDataStr = safeStorage.get('pacer_cache_data');
        if (cachedDataStr) {
            const cachedData = JSON.parse(cachedDataStr);
            const climbIndex = climbsConfig.findIndex(c => c.name === cachedData.climbName);
            if (climbIndex !== -1) {
                selectEl.value = climbIndex;
                currentClimb = climbsConfig[climbIndex];
                
                if (currentClimb.id === "custom") {
                    document.getElementById('gpx-upload-zone').style.display = 'flex';
                    document.getElementById('strava-fetch-row').style.display = 'none';
                }

                document.getElementById('title-text').innerText = `${currentClimb.name} Pacer`;
                document.getElementById('targetTimeInput').value = cachedData.targetTimeStr;
                
                baseSegments = cachedData.baseSegments;
                isDataLoaded = true;
                
                document.getElementById('startBtn').disabled = false;
                document.getElementById('data-settings-box').style.display = 'none'; 
                document.getElementById('toggleSettingsBtn').innerHTML = '▶ Show Settings';
                
                const statusEl = document.getElementById('strava-status');
                statusEl.innerText = `✓ Cached PR Loaded!`;
                statusEl.style.display = 'inline-block';
                statusEl.className = "status-text ahead";
                
                applyNewTarget();
                return;
            }
        }
        
        if(climbsConfig.length > 0) loadClimbSkeleton(climbsConfig[0]);
        
    } catch (e) {
        console.error("Config Error:", e);
    }
}

function loadClimbSkeleton(climb) {
    currentClimb = climb;
    isDataLoaded = false;
    document.getElementById('title-text').innerText = `${climb.name} Pacer`;
    document.getElementById('targetTimeInput').value = climb.defaultTime;
    document.getElementById('startBtn').disabled = true;
    document.getElementById('strava-status').style.display = 'none';
    
    baseSegments = climb.subSegments.map(name => ({
        name: name, targetCumSec: null, targetPower: null, prevSegSec: null, prevWatts: null
    }));
    
    applyNewTarget(); 
}

function clearCacheAndReset() {
    safeStorage.remove('pacer_cache_data');
    alert("Cache cleared. Ready to fetch new data.");
    loadClimbSkeleton(currentClimb);
    document.getElementById('data-settings-box').style.display = 'flex'; 
}
