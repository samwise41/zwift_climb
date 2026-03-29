// ==========================================
// DEV MODE TOGGLE (Set to false for Production)
// ==========================================
const DEV_MODE = true; 

window.addEventListener('beforeunload', function (e) {
    if (startTime) { e.preventDefault(); e.returnValue = ''; }
});

function openHelp() {
    document.getElementById('helpModal').style.display = 'block';
    document.getElementById('modalBackdrop').style.display = 'block';
}
function closeHelp() {
    document.getElementById('helpModal').style.display = 'none';
    document.getElementById('modalBackdrop').style.display = 'none';
}

const safeStorage = {
    set: function(key, val) { try { window.localStorage.setItem(key, val); } catch(e) {} },
    get: function(key) { try { return window.localStorage.getItem(key); } catch(e) { return null; } },
    remove: function(key) { try { window.localStorage.removeItem(key); } catch(e) {} }
};

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

function toggleSettings() {
    const box = document.getElementById('data-settings-box');
    const btn = document.getElementById('toggleSettingsBtn');
    if (box.style.display === 'none') {
        box.style.display = 'flex';
        btn.innerHTML = '▼ Hide Settings';
    } else {
        box.style.display = 'none';
        btn.innerHTML = '▶ Show Settings';
    }
}

// --- Cockpit Mode Toggle ---
function toggleCockpitMode() {
    isCockpitMode = !isCockpitMode;
    const body = document.body;
    const btn = document.getElementById('cockpitToggleBtn');
    
    if (isCockpitMode) {
        body.classList.add('cockpit-mode');
        btn.innerHTML = '❌ Exit Cockpit';
        btn.style.position = 'fixed';
        btn.style.top = '10px';
        btn.style.right = '10px';
        btn.style.zIndex = '10000';
    } else {
        body.classList.remove('cockpit-mode');
        btn.innerHTML = '🚀 Cockpit';
        btn.style.position = 'static';
        // Force list re-render to put the action buttons back into the list
        if(isDataLoaded) renderList(); 
    }
    
    // Immediately render the dynamic cockpit segment action if ride is ready
    if (isCockpitMode && isDataLoaded) {
        renderActionDiv(currentActiveIndex);
    }
}

// --- Initialization & Caching ---
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
        
        // Add "Custom Route" option
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

        // CACHE CHECK: If we have a saved route, load it instantly!
        const cachedDataStr = safeStorage.get('pacer_cache_data');
        if (cachedDataStr) {
            const cachedData = JSON.parse(cachedDataStr);
            // Find the index of the cached climb to set the dropdown correctly
            const climbIndex = climbsConfig.findIndex(c => c.name === cachedData.climbName);
            if (climbIndex !== -1) {
                selectEl.value = climbIndex;
                currentClimb = climbsConfig[climbIndex];
                
                // Handle UI visibility based on what was cached
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
                return; // Exit early so we don't load the default skeleton
            }
        }
        
        // If no cache, load default
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

// --- Data Fetching Router ---
function processDataRequest() {
    if (currentClimb.id === "custom") {
        parseGPXFile();
    } else {
        fetchUserData();
    }
}

// --- 1. Strava Fetch Engine ---
async function fetchUserData() {
    if (!stravaAccessToken || !currentClimb) return;

    const statusEl = document.getElementById('strava-status');
    statusEl.innerText = `⏳ Searching Strava...`;
    statusEl.style.display = 'inline-block';
    statusEl.classList.remove("ahead", "behind"); 

    if (DEV_MODE) {
        setTimeout(() => {
            let dummySegments = [];
            let defaultTotalSecs = parseTimeToSeconds(currentClimb.defaultTime);
            let avgSecsPerSegment = Math.round(defaultTotalSecs / currentClimb.subSegments.length);

            for (let i = 0; i < currentClimb.subSegments.length; i++) {
                let mockSegSec = avgSecsPerSegment + (Math.floor(Math.random() * 30) - 15);
                let mockWatts = 210 + Math.floor(Math.random() * 60); 
                dummySegments.push({ name: currentClimb.subSegments[i], prevSegSec: mockSegSec, prevWatts: mockWatts, targetCumSec: null, targetPower: null });
            }
            saveAndLoadData(dummySegments, "DEV MODE Data Loaded");
        }, 600); 
        return;
    }

    const attemptType = document.getElementById('attemptSelect').value;
    const fetchLimit = attemptType === 'best' ? 50 : 1;

    try {
        const effortsRes = await fetch(`https://www.strava.com/api/v3/segment_efforts?segment_id=${currentClimb.id}&per_page=${fetchLimit}`, {
            headers: { 'Authorization': `Bearer ${stravaAccessToken}` }
        });
        
        // RATE LIMIT FALLBACK HANDLING
        if (effortsRes.status === 429) {
            statusEl.innerHTML = `⚠️ Strava Limit Reached. Use Custom Route (GPX) mode. <a href="https://www.strava.com/athlete/training" target="_blank" style="color:white; text-decoration:underline;">Export GPX here</a>`;
            statusEl.classList.add("behind");
            return;
        }
        
        let effortsData = await effortsRes.json();

        if (effortsData.message === "Authorization Error" || effortsRes.status === 401) {
            safeStorage.remove('strava_token'); 
            statusEl.innerText = `❌ Session expired.`;
            statusEl.classList.add("behind");
            document.getElementById('strava-btn').style.display = 'inline-block';
            return;
        }

        if (!effortsData || effortsData.length === 0 || effortsData.errors) {
            statusEl.innerText = `❌ No efforts found.`;
            statusEl.classList.add("behind");
            return;
        }

        if (attemptType === 'best') effortsData.sort((a, b) => a.elapsed_time - b.elapsed_time);

        const targetEffort = effortsData[0];
        statusEl.innerText = `⏳ Loading full activity...`;

        const activityRes = await fetch(`https://www.strava.com/api/v3/activities/${targetEffort.activity.id}`, {
            headers: { 'Authorization': `Bearer ${stravaAccessToken}` }
        });
        
        if (activityRes.status === 429) {
            statusEl.innerHTML = `⚠️ Strava Limit Reached. Use GPX Fallback.`;
            statusEl.classList.add("behind");
            return;
        }

        const activityData = await activityRes.json();
        let personalizedSegments = [];
        let missingSegments = [];

        for (let targetName of currentClimb.subSegments) {
            const regex = new RegExp("\\b" + targetName + "(?:\\b|\\s|$)", "i");
            const match = activityData.segment_efforts.find(seg => regex.test(seg.name));
            if (match) {
                personalizedSegments.push({ name: targetName, prevSegSec: match.elapsed_time, prevWatts: Math.round(match.average_watts || 0), targetCumSec: null, targetPower: null });
            } else {
                missingSegments.push(targetName);
            }
        }

        if (missingSegments.length === 0) {
            saveAndLoadData(personalizedSegments, "PR Loaded!");
        } else {
            console.warn("Missing:", missingSegments);
            statusEl.innerText = `⚠️ Missing ${missingSegments.length} hairpins.`;
            statusEl.classList.add("behind");
        }
    } catch (error) {
        console.error(error);
        statusEl.innerText = "❌ Connection Error";
        statusEl.classList.add("behind");
    }
}

// --- 2. GPX Parser Engine (The Fallback) ---
function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
    const R = 6371; 
    const dLat = (lat2-lat1) * (Math.PI/180);
    const dLon = (lon2-lon1) * (Math.PI/180); 
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * (Math.PI/180)) * Math.cos(lat2 * (Math.PI/180)) * Math.sin(dLon/2) * Math.sin(dLon/2); 
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
    return R * c; 
}

function parseGPXFile() {
    const fileInput = document.getElementById('gpxInput');
    const intervalKm = parseFloat(document.getElementById('splitIntervalKm').value) || 1.0;
    const statusEl = document.getElementById('strava-status');
    
    if (!fileInput.files || fileInput.files.length === 0) {
        statusEl.innerText = "⚠️ Please select a GPX file first.";
        statusEl.style.display = 'inline-block';
        statusEl.className = "status-text behind";
        return;
    }

    statusEl.innerText = "⏳ Parsing GPX...";
    statusEl.style.display = 'inline-block';
    statusEl.className = "status-text";

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(e.target.result, "text/xml");
            const trkpts = xmlDoc.getElementsByTagName("trkpt");
            
            if (trkpts.length === 0) throw new Error("No trackpoints found in GPX.");

            let generatedSegments = [];
            let currentSegmentStartIdx = 0;
            let currentSegmentWattsSum = 0;
            let currentSegmentWattsCount = 0;
            
            let cumulativeKm = 0;
            let targetNextSplitKm = intervalKm;
            
            let startPointTime = new Date(trkpts[0].getElementsByTagName("time")[0].textContent).getTime();

            for (let i = 1; i < trkpts.length; i++) {
                let lat1 = parseFloat(trkpts[i-1].getAttribute("lat"));
                let lon1 = parseFloat(trkpts[i-1].getAttribute("lon"));
                let lat2 = parseFloat(trkpts[i].getAttribute("lat"));
                let lon2 = parseFloat(trkpts[i].getAttribute("lon"));
                
                cumulativeKm += getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2);
                
                // Extract Power (usually in extensions -> power)
                let ext = trkpts[i].getElementsByTagName("extensions")[0];
                if (ext) {
                    let pwrNode = ext.getElementsByTagName("power")[0];
                    if (pwrNode) {
                        currentSegmentWattsSum += parseInt(pwrNode.textContent);
                        currentSegmentWattsCount++;
                    }
                }

                // Check if we hit the distance interval split!
                if (cumulativeKm >= targetNextSplitKm || i === trkpts.length - 1) {
                    let endPointTime = new Date(trkpts[i].getElementsByTagName("time")[0].textContent).getTime();
                    let segSecs = Math.round((endPointTime - startPointTime) / 1000);
                    let avgWatts = currentSegmentWattsCount > 0 ? Math.round(currentSegmentWattsSum / currentSegmentWattsCount) : 0;
                    
                    let splitNum = generatedSegments.length + 1;
                    let segName = i === trkpts.length - 1 ? "Finish" : `Km ${targetNextSplitKm.toFixed(1)}`;

                    generatedSegments.push({
                        name: segName,
                        prevSegSec: segSecs,
                        prevWatts: avgWatts,
                        targetCumSec: null, targetPower: null
                    });

                    // Reset for next chunk
                    startPointTime = endPointTime;
                    currentSegmentWattsSum = 0;
                    currentSegmentWattsCount = 0;
                    targetNextSplitKm += intervalKm;
                }
            }

            saveAndLoadData(generatedSegments, "GPX Parsed Successfully!");

        } catch (err) {
            console.error(err);
            statusEl.innerText = "❌ Error reading GPX format.";
            statusEl.className = "status-text behind";
        }
    };
    reader.readAsText(fileInput.files[0]);
}

// --- Success Handler & Cache Saver ---
function saveAndLoadData(segmentDataArray, successMsg) {
    baseSegments = segmentDataArray; 
    isDataLoaded = true; 
    
    document.getElementById('startBtn').disabled = false;
    document.getElementById('data-settings-box').style.display = 'none'; 
    document.getElementById('toggleSettingsBtn').innerHTML = '▶ Show Settings';
    
    const statusEl = document.getElementById('strava-status');
    statusEl.innerText = `✓ ${successMsg}`;
    statusEl.className = "status-text ahead";

    applyNewTarget(); // Calculate targets first

    // Save to Cache
    const cacheObject = {
        climbName: currentClimb.name,
        targetTimeStr: document.getElementById('targetTimeInput').value,
        baseSegments: baseSegments
    };
    safeStorage.set('pacer_cache_data', JSON.stringify(cacheObject));
}


// --- Pacing Calculator Logic ---
function parseTimeToSeconds(timeStr) {
    if(!timeStr) return 0;
    const parts = timeStr.split(':');
    if (parts.length === 2) {
        return (parseInt(parts[0]) || 0) * 60 + (parseInt(parts[1]) || 0);
    }
    return (parseInt(parts[0]) || 0) * 60;
}

function formatTime(totalSeconds) {
    if (totalSeconds === null || totalSeconds === undefined || isNaN(totalSeconds)) return "--:--";
    const absSec = Math.abs(Math.round(totalSeconds));
    const m = Math.floor(absSec / 60).toString().padStart(2, '0');
    const s = (absSec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}

function updateMainDelta(delta) {
    const el = document.getElementById('main-delta');
    if (delta === null) {
        el.textContent = "";
        el.className = "";
        return;
    }
    if (delta >= 0) {
        el.textContent = `-${formatTime(delta)}`;
        el.className = "ahead";
    } else {
        el.textContent = `+${formatTime(Math.abs(delta))}`;
        el.className = "behind";
    }
}

function applyNewTarget() {
    if (!isDataLoaded) {
        renderList(); 
        return;
    }

    const targetSeconds = parseTimeToSeconds(document.getElementById('targetTimeInput').value);
    if (targetSeconds <= 0) return; 

    const sliderVal = parseInt(document.getElementById('splitSlider').value) / 100;
    const historicalTotal = baseSegments.reduce((sum, s) => sum + s.prevSegSec, 0);
    const baseRatio = targetSeconds / historicalTotal;

    let tempSegments = baseSegments.map((seg, i) => {
        const position = (i / (baseSegments.length - 1)) * 2 - 1;
        const splitMultiplier = 1 + (position * sliderVal);
        return { ...seg, rawScaledSec: seg.prevSegSec * baseRatio * splitMultiplier };
    });

    const rawTotalTime = tempSegments.reduce((sum, s) => sum + s.rawScaledSec, 0);
    const correctionFactor = targetSeconds / rawTotalTime;

    let cumulativeSec = 0;
    activeSegments = tempSegments.map(seg => {
        const finalSegSec = Math.round(seg.rawScaledSec * correctionFactor);
        cumulativeSec += finalSegSec;
        
        const timeRatio = finalSegSec / seg.prevSegSec;
        const newPower = Math.round(seg.prevWatts * (1 / timeRatio));

        return { ...seg, targetCumSec: cumulativeSec, targetPower: newPower };
    });

    document.getElementById('title-text').innerText = `${currentClimb.name} (${formatTime(targetSeconds)})`;
    ha