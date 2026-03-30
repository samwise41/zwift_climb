// ==========================================
// js/universal.js - The Universal GPX Slicer
// ==========================================

// --- 1. YOUR GPX LIBRARY ---
// Just add new files here when you drop them into your /gpx/ folder!
const gpxLibrary = [
    { filename: "epic_kom.gpx", name: "Epic KOM" },
    { filename: "road_to_sky.gpx", name: "Road to Sky" },
    { filename: "volcano_ccw.gpx", name: "Volcano Circuit CCW" }
];

// --- Core State ---
let baseSegments = [];
let activeSegments = [];
let isDataLoaded = false;
let currentRouteName = "Universal Route";

let startTime = null;
let timerInterval = null;
let currentActiveIndex = 0;
let actualCumSecData = [];

// --- Init Dropdown ---
function initDropdown() {
    const selectEl = document.getElementById('routeSelect');
    selectEl.innerHTML = ''; 
    
    gpxLibrary.forEach(route => {
        const opt = document.createElement('option');
        opt.value = route.filename;
        opt.textContent = route.name;
        selectEl.appendChild(opt);
    });
    
    // Always add the custom upload at the bottom
    const customOpt = document.createElement('option');
    customOpt.value = "custom";
    customOpt.textContent = "Upload My Own GPX...";
    selectEl.appendChild(customOpt);
}

document.getElementById('routeSelect').addEventListener('change', (e) => {
    if (e.target.value === 'custom') {
        document.getElementById('custom-upload-row').style.display = 'flex';
    } else {
        document.getElementById('custom-upload-row').style.display = 'none';
    }
});

// --- Core Engine: Load & Slice ---
async function loadAndSliceRoute() {
    const routeFile = document.getElementById('routeSelect').value;
    const sliceMethod = document.getElementById('sliceSelect').value;
    const statusEl = document.getElementById('strava-status');
    
    statusEl.innerText = "⏳ Slicing Route...";
    statusEl.className = "status-text";
    statusEl.style.display = 'inline-block';

    try {
        let gpxText = "";
        
        if (routeFile === 'custom') {
            const fileInput = document.getElementById('gpxInput');
            if (!fileInput.files.length) {
                alert("Please select a GPX file to upload.");
                statusEl.style.display = 'none';
                return;
            }
            gpxText = await fileInput.files[0].text();
            currentRouteName = fileInput.files[0].name.replace('.gpx', '');
        } else {
            const res = await fetch(`./gpx/${routeFile}`);
            if (!res.ok) throw new Error("GPX file not found on server.");
            gpxText = await res.text();
            currentRouteName = document.getElementById('routeSelect').options[document.getElementById('routeSelect').selectedIndex].text;
        }

        if (sliceMethod === 'yolo') {
            alert("YOLO Mode coming soon! Using 1km for now.");
            executeStandardSlicer(gpxText, 1.0);
        } else {
            executeStandardSlicer(gpxText, parseFloat(sliceMethod));
        }

    } catch (error) {
        console.error("Slicing Error:", error);
        statusEl.innerText = "❌ Error reading GPX";
        statusEl.className = "status-text behind";
    }
}

// --- The Standard Distance Slicer ---
function executeStandardSlicer(gpxText, intervalKm) {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(gpxText, "text/xml");
    const trkpts = xmlDoc.getElementsByTagName("trkpt");
    
    if (trkpts.length === 0) throw new Error("No trackpoints found in GPX.");

    let generatedSegments = [];
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
        
        let ext = trkpts[i].getElementsByTagName("extensions")[0];
        if (ext) {
            let pwrNode = ext.getElementsByTagName("power")[0];
            if (pwrNode) {
                currentSegmentWattsSum += parseInt(pwrNode.textContent);
                currentSegmentWattsCount++;
            }
        }

        if (cumulativeKm >= targetNextSplitKm || i === trkpts.length - 1) {
            let endPointTime = new Date(trkpts[i].getElementsByTagName("time")[0].textContent).getTime();
            let segSecs = Math.round((endPointTime - startPointTime) / 1000);
            
            let avgWatts = currentSegmentWattsCount > 0 ? Math.round(currentSegmentWattsSum / currentSegmentWattsCount) : 150;
            let isFinish = i === trkpts.length - 1;
            let segName = isFinish ? "Finish Line" : `Km ${targetNextSplitKm.toFixed(1)}`;
            
            if (segSecs > 0) {
                generatedSegments.push({
                    name: segName,
                    prevSegSec: segSecs,
                    prevWatts: avgWatts,
                    targetCumSec: null, targetPower: null
                });
            }

            startPointTime = endPointTime;
            currentSegmentWattsSum = 0;
            currentSegmentWattsCount = 0;
            targetNextSplitKm += intervalKm;
        }
    }

    baseSegments = generatedSegments;
    isDataLoaded = true;
    
    document.getElementById('startBtn').disabled = false;
    document.getElementById('trim-instructions').style.display = 'block';

    const statusEl = document.getElementById('strava-status');
    statusEl.innerText = `✓ Sliced into ${baseSegments.length} checkpoints!`;
    statusEl.className = "status-text ahead";
    
    document.getElementById('title-text').innerText = currentRouteName;

    applyNewTarget();
}

// --- NEW: Trim Segment Feature ---
// Allows user to chop off descents from their GPX file
function removeSegment(index) {
    if (startTime) return; // Don't let them delete during a ride!
    baseSegments.splice(index, 1);
    applyNewTarget(); // Instantly re-calculates the pacing targets
}

// --- Math & Utilities ---
function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
    const R = 6371; 
    const dLat = (lat2-lat1) * (Math.PI/180);
    const dLon = (lon2-lon1) * (Math.PI/180); 
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * (Math.PI/180)) * Math.cos(lat2 * (Math.PI/180)) * Math.sin(dLon/2) * Math.sin(dLon/2); 
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
    return R * c; 
}

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

        // Show trash can only if ride hasn't started
        const deleteBtnHtml = !startTime ? `<button onclick="removeSegment(${index})" style="background: none; border: none; cursor: pointer; color: #f44336; font-size: 1.2em; margin-left: 10px;" title="Remove this split">🗑️</button>` : '';

        const div = document.createElement('div');
        div.className = 'segment';
        div.innerHTML = `
            <div class="segment-info" style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                <div>
                    <div class="segment-name">${seg.name}</div>
                    <div class="segment-target" style="color: var(--target-blue); font-weight: bold;">Target: ${formatTime(seg.targetCumSec)} (${formatTime(targetSegSec)}) @ ${seg.targetPower}W</div>
                </div>
                <div>${deleteBtnHtml}</div>
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
    
    // Hide the trim instructions once started
    document.getElementById('trim-instructions').style.display = 'none';
    
    renderList(); // Re-render to hide trash cans
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
        document.getElementById('trim-instructions').style.display = 'block';
        renderList();
    }
}

// Boot up!
initDropdown();
