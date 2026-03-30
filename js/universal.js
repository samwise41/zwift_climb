// ==========================================
// js/universal.js - Strava Streams Slicer
// ==========================================

const DEV_MODE = false;

// Universal Route Database (Add Strava IDs here!)
const universalRoutes = [
    { id: 16669530, name: "Epic KOM" },
    { id: 16425130, name: "Volcano Circuit CCW" },
    { id: 21343975, name: "Titans Grove KOM" },
    { id: 37033150, name: "The Grade" },
    { id: 16425133, name: "Innsbruck KOM" }
];


// --- Safe Storage Wrapper (Fixes the Storage Error) ---
const safeStorage = {
    set: function(key, val) { try { window.localStorage.setItem(key, val); } catch(e) { console.warn("Storage blocked"); } },
    get: function(key) { try { return window.localStorage.getItem(key); } catch(e) { return null; } },
    remove: function(key) { try { window.localStorage.removeItem(key); } catch(e) {} }
};

let stravaAccessToken = null;
let baseSegments = [];
let activeSegments = [];
let isDataLoaded = false;
let currentRouteName = "Universal Route";

let startTime = null;
let timerInterval = null;
let currentActiveIndex = 0;
let actualCumSecData = [];

// --- Auth Gatekeeper ---
function startStravaAuth() {
    if (DEV_MODE) {
        initAuth(); 
    } else {
        window.top.location.href = "/api/auth";
    }
}

function initAuth() {
    if (DEV_MODE) {
        stravaAccessToken = "DEV_MODE_ACTIVE";
        showApp();
        return;
    }

    let urlToken = null;
    try {
        const urlParams = new URLSearchParams(window.location.search);
        urlToken = urlParams.get('access_token') || urlParams.get('code') || urlParams.get('token'); 
    } catch(e) {}

    if (urlToken) {
        stravaAccessToken = urlToken;
        safeStorage.set('strava_token', urlToken);
        try { window.history.replaceState({}, document.title, window.location.pathname); } catch(e) {}
    } else {
        stravaAccessToken = safeStorage.get('strava_token');
    }

    if (stravaAccessToken) {
        showApp();
    } else {
        const btn = document.getElementById('strava-btn');
        if (btn) btn.style.display = 'inline-block';
        const container = document.getElementById('settings-container');
        if (container) container.style.display = 'none';
    }
}

function showApp() {
    const btn = document.getElementById('strava-btn');
    if (btn) btn.style.display = 'none';
    const container = document.getElementById('settings-container');
    if (container) container.style.display = 'block';
    
    const selectEl = document.getElementById('routeSelect');
    if (selectEl) {
        selectEl.innerHTML = ''; 
        universalRoutes.forEach(route => {
            const opt = document.createElement('option');
            opt.value = route.id;
            opt.textContent = route.name;
            selectEl.appendChild(opt);
        });
    }
}

// --- Fetch & Slicer Engine (Verbose & Safe) ---
async function fetchAndSliceStravaData() {
    const selectEl = document.getElementById('routeSelect');
    const segmentId = selectEl.value;
    currentRouteName = selectEl.options[selectEl.selectedIndex].text;
    
    const sliceIntervalKm = parseFloat(document.getElementById('sliceSelect').value);
    const attemptType = document.getElementById('attemptSelect').value;
    
    const statusEl = document.getElementById('strava-status');
    const dateDisplayEl = document.getElementById('effort-date-display');
    
    if (statusEl) {
        statusEl.innerText = "⏳ Step 1: Requesting data from Strava...";
        statusEl.className = "status-text";
        statusEl.style.display = 'inline-block';
    }
    
    // Defensive check: only update style if the element actually exists
    if (dateDisplayEl) {
        dateDisplayEl.style.display = 'none';
    }

    const fetchLimit = attemptType === 'best' ? 200 : 1;

    try {
        console.log(`Fetching segment efforts for ID: ${segmentId}`);

        const effortsRes = await fetch(`https://www.strava.com/api/v3/segment_efforts?segment_id=${segmentId}&per_page=${fetchLimit}`, {
            headers: { 'Authorization': `Bearer ${stravaAccessToken}` }
        });
        
        if (statusEl) statusEl.innerText = "⏳ Step 2: Reading Strava response...";
        let effortsData = await effortsRes.json();
        console.log("Strava Segment Data:", effortsData);
        
        if (effortsData.message || effortsData.errors) {
            throw new Error(`Strava Error: ${effortsData.message || 'Unknown'}`);
        }

        if (!Array.isArray(effortsData)) {
            throw new Error(`Data format error. Check Developer Console.`);
        }

        if (effortsData.length === 0) {
            throw new Error("Strava found 0 rides for you on this specific route.");
        }

        if (statusEl) statusEl.innerText = "⏳ Step 3: Analyzing your rides...";
        if (attemptType === 'best') {
            effortsData.sort((a, b) => a.elapsed_time - b.elapsed_time);
        } else {
            effortsData.sort((a, b) => new Date(b.start_date) - new Date(a.start_date));
        }

        const targetEffort = effortsData[0];
        
        if (!targetEffort || !targetEffort.activity || !targetEffort.activity.id) {
            throw new Error("Could not extract Activity ID from your ride.");
        }

        const activityId = targetEffort.activity.id;
        const startIndex = targetEffort.start_index;
        const endIndex = targetEffort.end_index;

        const effortDateObj = new Date(targetEffort.start_date_local || targetEffort.start_date);
        const formattedDate = effortDateObj.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

        if (statusEl) statusEl.innerText = "⏳ Step 4: Downloading your ride stream...";
        console.log(`Fetching streams for Activity ID: ${activityId}`);
        
        const streamRes = await fetch(`https://www.strava.com/api/v3/activities/${activityId}/streams?keys=distance,time,watts&key_by_type=true`, {
            headers: { 'Authorization': `Bearer ${stravaAccessToken}` }
        });
        
        const streamData = await streamRes.json();
        console.log("Strava Stream Data:", streamData);
        
        if (streamData.message || streamData.errors) {
            throw new Error(`Strava Blocked Stream: ${streamData.message || 'Unknown'}`);
        }

        if (!streamData.distance || !streamData.time) {
            throw new Error("Your ride file is missing distance or time data.");
        }

        if (statusEl) statusEl.innerText = "⏳ Step 5: Slicing the data mathematically...";
        let rawDistances = streamData.distance.data.slice(startIndex, endIndex + 1);
        let rawTimes = streamData.time.data.slice(startIndex, endIndex + 1);
        let rawWatts = streamData.watts ? streamData.watts.data.slice(startIndex, endIndex + 1) : [];

        let startDist = rawDistances[0];
        let startTimeVal = rawTimes[0];
        
        const distances = rawDistances.map(d => d - startDist);
        const times = rawTimes.map(t => t - startTimeVal);
        const watts = rawWatts;

        let generatedSegments = [];
        let intervalMeters = sliceIntervalKm * 1000;
        let nextTargetMeters = intervalMeters;
        let lastIndex = 0;

        for (let i = 0; i < distances.length; i++) {
            if (distances[i] >= nextTargetMeters || i === distances.length - 1) {
                
                let splitSecs = times[i] - times[lastIndex];
                
                let avgWatts = 150; 
                if (watts.length > 0) {
                    let wattsSlice = watts.slice(lastIndex, i + 1);
                    let wattsSum = wattsSlice.reduce((a, b) => a + b, 0);
                    avgWatts = Math.round(wattsSum / wattsSlice.length);
                }

                let isFinish = i === distances.length - 1;
                let segName = isFinish ? "Finish Line" : `Km ${(nextTargetMeters / 1000).toFixed(1)}`;

                if (splitSecs > 0) {
                    generatedSegments.push({
                        name: segName,
                        prevSegSec: splitSecs,
                        prevWatts: avgWatts,
                        targetCumSec: null, targetPower: null
                    });
                }

                lastIndex = i;
                nextTargetMeters += intervalMeters;
            }
        }

        baseSegments = generatedSegments;
        isDataLoaded = true;
        
        const startBtn = document.getElementById('startBtn');
        if (startBtn) startBtn.disabled = false;
        
        if (statusEl) {
            statusEl.innerText = `✓ Sliced into ${baseSegments.length} checkpoints!`;
            statusEl.className = "status-text ahead";
        }
        
        const titleText = document.getElementById('title-text');
        if (titleText) titleText.innerText = currentRouteName;
        
        if (dateDisplayEl) {
            dateDisplayEl.innerText = `Baseline Effort: ${formattedDate} (${formatTime(targetEffort.elapsed_time)})`;
            dateDisplayEl.style.display = 'block';
        }

        const targetTimeInput = document.getElementById('targetTimeInput');
        if (targetTimeInput) targetTimeInput.value = formatTime(targetEffort.elapsed_time);

        applyNewTarget();

    } catch (error) {
        console.error("Stream Fetch Error:", error);
        if (statusEl) {
            statusEl.innerText = `❌ ${error.message}`;
            statusEl.className = "status-text behind";
        }
    }
}

// --- Math & Utilities ---
function parseTimeToSeconds(timeStr) {
    if(!timeStr) return 0;
    const parts = timeStr.split(':');
    if (parts.length === 2) return (parseInt(parts[0]) || 0) * 60 + (parseInt(parts[1]) || 0);
    return (parseInt(parts[0]) || 0) * 60;
}

function formatTime(totalSeconds) {
    if (totalSeconds === null || isNaN(totalSeconds)) return "--:--";
    const absSec = Math.abs(Math.round(totalSeconds));
    const m = Math.floor(absSec / 60).toString().padStart(2, '0');
    const s = (absSec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}

function updateMainDelta(delta) {
    const el = document.getElementById('main-delta');
    if (!el) return;
    if (delta === null) { el.textContent = ""; el.className = ""; return; }
    el.textContent = delta >= 0 ? `-${formatTime(delta)}` : `+${formatTime(Math.abs(delta))}`;
    el.className = delta >= 0 ? "ahead" : "behind";
}

// --- Target Application & Rendering ---
function applyNewTarget() {
    if (!isDataLoaded) return;

    const inputEl = document.getElementById('targetTimeInput');
    if (!inputEl) return;
    
    const targetSeconds = parseTimeToSeconds(inputEl.value);
    if (targetSeconds <= 0) return; 

    const historicalTotal = baseSegments.reduce((sum, s) => sum + s.prevSegSec, 0);
    const baseRatio = targetSeconds / historicalTotal;

    let cumulativeSec = 0;
    activeSegments = baseSegments.map(seg => {
        const finalSegSec = Math.round(seg.prevSegSec * baseRatio);
        cumulativeSec += finalSegSec;
        const timeRatio = finalSegSec / seg.prevSegSec;
        const newPower = Math.round(seg.prevWatts * (1 / timeRatio));
        return { ...seg, targetCumSec: cumulativeSec, targetPower: newPower };
    });

    hardResetState(false); 
    renderList();
}

function hardResetState(fullReset) {
    clearInterval(timerInterval);
    timerInterval = null;
    startTime = null;
    currentActiveIndex = 0;
    actualCumSecData = new Array(activeSegments.length).fill(null);
    
    const timerEl = document.getElementById('timer');
    if (timerEl) timerEl.innerText = "00:00";
    
    updateMainDelta(null);
    
    const startBtn = document.getElementById('startBtn');
    if (startBtn) {
        startBtn.style.backgroundColor = 'var(--zwift-orange)';
        startBtn.innerText = "START";
    }
    
    const resetBtn = document.getElementById('resetBtn');
    if (resetBtn) resetBtn.style.display = 'none';
}

function renderList() {
    const list = document.getElementById('segmentList');
    if (!list) return;
    list.innerHTML = '';
    
    let runningPrevCumSec = 0;

    activeSegments.forEach((seg, index) => {
        const prevTargetCumSec = index > 0 ? activeSegments[index-1].targetCumSec : 0;
        const targetSegSec = seg.targetCumSec - prevTargetCumSec;

        runningPrevCumSec += seg.prevSegSec;

        const prevTimeStr = formatTime(runningPrevCumSec);
        const prevSegTimeStr = formatTime(seg.prevSegSec);
        const prevPowerStr = seg.prevWatts + 'W';

        const div = document.createElement('div');
        div.className = 'segment';
        div.innerHTML = `
            <div class="segment-info" style="width: 100%;">
                <div class="segment-name">${seg.name}</div>
                <div class="segment-target" style="color: var(--target-blue); font-weight: bold;">Target: ${formatTime(seg.targetCumSec)} (${formatTime(targetSegSec)}) @ ${seg.targetPower}W</div>
                <div class="prev-data-row">Prev: ${prevTimeStr} (${prevSegTimeStr}) @ ${prevPowerStr}</div>
            </div>
            <div class="segment-action" id="action-${index}"></div>
        `;
        list.appendChild(div);
        renderActionDiv(index); 
    });
}

function renderActionDiv(i) {
    const actionDiv = document.getElementById(`action-${i}`);
    if (!actionDiv) return;

    if (actualCumSecData[i] !== null) {
        const currentCumSec = actualCumSecData[i];
        const delta = activeSegments[i].targetCumSec - currentCumSec;
        let resTxt = delta >= 0 ? `-${formatTime(delta)} Ahead` : `+${formatTime(Math.abs(delta))} Behind`;
        let resCls = delta >= 0 ? 'ahead' : 'behind';

        actionDiv.innerHTML = `
            <div class="result-container" style="align-items: center;">
                <div class="time-row result ${resCls}">${resTxt}</div>
            </div>
        `;
    } else if (i === currentActiveIndex && isDataLoaded) {
        const disabledState = !startTime ? 'disabled' : '';
        actionDiv.innerHTML = `<button class="split-btn" ${disabledState} onclick="recordSplit(${i})">Split</button>`;
    } else {
        actionDiv.innerHTML = `<button class="split-btn" disabled>Split</button>`;
    }
}

// --- Ride Logic ---
function startRide() {
    if (!isDataLoaded || timerInterval) return; 
    startTime = Date.now();
    
    const startBtn = document.getElementById('startBtn');
    if (startBtn) {
        startBtn.style.backgroundColor = '#334155';
        startBtn.innerText = "RIDING";
    }
    
    const resetBtn = document.getElementById('resetBtn');
    if (resetBtn) resetBtn.style.display = 'inline-block';
    
    renderList(); 
    renderActionDiv(currentActiveIndex); 
    
    timerInterval = setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
        const timerEl = document.getElementById('timer');
        if (timerEl) timerEl.innerText = formatTime(elapsedSec);
    }, 1000);
}

function recordSplit(index) {
    if (!startTime || index !== currentActiveIndex) return; 
    const currentCumSec = Math.floor((Date.now() - startTime) / 1000);
    actualCumSecData[index] = currentCumSec;
    const splitDelta = activeSegments[index].targetCumSec - currentCumSec;
    updateMainDelta(splitDelta);
    currentActiveIndex = index + 1; 

    renderActionDiv(index);
    if (index + 1 < activeSegments.length) renderActionDiv(index + 1); 
}

function resetRideProgress() {
    if(confirm("Are you sure you want to reset?")) {
        hardResetState(true);
        renderList();
    }
}

// Boot up!
initAuth();
