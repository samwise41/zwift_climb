// --- Navigation Safety Warning ---
window.addEventListener('beforeunload', function (e) {
    if (startTime) { 
        e.preventDefault();
        e.returnValue = 'Ride in progress! Are you sure you want to leave?';
    }
});

// --- Help Modal Functions ---
function openHelp() {
    document.getElementById('helpModal').style.display = 'block';
    document.getElementById('modalBackdrop').style.display = 'block';
}
function closeHelp() {
    document.getElementById('helpModal').style.display = 'none';
    document.getElementById('modalBackdrop').style.display = 'none';
}

// --- Safe Storage Wrapper ---
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

let baseSegments = [];
let activeSegments = [];

let startTime = null;
let timerInterval = null;
let currentActiveIndex = 0;

// Ride Data Arrays
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

// --- Auth & Persistence Logic ---
function initAuth() {
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

// --- Configuration & JSON Loader ---
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
    document.getElementById('title-text').innerText = `${climb.name} Pacer`;
    document.getElementById('targetTimeInput').value = climb.defaultTime;
    
    document.getElementById('startBtn').disabled = true;
    document.getElementById('strava-status').style.display = 'none';

    baseSegments = climb.subSegments.map(name => ({
        name: name,
        targetCumSec: null, targetPower: null, prevSegSec: null, prevWatts: null
    }));
    
    applyNewTarget(); 
}

// --- Strava API Fetcher ---
async function fetchUserData() {
    if (!stravaAccessToken || !currentClimb) return;

    const statusEl = document.getElementById('strava-status');
    statusEl.innerText = `⏳ Searching...`;
    statusEl.style.display = 'inline-block';
    statusEl.classList.remove("ahead", "behind"); 

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
            baseSegments = personalizedSegments; 
            isDataLoaded = true; 
            
            document.getElementById('startBtn').disabled = false;
            document.getElementById('data-settings-box').style.display = 'none'; 
            document.getElementById('toggleSettingsBtn').innerHTML = '▶ Show Settings';

            applyNewTarget(); 
            
            statusEl.innerText = `✓ PR Loaded! Ready to pace.`;
            statusEl.classList.add("ahead");
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
    hardResetState(false); 
    renderList();
}

// --- UI & Ride Logic ---
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
}

function startRide() {
    if (!isDataLoaded || timerInterval) return; 
    startTime = Date.now();
    document.getElementById('startBtn').style.backgroundColor = '#334155';
    document.getElementById('startBtn').innerText = "RIDING";
    document.getElementById('resetBtn').style.display = 'inline-block';
    
    // Lock settings during ride
    document.getElementById('targetTimeInput').disabled = true;
    document.getElementById('splitSlider').disabled = true;
    document.getElementById('climbSelect').disabled = true;
    document.getElementById('attemptSelect').disabled = true;
    document.getElementById('fetchBtn').disabled = true;
    
    document.getElementById('data-settings-box').style.display = 'none';
    document.getElementById('toggleSettingsBtn').style.display = 'none';
    
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

// --- Charts Configuration (Updated for Color Fill) ---
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
                borderColor: '#000000', // Black line
                borderWidth: 2, 
                pointBackgroundColor: '#fff', 
                pointRadius: 3,
                fill: {
                    target: 'origin',
                    above: 'rgba(76, 175, 80, 0.4)', // Green when ahead of 0
                    below: 'rgba(252, 103, 25, 0.4)' // Orange when behind 0
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

// --- App Initialization ---
initAuth();
loadSegmentsConfig();
