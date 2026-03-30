// ==========================================
// js/universal.js - Strava Streams Slicer
// ==========================================

const DEV_MODE = false;

// We use the actual Strava Segment IDs here!
const universalRoutes = [
    { id: 16669530, name: "Epic KOM" },
    { id: 16425130, name: "Volcano Circuit CCW" },
    { id: 21343975, name: "Titans Grove KOM" },
    { id: 16425133, name: "Innsbruck KOM" }
];

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
        try { window.localStorage.setItem('strava_token', urlToken); } catch(e) {}
        try { window.history.replaceState({}, document.title, window.location.pathname); } catch(e) {}
    } else {
        try { stravaAccessToken = window.localStorage.getItem('strava_token'); } catch(e) {}
    }

    if (stravaAccessToken) {
        showApp();
    } else {
        document.getElementById('strava-btn').style.display = 'inline-block';
        document.getElementById('settings-container').style.display = 'none';
    }
}

function showApp() {
    document.getElementById('strava-btn').style.display = 'none';
    document.getElementById('settings-container').style.display = 'block';
    
    const selectEl = document.getElementById('routeSelect');
    selectEl.innerHTML = ''; 
    universalRoutes.forEach(route => {
        const opt = document.createElement('option');
        opt.value = route.id;
        opt.textContent = route.name;
        selectEl.appendChild(opt);
    });
}

// --- Fetch & Slicer Engine ---
async function fetchAndSliceStravaData() {
    const segmentId = document.getElementById('routeSelect').value;
    currentRouteName = document.getElementById('routeSelect').options[document.getElementById('routeSelect').selectedIndex].text;
    const sliceIntervalKm = parseFloat(document.getElementById('sliceSelect').value);
    const attemptType = document.getElementById('attemptSelect').value;
    const statusEl = document.getElementById('strava-status');
    
    statusEl.innerText = "⏳ Finding your effort...";
    statusEl.className = "status-text";
    statusEl.style.display = 'inline-block';

    const fetchLimit = attemptType === 'best' ? 50 : 1;

    try {
        // 1. Fetch their segment efforts
        const effortsRes = await fetch(`https://www.strava.com/api/v3/segment_efforts?segment_id=${segmentId}&per_page=${fetchLimit}`, {
            headers: { 'Authorization': `Bearer ${stravaAccessToken}` }
        });
        
        let effortsData = await effortsRes.json();
        if (effortsData.message === "Authorization Error" || effortsRes.status === 401) {
            statusEl.innerText = `❌ Session expired.`;
            statusEl.className = "status-text behind";
            return;
        }

        if (!effortsData || effortsData.length === 0 || effortsData.errors) {
            statusEl.innerText = `❌ You haven't ridden this route!`;
            statusEl.className = "status-text behind";
            return;
        }

        if (attemptType === 'best') {
            effortsData.sort((a, b) => a.elapsed_time - b.elapsed_time);
        }

        const targetEffort = effortsData[0];
        const effortId = targetEffort.id;

        // 2. Fetch the Streams API for this specific effort
        statusEl.innerText = "⏳ Downloading telemetry streams...";
        
        const streamRes = await fetch(`https://www.strava.com/api/v3/segment_efforts/${effortId}/streams?keys=distance,time,watts&key_by_type=true`, {
            headers: { 'Authorization': `Bearer ${stravaAccessToken}` }
        });
        
        const streamData = await streamRes.json();
        
        if (!streamData.distance || !streamData.time) {
            throw new Error("Strava stream did not return distance or time data.");
        }

        const distances = streamData.distance.data; // Meters
        const times = streamData.time.data; // Seconds
        const watts = streamData.watts ? streamData.watts.data : []; // Watts (might be empty if no power meter)

        // 3. Slice the Arrays!
        statusEl.innerText = "⏳ Slicing data...";
        let generatedSegments = [];
        let intervalMeters = sliceIntervalKm * 1000;
        let nextTargetMeters = intervalMeters;
        let lastIndex = 0;

        for (let i = 0; i < distances.length; i++) {
            if (distances[i] >= nextTargetMeters || i === distances.length - 1) {
                
                let splitSecs = times[i] - times[lastIndex];
                
                // Calculate average watts for this chunk
                let avgWatts = 150; // Fallback
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
        
        document.getElementById('startBtn').disabled = false;
        statusEl.innerText = `✓ Sliced into ${baseSegments.length} checkpoints!`;
        statusEl.className = "status-text ahead";
        document.getElementById('title-text').innerText = currentRouteName;

        // Set the default target time input to whatever their PR was
        document.getElementById('targetTimeInput').value = formatTime(targetEffort.elapsed_time);

        applyNewTarget();

    } catch (error) {
        console.error("Stream Fetch Error:", error);
        statusEl.innerText = "❌ Strava Stream Error";
        statusEl.className = "status-text behind";
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
    if (delta === null) { el.textContent = ""; el.className = ""; return; }
    el.textContent = delta >= 0 ? `-${formatTime(delta)}` : `+${formatTime(Math.abs(delta))}`;
    el.className = delta >= 0 ? "ahead" : "behind";
}

// --- Target Application & Rendering ---
function applyNewTarget() {
    if (!isDataLoaded) return;

    const targetSeconds = parseTimeToSeconds(document.getElementById('targetTimeInput').value);
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
    document.getElementById('timer').innerText = "00:00";
    updateMainDelta(null);
    document.getElementById('startBtn').style.backgroundColor = 'var(--zwift-orange)';
    document.getElementById('startBtn').innerText = "START";
    document.getElementById('resetBtn').style.display = 'none';
}

function renderList() {
    const list = document.getElementById('segmentList');
    list.innerHTML = '';

    activeSegments.forEach((seg, index) => {
        const prevTargetCumSec = index > 0 ? activeSegments[index-1].targetCumSec : 0;
        const targetSegSec = seg.targetCumSec - prevTargetCumSec;

        const div = document.createElement('div');
        div.className = 'segment';
        div.innerHTML = `
            <div class="segment-info" style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                <div>
                    <div class="segment-name">${seg.name}</div>
                    <div class="segment-target" style="color: var(--target-blue); font-weight: bold;">Target: ${formatTime(seg.targetCumSec)} (${formatTime(targetSegSec)}) @ ${seg.targetPower}W</div>
                </div>
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
    document.getElementById('startBtn').style.backgroundColor = '#334155';
    document.getElementById('startBtn').innerText = "RIDING";
    document.getElementById('resetBtn').style.display = 'inline-block';
    
    renderList(); 
    renderActionDiv(currentActiveIndex); 
    
    timerInterval = setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
        document.getElementById('timer').innerText = formatTime(elapsedSec);
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
