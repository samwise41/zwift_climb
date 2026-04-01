// ==========================================
// DEV MODE TOGGLE (Set to false for Production)
// ==========================================
const DEV_MODE = false; 

window.addEventListener('beforeunload', function (e) {
    if (startTime) { 
        e.preventDefault();
        e.returnValue = 'Ride in progress! Are you sure you want to leave?';
    }
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

// --- Core State ---
let stravaAccessToken = null;
let climbsConfig = [];
let currentClimb = null;
let isDataLoaded = false;

let effortDateStr = ""; 
let pipWindow = null; 
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

// ==========================================
// SMART COCKPIT MODE (PiP or DOM Overlay)
// ==========================================
async function toggleCockpitMode() {
    const btn = document.getElementById('cockpitToggleBtn');

    // 1. Desktop: Try True Picture-in-Picture API
    if ('documentPictureInPicture' in window) {
        if (pipWindow) {
            pipWindow.close();
            return;
        }
        try {
            pipWindow = await documentPictureInPicture.requestWindow({
                width: 320,
                height: 280
            });

            pipWindow.document.body.innerHTML = `
                <div style="background-color: #0f172a; color: white; height: 100vh; width: 100vw; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 15px; box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; position: absolute; top: 0; left: 0;">
                    <div id="pip-header" style="font-size: 1.2em; color: #3daee9; margin-bottom: 5px; text-align: center; font-weight: bold;">${currentClimb ? currentClimb.name : 'Climb Pacer'}</div>
                    <div id="pip-timer" style="font-size: 4.5em; font-weight: bold; font-variant-numeric: tabular-nums; line-height: 1; margin: 5px 0;">${document.getElementById('timer').innerText}</div>
                    <div id="pip-main-delta" style="font-size: 2em; font-weight: bold; margin-bottom: 20px;">${document.getElementById('main-delta').innerText}</div>
                    <div id="pip-action-zone" style="width: 100%; text-align: center;"></div>
                </div>
            `;

            const mainDeltaEl = document.getElementById('main-delta');
            const pipDeltaEl = pipWindow.document.getElementById('pip-main-delta');
            if (mainDeltaEl.classList.contains('ahead')) pipDeltaEl.style.color = '#4caf50';
            if (mainDeltaEl.classList.contains('behind')) pipDeltaEl.style.color = '#f44336';

            renderPipAction(); 

            pipWindow.addEventListener("pagehide", () => {
                pipWindow = null;
                btn.innerHTML = '🚀 Cockpit';
            });

            btn.innerHTML = '❌ Close PiP';
            return; 
        } catch (error) {
            console.warn("PiP blocked or failed, falling back to overlay:", error);
        }
    }

    // 2. Mobile / Unsupported: Fallback to DOM Overlay
    toggleDOMOverlay();
}

function toggleDOMOverlay() {
    isCockpitMode = !isCockpitMode;
    const body = document.body;
    
    if (isCockpitMode) {
        body.classList.add('cockpit-mode');
    } else {
        body.classList.remove('cockpit-mode');
        if (isDataLoaded) renderList(); 
    }

    if (isCockpitMode && isDataLoaded) {
        renderCockpitAction();
    }
}

// Mobile/DOM Overlay Render
function renderCockpitAction() {
    const cockpitZone = document.getElementById('cockpit-active-segment');
    if (!cockpitZone || !isCockpitMode) return;

    let html = "";

    // 1. PREVIOUS SEGMENT
    if (currentActiveIndex > 0) {
        const prevIndex = currentActiveIndex - 1;
        const prevSeg = activeSegments[prevIndex];
        const prevPrevCumSec = prevIndex > 0 ? actualCumSecData[prevIndex - 1] : 0;
        const actualSplitSecs = actualCumSecData[prevIndex] - prevPrevCumSec;

        html += `
            <div style="font-size: 0.9em; color: #64748b; margin-bottom: 8px; font-weight: bold; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px;">
                🔙 Prev: ${prevSeg.name} | Done: ${formatTime(actualSplitSecs)} (Target: ${prevSeg.targetPower}W)
            </div>`;
    } else {
        html += `
            <div style="font-size: 0.9em; color: #64748b; margin-bottom: 8px; font-weight: bold; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px;">
                🏁 Awaiting First Split...
            </div>`;
    }

    // 2. CURRENT SEGMENT & BUTTON (Removed "Up Next" redundancy)
    if (currentActiveIndex < activeSegments.length) {
        const currSeg = activeSegments[currentActiveIndex];
        const prevTargetCumSec = currentActiveIndex > 0 ? activeSegments[currentActiveIndex-1].targetCumSec : 0;
        const targetSegSec = currSeg.targetCumSec - prevTargetCumSec;

        const disabledState = !startTime ? 'disabled style="opacity:0.5; cursor:not-allowed; background-color:#334155;"' : 'style="background-color: var(--zwift-orange); cursor: pointer;"';
        const btnText = !startTime ? "Waiting to Start..." : `Split: ${currSeg.name}`;

        html += `
            <div style="font-size: 1.2em; color: var(--target-blue); font-weight: bold; margin-top: 10px; margin-bottom: 15px;">
                🎯 Target: ${formatTime(targetSegSec)} @ ${currSeg.targetPower}W
            </div>
            <button class="split-btn" ${disabledState} onclick="recordSplit(${currentActiveIndex})" style="width: 100%; padding: 20px; font-size: 1.5em; border-radius: 12px; font-weight: bold; border: none; color: white;">${btnText}</button>
        `;
    } else {
        html += `<div style="font-size: 2em; color: var(--ahead-green); font-weight: bold; margin-top: 10px;">🎉 RIDE COMPLETE!</div>`;
    }

    // 3. UNDO BUTTON
    if (currentActiveIndex > 0 && startTime) {
        const lastSegmentName = activeSegments[currentActiveIndex - 1].name;
        html += `<div style="margin-top: 25px;">
                    <button class="undo-btn" onclick="undoSplit(${currentActiveIndex - 1})" style="background: none; border: 1px solid #94a3b8; color: #94a3b8; padding: 10px 20px; font-size: 1.1em; border-radius: 8px; cursor: pointer;">↺ Undo: ${lastSegmentName}</button>
                 </div>`;
    }
    cockpitZone.innerHTML = html;
}

// Desktop PiP Window Render
function renderPipAction() {
    if (!pipWindow || !isDataLoaded) return;
    const zone = pipWindow.document.getElementById('pip-action-zone');
    const header = pipWindow.document.getElementById('pip-header');

    // 1. Update Header with Previous Segment Data
    if (header) {
        if (currentActiveIndex > 0) {
            const prevIndex = currentActiveIndex - 1;
            const prevSeg = activeSegments[prevIndex];
            const prevPrevCumSec = prevIndex > 0 ? actualCumSecData[prevIndex - 1] : 0;
            const actualSplitSecs = actualCumSecData[prevIndex] - prevPrevCumSec;
            
            header.innerHTML = `🔙 Prev: ${prevSeg.name} | Done: ${formatTime(actualSplitSecs)} (Target: ${prevSeg.targetPower}W)`;
            header.style.color = '#94a3b8';
            header.style.fontSize = '0.9em';
        } else {
            header.innerHTML = `🏁 Awaiting First Split...`;
            header.style.color = '#94a3b8';
            header.style.fontSize = '0.9em';
        }
    }

    let html = '';
    
    // 2. Current Segment & Button (Removed "Up Next" redundancy)
    if (currentActiveIndex < activeSegments.length) {
        const currSeg = activeSegments[currentActiveIndex];
        const prevTargetCumSec = currentActiveIndex > 0 ? activeSegments[currentActiveIndex-1].targetCumSec : 0;
        const targetSegSec = currSeg.targetCumSec - prevTargetCumSec;

        const disabledStyle = !startTime ? 'opacity: 0.5; cursor: not-allowed; background-color: #334155;' : 'cursor: pointer; background-color: #fc6719;';
        const btnText = !startTime ? "Waiting to Start..." : `Split: ${currSeg.name}`;

        html += `
            <div style="font-size: 1.1em; color: #3daee9; font-weight: bold; margin-bottom: 12px; margin-top: 5px;">🎯 Target: ${formatTime(targetSegSec)} @ ${currSeg.targetPower}W</div>
            <button id="pip-split-btn" style="color: white; border: none; padding: 15px 20px; border-radius: 8px; font-weight: bold; font-size: 1.3em; width: 100%; max-width: 280px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); transition: transform 0.1s; ${disabledStyle}">${btnText}</button>
        `;
    } else {
        html += `<div style="font-size: 1.8em; color: #4caf50; font-weight: bold;">🎉 RIDE COMPLETE!</div>`;
    }

    // 3. Undo Button
    if (currentActiveIndex > 0 && startTime) {
        const lastSegmentName = activeSegments[currentActiveIndex - 1].name;
        html += `<div style="margin-top: 15px;">
                    <button id="pip-undo-btn" style="background: none; border: 1px solid #94a3b8; color: #94a3b8; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 0.9em; transition: transform 0.1s;">↺ Undo: ${lastSegmentName}</button>
                 </div>`;
    }

    zone.innerHTML = html;

    // Attach listeners
    const splitBtn = pipWindow.document.getElementById('pip-split-btn');
    if (splitBtn && startTime) {
        splitBtn.onmousedown = () => splitBtn.style.transform = 'scale(0.95)';
        splitBtn.onmouseup = () => splitBtn.style.transform = 'scale(1)';
        splitBtn.onclick = () => recordSplit(currentActiveIndex);
    }

    const undoBtn = pipWindow.document.getElementById('pip-undo-btn');
    if (undoBtn) {
        undoBtn.onmousedown = () => undoBtn.style.transform = 'scale(0.95)';
        undoBtn.onmouseup = () => undoBtn.style.transform = 'scale(1)';
        undoBtn.onclick = () => undoSplit(currentActiveIndex - 1);
    }
}
// ==========================================


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

async function loadSegmentsConfig() {
    try {
        const res = await fetch('./segments.json?t=' + Date.now());
        climbsConfig = await res.json();
        
        const selectEl = document.getElementById('climbSelect');
        climbsConfig.forEach((climb, index) => {
            const opt = document.createElement('option');
            opt.value = index;
            opt.textContent = climb.name;
            selectEl.appendChild(opt);
        });

        selectEl.addEventListener('change', (e) => loadClimbSkeleton(climbsConfig[e.target.value]));
        
        const cachedDataStr = safeStorage.get('pacer_cache_data');
        if (cachedDataStr) {
            const cachedData = JSON.parse(cachedDataStr);
            const climbIndex = climbsConfig.findIndex(c => c.name === cachedData.climbName);
            
            if (climbIndex !== -1) {
                selectEl.value = climbIndex;
                currentClimb = climbsConfig[climbIndex];

                document.getElementById('title-text').innerText = `${currentClimb.name} Pacer`;
                document.getElementById('targetTimeInput').value = cachedData.targetTimeStr;
                
                baseSegments = cachedData.baseSegments;
                isDataLoaded = true;
                
                effortDateStr = cachedData.effortDateStr || "";
                const dateEl = document.getElementById('effort-date-display');
                if (dateEl) {
                    if (effortDateStr) {
                        dateEl.innerText = `Baseline Effort: ${effortDateStr}`;
                        dateEl.style.display = 'block';
                    } else {
                        dateEl.style.display = 'none';
                    }
                }
                
                document.getElementById('startBtn').disabled = false;
                document.getElementById('data-settings-box').style.display = 'none'; 
                document.getElementById('toggleSettingsBtn').innerHTML = '▶ Show Settings';
                
                const statusEl = document.getElementById('strava-status');
                statusEl.innerText = `✓ Cached Activity Loaded!`;
                statusEl.style.display = 'inline-block';
                statusEl.className = "status-text ahead";
                
                applyNewTarget();
                return;
            }
        }
        
        if(climbsConfig.length > 0) {
            loadClimbSkeleton(climbsConfig[0]);
        }
    } catch (e) {
        console.error("Could not load segments.json.", e);
        document.getElementById('title-text').innerText = "Error: segments.json missing";
    }
}

function loadClimbSkeleton(climb) {
    currentClimb = climb;
    isDataLoaded = false;
    effortDateStr = "";
    
    document.getElementById('title-text').innerText = `${climb.name} Pacer`;
    document.getElementById('effort-date-display').style.display = 'none';
    document.getElementById('targetTimeInput').value = climb.defaultTime;
    
    document.getElementById('startBtn').disabled = true;
    document.getElementById('strava-status').style.display = 'none';

    baseSegments = climb.subSegments.map(name => ({
        name: name,
        targetCumSec: null, targetPower: null, prevSegSec: null, prevWatts: null
    }));
    
    applyNewTarget(); 
}

function clearCacheAndReset() {
    safeStorage.remove('pacer_cache_data');
    alert("Saved data cleared. Ready to fetch new data.");
    loadClimbSkeleton(currentClimb);
    document.getElementById('data-settings-box').style.display = 'flex'; 
    document.getElementById('toggleSettingsBtn').innerHTML = '▼ Hide Settings';
}

function saveAndLoadData(segmentDataArray, successMsg, dateStr = "") {
    baseSegments = segmentDataArray; 
    effortDateStr = dateStr;
    isDataLoaded = true; 
    
    document.getElementById('startBtn').disabled = false;
    document.getElementById('data-settings-box').style.display = 'none'; 
    document.getElementById('toggleSettingsBtn').innerHTML = '▶ Show Settings';
    
    const statusEl = document.getElementById('strava-status');
    statusEl.innerText = `✓ ${successMsg}`;
    statusEl.style.display = 'inline-block';
    statusEl.className = "status-text ahead";

    const dateEl = document.getElementById('effort-date-display');
    if (dateEl) {
        if (effortDateStr) {
            dateEl.innerText = `Baseline Effort: ${effortDateStr}`;
            dateEl.style.display = 'block';
        } else {
            dateEl.style.display = 'none';
        }
    }

    applyNewTarget(); 

    const cacheObject = {
        climbName: currentClimb.name,
        targetTimeStr: document.getElementById('targetTimeInput').value,
        baseSegments: baseSegments,
        effortDateStr: effortDateStr
    };
    safeStorage.set('pacer_cache_data', JSON.stringify(cacheObject));
}

async function fetchUserData() {
    if (!stravaAccessToken || !currentClimb) return;

    const statusEl = document.getElementById('strava-status');
    statusEl.innerText = `⏳ Searching...`;
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
                
                dummySegments.push({
                    name: currentClimb.subSegments[i],
                    prevSegSec: mockSegSec,
                    prevWatts: mockWatts,
                    targetCumSec: null, targetPower: null
                });
            }

            saveAndLoadData(dummySegments, "DEV MODE Data Loaded", "Today (Dev Mode)");
        }, 600); 
        return;
    }

    const attemptType = document.getElementById('attemptSelect').value;
    const fetchLimit = attemptType === 'best' ? 50 : 1;

    try {
        const effortsRes = await fetch(`https://www.strava.com/api/v3/segment_efforts?segment_id=${currentClimb.id}&per_page=${fetchLimit}`, {
            headers: { 'Authorization': `Bearer ${stravaAccessToken}` }
        });
        let effortsData = await effortsRes.json();

        if (effortsData.message === "Authorization Error" || effortsRes.status === 401) {
            safeStorage.remove('strava_token'); 
            safeStorage.remove('strava_expiry');
            statusEl.innerText = `❌ Session expired.`;
            statusEl.classList.add("behind");
            document.getElementById('strava-btn').style.display = 'inline-block';
            document.getElementById('settings-container').style.display = 'none';
            return;
        }

        if (!effortsData || effortsData.length === 0 || effortsData.errors) {
            statusEl.innerText = `❌ No efforts found for ${currentClimb.name}.`;
            statusEl.classList.add("behind");
            return;
        }

        if (attemptType === 'best') {
            effortsData.sort((a, b) => a.elapsed_time - b.elapsed_time);
        }

        const targetEffort = effortsData[0];
        const activityId = targetEffort.activity.id;

        const effortDateObj = new Date(targetEffort.start_date_local || targetEffort.start_date);
        const formattedDate = effortDateObj.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

        statusEl.innerText = `⏳ Loading activity...`;

        const activityRes = await fetch(`https://www.strava.com/api/v3/activities/${activityId}`, {
            headers: { 'Authorization': `Bearer ${stravaAccessToken}` }
        });
        const activityData = await activityRes.json();
        const segmentEfforts = activityData.segment_efforts;

        let personalizedSegments = [];
        let missingSegments = [];

        for (let targetName of currentClimb.subSegments) {
            const regex = new RegExp("\\b" + targetName + "(?:\\b|\\s|$)", "i");
            const match = segmentEfforts.find(seg => regex.test(seg.name));
            
            if (match) {
                personalizedSegments.push({
                    name: targetName,
                    prevSegSec: match.elapsed_time,
                    prevWatts: Math.round(match.average_watts || 0),
                    targetCumSec: null, targetPower: null
                });
            } else {
                missingSegments.push(targetName);
            }
        }

        if (missingSegments.length === 0) {
            const successMsg = attemptType === 'best' ? "PR Loaded!" : "Recent Effort Loaded!";
            saveAndLoadData(personalizedSegments, successMsg, formattedDate);
        } else {
            console.warn("⚠️ Missing Sub-Segments:", missingSegments);
            statusEl.innerText = `⚠️ Missing ${missingSegments.length} hairpins.`;
            statusEl.classList.add("behind");
        }
    } catch (error) {
        console.error(error);
        statusEl.innerText = "❌ Connection Error";
        statusEl.classList.add("behind");
    }
}

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
    let txt = "", cls = "";
    
    if (delta !== null) {
        txt = delta >= 0 ? `-${formatTime(delta)}` : `+${formatTime(Math.abs(delta))}`;
        cls = delta >= 0 ? "ahead" : "behind";
    }
    
    el.textContent = txt;
    el.className = cls;

    if (pipWindow) {
        const pipEl = pipWindow.document.getElementById('pip-main-delta');
        if (pipEl) {
            pipEl.textContent = txt;
            pipEl.style.color = delta >= 0 ? '#4caf50' : (delta < 0 ? '#f44336' : 'inherit');
        }
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
    hardResetState(false); 
    renderList();

    if (isDataLoaded) {
        const cacheStr = safeStorage.get('pacer_cache_data');
        if (cacheStr) {
            let cacheObj = JSON.parse(cacheStr);
            cacheObj.targetTimeStr = document.getElementById('targetTimeInput').value;
            cacheObj.baseSegments = activeSegments;
            safeStorage.set('pacer_cache_data', JSON.stringify(cacheObj));
        }
    }
}

function resetRideProgress() {
    if(confirm("Are you sure you want to reset? All current ride progress will be lost.")) {
        hardResetState(true);
        renderList();
    }
}

function hardResetState(fullReset) {
    clearInterval(timerInterval);
    timerInterval = null;
    startTime = null;
    currentActiveIndex = 0;
    
    actualCumSecData = new Array(activeSegments.length).fill(null);
    trendData = new Array(activeSegments.length).fill(null);
    currentSegTimeData = new Array(activeSegments.length).fill(null);
    currentSegWattsData = new Array(activeSegments.length).fill(null);
    
    document.getElementById('timer').innerText = "00:00";
    if (pipWindow) {
        const pipTimer = pipWindow.document.getElementById('pip-timer');
        if(pipTimer) pipTimer.innerText = "00:00";
    }
    
    updateMainDelta(null);
    document.getElementById('startBtn').style.backgroundColor = 'var(--zwift-orange)';
    document.getElementById('startBtn').innerText = "START";
    document.getElementById('resetBtn').style.display = 'none';
    
    if (fullReset) {
        document.getElementById('targetTimeInput').disabled = false;
        document.getElementById('splitSlider').disabled = false;
        document.getElementById('climbSelect').disabled = false;
        document.getElementById('attemptSelect').disabled = false;
        document.getElementById('fetchBtn').disabled = false;
        document.getElementById('toggleSettingsBtn').style.display = 'block';
    }

    if(pacingTrendChart) {
        pacingTrendChart.data.datasets[0].data = trendData;
        pacingTrendChart.update();
    }
    if(comparisonChart) {
        comparisonChart.data.datasets[2].data = currentSegWattsData;
        comparisonChart.data.datasets[5].data = currentSegTimeData;
        comparisonChart.update();
    }

    renderPipAction();
    renderCockpitAction();
}

function startRide() {
    if (!isDataLoaded || timerInterval) return; 
    startTime = Date.now();
    document.getElementById('startBtn').style.backgroundColor = '#334155';
    document.getElementById('startBtn').innerText = "RIDING";
    document.getElementById('resetBtn').style.display = 'inline-block';
    
    document.getElementById('targetTimeInput').disabled = true;
    document.getElementById('splitSlider').disabled = true;
    document.getElementById('climbSelect').disabled = true;
    document.getElementById('attemptSelect').disabled = true;
    document.getElementById('fetchBtn').disabled = true;
    
    document.getElementById('data-settings-box').style.display = 'none';
    document.getElementById('toggleSettingsBtn').style.display = 'none';
    
    renderActionDiv(currentActiveIndex); 
    renderPipAction();
    renderCockpitAction();
    
    timerInterval = setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
        const timeStr = formatTime(elapsedSec);
        document.getElementById('timer').innerText = timeStr;
        
        if (pipWindow) {
            const pipTimer = pipWindow.document.getElementById('pip-timer');
            if(pipTimer) pipTimer.innerText = timeStr;
        }
    }, 1000);
}

function recordSplit(index) {
    if (!startTime || index !== currentActiveIndex) return; 

    const currentCumSec = Math.floor((Date.now() - startTime) / 1000);
    actualCumSecData[index] = currentCumSec;
    
    const prevCumSec = index > 0 ? actualCumSecData[index-1] : 0;
    currentSegTimeData[index] = currentCumSec - prevCumSec;
    
    const splitDelta = activeSegments[index].targetCumSec - currentCumSec;
    trendData[index] = splitDelta;
    
    updateMainDelta(splitDelta);
    currentActiveIndex = index + 1; 

    if (pacingTrendChart) pacingTrendChart.update();
    if (comparisonChart) comparisonChart.update();

    renderActionDiv(index);
    if (index > 0) renderActionDiv(index - 1); 
    if (index + 1 < activeSegments.length) renderActionDiv(index + 1); 
    
    renderPipAction();
    renderCockpitAction();
}

function undoSplit(index) {
    if (index !== currentActiveIndex - 1) return;

    actualCumSecData[index] = null;
    currentSegTimeData[index] = null;
    trendData[index] = null;
    currentSegWattsData[index] = null;

    if (index > 0) {
        const prevIndex = index - 1;
        const prevDelta = activeSegments[prevIndex].targetCumSec - actualCumSecData[prevIndex];
        updateMainDelta(prevDelta);
    } else {
        updateMainDelta(null);
    }

    currentActiveIndex = index; 

    if (pacingTrendChart) pacingTrendChart.update();
    if (comparisonChart) comparisonChart.update();

    renderActionDiv(index);
    if (index > 0) renderActionDiv(index - 1);
    if (index + 1 < activeSegments.length) renderActionDiv(index + 1);

    renderPipAction();
    renderCockpitAction();
}

function updateComparisonWatts(index, element) {
    const val = element.value;
    if (val === '') {
        currentSegWattsData[index] = null;
        element.style.border = '1px solid #1e293b';
        element.style.color = 'var(--cur-color)'; 
    } else {
        const watts = parseInt(val);
        if (!isNaN(watts)) {
            currentSegWattsData[index] = watts;
            applyPowerInputStyles(element, watts, activeSegments[index].targetPower);
        }
    }
    if (comparisonChart) comparisonChart.update('none'); 
}

function applyPowerInputStyles(inputEl, userPower, targetPower) {
    if (userPower >= targetPower) {
        inputEl.style.border = '1px solid var(--ahead-green)';
        inputEl.style.color = 'var(--ahead-green)';
    } else {
        inputEl.style.border = '1px solid var(--behind-red)';
        inputEl.style.color = 'var(--behind-red)';
    }
}

function renderActionDiv(i) {
    const actionDiv = document.getElementById(`action-${i}`);
    if (!actionDiv) return;

    if (actualCumSecData[i] !== null) {
        const currentCumSec = actualCumSecData[i];
        const prevCumSec = i > 0 ? actualCumSecData[i-1] : 0;
        const segDuration = currentCumSec - prevCumSec;
        const delta = activeSegments[i].targetCumSec - currentCumSec;
        
        let resTxt = delta >= 0 ? `-${formatTime(delta)} Ahead` : `+${formatTime(Math.abs(delta))} Behind`;
        let resCls = delta >= 0 ? 'ahead' : 'behind';

        const isLastCompleted = (i === currentActiveIndex - 1);
        const undoBtnHtml = isLastCompleted ? `<button class="undo-btn" onclick="undoSplit(${i})">↺ Undo</button>` : '';
        
        const existingPower = currentSegWattsData[i] !== null ? currentSegWattsData[i] : '';

        actionDiv.innerHTML = `
            <div class="result-container">
                <div class="time-row">
                    <span class="cur-cum">${formatTime(currentCumSec)}</span> |
                    <span class="cur-seg">Seg: ${formatTime(segDuration)}</span>
                </div>
                <div class="time-row result ${resCls}">${resTxt}</div>
                <div class="power-input-container">
                    ${undoBtnHtml}
                    <span class="power-label">Avg W:</span>
                    <input type="number" inputmode="decimal" id="power-${i}" class="power-input" placeholder="--" value="${existingPower}" oninput="updateComparisonWatts(${i}, this)">
                </div>
            </div>
        `;
        
        if (existingPower !== '') {
            const inputEl = document.getElementById(`power-${i}`);
            applyPowerInputStyles(inputEl, parseInt(existingPower), activeSegments[i].targetPower);
        }
        
    } else if (i === currentActiveIndex && isDataLoaded) {
        const disabledState = !startTime ? 'disabled' : '';
        actionDiv.innerHTML = `<button class="split-btn" ${disabledState} onclick="recordSplit(${i})">Split</button>`;
    } else {
        actionDiv.innerHTML = `<button class="split-btn" disabled>Split</button>`;
    }
}

function renderList() {
    const list = document.getElementById('segmentList');
    list.innerHTML = '';
    let runningPrevCumSec = 0;

    activeSegments.forEach((seg, index) => {
        const prevTargetCumSec = index > 0 && activeSegments[index-1].targetCumSec !== null ? activeSegments[index-1].targetCumSec : 0;
        const targetSegSec = seg.targetCumSec !== null ? (seg.targetCumSec - prevTargetCumSec) : null;
        
        if (seg.prevSegSec !== null) runningPrevCumSec += seg.prevSegSec;

        const targetTimeStr = seg.targetCumSec !== null ? formatTime(seg.targetCumSec) : "--:--";
        const targetSegTimeStr = targetSegSec !== null ? formatTime(targetSegSec) : "--:--";
        const targetPowerStr = seg.targetPower !== null ? seg.targetPower + 'W' : '--W';
        
        const prevTimeStr = seg.prevSegSec !== null ? formatTime(runningPrevCumSec) : "--:--";
        const prevSegTimeStr = seg.prevSegSec !== null ? formatTime(seg.prevSegSec) : "--:--";
        const prevPowerStr = seg.prevWatts !== null ? seg.prevWatts + 'W' : '--W';

        const div = document.createElement('div');
        div.className = 'segment';
        div.innerHTML = `
            <div class="segment-info">
                <div class="segment-name">${seg.name}</div>
                <div class="segment-target" style="color: var(--target-blue); font-weight: bold;">Target: ${targetTimeStr} (${targetSegTimeStr}) @ ${targetPowerStr}</div>
                <div class="prev-data-row">Prev: ${prevTimeStr} (${prevSegTimeStr}) @ ${prevPowerStr}</div>
            </div>
            <div class="segment-action" id="action-${index}"></div>
        `;
        list.appendChild(div);
        renderActionDiv(index); 
    });
    
    initCharts();
}

function initCharts() {
    Chart.defaults.color = '#64748b'; 
    Chart.defaults.borderColor = '#e2e8f0'; 
    Chart.defaults.font.size = 10;

    const chartLabels = activeSegments.map((seg, i) => {
        if (i === 0) return "Start";
        if (i === activeSegments.length - 1) return "Banner";
        let splitName = seg.name.split(" to ");
        return splitName.length > 1 ? "B" + splitName[1] : "S" + i;
    });

    const prevSegTimeData = activeSegments.map(s => s.prevSegSec);
    const prevSegWattsData = activeSegments.map(s => s.prevWatts);
    const targetWattsData = activeSegments.map(s => s.targetPower);
    
    const targetSegTimeData = activeSegments.map((s, i) => {
        if (s.targetCumSec === null) return null;
        if (i === 0) return s.targetCumSec;
        return s.targetCumSec - activeSegments[i-1].targetCumSec;
    });

    if(pacingTrendChart) pacingTrendChart.destroy();
    const ctxTrend = document.getElementById('pacingTrendChart').getContext('2d');
    
    pacingTrendChart = new Chart(ctxTrend, {
        type: 'line',
        data: {
            labels: chartLabels,
            datasets: [{
                label: 'Time Ahead/Behind', 
                data: trendData,
                borderColor: '#000000',
                borderWidth: 2, 
                pointBackgroundColor: '#fff', 
                pointRadius: 3,
                fill: {
                    target: 'origin',
                    above: 'rgba(76, 175, 80, 0.4)', 
                    below: 'rgba(252, 103, 25, 0.4)'
                },
                tension: 0.1
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false, 
            plugins: { 
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            let val = context.raw;
                            if (val === null) return '';
                            let sign = val >= 0 ? '+' : '-';
                            return ` ${sign}${formatTime(val)}`;
                        }
                    }
                }
            },
            scales: {
                y: { 
                    title: { display: false }, 
                    ticks: { 
                        stepSize: 30,
                        callback: function(value) {
                            let sign = value >= 0 ? '+' : '-';
                            return `${sign}${formatTime(value)}`;
                        }
                    } 
                },
                x: { ticks: { maxRotation: 45, minRotation: 45 } }
            }
        }
    });

    if(comparisonChart) comparisonChart.destroy();
    const ctxComp = document.getElementById('comparisonChart').getContext('2d');
    comparisonChart = new Chart(ctxComp, {
        data: {
            labels: chartLabels,
            datasets: [
                { type: 'line', label: 'Prev W', data: prevSegWattsData, borderColor: '#888', borderDash: [1, 2], borderWidth: 1.5, fill: false, pointRadius: 0, yAxisID: 'y1' },
                { type: 'line', label: 'Target W', data: targetWattsData, borderColor: '#3daee9', borderDash: [6, 4], borderWidth: 2, fill: false, pointRadius: 0, yAxisID: 'y1' },
                { type: 'line', label: 'Cur W', data: currentSegWattsData, borderColor: '#4caf50', borderDash: [], borderWidth: 3, fill: false, pointRadius: 2, yAxisID: 'y1' },
                
                { type: 'bar', label: 'Prev Time', data: prevSegTimeData, backgroundColor: 'rgba(136, 136, 136, 0.4)', barPercentage: 0.9, categoryPercentage: 0.8, yAxisID: 'y' },
                { type: 'bar', label: 'Target Time', data: targetSegTimeData, backgroundColor: 'rgba(61, 174, 233, 0.4)', barPercentage: 0.9, categoryPercentage: 0.8, yAxisID: 'y' },
                { type: 'bar', label: 'Cur Time', data: currentSegTimeData, backgroundColor: 'rgba(76, 175, 80, 0.7)', barPercentage: 0.9, categoryPercentage: 0.8, yAxisID: 'y' }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
            plugins: { 
                legend: { position: 'top', labels: { boxWidth: 10, font: { size: 9 }, padding: 5 } },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            let label = context.dataset.label || '';
                            let val = context.raw;
                            if (val === null) return '';
                            if (context.dataset.yAxisID === 'y') {
                                return `${label}: ${formatTime(val)}`;
                            } else {
                                return `${label}: ${val}W`;
                            }
                        }
                    }
                }
            },
            scales: {
                y: { 
                    type: 'linear', position: 'left', title: { display: false }, min: 0, 
                    ticks: { callback: value => formatTime(value) } 
                },
                y1: { 
                    type: 'linear', position: 'right', title: { display: false }, grid: { drawOnChartArea: false }, min: 150, suggestedMax: 350, 
                    ticks: { callback: value => value + 'W' } 
                },
                x: { ticks: { maxRotation: 45, minRotation: 45 }, stacked: false }
            }
        }
    });
}

initAuth();
loadSegmentsConfig();
